import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanaVowel } from '../public/noa-avatar-v4.mjs';

test('kana → viseme', () => {
    assert.equal(kanaVowel('か'), 'a'); assert.equal(kanaVowel('シ'), 'i'); assert.equal(kanaVowel('つ'), 'u');
    assert.equal(kanaVowel('ね'), 'e'); assert.equal(kanaVowel('ょ'), 'o'); assert.equal(kanaVowel('ん'), 'n');
    assert.equal(kanaVowel('ー'), null);
    assert.ok('aiueo'.includes(kanaVowel('夜')));
});

// Decision logic only (the drawing needs a browser canvas; it is checked on the stage).
import { readFileSync } from 'node:fs';
import { NoaAvatarV4 } from '../public/noa-avatar-v4.mjs';
import { PARAMS } from '../public/avatar-rig.mjs';
const model = JSON.parse(readFileSync(new URL('../public/models/noa/model.json', import.meta.url)));
const L = name => model.layers.find(l => l.name === name);
const rest = Object.fromEntries(Object.entries(PARAMS).map(([k, r]) => [k, r[2]]));
const pose = (p, name, x = {}) => NoaAvatarV4.prototype.pose.call(null, { ...rest, ...p }, L(name), x);

test('v4 blink closes from the top (lid painted, eye kept) and only then shows the closed-eye arc', () => {
    const half = { ParamEyeLOpen: .5 };
    assert.equal(pose(half, 'EyeWhiteL').alpha, 1, 'the eye stays; the lid covers it');
    assert.equal(pose(half, 'EyeWhiteL').lid, .5); assert.equal(pose(half, 'EyeClosedL').alpha, 0);
    assert.equal(pose(half, 'EyeLashL').dy, 22, 'the lash follows the lid down');
    assert.equal(pose({ ParamEyeLOpen: 0 }, 'EyeClosedL').alpha, 1);
});

test('v4 smile lifts the lower lid (never a sleepy half-lid); a full smile becomes the closed arc', () => {
    const smile = pose({ ParamEyeLSmile: .5 }, 'EyeWhiteL');
    assert.equal(smile.lid, 0, 'the upper lid stays open'); assert.equal(smile.smile, .5); assert.equal(pose({ ParamEyeLSmile: .5 }, 'EyeClosedL').alpha, 0);
    assert.ok(pose({ ParamEyeLSmile: 1 }, 'EyeClosedL').alpha > .9);
});

test('v4 lip shapes: a/i/e use the open mouth at their widths, o/u/n the o mouth; no vis = the usual mouths', () => {
    const talk = { ParamMouthOpenY: .8 };
    assert.equal(pose(talk, 'MouthOpen', { vis: { i: 1 } }).sx, 1.2);
    assert.equal(pose(talk, 'MouthOpen', { vis: { a: 1 } }).sx, 1);
    const o = pose(talk, 'MouthO', { vis: { o: 1 } }); assert.ok(o.alpha > .9); assert.equal(o.sx, .95);
    assert.ok(pose(talk, 'MouthOpen', { vis: { o: 1 } }).alpha < .1, 'an o does not also show the open mouth');
    assert.ok(pose(talk, 'MouthOpen').alpha > .9, 'without vis the v3 mouth logic applies');
    assert.ok(pose({ ParamMouthOpenY: 0 }, 'MouthClosed', { vis: { a: 1 } }).alpha > .9, 'silent: the closed mouth');
});

test('kanji get a stable pseudo-vowel (same character, same shape every frame)', () => {
    for (const ch of '夜配信星') assert.equal(kanaVowel(ch), kanaVowel(ch));
});
