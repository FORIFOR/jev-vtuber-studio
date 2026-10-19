// Coordinates are the shipped VRM0 bind-pose coordinates, before rotateVRM0.
// Eyes start at y=1.3872; the neck seam is behind z=-0.0295.
export const NOA_FACE_FIT = Object.freeze({
    chinY: 1.324, upperY: 1.385, frontZ: -.060, seamZ: -.031,
    length: .012, taper: .08,
});

/** From 4.91 the model's own contour replaces this fit (AIRoid_3D refine-face-v491.mjs). */
export const modelHasOwnFace = version => /^4\.(9[1-9]|\d{3,})\.|^([5-9]|\d{2,})\./.test(String(version || ''));

const activeFits = new WeakMap();
const sameAttributes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

// The final five components describe the upper-triangular deformation Jacobian.
function sample(x, y, z, out) {
    const fit = NOA_FACE_FIT;
    const ty = Math.max(0, Math.min(1, (y - fit.chinY) / (fit.upperY - fit.chinY)));
    const tz = Math.max(0, Math.min(1, (z - fit.frontZ) / (fit.seamZ - fit.frontZ)));
    const wy = 1 - ty * ty * (3 - 2 * ty), wz = 1 - tz * tz * (3 - 2 * tz);
    const weight = wy * wz;
    const dy = -6 * ty * (1 - ty) / (fit.upperY - fit.chinY) * wz;
    const dz = -6 * tz * (1 - tz) / (fit.seamZ - fit.frontZ) * wy;
    out[0] = x * (1 - fit.taper * weight);
    out[1] = y - fit.length * weight;
    out[2] = z;
    out[3] = 1 - fit.taper * weight;
    out[4] = -fit.taper * x * dy;
    out[5] = -fit.taper * x * dz;
    out[6] = 1 - fit.length * dy;
    out[7] = -fit.length * dz;
    return weight > 0;
}

function normal(nx, ny, nz, field, out) {
    // Solve J^T n' = n, then normalize. det(J) >= 0.92 throughout this fit.
    const x = nx / field[3];
    const y = (ny - field[4] * x) / field[6];
    const z = nz - field[5] * x - field[7] * y;
    const length = Math.hypot(x, y, z) || 1;
    out[0] = x / length; out[1] = y / length; out[2] = z / length;
}

function transform(source) {
    const { position, normals, morphPositions, morphNormals } = source;
    const result = {
        position: position.clone(), normals: normals.clone(),
        morphPositions: morphPositions.map(attribute => attribute.clone()),
        morphNormals: morphNormals.map(attribute => attribute.clone()),
        adjusted: 0,
    };
    const base = new Float64Array(8), endpoint = new Float64Array(8);
    const baseNormal = new Float64Array(3), endpointNormal = new Float64Array(3);
    for (let index = 0; index < position.count; index++) {
        const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
        const nx = normals.getX(index), ny = normals.getY(index), nz = normals.getZ(index);
        const changed = sample(x, y, z, base);
        baseNormal[0] = nx; baseNormal[1] = ny; baseNormal[2] = nz;
        if (changed) {
            result.adjusted++;
            result.position.setXYZ(index, base[0], base[1], base[2]);
            normal(nx, ny, nz, base, baseNormal);
            result.normals.setXYZ(index, ...baseNormal);
        }
        for (let target = 0; target < morphPositions.length; target++) {
            const delta = morphPositions[target], deltaNormal = morphNormals[target];
            const dx = delta.getX(index), dy = delta.getY(index), dz = delta.getZ(index);
            const endpointChanged = sample(x + dx, y + dy, z + dz, endpoint);
            if (!changed && !endpointChanged) continue;
            // glTF stores relative deltas, not absolute target coordinates.
            result.morphPositions[target].setXYZ(index,
                endpoint[0] - base[0], endpoint[1] - base[1], endpoint[2] - base[2]);
            endpointNormal[0] = nx + deltaNormal.getX(index);
            endpointNormal[1] = ny + deltaNormal.getY(index);
            endpointNormal[2] = nz + deltaNormal.getZ(index);
            if (endpointChanged) normal(...endpointNormal, endpoint, endpointNormal);
            result.morphNormals[target].setXYZ(index,
                endpointNormal[0] - baseNormal[0], endpointNormal[1] - baseNormal[1], endpointNormal[2] - baseNormal[2]);
        }
    }
    for (const attribute of [result.position, result.normals, ...result.morphPositions, ...result.morphNormals]) attribute.needsUpdate = true;
    return result;
}

/** Fit the loaded face once; retain original attributes for exact restoration. */
export function configureNoaFace(scene) {
    if (activeFits.has(scene)) return activeFits.get(scene);
    let face;
    scene.traverse(object => {
        if ((object.userData?.name || object.name) !== 'Face') return;
        if (face) throw new Error('Duplicate Noa face node');
        face = object;
    });
    if (!face) throw new Error('Noa face node is missing');
    const originals = new Map(), sets = [];
    face.traverse(mesh => {
        if (!mesh.isSkinnedMesh || originals.has(mesh.geometry)) return;
        const geometry = mesh.geometry;
        const source = {
            position: geometry.getAttribute('position'), normals: geometry.getAttribute('normal'),
            morphPositions: geometry.morphAttributes.position || [], morphNormals: geometry.morphAttributes.normal || [],
        };
        if (!geometry.morphTargetsRelative || !source.position || !source.normals
            || source.morphPositions.length !== 57 || source.morphNormals.length !== 57
            || [source.normals, ...source.morphPositions, ...source.morphNormals].some(attribute => attribute.count !== source.position.count))
            throw new Error('Noa face attributes do not match the authored relative morph layout');
        // Teeth share morph accessors with the face but have different base positions.
        // Their transformed deltas must therefore get a separate attribute set.
        let set = sets.find(candidate => candidate.source.position === source.position && candidate.source.normals === source.normals
            && sameAttributes(candidate.source.morphPositions, source.morphPositions)
            && sameAttributes(candidate.source.morphNormals, source.morphNormals));
        if (!set) { set = { source }; sets.push(set); }
        originals.set(geometry, { ...source, set, box: geometry.boundingBox, sphere: geometry.boundingSphere });
    });
    if (!originals.size) throw new Error('Noa skinned face surfaces are missing');
    // Validate and calculate every set before changing any loaded geometry.
    for (const set of sets) set.result = transform(set.source);
    for (const [geometry, { set }] of originals) {
        // Invalidate any prior GPU buffers and morph texture before changing attrs.
        geometry.dispose();
        geometry.setAttribute('position', set.result.position);
        geometry.setAttribute('normal', set.result.normals);
        geometry.morphAttributes.position = set.result.morphPositions;
        geometry.morphAttributes.normal = set.result.morphNormals;
        geometry.boundingBox = null; geometry.boundingSphere = null;
        geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    }
    const fit = {
        geometries: originals.size, attributeSets: sets.length,
        adjustedVertices: sets.reduce((sum, set) => sum + set.result.adjusted, 0),
        dispose() {
            for (const [geometry, source] of originals) {
                geometry.dispose();
                geometry.setAttribute('position', source.position);
                geometry.setAttribute('normal', source.normals);
                geometry.morphAttributes.position = source.morphPositions;
                geometry.morphAttributes.normal = source.morphNormals;
                geometry.boundingBox = source.box; geometry.boundingSphere = source.sphere;
            }
            originals.clear(); sets.length = 0;
            if (activeFits.get(scene) === fit) activeFits.delete(scene);
        },
    };
    activeFits.set(scene, fit);
    return fit;
}
