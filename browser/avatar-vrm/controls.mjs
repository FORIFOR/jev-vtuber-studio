import { clampParam } from '../../public/avatar-rig.mjs';
import { INTENSITY_GAIN } from '../../public/voice-acting.mjs';

export const EXPRESSIONS = ['neutral', 'happy', 'Surprised', 'worried', 'blush', 'laugh'];
export const VOWEL_NAMES = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' };
export const REACTION_MAP = {
    neutral: { gesture: 'explain', expression: 'neutral' },
    nod: { gesture: 'nod', expression: 'neutral' },
    happy: { gesture: 'nod', expression: 'happy' },
    laugh: { gesture: 'explain', expression: 'laugh' },
    surprised: { gesture: 'surprise', expression: 'Surprised' },
    shock: { gesture: 'surprise', expression: 'Surprised' },
    embarrassed: { gesture: 'idle', expression: 'blush' },
    thinking: { gesture: 'think', expression: 'worried' },
    troubled: { gesture: 'think', expression: 'worried' },
    excited: { gesture: 'beckon', expression: 'happy' },   // the adopted illustration's pose
    listen: { gesture: 'think', expression: 'neutral' },
};

// Pin the locally reviewed assets, not a remotely supplied animation URL.
export const APPROVED_MOTIONS = {
    idle: ['rb-idle.vrma', 'f698f6ea045533ab7475f7d512ea76c904f4a88b6e3645256f70ae532dd79b40'],
    nod: ['rb-nod.vrma', '1c73e142305ae33e356a185145c3bf482d8fcda5057f632e60dd5ecda3b8c726'],
    wave: ['rb-wave.vrma', '8bd33d84e90c0243987924c2f27d826f0b3343cfa8d1607a4e2f0bb9ce8af643'],
    think: ['rb-listen-2.vrma', '3a7c6bc77fe9531ae960b9446b60ace26e5b1036768c1c93f040a90b22329eb7'],
    surprise: ['rb-shrug.vrma', '40db0f7c6d61200136c3a48f77d8cede1557cc62e468f5aca46cbd80e1da5f47'],
    explain: ['rb-idle-talking.vrma', '3b1c1155dfac93d4d4d3a44deecc17420cd191cbec9b68e795f19bc6d05e0e6e'],
    // Authored in this repository (scripts/build-noa-beckon-motion.mjs), not an upstream Rocketbox clip.
    beckon: ['noa-beckon.vrma', '08e4f88e7bffc7255006efb70fa7f862540e0cc08f560cac0fbf25a01d171469'],
};

export const clamp = (v, lo = 0, hi = 1, fallback = lo) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const radians = Math.PI / 180, REST_TILT_SIGN = 1;
// Noa's resting look, from the design sheet (docs/REVIEW_v490.md, addendum 2 A/E): a soft smile (happy 15%, mouth
// corners 40%), a light blush (20%) and the head tilted 8 degrees. Expression values apply only while the stage rig is
// driving her as the host: no rig parameters (load, stop) and the comment narrator's turn stay as before, and a
// downturned mouth removes the smile and blush.
export const REST = Object.freeze({ happy: .15, blush: .20, mouth: .40, eyes: 0, tiltDegrees: 8, shoulderDegrees: 3 });   // shoulders: a slight counter-tilt to the head, the weight-on-one-leg look   // eyes: extra laugh-eye weight at rest. 0 from 4.92: on the larger eyes the laugh eye
// lowers the upper lid (sleepy at .12, closed at .30) instead of the illustration's arched smile; happy .15 carries the eyes.
/** Seconds of uninterrupted idle before the n-th idle beckon: 40..60, a fixed sequence (no randomness). */
export const idleBeckonDelay = count => 40 + (Math.max(0, Math.floor(count)) * 13) % 21;
const BROW_REACTIONS = {
    happy: { warm: .18, raised: .08 }, laugh: { warm: .24, raised: .10 },
    surprised: { raised: .45 }, shock: { raised: .45 },
    embarrassed: { worried: .12, warm: .12 }, thinking: { focused: .12, raised: .08 },
    troubled: { worried: .40 }, excited: { raised: .26, warm: .18 }, listen: { raised: .08 },
};

export function reactionPlan(name, intensity = 1, { reducedMotion = false } = {}) {
    const selected = Object.hasOwn(REACTION_MAP, name) ? name : 'neutral';
    const gain = clamp(typeof intensity === 'string' ? (Object.hasOwn(INTENSITY_GAIN, intensity) ? INTENSITY_GAIN[intensity] : 1) : intensity, .5, 1.3, 1);
    const plan = { ...REACTION_MAP[selected], intensity: clamp(.2 + (gain - .5), .2, 1), gain, name: selected };
    if (reducedMotion) plan.gesture = 'idle';
    return plan;
}

export function deriveControls(params = {}, extras = {}, { reducedMotion = false } = {}) {
    const p = id => clampParam(id, params[id]);
    const motion = clamp(extras.motion, 0, 1, 1) * (reducedMotion ? .25 : 1);
    const reaction = extras.reaction && typeof extras.reaction === 'object' ? extras.reaction : null;
    const plan = reactionPlan(reaction?.name, reaction?.gain, { reducedMotion });
    const expressionWeight = reaction ? clamp(reaction.weight, 0, 1, 1) * clamp(reaction.gain, 0, 1, 1) : 0;
    const browHeight = (p('ParamBrowLY') + p('ParamBrowRY')) / 2;
    const browAngle = (p('ParamBrowLAngle') + p('ParamBrowRAngle')) / 2;
    const eyeSmile = (p('ParamEyeLSmile') + p('ParamEyeRSmile')) / 2;
    const mouthForm = p('ParamMouthForm'), gazeY = p('ParamEyeBallY');
    // This VRM has bilateral brow morphs. Average the two authored parameters,
    // and take the stronger signal rather than adding the preset twice.
    const brows = {
        raised: clamp(browHeight * .42 + Math.max(0, gazeY) * .04, 0, .5),
        worried: clamp(browAngle * .45, 0, .5),
        focused: clamp(Math.max(0, -browAngle) * .4 + Math.max(0, -browHeight) * .25, 0, .45),
        warm: clamp(Math.max(0, mouthForm) * .14 + eyeSmile * .08, 0, .22),
    };
    const browReaction = Object.hasOwn(BROW_REACTIONS, plan.name) ? BROW_REACTIONS[plan.name] : {};
    for (const name of Object.keys(brows)) brows[name] = Math.max(brows[name], (browReaction[name] || 0) * expressionWeight);
    const browTotal = Object.values(brows).reduce((sum, value) => sum + value, 0);
    if (browTotal > .6) for (const name of Object.keys(brows)) brows[name] *= .6 / browTotal;
    const mouthLocked = extras.role === 'comment';
    const rigActive = Number.isFinite(params.ParamMouthForm), resting = rigActive && mouthForm >= 0 && !mouthLocked;
    const tilt = rigActive ? REST.tiltDegrees : 0;
    const open = mouthLocked ? 0 : p('ParamMouthOpenY');
    const vowels = Object.fromEntries(Object.values(VOWEL_NAMES).map(name => [name, 0]));
    let total = 0;
    for (const [key, name] of Object.entries(VOWEL_NAMES)) {
        const value = clamp(extras.vis?.[key]);
        vowels[name] = value;
        total += value;
    }
    const closed = clamp(extras.vis?.n);
    if (total + closed > 0) {
        // Include the closed nasal in normalization so ん closes the mouth.
        const scale = open / Math.max(1, total + closed);
        for (const name of Object.keys(vowels)) vowels[name] *= scale;
    } else {
        vowels.aa = open;
    }
    return {
        head: [-p('ParamAngleY') * .65 * radians * motion, p('ParamAngleX') * .65 * radians * motion, clamp((-p('ParamAngleZ') * .65 + REST_TILT_SIGN * tilt) * radians * motion, -.35, .35, 0)],   // the tilt never widens the reviewed head range
        body: [-p('ParamBodyAngleY') * .6 * radians * motion + (p('ParamBreath') - .5) * .008 * motion, p('ParamBodyAngleX') * .6 * radians * motion,
            clamp((-p('ParamBodyAngleZ') * .6 - REST_TILT_SIGN * (rigActive ? REST.shoulderDegrees : 0)) * radians * motion, -.35, .35, 0)],
        gaze: { yaw: p('ParamEyeBallX') * 22 * (reducedMotion ? .55 : 1), pitch: -gazeY * 14 * (reducedMotion ? .55 : 1) },
        blink: { left: clamp(1 - p('ParamEyeLOpen')), right: clamp(1 - p('ParamEyeROpen')) },
        brows,
        // Carry the existing rig's persistent mood through quieter intervals.
        // These small weights fill only the space left by an active reaction.
        rest: { happy: clamp(Math.max(resting ? REST.happy : 0, mouthForm * .18, eyeSmile * .22), 0, .18), worried: clamp(-mouthForm * .16, 0, .16),
            blush: resting ? REST.blush : 0, mouth: resting ? REST.mouth : 0, eyes: resting ? REST.eyes : 0 },
        vowels,
        expression: plan.expression,
        expressionWeight,
        mouthLocked,
        mouthOpen: open,
        motion,
    };
}
