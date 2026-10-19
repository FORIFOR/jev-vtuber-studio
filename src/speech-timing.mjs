import { readWav } from './wav.mjs';
import { MAX_LIP_CUES, validLipSync } from '../public/speech-visemes.mjs';

// The adapter's Buffer API and LRU remain unchanged; metadata dies with its WAV.
const timings = new WeakMap();
export const speechTiming = bytes => timings.get(bytes) ?? null;
const finiteLength = value => Number.isFinite(value) && value >= 0 && value <= 45;
const shape = vowel => /^[aiueo]$/i.test(vowel) ? vowel.toLowerCase() : 'n';
const strength = vowel => /^[AIUEO]$/.test(vowel) ? .6 : 1;
const closeConsonants = new Set(['m', 'b', 'p', 'N', 'cl']);
// VOICEVOX decoder runs at 24000/256 Hz and uses numpy's nearest-even rounding.
const frames = seconds => { const x = seconds * 93.75, floor = Math.floor(x); return x - floor === .5 ? floor + (floor % 2) : Math.round(x); };
const rounded = value => Math.round(value * 1000) / 1000;

function makeTimeline(source, durationMs, cues) {
    if (cues.length > MAX_LIP_CUES) return null;
    const result = { version: 1, source, durationMs, cues };
    return validLipSync(result) ? result : null;
}

function flatten(query, upspeak) {
    if (!Array.isArray(query?.accent_phrases) || query.accent_phrases.length > 1000) return null;
    const moras = [];
    for (const phrase of query.accent_phrases) {
        if (!Array.isArray(phrase?.moras) || phrase.moras.length > 1500 - moras.length) return null;
        for (const mora of phrase.moras) {
            if (!mora || typeof mora.vowel !== 'string' || mora.vowel.length > 8) return null;
            moras.push(mora);
        }
        const last = phrase.moras.at(-1);
        // Default /synthesis enables the engine's interrogative upspeak.
        if (upspeak && phrase.is_interrogative && last?.pitch > 0)
            moras.push({ vowel: last.vowel, vowel_length: .15 });
        if (phrase.pause_mora) moras.push(phrase.pause_mora);
        if (moras.length > 1500) return null;
    }
    return moras.length ? moras : null;
}

function queryTimeline(query, moras, durationMs) {
    if (!Number.isFinite(query.speedScale) || query.speedScale <= 0 || query.speedScale > 4
        || !finiteLength(query.prePhonemeLength) || !finiteLength(query.postPhonemeLength)) return null;
    const all = [{ vowel: 'sil', vowel_length: query.prePhonemeLength }, ...moras, { vowel: 'sil', vowel_length: query.postPhonemeLength }];
    let at = 0;
    const cues = [], push = (seconds, vowel, gain = 1) => {
        const length = frames(seconds / query.speedScale) * 1000 / 93.75;
        if (length > 0) { cues.push({ startMs: at, endMs: at + length, vowel, ...(gain !== 1 ? { strength: gain } : {}) }); at += length; }
    };
    for (const mora of all) {
        if (!finiteLength(mora.vowel_length) || (mora.consonant && !finiteLength(mora.consonant_length))) return null;
        const vowel = shape(mora.vowel);
        if (mora.consonant) push(mora.consonant_length, closeConsonants.has(mora.consonant) ? 'n' : vowel, .45);
        let length = mora.vowel_length;
        if (mora.vowel === 'pau') {
            if (query.pauseLength != null) { if (!finiteLength(query.pauseLength)) return null; length = query.pauseLength; }
            if (query.pauseLengthScale != null) { if (!finiteLength(query.pauseLengthScale)) return null; length *= query.pauseLengthScale; }
        }
        push(length, vowel, strength(mora.vowel));
    }
    // A different decoder or invalid/dummy lengths must never masquerade as exact timing.
    if (!at || Math.abs(at - durationMs) > Math.max(40, durationMs * .05)) return null;
    const scale = durationMs / at;
    return makeTimeline('query', durationMs, cues.map(cue => ({ ...cue, startMs: rounded(cue.startMs * scale), endMs: rounded(cue.endMs * scale) })));
}

// Aivis explicitly returns dummy zero durations. Its reading is useful, but these
// timestamps are an estimate over the WAV's active intervals, not forced alignment.
// https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/voicevox_engine/tts_pipeline/model.py
function estimatedTimeline(moras, samples, rate) {
    const durationMs = samples.length / rate * 1000, hop = Math.max(1, Math.round(rate / 100));
    const energy = [];
    for (let at = 0; at < samples.length; at += hop) {
        let sum = 0; const end = Math.min(samples.length, at + hop);
        for (let i = at; i < end; i++) sum += samples[i] * samples[i];
        energy.push(Math.sqrt(sum / (end - at)));
    }
    const peak = energy.reduce((max, value) => Math.max(max, value), 0), threshold = Math.max(.002, peak * .035);
    const active = energy.map(value => value > threshold);
    // Bridge brief closures/devoicing; real pauses >=60ms stay closed.
    for (let i = 0; i < active.length;) {
        if (active[i]) { i++; continue; }
        const start = i; while (i < active.length && !active[i]) i++;
        if (start > 0 && i < active.length && i - start < 6) active.fill(true, start, i);
    }
    const spans = []; let total = 0;
    for (let i = 0; i < active.length;) {
        if (!active[i]) { i++; continue; }
        const start = i; while (i < active.length && active[i]) i++;
        const startMs = start * hop / rate * 1000, endMs = Math.min(durationMs, i * hop / rate * 1000);
        spans.push({ startMs, endMs, offset: total }); total += endMs - startMs;
    }
    if (!total) return makeTimeline('reading-estimate', durationMs, [{ startMs: 0, endMs: durationMs, vowel: 'n' }]);
    const phones = [];
    for (const mora of moras) {
        if (['pau', 'sil'].includes(mora.vowel)) continue;
        const vowel = shape(mora.vowel);
        if (mora.consonant) phones.push({ vowel: closeConsonants.has(mora.consonant) ? 'n' : vowel, weight: .35, strength: .45 });
        phones.push({ vowel, weight: vowel === 'n' ? .65 : 1, strength: strength(mora.vowel) });
    }
    if (!phones.length) return null;
    const unit = total / phones.reduce((sum, phone) => sum + phone.weight, 0), cues = [];
    let cursor = 0;
    for (const phone of phones) {
        const end = cursor + phone.weight * unit;
        for (const span of spans) {
            const lo = Math.max(cursor, span.offset), hi = Math.min(end, span.offset + span.endMs - span.startMs);
            if (hi - lo > .002) cues.push({ startMs: rounded(span.startMs + lo - span.offset), endMs: rounded(Math.min(durationMs, span.startMs + hi - span.offset)), vowel: phone.vowel,
                ...(phone.strength !== 1 ? { strength: phone.strength } : {}) });
        }
        cursor = end;
        if (cues.length > MAX_LIP_CUES) return null;
    }
    return makeTimeline('reading-estimate', durationMs, cues);
}

/** Best-effort, never adds calls or rejects successful speech because metadata is bad. */
export function attachSpeechTiming(bytes, query, engine = 'voicevox') {
    try {
        const moras = flatten(query, engine === 'voicevox');
        if (!moras) return bytes;
        const wav = readWav(bytes);
        const timeline = (engine === 'voicevox' && queryTimeline(query, moras, wav.ms))
            || estimatedTimeline(moras, wav.samples, wav.rate);
        if (timeline) timings.set(bytes, timeline);
    } catch { /* Successful WAV remains playable without lip metadata. */ }
    return bytes;
}

export function cropSpeechTiming(timeline, startMs, durationMs) {
    if (!validLipSync(timeline)) return null;
    const cues = timeline.cues.flatMap(cue => {
        const start = Math.max(0, cue.startMs - startMs), end = Math.min(durationMs, cue.endMs - startMs);
        return end > start ? [{ ...cue, startMs: start, endMs: end }] : [];
    });
    return makeTimeline(timeline.source, durationMs, cues);
}

/** Use the finalized bus layout so retained/dropped pre-clips cannot shift vowels. */
export function assembleSpeechTiming(units, layout) {
    if (!units.some(unit => validLipSync(unit.lipSync))) return null;
    const cues = [], sources = new Set();
    layout.units.forEach((mark, index) => {
        const timeline = units[index].lipSync;
        if (!validLipSync(timeline)) { cues.push({ startMs: mark.startMs, endMs: mark.endMs, vowel: 'x' }); sources.add('mixed'); return; }
        sources.add(timeline.source);
        const length = mark.endMs - mark.startMs;
        for (const cue of timeline.cues) {
            const startMs = mark.startMs + Math.min(length, cue.startMs), endMs = mark.startMs + Math.min(length, cue.endMs);
            if (endMs > startMs) cues.push({ ...cue, startMs, endMs });
        }
    });
    if (layout.clip) { cues.push({ startMs: layout.clip.startMs, endMs: layout.clip.endMs, vowel: 'x' }); sources.add('mixed'); }
    cues.sort((a, b) => a.startMs - b.startMs);
    return makeTimeline(sources.size === 1 ? [...sources][0] : 'mixed', layout.totalMs, cues);
}
