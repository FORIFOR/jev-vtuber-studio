import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AvatarController, Affect, PARAMS } from '../public/avatar-rig.mjs';

const ROOT = new URL('../', import.meta.url);
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const run = (a, from, to, step = 16) => { const frames = []; for (let t = from; t <= to; t += step) frames.push(a.update(t)); return frames; };
const inRange = p => Object.entries(p).every(([k, v]) => Number.isFinite(v) && v >= PARAMS[k][0] && v <= PARAMS[k][1]);
const read = path => readFileSync(new URL(path, ROOT), 'utf8');

test('two-argument react() is frame-identical to gain 1', () => {
    for (const name of ['surprised', 'shock', 'laugh', 'embarrassed', 'thinking']) {
        const a = new AvatarController({ random: seq(.1, .5, .9, .3), now: 0 }), b = new AvatarController({ random: seq(.1, .5, .9, .3), now: 0 });
        run(a, 0, 400); run(b, 0, 400);
        a.react(name, 416); b.react(name, 416, 1);
        a.mouth(.4); b.mouth(.4);
        const fa = [], fb = [];
        for (let i = 1; i <= 60; i++) { fa.push(a.update(416 + i * 16)); fb.push(b.update(416 + i * 16)); }
        assert.deepEqual(fa, fb, name);
    }
});

test('gain 1.25 strengthens surprised brows and eyes, within PARAMS', () => {
    const frame = gain => {
        const a = new AvatarController({ random: () => .99, now: 0 });
        run(a, 0, 1000);
        if (gain !== null) a.react('surprised', 1000, gain);
        const frames = run(a, 1016, 1800);
        assert.ok(frames.every(inRange));
        return frames.at(-1);
    };
    const idle = frame(null), g1 = frame(1), g125 = frame(1.25);
    for (const k of ['ParamBrowLY', 'ParamEyeLOpen']) {
        const d1 = g1[k] - idle[k], d125 = g125[k] - idle[k];
        assert.ok(d1 > 0 && d125 > d1, `${k}: ${d1} → ${d125}`);
    }
});

test('gain is clamped to .5..1.3 and non-finite gain acts as 1', () => {
    const a = new AvatarController({ random: () => .5 });
    a.react('shock', 0, 3); assert.equal(a.reaction.gain, 1.3);
    a.react('shock', 0, .1); assert.equal(a.reaction.gain, .5);
    a.react('shock', 0, NaN); assert.equal(a.reaction.gain, 1);
    const b = new AvatarController({ random: () => .5, now: 0 }), c = new AvatarController({ random: () => .5, now: 0 });
    b.react('shock', 0, 3); c.react('shock', 0, 1.3);
    const fb = run(b, 16, 2000), fc = run(c, 16, 2000);
    assert.deepEqual(fb, fc);
    assert.ok(fb.every(inRange));
});

test('Affect.apply scale halves the nudge and is clamped', () => {
    const full = new Affect(), half = new Affect(), big = new Affect();
    full.apply('happy', 1000); half.apply('happy', 1000, .5); big.apply('happy', 1000, 9);
    const d = a => a.state.happy - a.base.happy;
    assert.ok(Math.abs(d(half) - d(full) / 2) < 1e-9);
    assert.ok(Math.abs(d(big) - d(full) * 1.5) < 1e-9);
    const legacy = new Affect(); legacy.apply('happy', 1000, 1);
    assert.deepEqual(legacy.state, full.state);
});

test('voice/delivery stay operator-only: Studio has the cards, the stage does not', () => {
    const stageJs = read('public/stage.mjs'), stageHtml = read('public/stage.html'), studio = read('public/index.html');
    assert.match(stageJs, /import \{[^}]*\bvoiceLead\b[^}]*\} from '\.\/voice-acting\.mjs'/);
    for (const id of ['id="voice"', 'id="delivery"']) { assert.ok(!stageHtml.includes(id), id); assert.ok(studio.includes(id), id); }
    for (const id of ['id="affect"', 'id="reaction"', 'id="comment-queue"', 'id="performance"', 'id="game-brain"', 'id="events"', 'id="programme"']) assert.ok(studio.includes(id), id);
    for (const s of ['tiers', 'voice_tier', 'engine:']) assert.ok(!stageJs.includes(s), s);
    const js = read('public/studio.mjs');
    for (const s of ["pairs('voice'", "pairs('delivery'", "voice_tier: 'VOICE tier'", "voice_circuit: 'VOICE ✕'", "voice_warmup: 'VOICE warm'", "'TTFA'", "'RTF‰'"]) assert.ok(js.includes(s), s);
});
