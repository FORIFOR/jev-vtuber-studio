import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync, crc32 } from 'node:zlib';

const directory = new URL('../public/models/noa/', import.meta.url);
const model = JSON.parse(readFileSync(new URL('model.json', directory)));

// Inspect the shipped non-interlaced RGBA8 PNGs, without a browser or substitute image objects.
function rgba(layer) {
    const bytes = readFileSync(new URL(layer.file, directory));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], layer.file);
    const compressed = [];
    let offset = 8, ended = false, headers = 0;
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
        assert.ok(end <= bytes.length, `${layer.file}: truncated chunk`);
        const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
        assert.equal(crc32(bytes.subarray(offset + 4, end - 4)), bytes.readUInt32BE(end - 4), `${layer.file}: ${type} checksum`);
        if (type === 'IHDR') {
            headers++;
            assert.equal(offset, 8);
            assert.equal(length, 13);
            assert.deepEqual([data.readUInt32BE(0), data.readUInt32BE(4)], [layer.w, layer.h], `${layer.file}: manifest dimensions`);
            assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0], `${layer.file}: RGBA8, non-interlaced`);
        }
        if (type === 'IDAT') compressed.push(data);
        if (type === 'IEND') { assert.equal(length, 0); assert.equal(end, bytes.length); ended = true; }
        offset = end;
    }
    assert.equal(headers, 1);
    assert.ok(ended && compressed.length > 0, `${layer.file}: complete image`);
    const stride = layer.w * 4, raw = inflateSync(Buffer.concat(compressed)), pixels = Buffer.alloc(stride * layer.h);
    assert.equal(raw.length, (stride + 1) * layer.h, `${layer.file}: decoded dimensions`);
    const paeth = (left, above, corner) => {
        const prediction = left + above - corner;
        const a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - corner);
        return a <= b && a <= c ? left : b <= c ? above : corner;
    };
    for (let y = 0; y < layer.h; y++) {
        const start = y * stride, row = y * (stride + 1), filter = raw[row];
        assert.ok(filter <= 4, `${layer.file}: valid PNG filter`);
        for (let x = 0; x < stride; x++) {
            const left = x >= 4 ? pixels[start + x - 4] : 0;
            const above = y > 0 ? pixels[start + x - stride] : 0;
            const corner = x >= 4 && y > 0 ? pixels[start + x - stride - 4] : 0;
            const prediction = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, corner)][filter];
            pixels[start + x] = (raw[row + 1 + x] + prediction) & 255;
        }
    }
    return pixels;
}

test('every shipped 2D layer is a complete, nonblank transparent PNG matching its manifest', () => {
    assert.equal(new Set(model.layers.map(layer => layer.name)).size, model.layers.length);
    assert.deepEqual(model.layers.map(layer => layer.file).sort(), readdirSync(directory).filter(file => file.endsWith('.png')).sort());
    for (const layer of model.layers) {
        const pixels = rgba(layer);
        let visible = 0, transparent = 0;
        for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] > 0) visible++;
            if (pixels[index] < 255) transparent++;
        }
        assert.ok(visible > 0, `${layer.file}: drawable pixels`);
        assert.ok(transparent > 0, `${layer.file}: compositable transparent boundary`);
    }
});

test('the real 2D model contains paired eyes, mouth states and valid v4 skin sampling regions', () => {
    for (const side of ['L', 'R']) {
        for (const kind of ['eyeWhite', 'iris', 'lash', 'closedEye', 'brow', 'hair'])
            assert.equal(model.layers.filter(layer => layer.side === side && layer.kind === kind).length, 1, `${side}: ${kind}`);
    }
    for (const kind of ['body', 'face', 'mouthOpen', 'mouthClosed', 'mouthO', 'mouthWave'])
        assert.equal(model.layers.filter(layer => layer.kind === kind).length, 1, kind);
    const face = model.layers.find(layer => layer.kind === 'face'), pixels = rgba(face);
    for (const [x, y] of [[600, 580], [818, 592]]) {
        assert.ok(x - 3 >= face.x && x + 3 < face.x + face.w && y - 3 >= face.y && y + 3 < face.y + face.h);
        let opaque = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++)
            if (pixels[((y - face.y + dy) * face.w + x - face.x + dx) * 4 + 3] > 200) opaque++;
        assert.ok(opaque > 0, `v4 eyelid color at ${x},${y} is sampled from actual skin pixels`);
    }
    const stage = readFileSync(new URL('../public/stage.html', import.meta.url), 'utf8');
    for (const id of ['noa-layers', 'noa-vrm']) {
        const tag = stage.match(new RegExp(`<canvas\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
        assert.ok(tag, `${id}: dedicated canvas`);
        const width = Number(tag.match(/\bwidth="(\d+)"/)?.[1]), height = Number(tag.match(/\bheight="(\d+)"/)?.[1]);
        assert.equal(width / height, model.canvas[0] / model.canvas[1], `${id}: same 3:4 framing`);
    }
});
