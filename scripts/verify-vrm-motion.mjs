import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Group, Object3D, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRM, VRMHumanoid, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { VRMSpringBoneJoint, VRMSpringBoneManager, VRMSpringBoneCollider, VRMSpringBoneColliderShapeSphere } from '@pixiv/three-vrm-springbone';
import { PerformanceController, prepareMotionClip } from '../browser/avatar-vrm/performance.mjs';
import { APPROVED_MOTIONS, deriveControls } from '../browser/avatar-vrm/controls.mjs';
import { stabilizeSpringStep } from '../browser/avatar-vrm/spring-step.mjs';
import { configureNoaPhysics } from '../browser/avatar-vrm/physics-fit.mjs';

// Bundle this optional evaluator with the same pinned tools as the browser renderer.
// It extracts the actual model's rig and colliders; it does not replace its meshes.
const root = resolve(process.env.JEV_AVATAR_PROJECT_ROOT || process.cwd());
const assets = resolve(root, 'public/models/noa3d');
const output = resolve(root, 'data/vrm-motion-evaluation.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const degrees = radians => radians * 180 / Math.PI;
const finite = values => values.every(Number.isFinite);
const manifest = JSON.parse(await readFile(resolve(assets, 'manifest.json'), 'utf8'));
const bytes = await readFile(resolve(assets, 'Noa.vrm'));
assert.equal(sha256(bytes), manifest.sha256);
assert.equal(bytes.length, manifest.bytes);
assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
assert.equal(bytes.readUInt32LE(8), bytes.length);
const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)));
assert.equal(doc.extensions.VRM.specVersion, '0.0');
assert.equal(doc.extensions.VRM.meta.version, manifest.version);
const motionManifest = JSON.parse(await readFile(resolve(assets, 'motions/manifest.json'), 'utf8'));
const loader = new GLTFLoader();
loader.register(parser => new VRMAnimationLoaderPlugin(parser));
const animations = {}, motionHashes = {};
for (const [gesture, [filename, hash]] of Object.entries(APPROVED_MOTIONS)) {
    const asset = motionManifest.motions[gesture];
    assert.equal(asset.file, filename);
    assert.equal(asset.sha256, hash);
    assert.equal(asset.license, 'MIT');
    const clipBytes = await readFile(resolve(assets, 'motions', filename));
    assert.equal(clipBytes.length, asset.bytes);
    assert.equal(sha256(clipBytes), hash);
    const loaded = await loader.parseAsync(clipBytes.buffer.slice(clipBytes.byteOffset, clipBytes.byteOffset + clipBytes.byteLength), '');
    assert.ok(loaded.userData.vrmAnimations?.[0]);
    animations[gesture] = loaded.userData.vrmAnimations[0];
    motionHashes[gesture] = { file: filename, sha256: hash };
}

function actualRig() {
    const scene = new Group();
    const nodes = doc.nodes.map(source => {
        const node = new Object3D();
        node.name = source.name || '';
        if (source.matrix) {
            node.matrix.fromArray(source.matrix);
            node.matrix.decompose(node.position, node.quaternion, node.scale);
        } else {
            node.position.fromArray(source.translation || [0, 0, 0]);
            node.quaternion.fromArray(source.rotation || [0, 0, 0, 1]);
            node.scale.fromArray(source.scale || [1, 1, 1]);
        }
        // Spring joints disable matrixAutoUpdate; initialize the exported local TRS first.
        node.updateMatrix();
        return node;
    });
    doc.nodes.forEach((source, index) => (source.children || []).forEach(child => nodes[index].add(nodes[child])));
    for (const index of doc.scenes[doc.scene || 0].nodes) scene.add(nodes[index]);
    const secondary = doc.extensions.VRM.secondaryAnimation;
    const colliderGroups = secondary.colliderGroups.map(source => ({ colliders: source.colliders.map(value => {
        // This is the VRM0 offset convention used by three-vrm's actual loader.
        const collider = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({
            radius: value.radius,
            offset: new Vector3(value.offset?.x || 0, value.offset?.y || 0, -(value.offset?.z || 0)),
        }));
        nodes[source.node].add(collider);
        return collider;
    }) }));
    const manager = new VRMSpringBoneManager(), hair = [];
    for (const source of secondary.boneGroups) for (const rootIndex of source.bones) nodes[rootIndex].traverse(node => {
        const joint = new VRMSpringBoneJoint(node, node.children[0] || null, {
            hitRadius: source.hitRadius, dragForce: source.dragForce, stiffness: source.stiffiness,
            gravityPower: source.gravityPower,
            gravityDir: new Vector3(source.gravityDir.x, source.gravityDir.y, source.gravityDir.z),
        }, source.colliderGroups.map(index => colliderGroups[index]));
        if (source.center != null) joint.center = nodes[source.center];
        manager.addJoint(joint);
        if (source.comment === 'Hair') hair.push(joint);
    });
    scene.updateMatrixWorld(true);
    manager.setInitState();
    const rename = { leftThumbProximal: 'leftThumbMetacarpal', leftThumbIntermediate: 'leftThumbProximal', rightThumbProximal: 'rightThumbMetacarpal', rightThumbIntermediate: 'rightThumbProximal' };
    const humanoid = new VRMHumanoid(Object.fromEntries(doc.extensions.VRM.humanoid.humanBones.map(bone => [rename[bone.bone] || bone.bone, { node: nodes[bone.node] }])));
    scene.add(humanoid.normalizedHumanBonesRoot);
    const vrm = new VRM({ scene, humanoid, meta: { ...doc.extensions.VRM.meta, metaVersion: '0' }, springBoneManager: manager });
    const originalColliders = [...manager.colliders].map(collider => ({ collider, radius: collider.shape.radius, offset: collider.shape.offset.toArray() }));
    const originalJoints = [...manager.joints].map(joint => ({ joint, settings: { ...joint.settings, gravityDir: joint.settings.gravityDir.toArray() } }));
    const physicsAdjustments = configureNoaPhysics(vrm);
    assert.equal(physicsAdjustments.length, 4, 'only the measured side-hair chain receives a restoring force');
    assert.deepEqual(configureNoaPhysics(vrm), [], 'physics fit is idempotent');
    for (const { collider, radius, offset } of originalColliders) {
        assert.equal(collider.shape.radius, radius, 'preserve the authored skin collision radius');
        assert.deepEqual(collider.shape.offset.toArray(), offset, 'preserve the authored collider position');
    }
    for (const { joint, settings } of originalJoints) {
        const current = { ...joint.settings, gravityDir: joint.settings.gravityDir.toArray() };
        if (/^J_Sec_Hair[1-4]_03$/.test(joint.bone.name)) settings.gravityPower = .02;
        assert.deepEqual(current, settings, 'preserve all other authored spring properties');
    }
    VRMUtils.rotateVRM0(vrm);
    const restoreSpringStep = stabilizeSpringStep(manager);
    const clips = Object.fromEntries(Object.entries(animations).map(([gesture, animation]) => [gesture, prepareMotionClip(animation, vrm, gesture)]));
    const performer = new PerformanceController(vrm, clips);
    return { vrm, performer, hair, nodes, physicsAdjustments, dispose() { performer.dispose(); restoreSpringStep(); } };
}

function maxDifference(joints, pose) {
    return Math.max(...joints.map((joint, index) => joint.bone.quaternion.angleTo(pose[index])));
}

function springDiagnostic(joint) {
    const tail = joint.initialLocalChildPosition.clone().applyMatrix4(joint.bone.matrixWorld);
    const origin = joint.bone.getWorldPosition(new Vector3());
    return {
        name: joint.bone.name, parent: joint.bone.parent?.name, origin: origin.toArray(), tail: tail.toArray(),
        boneLength: tail.distanceTo(origin), hitRadius: joint.settings.hitRadius,
        colliders: joint.colliderGroups.flatMap((group, groupIndex) => group.colliders.map((collider, index) => ({
            groupIndex, index, parent: collider.parent?.name,
            center: new Vector3().setFromMatrixPosition(collider.colliderMatrix).toArray(),
            localOffset: collider.shape.offset.toArray(), radius: collider.shape.radius,
            signedDistance: collider.shape.calculateCollision(collider.colliderMatrix, tail, joint.settings.hitRadius, new Vector3()),
        }))).sort((a, b) => a.signedDistance - b.signedDistance),
    };
}

function evaluate(fps, gesture, interrupted) {
    const rig = actualRig(), { vrm, performer, hair, nodes } = rig;
    const dt = 1 / fps, head = vrm.humanoid.getNormalizedBoneNode('head');
    const normalized = Object.values(vrm.humanoid.normalizedHumanBones).map(bone => bone.node);
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    const hipsOrigin = hips.position.clone();
    let steps = 0, peak = 0, maxRootDrift = 0, maxQuaternionError = 0;
    let headBase = null;
    const yawRotation = new Quaternion(), yawAxis = new Vector3(0, 1, 0);
    function removeHeadPose() {
        if (headBase) head.quaternion.copy(headBase);
        headBase = null;
    }
    function step(motion = 0, yaw = 0) {
        removeHeadPose();
        performer.update(dt, motion);
        headBase = head.quaternion.clone();
        head.quaternion.multiply(yawRotation.setFromAxisAngle(yawAxis, yaw)).normalize();
        vrm.update(dt);
        vrm.scene.updateMatrixWorld(true);
        steps++;
        for (const node of [...nodes, ...normalized]) {
            assert.ok(finite(node.quaternion.toArray()) && finite(node.position.toArray()) && finite(node.matrixWorld.elements), `${gesture}: finite transforms`);
            const error = Math.abs(node.quaternion.length() - 1);
            maxQuaternionError = Math.max(maxQuaternionError, error);
            assert.ok(error < 1e-5, `${gesture}: normalized rotations`);
        }
        maxRootDrift = Math.max(maxRootDrift, Math.hypot(hips.position.x - hipsOrigin.x, hips.position.z - hipsOrigin.z));
    }
    try {
        for (let frame = 0; frame < 5 * fps; frame++) step();
        const baseline = hair.map(joint => joint.bone.quaternion.clone());
        const restingBones = normalized.map(bone => ({ rotation: bone.quaternion.clone(), position: bone.position.clone() }));
        const diagnosticJoint = hair.find(joint => joint.bone.name === 'J_Sec_Hair3_03');
        const springBaseline = springDiagnostic(diagnosticJoint);
        let duration;
        if (gesture === 'idle') duration = 2;
        else {
            removeHeadPose();
            performer.perform({ gesture, intensity: .7 });
            duration = interrupted ? performer.duration * .45 : performer.duration + .5;
        }
        for (let frame = 0; frame < Math.ceil(duration * fps); frame++) {
            const yaw = gesture === 'idle' ? deriveControls({ ParamAngleX: 30 * Math.sin(2 * Math.PI * frame / (2 * fps)) }).head[1] : 0;
            step(gesture === 'idle' ? 0 : 1, yaw);
            peak = Math.max(peak, maxDifference(hair, baseline));
        }
        const automaticReturn = gesture === 'idle' || interrupted ? null : performer.gesture === 'idle';
        if (automaticReturn !== null) assert.ok(automaticReturn, `${gesture}: automatic return to idle`);
        removeHeadPose();
        performer.stop();
        for (let frame = 0; frame < 8 * fps; frame++) step();
        const residual = degrees(maxDifference(hair, baseline));
        const poseResidual = degrees(Math.max(...normalized.map((bone, index) => bone.quaternion.angleTo(restingBones[index].rotation))));
        const positionResidual = Math.max(...normalized.map((bone, index) => bone.position.distanceTo(restingBones[index].position)));
        const diagnostics = {
            peakHairDegrees: degrees(peak), eightSecondResidualDegrees: residual,
            humanoidRestRotationResidualDegrees: poseResidual, humanoidRestPositionResidualM: positionResidual,
            spring: { baseline: springBaseline, current: springDiagnostic(diagnosticJoint) },
            hair: hair.map((joint, index) => ({ name: joint.bone.name, residualDegrees: degrees(joint.bone.quaternion.angleTo(baseline[index])), baseline: baseline[index].toArray(), current: joint.bone.quaternion.toArray(), position: joint.bone.position.toArray() })).sort((a, b) => b.residualDegrees - a.residualDegrees),
            humanoid: normalized.map((bone, index) => ({ name: bone.name, residualDegrees: degrees(bone.quaternion.angleTo(restingBones[index].rotation)), positionResidualM: bone.position.distanceTo(restingBones[index].position), baseline: restingBones[index].rotation.toArray(), current: bone.quaternion.toArray(), position: bone.position.toArray() })).sort((a, b) => b.residualDegrees - a.residualDegrees),
        };
        try {
            assert.equal(performer.gesture, 'idle');
            assert.equal(performer.previous, null, 'transition snapshot is released');
            assert.equal(performer.snapshot, null, 'transition clip is released');
            assert.ok(degrees(peak) > .1, `${gesture}: actual hair reaction must be measurable`);
            assert.ok(residual < 1, `${gesture} at ${fps}fps: hair must settle within one degree (${residual})`);
            assert.ok(poseResidual < .01, `${gesture}: humanoid must return to resting rotation (${poseResidual} degrees)`);
            assert.ok(positionResidual < 1e-6, `${gesture}: humanoid must return to resting position (${positionResidual} m)`);
            assert.ok(maxRootDrift < 1e-6, `${gesture}: no horizontal model drift`);
        } catch (error) { error.diagnostics = diagnostics; throw error; }
        return {
            fps, gesture, interrupted, clip: APPROVED_MOTIONS[gesture][0], simulatedFrames: steps,
            physicsAdjustments: rig.physicsAdjustments,
            peakHairDegrees: degrees(peak), eightSecondResidualDegrees: residual,
            humanoidRestRotationResidualDegrees: poseResidual, humanoidRestPositionResidualM: positionResidual,
            maxHorizontalRootDriftM: maxRootDrift, maxQuaternionError, automaticReturn,
        };
    } finally { rig.dispose(); }
}

const runs = [], runtimeSources = {};
for (const source of ['browser/avatar-vrm/performance.mjs', 'browser/avatar-vrm/motion-fit.mjs', 'browser/avatar-vrm/spring-step.mjs', 'browser/avatar-vrm/controls.mjs', 'browser/avatar-vrm/physics-fit.mjs'])
    runtimeSources[source] = sha256(await readFile(resolve(root, source)));
const failures = [];
const expectedRuns = 33;
for (const fps of [30, 60, 120]) for (const gesture of Object.keys(APPROVED_MOTIONS)) {
    for (const interrupted of gesture === 'idle' ? [false] : [false, true]) {
        try {
            const run = evaluate(fps, gesture, interrupted);
            runs.push(run);
            console.log(`${fps} fps ${gesture}${interrupted ? ' interrupted' : ''}: hair ${run.peakHairDegrees.toFixed(2)} deg, residual ${run.eightSecondResidualDegrees.toFixed(6)} deg`);
        } catch (error) {
            failures.push({ fps, gesture, interrupted, error: error.message, diagnostics: error.diagnostics });
            console.error(`${fps} fps ${gesture}${interrupted ? ' interrupted' : ''}: ${error.message}`);
        }
    }
}
const report = {
    version: manifest.version, sha256: manifest.sha256, modelBytes: bytes.length,
    generatedAt: new Date().toISOString(), runtimeSources, motions: motionHashes,
    method: 'Actual VRM hierarchy, humanoid transforms, spring parameters and colliders extracted from the shipped GLB. Actual hash-verified VRMA parsed by the pinned production library, production prepareMotionClip and PerformanceController, production fixed-step spring integrator. No substitute meshes, synthetic clips, browser requests or mocked engine.',
    inputs: 'All six motions at 30/60/120 fps; five-second warm-up, normal completion and 45% interruption, eight-second stopped-idle recovery. Idle head turn uses a +/-30-degree Jev control input mapped by production deriveControls. Idle animation is paused during the recovery measurement so the baseline is stationary.',
    limitations: ['No WebGL rendering or geometry/material clearance evaluation.', 'Facial expressions, real speech synchronization and OBS are not assessed.', 'Rig-only simulation verifies numerical motion, not subjective hair quality or superiority to other VTubers.'],
    passed: failures.length === 0 && runs.length === expectedRuns, completedRuns: runs.length, expectedRuns, runs, failures,
};
await mkdir(resolve(root, 'data'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Motion evaluation: ${runs.length}/${expectedRuns} runs passed; report ${output}`);
assert.equal(report.passed, true, `${failures.length} motion evaluations failed`);
