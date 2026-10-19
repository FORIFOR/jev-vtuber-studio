import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { AI_RING_MATERIAL, aiRingIntensity } from '../browser/avatar-vrm/ai-ring.mjs';

test('the AI ring follows the voice while speaking, holds a steady glow while attending, and stays bounded', () => {
    assert.ok(aiRingIntensity({ speaking: true, led: 1 }) > aiRingIntensity({ speaking: true, led: .45 }));
    assert.equal(aiRingIntensity({ speaking: false, led: .2, reaction: { name: 'thinking' } }), .9);
    assert.equal(aiRingIntensity({ speaking: false, led: .2, reaction: { name: 'listen' } }), .9);
    for (const led of [NaN, -1, 0, .5, 1, 9, undefined]) {
        const value = aiRingIntensity({ led });
        assert.ok(Number.isFinite(value) && value >= .35 && value <= 1.65, String(led));
    }
});

const vrmShipped = existsSync(new URL('../public/models/noa3d/Noa.vrm', import.meta.url));
test('the shipped model has the ring material the renderer drives', { skip: !vrmShipped && 'Noa.vrm is not in this checkout (the public repository leaves it out; docs/ASSETS.md)' }, () => {
    const bytes = readFileSync(new URL('../public/models/noa3d/Noa.vrm', import.meta.url));
    const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
    const rings = doc.materials.filter(material => AI_RING_MATERIAL.test(material.name));
    assert.equal(rings.length, 1);
    assert.ok(rings[0].emissiveFactor.some(value => value > .3), 'authored as emissive');
});
