// Shared by the stage (browser), the engine and the VTube Studio bridge (Node).
// Jev only ever chooses a preset name; this file turns it into acting.
// Parameter ids follow the Live2D Cubism standard parameter names.

export const PARAMS = {
    ParamAngleX: [-30, 30, 0], ParamAngleY: [-30, 30, 0], ParamAngleZ: [-30, 30, 0],
    ParamBodyAngleX: [-10, 10, 0], ParamBodyAngleY: [-10, 10, 0], ParamBodyAngleZ: [-10, 10, 0],
    ParamEyeLOpen: [0, 1.2, 1], ParamEyeROpen: [0, 1.2, 1],
    ParamEyeLSmile: [0, 1, 0], ParamEyeRSmile: [0, 1, 0],
    ParamEyeBallX: [-1, 1, 0], ParamEyeBallY: [-1, 1, 0],
    ParamBrowLY: [-1, 1, 0], ParamBrowRY: [-1, 1, 0], ParamBrowLAngle: [-1, 1, 0], ParamBrowRAngle: [-1, 1, 0],
    ParamMouthOpenY: [0, 1, 0], ParamMouthForm: [-1, 1, 0], ParamCheek: [0, 1, 0], ParamBreath: [0, 1, 0],
};
export const clampParam = (id, v) => { const r = PARAMS[id]; return r && Number.isFinite(v) ? Math.max(r[0], Math.min(r[1], v)) : r?.[2] ?? 0; };

const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
// Rises over `rise` ms, holds, falls over `fall` ms: 0..1 envelope for a gesture.
const pulse = (t, rise, hold, fall) => t < 0 ? 0 : t < rise ? ease(t / rise) : t < rise + hold ? 1 : ease(1 - (t - rise - hold) / fall);

/** Code-side acting. `face` is held while speaking and during the afterglow; `reflex`
 * is the short involuntary peak before the voice; `motion(t)` returns body/head deltas.
 * `lead` delays the voice so the reflex visibly comes first (bounded, ms).
 * `affect` nudges the persistent mood. `big` presets are rate-limited by Effects. */
export const REACTIONS = {
    neutral: { label: '平常', face: {}, motion: () => ({}), afterMs: 600, lead: 0, camera: 'keep', sfx: 'none', affect: {} },
    nod: { label: 'うなずき', face: { ParamMouthForm: .3, ParamEyeLSmile: .15, ParamEyeRSmile: .15 },
        motion: t => ({ ParamAngleY: -9 * pulse(t, 160, 60, 220) + -5 * pulse(t - 520, 140, 40, 200) }), afterMs: 900, lead: 60, camera: 'keep', sfx: 'none', affect: { happy: .03, focus: .05 } },
    happy: { label: 'にっこり', face: { ParamMouthForm: .85, ParamEyeLSmile: .6, ParamEyeRSmile: .6, ParamCheek: .25, ParamBrowLY: .25, ParamBrowRY: .25 },
        motion: t => ({ ParamAngleZ: 5 * pulse(t, 260, 900, 500), ParamBodyAngleZ: 2 * pulse(t, 300, 900, 500) }), afterMs: 1800, lead: 80, camera: 'keep', sfx: 'none', affect: { happy: .15, energy: .05 } },
    laugh: { label: '笑う', big: true, fallback: 'happy', face: { ParamMouthForm: 1, ParamEyeLSmile: 1, ParamEyeRSmile: 1, ParamCheek: .35, ParamBrowLY: .35, ParamBrowRY: .35 },
        reflex: { ms: 220, params: { ParamEyeLOpen: -.6, ParamEyeROpen: -.6 } },
        motion: t => { const k = pulse(t, 120, 1100, 450); return { ParamBodyAngleY: 3 * k * Math.sin(t / 55), ParamAngleZ: -6 * k + 2 * k * Math.sin(t / 70), ParamAngleY: 4 * k * Math.abs(Math.sin(t / 110)) }; },
        afterMs: 2200, lead: 140, camera: 'keep', sfx: 'none', affect: { happy: .22, energy: .15 } },
    surprised: { label: 'びっくり', fallback: 'neutral', face: { ParamEyeLOpen: .15, ParamEyeROpen: .15, ParamBrowLY: .7, ParamBrowRY: .7, ParamMouthForm: -.1 },
        reflex: { ms: 260, params: { ParamEyeLOpen: .2, ParamEyeROpen: .2, ParamBrowLY: .3, ParamBrowRY: .3, ParamMouthOpenY: .35 } },
        motion: t => ({ ParamAngleY: 6 * pulse(t, 90, 120, 400), ParamBodyAngleY: 3 * pulse(t, 90, 80, 380) }), afterMs: 1200, lead: 200, camera: 'keep', sfx: 'none', affect: { energy: .12, focus: .1 } },
    shock: { label: 'のけぞる', big: true, fallback: 'surprised', face: { ParamEyeLOpen: .2, ParamEyeROpen: .2, ParamBrowLY: 1, ParamBrowRY: 1, ParamMouthForm: -.35 },
        reflex: { ms: 320, params: { ParamEyeLOpen: .2, ParamEyeROpen: .2, ParamMouthOpenY: .6 } },
        motion: t => { const k = pulse(t, 110, 260, 700); return { ParamBodyAngleX: -8 * k, ParamAngleX: -14 * k, ParamAngleY: 8 * k, ParamAngleZ: -7 * k }; },
        afterMs: 1400, lead: 280, camera: 'face_zoom', sfx: 'shock', affect: { energy: .2, focus: .15, happy: -.05 } },
    embarrassed: { label: '照れる', fallback: 'happy', face: { ParamCheek: 1, ParamMouthForm: .45, ParamEyeLSmile: .35, ParamEyeRSmile: .35, ParamEyeBallX: -.7, ParamEyeBallY: -.35, ParamBrowLAngle: .35, ParamBrowRAngle: .35 },
        motion: t => { const k = pulse(t, 380, 1600, 700); return { ParamAngleX: -10 * k, ParamAngleY: -7 * k, ParamAngleZ: 8 * k, ParamBodyAngleZ: 2 * k }; },
        afterMs: 2400, lead: 120, camera: 'keep', sfx: 'none', affect: { happy: .1, energy: -.02 } },
    thinking: { label: '考える', face: { ParamEyeBallX: .45, ParamEyeBallY: .6, ParamBrowLY: .2, ParamBrowRY: -.15, ParamBrowLAngle: -.3, ParamMouthForm: -.15 },
        motion: t => { const k = pulse(t, 500, 1800, 800); return { ParamAngleX: 8 * k, ParamAngleZ: 9 * k, ParamAngleY: 4 * k }; }, afterMs: 1400, lead: 0, camera: 'keep', sfx: 'none', affect: { focus: .15, energy: -.05 } },
    troubled: { label: '困り顔', face: { ParamBrowLAngle: .8, ParamBrowRAngle: .8, ParamBrowLY: .15, ParamBrowRY: .15, ParamMouthForm: -.45, ParamEyeLOpen: -.15, ParamEyeROpen: -.15, ParamEyeBallX: -.25, ParamEyeBallY: -.4 },
        motion: t => { const k = pulse(t, 400, 1300, 700); return { ParamAngleZ: -7 * k, ParamAngleY: -5 * k }; }, afterMs: 1500, lead: 60, camera: 'keep', sfx: 'none', affect: { happy: -.1, focus: .05 } },
    excited: { label: 'はしゃぐ', big: true, fallback: 'happy', face: { ParamMouthForm: 1, ParamEyeLOpen: .15, ParamEyeROpen: .15, ParamBrowLY: .6, ParamBrowRY: .6, ParamCheek: .3 },
        reflex: { ms: 200, params: { ParamMouthOpenY: .4 } },
        motion: t => { const k = pulse(t, 140, 900, 500); return { ParamBodyAngleY: 6 * k * Math.abs(Math.sin(t / 130)), ParamAngleY: 7 * k, ParamAngleZ: 4 * k * Math.sin(t / 160) }; },
        afterMs: 1800, lead: 160, camera: 'face_zoom', sfx: 'spark', affect: { happy: .2, energy: .25 } },
    // Local only: never offered to Jev. Used while the narrator reads a picked comment.
    listen: { label: 'コメントを見る', local: true, face: { ParamEyeBallX: -.65, ParamEyeBallY: .25, ParamBrowLY: .2, ParamBrowRY: .2 },
        motion: t => { const k = pulse(t, 450, 60000, 500); return { ParamAngleX: -12 * k, ParamAngleY: 3 * k, ParamAngleZ: -4 * k }; }, afterMs: 0, lead: 0, camera: 'keep', sfx: 'none', affect: { focus: .08 } },
};
/** Candidates offered to Jev (typed choice). Descriptions stay English like other Jev questions. */
export const JEV_REACTIONS = {
    neutral: 'Calm ordinary delivery, no particular reaction',
    nod: 'Agreeing, acknowledging or confirming softly',
    happy: 'Pleased, warm smile',
    laugh: 'Laughing at something genuinely funny',
    surprised: 'Mild surprise or a small discovery',
    shock: 'Big surprise or alarm, visible recoil',
    embarrassed: 'Shy or flustered, e.g. after praise',
    thinking: 'Pondering or weighing options',
    troubled: 'Concerned, apologetic or wry',
    excited: 'Excited cheer or triumph',
};
export const isReaction = name => typeof name === 'string' && Object.hasOwn(REACTIONS, name);
/** Legacy verdicts only carry a mood; keep them acting sensibly. */
export function reactionFor({ reaction, mood } = {}) {
    if (isReaction(reaction)) return reaction;
    return ({ happy: 'happy', curious: 'thinking' })[mood] || 'neutral';
}
/** Demo mode never calls Jev: a transparent keyword stand-in. */
export function demoReaction(text = '') {
    if (/(あはは|ふふっ|笑っちゃ|（笑）|\(笑\))/.test(text)) return 'laugh';
    if (/(危な|うわっ|ひゃっ|ええっ)/.test(text)) return 'shock';
    if (/(えっ|おっと|あれ[？?、]|びっくり|まさか)/.test(text)) return 'surprised';
    if (/(照れ|恥ずかし)/.test(text)) return 'embarrassed';
    if (/(やった|星を|最高)/.test(text)) return 'excited';
    if (/(うれし|楽し|いいね|素敵|よし|消えた|助かった|持ち直)/.test(text)) return 'happy';
    if (/(ごめん|困っ|難しい|近い|積みすぎ|詰まっ)/.test(text)) return 'troubled';
    if (/(うーん|かな[。？?]|考え|どうだろう)/.test(text)) return 'thinking';
    if (/(なるほど|たしかに|そうそう|うんうん)/.test(text)) return 'nod';
    return 'neutral';
}
/** Instant face for a just-picked comment, before any words: a local tone read, never spoken, never a gate decision. */
export function commentReflex(text = '') {
    if (/(眠れ|疲れ|落ち込|つら|辛い|しんど|ミス|失敗|緊張|気まず|悩|不安|寂し|さみし)/.test(text)) return 'troubled';
    if (/(かわい|可愛|声.*好き|天才)/.test(text)) return 'embarrassed';
    if (/(すご|うま|ナイス|最高|おめでと|惜し)/.test(text)) return 'surprised';
    if (/(初見|こんばん|はじめまして|おつかれ|お疲れ|ありがと)/.test(text)) return 'happy';
    if (/[?？]/.test(text)) return 'thinking';
    return 'listen';
}
export function describeReaction(name) {
    const r = REACTIONS[isReaction(name) ? name : 'neutral'];
    return { name: isReaction(name) ? name : 'neutral', label: r.label, camera: r.camera, sfx: r.sfx, lead: r.lead, big: !!r.big };
}

/** Slow persistent mood, owned by the engine; decays toward a calm baseline. */
export class Affect {
    constructor(base = { happy: .55, energy: .5, focus: .5 }) { this.base = { ...base }; this.state = { ...base }; this.at = 0; }
    decay(now = Date.now()) {
        const k = this.at ? Math.exp(-Math.max(0, now - this.at) / 25000) : 1;
        for (const key of Object.keys(this.base)) this.state[key] = this.base[key] + (this.state[key] - this.base[key]) * k;
        this.at = now; return this;
    }
    /** `scale` (0..1.5) follows the delivery intensity; 1 is the legacy nudge. */
    apply(name, now = Date.now(), scale = 1) {
        this.decay(now);
        const g = Number.isFinite(scale) ? Math.max(0, Math.min(1.5, scale)) : 1;
        for (const [k, v] of Object.entries(REACTIONS[name]?.affect || {})) this.state[k] = Math.max(0, Math.min(1, this.state[k] + v * g));
        return this.snapshot(now);
    }
    snapshot(now = Date.now()) { this.decay(now); return Object.fromEntries(Object.entries(this.state).map(([k, v]) => [k, Math.round(v * 100) / 100])); }
}

// Smoothing speeds (1/ms). Eyes and mouth are quick, head and body lag behind.
const SPEED = { ParamMouthOpenY: .03, ParamEyeLOpen: .02, ParamEyeROpen: .02, ParamEyeBallX: .012, ParamEyeBallY: .012, ParamBodyAngleX: .006, ParamBodyAngleY: .008, ParamBodyAngleZ: .006 };

/** Idle life + reaction sequence (listen → reflex → speak → afterglow → idle) + lip sync.
 * Pure: time and randomness are injected, so tests can drive it frame by frame. */
export class AvatarController {
    constructor({ random = Math.random, reducedMotion = false, now = 0 } = {}) {
        this.random = random; this.motionScale = reducedMotion ? .25 : 1;
        this.current = Object.fromEntries(Object.entries(PARAMS).map(([k, r]) => [k, r[2]]));
        this.affect = { happy: .55, energy: .5, focus: .5 };
        this.reaction = null; this.mouthInput = 0; this.speaking = false; this.last = now;
        this.nextBlink = now + 1500 + random() * 2500; this.blinkAt = -1e9; this.doubleBlink = false;
        this.gaze = { x: 0, y: 0 }; this.nextGaze = now + 1200; this.attention = null;
        this.phase = 'idle';
    }
    /** Something to watch when nothing else directs her (e.g. the game board): gaze x/y (-1..1) and a forward lean
     * (0..1). While she speaks it is halved, so she glances back toward the viewer. null = free idle gaze. */
    attend(target = null) {
        this.attention = target && [target.x, target.y].every(Number.isFinite) ? { x: Math.max(-1, Math.min(1, target.x)), y: Math.max(-1, Math.min(1, target.y)), lean: Math.max(0, Math.min(1, Number(target.lean) || 0)) } : null;
    }
    setAffect(a = {}) { for (const k of ['happy', 'energy', 'focus']) if (Number.isFinite(a[k])) this.affect[k] = Math.max(0, Math.min(1, a[k])); }
    /** Start acting a preset now. Returns the voice lead (ms) the caller should wait.
     * `gain` (.5..1.3) scales face, motion and reflex with the delivery intensity. */
    react(name, now, gain = 1) {
        const key = isReaction(name) ? name : 'neutral';
        const g = Number.isFinite(gain) ? Math.max(.5, Math.min(1.3, gain)) : 1;
        this.reaction = { name: key, preset: REACTIONS[key], start: now, endAt: null, gain: g };
        this.phase = REACTIONS[key].reflex ? 'reflex' : key === 'listen' ? 'listen' : 'speak';
        return REACTIONS[key].lead;
    }
    /** Voice finished: hold the face for the afterglow, then blend back to idle. */
    settle(now) { if (this.reaction && this.reaction.endAt === null) this.reaction.endAt = now; this.speaking = false; this.mouthInput = 0; }
    reset() { this.reaction = null; this.speaking = false; this.mouthInput = 0; this.phase = 'idle'; }
    mouth(level) { this.mouthInput = Math.max(0, Math.min(1, Number(level) || 0)); this.speaking = this.mouthInput > .02 || this.speaking; }
    /** 0..1 weight of the current preset's face. */
    weight(now) {
        const r = this.reaction; if (!r) return 0;
        const tIn = ease((now - r.start) / 180);
        if (r.endAt === null) return tIn;
        const after = now - r.endAt - r.preset.afterMs;
        if (after < 0) return tIn;
        const w = tIn * ease(1 - after / 800);
        if (w <= 0) { this.reaction = null; this.phase = 'idle'; }
        return Math.max(0, w);
    }
    target(now) {
        const m = this.motionScale, a = this.affect, t = now / 1000, out = {};
        for (const [k, r] of Object.entries(PARAMS)) out[k] = r[2];
        // Idle: breathing, slow sway scaled by energy, a resting smile scaled by mood.
        const sway = (.6 + a.energy) * m;
        out.ParamBreath = .5 + .5 * Math.sin(t * 2 * Math.PI / 3.6);
        out.ParamAngleX = sway * (3 * Math.sin(t * .31) + 1.5 * Math.sin(t * .83 + 1));
        out.ParamAngleY = sway * (1.5 * Math.sin(t * .47 + 2)) + (out.ParamBreath - .5) * 1.2 * m;
        out.ParamAngleZ = sway * (2 * Math.sin(t * .23 + .5));
        out.ParamBodyAngleX = sway * 1.2 * Math.sin(t * .19 + 1.7);
        out.ParamBodyAngleZ = sway * .8 * Math.sin(t * .27);
        out.ParamMouthForm = (a.happy - .5) * .8;
        out.ParamEyeLSmile = out.ParamEyeRSmile = Math.max(0, a.happy - .7);
        // Eye wander: small saccades; high focus keeps the gaze steadier.
        if (now >= this.nextGaze) {
            const span = 1 - .6 * a.focus;
            this.gaze = { x: (this.random() * 2 - 1) * .45 * span, y: (this.random() * 2 - 1) * .25 * span };
            this.nextGaze = now + 1400 + this.random() * 2800;
        }
        out.ParamEyeBallX = this.gaze.x; out.ParamEyeBallY = this.gaze.y;
        const at = this.attention;
        if (at) {
            const k = this.speaking ? .5 : 1, l = at.lean * k * m;
            out.ParamEyeBallX = at.x * .9 * k + this.gaze.x * (1 - .9 * k); out.ParamEyeBallY = at.y * .9 * k + this.gaze.y * (1 - .9 * k);
            out.ParamAngleX += at.x * 9 * l; out.ParamAngleY += -4 * l; out.ParamBodyAngleX += at.x * 3 * l; out.ParamBodyAngleY += -2 * l;
        }
        // Talking: a slight head bob coupled to the voice envelope.
        if (this.speaking) { out.ParamAngleY += this.mouthInput * 3 * m; out.ParamBodyAngleY += this.mouthInput * 1.2 * m; }
        const r = this.reaction, w = this.weight(now);
        if (r && w > 0) {
            const tr = now - r.start, g = r.gain ?? 1;
            for (const [k, v] of Object.entries(r.preset.face)) {
                // Eye open / brow / form are offsets from the idle value; gaze replaces it.
                if (k === 'ParamEyeBallX' || k === 'ParamEyeBallY') { const wg = w * Math.min(1, g); out[k] = out[k] * (1 - wg) + v * wg; }
                else out[k] += v * w * g;
            }
            for (const [k, v] of Object.entries(r.preset.motion(tr))) out[k] += v * w * m * g;
            const reflex = r.preset.reflex;
            if (reflex && tr < reflex.ms + 200) {
                const k = pulse(tr, 70, reflex.ms - 70, 200);
                for (const [id, v] of Object.entries(reflex.params)) out[id] += v * k * g;
                if (tr >= reflex.ms && this.phase === 'reflex') this.phase = 'speak';
            }
            if (r.endAt !== null && this.phase !== 'idle') this.phase = 'after';
        }
        return out;
    }
    /** Advance to `now` and return clamped Cubism parameter values for this frame. */
    update(now) {
        const dt = Math.max(0, Math.min(100, now - this.last)); this.last = now;
        const target = this.target(now);
        target.ParamMouthOpenY += this.mouthInput * (this.reaction?.name === 'laugh' ? 1.15 : 1);
        for (const k of Object.keys(PARAMS)) {
            const s = 1 - Math.exp(-(SPEED[k] || .01) * dt);
            this.current[k] += (target[k] - this.current[k]) * s;
        }
        // Blink is applied after smoothing so it stays crisp. Wide-eyed presets blink less.
        if (now >= this.nextBlink) {
            this.blinkAt = now; this.doubleBlink = this.random() < .18;
            const surprisedEyes = this.reaction && (this.reaction.preset.face.ParamEyeLOpen || 0) > .1;
            this.nextBlink = now + (surprisedEyes ? 3500 : 2200) + this.random() * 3800;
        }
        const tb = now - this.blinkAt, closed = b => b >= 0 && b < 150 ? Math.sin(Math.PI * b / 150) : 0;
        const blink = Math.max(closed(tb), this.doubleBlink ? closed(tb - 220) : 0);
        const out = {};
        for (const k of Object.keys(PARAMS)) {
            let v = this.current[k];
            if (k === 'ParamEyeLOpen' || k === 'ParamEyeROpen') v *= 1 - blink;
            out[k] = clampParam(k, v);
        }
        return out;
    }
}

/** VTube Studio: tracking inputs the default model setup already maps, plus custom
 * parameters (created on connect) the operator maps once in VTS to the model's
 * ParamCheek / ParamEyeLSmile / ParamBodyAngle*. Values are converted to VTS ranges. */
export const VTS_CUSTOM = [
    { parameterName: 'JevCheek', explanation: 'Jev blush 0..1 (map to ParamCheek)', min: 0, max: 1, defaultValue: 0 },
    { parameterName: 'JevEyeSmile', explanation: 'Jev eye smile 0..1 (map to ParamEyeLSmile/RSmile)', min: 0, max: 1, defaultValue: 0 },
    { parameterName: 'JevBodyAngleX', explanation: 'Jev body turn -10..10 (map to ParamBodyAngleX)', min: -10, max: 10, defaultValue: 0 },
    { parameterName: 'JevBodyAngleY', explanation: 'Jev body bob -10..10 (map to ParamBodyAngleY)', min: -10, max: 10, defaultValue: 0 },
    { parameterName: 'JevBodyAngleZ', explanation: 'Jev body lean -10..10 (map to ParamBodyAngleZ)', min: -10, max: 10, defaultValue: 0 },
    { parameterName: 'JevBrowAngle', explanation: 'Jev troubled brows -1..1 (map to ParamBrowLAngle/RAngle)', min: -1, max: 1, defaultValue: 0 },
];
export function toVTS(p) {
    const n = (id) => clampParam(id, p[id]), unit = v => Math.max(0, Math.min(1, v)), half = v => unit((v + 1) / 2);
    return [
        { id: 'FaceAngleX', value: n('ParamAngleX') }, { id: 'FaceAngleY', value: n('ParamAngleY') }, { id: 'FaceAngleZ', value: n('ParamAngleZ') },
        { id: 'EyeOpenLeft', value: unit(n('ParamEyeLOpen')) }, { id: 'EyeOpenRight', value: unit(n('ParamEyeROpen')) },
        { id: 'EyeLeftX', value: n('ParamEyeBallX') }, { id: 'EyeRightX', value: n('ParamEyeBallX') },
        { id: 'EyeLeftY', value: n('ParamEyeBallY') }, { id: 'EyeRightY', value: n('ParamEyeBallY') },
        { id: 'BrowLeftY', value: half(n('ParamBrowLY')) }, { id: 'BrowRightY', value: half(n('ParamBrowRY')) }, { id: 'Brows', value: half((n('ParamBrowLY') + n('ParamBrowRY')) / 2) },
        { id: 'MouthOpen', value: n('ParamMouthOpenY') }, { id: 'MouthSmile', value: half(n('ParamMouthForm')) },
        { id: 'JevCheek', value: n('ParamCheek') }, { id: 'JevEyeSmile', value: (n('ParamEyeLSmile') + n('ParamEyeRSmile')) / 2 },
        { id: 'JevBodyAngleX', value: n('ParamBodyAngleX') }, { id: 'JevBodyAngleY', value: n('ParamBodyAngleY') }, { id: 'JevBodyAngleZ', value: n('ParamBodyAngleZ') },
        { id: 'JevBrowAngle', value: (n('ParamBrowLAngle') + n('ParamBrowRAngle')) / 2 },
    ].map(x => ({ id: x.id, value: Math.round(x.value * 1000) / 1000 }));
}
