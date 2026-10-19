import test from 'node:test';
import assert from 'node:assert/strict';
import { readWav, writeWav, resample, silence, trimSilence, fade, levels, gain, normalizeRms, concat } from '../src/wav.mjs';
import { BUS, INTENSITY_DB, conditionSpeech, conditionClip, assemble, encodePart, partAudio, joinParts, reel } from '../src/audio-bus.mjs';
import { wavDuration } from '../src/providers.mjs';
import { wav } from './helpers.mjs';

const sine = (sec, hz, rate = 24000, amp = .3) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const tone = (sec, hz, rate = 24000, amp = .3) => writeWav(sine(sec, hz, rate, amp), rate);
const dc = (ms, v = .25, rate = 24000) => new Float32Array(Math.round(ms * rate / 1000)).fill(v);
function riff(chunks) {
    const body = Buffer.concat(chunks.map(([id, data, size]) => { const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(size ?? data.length, 4); return Buffer.concat([h, data, Buffer.alloc(data.length % 2)]); }));
    const head = Buffer.alloc(12); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8, 'ascii');
    return Buffer.concat([head, body]);
}
function fmtChunk({ rate = 24000, bits = 16, format = 1, channels = 1, ext = false }) {
    const w = bits / 8, f = Buffer.alloc(ext ? 40 : 16);
    f.writeUInt16LE(ext ? 0xFFFE : format, 0); f.writeUInt16LE(channels, 2); f.writeUInt32LE(rate, 4); f.writeUInt32LE(rate * channels * w, 8); f.writeUInt16LE(channels * w, 12); f.writeUInt16LE(bits, 14);
    if (ext) { f.writeUInt16LE(22, 16); f.writeUInt16LE(bits, 18); f.writeUInt32LE(channels === 1 ? 4 : 3, 20); f.writeUInt16LE(format, 24); Buffer.from('000000001000800000aa00389b71', 'hex').copy(f, 26); }
    return f;
}
function pcmData(chans, { bits = 16, format = 1 } = {}) {
    const n = chans[0].length, ch = chans.length, w = bits / 8, d = Buffer.alloc(n * ch * w);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        const x = chans[c][i], p = (i * ch + c) * w;
        if (format === 3) bits === 32 ? d.writeFloatLE(x, p) : d.writeDoubleLE(x, p);
        else if (bits === 8) d.writeUInt8(Math.round(x * 127) + 128, p);
        else if (bits === 16) d.writeInt16LE(Math.round(x * 32767), p);
        else if (bits === 24) d.writeIntLE(Math.round(x * 8388607), p, 3);
        else d.writeInt32LE(Math.round(x * 2147483647), p);
    }
    return d;
}
const encode = (chans, o = {}) => riff([['fmt ', fmtChunk({ ...o, channels: chans.length })], ['data', pcmData(chans, o)]]);
const maxDiff = (a, b) => { assert.equal(a.length, b.length); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const zeroCrossings = a => { let n = 0; for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++; return n; };

test('readWav decodes PCM 8/16/24/32-bit, float32/64 and averages stereo to mono', () => {
    const x = sine(.05, 440, 24000, .6);
    for (const [o, tol] of [[{ bits: 8 }, 1 / 64], [{ bits: 16 }, 1e-4], [{ bits: 24 }, 1e-6], [{ bits: 32 }, 1e-6], [{ bits: 32, format: 3 }, 1e-7], [{ bits: 64, format: 3 }, 1e-7]]) {
        const w = readWav(encode([x], o));
        assert.equal(w.rate, 24000); assert.equal(w.channels, 1); assert.equal(w.bits, o.bits); assert.equal(w.format, o.format ?? 1);
        assert.ok(w.samples instanceof Float32Array);
        assert.ok(maxDiff(w.samples, x) < tol, `bits ${o.bits} format ${o.format ?? 1}`);
        assert.ok(Math.abs(w.ms - 50) < 1e-9);
    }
    const left = sine(.05, 440, 24000, .6), right = sine(.05, 660, 24000, .2), avg = left.map((v, i) => (v + right[i]) / 2);
    for (const o of [{ bits: 16 }, { bits: 32, format: 3 }]) {
        const w = readWav(encode([left, right], o));
        assert.equal(w.channels, 2); assert.equal(w.samples.length, left.length);
        assert.ok(maxDiff(w.samples, avg) < 1e-4);
    }
    // PCM16 round trip through writeWav stays within the quantisation step (write x32767, read /32768).
    const back = readWav(writeWav(x, 24000));
    assert.ok(maxDiff(back.samples, x) <= 2 / 32767);
    // Float samples outside -1..1 and non-finite values never leak out.
    const hot = readWav(encode([Float32Array.of(2, -3, NaN, .5)], { bits: 32, format: 3, rate: 8000 }));
    assert.deepEqual([...hot.samples], [1, -1, 0, .5]);
});

test('WAVE_FORMAT_EXTENSIBLE is accepted only when asked for', () => {
    const x = sine(.05, 440, 44100, .5);
    for (const o of [{ bits: 16, format: 1 }, { bits: 24, format: 1 }, { bits: 32, format: 3 }]) {
        const b = riff([['fmt ', fmtChunk({ ...o, rate: 44100, ext: true })], ['data', pcmData([x], o)]]);
        assert.throws(() => readWav(b), /Unsupported WAV encoding/);
        assert.throws(() => wavDuration(b), /Unsupported WAV encoding/);
        const w = readWav(b, { extensible: true });
        assert.equal(w.rate, 44100); assert.equal(w.format, o.format);
        assert.ok(maxDiff(w.samples, x) < 1e-4);
    }
    const bad = fmtChunk({ bits: 16, ext: true }); bad.writeUInt16LE(2, 24);
    assert.throws(() => readWav(riff([['fmt ', bad], ['data', pcmData([x])]]), { extensible: true }), /Unsupported WAV encoding/);
});

test('readWav rejects malformed, truncated, empty, streaming, overlong and unsupported files', () => {
    const fmt = fmtChunk({});
    assert.throws(() => readWav(Buffer.from('not a wav at all, not a wav at all, not a wav!!')), /TTS must return WAV/);
    assert.throws(() => readWav(null), /TTS must return WAV/);
    assert.throws(() => readWav(riff([['fmt ', fmt], ['LIST', Buffer.alloc(20)]])), /TTS must return WAV/);
    assert.throws(() => readWav(riff([['LIST', Buffer.alloc(20)], ['data', Buffer.alloc(40)]])), /TTS must return WAV/);
    assert.throws(() => readWav(riff([['fmt ', fmt], ['data', Buffer.alloc(0)]])), /Invalid WAV duration/);
    assert.throws(() => readWav(riff([['fmt ', fmt], ['data', Buffer.alloc(480), 0xFFFFFFFF]])), /Invalid WAV duration/);
    assert.throws(() => readWav(writeWav(new Float32Array(46 * 8000), 8000)), /Invalid WAV duration/);
    assert.equal(readWav(writeWav(new Float32Array(46 * 8000), 8000), { maxSeconds: 60 }).ms, 46000);
    const full = tone(.1, 440);
    assert.throws(() => readWav(full.subarray(0, full.length - 100)), /Truncated WAV/);
    assert.throws(() => readWav(encode([sine(.05, 440, 7000)], { rate: 7000 })), /Unsupported WAV encoding/);
    assert.throws(() => readWav(encode([sine(.05, 440, 97000)], { rate: 97000 })), /Unsupported WAV encoding/);
    const x = sine(.01, 440);
    assert.throws(() => readWav(riff([['fmt ', fmtChunk({ channels: 3 })], ['data', pcmData([x, x, x])]])), /Unsupported WAV encoding/);
    assert.throws(() => readWav(riff([['fmt ', fmtChunk({ format: 3, bits: 16 })], ['data', pcmData([x])]])), /Unsupported WAV encoding/);
    assert.throws(() => readWav(riff([['fmt ', fmtChunk({ format: 2 })], ['data', pcmData([x])]])), /Unsupported WAV encoding/);
    // Odd chunks are padded and several data chunks concatenate.
    const a = sine(.01, 440), b = sine(.01, 880);
    const joined = readWav(riff([['fmt ', fmt], ['data', pcmData([a])], ['LIST', Buffer.alloc(3)], ['data', pcmData([b])]]));
    assert.ok(maxDiff(joined.samples, concat([a, b])) < 1e-4);
});

test('writeWav is canonical PCM16 mono and agrees with wavDuration', () => {
    for (const [n, r] of [[2400, 24000], [44100, 44100], [12345, 22050], [8000 * 45, 8000]]) {
        const b = writeWav(new Float32Array(n).fill(.1), r);
        assert.equal(b.length, 44 + n * 2);
        assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt32LE(4), 36 + n * 2); assert.equal(b.toString('ascii', 8, 16), 'WAVEfmt ');
        assert.deepEqual([b.readUInt32LE(16), b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt32LE(28), b.readUInt16LE(32), b.readUInt16LE(34)], [16, 1, 1, r, r * 2, 2, 16]);
        assert.equal(b.toString('ascii', 36, 40), 'data'); assert.equal(b.readUInt32LE(40), n * 2);
        assert.equal(wavDuration(b), n / r);
    }
    const b = writeWav(Float32Array.of(NaN, Infinity, -Infinity, 2, -2, .5), 8000);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => b.readInt16LE(44 + i * 2)), [0, 0, 0, 32767, -32767, 16384]);
    assert.throws(() => writeWav(new Float32Array(10), 0), /Invalid sample rate/);
});

test('resample keeps pitch, length and rejects aliasing', () => {
    const x = sine(1, 1000, 24000);
    const y = resample(x, 24000, 44100);
    assert.equal(y.length, Math.round(x.length * 44100 / 24000));
    const rx = zeroCrossings(x) / (x.length / 24000), ry = zeroCrossings(y) / (y.length / 44100);
    assert.ok(Math.abs(ry / rx - 1) < .01, `${rx} vs ${ry}`);
    assert.ok(Math.abs(levels(y.subarray(2000, -2000), 44100).rmsDb - levels(x, 24000).rmsDb) < .2);
    const back = resample(y, 44100, 24000);
    assert.equal(back.length, x.length);
    assert.ok(maxDiff(back.subarray(500, -500), x.subarray(500, -500)) < .01);
    const hi = sine(1, 20000, 48000), down = resample(hi, 48000, 24000);
    assert.equal(down.length, 24000);
    assert.ok(levels(down.subarray(500, -500), 24000).rmsDb - levels(hi, 48000).rmsDb < -20);
    const same = resample(x, 24000, 24000);
    assert.notEqual(same, x); assert.deepEqual(same, x);
    assert.equal(resample(sine(.1, 440, 22050), 22050, 16000).length, 1600);
    assert.equal(resample(new Float32Array(0), 24000, 44100).length, 0);
});

test('silence, trimSilence, fade, gain and concat', () => {
    assert.equal(silence(100, 24000).length, 2400); assert.equal(silence(-5, 24000).length, 0);
    const fixture = readWav(wav(.1)).samples;
    assert.equal(trimSilence(fixture, 24000), fixture);
    const padded = concat([silence(200, 24000), sine(.3, 440), silence(200, 24000)]);
    const trimmed = trimSilence(padded, 24000);
    let lead = 0; while (trimmed[lead] === 0) lead++;
    let tail = 0; while (trimmed[trimmed.length - 1 - tail] === 0) tail++;
    assert.ok(lead / 24 <= 16, `leading ${lead / 24} ms`); assert.ok(tail / 24 <= 16, `trailing ${tail / 24} ms`);
    assert.ok(trimmed.length <= 7200 + 2 * 360 + 2 && trimmed.length >= 7200);
    const click = new Float32Array(24000); click[12000] = .5;
    const kept = trimSilence(click, 24000);
    assert.ok(kept.length >= 720 && kept.includes(.5));
    const ramp = new Float32Array(1000).fill(1);
    assert.equal(fade(ramp, 24000, 5, 5), ramp);
    assert.equal(ramp[0], 0); assert.equal(ramp[999], 0); assert.equal(ramp[500], 1); assert.ok(ramp[60] > ramp[10]);
    const short = new Float32Array(10).fill(1); fade(short, 24000, 5, 5);
    assert.equal(short[0], 0); assert.ok(short.every(v => v >= 0 && v <= 1));
    const g = Float32Array.of(.5, -.25);
    assert.equal(gain(g, 20 * Math.log10(2)), g); assert.ok(Math.abs(g[0] - 1) < 1e-6);
    assert.equal(gain(g, NaN), g); assert.ok(Math.abs(g[0] - 1) < 1e-6);
    assert.deepEqual([...concat([Float32Array.of(1), new Float32Array(0), Float32Array.of(2, 3)])], [1, 2, 3]);
});

test('levels and normalizeRms', () => {
    const quiet = new Float32Array(24000), l = levels(quiet, 24000);
    assert.equal(l.activeDb, -Infinity); assert.equal(l.rmsDb, -Infinity); assert.equal(l.peakDb, -Infinity); assert.equal(l.clipped, 0);
    assert.equal(levels(new Float32Array(0)).activeDb, -Infinity);
    assert.equal(normalizeRms(quiet, 24000), quiet); assert.ok(quiet.every(v => v === 0));
    for (const amp of [.1, .3, .9]) {
        const x = sine(.5, 440, 24000, amp);
        assert.equal(normalizeRms(x, 24000), x);
        assert.ok(Math.abs(levels(x, 24000).activeDb + 20) < .5, `amp ${amp}`);
        assert.ok(x.every(Number.isFinite));
    }
    // Boost is capped at maxBoostDb: a -37 dB tone only reaches -25 dB.
    const faint = normalizeRms(sine(.5, 440, 24000, .02), 24000);
    assert.ok(Math.abs(levels(faint, 24000).activeDb - (20 * Math.log10(.02 / Math.SQRT2) + 12)) < .1);
    // Active level ignores silent frames; a hot sine reports clipping.
    const gapped = concat([sine(.5, 440, 24000, .1), silence(500, 24000)]);
    assert.ok(Math.abs(levels(gapped, 24000).activeDb - levels(sine(.5, 440, 24000, .1), 24000).activeDb) < .1);
    assert.ok(levels(sine(.5, 440, 24000, 1), 24000).clipped >= .01);
    assert.ok(Math.abs(levels(sine(.5, 440, 24000, .5), 24000).peakDb - 20 * Math.log10(.5)) < .01);
    const x = sine(.5, 440, 24000, .001);
    normalizeRms(x, 24000, { targetDb: -20, maxBoostDb: 12 });
    assert.ok(x.every(Number.isFinite));
});

test('conditionSpeech and conditionClip copy, trim, level and fade', () => {
    const raw = concat([silence(200, 24000), sine(.4, 440, 24000, .05), silence(200, 24000)]);
    const before = Float32Array.from(raw), out = conditionSpeech(raw, 24000);
    assert.deepEqual(raw, before);
    assert.ok(out.length < raw.length - 8000);
    assert.ok(Math.abs(levels(out, 24000).activeDb - BUS.targetRmsDb) < .5);
    assert.equal(out[0], 0);
    const high = conditionSpeech(raw, 24000, { gainDb: INTENSITY_DB.high }), low = conditionSpeech(raw, 24000, { gainDb: INTENSITY_DB.low });
    assert.ok(Math.abs(levels(high, 24000).activeDb - (BUS.targetRmsDb + 1.5)) < .5);
    assert.ok(Math.abs(levels(low, 24000).activeDb - (BUS.targetRmsDb - 2)) < .5);
    assert.ok(Math.abs(levels(conditionSpeech(sine(.4, 440, 24000, .3), 24000, { gainDb: 40 }), 24000).activeDb - (BUS.targetRmsDb + 6)) < .5);
    const quiet = conditionSpeech(new Float32Array(4800), 24000);
    assert.equal(quiet.length, 4800); assert.ok(quiet.every(v => v === 0));
    const clip = sine(.3, 300, 24000, .2);
    assert.ok(Math.abs(levels(conditionClip(clip, 24000, { cls: 'gasp' }), 24000).activeDb - BUS.clipDb.default) < .5);
    assert.ok(Math.abs(levels(conditionClip(clip, 24000, { cls: 'breath_in' }), 24000).activeDb - BUS.clipDb.breath_in) < .5);
    assert.ok(Math.abs(levels(conditionClip(clip, 24000, { cls: 'laugh_big', gainDb: 20 }), 24000).activeDb - (BUS.clipDb.default + 6)) < .5);
    assert.ok(Math.abs(levels(conditionClip(clip, 24000, { cls: 'constructor' }), 24000).activeDb - BUS.clipDb.default) < .5);
    assert.ok(Math.abs(levels(clip, 24000).peakDb - 20 * Math.log10(.2)) < .01, 'input untouched');
});

test('assemble lays out exact pauses, clips and a monotonic timeline', () => {
    const rate = 24000;
    const zeroRun = (s, from) => { let i = from; while (i < s.length && s[i] === 0) i++; return i - from; };
    const a = assemble({ rate, units: [{ pcm: dc(100), pauseAfterMs: 100, tag: 'a' }, { pcm: dc(150), pauseAfterMs: 250, tag: 'b' }] });
    assert.equal(zeroRun(a.samples, 2400), 2400);
    assert.equal(a.samples.length, 2400 + 2400 + 3600);
    assert.deepEqual(a.timeline, { rate, preRollMs: 0, totalMs: 350, units: [{ tag: 'a', startMs: 0, endMs: 100 }, { tag: 'b', startMs: 200, endMs: 350 }], clip: null });
    const odd = assemble({ rate: 44100, units: [{ pcm: dc(50, .25, 44100), pauseAfterMs: 37 }, { pcm: dc(50, .25, 44100) }] });
    assert.equal(zeroRun(odd.samples, 2205), Math.round(37 * 44100 / 1000));
    const pre = assemble({ rate, units: [{ pcm: dc(200) }], clip: { pcm: dc(300, .1), position: 'pre', cls: 'gasp' } });
    assert.equal(pre.timeline.preRollMs, 300 + BUS.preGapMs);
    assert.deepEqual(pre.timeline.clip, { cls: 'gasp', position: 'pre', startMs: 0, endMs: 300 });
    assert.equal(pre.timeline.units[0].startMs, 360);
    assert.equal(zeroRun(pre.samples, 7200), 1440);
    const post = assemble({ rate, units: [{ pcm: dc(200) }], clip: { pcm: dc(300, .1), position: 'post', cls: 'laugh_small' }, tailMs: 100 });
    assert.equal(post.timeline.preRollMs, 0);
    assert.deepEqual(post.timeline.clip, { cls: 'laugh_small', position: 'post', startMs: 200 + BUS.postGapMs, endMs: 580 });
    assert.equal(post.timeline.totalMs, 680);
    assert.equal(assemble({ rate, units: [{ pcm: dc(100) }], tailMs: 5000 }).timeline.totalMs, 100 + BUS.maxPauseMs);
    const many = assemble({ rate, units: [500, 500, 500, 999].map((p, i) => ({ pcm: dc(50), pauseAfterMs: p, tag: i })) });
    const gaps = many.timeline.units.slice(1).map((u, i) => u.startMs - many.timeline.units[i].endMs);
    assert.deepEqual(gaps, [200, 200, 200]);
    assert.equal(gaps.reduce((x, y) => x + y), BUS.maxPausesPerPartMs);
    const two = assemble({ rate, units: [{ pcm: dc(50), pauseAfterMs: 500 }, { pcm: dc(50), pauseAfterMs: -40 }, { pcm: dc(50) }] });
    assert.deepEqual(two.timeline.units.slice(1).map((u, i) => u.startMs - two.timeline.units[i].endMs), [300, 0]);
    const loud = assemble({ rate, units: [{ pcm: sine(.2, 440, rate, 1), pauseAfterMs: 120 }, { pcm: sine(.2, 660, rate, .5) }], clip: { pcm: sine(.2, 220, rate, .9), position: 'pre', cls: 'gasp' } });
    assert.ok(levels(loud.samples, rate).peakDb <= BUS.ceilingDb + 1e-6);
    assert.ok(levels(readWav(encodePart(loud.samples, rate).bytes).samples, rate).peakDb <= BUS.ceilingDb + 1e-3);
    for (const t of [a.timeline, pre.timeline, post.timeline, many.timeline, loud.timeline]) {
        const marks = [...(t.clip?.position === 'pre' ? [t.clip] : []), ...t.units, ...(t.clip?.position === 'post' ? [t.clip] : [])];
        marks.forEach((m, i) => { assert.ok(m.startMs <= m.endMs); if (i) assert.ok(marks[i - 1].endMs <= m.startMs); });
        assert.ok(marks.at(-1).endMs <= t.totalMs);
    }
    assert.throws(() => assemble({ rate, units: [] }), /Empty part/);
    assert.throws(() => assemble({ rate, units: [{ pcm: new Float32Array(46 * rate) }] }), /Turn audio too long/);
    assert.throws(() => assemble({ rate, units: [{ pcm: dc(10) }], clip: { pcm: dc(10), position: 'mid' } }), /Invalid clip position/);
});

test('encodePart and partAudio: bare() drops exactly the clip and its gap', () => {
    const e = encodePart(dc(250), 24000);
    assert.equal(e.kind, 'wav'); assert.equal(e.durationMs, 250); assert.equal(wavDuration(e.bytes), .25);
    for (const position of ['pre', 'post']) {
        const pa = partAudio({ rate: 24000, units: [{ pcm: dc(400), pauseAfterMs: 100 }, { pcm: dc(300) }], clip: { pcm: dc(500, .1), position, cls: 'gasp' }, tailMs: 40 });
        const bare = pa.bare();
        assert.equal(pa.bare(), bare);
        const gap = position === 'pre' ? BUS.preGapMs : BUS.postGapMs;
        assert.equal(pa.full.durationMs - bare.durationMs, 500 + gap);
        assert.equal(bare.timeline.clip, null); assert.equal(pa.full.timeline.clip.position, position);
        assert.equal(Math.round(wavDuration(pa.full.bytes) * 1000), pa.full.durationMs);
        assert.equal(Math.round(wavDuration(bare.bytes) * 1000), bare.durationMs);
        assert.equal(bare.kind, 'wav');
    }
    const plain = partAudio({ rate: 24000, units: [{ pcm: dc(100) }] });
    assert.equal(plain.bare(), plain.full);
});

test('joinParts joins with a gap, resamples to the first rate and accepts zero-filled fixtures', () => {
    const one = { kind: 'wav', bytes: wav(.2), durationMs: 200 };
    const single = joinParts([one]);
    assert.equal(single.bytes, one.bytes); assert.equal(single.durationMs, 200);
    assert.equal(joinParts([{ kind: 'wav', bytes: wav(.3) }]).durationMs, 300);
    const two = joinParts([one, { kind: 'wav', bytes: wav(.2), durationMs: 200 }]);
    assert.equal(two.kind, 'wav');
    assert.ok(Math.abs(two.durationMs - 460) <= 1, `${two.durationMs}`);
    assert.ok(Math.abs(wavDuration(two.bytes) - .46) < .002);
    const mixed = joinParts([{ bytes: tone(.2, 440, 24000) }, { bytes: tone(.2, 440, 44100) }], 100);
    const back = readWav(mixed.bytes);
    assert.equal(back.rate, 24000); assert.ok(Math.abs(back.ms - 500) < 1);
    assert.throws(() => joinParts([one, { bytes: Buffer.from('nope') }]), /TTS must return WAV/);
    assert.throws(() => joinParts([]), /Empty part/);
});

test('reel plays each item at its broadcast level: clips conditioned with gainDb, air-level styles untouched', () => {
    const raw = sine(.5, 300, 24000, .3), air = conditionSpeech(sine(.5, 440, 24000, .05), 24000, { gainDb: INTENSITY_DB.high });
    const r = reel([{ label: 'breath_in', kind: 'clip', cls: 'breath_in', gainDb: -6, pcm: raw, rate: 24000 }, { label: 'joy/high', kind: 'style', level: 'air', pcm: air, rate: 24000 }, { label: 'p', kind: 'phrase', pcm: raw, rate: 24000 }]);
    const w = readWav(r.bytes), seg = i => w.samples.subarray(Math.round(r.index[i].startMs * 24), Math.round(r.index[i].startMs * 24) + 12000);
    const onAir = levels(conditionClip(raw, 24000, { cls: 'breath_in', gainDb: -6 }), 24000).activeDb;
    assert.ok(Math.abs(levels(seg(0), 24000).activeDb - onAir) < .6 && onAir < -33, `clip ${levels(seg(0), 24000).activeDb} vs ${onAir}`);
    assert.ok(Math.abs(levels(seg(1), 24000).activeDb - levels(air, 24000).activeDb) < .3, 'an air-level render keeps its intensity gain');
    assert.ok(Math.abs(levels(seg(2), 24000).activeDb - BUS.targetRmsDb) < .6, 'anything else is speech at the bus target');
});

test('reel indexes items in order and stops before maxMs', () => {
    assert.equal(reel([]), null);
    const items = [0, 1, 2, 3, 4].map(i => ({ label: `item ${i}`, kind: i < 2 ? 'style' : 'clip', pcm: sine(1, 300 + i * 100, i % 2 ? 44100 : 24000, .05), rate: i % 2 ? 44100 : 24000 }));
    const r = reel(items, { maxMs: 2500 });
    assert.deepEqual(r.index.map(x => [x.label, x.kind, x.startMs]), [['item 0', 'style', 0], ['item 1', 'style', 1350]]);
    assert.equal(r.truncated, 3); assert.ok(r.durationMs <= 2500);
    const w = readWav(r.bytes);
    assert.equal(w.rate, 24000); assert.ok(Math.abs(w.ms - 2350) < 1);
    assert.ok(Math.abs(levels(w.samples.subarray(0, 24000), 24000).activeDb + 20) < .6);
    const all = reel(items, { rate: 16000 });
    assert.equal(all.truncated, 0); assert.equal(all.index.length, 5);
    all.index.forEach((x, i) => { if (i) assert.ok(x.startMs > all.index[i - 1].startMs); });
    assert.equal(readWav(all.bytes).rate, 16000);
    assert.equal(reel([{ label: 'long', kind: 'style', pcm: sine(3, 440), rate: 24000 }], { maxMs: 1000 }), null);
    const hot = reel([{ label: 'hot', kind: 'clip', pcm: sine(.5, 440, 24000, .01).map((v, i) => i === 100 ? 1 : v), rate: 24000 }]);
    assert.ok(levels(readWav(hot.bytes).samples, 24000).peakDb <= BUS.ceilingDb + 1e-3);
});
