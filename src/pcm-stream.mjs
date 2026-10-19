// One approved part's audio, arriving as raw PCM16 mono chunks (Gemini TTS streaming). Chunks are kept in order so a
// late or reconnecting renderer replays from the start; each subscriber gets every chunk exactly once, then null.
export class PcmStream {
    constructor({ rate = 24000, maxBytes = 12000000 } = {}) {
        this.rate = rate; this.maxBytes = maxBytes; this.chunks = []; this.bytes = 0;
        this.done = false; this.error = null; this.listeners = new Set(); this.createdAt = performance.now(); this.firstAt = null;
        this.first = new Promise((resolve, reject) => { this.resolveFirst = resolve; this.rejectFirst = reject; });
        this.first.catch(() => { });
        this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
    }
    push(buf) {
        if (this.done || !buf?.length) return;
        // PCM16 frames are 2 bytes; an odd tail would shift every later sample.
        if (this.carry) { buf = Buffer.concat([this.carry, buf]); this.carry = null; }
        if (buf.length % 2) { this.carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
        if (!buf.length) return;
        if (this.bytes + buf.length > this.maxBytes) return this.fail(new Error('Stream too long'));
        this.chunks.push(buf); this.bytes += buf.length;
        if (this.firstAt === null) { this.firstAt = performance.now(); this.resolveFirst(this); }
        for (const fn of this.listeners) fn(buf);
    }
    end() {
        if (this.done) return;
        this.done = true;
        if (this.firstAt === null) this.rejectFirst(Object.assign(new Error('Stream ended without audio'), { code: 'TTS_REJECTED' }));
        for (const fn of this.listeners) fn(null);
        this.listeners.clear(); this.resolveFinished(this);
    }
    fail(error) {
        if (this.done) return;
        this.error = error; this.done = true;
        if (this.firstAt === null) this.rejectFirst(error);
        for (const fn of this.listeners) fn(null);
        this.listeners.clear(); this.resolveFinished(this);
    }
    /** Replays buffered chunks, then follows live ones; fn(null) marks the end. Returns an unsubscribe function. */
    subscribe(fn) {
        for (const c of this.chunks) fn(c);
        if (this.done) { fn(null); return () => { }; }
        this.listeners.add(fn); return () => this.listeners.delete(fn);
    }
    get durationMs() { return Math.round(this.bytes / 2 / this.rate * 1000); }
    get firstChunkMs() { return this.firstAt === null ? null : Math.round(this.firstAt - this.createdAt); }
}
