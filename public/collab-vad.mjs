// Voice activity for the voice-call partner (public/collab.mjs, docs/COLLAB.md). Pure and shared with the tests: the
// partner's audio (mono, 16 kHz) in 20 ms frames -> 'start' when they begin speaking, 'end' with the utterance when
// they pause, 'discard' for a blip too short to be speech. An energy threshold, not a model: Discord's output carries
// only the other people in the call, already noise-suppressed by Discord.
export const RATE = 16000;

/** Linear resampling to 16 kHz (the capture runs at the device rate). */
export function downsample(input, fromRate, toRate = RATE) {
    if (fromRate === toRate) return Float32Array.from(input);
    const ratio = fromRate / toRate, out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
        const at = i * ratio, j = Math.floor(at), f = at - j;
        out[i] = (input[j] ?? 0) * (1 - f) + (input[j + 1] ?? input[j] ?? 0) * f;
    }
    return out;
}

/** 16-bit PCM mono WAV bytes. */
export function encodeWav(samples, rate = RATE) {
    const b = new DataView(new ArrayBuffer(44 + samples.length * 2)), text = (at, s) => { for (let i = 0; i < s.length; i++) b.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); b.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, rate, true);
    b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); text(36, 'data'); b.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
    return new Uint8Array(b.buffer);
}

export class Segmenter {
    constructor({ threshold = .015, frameMs = 20, startFrames = 3, endSilenceMs = 600, preRollMs = 300, maxMs = 25000, minSpeechMs = 300 } = {}) {
        Object.assign(this, { threshold, frame: RATE * frameMs / 1000, frameMs, startFrames, endSilenceMs, preRollMs, maxMs, minSpeechMs });
        this.rest = new Float32Array(0); this.pre = []; this.voiced = 0; this.active = null; this.level = 0;
    }
    /** Feed 16 kHz samples; -> events in order. */
    push(samples) {
        const events = [], all = new Float32Array(this.rest.length + samples.length);
        all.set(this.rest); all.set(samples, this.rest.length);
        let at = 0;
        for (; at + this.frame <= all.length; at += this.frame) this.frameIn(all.subarray(at, at + this.frame), events);
        this.rest = all.slice(at);
        return events;
    }
    frameIn(f, events) {
        let sum = 0; for (const v of f) sum += v * v;
        const rms = Math.sqrt(sum / f.length), loud = rms >= this.threshold, copy = Float32Array.from(f);
        this.level = rms;
        if (!this.active) {
            this.pre.push(copy); if (this.pre.length > this.preRollMs / this.frameMs) this.pre.shift();
            this.voiced = loud ? this.voiced + 1 : 0;
            if (this.voiced >= this.startFrames) { this.active = { frames: [...this.pre], speechMs: this.voiced * this.frameMs, silentMs: 0 }; this.pre = []; events.push({ type: 'start' }); }
            return;
        }
        const a = this.active;
        a.frames.push(copy);
        if (loud) { a.speechMs += this.frameMs; a.silentMs = 0; } else a.silentMs += this.frameMs;
        if (a.silentMs >= this.endSilenceMs || a.frames.length * this.frameMs >= this.maxMs) this.finish(events);
    }
    finish(events) {
        const a = this.active; this.active = null; this.voiced = 0;
        if (!a) return;
        if (a.speechMs < this.minSpeechMs) { events.push({ type: 'discard' }); return; }
        const pcm = new Float32Array(a.frames.length * this.frame);
        a.frames.forEach((f, i) => pcm.set(f, i * this.frame));
        events.push({ type: 'end', pcm, speechMs: a.speechMs });
    }
}
