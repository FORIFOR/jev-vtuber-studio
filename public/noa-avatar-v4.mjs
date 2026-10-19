// v4 renderer for Noa's layers (public/models/noa; design handoff "Noa avatar v4", adapted to this stage's room). Same Cubism params and model.json as the repo's LayerAvatar.
// Adds on top of v3: pseudo-3D head turn (cylindrical mesh warp), real eyelid blink (lid sweeps down, lash follows),
// five visemes (a/i/u/e/o) built from the existing mouth parts, load-time hair defringe, night colour grade + rim light.
import { LayerAvatar, layerPose, rigPose, NECK, BODY_BASE, eyeOpenness, expressionWeights } from './layer-avatar.mjs';

const rad = d => d * Math.PI / 180, clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const HAIR_PIVOT = { L: [500, 405], R: [905, 395] };
const CLIP_AT = [884, 346], LED_AT = [1003, 568];
const WARP = { cx: 715, cy: 500, rx: 430, ry: 470, x0: 230, x1: 1090, y0: 60, y1: 890, cols: 9, rows: 9 };

/** Kana → vowel for lip shapes. 'n' = ん (nearly closed), null = keep previous (ー, kanji handled by caller). */
const VOWELS = {
    a: 'あかさたなはまやらわがざだばぱぁゃアカサタナハマヤラワガザダバパァャ',
    i: 'いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ',
    u: 'うくすつぬふむゆるぐずづぶぷぅゅっウクスツヌフムユルグズヅブプゥュッ',
    e: 'えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ',
    o: 'おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ',
};
export function kanaVowel(ch) {
    if (ch === 'ん' || ch === 'ン') return 'n';
    if (ch === 'ー' || ch === '〜') return null;
    for (const [v, s] of Object.entries(VOWELS)) if (s.includes(ch)) return v;
    // Kanji and other characters: a stable pseudo-vowel (same character, same shape), never a per-frame random pick.
    return 'aiueo'[(String(ch).codePointAt(0) ?? 0) % 5];
}
// Viseme shapes on the existing art: which mouth part, and its width/height response to openness.
const VIS = {
    a: { part: 'open', sx: 1, sy: [.5, .5] }, i: { part: 'open', sx: 1.2, sy: [.42, .2] }, e: { part: 'open', sx: 1.08, sy: [.48, .34] },
    o: { part: 'o', sx: .95, sy: [.8, .5] }, u: { part: 'o', sx: .78, sy: [.62, .28] }, n: { part: 'o', sx: .7, sy: [.45, .1] },
};

export class NoaAvatarV4 extends LayerAvatar {
    constructor(canvas, opts = {}) {
        super(canvas, opts);
        this.r = { t: 0, last: 0, prev: null, hair: { L: { a: 0, v: 0 }, R: { a: 0, v: 0 } }, pop: { s: 0, v: 0 } };
        this.flash = { warm: 0, cool: 0 };
        const mk = () => { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; return c; };
        this.head = mk(); this.hg = this.head.getContext('2d');
        this.tmp = mk(); this.tg = this.tmp.getContext('2d');
    }
    async load() { await super.load(); this.defringe(); this.sampleSkin(); }
    resume() {
        this.r.last = 0;
        this.r.prev = null;
        this.r.pop.s = this.r.pop.v = 0;
        for (const hair of Object.values(this.r.hair)) hair.v = 0;
        this.flash.warm = this.flash.cool = 0;
    }
    sampleSkin() {
        const face = this.model.layers.find(l => l.kind === 'face'); if (!face) return;
        const c = document.createElement('canvas'); c.width = face.w; c.height = face.h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(face.img, 0, 0);
        const at = (mx, my) => { const d = g.getImageData(mx - face.x - 3, my - face.y - 3, 7, 7).data; let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } return n ? `rgb(${r / n | 0},${gg / n | 0},${b / n | 0})` : null; };
        this.skin = { L: at(600, 580), R: at(818, 592) };
        const dark = s => s && s.replace(/rgb\((\d+),(\d+),(\d+)\)/, (_, r, g2, b) => `rgb(${r * .9 | 0},${g2 * .82 | 0},${b * .84 | 0})`);
        this.lidSkin = { L: dark(this.skin.L), R: dark(this.skin.R) };
    }
    /** The painted layers were cut from a light background; knock back light, semi-transparent edge pixels on hair. */
    defringe() {
        for (const l of this.model.layers) {
            const rows = ({ HeadBase: l.h, HairSideL: l.h, HairSideR: l.h, Body: 190 })[l.name];
            if (!rows) continue;
            const c = document.createElement('canvas'); c.width = l.w; c.height = l.h;
            const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(l.img, 0, 0);
            const d = g.getImageData(0, 0, l.w, Math.min(rows, l.h)), px = d.data;
            for (let i = 0; i < px.length; i += 4) {
                const a = px[i + 3]; if (a === 0 || a > 244) continue;
                const lum = .3 * px[i] + .59 * px[i + 1] + .11 * px[i + 2]; if (lum < 140) continue;
                const f = Math.min(1, (lum - 140) / 110);
                px[i] *= 1 - .62 * f; px[i + 1] *= 1 - .6 * f; px[i + 2] *= 1 - .5 * f; px[i + 3] = a * (1 - .55 * f);
            }
            g.putImageData(d, 0, 0); l.img = c;
        }
    }
    kick(v) { this.r.pop.v += v; }
    pulseLight(kind, v = 1) { this.flash[kind] = Math.max(this.flash[kind] || 0, v); }

    /** Pose with v4 eye + mouth logic (everything else from the repo's layerPose). */
    pose(p, l, x) {
        const pose = layerPose(p, l), side = l.side === 'R' ? 'R' : 'L';
        // Blink closes from the top; a smile pushes the lower lid up into a crescent (never a sleepy half-lid).
        const o = p[`ParamEye${side}Open`], sm = clamp01(p[`ParamEye${side}Smile`]), lid = clamp01(1 - o);
        // Operator 2026-10-10: the open eye showed through a half-faded lid. The swap is now near-instant (narrow band).
        const closed = Math.max(clamp01((lid - .8) / .04), clamp01((sm - .8) / .04));
        if (l.kind === 'eyeWhite' || l.kind === 'iris') { pose.alpha = 1; pose.sy = o >= 1 ? 1 + Math.min(.2, o - 1) * .8 : 1; pose.lid = lid; pose.smile = sm; pose.closed = closed; }
        if (l.kind === 'lash') { pose.alpha = 1 - closed; pose.sy = (o >= 1 ? 1 + Math.min(.2, o - 1) * .6 : 1 - lid * .3) * (1 - sm * .12); pose.dy += lid * 44 + sm * 5; }
        if (l.kind === 'closedEye') pose.alpha = closed;
        const vis = x.vis;
        if (vis && (l.kind === 'mouthOpen' || l.kind === 'mouthO')) {
            const open = clamp01(p.ParamMouthOpenY), talk = clamp01((open - .06) / .2);
            let wOpen = 0, wO = 0, sx = 0, sy = 0, sxo = 0, syo = 0;
            for (const [k, w] of Object.entries(vis)) {
                const s = VIS[k]; if (!s || w <= 0) continue;
                if (s.part === 'open') { wOpen += w; sx += s.sx * w; sy += (s.sy[0] + s.sy[1] * open) * w; }
                else { wO += w; sxo += s.sx * w; syo += (s.sy[0] + s.sy[1] * open) * w; }
            }
            // The open mouth fades by its own weight even when it is 0 (an お/う/ん shows only the o mouth).
            if (l.kind === 'mouthOpen') { pose.alpha = Math.max(pose.alpha * (1 - talk), talk * wOpen); if (wOpen > 0) { pose.sx = sx / wOpen; pose.sy = sy / wOpen; } }
            if (l.kind === 'mouthO') { pose.alpha = Math.max(pose.alpha * (1 - talk), talk * wO); if (wO > 0) { pose.sx = sxo / wO; pose.sy = syo / wO; pose.pivot = [l.x + l.w / 2, l.y]; } }
        }
        if (l.kind === 'mouthClosed' && x.vis) pose.alpha *= 1 - clamp01((clamp01(p.ParamMouthOpenY) - .06) / .2);
        return pose;
    }

    draw(p, x = {}) {
        if (!this.ready) return;
        const R = this.r, now = performance.now(), dt = R.last ? Math.min(.05, Math.max(.001, (now - R.last) / 1000)) : 1 / 60;
        R.last = now; R.t += dt;
        const { ctx, canvas, model, hg, head } = this, k = canvas.width / model.canvas[0], m = x.motion ?? 1;
        const rig = rigPose(p), hd = { x: rig.head.dx, y: rig.head.dy, r: rig.head.rot };
        const pv = R.prev || hd, vel = { x: (hd.x - pv.x) / dt, y: (hd.y - pv.y) / dt, r: (hd.r - pv.r) / dt }; R.prev = hd;
        for (const s of ['L', 'R']) {
            const h = R.hair[s], L = s === 'L';
            const breeze = (Math.sin(R.t * 1.1 + (L ? 0 : 1.7)) * .9 + Math.sin(R.t * 2.6 + (L ? 2 : 0)) * .35) * m;
            const drive = -vel.x * .09 - vel.r * .6 + vel.y * .05 * (L ? 1 : -1) - p.ParamAngleX * .08;
            h.v += ((drive + breeze - h.a) * (L ? 70 : 88) - h.v * (L ? 6 : 7.5)) * dt; h.a += h.v * dt;
            h.a = Math.max(-10, Math.min(10, h.a));
        }
        const P = R.pop; P.v += (-P.s * 260 - P.v * 13) * dt; P.s += P.v * dt; const sq = P.s * .1;
        const glint = .55 + .25 * Math.sin(R.t * 2.3) + .15 * Math.sin(R.t * 5.1);
        // Features: half the repo's parallax — the mesh warp now carries the rest of the turn.
        const pf = { ...p, ParamAngleX: p.ParamAngleX * .5, ParamAngleY: p.ParamAngleY * .5 };

        // 1) Head layers → head canvas, in model space (no head rig yet).
        hg.setTransform(1, 0, 0, 1, 0, 0); hg.clearRect(0, 0, head.width, head.height);
        let body = null;
        for (const l of model.layers) {
            if (l.kind === 'iris') continue;
            if (l.kind === 'body') { body = l; continue; }
            const pose = this.pose(pf, l, x), side = l.side === 'R' ? 'R' : 'L';
            if (l.kind === 'hair') { pose.rot = R.hair[side].a; pose.pivot = HAIR_PIVOT[side]; }
            if (pose.alpha <= .01) continue;
            hg.setTransform(k, 0, 0, k, 0, 0);
            hg.translate(pose.dx, pose.dy);
            hg.translate(...pose.pivot); hg.rotate(rad(pose.rot)); hg.scale(pose.sx, pose.sy); hg.translate(-pose.pivot[0], -pose.pivot[1]);
            hg.globalAlpha = pose.alpha;
            const eye = l.kind === 'eyeWhite' && this.eyes[l.side];
            if (eye) { this.drawEye(eye, pf, pose, glint); hg.drawImage(eye.c, l.x, l.y); }
            else {
                if (l.kind === 'closedEye') this.skinPatch(l, pose.alpha);
                hg.drawImage(l.img, l.x, l.y);
            }
        }
        hg.globalAlpha = 1;
        // Accents in head space.
        hg.setTransform(k, 0, 0, k, 0, 0); hg.globalCompositeOperation = 'lighter';
        const tw = .5 + .5 * Math.sin(R.t * 1.8), [sx0, sy0] = CLIP_AT, s = 10 + 8 * tw;
        hg.globalAlpha = .35 + .65 * tw * (x.sparkle ?? 1);
        hg.translate(sx0, sy0); hg.rotate(R.t * .6); hg.fillStyle = '#fff6d8'; hg.beginPath();
        hg.moveTo(0, -s); hg.quadraticCurveTo(0, 0, s, 0); hg.quadraticCurveTo(0, 0, 0, s); hg.quadraticCurveTo(0, 0, -s, 0); hg.quadraticCurveTo(0, 0, 0, -s); hg.fill();
        hg.setTransform(k, 0, 0, k, 0, 0);
        const led = x.led ?? .4, [lx, ly] = LED_AT, lg = hg.createRadialGradient(lx, ly, 0, lx, ly, 26);
        lg.addColorStop(0, `rgba(150,230,255,${.9 * led})`); lg.addColorStop(.35, `rgba(120,200,255,${.35 * led})`); lg.addColorStop(1, 'rgba(120,200,255,0)');
        hg.globalAlpha = 1; hg.fillStyle = lg; hg.fillRect(lx - 28, ly - 28, 56, 56);
        hg.globalCompositeOperation = 'source-over';

        // 2) Composite: body, then warped head.
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        const bodySpace = () => {
            ctx.setTransform(k, 0, 0, k, 0, 0); ctx.translate(rig.body.dx, rig.body.dy);
            ctx.translate(...BODY_BASE); ctx.rotate(rad(rig.body.rot)); ctx.scale(1, rig.body.breath); ctx.translate(-BODY_BASE[0], -BODY_BASE[1]);
        };
        if (body) {
            bodySpace(); ctx.translate(...BODY_BASE); ctx.scale(1 + sq * .15, 1 - sq * .12); ctx.translate(-BODY_BASE[0], -BODY_BASE[1]);
            ctx.drawImage(body.img, body.x, body.y);
        }
        bodySpace();
        ctx.translate(rig.head.dx, rig.head.dy); ctx.translate(...NECK); ctx.rotate(rad(rig.head.rot)); ctx.scale(1 - sq * .5, 1 + sq); ctx.translate(-NECK[0], -NECK[1]);
        this.drawWarped(p, k, x.warp ?? 1);
        this.lightPass(x, dt);
    }

    drawEye(eye, p, pose, glint) {
        const { g, iris, white: l } = eye, ip = layerPose(p, iris); ip.dx -= pose.dx; ip.dy -= pose.dy;
        g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, l.w, l.h); g.drawImage(l.img, 0, 0);
        g.globalCompositeOperation = 'source-atop'; g.drawImage(iris.img, iris.x - l.x + ip.dx, iris.y - l.y + ip.dy);
        const cx = iris.x - l.x + ip.dx + iris.w * .66, cy = iris.y - l.y + ip.dy + iris.h * .3, gr = g.createRadialGradient(cx, cy, 0, cx, cy, 11);
        gr.addColorStop(0, `rgba(255,255,255,${.85 * glint})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(cx - 12, cy - 12, 24, 24);
        const bx = iris.x - l.x + ip.dx + iris.w * .4, by = iris.y - l.y + ip.dy + iris.h * .78, gb = g.createRadialGradient(bx, by, 0, bx, by, 9);
        gb.addColorStop(0, `rgba(170,210,255,${.35 + .2 * glint})`); gb.addColorStop(1, 'rgba(170,210,255,0)'); g.fillStyle = gb; g.fillRect(bx - 10, by - 10, 20, 20);
        // Upper-lid shadow, then the lid itself: a convex edge sweeping down; the lower lid rises a little.
        const lid = pose.lid || 0, sm = pose.smile || 0, w = l.w, h = l.h, skin = this.skin?.[l.side] || '#f3d2c2';
        const sh = g.createLinearGradient(0, 0, 0, h * .55); sh.addColorStop(0, 'rgba(60,40,60,.35)'); sh.addColorStop(1, 'rgba(60,40,60,0)');
        g.fillStyle = sh; g.fillRect(0, 0, w, h);
        // Lids are painted in sampled skin (the face layer under the eyes only has blurred placeholders).
        g.globalCompositeOperation = 'source-atop';
        if (lid > .01) {
            const edge = -h * .2 + lid * h * 1.05, bow = h * .22;
            const lidSkin = this.lidSkin?.[l.side] || skin;
            const lg = g.createLinearGradient(0, 0, 0, edge + bow); lg.addColorStop(0, lidSkin); lg.addColorStop(.7, lidSkin); lg.addColorStop(1, 'rgba(140,88,92,.95)');
            g.fillStyle = lg; g.beginPath(); g.moveTo(-2, -2); g.lineTo(w + 2, -2); g.lineTo(w + 2, edge); g.quadraticCurveTo(w / 2, edge + bow * 2, -2, edge); g.closePath(); g.fill();
            g.strokeStyle = `rgba(55,35,48,${Math.min(1, lid * 2.2) * .85})`; g.lineWidth = 3.5; g.lineCap = 'round';
            g.beginPath(); g.moveTo(w * .04, edge + bow * .15); g.quadraticCurveTo(w / 2, edge + bow * 2, w * .96, edge + bow * .15); g.stroke();
            g.fillStyle = skin; g.fillRect(0, h - lid * h * .12, w, h);
        }
        if (sm > .01) {
            const base = h * (1.02 - sm * .32), arch = sm * h * .34;
            const lg = g.createLinearGradient(0, base - arch, 0, h); lg.addColorStop(0, skin); lg.addColorStop(1, skin);
            g.fillStyle = lg; g.beginPath(); g.moveTo(-2, h + 2); g.lineTo(-2, base); g.quadraticCurveTo(w / 2, base - arch * 2, w + 2, base); g.lineTo(w + 2, h + 2); g.closePath(); g.fill();
            g.strokeStyle = `rgba(70,42,52,${.35 + .35 * sm})`; g.lineWidth = 2.5; g.lineCap = 'round';
            g.beginPath(); g.moveTo(w * .12, base - arch * .2); g.quadraticCurveTo(w / 2, base - arch * 2, w * .88, base - arch * .2); g.stroke();
        }
        const cl = pose.closed || 0;
        if (cl > .01) { g.globalAlpha = cl; g.fillStyle = skin; g.fillRect(0, 0, w, h); g.globalAlpha = 1; }
        g.globalCompositeOperation = 'source-over';
    }

    /** Soft skin patch over the eye area while the closed-eye arc shows: the face layer only has blurred placeholders there. */
    skinPatch(l, a) {
        if (a <= .01) return;
        const white = this.eyes[l.side]?.white, hg = this.hg, skin = this.skin?.[l.side] || '#f3d2c2'; if (!white) return;
        const cx = white.x + white.w / 2, cy = white.y + white.h / 2, rx = white.w * .78, ry = white.h * .8;
        hg.save(); hg.globalAlpha = a; hg.translate(cx, cy); hg.scale(1, ry / rx);
        const gr = hg.createRadialGradient(0, 0, rx * .55, 0, 0, rx);
        gr.addColorStop(0, skin); gr.addColorStop(1, skin.replace('rgb(', 'rgba(').replace(')', ',0)'));
        hg.fillStyle = gr; hg.beginPath(); hg.arc(0, 0, rx, 0, Math.PI * 2); hg.fill(); hg.restore();
    }

    /** Cylindrical warp of the head canvas: the face centre travels with yaw/pitch while the silhouette and neck stay put. */
    drawWarped(p, k, strength) {
        const { ctx, head } = this, W = WARP;
        const yaw = p.ParamAngleX / 30 * .26 * strength, pitch = -p.ParamAngleY / 30 * .16 * strength;
        if (Math.abs(yaw) < .002 && Math.abs(pitch) < .002) { ctx.drawImage(head, 0, 0, head.width, head.height, 0, 0, head.width / k, head.height / k); return; }
        // Backing: the unwarped head under the mesh hides hairline seams between triangles (the silhouette barely moves).
        ctx.drawImage(head, 0, 0, head.width, head.height, 0, 0, head.width / k, head.height / k);
        const map = (xx, yy) => {
            const fy = clamp01((W.y1 - 40 - yy) / 260);
            const u = Math.max(-.97, Math.min(.97, (xx - W.cx) / W.rx)), v = Math.max(-.97, Math.min(.97, (yy - W.cy) / W.ry));
            const bulge = Math.sqrt(Math.max(0, 1 - v * v)), bu = Math.sqrt(Math.max(0, 1 - u * u));
            const dx = W.rx * (Math.sin(Math.asin(u) + yaw * bulge) - u) * fy;
            const dy = W.ry * (Math.sin(Math.asin(v) + pitch * bu) - v) * fy;
            return [xx + dx, yy + dy];
        };
        const pts = [];
        for (let j = 0; j <= W.rows; j++) { const row = []; for (let i = 0; i <= W.cols; i++) { const sx = W.x0 + (W.x1 - W.x0) * i / W.cols, sy = W.y0 + (W.y1 - W.y0) * j / W.rows; row.push([sx, sy, ...map(sx, sy)]); } pts.push(row); }
        // Every head layer lies inside the grid, so the head is painted only through the warped triangles.
        for (let j = 0; j < W.rows; j++) for (let i = 0; i < W.cols; i++) {
            const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i], d = pts[j + 1][i + 1];
            this.tri(a, b, c, k); this.tri(b, d, c, k);
        }
    }
    tri(A, B, C, k) {
        const { ctx, head } = this;
        const [x0, y0, u0, v0] = A, [x1, y1, u1, v1] = B, [x2, y2, u2, v2] = C;
        const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (!det) return;
        const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det, c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
        const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det, d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
        const e = u0 - a * x0 - c * y0, f = v0 - b * x0 - d * y0;
        const mx = (u0 + u1 + u2) / 3, my = (v0 + v1 + v2) / 3, grow = pt => { const dx = pt[0] - mx, dy = pt[1] - my, L = Math.hypot(dx, dy) || 1; return [pt[0] + dx / L * 1.2, pt[1] + dy / L * 1.2]; };
        const [p0, p1, p2] = [grow([u0, v0]), grow([u1, v1]), grow([u2, v2])];
        ctx.save(); ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.lineTo(...p2); ctx.closePath(); ctx.clip();
        ctx.transform(a, b, c, d, e, f);
        const bx = Math.min(x0, x1, x2) - 2, by = Math.min(y0, y1, y2) - 2, bw = Math.max(x0, x1, x2) - bx + 4, bh = Math.max(y0, y1, y2) - by + 4;
        ctx.drawImage(head, bx * k, by * k, bw * k, bh * k, bx, by, bw, bh);
        ctx.restore();
    }

    /** Night grade: cool soft-light tint, moon (left, cool) vs lamp (right, warm), desk shade, rim lights. Only on Noa's pixels. */
    lightPass(x, dt) {
        const { ctx, canvas, tg, tmp } = this, w = canvas.width, h = canvas.height, f = this.flash;
        f.warm = Math.max(0, f.warm - dt * .9); f.cool = Math.max(0, f.cool - dt * 1.2);
        const lamp = x.lamp ?? 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, w, h); tg.drawImage(canvas, 0, 0);
        ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(60,78,150,.32)'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(tmp, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        const side = ctx.createLinearGradient(0, 0, w, 0);
        // This stage's room: moon window on the viewer's left of Noa, warm lamp on the right (docs/ART_BRIEF.md).
        side.addColorStop(0, `rgba(90,120,210,${.16 + .25 * f.cool})`); side.addColorStop(.5, 'rgba(0,0,0,0)');
        side.addColorStop(1, `rgba(255,170,100,${.13 * lamp + .22 * f.warm})`);
        ctx.fillStyle = side; ctx.fillRect(0, 0, w, h);
        const low = ctx.createLinearGradient(0, h * .6, 0, h); low.addColorStop(0, 'rgba(8,10,24,0)'); low.addColorStop(1, 'rgba(8,10,24,.34)');
        ctx.fillStyle = low; ctx.fillRect(0, 0, w, h);
        if (x.rim !== false) {
            const rim = (dx, dy, color, a) => {
                tg.globalCompositeOperation = 'source-over'; tg.clearRect(0, 0, w, h); tg.drawImage(canvas, 0, 0);
                tg.globalCompositeOperation = 'source-in'; tg.fillStyle = color; tg.fillRect(0, 0, w, h);
                tg.globalCompositeOperation = 'destination-out'; tg.drawImage(canvas, dx, dy);
                ctx.globalAlpha = a; ctx.filter = 'blur(1.6px)'; ctx.drawImage(tmp, 0, 0); ctx.filter = 'none';
            };
            rim(8, 3, '#bcd4ff', .6 + .3 * f.cool);            // a positive shift leaves the LEFT edge: moonlight
            rim(-6, 2, '#ffc58c', (.22 + .25 * f.warm) * lamp); // a negative shift leaves the RIGHT edge: lamp
            ctx.globalAlpha = 1;
        }
        ctx.globalCompositeOperation = 'source-over';
    }
}
