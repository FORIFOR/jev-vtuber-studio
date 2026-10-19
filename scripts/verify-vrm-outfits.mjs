import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BackSide, Bone, BufferAttribute, BufferGeometry, Color, Group, Matrix4, Mesh, PropertyBinding, Skeleton, SkinnedMesh } from 'three';
import { MToonMaterial } from '@pixiv/three-vrm';
import { DEFAULT_OUTFIT_ID, OUTFITS } from '../public/avatar-outfits.mjs';
import { HOOD_PART_NAMES, NoaOutfitController, OUTFIT_MATERIAL_COLORS } from '../browser/avatar-vrm/outfits.mjs';

const root = resolve(process.env.JEV_AVATAR_PROJECT_ROOT || process.cwd());
const asset = resolve(root, 'public/models/noa3d');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(resolve(asset, 'manifest.json'), 'utf8'));
const bytes = await readFile(resolve(asset, 'Noa.vrm'));
assert.equal(hash(bytes), manifest.sha256);
assert.equal(bytes.length, manifest.bytes);
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
assert.equal(bytes.readUInt32LE(8), bytes.length);
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const binary = bytes.subarray(28 + jsonLength);
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const readers = { 5121: ['readUInt8', Uint8Array, 1], 5123: ['readUInt16LE', Uint16Array, 2], 5125: ['readUInt32LE', Uint32Array, 4], 5126: ['readFloatLE', Float32Array, 4] };
const attributes = new Map();

function attribute(index) {
    if (attributes.has(index)) return attributes.get(index);
    const accessor = doc.accessors[index], view = doc.bufferViews[accessor.bufferView];
    assert.ok(!accessor.sparse, 'read the authored non-sparse buffer without substituting values');
    const width = components[accessor.type], [reader, Type, size] = readers[accessor.componentType];
    const values = new Type(accessor.count * width);
    for (let row = 0; row < accessor.count; row++) for (let col = 0; col < width; col++)
        values[row * width + col] = binary[reader]((view.byteOffset || 0) + (accessor.byteOffset || 0) + row * (view.byteStride || width * size) + col * size);
    const result = new BufferAttribute(values, width, accessor.normalized || false);
    attributes.set(index, result);
    return result;
}

// Reconstruct the shipped surfaces, rig and MToon color parameters, not test stand-ins.
// Textures are not decoded: this evaluator checks mutations, not rendered color accuracy.
const materials = doc.materials.map((source, index) => {
    const parameters = doc.extensions.VRM.materialProperties[index];
    assert.equal(parameters.shader, 'VRM/MToon');
    const material = new MToonMaterial();
    material.name = source.name;
    // VRMMaterialsV0CompatPlugin uses a 2.2 EOTF for Unity's VRM0 factors.
    material.color.fromArray(parameters.vectorProperties._Color.slice(0, 3).map(value => value ** 2.2));
    material.shadeColorFactor.fromArray(parameters.vectorProperties._ShadeColor.slice(0, 3).map(value => value ** 2.2));
    material.opacity = parameters.vectorProperties._Color[3];
    return material;
});
const jointIndices = new Set(doc.skins.flatMap(skin => skin.joints));
const nodes = doc.nodes.map((source, index) => {
    const node = jointIndices.has(index) ? new Bone() : new Group();
    node.name = PropertyBinding.sanitizeNodeName(source.name || '');
    node.userData.name = source.name;
    if (source.matrix) {
        node.matrix.fromArray(source.matrix);
        node.matrix.decompose(node.position, node.quaternion, node.scale);
    } else {
        node.position.fromArray(source.translation || [0, 0, 0]);
        node.quaternion.fromArray(source.rotation || [0, 0, 0, 1]);
        node.scale.fromArray(source.scale || [1, 1, 1]);
    }
    node.updateMatrix();
    return node;
});
doc.nodes.forEach((source, index) => (source.children || []).forEach(child => nodes[index].add(nodes[child])));
const scene = new Group();
for (const index of doc.scenes[doc.scene || 0].nodes) scene.add(nodes[index]);
scene.updateMatrixWorld(true);
const skeletons = doc.skins.map(skin => {
    const inverse = attribute(skin.inverseBindMatrices).array;
    return new Skeleton(skin.joints.map(index => nodes[index]), skin.joints.map((_, index) => new Matrix4().fromArray(inverse, index * 16)));
});
const meshes = [], allMaterials = new Set(materials);
const attributeNames = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', JOINTS_0: 'skinIndex', WEIGHTS_0: 'skinWeight' };
doc.nodes.forEach((source, index) => {
    if (source.mesh == null) return;
    const meshDefinition = doc.meshes[source.mesh];
    for (const [primitiveIndex, primitive] of meshDefinition.primitives.entries()) {
        const geometry = new BufferGeometry();
        for (const [name, accessor] of Object.entries(primitive.attributes))
            geometry.setAttribute(attributeNames[name] || name, attribute(accessor));
        if (primitive.indices != null) geometry.setIndex(attribute(primitive.indices));
        for (const target of primitive.targets || []) for (const [name, accessor] of Object.entries(target)) {
            const key = attributeNames[name] || name;
            (geometry.morphAttributes[key] ||= []).push(attribute(accessor));
        }
        geometry.morphTargetsRelative = true;
        const material = materials[primitive.material];
        const outline = material.clone();
        outline.name += ' (Outline)';
        outline.isOutline = true;
        outline.side = BackSide;
        allMaterials.add(outline);
        const mesh = source.skin == null ? new Mesh(geometry, [material, outline]) : new SkinnedMesh(geometry, [material, outline]);
        mesh.name = `${nodes[index].name}_${primitiveIndex}`;
        nodes[index].add(mesh);
        if (source.skin != null) mesh.bind(skeletons[source.skin], nodes[index].matrixWorld);
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences = [...(source.weights || meshDefinition.weights || mesh.morphTargetInfluences)];
        meshes.push(mesh);
    }
});
scene.updateMatrixWorld(true);

const colors = () => [...allMaterials].map(material => ({ color: material.color.toArray(), shade: material.shadeColorFactor.toArray(), opacity: material.opacity }));
const shape = () => JSON.stringify({
    nodes: nodes.map(node => ({ position: node.position.toArray(), rotation: node.quaternion.toArray(), scale: node.scale.toArray(), children: node.children.map(child => child.uuid) })),
    meshes: meshes.map(mesh => ({ geometry: mesh.geometry.uuid, material: mesh.material.map(material => material.uuid), skeleton: mesh.skeleton?.uuid, morphs: mesh.morphTargetInfluences })),
    skeletons: skeletons.map(skeleton => ({ bones: skeleton.bones.map(bone => bone.uuid), inverses: skeleton.boneInverses.map(matrix => matrix.toArray()) })),
});
const geometryHash = () => {
    const digest = createHash('sha256');
    for (const buffer of attributes.values()) digest.update(Buffer.from(buffer.array.buffer, buffer.array.byteOffset, buffer.array.byteLength));
    return digest.digest('hex');
};
const baselineColors = colors(), baselineShape = shape(), baselineGeometry = geometryHash();
const baselineVisibility = nodes.map(node => node.visible);
const outfit = new NoaOutfitController(scene);
const hoodIndices = new Set(HOOD_PART_NAMES.map(name => doc.nodes.findIndex(node => node.name === name)));
const allMaterialList = [...allMaterials];
let switches = 0;
for (let cycle = 0; cycle < 100; cycle++) for (const choice of OUTFITS) {
    assert.equal(outfit.setOutfit(choice.id), choice.id);
    assert.equal(outfit.outfitId, choice.id);
    switches++;
    for (const [index, node] of nodes.entries())
        assert.equal(node.visible, hoodIndices.has(index) ? choice.id !== 'studio-jacket' : baselineVisibility[index]);
    const currentColors = colors();
    for (const [index, material] of allMaterialList.entries()) {
        const name = material.name.replace(/ \(Outline\)$/, '');
        const next = OUTFIT_MATERIAL_COLORS[choice.id][name];
        if (next) {
            const expected = new Color(next);
            assert.deepEqual(material.color.toArray(), expected.toArray(), `${choice.id}: ${material.name}`);
            for (const [channelIndex, channel] of ['r', 'g', 'b'].entries()) {
                const base = baselineColors[index].color[channelIndex], shade = baselineColors[index].shade[channelIndex];
                assert.equal(material.shadeColorFactor[channel], Math.min(1, expected[channel] * (base > 0 ? shade / base : 1)));
            }
        } else assert.deepEqual(currentColors[index], baselineColors[index], `${material.name}: untouched outside garment palette`);
    }
    assert.equal(shape(), baselineShape, 'switching does not replace or modify geometry, transforms, skeleton, morphs or material objects');
    const beforeRejected = colors(), beforeVisibility = nodes.map(node => node.visible);
    assert.throws(() => outfit.setOutfit('unapproved-outfit'), /Unknown Noa outfit/);
    assert.deepEqual(colors(), beforeRejected);
    assert.deepEqual(nodes.map(node => node.visible), beforeVisibility);
}
outfit.setOutfit(DEFAULT_OUTFIT_ID);
assert.deepEqual(colors(), baselineColors);
assert.deepEqual(nodes.map(node => node.visible), baselineVisibility);
assert.equal(geometryHash(), baselineGeometry, 'all actual vertex/index/morph buffers are bitwise unchanged');
outfit.setOutfit('studio-jacket');
outfit.dispose();
outfit.dispose();
assert.deepEqual(colors(), baselineColors, 'dispose restores original material colors');
assert.deepEqual(nodes.map(node => node.visible), baselineVisibility, 'dispose restores original visibility');
assert.throws(() => outfit.setOutfit(DEFAULT_OUTFIT_ID), /disposed/);

const runtimeSources = {};
for (const path of ['public/avatar-outfits.mjs', 'browser/avatar-vrm/outfits.mjs']) runtimeSources[path] = hash(await readFile(resolve(root, path)));
const report = {
    passed: true, modelSha256: manifest.sha256, modelVersion: manifest.version, generatedAt: new Date().toISOString(), runtimeSources,
    method: 'Actual shipped GLB accessors, original node hierarchy, skin inverse matrices and morphs extracted into Three BufferGeometry, Skeleton, SkinnedMesh and MToonMaterial; production NoaOutfitController. MToon outline clones use the production loader naming convention. No substitute geometry or mocked methods.',
    switches, outfits: OUTFITS.map(choice => choice.id), meshes: meshes.length, materialInstances: allMaterials.size, geometryAccessorCount: attributes.size,
    checks: ['300 switches including exact restoration', 'outline clone colors and shade ratios', 'all non-garment materials unchanged', 'all node transforms, skin bindings and morph values unchanged', 'all actual geometry/index/morph buffers bitwise unchanged', 'only 14 hood nodes hidden for studio-jacket', 'unknown outfit rejected without mutation', 'idempotent dispose restores originals'],
    limitations: ['Textures are not decoded and WebGL is not initialized.', 'This tests the controller against extracted real assets, not the entire browser GLTF loader.', 'No browser UI, OBS, speech synchronization or animated garment clearance evaluation.'],
};
await mkdir(resolve(root, 'data'), { recursive: true });
await writeFile(resolve(root, 'data/vrm-outfit-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
for (const mesh of meshes) mesh.geometry.dispose();
for (const material of allMaterials) material.dispose();
