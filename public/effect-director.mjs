// Noa's on-screen acting effects: which preset (if any) a moment deserves, and the limits that keep the screen quiet.
// Pure and shared (stage + tests). No AI calls: it maps what already happened — the approved line as it starts playing
// (speech_started, with the Jev reaction and the line's cue) and real game state — onto a few Noa-specific presets.
// A preset is one act: the avatar's face/body come from the same reaction; this adds light, lines and a telop.

/** fx: the drawing around Noa. telopStyle: how the emphasised spoken words look (null = no telop). ms: on-screen time. */
export const NOA_EFFECTS = Object.freeze({
    joy: { fx: 'sparkle', telopStyle: 'joy', sfx: null, ms: 1600, priority: 2 },
    surprise: { fx: 'speedlines', telopStyle: 'surprise', sfx: null, ms: 1100, priority: 3 },
    shy: { fx: 'warmglow', telopStyle: 'shy', sfx: null, ms: 1800, priority: 2 },
    trouble: { fx: 'sweat', telopStyle: 'trouble', sfx: null, ms: 1500, priority: 2 },
    laugh: { fx: 'bounce', telopStyle: 'laugh', sfx: null, ms: 1400, priority: 2 },
    record: { fx: 'confetti', telopStyle: null, sfx: 'chime', ms: 2600, priority: 4 }, // the board banner already names the record
});
export const MAX_EFFECT_MS = 3000, PRESET_COOLDOWN_MS = 6000;

// Words worth lifting out of the line, most telling first. Only a whole clause is ever shown (see telopFrom).
const KEYWORDS = {
    joy: ['助かった', 'やった', '消えた', 'ライン', 'よし', 'いいね'], surprise: ['待って', 'えっ', 'うわ', 'わっ', 'あっ'],
    shy: ['照れ', '褒め', 'えへへ'], trouble: ['あー', 'しまった', '詰まっ', '積みすぎ', '近い'], laugh: ['ふふ', 'あはは', '笑'],
};
const CONDITION_END = /(ら|ば|ても|なら|と|けど|のに)、$/; // "…たら、" makes the next clause conditional: never show it alone
const MAX_TELOP_CHARS = 10;
const bare = t => t.replace(/[、。！？!?…\s]/g, '');

/** The emphasised words for a telop: one complete clause of the approved line (so negations and conditions stay with
 * their words), short enough to read at a glance, or null. There are no word timings: it is shown for the part. */
export function telopFrom(text, preset) {
    if (typeof text !== 'string' || !NOA_EFFECTS[preset]?.telopStyle) return null;
    const clauses = text.match(/[^、。！？!?…]+[、。！？!?…]*/g)?.map(c => c.trim()).filter(Boolean) ?? [];
    const usable = clauses.map((c, i) => ({ c, ok: bare(c).length > 0 && bare(c).length <= MAX_TELOP_CHARS && !(i > 0 && CONDITION_END.test(clauses[i - 1])) && !CONDITION_END.test(c) }));
    for (const kw of KEYWORDS[preset] || []) { const hit = usable.find(x => x.ok && x.c.includes(kw)); if (hit) return hit.c.replace(/、$/, ''); }
    const exclaimed = usable.find(x => x.ok && /[！!]$/.test(x.c));
    return exclaimed ? exclaimed.c : null;
}

/** Event type behind a line's cue.eventId (round-001:12:line_clear, follow-…, result-…, recap-…, intro-…, speed-…). */
export function eventTypeOf(eventId) {
    const id = String(eventId ?? '');
    if (id.startsWith('follow-')) return 'danger_recovered';
    const pre = /^(result|recap|intro|speed)-/.exec(id); if (pre) return pre[1];
    return id.split(':')[2] ?? null;
}

/** Effect for a line as it starts playing (speech_started payload), or null. Ordinary thanks just smile (the face does
 * it); a real game success shines; a viewer's worry never gets a comic sweat; the narrator reading a comment gets none. */
export function speechEffect(d) {
    if (!d || (d.role ?? 'host') !== 'host') return null;
    const u = String(d.cue?.utterance ?? ''), game = u.startsWith('game_'), type = eventTypeOf(d.cue?.eventId), r = d.reaction;
    let preset = null;
    if (r === 'surprised' || r === 'shock') preset = 'surprise';
    else if (r === 'laugh') preset = 'laugh';
    else if (r === 'embarrassed') preset = 'shy';
    else if (r === 'troubled') preset = game ? 'trouble' : null;
    else if (r === 'happy' || r === 'excited') preset = (game && ['line_clear', 'danger_exit', 'danger_recovered'].includes(type)) || (r === 'excited' && d.intensity === 'high') ? 'joy' : null;
    if (!preset) return null;
    return { ...NOA_EFFECTS[preset], preset, key: `speech:${d.id}`, epoch: d.cue?.epoch ?? null, telop: telopFrom(d.text, preset) };
}

/** Effect straight from the game (not from speech): a first record / new best, seen live as the round ends. A stage that
 * (re)connects during results has no `prev` playing phase, so it never replays a celebration. */
export function gameEffect(prev, st) {
    const r = st?.lastResult;
    if (prev?.phase !== 'playing' || st?.phase !== 'results' || !r || prev.roundId !== r.roundId) return null;
    if (!(r.previousBest === null || r.newBest)) return null;
    return { ...NOA_EFFECTS.record, preset: 'record', key: `record:${r.roundId}`, epoch: null, telop: null };
}

/** The limits live in code, not in Jev: each event once, one lead effect at a time (a higher priority may take over),
 * a cooldown per preset, nothing from another session, never longer than MAX_EFFECT_MS. */
export class EffectDirector {
    constructor({ now = Date.now } = {}) { this.now = now; this.seen = new Set(); this.active = null; this.lastAt = {}; this.epoch = null; }
    setEpoch(epoch) { if (epoch !== undefined && epoch !== this.epoch) { this.epoch = epoch; this.clear(); } }
    offer(e) {
        if (!e || this.seen.has(e.key)) return null;
        if (e.epoch !== null && e.epoch !== undefined && this.epoch !== null && e.epoch !== this.epoch) return null;
        const now = this.now();
        if (now - (this.lastAt[e.preset] ?? -Infinity) < PRESET_COOLDOWN_MS) return null;
        if (this.active && now < this.active.until && this.active.priority >= e.priority) return null;
        this.seen.add(e.key); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
        this.lastAt[e.preset] = now;
        this.active = { ...e, ms: Math.min(e.ms, MAX_EFFECT_MS), until: now + Math.min(e.ms, MAX_EFFECT_MS) };
        return this.active;
    }
    clear() { this.active = null; }
}
