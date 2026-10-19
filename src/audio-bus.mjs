import { wavDuration } from './providers.mjs';
import { readWav, writeWav, resample, silence, trimSilenceRange, fade, gain, normalizeRms, concat } from './wav.mjs';
import { cropSpeechTiming, assembleSpeechTiming } from './speech-timing.mjs';
/** One canonical PCM16 mono WAV per part: speech units, exact pauses and at most one wordless clip. */
export const BUS = { preGapMs: 60, postGapMs: 80, fadeMs: 5, targetRmsDb: -20, clipDb: { default: -24, breath_in: -30, breath_out: -30, sigh: -30 }, ceilingDb: -1, trimDb: -50, keepMs: 15, splitGapMs: 20, maxPauseMs: 300, maxPausesPerPartMs: 600, maxPartMs: 45000 };
export const INTENSITY_DB = { low: -2, mid: 0, high: 1.5 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));
export function conditionSpeech(pcm, rate, { gainDb = 0 } = {}) {
    return conditionSpeechUnit(pcm, rate, { gainDb }).pcm;
}
export function conditionSpeechUnit(pcm, rate, { gainDb = 0, lipSync = null } = {}) {
    const samples = Float32Array.from(pcm);
    const { start, end } = trimSilenceRange(samples, rate, { thresholdDb: BUS.trimDb, keepMs: BUS.keepMs });
    const x = start === 0 && end === samples.length ? samples : samples.slice(start, end);
    return { pcm: fade(normalizeRms(x, rate, { targetDb: BUS.targetRmsDb + clamp(gainDb, -6, 6) }), rate, BUS.fadeMs, BUS.fadeMs),
        lipSync: cropSpeechTiming(lipSync, start / rate * 1000, x.length / rate * 1000) };
}
export function conditionClip(pcm, rate, { cls, gainDb = 0 } = {}) {
    const x = normalizeRms(Float32Array.from(pcm), rate, { targetDb: Object.hasOwn(BUS.clipDb, cls) ? BUS.clipDb[cls] : BUS.clipDb.default });
    return fade(gain(x, clamp(gainDb, -12, 6)), rate, BUS.fadeMs, BUS.fadeMs);
}
/** Layout: [clip if pre][preGap][u0][pause0][u1]...[uN][postGap][clip if post][tail].
 * Pauses are exact zero-sample runs; the last unit's pauseAfterMs is ignored. */
export function assemble({ rate, units, clip = null, tailMs = 0 }) {
    if (!Array.isArray(units) || !units.length) throw new Error('Empty part');
    if (!Number.isInteger(rate) || rate <= 0) throw new Error('Invalid sample rate');
    if (clip && !['pre', 'post'].includes(clip.position)) throw new Error('Invalid clip position');
    const toMs = s => Math.round(s * 1000 / rate);
    let pauses = units.slice(0, -1).map(u => clamp(u.pauseAfterMs ?? 0, 0, BUS.maxPauseMs));
    const sum = pauses.reduce((a, b) => a + b, 0);
    if (sum > BUS.maxPausesPerPartMs) pauses = pauses.map(p => Math.round(p * BUS.maxPausesPerPartMs / sum));
    const chunks = [], marks = [];
    let pos = 0, clipMark = null;
    const push = x => { chunks.push(x); pos += x.length; };
    if (clip?.position === 'pre') { push(clip.pcm); clipMark = { cls: clip.cls ?? null, position: 'pre', startMs: 0, endMs: toMs(pos) }; push(silence(BUS.preGapMs, rate)); }
    const preRoll = pos;
    units.forEach((u, i) => {
        const start = pos; push(u.pcm);
        marks.push({ tag: u.tag ?? null, startMs: toMs(start), endMs: toMs(pos) });
        if (i < pauses.length) push(silence(pauses[i], rate));
    });
    if (clip?.position === 'post') { push(silence(BUS.postGapMs, rate)); const start = pos; push(clip.pcm); clipMark = { cls: clip.cls ?? null, position: 'post', startMs: toMs(start), endMs: toMs(pos) }; }
    push(silence(clamp(tailMs, 0, BUS.maxPauseMs), rate));
    if (pos * 1000 / rate > BUS.maxPartMs) throw new Error('Turn audio too long');
    const samples = concat(chunks), ceiling = 10 ** (BUS.ceilingDb / 20);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
    if (peak > ceiling) { const k = ceiling / peak; for (let i = 0; i < samples.length; i++) samples[i] *= k; }
    return { samples, timeline: { rate, preRollMs: toMs(preRoll), totalMs: toMs(samples.length), units: marks, clip: clipMark } };
}
/** Upper bound of the silence assemble() adds to a planned part without a clip: inner pauses (clamped and capped
 * as assemble does; units merge chunks, so never more) plus the tail. Speech itself is the caller's estimate. */
export function plannedSilenceMs(planPart) {
    const chunks = Array.isArray(planPart?.chunks) ? planPart.chunks : [];
    const inner = chunks.slice(0, -1).reduce((n, ch) => n + clamp(Number.isFinite(ch?.pauseAfterMs) ? ch.pauseAfterMs : 0, 0, BUS.maxPauseMs), 0);
    return Math.min(inner, BUS.maxPausesPerPartMs) + clamp(Number.isFinite(planPart?.tailMs) ? planPart.tailMs : 0, 0, BUS.maxPauseMs);
}
export function encodePart(samples, rate) {
    const bytes = writeWav(samples, rate);
    wavDuration(bytes);
    return { kind: 'wav', bytes, durationMs: Math.ceil(samples.length / rate * 1000) };
}
/** full carries the planned clip (an upper bound for maxTurnAudioMs); bare() is the same part without it. */
export function partAudio({ rate, units, clip = null, tailMs = 0 }) {
    const build = c => {
        const a = assemble({ rate, units, clip: c, tailMs }), lipSync = assembleSpeechTiming(units, a.timeline);
        return { ...encodePart(a.samples, rate), timeline: a.timeline, ...(lipSync ? { lipSync } : {}) };
    };
    const full = build(clip);
    let bare = clip ? null : full;
    return { full, bare: () => bare ||= build(null) };
}
export function joinParts(audios, gapMs = 60) {
    if (!Array.isArray(audios) || !audios.length) throw new Error('Empty part');
    if (audios.length === 1) {
        const a = audios[0];
        return { kind: 'wav', bytes: a.bytes, durationMs: Number.isFinite(a.durationMs) ? a.durationMs : Math.ceil(wavDuration(a.bytes) * 1000) };
    }
    const decoded = audios.map(a => readWav(a.bytes)), rate = decoded[0].rate, gap = silence(gapMs, rate), chunks = [];
    decoded.forEach((d, i) => { if (i) chunks.push(gap); chunks.push(d.rate === rate ? d.samples : resample(d.samples, d.rate, rate)); });
    return encodePart(concat(chunks), rate);
}
/** Rehearsal-only audition reel. It may exceed the 45 s part cap, so it is written without wavDuration.
 * Items are heard at their broadcast level: `level: 'air'` is already bus-conditioned (kept as is, so intensity
 * differences survive), a clip with `cls` goes through conditionClip with its gainDb, anything else is speech at -20 dB. */
export function reel(items, { rate = 24000, gapMs = 350, maxMs = 120000 } = {}) {
    if (!Array.isArray(items) || !items.length) return null;
    const gap = silence(gapMs, rate), max = Math.round(maxMs * rate / 1000), chunks = [], index = [], ceiling = 10 ** (BUS.ceilingDb / 20);
    let pos = 0, i = 0;
    for (; i < items.length; i++) {
        const it = items[i], lead = chunks.length ? gap.length : 0;
        if (pos + lead + Math.round(it.pcm.length * rate / it.rate) > max) break;
        const x = resample(it.pcm, it.rate, rate);
        const pcm = it.level === 'air' ? fade(Float32Array.from(x), rate, BUS.fadeMs, BUS.fadeMs)
            : typeof it.cls === 'string' ? conditionClip(x, rate, { cls: it.cls, gainDb: Number.isFinite(it.gainDb) ? it.gainDb : 0 })
            : fade(normalizeRms(x, rate, { targetDb: BUS.targetRmsDb }), rate, BUS.fadeMs, BUS.fadeMs);
        let peak = 0;
        for (let k = 0; k < pcm.length; k++) peak = Math.max(peak, Math.abs(pcm[k]));
        if (peak > ceiling) gain(pcm, 20 * Math.log10(ceiling / peak));
        if (lead) chunks.push(gap);
        index.push({ label: String(it.label ?? ''), kind: it.kind, startMs: Math.round((pos + lead) * 1000 / rate) });
        chunks.push(pcm); pos += lead + pcm.length;
    }
    if (!index.length) return null;
    return { bytes: writeWav(concat(chunks), rate), durationMs: Math.ceil(pos / rate * 1000), index, truncated: items.length - i };
}
