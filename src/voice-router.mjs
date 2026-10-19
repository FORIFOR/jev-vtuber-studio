// VoiceQualityRouter + DirectedVoice: renders ALREADY APPROVED parts through CACHE (exact phrase takes of the
// approved text) → LOCAL (the one configured engine) → PREMIUM (an inert, disabled slot). There is no voice
// fallback: a local failure rejects. Each part becomes ONE canonical WAV; finalize() at publication can only
// keep or drop the planned wordless clip, so durationMs stays an upper bound.
import { ReplyVoice } from './voice-routing.mjs';
import { createAdapters, TtsError, wrapError, VOCAL_TAGS } from './tts-adapters.mjs';
import { BUS, INTENSITY_DB, conditionSpeechUnit, conditionClip, partAudio, reel } from './audio-bus.mjs';
import { speechTiming } from './speech-timing.mjs';
import { readWav, resample } from './wav.mjs';
import { SpeechDirector, effectiveMode } from './speech-director.mjs';
import { ClipGovernor, clipCompatible, calmReaction, NONVERBAL, VOICE_FAMILIES } from '../public/voice-acting.mjs';
import { hash } from './util.mjs';
import { CloudSpend } from './cloud-spend.mjs';
export const AUDIO_PROCESSING_VERSION = 1;

/** Burn-in sentences: ordinary length and punctuation, never broadcast. */
export const BURN_IN = Object.freeze(['今日はゆっくり、夜の話をしていこうと思います。', 'えっ、それ本当なんですか？ちょっと待ってください。', 'コメントありがとう、あとでじっくり読みますね。']);
/** Rehearsal-only audition sentences, one per voice family. Never broadcast. */
export const AUDITION_TEXT = Object.freeze({
    neutral: 'この声で、落ち着いて話します。',
    calm: 'うん、そうだね。この声でうなずきます。',
    joy: 'わあ、うれしい！この声で喜びます。',
    surprise: 'えっ、本当に？この声で驚きます。',
    shy: 'そんなに褒められると、照れちゃうな。',
    think: 'うーん、どっちがいいかな。',
    worry: 'ごめん、それは少し難しいかも。',
});
const ROUTER = { lruEntries: 64, lruBytes: 16000000, samples: 64, ewma: .3, defaultAudioMsPerChar: 170, identityMaxAgeMs: 60000, maxAuditions: 14 };
const invariant = () => Object.assign(new Error('Direction altered text'), { code: 'PLAN_INVARIANT' });
const circuitOpen = () => new TtsError('TTS_ENGINE_DOWN', 'Voice engine circuit open');
const COUNTED = new Set(['TTS_ENGINE_DOWN', 'TTS_ENGINE_MISMATCH']);
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };

export class CircuitBreaker {
    constructor({ failures = 2, openMs = 15000, maxOpenMs = 60000, now = Date.now } = {}) {
        this.limit = failures; this.baseMs = openMs; this.maxOpenMs = maxOpenMs; this.now = now;
        this.openMs = openMs; this.count = 0; this.probing = false; this._state = 'closed'; this._openUntil = 0;
    }
    get state() { return this._state; }
    get openUntil() { return this._openUntil; }
    allow() {
        if (this._state === 'closed') return true;
        if (this._state === 'open') { if (this.now() < this._openUntil) return false; this._state = 'half_open'; this.probing = false; }
        if (this.probing) return false;
        return this.probing = true;
    }
    success() { this._state = 'closed'; this.count = 0; this.probing = false; this.openMs = this.baseMs; this._openUntil = 0; }
    /** Returns true when this failure opened the circuit. */
    failure(code = null) {
        this.probing = false; this.lastCode = code;
        if (this._state !== 'half_open' && ++this.count < this.limit) return false;
        const justOpened = this._state !== 'open';
        this._state = 'open'; this.count = 0; this._openUntil = this.now() + this.openMs; this.openMs = Math.min(this.maxOpenMs, this.openMs * 2);
        return justOpened;
    }
    /** The granted half-open attempt ended without a verdict (abort, rejection, cache-only part). */
    release() { this.probing = false; }
}

const CUT = /[、，・ 　]/u;
const isHigh = s => { const x = s.charCodeAt(s.length - 1); return x >= 0xD800 && x <= 0xDBFF; };
/** Exact substrings of ≤ max chars: cut after the delimiter nearest the middle, else hard-split at max. */
function splitText(s, max) {
    if (s.length <= max) return [s];
    let cut = -1, best = Infinity;
    for (let i = 0; i < s.length - 1; i++) {
        if (!CUT.test(s[i])) continue;
        const d = Math.abs(i + 1 - s.length / 2);
        if (d < best && s.slice(0, i + 1).trim() && s.slice(i + 1).trim()) { cut = i + 1; best = d; }
    }
    if (cut < 0) cut = isHigh(s.slice(0, max)) && max > 1 ? max - 1 : max;
    return [...splitText(s.slice(0, cut), max), ...splitText(s.slice(cut), max)];
}
/** Pure. Turns an approved part plan into render units (cache or local) whose texts join to part.text exactly. */
export function planUnits(part, { maxChars, expressive = true, keyOf, hasPhrase = () => false, firstPart = false } = {}) {
    const text = part?.text, chunks = part?.chunks;
    if (typeof text !== 'string' || !text || !Array.isArray(chunks) || !chunks.length || !chunks.every(ch => typeof ch?.text === 'string' && ch.text) || chunks.map(ch => ch.text).join('') !== text) throw invariant();
    const max = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : Infinity, pieces = [];
    let at = 0;
    for (const ch of chunks) {
        const delivery = { family: ch.family, intensity: ch.intensity, pace: ch.pace }, key = keyOf(delivery), list = splitText(ch.text, max);
        const pause = Number.isFinite(ch.pauseAfterMs) ? Math.max(0, ch.pauseAfterMs) : 0;
        list.forEach((t, j) => { pieces.push({ tier: 'local', text: t, charStart: at, charEnd: at + t.length, delivery, key, pauseAfterMs: j < list.length - 1 ? BUS.splitGapMs : pause, split: list.length > 1 }); at += t.length; });
    }
    if (pieces.every(p => p.key === pieces[0].key) && hasPhrase(pieces[0].key, text))
        return [{ tier: 'cache', text, charStart: 0, charEnd: text.length, delivery: pieces[0].delivery, key: pieces[0].key, pauseAfterMs: pieces.at(-1).pauseAfterMs, split: false }];
    for (const p of pieces) if (!p.split && hasPhrase(p.key, p.text)) p.tier = 'cache';
    const fits = (...us) => us.reduce((n, u) => n + u.text.length, 0) <= max;
    const merge = (a, b) => ({ ...a, text: a.text + b.text, charEnd: b.charEnd, pauseAfterMs: b.pauseAfterMs, split: a.split || b.split });
    const units = [];
    for (const p of pieces) {
        const prev = units.at(-1);
        if (prev?.tier === 'local' && p.tier === 'local' && (prev.key === p.key || !expressive) && fits(prev, p)) units[units.length - 1] = merge(prev, p);
        else units.push({ ...p });
    }
    const cap = firstPart ? 2 : 3, locals = () => units.reduce((n, u) => n + (u.tier === 'local'), 0);
    while (locals() > cap) {
        let i = units.length - 2;
        while (i >= 0 && !(units[i].tier === 'local' && units[i + 1].tier === 'local' && fits(units[i], units[i + 1]))) i--;
        if (i >= 0) { units.splice(i, 2, merge(units[i], units[i + 1])); continue; }
        // Only give up a cache unit when both neighbours can then merge through it (net one call fewer).
        let j = units.length - 2;
        while (j >= 1 && !(units[j].tier === 'cache' && units[j - 1].tier === 'local' && units[j + 1].tier === 'local' && fits(units[j - 1], units[j], units[j + 1]))) j--;
        if (j < 1) break;
        units[j] = { ...units[j], tier: 'local' };
    }
    if (units.map(u => u.text).join('') !== text) throw invariant();
    return units;
}

/** One bus per part: the first local unit's rate (or the first phrase take's); no resampling in the common case. */
function toBus(units, rendered, phrase) {
    let rate = rendered[0]?.rate ?? null, li = 0;
    const sources = units.map(u => {
        if (u.tier === 'local') return rendered[li++];
        const p = phrase(u, rate);
        if (!p) throw new TtsError('TTS_REJECTED', 'Phrase cache changed');
        rate ??= p.rate;
        return { samples: p.pcm, rate: p.rate };
    });
    return { rate, busUnits: units.map((u, i) => {
        const s = sources[i], pcm = s.rate === rate ? s.samples : resample(s.samples, s.rate, rate);
        return { ...conditionSpeechUnit(pcm, rate, { gainDb: INTENSITY_DB[u.delivery?.intensity] ?? 0, lipSync: s.lipSync }), pauseAfterMs: u.pauseAfterMs, tag: i };
    }) };
}

export class VoiceQualityRouter {
    constructor(c, { ledger, library = null, fetchFn = fetch, adapters = null, now = Date.now, governor = new ClipGovernor(now), spend = undefined } = {}) {
        this.c = c; this.ledger = ledger; this.library = library; this.now = now; this.governor = governor;
        // Paid cloud voices only: persistent daily/monthly spend with a reservation before every request.
        this.spend = spend !== undefined ? spend : c.dataDir ? new CloudSpend(c.dataDir, { dayUsd: c.geminiTtsMaxUsd ?? 3, monthUsd: c.geminiTtsMaxUsdMonth ?? 10 }) : null;
        this.adapters = adapters || createAdapters(c, fetchFn);
        this.premium = null; // Disabled slot: no config key, no secret, no code path besides status().
        this.onEvent = null;
        this.breakers = {}; this.queues = {}; this.engines = {};
        for (const id of Object.keys(this.adapters)) { this.breakers[id] = new CircuitBreaker({ now }); this.queues[id] = Promise.resolve(); this.engines[id] = { state: 'unknown', calls: 0, failures: 0, samples: [], lastError: null }; }
        this.lru = new Map(); this.lruBytes = 0;
        this.stats = { lru: { hits: 0, misses: 0 }, phrase: { hits: 0, misses: 0 }, clips: { used: 0, dropped: 0 } };
        this.ewma = new Map();
    }
    /** Cloud calls reserve an estimate first (TTS_BUDGET, never counted as an engine failure) and settle the actual
     * generated audio afterwards; local engines pass straight through. */
    usd(a, chars, audioSec) { return (audioSec * 25 * a.info.usdPerMAudio + chars * 1.5 * a.info.usdPerMText) / 1e6; }
    async billed(a, chars, call, secondsOf, quiet = null) {
        if (!a.info.cloud || !this.spend) return call();
        let id;
        try { id = this.spend.reserve(this.usd(a, chars, chars * .25)); } catch (e) { quiet?.add(e); throw e; }
        let sec = 0;
        try { const out = await call(); sec = secondsOf(out); return out; }
        finally { this.spend.settle(id, { usd: this.usd(a, chars, sec), audioSec: sec }); }
    }
    adapter() {
        const id = this.c.replyTtsProvider;
        if (typeof id !== 'string' || !Object.hasOwn(this.adapters, id)) throw new TtsError('TTS_REJECTED', 'Unknown TTS provider');
        return this.adapters[id];
    }
    /** Cache identity of one rendered take: engine/model + voice + resolved acting (+ text, added by the library).
     * AUDIO_PROCESSING_VERSION 1 = today's conditioning and keeps today's keys; bump it when post-processing changes. */
    renderKey(delivery, adapter = this.adapter()) { return hash(JSON.stringify([adapter.id, adapter.identity(), adapter.resolve(delivery), ...(AUDIO_PROCESSING_VERSION > 1 ? [AUDIO_PROCESSING_VERSION] : [])])); }
    breaker() { return this.breakers[this.c.replyTtsProvider] ?? null; }
    /** Observer callbacks never change a render's or warm-up's outcome. */
    emit(kind, detail) { try { this.onEvent?.(kind, detail); } catch {} }
    available() { const b = this.breaker(); return !b || b.state !== 'open' || this.now() >= b.openUntil; }
    retryAt() { const b = this.breaker(); return b?.state === 'open' ? b.openUntil : 0; }
    estKey(a) { return `${a.id}|${JSON.stringify(a.identity())}`; }
    perChar(field) { try { return this.ewma.get(this.estKey(this.adapter()))?.[field] ?? null; } catch { return null; } }
    estimateSynthMs(text) { const k = this.perChar('synth'); return k == null ? 0 : Math.round(k * String(text ?? '').length); }
    estimateAudioMs(text) { return Math.round((this.perChar('audio') ?? ROUTER.defaultAudioMsPerChar) * String(text ?? '').length); }
    record(a, e, chars, synthMs, audioMs) {
        const k = this.estKey(a), m = this.ewma.get(k) || {}, n = Math.max(1, chars);
        const ew = (old, x) => old == null ? x : old + ROUTER.ewma * (x - old);
        this.ewma.set(k, { synth: ew(m.synth, synthMs / n), audio: ew(m.audio, audioMs / n) });
        e.samples.push(synthMs); if (e.samples.length > ROUTER.samples) e.samples.shift();
    }
    lruGet(key) { const b = this.lru.get(key); if (b) { this.lru.delete(key); this.lru.set(key, b); } return b ?? null; }
    lruSet(key, bytes) {
        if (this.lru.has(key)) { this.lruBytes -= this.lru.get(key).length; this.lru.delete(key); }
        this.lru.set(key, bytes); this.lruBytes += bytes.length;
        while (this.lru.size > ROUTER.lruEntries || this.lruBytes > ROUTER.lruBytes) { const [k, b] = this.lru.entries().next().value; this.lru.delete(k); this.lruBytes -= b.length; }
    }
    /** Live only (DirectedVoice answers demo). One queued engine job per part, one ledger reservation per voiced part. */
    async renderPart(part, signal) {
        const a = this.adapter(), c = this.c, pid = c.replyTtsProvider, mode = effectiveMode(c), breaker = this.breakers[pid], eng = this.engines[pid];
        if (!breaker.allow()) throw circuitOpen();
        let settled = false;
        const settle = fn => { if (!settled) { settled = true; fn(); } };
        try {
            // Phrases and clips only in directed modes: with direction off there is no audition reel to hear them in.
            const lib = c.phraseCache && mode !== 'off' ? this.library : null;
            let id16 = null;
            const units = planUnits(part, { maxChars: a.info.maxChars, expressive: a.info.expressive, keyOf: d => this.renderKey(d, a),
                hasPhrase: (k, t) => lib ? lib.hasPhrase(id16 ??= a.identity16(), t, k) === true : false, firstPart: (part?.index ?? 0) === 0 });
            const locals = units.filter(u => u.tier === 'local');
            for (const u of locals) a.validateText(u.text); // Rejections before any probe, reservation or fetch.
            // Engines with vocal tags (Gemini) voice a wordless reaction in the SAME request and voice, when the operator
            // library has no recorded take. Code picks one whitelisted tag; words still come only from approved text.
            const wantCls = typeof part.clip?.cls === 'string' && Object.hasOwn(NONVERBAL, part.clip.cls) ? part.clip.cls : null;
            let inlineTag = null;
            if (wantCls && a.info.vocalTags && c.reactionAudio && mode !== 'off' && Object.hasOwn(VOCAL_TAGS, wantCls) && !this.library?.kinds().includes(wantCls) && this.governor.allow(wantCls)) {
                const position = NONVERBAL[wantCls].position, unit = position === 'pre' ? units[0] : units.at(-1);
                if (unit?.tier === 'local') inlineTag = { cls: wantCls, position, unit };
            }
            if (lib) { this.stats.phrase.hits += units.length - locals.length; this.stats.phrase.misses += locals.length; }
            let calls = 0, synthMs = 0, audioMs = 0, rendered = [];
            if (locals.length) {
                const fp = a.fingerprint(), jobs = locals.map(u => { const params = a.resolve(u.delivery), tag = inlineTag?.unit === u ? { cls: inlineTag.cls, position: inlineTag.position } : null; return { u, params, tag, key: hash(JSON.stringify([fp, params, u.text, tag])) }; });
                const quiet = new Set(); // Errors that say nothing about the engine: budget, a circuit opened by an earlier queued part.
                const run = async () => {
                    if (signal?.aborted) throw signal.reason;
                    if (breaker.state === 'open') { const e = circuitOpen(); quiet.add(e); throw e; }
                    const needCall = jobs.some(j => !this.lru.has(j.key)), out = [], fresh = [];
                    if (needCall) {
                        if (a.id === 'supertonic') await a.health(signal, { maxAgeMs: 0 });
                        else if (a.id === 'aivisspeech' || a.id === 'sbv2' || a.info.cloud) await a.health(signal, { maxAgeMs: ROUTER.identityMaxAgeMs });
                        if (signal?.aborted) throw signal.reason;
                        try { this.ledger.reserve('tts'); } catch (e) { quiet.add(e); throw e; }
                    }
                    for (const j of jobs) {
                        if (signal?.aborted) throw signal.reason;
                        let bytes = this.lruGet(j.key), ms = 0;
                        const hit = !!bytes;
                        if (hit) this.stats.lru.hits++;
                        else {
                            this.stats.lru.misses++;
                            const t0 = performance.now();
                            bytes = await this.billed(a, j.u.text.length + (j.params.style?.length || 0), () => a.synthesize(j.u.text, j.params, signal, j.tag ? { tag: j.tag } : undefined), b => readWav(b).ms / 1000, quiet);
                            ms = performance.now() - t0; calls++; eng.calls++;
                            if (signal?.aborted) throw signal.reason;
                        }
                        const w = readWav(bytes);
                        if (!hit) { fresh.push([j.key, bytes]); synthMs += ms; audioMs += w.ms; this.record(a, eng, j.u.text.length, ms, w.ms); }
                        out.push({ samples: w.samples, rate: w.rate, lipSync: speechTiming(bytes) });
                    }
                    if (signal?.aborted) throw signal.reason;
                    for (const [k, b] of fresh) this.lruSet(k, b); // Only a complete, unaborted part is cached.
                    return { out, called: needCall };
                };
                const job = this.queues[pid].then(run);
                // Serialize work without retaining the completed job's decoded PCM.
                this.queues[pid] = job.then(() => {}, () => {});
                let result;
                try { result = await job; }
                catch (e) {
                    if (quiet.has(e)) throw e;
                    if (signal?.aborted) throw signal.reason ?? e;
                    const err = wrapError(e, signal);
                    eng.failures++; eng.lastError = err.code ?? 'TTS_ENGINE_DOWN';
                    if (COUNTED.has(err.code)) {
                        eng.state = 'down'; a.invalidate();
                        settle(() => { if (breaker.failure(err.code)) this.emit('voice_circuit', err.code); });
                    }
                    throw err;
                }
                if (result.called) { eng.state = 'ready'; settle(() => breaker.success()); }
                rendered = result.out;
            }
            const { rate, busUnits } = toBus(units, rendered, (u, r) => lib?.phrase(id16 ??= a.identity16(), u.text, u.key, r));
            rendered = null;
            const want = inlineTag ? null : wantCls;
            let clip = null, clipSkipped = null;
            if (want) {
                if (!c.reactionAudio || mode === 'off') clipSkipped = 'disabled';
                else if (!this.library) clipSkipped = 'missing';
                else if (!this.governor.allow(want)) clipSkipped = 'cooldown';
                else {
                    const x = this.library.clip(want, rate); // Rotates takes: only called when the clip can play.
                    if (!x) clipSkipped = 'missing';
                    else clip = { cls: want, position: NONVERBAL[want].position, pcm: conditionClip(x.rate === rate ? x.pcm : resample(x.pcm, x.rate, rate), rate, { cls: want, gainDb: x.gainDb }) };
                }
            }
            const tailMs = Number.isFinite(part.tailMs) ? part.tailMs : 0;
            let pa = partAudio({ rate, units: busUnits, clip, tailMs });
            if (clip && Number.isFinite(part.budgetMs) && pa.full.durationMs > part.budgetMs) { clip = null; clipSkipped = 'budget'; pa = partAudio({ rate, units: busUnits, clip: null, tailMs }); }
            // Contract: a reaction sound (clip + its gap) never adds more than maxReactionAudioMs to a turn.
            if (clip && pa.full.durationMs - pa.bare().durationMs > (c.maxReactionAudioMs ?? 1200)) { clip = null; clipSkipped = 'reaction_budget'; pa = partAudio({ rate, units: busUnits, clip: null, tailMs }); }
            if (clipSkipped) this.stats.clips.dropped++;
            // Phrase-library audio reused in this part (no new generation): measured, so a test run can report it in seconds.
            const cacheAudioMs = busUnits.reduce((n, b, i) => units[i].tier === 'local' ? n : n + b.pcm.length / rate * 1000, 0);
            const full = pa.full, stats = { engine: a.id, tiers: { cache: units.length - locals.length, local: locals.length }, calls, synthMs: Math.round(synthMs), audioMs: Math.round(audioMs), cacheAudioMs: Math.round(cacheAudioMs), clip: clip?.cls ?? inlineTag?.cls ?? null, clipSkipped, ...(inlineTag ? { vocalTag: inlineTag.cls } : {}) };
            const offsets = [];
            part.chunks.reduce((n, ch) => { offsets.push(n); return n + ch.text.length; }, 0);
            let final = null, released = false;
            const release = () => { released = true; busUnits.forEach(u => { u.pcm = null; }); if (clip) clip.pcm = null; };
            const finalize = ({ reaction } = {}, at = this.now()) => {
                if (final) return final;
                if (released && clip) throw new Error('Part released');
                // An inline vocal tag is inside the speech audio: it cannot be removed, so it always counts as used.
                if (inlineTag) { this.governor.commit(inlineTag.cls, at); this.stats.clips.used++; }
                const cls = clip?.cls ?? null, keep = !!cls && clipCompatible(cls, reaction, mode) && this.governor.allow(cls, at);
                const out = keep ? full : pa.bare();
                if (keep) this.governor.commit(cls, at);
                if (cls) this.stats.clips[keep ? 'used' : 'dropped']++;
                const tl = out.timeline, beats = [];
                for (const b of Array.isArray(part.beats) ? part.beats : []) {
                    const s = offsets[b?.chunk], i = Number.isInteger(s) ? units.findIndex(u => u.charStart <= s && s < u.charEnd) : -1, m = tl.units[i];
                    if (!m || beats.length >= 4) continue;
                    const u = units[i], atMs = Math.round(m.startMs + (m.endMs - m.startMs) * (s - u.charStart) / Math.max(1, u.charEnd - u.charStart));
                    if (atMs < tl.totalMs) beats.push({ atMs, reaction: calmReaction(b.reaction) });
                }
                const mouth = keep && Number.isFinite(NONVERBAL[cls].mouth) && tl.clip ? [{ startMs: tl.clip.startMs, endMs: tl.clip.endMs, scale: NONVERBAL[cls].mouth }] : [];
                final = { kind: 'wav', bytes: out.bytes, durationMs: out.durationMs, ...(out.lipSync ? { lipSync: out.lipSync } : {}), leadMs: (keep && NONVERBAL[cls].position === 'pre') || inlineTag?.position === 'pre' ? 0 : null, beats, mouth, clip: keep ? cls : inlineTag?.cls ?? null, stats };
                release();
                return final;
            };
            // clipMs: what the planned clip adds to durationMs. The next part's turn check exempts it, so a clip kept against
            // an estimated budget can never be what fails the turn (it is only ever budgeted, never the cause).
            return { kind: 'wav', bytes: full.bytes, durationMs: full.durationMs, ...(full.lipSync ? { lipSync: full.lipSync } : {}), clipMs: clip ? Math.max(0, full.durationMs - pa.bare().durationMs) : 0, speechMs: full.timeline.units.reduce((n, m) => n + m.endMs - m.startMs, 0), timeline: full.timeline, stats, finalize, release };
        } finally { settle(() => breaker.release()); }
    }
    /** Streaming render for a cloud voice (Gemini): returns on the FIRST audio chunk. Same voice and style as
     * renderPart; the style comes from the part's head delivery, and a planned wordless clip becomes one whitelisted
     * vocal tag in the same request. No bus (pauses/normalisation) and no phrase cache on this path. */
    async streamPart(part, signal) {
        const a = this.adapter(), c = this.c, pid = c.replyTtsProvider, mode = effectiveMode(c), breaker = this.breakers[pid], eng = this.engines[pid];
        if (typeof part?.text !== 'string' || !part.text) throw invariant();
        a.validateText(part.text);
        if (!breaker.allow()) throw circuitOpen();
        const head = part.chunks?.[0] ?? {}, params = a.resolve({ family: head.family, intensity: part.intensity ?? head.intensity, pace: head.pace });
        const cls = typeof part.clip?.cls === 'string' ? part.clip.cls : null;
        const tag = cls && a.info.vocalTags && c.reactionAudio && mode !== 'off' && Object.hasOwn(VOCAL_TAGS, cls) && this.governor.allow(cls) ? { cls, position: NONVERBAL[cls].position } : null;
        const chars = part.text.length + (params.style?.length || 0);
        let resId = null, settled = false;
        const settle = fn => { if (!settled) { settled = true; fn(); } };
        this.ledger.reserve('tts'); // A daily call limit is a budget hold, never an engine failure.
        try {
            await a.health(signal, { maxAgeMs: ROUTER.identityMaxAgeMs });
            if (this.spend) resId = this.spend.reserve(this.usd(a, chars, chars * .25));
            const t0 = performance.now(), stream = a.stream(part.text, params, signal, tag ? { tag } : {});
            void stream.finished.then(st => {
                if (resId !== null) this.spend.settle(resId, { usd: this.usd(a, chars, st.durationMs / 1000), audioSec: st.durationMs / 1000 });
                if (!st.error) this.record(a, eng, part.text.length, performance.now() - t0, st.durationMs);
            });
            await stream.first;
            const firstMs = performance.now() - t0;
            eng.calls++; eng.state = 'ready'; settle(() => breaker.success());
            // Published before its length is known: a generous estimate bounds the turn until the stream finishes.
            const estimate = Math.max(this.estimateAudioMs(part.text), part.text.length * 200);
            const stats = { engine: a.id, tiers: { cache: 0, local: 1 }, calls: 1, synthMs: Math.round(firstMs), audioMs: 0, clip: tag?.cls ?? null, clipSkipped: null, stream: true, firstChunkMs: Math.round(firstMs), ...(tag ? { vocalTag: tag.cls } : {}) };
            let final = null;
            const finalize = (_ = {}, at = this.now()) => {
                if (final) return final;
                if (tag) { this.governor.commit(tag.cls, at); this.stats.clips.used++; }
                final = { kind: 'stream', stream, bytes: null, durationMs: estimate, leadMs: tag?.position === 'pre' ? 0 : null, beats: [], mouth: [], clip: tag?.cls ?? null, stats };
                return final;
            };
            return { kind: 'stream', stream, bytes: null, durationMs: estimate, clipMs: 0, speechMs: estimate, stats, finalize, release: () => { } };
        } catch (e) {
            if (resId !== null && e?.code !== 'TTS_BUDGET') this.spend.settle(resId, { usd: 0, audioSec: 0 });
            if (e?.code === 'TTS_BUDGET' || signal?.aborted) throw signal?.aborted ? signal.reason ?? e : e;
            const err = wrapError(e, signal);
            eng.failures++; eng.lastError = err.code ?? 'TTS_ENGINE_DOWN';
            if (COUNTED.has(err.code)) { eng.state = 'down'; a.invalidate(); settle(() => { if (breaker.failure(err.code)) this.emit('voice_circuit', err.code); }); }
            throw err;
        } finally { settle(() => breaker.release()); }
    }
    async warmup(signal) {
        let a;
        try { a = this.adapter(); } catch { return null; }
        const pid = this.c.replyTtsProvider, eng = this.engines[pid];
        // On the engine's own queue: a slow first model load never overlaps a part's engine calls.
        const job = this.queues[pid].then(() => { if (signal?.aborted) throw signal.reason; return a.warmup(signal, this.ledger); });
        this.queues[pid] = job.catch(() => {});
        try {
            const r = await job;
            eng.state = 'ready'; this.emit('voice_warmup', r?.ms ?? 0);
            return r;
        } catch (e) {
            if (signal?.aborted) return null;
            const err = wrapError(e, signal), code = typeof err?.code === 'string' ? err.code : 'TTS_ENGINE_DOWN';
            eng.state = 'down'; eng.lastError = code; this.emit('voice_warmup', code);
            return null;
        }
    }
    /** Burn-in: measured on VOICEVOX (M3 Max), the first ~5 sentences after start render 2-3x slower (1.6-2.2 s vs
     * 0.6-0.7 s warm). Renders a few ordinary sentences on the host voice before the show needs it. Never aired, never
     * cached, one ledger reservation, failures swallowed (never opens the circuit). */
    async burnIn(signal, texts = BURN_IN) {
        let a;
        try { a = this.adapter(); } catch { return null; }
        if (a.info.cloud) return null; // No local cold start to warm, and every render is billed.
        const pid = this.c.replyTtsProvider, t0 = performance.now();
        const job = this.queues[pid].then(async () => {
            this.ledger?.reserve?.('tts');
            for (const text of texts) { if (signal?.aborted) return; await a.synthesize(text, a.resolve(null), signal); }
        });
        this.queues[pid] = job.catch(() => {});
        try { await job; const ms = Math.round(performance.now() - t0); this.emit('voice_burn_in', ms); return { ms }; }
        catch { return null; }
    }
    status() {
        const id = this.c.replyTtsProvider, a = Object.hasOwn(this.adapters, id) ? this.adapters[id] : null, b = a ? this.breakers[id] : null;
        const eng = a ? this.engines[id] : { state: 'unknown', calls: 0, failures: 0, samples: [], lastError: null }, est = a ? this.ewma.get(this.estKey(a)) : null;
        return {
            main: { id, label: a?.info?.label ?? null, state: b && b.state !== 'closed' ? b.state : eng.state, openForMs: b?.state === 'open' ? Math.max(0, b.openUntil - this.now()) : 0,
                lastError: eng.lastError, calls: eng.calls, failures: eng.failures, p50SynthMs: median(eng.samples), msPerChar: est?.synth == null ? null : Math.round(est.synth * 10) / 10, cloud: !!a?.info?.cloud, cost: a?.cost?.() ?? null },
            premium: { state: 'disabled' },
            lru: { entries: this.lru.size, bytes: this.lruBytes, ...this.stats.lru },
            phrase: { ...this.stats.phrase },
            clips: { ...this.stats.clips },
        };
    }
    clear() { this.lru.clear(); this.lruBytes = 0; for (const a of Object.values(this.adapters)) a.invalidate?.(); }
}

const validInput = text => {
    if (typeof text !== 'string' || !text.trim() || text.length > 1200 || /[<>\u0000]/.test(text)) throw new TtsError('TTS_REJECTED', 'Invalid TTS input');
};
/** The host voice seam: synthesize(text, signal, part?). Pass-through keeps today's ReplyVoice byte for byte. */
export class DirectedVoice {
    constructor(c, ledger, { library = null, fetchFn = fetch, router = null, legacy = null, now = Date.now } = {}) {
        this.c = c; this.ledger = ledger; this.library = library;
        this.legacy = legacy || new ReplyVoice(c, ledger, fetchFn);
        this.router = router || new VoiceQualityRouter(c, { ledger, library, fetchFn, now });
        this.director = new SpeechDirector(c);
        this.cache = { clear: () => { this.legacy.cache?.clear(); this.router.clear(); } };
        this.lastPart = null;
    }
    get onEvent() { return this.router.onEvent; }
    set onEvent(fn) { this.router.onEvent = fn; }
    passThrough() { return effectiveMode(this.c) === 'off' && ['voicevox', 'supertonic'].includes(this.c.replyTtsProvider); }
    clipKinds() {
        if (this.c.mode !== 'live' || !this.c.reactionAudio || effectiveMode(this.c) === 'off') return [];
        const lib = this.library ? this.library.kinds() : [];
        let tags = false;
        try { tags = !!this.router.adapter().info.vocalTags; } catch { }
        // Vocal-tag engines can voice every tagged class themselves; NONVERBAL order is kept for Jev candidates.
        return tags ? Object.keys(NONVERBAL).filter(k => lib.includes(k) || Object.hasOwn(VOCAL_TAGS, k)) : lib;
    }
    /** Live cloud voices stream by default; rehearsal (streamingAllowed=false) keeps whole WAVs for the operator to hear. */
    streaming() {
        if (this.streamingAllowed === false || this.c.mode !== 'live' || this.c.geminiTtsStream === false) return false;
        try { return !!this.router.adapter().info.cloud; } catch { return false; }
    }
    async synthesize(text, signal, part = null) {
        if (this.passThrough()) return this.legacy.synthesize(text, signal);
        if (part && part.text !== text) throw invariant();
        if (this.c.mode !== 'live') { validInput(text); return { kind: 'browser', durationMs: Math.min(30000, Math.max(3000, text.length * 130)), bytes: null }; }
        const r = this.streaming() ? await this.router.streamPart(part ?? this.director.neutralPart(text), signal) : await this.router.renderPart(part ?? this.director.neutralPart(text), signal), s = r.stats;
        this.lastPart = { engine: s.engine, tiers: { ...s.tiers }, calls: s.calls, synthMs: s.synthMs, audioMs: s.audioMs, clip: s.clip };
        return r;
    }
    available() { return this.passThrough() || this.c.mode !== 'live' || this.router.available(); }
    retryAt() { return this.router.retryAt(); }
    estimateSynthMs(text) { return this.router.estimateSynthMs(text); }
    estimateAudioMs(text) { return this.router.estimateAudioMs(text); }
    /** burnIn only at show start (rehearsal keeps its exact call sequence). The pass-through path warms the same
     * engine and voice through the router's adapter. */
    async warmup(signal, { burnIn = false } = {}) {
        if (this.c.mode !== 'live') return null;
        const r = this.passThrough() ? null : await this.router.warmup(signal);
        if (burnIn) await this.router.burnIn(signal);
        return r;
    }
    /** Rehearsal reel: every mapped style at mid and high, the base style when any family falls back to it,
     * every clip, every phrase take of this voice. */
    async audition(signal) {
        const c = this.c, lib = this.library;
        if (c.mode !== 'live' || effectiveMode(c) === 'off') return null;
        const a = this.router.adapter(), items = [];
        // Text-styled engines (Gemini) give every family its own style description: all of them are heard.
        const mapped = a.info.styles === 'text' ? [...VOICE_FAMILIES] : VOICE_FAMILIES.filter(f => a.styleFor(f) !== undefined);
        // An unmapped family airs on the engine's base style (AIVIS_STYLE / VOICEVOX_SPEAKER / SBV2_STYLE), which can be
        // another speaker entirely: once any family is mapped, the first unmapped one stands in for that base style.
        const base = mapped.length ? VOICE_FAMILIES.find(f => !mapped.includes(f)) : undefined;
        let renders = 0;
        for (const family of VOICE_FAMILIES) {
            if (!mapped.includes(family) && family !== base) continue;
            for (const intensity of ['mid', 'high']) {
                if (renders >= ROUTER.maxAuditions) break;
                renders++;
                const text = AUDITION_TEXT[family];
                const part = { index: 1, text, head: 'neutral', intensity, chunks: [{ text, start: 0, reaction: 'neutral', family, intensity, pace: 'normal', ending: 'beat', interjection: false, pauseAfterMs: 0 }], clip: null, beats: [], tailMs: 0 };
                const w = readWav((await this.router.renderPart(part, signal)).finalize({ reaction: 'neutral' }).bytes);
                items.push({ label: `${family}/${intensity}`, kind: 'style', level: 'air', pcm: w.samples, rate: w.rate });
            }
        }
        if (lib && c.reactionAudio) for (const { id, cls, gainDb } of lib.entries(a.identity16()).clips) { const x = lib.pcm(id); if (x) items.push({ label: cls, kind: 'clip', cls, gainDb, pcm: x.pcm, rate: x.rate }); }
        // Every vocal tag that can air is heard too, in the host voice, around a fixed audition line. Direct adapter
        // calls: the live cooldown governor and LRU are untouched; one reservation for the batch.
        if (c.reactionAudio && a.info.vocalTags) {
            const kinds = this.clipKinds().filter(k => Object.hasOwn(VOCAL_TAGS, k) && !(lib?.kinds() || []).includes(k));
            if (kinds.length) this.ledger?.reserve?.('tts');
            for (const cls of kinds) {
                const w = readWav(await a.synthesize(AUDITION_TEXT.neutral, a.resolve(null), signal, { tag: { cls, position: NONVERBAL[cls].position } }));
                items.push({ label: `${cls} (vocal tag)`, kind: 'style', level: 'air', pcm: w.samples, rate: w.rate });
            }
        }
        if (lib && c.phraseCache) for (const { id, text } of lib.entries(a.identity16()).phrases) { const x = lib.pcm(id); if (x) items.push({ label: text, kind: 'phrase', pcm: x.pcm, rate: x.rate }); }
        // Every take that can air must be heard, so nothing is cut: the reel is already bounded by
        // LIBRARY_LIMITS.totalMs plus at most 14 short style renders and their gaps.
        return reel(items, { rate: 24000, maxMs: Infinity });
    }
    status() { return { direction: effectiveMode(this.c), passThrough: this.passThrough(), ...this.router.status(), library: this.library?.status() ?? null, lastPart: this.lastPart }; }
}
