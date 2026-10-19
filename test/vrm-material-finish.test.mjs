import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { configureNoaMaterials, NOA_FINISH_GROUPS } from '../browser/avatar-vrm/material-finish.mjs';

// Uniform boundary fixture. The image comparison separately exercises real MToon.
class Color {
    isColor = true;
    constructor(r = .1, g = .2, b = .3) { this.setRGB(r, g, b); }
    setRGB(r, g, b) { Object.assign(this, { r, g, b }); return this; }
    clone() { return new Color(this.r, this.g, this.b); }
    copy(c) { return this.setRGB(c.r, c.g, c.b); }
}
const material = name => ({ name, isMToonMaterial: true,
    shadingShiftFactor: -.5, shadingToonyFactor: .5, giEqualizationFactor: .9,
    parametricRimColorFactor: new Color(), parametricRimFresnelPowerFactor: 8,
    parametricRimLiftFactor: .1, rimLightingMixFactor: 0,
    color: new Color(1, 1, 1), shadeColorFactor: new Color(.8, .7, .6),
    map: {}, normalMap: {}, alphaTest: .5, opacity: 1, transparent: false,
    depthWrite: true, side: 2, outlineWidthFactor: .00035, outlineColorFactor: new Color(),
});
const sceneOf = values => ({ traverse(fn) { values.forEach(value => fn({ material: value })); } });

const vrmShipped = existsSync(new URL('../public/models/noa3d/Noa.vrm', import.meta.url));
test('the material finish touches only shipped skin, hair, clothing and hardware uniforms', { skip: !vrmShipped && 'Noa.vrm is not in this checkout (the public repository leaves it out; docs/ASSETS.md)' }, () => {
    const bytes = readFileSync(new URL('../public/models/noa3d/Noa.vrm', import.meta.url));
    const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    const allowed = Object.values(NOA_FINISH_GROUPS).flat();
    for (const name of allowed) assert.ok(doc.materials.some(m => m.name === name), name);
    assert.equal(new Set(allowed).size, allowed.length);
    const materials = doc.materials.map(m => material(m.name));
    const untouchedKeys = ['color', 'shadeColorFactor', 'map', 'normalMap', 'alphaTest', 'opacity', 'transparent', 'depthWrite', 'side', 'outlineWidthFactor', 'outlineColorFactor'];
    const snapshots = materials.map(m => Object.fromEntries(untouchedKeys.map(k => [k, m[k]])));
    const unlisted = materials.filter(m => !allowed.includes(m.name));
    const unlistedBefore = unlisted.map(m => JSON.stringify(m));
    const finish = configureNoaMaterials(sceneOf(materials));
    assert.equal(finish.materialCount, allowed.length);
    materials.forEach((m, i) => {
        for (const key of untouchedKeys) assert.equal(m[key], snapshots[i][key], `${m.name}: preserve ${key}`);
    });
    assert.deepEqual(unlisted.map(m => JSON.stringify(m)), unlistedBefore, 'eyes, lashes, mouth and unrelated materials remain unchanged');
    finish.dispose();
});

test('shared MToon and outline uniforms are fitted once and restored exactly without allocating textures', () => {
    const hair = material(NOA_FINISH_GROUPS.hair[0]);
    const outline = material(hair.name + ' (Outline)');
    const otherShader = { ...material(hair.name), isMToonMaterial: false };
    const before = [hair, outline, otherShader].map(m => JSON.stringify(m));
    const scene = sceneOf([[hair, outline], hair, otherShader]);
    const finish = configureNoaMaterials(scene);
    assert.equal(finish.materialCount, 2);
    assert.equal(configureNoaMaterials(scene), finish);
    assert.notEqual(JSON.stringify(hair), before[0]);
    assert.equal(JSON.stringify(otherShader), before[2]);
    finish.dispose();
    finish.dispose();
    assert.deepEqual([hair, outline, otherShader].map(m => JSON.stringify(m)), before);
    const again = configureNoaMaterials(scene);
    assert.notEqual(again, finish);
    again.dispose();
    assert.deepEqual([hair, outline, otherShader].map(m => JSON.stringify(m)), before);
});
