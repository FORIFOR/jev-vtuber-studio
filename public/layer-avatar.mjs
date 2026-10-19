// Layered PNG avatar: draws Noa's part layers (public/models/noa, see model.json) on a canvas from the same
// Cubism parameters that drive the SVG avatar and VTube Studio. Our own 2D mapping: no Live2D runtime, no mesh
// deformation — parts move, fade and scale as whole images, so angles stay small to keep part seams hidden.

const clamp01 = v => v <= 0 ? 0 : v >= 1 ? 1 : v;
export const NECK = [700, 800], BODY_BASE = [620, 1480];
const HAIR_PIVOT = { L: [500, 405], R: [905, 395] };

/** How open an eye reads: the lid follows ParamEye?Open, and a smile narrows it toward the closed arc. */
export const eyeOpenness = (open, smile) => Math.max(0, open * (1 - .9 * smile * smile));
// Open and closed eyes swap within a narrow band instead of cross-fading (operator 2026-10-10: through the closed lid
// the open eye showed — a smile holding openness near .45 kept both half-visible for whole lines).
const EYE_SWAP = .42, EYE_BAND = .03;
const eyeShown = o => clamp01((o - (EYE_SWAP - EYE_BAND / 2)) / EYE_BAND);

/** Pure: how much the face reads as surprise / trouble, from parameters alone (same for every renderer).
 * Surprise = eyes wider than open and no smile (excited widens the eyes but smiles). Trouble = lowered mouth
 * corners together with slanted brows (thinking and shock lower the corners without the brow slant). Brows are
 * mostly hidden under Noa's bangs, so these pick the mouth shape that carries the expression. */
export function expressionWeights(p) {
    const wide = clamp01((Math.max(p.ParamEyeLOpen, p.ParamEyeROpen) - 1) / .12);
    const surprise = wide * clamp01((.2 - p.ParamMouthForm) / .3);
    const trouble = clamp01((-p.ParamMouthForm - .25) / .15) * clamp01((p.ParamBrowLAngle + p.ParamBrowRAngle) / 2 / .5);
    return { surprise, trouble };
}
const openAlpha = p => clamp01((clamp01(p.ParamMouthOpenY) - .08) / .22);
/** A broad smile (happy / laugh / excited) opens the mouth a little even without speech: the open-smile art, small. */
export const smileOpen = p => clamp01((p.ParamMouthForm - .55) / .3);
const mouthShown = p => Math.max(openAlpha(p), smileOpen(p));
// Features slide a little further than the head when it turns, so a turn reads as a turn, not a tilted picture.
let BLUSH_FLOOR = .45;
/** NOA BEER (operator 2026-10-10): flushed cheeks while the can is on the desk; back to the usual floor otherwise. */
export const setBlushFloor = v => { BLUSH_FLOOR = clamp01(v); };
const PARALLAX = { eyeWhite: .55, iris: .55, lash: .55, closedEye: .55, brow: .5, blush: .35, mouthOpen: .45, mouthClosed: .45, mouthO: .45, mouthWave: .45, face: .2 };

/** Pure: pose of one layer for this frame, in model pixels. `lag` = hair spring lag {x, z} (head minus hair). */
export function layerPose(p, layer, lag = { x: 0, z: 0 }) {
    const pose = { alpha: layer.opacity ?? 1, dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, pivot: layer.pivot || [layer.x + layer.w / 2, layer.y + layer.h / 2] };
    const side = layer.side === 'R' ? 'R' : 'L';
    if (PARALLAX[layer.kind]) { pose.dx += p.ParamAngleX * PARALLAX[layer.kind]; pose.dy -= p.ParamAngleY * PARALLAX[layer.kind] * .6; }
    switch (layer.kind) {
        case 'eyeWhite': case 'iris': case 'lash': {
            const o = eyeOpenness(p[`ParamEye${side}Open`], p[`ParamEye${side}Smile`]);
            pose.alpha = eyeShown(o);
            pose.sy = o >= 1 ? 1 + Math.min(.2, o - 1) * .8 : .45 + .55 * clamp01(o);
            if (layer.kind === 'iris') { pose.dx += p.ParamEyeBallX * 10; pose.dy += -p.ParamEyeBallY * 6; } // clipped to the eye white
            break;
        }
        case 'closedEye': pose.alpha = 1 - eyeShown(eyeOpenness(p[`ParamEye${side}Open`], p[`ParamEye${side}Smile`])); break;
        case 'brow':
            pose.dy = -p[`ParamBrow${side}Y`] * 16;
            pose.rot = p[`ParamBrow${side}Angle`] * 14 * (side === 'L' ? -1 : 1);
            break;
        // Operator 2026-10-09: high-tension show, cheeks always a little flushed; reactions still deepen it.
        case 'blush': pose.alpha = clamp01(Math.max(p.ParamCheek * 1.6, BLUSH_FLOOR)); break;
        case 'mouthOpen': {
            const open = clamp01(p.ParamMouthOpenY);
            pose.alpha = mouthShown(p); pose.sy = .5 + .5 * open;
            pose.sx = 1 - .3 * expressionWeights(p).surprise; // a surprised voice talks through a rounder mouth
            pose.pivot = [layer.x + layer.w / 2, layer.y];
            break;
        }
        case 'mouthClosed': {
            const { surprise, trouble } = expressionWeights(p);
            pose.alpha = (1 - mouthShown(p)) * (1 - Math.max(surprise, trouble));
            pose.sx = 1 + p.ParamMouthForm * .1;
            break;
        }
        case 'mouthO': pose.alpha = (1 - mouthShown(p)) * expressionWeights(p).surprise; break;
        case 'mouthWave': pose.alpha = (1 - mouthShown(p)) * expressionWeights(p).trouble; break;
        case 'hair':
            pose.rot = -lag.z * 1.8 - lag.x * .35;
            pose.pivot = HAIR_PIVOT[side];
            break;
    }
    return pose;
}

/** Pure: the whole-head and whole-body motion (applied before a layer's own pose). */
export function rigPose(p) {
    return {
        body: { dx: p.ParamBodyAngleX * 5, dy: -p.ParamBodyAngleY * 5, rot: p.ParamBodyAngleZ * .9, breath: 1 + p.ParamBreath * .008 },
        head: { dx: p.ParamAngleX * 1.4, dy: -p.ParamAngleY * 1.1 - p.ParamBreath * 2, rot: p.ParamAngleZ * .35 },
    };
}

const rad = d => d * Math.PI / 180;
export class LayerAvatar {
    constructor(canvas, { base = '/models/noa/', fetchFn = (...a) => fetch(...a), grade = false } = {}) {
        Object.assign(this, { canvas, base, fetchFn, grade });
        this.ctx = canvas.getContext('2d'); this.ready = false; this.hair = { x: 0, vx: 0, z: 0, vz: 0 };
    }
    async load() {
        const r = await this.fetchFn(this.base + 'model.json');
        if (!r.ok) throw new Error('model not found');
        this.model = await r.json();
        await Promise.all(this.model.layers.map(l => new Promise((ok, fail) => {
            l.img = new Image(); l.img.onload = ok; l.img.onerror = () => fail(new Error(`layer ${l.name}`)); l.img.src = this.base + l.file;
        })));
        // Irises are clipped to their eye whites through a small per-eye scratch canvas.
        this.eyes = {};
        for (const white of this.model.layers.filter(l => l.kind === 'eyeWhite')) {
            const iris = this.model.layers.find(l => l.kind === 'iris' && l.side === white.side), c = document.createElement('canvas');
            c.width = white.w; c.height = white.h; this.eyes[white.side] = { white, iris, c, g: c.getContext('2d') };
        }
        this.ready = true;
    }
    draw(p) {
        if (!this.ready) return;
        const { ctx, canvas, model } = this, k = canvas.width / model.canvas[0];
        const rig = rigPose(p), h = this.hair;
        // Hair physics stand-in: side locks trail the head on a damped spring.
        h.vx = (h.vx + (rig.head.dx - h.x) * .09) * .82; h.x += h.vx;
        h.vz = (h.vz + (rig.head.rot * 2.5 - h.z) * .07) * .84; h.z += h.vz;
        const lag = { x: rig.head.dx - h.x, z: rig.head.rot * 2.5 - h.z };
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const l of model.layers) {
            if (l.kind === 'iris') continue; // drawn inside its eye white
            const pose = layerPose(p, l, lag);
            if (pose.alpha <= .01) continue;
            ctx.setTransform(k, 0, 0, k, 0, 0);
            // Body transform (everything), then head transform (all but the body).
            ctx.translate(rig.body.dx, rig.body.dy);
            ctx.translate(...BODY_BASE); ctx.rotate(rad(rig.body.rot)); ctx.scale(1, rig.body.breath); ctx.translate(-BODY_BASE[0], -BODY_BASE[1]);
            if (l.kind !== 'body') { ctx.translate(rig.head.dx, rig.head.dy); ctx.translate(...NECK); ctx.rotate(rad(rig.head.rot)); ctx.translate(-NECK[0], -NECK[1]); }
            ctx.translate(pose.dx, pose.dy);
            ctx.translate(...pose.pivot); ctx.rotate(rad(pose.rot)); ctx.scale(pose.sx, pose.sy); ctx.translate(-pose.pivot[0], -pose.pivot[1]);
            ctx.globalAlpha = pose.alpha;
            const eye = l.kind === 'eyeWhite' && this.eyes[l.side];
            if (eye) {
                const { g, iris } = eye, ip = layerPose(p, iris, lag); ip.dx -= pose.dx; ip.dy -= pose.dy; // relative to its (already moved) eye white
                g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, l.w, l.h); g.drawImage(l.img, 0, 0);
                g.globalCompositeOperation = 'source-atop'; g.drawImage(iris.img, iris.x - l.x + ip.dx, iris.y - l.y + ip.dy);
                ctx.drawImage(eye.c, l.x, l.y);
            } else ctx.drawImage(l.img, l.x, l.y);
        }
        ctx.globalAlpha = 1;
        if (this.grade) this.light();
    }
    /** Room light on Noa's pixels only (source-atop): cool moonlight from the window side, warm lamp from the other,
     * and the desk's shade low down, so the illustration sits in the same night room as the backdrop. */
    light() {
        const { ctx, canvas: { width: w, height: h } } = this;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-atop';
        const side = ctx.createLinearGradient(0, 0, w, 0);
        side.addColorStop(0, 'rgba(70,100,190,.16)'); side.addColorStop(.5, 'rgba(0,0,0,0)'); side.addColorStop(1, 'rgba(255,176,104,.14)');
        ctx.fillStyle = side; ctx.fillRect(0, 0, w, h);
        const low = ctx.createLinearGradient(0, h * .62, 0, h);
        low.addColorStop(0, 'rgba(8,10,24,0)'); low.addColorStop(1, 'rgba(8,10,24,.32)');
        ctx.fillStyle = low; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
    }
}
