// How a person speaking as Noa is heard (docs/HUMAN_VOICE.md; operator 2026-10-19, NOA Studio Phase 3).
// passthrough: the OBS mic input airs as it is (Phase 1; a voice changer may sit before it). resynth: the person's
// speech is transcribed (local whisper) and spoken again by Noa's own TTS voice (AivisSpeech コハク), so the AI and the
// person sound the same; their raw mic never airs. rvc: an external RVC app turns the mic into コハク's timbre and feeds
// the OBS mic input (Phase 3b; the Studio only opens and mutes that input).
export const HUMAN_VOICE_MODES = Object.freeze(['passthrough', 'resynth', 'rvc']);
/** Whether a handoff to the person opens the OBS mic input (resynth keeps it muted: only Noa's TTS voice airs). */
export const opensMic = mode => mode !== 'resynth';
const SAID = 6;

/** The person's transcribed lines waiting to be spoken in Noa's voice, each synthesized as soon as it arrives (the
 * next one is ready while the current one plays), and what they said since the handoff (for the AI's first line). */
export class HumanLines {
    constructor() { this.items = []; this.said = []; this.seq = 0; }
    /** synth(text) -> Promise<voice>; the item is ready when it settles. */
    add(text, synth) {
        this.seq++; // a prepared resume line made before this line is stale (TalkEngine resume preparation)
        const item = { text, done: false, voice: null, error: null };
        Promise.resolve().then(() => synth(text)).then(v => { item.voice = v; }, e => { item.error = e; }).finally(() => { item.done = true; });
        this.items.push(item);
        return item;
    }
    /** The next line if its audio is ready (or failed), else null; lines stay in order. */
    ready() { return this.items[0]?.done ? this.items.shift() : null; }
    aired(text) { this.said.push(text); if (this.said.length > SAID) this.said.shift(); }
    clear() { this.items = []; }
    /** Start of a handoff: nothing queued, nothing remembered. */
    reset() { this.items = []; this.said = []; }
}
