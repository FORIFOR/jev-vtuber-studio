import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { layerPose, rigPose, eyeOpenness, expressionWeights } from '../public/layer-avatar.mjs';
import { AvatarController, PARAMS } from '../public/avatar-rig.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

const model = JSON.parse(readFileSync(new URL('../public/models/noa/model.json', import.meta.url)));
const L = name => model.layers.find(l => l.name === name);
const rest = Object.fromEntries(Object.entries(PARAMS).map(([k, r]) => [k, r[2]]));
const at = (name, ms = 700, mouth = 0) => { const c = new AvatarController({ random: () => .5, now: 0 }); c.nextBlink = 1e12; if (mouth) c.mouth(mouth); else c.react(name, 0); let p; for (let t = 0; t <= ms; t += 16) p = c.update(t); return p; };

test('Noa layer manifest: every part exists, sits inside the 1200x1600 canvas, and has a known kind', () => {
    assert.deepEqual(model.canvas, [1200, 1600]); assert.equal(model.layers.length, 21);
    for (const l of model.layers) {
        assert.ok(existsSync(new URL(`../public/models/noa/${l.file}`, import.meta.url)), l.file);
        assert.match(l.file, /^[A-Za-z0-9]+\.png$/);
        assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= 1200 && l.y + l.h <= 1600, l.name);
        assert.ok(['body', 'head', 'face', 'eyeWhite', 'iris', 'lash', 'closedEye', 'brow', 'blush', 'mouthOpen', 'mouthClosed', 'mouthO', 'mouthWave', 'hair'].includes(l.kind), l.kind);
    }
});

test('layer pose: at rest the eyes are open and the mouth closed; a blink swaps to the closed-eye parts', () => {
    assert.equal(layerPose(rest, L('EyeLashL')).alpha, 1); assert.equal(layerPose(rest, L('EyeClosedL')).alpha, 0);
    assert.equal(layerPose(rest, L('MouthClosed')).alpha, 1); assert.equal(layerPose(rest, L('MouthOpen')).alpha, 0); assert.equal(layerPose(rest, L('Blush')).alpha, .45);
    const blink = { ...rest, ParamEyeLOpen: 0, ParamEyeROpen: 0 };
    assert.equal(layerPose(blink, L('EyeWhiteR')).alpha, 0); assert.equal(layerPose(blink, L('EyeClosedR')).alpha, 1);
    assert.ok(eyeOpenness(1, 1) < .3, 'a full eye smile reads as the closed arc');
});

test('controller → layers: talking opens the mouth, laugh closes the eyes, embarrassed blushes, troubled moves the brows', () => {
    const talk = at(null, 700, .8);
    assert.ok(layerPose(talk, L('MouthOpen')).alpha > .9); assert.ok(layerPose(talk, L('MouthClosed')).alpha < .1);
    assert.ok(layerPose(at('laugh'), L('EyeClosedL')).alpha > .9);
    assert.ok(layerPose(at('embarrassed'), L('Blush')).alpha > layerPose(at('neutral'), L('Blush')).alpha + .3);
    const t = at('troubled'), b = layerPose(t, L('BrowL')), n = layerPose(at('neutral'), L('BrowL'));
    assert.ok(Math.abs(b.rot - n.rot) + Math.abs(b.dy - n.dy) > 2);
    // Whole-image parts: the head never turns far enough to open the neck seam.
    for (const name of ['shock', 'excited', 'laugh', 'nod']) for (let ms = 0; ms <= 1500; ms += 100) assert.ok(Math.abs(rigPose(at(name, ms)).head.rot) <= 30 * .35);
});

test('model files are served only by flat name from the fixed folder', async t => {
    const c = setup(t); const a = createApp(c, { remoteOptions: false }); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const m = await fetch(url + '/models/noa/model.json'); assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /json/);
    assert.equal((await fetch(url + '/models/noa/Face.png')).headers.get('content-type'), 'image/png');
    for (const p of ['/models/noa/Nope.png', '/models/noa/model.js', '/models/other/Face.png', '/models/noa/%2e%2e%2fstage.html', '/models/room/background.png', '/models/room/%2e%2e%2fnoa%2fmodel.json']) assert.equal((await fetch(url + p)).status, 404, p);
});

test('surprise and trouble are carried by the mouth shape (brows hide under the bangs), and only by their own presets', () => {
    const w = n => expressionWeights(at(n));
    for (const n of ['neutral', 'happy', 'excited', 'embarrassed', 'thinking', 'laugh', 'nod']) assert.deepEqual([w(n).surprise < .1, w(n).trouble < .1], [true, true], n);
    assert.ok(w('surprised').surprise > .7 && w('shock').surprise > .7); assert.ok(w('troubled').trouble > .7);
    const s = at('surprised'), t = at('troubled');
    assert.ok(layerPose(s, L('MouthO')).alpha > .7 && layerPose(s, L('MouthClosed')).alpha < .3, 'surprise: small o mouth');
    assert.ok(layerPose(t, L('MouthWave')).alpha > .7 && layerPose(t, L('MouthClosed')).alpha < .3, 'troubled: wavy mouth');
    assert.ok(t.ParamEyeBallY < -.2, 'troubled looks down');
    // Speaking always shows the open mouth, whatever the expression; a surprised voice talks through a rounder one.
    const talkingSurprised = { ...s, ParamMouthOpenY: .9 };
    assert.equal(layerPose(talkingSurprised, L('MouthO')).alpha, 0); assert.ok(layerPose(talkingSurprised, L('MouthOpen')).sx < .8);
});

test('happy and laugh read without labels: a small open smile (not a neutral face), and laugh ≠ blink', () => {
    const mouth = p => layerPose(p, L('MouthOpen')).alpha;
    assert.equal(mouth(at('neutral')), 0); assert.ok(mouth(at('happy')) > .8, 'happy smiles open');
    const laugh = at('laugh'), blink = { ...rest, ParamEyeLOpen: 0, ParamEyeROpen: 0 };
    assert.ok(layerPose(laugh, L('EyeClosedL')).alpha > .9 && layerPose(blink, L('EyeClosedL')).alpha > .9);
    assert.ok(mouth(laugh) > .8 && mouth(blink) === 0, 'a laugh opens the mouth; a blink does not');
    const emb = at('embarrassed'); assert.ok(Math.abs(layerPose(emb, L('EyeIrisL')).dx) > 4, 'embarrassed looks away visibly');
});

test('attention: while she plays quietly she watches the board and leans in; speaking halves it', () => {
    const c = new AvatarController({ random: () => .5, now: 0 }); c.attend({ x: -.85, y: -.25, lean: 1 });
    let p; for (let t = 0; t <= 2000; t += 16) p = c.update(t);
    assert.ok(p.ParamEyeBallX < -.6 && p.ParamAngleX < -4, 'gaze and head toward the board');
    c.mouth(.6); for (let t = 2000; t <= 4000; t += 16) p = c.update(t);
    assert.ok(p.ParamEyeBallX > -.6 && p.ParamEyeBallX < -.2, 'a glance back while talking');
    c.attend(null); c.mouth(0); c.settle(4000); for (let t = 4000; t <= 8000; t += 16) p = c.update(t);
    assert.ok(Math.abs(p.ParamEyeBallX) < .5);
});

test('eyes: open and closed never show half each (no see-through lid), at any openness', async () => {
    const { layerPose: pose } = await import('../public/layer-avatar.mjs');
    const { readFileSync } = await import('node:fs');
    const layers = JSON.parse(readFileSync(new URL('../public/models/noa/model.json', import.meta.url))).layers;
    const L = f => layers.find(l => l.file === `${f}.png`);
    let mixed = 0;
    for (let o = 0; o <= 1.0001; o += .01) {
        const p = { ParamEyeLOpen: o, ParamEyeLSmile: 0, ParamAngleX: 0, ParamAngleY: 0, ParamEyeBallX: 0, ParamEyeBallY: 0 };
        const open = pose(p, L('EyeWhiteL')).alpha, closed = pose(p, L('EyeClosedL')).alpha;
        assert.ok(Math.abs(open + closed - 1) < 1e-9);
        if (open > .1 && closed > .1) mixed++;
    }
    assert.ok(mixed <= 3, `half-and-half frames: ${mixed}`);
});

test('NOA BEER: the blush floor follows the drink mode and returns to the usual level', async () => {
    const { layerPose: pose, setBlushFloor } = await import('../public/layer-avatar.mjs');
    const blush = { kind: 'blush', x: 0, y: 0, w: 10, h: 10, opacity: 0 }, p = { ParamCheek: 0, ParamAngleX: 0, ParamAngleY: 0 };
    setBlushFloor(.85); assert.equal(pose(p, blush).alpha, .85);
    setBlushFloor(.45); assert.equal(pose(p, blush).alpha, .45);
});
