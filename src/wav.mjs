// Zero-dependency PCM helpers. Decoded audio is always mono Float32Array in -1..1.
const fail = m => { throw new Error(m); };
const amp = db => 10 ** (db / 20);
const dbOf = a => a > 0 ? 20 * Math.log10(a) : -Infinity;
const finite = x => Number.isFinite(x) ? x : 0;
function parseFmt(b, o, n, extensible) {
    let format = b.readUInt16LE(o);
    const channels = b.readUInt16LE(o + 2), rate = b.readUInt32LE(o + 4), bits = b.readUInt16LE(o + 14);
    // WAVE_FORMAT_EXTENSIBLE only for operator clips; the subformat GUID starts with the real tag.
    if (format === 0xFFFE) format = extensible && n >= 26 ? b.readUInt16LE(o + 24) : -1;
    const ok = (format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits));
    if (!ok || channels < 1 || channels > 2 || rate < 8000 || rate > 96000) fail('Unsupported WAV encoding');
    return { format, channels, rate, bits };
}
/** Walks chunks exactly like providers.wavDuration (pad bytes honoured) and decodes to mono. */
export function readWav(buf, { extensible = false, maxSeconds = 45 } = {}) {
    const b = Buffer.isBuffer(buf) ? buf : buf instanceof Uint8Array ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : null;
    if (!b || b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') fail('TTS must return WAV');
    let fmt = null, offset = 12;
    const data = [];
    while (offset + 8 <= b.length) {
        const id = b.toString('ascii', offset, offset + 4), n = b.readUInt32LE(offset + 4);
        offset += 8;
        // 0xFFFFFFFF is the "unknown length" streaming marker: never guess a duration.
        if (id === 'data' && n === 0xFFFFFFFF) fail('Invalid WAV duration');
        if (offset + n > b.length) fail('Truncated WAV');
        if (id === 'fmt ' && n >= 16) fmt = parseFmt(b, offset, n, extensible);
        if (id === 'data') data.push(b.subarray(offset, offset + n));
        offset += n + (n % 2);
    }
    if (!fmt || !data.length) fail('TTS must return WAV');
    const { format, channels, rate, bits } = fmt, width = bits / 8, frame = channels * width;
    const bytes = data.length === 1 ? data[0] : Buffer.concat(data), frames = Math.floor(bytes.length / frame), ms = frames * 1000 / rate;
    if (!bytes.length || !frames || !Number.isFinite(ms) || ms <= 0 || ms > maxSeconds * 1000) fail('Invalid WAV duration');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const read = format === 3 ? (bits === 32 ? p => dv.getFloat32(p, true) : p => dv.getFloat64(p, true))
        : bits === 8 ? p => (dv.getUint8(p) - 128) / 128
        : bits === 16 ? p => dv.getInt16(p, true) / 32768
        : bits === 24 ? p => (dv.getUint8(p) | dv.getUint8(p + 1) << 8 | dv.getInt8(p + 2) << 16) / 8388608
        : p => dv.getInt32(p, true) / 2147483648;
    const samples = new Float32Array(frames);
    for (let i = 0, p = 0; i < frames; i++, p += frame) {
        const x = channels === 2 ? (finite(read(p)) + finite(read(p + width))) / 2 : finite(read(p));
        samples[i] = Math.max(-1, Math.min(1, x));
    }
    return { rate, channels, bits, format, samples, ms };
}
/** Canonical 44-byte PCM16 mono WAV. */
export function writeWav(samples, rate) {
    if (!Number.isInteger(rate) || rate <= 0) fail('Invalid sample rate');
    const n = samples.length, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, finite(samples[i]))) * 32767), true);
    return b;
}
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
/** Blackman-windowed sinc, 16 zero crossings each side at the lower rate, cutoff 0.5*min(from, to).
 * Integer rates use a lazily built polyphase table; each phase is normalised to unity DC gain. */
export function resample(samples, from, to) {
    if (from === to) return Float32Array.from(samples);
    if (!(from > 0 && to > 0) || !Number.isFinite(from) || !Number.isFinite(to)) fail('Invalid sample rate');
    const n = samples.length, m = Math.round(n * to / from), out = new Float32Array(m);
    const r = Math.min(1, to / from), W = 16 / r, K = Math.ceil(W), taps = 2 * K + 2;
    const kernel = x => {
        if (Math.abs(x) >= W) return 0;
        const u = Math.PI * r * x;
        return (u ? Math.sin(u) / u : 1) * (.42 + .5 * Math.cos(Math.PI * x / W) + .08 * Math.cos(2 * Math.PI * x / W));
    };
    const weights = frac => {
        const w = new Float64Array(taps); let sum = 0;
        for (let k = 0; k < taps; k++) sum += w[k] = kernel(frac + K - k);
        for (let k = 0; k < taps; k++) w[k] /= sum;
        return w;
    };
    const int = Number.isInteger(from) && Number.isInteger(to), g = int ? gcd(from, to) : 1, L = to / g, M = from / g;
    const table = int && L * taps <= 500000 ? new Array(L) : null;
    for (let j = 0; j < m; j++) {
        let base, w;
        if (int) { const q = j * M; base = Math.floor(q / L); const p = q - base * L; w = table ? (table[p] ||= weights(p / L)) : weights(p / L); }
        else { const t = j * from / to; base = Math.floor(t); w = weights(t - base); }
        const i0 = base - K; let acc = 0;
        if (i0 >= 0 && i0 + taps <= n) for (let k = 0; k < taps; k++) acc += samples[i0 + k] * w[k];
        else for (let k = 0; k < taps; k++) { const i = i0 + k; if (i >= 0 && i < n) acc += samples[i] * w[k]; }
        out[j] = acc;
    }
    return out;
}
export const silence = (ms, rate) => new Float32Array(Math.max(0, Math.round(ms * rate / 1000) || 0));
/** Returns the SAME instance when nothing is above the threshold (zero-filled fixtures survive). */
export function trimSilence(samples, rate, { thresholdDb = -50, keepMs = 15, minMs = 30 } = {}) {
    const { start, end } = trimSilenceRange(samples, rate, { thresholdDb, keepMs, minMs });
    return start === 0 && end === samples.length ? samples : samples.slice(start, end);
}
/** Same crop calculation, exposed so audio-relative metadata keeps the exact offset. */
export function trimSilenceRange(samples, rate, { thresholdDb = -50, keepMs = 15, minMs = 30 } = {}) {
    const th = amp(thresholdDb), n = samples.length;
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) if (Math.abs(samples[i]) > th) { first = i; break; }
    if (first < 0) return { start: 0, end: n };
    for (let i = n - 1; i >= first; i--) if (Math.abs(samples[i]) > th) { last = i; break; }
    const keep = Math.max(0, Math.round(keepMs * rate / 1000)), min = Math.min(n, Math.max(0, Math.round(minMs * rate / 1000)));
    let start = Math.max(0, first - keep), end = Math.min(n, last + 1 + keep);
    if (end - start < min) { start = Math.max(0, start - Math.floor((min - (end - start)) / 2)); end = Math.min(n, start + min); start = Math.max(0, end - min); }
    return { start, end };
}
/** Raised-cosine ramps in place, each capped at half the length. */
export function fade(samples, rate, inMs = 5, outMs = 5) {
    const n = samples.length, half = Math.floor(n / 2);
    const a = Math.min(half, Math.max(0, Math.round(inMs * rate / 1000) || 0)), z = Math.min(half, Math.max(0, Math.round(outMs * rate / 1000) || 0));
    for (let i = 0; i < a; i++) samples[i] *= .5 - .5 * Math.cos(Math.PI * i / a);
    for (let i = 0; i < z; i++) samples[n - 1 - i] *= .5 - .5 * Math.cos(Math.PI * i / z);
    return samples;
}
/** activeDb is gated RMS over 20 ms frames above -45 dBFS (a cheap stand-in for LUFS). */
export function levels(samples, rate = 24000) {
    const n = samples.length, frame = Math.max(1, Math.round(rate * .02)), gate = amp(-45) ** 2;
    let sum = 0, peak = 0, hot = 0, activeSum = 0, activeN = 0;
    for (let s = 0; s < n; s += frame) {
        const e = Math.min(n, s + frame); let fs = 0;
        for (let i = s; i < e; i++) { const x = samples[i], a = Math.abs(x); fs += x * x; if (a > peak) peak = a; if (a >= .999) hot++; }
        sum += fs;
        if (fs / (e - s) > gate) { activeSum += fs; activeN += e - s; }
    }
    return { rmsDb: n ? dbOf(Math.sqrt(sum / n)) : -Infinity, activeDb: activeN ? 10 * Math.log10(activeSum / activeN) : -Infinity, peakDb: dbOf(peak), clipped: n ? hot / n : 0 };
}
export function gain(samples, db) {
    if (!Number.isFinite(db) || db === 0) return samples;
    const k = amp(db);
    for (let i = 0; i < samples.length; i++) samples[i] *= k;
    return samples;
}
export function normalizeRms(samples, rate, { targetDb = -20, maxBoostDb = 12, maxCutDb = 18, floorDb = -55 } = {}) {
    const { activeDb } = levels(samples, rate);
    if (!(activeDb >= floorDb)) return samples;
    return gain(samples, Math.max(-maxCutDb, Math.min(maxBoostDb, targetDb - activeDb)));
}
export function concat(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
}
