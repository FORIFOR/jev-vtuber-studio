// Shared by the stage (browser), the voice router and the speech director (Node).
// The Jev `reaction` preset is the ONE emotion vocabulary: this table turns it into
// voice acting (family, intensity, pace) and an optional wordless clip, so voice and
// avatar never disagree. Big presets share their fallback's voice, so a publication-time
// downgrade (shock → surprised) never contradicts audio that was already rendered.
import { REACTIONS, isReaction } from './avatar-rig.mjs';

export const VOICE_FAMILIES = ['neutral', 'calm', 'joy', 'surprise', 'shy', 'think', 'worry'];
export const INTENSITIES = ['low', 'mid', 'high'];
export const PACES = ['slow', 'normal', 'fast'];
export const ENDINGS = ['continue', 'beat', 'hold'];
export const INTENSITY_GAIN = Object.freeze({ low: .7, mid: 1, high: 1.25 });

const voice = (family, intensity, pace) => Object.freeze({ family, intensity, pace });
const act = (v, cls = null) => Object.freeze({ voice: v, clip: cls ? Object.freeze({ cls }) : null });
const NEUTRAL = voice('neutral', 'mid', 'normal'), JOY = voice('joy', 'mid', 'normal'), SURPRISE = voice('surprise', 'high', 'fast');
/** Preset → voice acting. Shared voice objects are reused by reference (big preset = its fallback's voice). */
export const VOICE_ACTING = Object.freeze({
    neutral: act(NEUTRAL),
    nod: act(voice('calm', 'mid', 'normal')),
    happy: act(JOY),
    laugh: act(JOY, 'laugh_big'),
    excited: act(JOY, 'breath_in'),
    surprised: act(SURPRISE),
    shock: act(SURPRISE, 'gasp'),
    embarrassed: act(voice('shy', 'low', 'slow'), 'laugh_small'),
    thinking: act(voice('think', 'low', 'slow'), 'hmm'),
    troubled: act(voice('worry', 'low', 'slow'), 'breath_out'),
    listen: act(null),
});
const nv = (position, reactions, extra = {}) => Object.freeze({ position, reactions: Object.freeze(reactions), ...extra });
/** Closed wordless clip classes, in canonical order. `pre` plays before part 0, `post` after the last part.
 * `reactions` lists the presets a Jev-chosen clip may accompany ('jev' direction mode). */
export const NONVERBAL = Object.freeze({
    gasp: nv('pre', ['shock', 'surprised']),
    laugh_small: nv('post', ['happy', 'laugh', 'embarrassed', 'nod', 'excited']),
    laugh_big: nv('pre', ['laugh']),
    breath_in: nv('pre', ['excited', 'neutral', 'nod', 'thinking', 'happy', 'surprised']),
    breath_out: nv('post', ['troubled', 'thinking', 'neutral', 'nod', 'happy']),
    sigh: nv('post', ['troubled', 'thinking']),
    hmm: nv('pre', ['thinking', 'nod', 'neutral'], { mouth: .2 }),
});
/** Jev candidate descriptions for delivery_nonverbal (English, like other Jev questions). */
export const NONVERBAL_TEXT = Object.freeze({
    gasp: 'Short surprised intake of breath before speaking',
    laugh_small: 'Small chuckle',
    laugh_big: 'Hearty laugh, only when genuinely funny',
    breath_in: 'Audible breath before speaking',
    breath_out: 'Relieved exhale after speaking',
    sigh: 'Soft sigh',
    hmm: 'Closed-mouth thinking hum',
});
export const CLIP_COOLDOWN_MS = Object.freeze({ gasp: 8000, laugh_big: 30000, laugh_small: 30000, breath_in: 20000, breath_out: 45000, sigh: 45000, hmm: 30000 });
export const CLIP_MIN_SPACING_MS = 8000;

const actable = name => isReaction(name) && !REACTIONS[name].local && Object.hasOwn(VOICE_ACTING, name);
const isClip = cls => typeof cls === 'string' && Object.hasOwn(NONVERBAL, cls);
export const voiceActing = name => actable(name) ? VOICE_ACTING[name] : VOICE_ACTING.neutral;
/** The calm preset used for mid-part beats: big presets fall back, unknown/local names are neutral. */
export function calmReaction(name) {
    if (!isReaction(name) || REACTIONS[name].local) return 'neutral';
    return REACTIONS[name].big ? REACTIONS[name].fallback || 'neutral' : name;
}
export function clipCompatible(cls, reaction, mode) {
    if (!isClip(cls)) return false;
    if (mode === 'reaction') return voiceActing(reaction).clip?.cls === cls;
    if (mode === 'jev') return NONVERBAL[cls].reactions.includes(reaction) === true;
    return false;
}
/** False when the words already carry the sound (a laugh clip after 「あはは」 would double it). */
export function clipAllowedForText(cls, text) {
    const t = String(text ?? '').trim();
    if (cls === 'laugh_small' || cls === 'laugh_big') return !/^(?:あは|はは|ふふ|えへ|うふ)|(?:笑|あはは|ふふっ)[。！]*$/u.test(t);
    if (cls === 'hmm') return !/^(?:うーん|んー|えーと|ふむ)/u.test(t);
    if (cls === 'breath_out' || cls === 'sigh') return !/(?:はぁ|はあ|ふう|ふぅ)[。！…]*$/u.test(t);
    if (cls === 'gasp') return !/^(?:はっ|ひっ)/u.test(t);
    return true;
}
/** Stage voice lead: the reflex lead (0..400 ms), shortened by a server lead (0 when a pre-clip carries the reflex). */
export function voiceLead(reflexLead, serverLead) {
    const r = Math.max(0, Math.min(400, Number(reflexLead) || 0));
    return Number.isFinite(serverLead) ? Math.min(r, Math.max(0, serverLead)) : r;
}
/** Per-class cooldowns plus a minimum spacing between any two clips. allow() never mutates; commit() on publication. */
export class ClipGovernor {
    constructor(now = Date.now) { this.now = now; this.last = Object.create(null); this.lastAny = -Infinity; }
    allow(cls, at = this.now()) {
        return isClip(cls) && at - this.lastAny >= CLIP_MIN_SPACING_MS && at - (this.last[cls] ?? -Infinity) >= CLIP_COOLDOWN_MS[cls];
    }
    commit(cls, at = this.now()) { this.last[cls] = at; this.lastAny = at; }
}
