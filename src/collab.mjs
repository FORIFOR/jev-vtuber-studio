// The voice-call partner (docs/COLLAB.md; NOA Studio Phase 2): whether they are speaking (the capture page's voice
// activity), what they said (whisper transcripts) and what Noa said back, for turn taking, barge-in, the reply's
// conversation context and dropping Noa's own voice heard back through the partner's mic. One partner (one mixed
// Discord output); their name is the operator's COLLAB_NAME, never guessed from speech.
export const FLOOR_GAP_MS = 600; // after the partner stops, Noa waits this long before starting a new line
export const PARTNER_ACTIVE_MS = 8000; // Noa's own talk (and comments, partner first) wait this long after the partner
const HISTORY = 12, ECHO_WINDOW_MS = 20000;

const bigrams = s => { const t = String(s).replace(/[\s。、．，,.!?！？…「」『』"'ー〜~]/g, ''), out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
/** How much of the transcript's wording appears in Noa's line (0-1). */
function overlap(heard, said) {
    const a = bigrams(heard), b = bigrams(said);
    if (!a.size || !b.size) return 0;
    let n = 0; for (const x of a) if (b.has(x)) n++;
    return n / a.size;
}

export class CollabSession {
    constructor({ now = Date.now } = {}) { this.now = now; this.reset(); }
    reset() { this.speakingSince = null; this.lastSpeechEnd = 0; this.lastHeardAt = 0; this.log = []; }
    /** The capture page saw the partner start (true) or stop (false) speaking. */
    speaking(on) {
        const t = this.now();
        if (on && this.speakingSince === null) this.speakingSince = t;
        else if (!on && this.speakingSince !== null) { this.speakingSince = null; this.lastSpeechEnd = t; }
    }
    /** How long the partner has been speaking without a pause (0 when silent). */
    speakingFor() { return this.speakingSince === null ? 0 : this.now() - this.speakingSince; }
    /** The partner has the floor: speaking, or just stopped. */
    holdsFloor(gapMs = FLOOR_GAP_MS) { return this.speakingSince !== null || this.now() - this.lastSpeechEnd < gapMs; }
    /** The partner spoke (or was heard) within ms. */
    activeWithin(ms = PARTNER_ACTIVE_MS) { const t = this.now(); return this.speakingSince !== null || t - this.lastSpeechEnd < ms || t - this.lastHeardAt < ms; }
    heard(text) { const at = this.now(); this.lastHeardAt = at; this.push({ who: 'partner', text, at }); }
    said(text) { this.push({ who: 'noa', text, at: this.now() }); }
    push(x) { this.log.push(x); if (this.log.length > HISTORY) this.log.shift(); }
    /** The last n turns of the call, oldest first: [{ who: 'partner' | 'noa', text }]. */
    dialogue(n = 6) { return this.log.slice(-n).map(({ who, text }) => ({ who, text })); }
    /** Noa's own recent line heard back through the partner's mic (no headphones): most of its wording is hers. */
    isEcho(text) {
        const t = this.now();
        return this.log.some(x => x.who === 'noa' && t - x.at < ECHO_WINDOW_MS && overlap(text, x.text) >= .6);
    }
}
