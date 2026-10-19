// Authors public/models/noa3d/motions/noa-beckon.vrma: Noa's beckoning gesture from the adopted illustration (her left
// hand offered towards the viewer, her right hand raised beside her hair, head tilted). Original to this project (MIT);
// deterministic and dependency-free, so the pinned SHA-256 can be reproduced with `node scripts/build-noa-beckon-motion.mjs`.
// VRM Animation 1.0 conventions: T-pose rest with identity rotations, facing +Z, left arm along +X.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const mul = (a, b) => [                     // quaternion product a*b, [x, y, z, w]
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const inv = q => [-q[0], -q[1], -q[2], q[3]];
const rot = (q, v) => mul(mul(q, [...v, 0]), inv(q)).slice(0, 3);
const arc = (from, to) => { const a = norm(from), b = norm(to); return norm([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2]]); };
const about = (axis, degrees) => { const h = degrees * Math.PI / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; };
const ID = [0, 0, 0, 1], X = [1, 0, 0];
/** Upper and lower arm rotations that point the two segments along the given model-space directions. */
function arm(side, upperDir, lowerDir, twist = 0) {
    const rest = [side, 0, 0], upper = arc(rest, upperDir);
    return { upper, lower: mul(arc(rest, rot(inv(upper), norm(lowerDir))), about(X, twist)) };
}
const down = side => arm(side, [side * .26, -.966, 0], [side * .26, -.966, .02]);
const offer = arm(1, [.50, -.30, .81], [.42, -.02, .91], 85), curl = arm(1, [.50, -.30, .81], [.30, .30, .91], 85);   // forearm and wrist share the palm-up turn
const hair = arm(-1, [-.58, -.64, .50], [.40, .91, .02]);   // fingertips on the headset, as in the illustration
const L = down(1), R = down(-1), palmUp = about(X, 85), tilt = about([0, 0, 1], 8), lean = about([0, 0, 1], 3);
// time: rest, reach, (beckon twice), hold, return.
const times = [0, .6, 1.1, 1.4, 1.7, 2.0, 2.6, 3.3];
const tracks = {
    leftUpperArm: [L.upper, offer.upper, curl.upper, offer.upper, curl.upper, offer.upper, offer.upper, L.upper],
    leftLowerArm: [L.lower, offer.lower, curl.lower, offer.lower, curl.lower, offer.lower, offer.lower, L.lower],
    leftHand: [ID, palmUp, palmUp, palmUp, palmUp, palmUp, palmUp, ID],
    rightUpperArm: [R.upper, hair.upper, hair.upper, hair.upper, hair.upper, hair.upper, hair.upper, R.upper],
    rightLowerArm: [R.lower, hair.lower, hair.lower, hair.lower, hair.lower, hair.lower, hair.lower, R.lower],
    rightHand: [ID, ...Array(6).fill(about(X, -60)), ID],   // palm turned towards the face
    head: [ID, tilt, tilt, tilt, tilt, tilt, tilt, ID],
    spine: [ID, lean, lean, lean, lean, lean, lean, ID],
};
// The offered hand opens its fingers like a fan (palm up), as in the illustration: a turn about the palm normal (y).
const Y = [0, 1, 0], spread = { leftThumbProximal: -28, leftIndexProximal: -14, leftMiddleProximal: -4, leftRingProximal: 6, leftLittleProximal: 16 };
for (const [bone, degrees] of Object.entries(spread)) { const open = about(Y, degrees); tracks[bone] = [ID, open, open, open, open, open, open, ID]; }
const skeleton = [   // name, parent, rest translation
    ['hips', null, [0, .90, 0]], ['spine', 'hips', [0, .10, 0]], ['chest', 'spine', [0, .12, 0]], ['neck', 'chest', [0, .20, 0]], ['head', 'neck', [0, .08, 0]],
    ['leftUpperArm', 'chest', [.12, .16, 0]], ['leftLowerArm', 'leftUpperArm', [.22, 0, 0]], ['leftHand', 'leftLowerArm', [.20, 0, 0]],
    ['rightUpperArm', 'chest', [-.12, .16, 0]], ['rightLowerArm', 'rightUpperArm', [-.22, 0, 0]], ['rightHand', 'rightLowerArm', [-.20, 0, 0]],
    ['leftThumbProximal', 'leftHand', [.02, -.01, .025]], ['leftIndexProximal', 'leftHand', [.08, 0, .02]], ['leftMiddleProximal', 'leftHand', [.085, 0, .005]],
    ['leftRingProximal', 'leftHand', [.08, 0, -.01]], ['leftLittleProximal', 'leftHand', [.072, 0, -.025]],
];
const index = Object.fromEntries(skeleton.map(([name], i) => [name, i]));
const nodes = skeleton.map(([name, , translation]) => ({ name, translation, rotation: ID }));
for (const [name, parent] of skeleton) if (parent) (nodes[index[parent]].children ??= []).push(index[name]);
const chunks = [], bufferViews = [], accessors = [];
let length = 0;
function accessor(values, type) {
    const bytes = Buffer.from(new Float32Array(values).buffer);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length }); chunks.push(bytes); length += bytes.length;
    const size = type === 'SCALAR' ? 1 : 4, extent = type === 'SCALAR' ? { min: [Math.min(...values)], max: [Math.max(...values)] } : {};
    return accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / size, type, ...extent }) - 1;
}
const input = accessor(times, 'SCALAR'), samplers = [], channels = [];
for (const [bone, keys] of Object.entries(tracks)) {
    // Keep neighbouring keys on the same hemisphere so linear interpolation takes the short way.
    const fixed = keys.map(q => [...q]);
    for (let i = 1; i < fixed.length; i++) if (fixed[i].reduce((sum, v, k) => sum + v * fixed[i - 1][k], 0) < 0) fixed[i] = fixed[i].map(v => -v);
    samplers.push({ input, output: accessor(fixed.flat(), 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: index[bone], path: 'rotation' } });
}
const doc = {
    asset: { version: '2.0', generator: 'Jev VTuber Studio scripts/build-noa-beckon-motion.mjs' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(skeleton.map(([name]) => [name, { node: index[name] }])) } } },
    scene: 0, scenes: [{ name: 'NoaBeckon', nodes: [index.hips] }], nodes,
    animations: [{ name: 'noa-beckon', samplers, channels }], accessors, bufferViews, buffers: [{ byteLength: length }],
};
let json = Buffer.from(JSON.stringify(doc)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const bin = Buffer.concat(chunks), header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8);
jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
const out = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
const file = resolve(import.meta.dirname, '../public/models/noa3d/motions/noa-beckon.vrma');
writeFileSync(file, out);
console.log(`noa-beckon.vrma: ${out.length} bytes, SHA-256 ${createHash('sha256').update(out).digest('hex')}`);
