import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AvatarController, PARAMS, REACTIONS } from '../public/avatar-rig.mjs';
import { INTENSITY_GAIN } from '../public/voice-acting.mjs';
import { APPROVED_MOTIONS, EXPRESSIONS, REACTION_MAP, VOWEL_NAMES, deriveControls, reactionPlan } from '../browser/avatar-vrm/controls.mjs';

const base = new URL('../public/models/noa3d/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('motions/manifest.json', base)));
const range = (value, lo, hi) => assert.ok(Number.isFinite(value) && value >= lo && value <= hi, `${value} in [${lo}, ${hi}]`);

test('all actual Jev reaction presets resolve to reviewed local motion and expression names', () => {
    assert.deepEqual(Object.keys(REACTION_MAP).sort(), Object.keys(REACTIONS).sort());
    assert.deepEqual(Object.keys(APPROVED_MOTIONS).sort(), Object.keys(manifest.motions).sort());
    for (const [gesture, [file, digest]] of Object.entries(APPROVED_MOTIONS)) {
        const asset = manifest.motions[gesture];
        assert.equal(asset.file, file);
        assert.equal(asset.sha256, digest);
        assert.equal(asset.license, 'MIT');
        assert.equal(createHash('sha256').update(readFileSync(new URL(`motions/${file}`, base))).digest('hex'), digest);
    }
    for (const name of Object.keys(REACTIONS)) for (const intensity of Object.values(INTENSITY_GAIN)) {
        const plan = reactionPlan(name, intensity);
        assert.equal(plan.name, name);
        assert.ok(Object.hasOwn(APPROVED_MOTIONS, plan.gesture));
        assert.ok(EXPRESSIONS.includes(plan.expression));
        range(plan.intensity, .2, 1);
        assert.equal(reactionPlan(name, intensity, { reducedMotion: true }).gesture, 'idle');
    }
    assert.equal(REACTION_MAP.surprised.expression, 'Surprised');
    assert.deepEqual(VOWEL_NAMES, { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' });
});

test('actual AvatarController reaction frames remain bounded through the VRM adapter', () => {
    for (const name of Object.keys(REACTIONS)) for (const gain of Object.values(INTENSITY_GAIN)) {
        const avatar = new AvatarController({ now: 0 });
        avatar.react(name, 0, gain);
        for (const now of [0, 90, 180, 400, 800, 1600, 3200]) {
            const params = avatar.update(now);
            const frame = deriveControls(params, { reaction: { name, gain, weight: avatar.weight(now) }, role: 'host' });
            for (const value of frame.head) range(value, -Math.PI / 6, Math.PI / 6);
            for (const value of frame.body) range(value, -Math.PI / 12, Math.PI / 12);
            range(frame.gaze.yaw, -22, 22); range(frame.gaze.pitch, -14, 14);
            range(frame.blink.left, 0, 1); range(frame.blink.right, 0, 1);
            range(frame.expressionWeight, 0, 1); range(frame.motion, 0, 1);
            assert.equal(frame.expression, REACTION_MAP[name].expression);
            for (const value of Object.values(frame.vowels)) range(value, 0, 1);
        }
        avatar.settle(3200);
        avatar.update(6400);
        assert.equal(avatar.reaction, null, `${name} returns to idle after its real afterglow`);
    }
});

test('production mouth bounds map to the correct VRM vowels and preserve closed nasal shapes', () => {
    const avatar = new AvatarController({ now: 0 });
    avatar.mouth(PARAMS.ParamMouthOpenY[1]);
    let params;
    for (const now of [100, 200, 300, 400, 500]) params = avatar.update(now);
    assert.ok(params.ParamMouthOpenY > .99);
    for (const [vowel, expression] of Object.entries(VOWEL_NAMES)) {
        const frame = deriveControls(params, { role: 'host', vis: { [vowel]: 1 } });
        for (const name of Object.values(VOWEL_NAMES)) assert.equal(frame.vowels[name], name === expression ? params.ParamMouthOpenY : 0);
        const narrator = deriveControls(params, { role: 'comment', vis: { [vowel]: 1 } });
        assert.equal(narrator.mouthLocked, true);
        assert.equal(narrator.mouthOpen, 0);
        assert.ok(Object.values(narrator.vowels).every(value => value === 0));
    }
    const nasal = deriveControls(params, { role: 'host', vis: { n: 1 } });
    assert.ok(Object.values(nasal.vowels).every(value => value === 0));
    const blend = deriveControls(params, { role: 'host', vis: Object.fromEntries([...Object.keys(VOWEL_NAMES), 'n'].map(name => [name, 1])) });
    assert.ok(Object.values(blend.vowels).reduce((sum, value) => sum + value, 0) <= params.ParamMouthOpenY);
    assert.ok(deriveControls(params, { role: 'host' }).vowels.aa > .99, 'amplitude-only fallback is available without invented phoneme timing');
});

test('the VRM blink follows the real controller, without independent blink timing', () => {
    const avatar = new AvatarController({ now: 0 });
    const start = avatar.nextBlink;
    avatar.update(start);
    const closed = avatar.update(start + 75);
    const frame = deriveControls(closed);
    assert.equal(frame.blink.left, 1 - closed.ParamEyeLOpen);
    assert.equal(frame.blink.right, 1 - closed.ParamEyeROpen);
    assert.ok(frame.blink.left > .99 && frame.blink.right > .99);
    const open = deriveControls(avatar.update(start + 500));
    assert.equal(open.blink.left, 0);
    assert.equal(open.blink.right, 0);
});

test('parameter limits, non-finite inputs and unknown reaction names cannot escape VRM controls', () => {
    for (const boundary of [0, 1]) {
        const params = Object.fromEntries(Object.entries(PARAMS).map(([name, limits]) => [name, limits[boundary]]));
        const controls = deriveControls(params);
        for (const value of [...controls.head, ...controls.body]) range(value, -.35, .35);
        range(controls.mouthOpen, 0, 1);
    }
    for (const value of [NaN, Infinity, -Infinity]) {
        const params = Object.fromEntries(Object.keys(PARAMS).map(name => [name, value]));
        const controls = deriveControls(params, { motion: value, reaction: { name: '__proto__', gain: value, weight: value } });
        assert.equal(controls.expression, 'neutral');
        for (const number of [...controls.head, ...controls.body, ...Object.values(controls.vowels), controls.motion, controls.expressionWeight]) assert.ok(Number.isFinite(number));
        const plan = reactionPlan('constructor', value);
        assert.equal(plan.name, 'neutral');
        range(plan.intensity, .2, 1);
    }
});
