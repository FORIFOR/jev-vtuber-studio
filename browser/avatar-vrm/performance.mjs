import { AnimationMixer, AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, LoopOnce, LoopRepeat } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { APPROVED_MOTIONS, clamp } from './controls.mjs';
import { fitIdleSleeves, fitLowHands } from './motion-fit.mjs';

const FADE = .4;

export function prepareMotionClip(animation, vrm, gesture) {
    if (!Object.hasOwn(APPROVED_MOTIONS, gesture)) throw new Error(`Unapproved gesture: ${gesture}`);
    const bones = Object.values(vrm.humanoid.normalizedHumanBones).map(bone => bone.node);
    const paths = new Set(bones.flatMap(bone => [bone.name, bone.uuid].flatMap(id => [`${id}.position`, `${id}.quaternion`])));
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) throw new Error('Missing hips bone');
    const clip = createVRMAnimationClip(animation, vrm);
    clip.name = gesture;
    // Motion clips own bones only. Expressions and gaze belong to Jev.
    clip.tracks = clip.tracks.filter(track => paths.has(track.name));
    if (!clip.tracks.length || !Number.isFinite(clip.duration) || clip.duration <= 0) throw new Error(`Empty motion: ${gesture}`);
    for (const track of clip.tracks) {
        if (track.name !== `${hips.name}.position` && track.name !== `${hips.uuid}.position`) continue;
        const initialY = track.values[1];
        for (let i = 0; i < track.values.length; i += 3) {
            track.values[i] = hips.position.x;
            track.values[i + 1] = hips.position.y + track.values[i + 1] - initialY;
            track.values[i + 2] = hips.position.z;
        }
    }
    if (gesture === 'idle') {
        fitIdleSleeves(clip, vrm.humanoid);
        for (const name of ['head', 'neck']) {
            const bone = vrm.humanoid.getNormalizedBoneNode(name);
            if (!bone) continue;
            const rest = vrm.humanoid.normalizedRestPose[name]?.rotation || bone.quaternion.toArray();
            clip.tracks = clip.tracks.filter(track => track.name !== `${bone.name}.quaternion` && track.name !== `${bone.uuid}.quaternion`);
            // A constant track is necessary: an absent binding can retain the last
            // gesture when its transition snapshot expires. Jev adds pose after this.
            clip.tracks.push(new QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, clip.duration], [...rest, ...rest]));
        }
    } else fitLowHands(clip, vrm);
    return clip;
}

export async function checkedBytes(url, { signal, sha256, bytes } = {}) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${url}`);
    const data = await response.arrayBuffer();
    if (bytes !== undefined && data.byteLength !== bytes) throw new Error(`Asset size mismatch: ${url}`);
    if (sha256) {
        const digest = await crypto.subtle.digest('SHA-256', data);
        const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
        if (hash !== sha256) throw new Error(`Asset integrity mismatch: ${url}`);
    }
    signal?.throwIfAborted();
    return data;
}

export class PerformanceController {
    static async create(vrm, { baseUrl, signal, reducedMotion = false }) {
        const response = await fetch(`${baseUrl}manifest.json`, { signal });
        if (!response.ok) throw new Error('Motion manifest download failed');
        const manifest = await response.json();
        const loader = new GLTFLoader();
        loader.register(parser => new VRMAnimationLoaderPlugin(parser));
        const clips = {};
        for (const [gesture, [filename, sha256]] of Object.entries(APPROVED_MOTIONS)) {
            const asset = manifest.motions?.[gesture];
            if (asset?.license !== 'MIT' || asset.file !== filename || asset.sha256 !== sha256) throw new Error(`Unapproved motion: ${gesture}`);
            const bytes = await checkedBytes(`${baseUrl}${filename}`, { signal, sha256, bytes: asset.bytes });
            const gltf = await loader.parseAsync(bytes, '');
            signal?.throwIfAborted();
            const animation = gltf.userData.vrmAnimations?.[0];
            if (!animation) throw new Error(`Missing VRMA animation: ${filename}`);
            clips[gesture] = prepareMotionClip(animation, vrm, gesture);
        }
        signal?.throwIfAborted();
        return new PerformanceController(vrm, clips, { reducedMotion });
    }

    constructor(vrm, clips, { reducedMotion = false } = {}) {
        this.vrm = vrm;
        this.clips = clips;
        this.bones = Object.values(vrm.humanoid.normalizedHumanBones).map(bone => bone.node);
        this.mixer = new AnimationMixer(vrm.scene);
        this.reducedMotion = reducedMotion;
        this.gesture = 'idle';
        this.elapsed = 0;
        this.action = this.mixer.clipAction(clips.idle).setLoop(LoopRepeat, Infinity).play();
        this.action.paused = reducedMotion;
        this.mixer.update(0);
    }

    transition(gesture, intensity = .7) {
        if (!this.clips[gesture]) throw new Error(`Unregistered motion: ${gesture}`);
        const pose = this.bones.map(bone => ({ rotation: bone.quaternion.toArray(), position: bone.position.toArray() }));
        this.mixer.stopAllAction();
        if (this.snapshot) this.mixer.uncacheClip(this.snapshot);
        const tracks = this.bones.flatMap((bone, i) => [
            new QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0, FADE], [...pose[i].rotation, ...pose[i].rotation]),
            new VectorKeyframeTrack(`${bone.name}.position`, [0, FADE], [...pose[i].position, ...pose[i].position]),
        ]);
        this.snapshot = new AnimationClip('Noa transition', FADE, tracks);
        this.previous = this.mixer.clipAction(this.snapshot);
        this.previous.setLoop(LoopOnce, 1);
        this.previous.clampWhenFinished = true;
        this.previous.play().fadeOut(FADE);
        const speed = .85 + .3 * clamp(intensity, .2, 1, .7);
        this.action = this.mixer.clipAction(this.clips[gesture]).reset();
        this.action.setLoop(gesture === 'idle' ? LoopRepeat : LoopOnce, gesture === 'idle' ? Infinity : 1);
        this.action.clampWhenFinished = true;
        this.action.setEffectiveTimeScale(speed).setEffectiveWeight(1).play().fadeIn(FADE);
        this.action.paused = gesture === 'idle' && this.reducedMotion;
        this.duration = this.clips[gesture].duration / speed;
        this.elapsed = 0;
        this.transitionTime = 0;
        this.gesture = gesture;
        this.mixer.update(0);
    }

    perform(plan) { this.transition(this.reducedMotion ? 'idle' : plan.gesture, plan.intensity); }
    stop() { this.transition('idle'); }

    update(dt, motion = 1) {
        this.action.paused = this.gesture === 'idle' && (this.reducedMotion || motion <= 0);
        this.mixer.update(dt);
        this.transitionTime = (this.transitionTime || 0) + dt;
        if (this.previous && this.transitionTime >= FADE) {
            this.previous.stop();
            this.mixer.uncacheClip(this.snapshot);
            this.previous = this.snapshot = null;
        }
        this.elapsed += dt;
        if (this.gesture !== 'idle' && this.elapsed >= this.duration) this.transition('idle');
    }

    dispose() {
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.vrm.scene);
        this.previous = this.snapshot = null;
    }
}
