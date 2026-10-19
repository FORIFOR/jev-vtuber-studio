// Shared wire format: bounded audio-relative milliseconds, never wall-clock time.
export const MAX_LIP_CUES = 4000;
const VOWELS = ['a', 'i', 'u', 'e', 'o', 'n', 'x'];
const CLOSED = Object.freeze({ a: 0, i: 0, u: 0, e: 0, o: 0, n: 1 });
export function validLipSync(value) {
    if (!value || value.version !== 1 || !['query', 'reading-estimate', 'mixed'].includes(value.source)
        || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.durationMs > 45000
        || !Array.isArray(value.cues) || !value.cues.length || value.cues.length > MAX_LIP_CUES) return false;
    let end = 0;
    for (const cue of value.cues) {
        if (!cue || !VOWELS.includes(cue.vowel) || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs)
            || cue.startMs < end || cue.endMs <= cue.startMs || cue.endMs > value.durationMs + .001
            || (cue.strength !== undefined && (!Number.isFinite(cue.strength) || cue.strength < 0 || cue.strength > 1))) return false;
        end = cue.endMs;
    }
    return true;
}

/** Call after validLipSync once per utterance. Gaps/pause/awaiting playback close the mouth.
 * x returns null: recorded reactions/unknown TTS keep the existing amplitude-driven mouth. */
export function visemeAt(timeline, milliseconds, role = 'host') {
    if (role === 'comment' || !Number.isFinite(milliseconds) || milliseconds < 0) return CLOSED;
    if (!timeline) return null;
    if (milliseconds >= timeline.durationMs) return CLOSED;
    let low = 0, high = timeline.cues.length;
    while (low < high) { const mid = (low + high) >>> 1; if (timeline.cues[mid].endMs <= milliseconds) low = mid + 1; else high = mid; }
    const cue = timeline.cues[low];
    if (!cue || milliseconds < cue.startMs || cue.vowel === 'n') return CLOSED;
    if (cue.vowel === 'x') return null;
    const strength = cue.strength ?? 1;
    return { a: 0, i: 0, u: 0, e: 0, o: 0, n: 1 - strength, [cue.vowel]: strength };
}

/** One utterance owns this clock. AudioContext.currentTime stops on suspension;
 * fetch/ACK/reflex delays and wall-clock jumps cannot advance its phonemes. */
export class SpeechVisemeClock {
    constructor() { this.reset(); }
    reset() { this.timeline = null; this.startedAt = null; this.role = 'host'; }
    prepare(speech) {
        this.reset(); this.role = speech.role || 'host';
        this.timeline = validLipSync(speech.lipSync) ? speech.lipSync : null;
    }
    start(audioTime) { this.startedAt = Number.isFinite(audioTime) ? audioTime : null; }
    sample(audioTime) {
        if (!this.timeline) return this.role === 'comment' ? CLOSED : null;
        const elapsed = this.startedAt !== null && Number.isFinite(audioTime) ? (audioTime - this.startedAt) * 1000 : NaN;
        return visemeAt(this.timeline, elapsed, this.role);
    }
}
