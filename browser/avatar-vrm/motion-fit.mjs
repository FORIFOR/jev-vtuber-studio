import { AnimationMixer, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three';

// Noa 4.86's measured garment clearance, ported from AIRoid's verified clips.
export function fitIdleSleeves(clip, humanoid) {
    const axis = new Vector3(0, 0, 1), q = new Quaternion();
    for (const [name, angle] of [['leftUpperArm', -.06], ['rightUpperArm', .06]]) {
        const bone = humanoid.getNormalizedBoneNode(name);
        const track = bone && clip.tracks.find(t => t.name === `${bone.name}.quaternion` || t.name === `${bone.uuid}.quaternion`);
        if (!track || track.getValueSize() !== 4) throw new Error(`Missing idle arm rotation: ${name}`);
        const offset = new Quaternion().setFromAxisAngle(axis, angle);
        for (let i = 0; i < track.values.length; i += 4) q.fromArray(track.values, i).premultiply(offset).normalize().toArray(track.values, i);
    }
}

export function fitLowHands(clip, vrm) {
    const humanoid = vrm.humanoid, hips = humanoid.getNormalizedBoneNode('hips');
    const bones = ['left', 'right'].map(side => ({
        side, arm: humanoid.getNormalizedBoneNode(`${side}UpperArm`),
        hand: humanoid.getNormalizedBoneNode(`${side}Hand`), times: [], values: [],
    }));
    if (!hips || bones.some(b => !b.arm || !b.hand)) throw new Error('Missing gesture-fit bones');
    const mixer = new AnimationMixer(vrm.scene), action = mixer.clipAction(clip).play();
    const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
    const axis = new Vector3(0, 0, 1), offset = new Quaternion(), position = new Vector3();
    const frames = Math.ceil(clip.duration * 60);
    try {
        for (let frame = 0; frame <= frames; frame++) {
            const time = Math.min(frame / 60, clip.duration);
            action.time = Math.min(time, Math.max(0, clip.duration - 1e-7));
            mixer.update(0);
            vrm.scene.updateMatrixWorld(true);
            for (const bone of bones) {
                const p = hips.worldToLocal(bone.hand.getWorldPosition(position));
                const low = smooth((.04 - p.y) / .07);
                const beside = 1 - smooth((Math.abs(p.z) - .10) / .07);
                const deficit = Math.max(0, .175 - Math.abs(p.x));
                const angle = Math.min(.085, deficit / .46) * low * beside;
                offset.setFromAxisAngle(axis, bone.side === 'left' ? -angle : angle);
                const q = bone.arm.quaternion.clone().premultiply(offset).normalize();
                bone.times.push(time);
                q.toArray(bone.values, bone.values.length);
            }
        }
    } finally {
        mixer.stopAllAction();
        mixer.uncacheRoot(vrm.scene);
    }
    for (const bone of bones) {
        const index = clip.tracks.findIndex(t => t.name === `${bone.arm.name}.quaternion` || t.name === `${bone.arm.uuid}.quaternion`);
        if (index < 0) throw new Error(`Missing gesture arm track: ${bone.side}`);
        clip.tracks[index] = new QuaternionKeyframeTrack(clip.tracks[index].name, bone.times, bone.values);
    }
}
