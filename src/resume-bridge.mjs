// A short fixed line for the moment the AI takes Noa's voice back and no prepared line is ready (docs/CONTROL.md;
// operator 2026-10-19, NOA Studio Phase 4). Gated (safety, as a fixed operator-style line) and voiced once, at the first
// handoff of a show, so it airs at once; rotated, and at most one every 5 minutes so it does not become a catchphrase.
export const BRIDGE_LINES = Object.freeze(['うん、じゃあ続けるね。', 'よし、ここからはわたしが話すね。', 'お待たせ、続きはわたしから話すね。', 'じゃあ、ここからまたわたしね。']);
export const BRIDGE_EVERY_MS = 5 * 60 * 1000;

export class ResumeBridge {
    constructor({ now = Date.now } = {}) { this.now = now; this.reset(); }
    reset() { this.ready = []; this.preparing = null; this.next = 0; this.lastAt = -Infinity; }
    /** Gate and voice every line once (judge(text) -> verdict, synth(text) -> voice); failures leave that line out. */
    prepare(judge, synth) {
        this.preparing ??= (async () => {
            for (const text of BRIDGE_LINES) {
                try {
                    const verdict = await judge(text);
                    if (!verdict?.accept) continue;
                    const voice = await synth(text);
                    if (voice?.bytes || voice?.kind === 'browser') this.ready.push({ text, voice });
                } catch { /* that line is simply not available */ }
            }
        })();
        return this.preparing;
    }
    /** The next ready line, or null when none is ready or one aired less than 5 minutes ago. */
    take() {
        if (!this.ready.length || this.now() - this.lastAt < BRIDGE_EVERY_MS) return null;
        const line = this.ready[this.next++ % this.ready.length];
        this.lastAt = this.now();
        return line;
    }
}
