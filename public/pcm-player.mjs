// Plays one approved part that arrives as raw PCM16 mono chunks. Chunks are scheduled back to back in arrival order on
// the audio clock; playback starts only after `prebufferMs` is buffered (or the stream ended), so a slow network makes a
// short gap instead of garbled order. onStart fires once, right before the first sample; onEnd once, after the last.
export class PcmPlayer {
    constructor({ ctx, destination, rate = 24000, prebufferMs = 300, beforeStart = async () => true, onStart = () => { }, onEnd = () => { } }) {
        Object.assign(this, { ctx, destination, rate, beforeStart, onStart, onEnd });
        this.prebufferBytes = Math.round(rate * prebufferMs / 1000) * 2;
        this.queue = []; this.queuedBytes = 0; this.carry = null; this.cursor = 0; this.sources = new Set();
        this.state = 'buffering'; this.ended = false; this.cancelled = false; this.gaps = 0; this.scheduledMs = 0;
    }
    push(bytes) {
        if (this.cancelled || this.ended || !bytes?.length) return;
        let b = bytes;
        if (this.carry) { const m = new Uint8Array(this.carry.length + b.length); m.set(this.carry); m.set(b, this.carry.length); b = m; this.carry = null; }
        if (b.length % 2) { this.carry = b.slice(b.length - 1); b = b.subarray(0, b.length - 1); }
        if (!b.length) return;
        if (this.state === 'playing') return this.schedule(b);
        this.queue.push(b); this.queuedBytes += b.length;
        if (this.state === 'buffering' && this.queuedBytes >= this.prebufferBytes) void this.begin();
    }
    end() {
        if (this.cancelled || this.ended) return;
        this.ended = true;
        if (this.state === 'buffering') { if (this.queuedBytes) void this.begin(); else this.finish(); }
        else if (this.state === 'playing' && !this.sources.size) this.finish();
    }
    async begin() {
        this.state = 'starting';
        const ok = await this.beforeStart();
        if (this.cancelled) return;
        if (!ok) { this.cancel(); return; }
        this.state = 'playing'; this.onStart();
        for (const b of this.queue.splice(0)) this.schedule(b);
        this.queuedBytes = 0;
        if (this.ended && !this.sources.size) this.finish();
    }
    schedule(bytes) {
        const n = bytes.length >> 1, buf = this.ctx.createBuffer(1, n, this.rate), ch = buf.getChannelData(0);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.destination);
        const now = this.ctx.currentTime + .02;
        if (this.cursor && this.cursor < now) this.gaps++; // Underrun: the next chunk came late; play it as soon as possible.
        const at = Math.max(this.cursor, now);
        src.start(at); this.cursor = at + n / this.rate; this.scheduledMs += n / this.rate * 1000;
        this.sources.add(src);
        src.onended = () => { this.sources.delete(src); if (this.ended && !this.sources.size && this.state === 'playing') this.finish(); };
    }
    finish() { if (this.state === 'done' || this.cancelled) return; this.state = 'done'; this.onEnd(); }
    cancel() {
        if (this.cancelled) return;
        this.cancelled = true; this.state = 'cancelled';
        for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { } }
        this.sources.clear(); this.queue = [];
    }
}
