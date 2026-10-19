import { Scene, WebGLRenderer, OrthographicCamera, HemisphereLight, DirectionalLight, SRGBColorSpace, Euler, Quaternion, Mesh, CircleGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { deriveControls, reactionPlan, clamp, idleBeckonDelay } from './controls.mjs';
import { ExpressionController } from './expressions.mjs';
import { PerformanceController, checkedBytes } from './performance.mjs';
import { stabilizeSpringStep } from './spring-step.mjs';
import { configureNoaPhysics } from './physics-fit.mjs';
import { configureNoaFace, modelHasOwnFace } from './face-fit.mjs';
import { AI_RING_MATERIAL, aiRingIntensity } from './ai-ring.mjs';
import { configureNoaMaterials } from './material-finish.mjs';
import { NoaOutfitController } from './outfits.mjs';
import { noaCloseupFrame } from './framing.mjs';
import { DEFAULT_OUTFIT_ID, isOutfitId } from '../../public/avatar-outfits.mjs';

const RIM = 1.1;

const MODEL = {
    sha256: '4bc7d25e0cb0d218fcc6b8eb4db8becb5ab43fe54c754adfccc0eb229443e2ef',
    bytes: 77008920,
};

function disposeScene(scene) {
    if (!scene) return;
    const images = new Set();
    scene.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (!material) continue;
            for (const value of Object.values(material)) if (value?.isTexture && value.source?.data) images.add(value.source.data);
        }
    });
    VRMUtils.deepDispose(scene);
    for (const image of images) image.close?.();
}

/** A stage-owned renderer: no RAF, audio capture, AI calls or independent blink. */
export class NoaVrmAvatar {
    constructor(canvas, options = {}) {
        if (!canvas) throw new Error('A canvas is required for Noa');
        this.canvas = canvas;
        this.options = options;
        this.outfitId = isOutfitId(options.outfit) ? options.outfit : DEFAULT_OUTFIT_ID;
        this.reducedMotion = options.reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        this.modelUrl = options.modelUrl || '/models/noa3d/Noa.vrm';
        this.motionBaseUrl = (options.motionBaseUrl || '/models/noa3d/motions/').replace(/\/?$/, '/');
        this.ready = false;
        this.disposed = false;
        this.abort = new AbortController();
        this.lastNow = null;
        this.poseBases = new Map();
        this.headWeight = 1;
        this.euler = new Euler(0, 0, 0, 'YXZ');
        this.quaternion = new Quaternion();
        this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(1);
        this.renderer.outputColorSpace = SRGBColorSpace;
        this.renderer.setClearColor(0x000000, 0);
        this.scene = new Scene();
        this.camera = new OrthographicCamera(-1, 1, 1, -1, .01, 20);
        const framing = noaCloseupFrame();
        this.camera.position.set(0, framing.centerY, 3);
        this.camera.lookAt(0, framing.centerY, 0);
        this.scene.add(new HemisphereLight(0xfff7f2, 0x647392, .85));
        this.keyLight = new DirectionalLight(0xfff5ed, 2.0);
        this.keyLight.position.set(-2, 2.5, 4);
        this.scene.add(this.keyLight);
        // Design review (4.91, item 7): a stronger cool rim so the silhouette reads against the night room.
        this.rimLight = new DirectionalLight(0xd5e8ff, RIM);
        this.rimLight.position.set(2, 2, -2);
        this.scene.add(this.rimLight);
        // Contact shadow: two soft ellipses on the floor under the hips. Only framings that include the floor show it
        // (the stage's bust close-up does not).
        this.groundShadow = [[.30, .19, .10], [.22, .14, .22]].map(([x, z, opacity]) => {
            const disc = new Mesh(new CircleGeometry(1, 40), new MeshBasicMaterial({ color: 0x0a0f24, transparent: true, opacity, depthWrite: false }));
            disc.rotation.x = -Math.PI / 2; disc.scale.set(x, z, 1); disc.position.y = .003; disc.renderOrder = -1;
            this.scene.add(disc); return disc;
        });
        this.hipsWorld = new Vector3();
        this.idleSeconds = 0; this.idleBeckons = 0;
        this.contextLost = () => { if (!this.disposed) this.error = new Error('Noa WebGL context lost'); };
        canvas.addEventListener('webglcontextlost', this.contextLost);
    }

    load() {
        if (this.disposed) return Promise.reject(new Error('Noa renderer is disposed'));
        this.loading ||= this.loadModel();
        return this.loading;
    }

    async loadModel() {
        let loadedScene;
        try {
            const signal = this.abort.signal;
            const bytes = await checkedBytes(this.modelUrl, { signal, ...MODEL });
            const loader = new GLTFLoader();
            loader.register(parser => new VRMLoaderPlugin(parser));
            const gltf = await loader.parseAsync(bytes, '');
            loadedScene = gltf.scene;
            signal.throwIfAborted();
            const vrm = gltf.userData.vrm;
            if (!vrm?.humanoid || !vrm.expressionManager) throw new Error('Noa VRM humanoid or expressions are missing');
            this.vrm = vrm;
            // From 4.91 the model carries its own face contour and skin/hair shading (AIRoid_3D refine-face-v491.mjs,
            // refine-reference-v491.mjs); the runtime fits tuned for 4.86-4.90 would narrow the jaw twice.
            const ownFinish = modelHasOwnFace(vrm.meta?.version);
            this.faceFit = ownFinish ? null : configureNoaFace(vrm.scene);
            this.materialFinish = configureNoaMaterials(vrm.scene, ownFinish ? { skip: ['skin', 'hair'] } : undefined);
            // 4.92 enabled skin outlines in the model; on the neck and body skin they draw a dark line across the
            // collarbones (design review 2026-10-03). Only the face keeps its outline (the jaw line).
            if (ownFinish) vrm.scene.traverse(object => { for (const material of [].concat(object.material || [])) if (material?.isMToonMaterial && /^(Noa neck skin|N00_000_00_Body_00_SKIN \(Instance\))( \(Outline\))?$/.test(material.name)) material.outlineWidthFactor = 0; });
            this.aiRings = [];
            vrm.scene.traverse(object => { for (const material of [].concat(object.material || [])) if (AI_RING_MATERIAL.test(material?.name || '') && 'emissiveIntensity' in material && !this.aiRings.includes(material)) this.aiRings.push(material); });
            this.outfits = new NoaOutfitController(vrm.scene);
            this.outfits.setOutfit(this.outfitId);
            this.physicsAdjustments = configureNoaPhysics(vrm);
            this.restoreSpringStep = stabilizeSpringStep(vrm.springBoneManager);
            this.expressions = new ExpressionController(vrm.expressionManager);
            // VRM0 faces -Z; the loader's normalized animation convention remains intact.
            VRMUtils.rotateVRM0(vrm);
            if (vrm.lookAt) { vrm.lookAt.autoUpdate = false; vrm.lookAt.target = undefined; }
            this.performer = await PerformanceController.create(vrm, { baseUrl: this.motionBaseUrl, signal, reducedMotion: this.reducedMotion });
            signal.throwIfAborted();
            this.scene.add(vrm.scene);
            this.head = vrm.humanoid.getNormalizedBoneNode('head');
            this.chest = vrm.humanoid.getNormalizedBoneNode('upperChest') || vrm.humanoid.getNormalizedBoneNode('chest');
            if (!this.head || !this.chest) throw new Error('Noa head or chest bone is missing');
            this.expressions.update(1, deriveControls());
            vrm.update(0);
            this.ready = true;
            this.resize();
            this.renderer.render(this.scene, this.camera);
            return this;
        } catch (error) {
            if (loadedScene && loadedScene !== this.vrm?.scene) disposeScene(loadedScene);
            this.error = error;
            this.dispose();
            throw error;
        }
    }

    removePose() {
        for (const [bone, base] of this.poseBases) bone.quaternion.copy(base);
        this.poseBases.clear();
    }

    setOutfit(id) {
        if (!isOutfitId(id)) throw new TypeError('Unknown Noa outfit');
        if (this.disposed) throw new Error('Noa renderer is disposed');
        this.outfits?.setOutfit(id);
        this.outfitId = id;
        return id;
    }

    addPose(bone, angles, weight) {
        if (!bone || weight <= 0) return;
        this.poseBases.set(bone, bone.quaternion.clone());
        this.euler.set(angles[0] * weight, angles[1] * weight, angles[2] * weight, 'YXZ');
        bone.quaternion.multiply(this.quaternion.setFromEuler(this.euler)).normalize();
    }

    react(name, intensity = 1) {
        if (this.disposed) return;
        this.stopped = false;
        const plan = reactionPlan(name, intensity, { reducedMotion: this.reducedMotion });
        this.directReaction = { name: plan.name, gain: plan.gain, weight: 1 };
        this.removePose();
        this.performer?.perform(plan);
        return plan;
    }

    resume(reaction) {
        if (this.disposed) return;
        this.lastNow = null;
        this.removePose();
        this.performer?.stop();
        this.directReaction = null;
        this.lastReactionKey = reaction && Number.isFinite(reaction.start) ? `${reaction.start}:${reaction.name}` : null;
        this.suppressedReaction = null;
        // Do not replay an old gesture, but keep the current speech mouth live.
        this.stopped = false;
    }

    stop(reaction) {
        if (this.disposed) return;
        this.stopped = true;
        this.removePose();
        this.performer?.stop();
        this.directReaction = null;
        // The stage may cancel before its first draw (or while assets load).
        if (reaction && Number.isFinite(reaction.start)) this.lastReactionKey = `${reaction.start}:${reaction.name}`;
        this.suppressedReaction = this.lastReactionKey;
        // Close residual speech immediately, including on an interrupted sentence.
        if (this.expressions) this.expressions.update(1, deriveControls({}, { role: 'comment' }));
    }

    resize() {
        const width = Math.max(1, this.canvas.width), height = Math.max(1, this.canvas.height);
        if (this.width === width && this.height === height) return;
        const framing = noaCloseupFrame(width / height);
        this.camera.left = framing.left;
        this.camera.right = framing.right;
        this.camera.top = framing.top;
        this.camera.bottom = framing.bottom;
        this.camera.position.set(0, framing.centerY, 3);
        this.camera.lookAt(0, framing.centerY, 0);
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
        this.width = width; this.height = height;
    }

    draw(params, extras = {}) {
        if (this.error) throw this.error;
        if (!this.ready || this.disposed) return;
        const now = Number.isFinite(extras.now) ? extras.now : performance.now();
        const dt = this.lastNow === null ? 1 / 60 : clamp((now - this.lastNow) / 1000, 0, .1);
        this.lastNow = now;
        this.removePose();
        const reaction = extras.reaction;
        const key = reaction && Number.isFinite(reaction.start) ? `${reaction.start}:${reaction.name}` : null;
        if (key && key !== this.lastReactionKey) {
            this.lastReactionKey = key;
            this.suppressedReaction = null;
            this.react(extras.role === 'comment' ? 'listen' : reaction.name, reaction.gain);
        }
        const blocked = key && key === this.suppressedReaction;
        const current = blocked || this.stopped ? null : Object.hasOwn(extras, 'reaction') ? reaction : this.directReaction;
        const controls = deriveControls(params, { ...extras, reaction: current, ...(blocked || this.stopped ? { role: 'comment' } : {}) }, { reducedMotion: this.reducedMotion });
        // Idle beckon: after 40-60 s of uninterrupted host idle, play the design sheet's gesture once. Frame time only;
        // any reaction, the narrator's turn, a stop or reduced motion resets the wait.
        const idle = this.performer.gesture === 'idle' && !current && !this.stopped && extras.role !== 'comment' && !this.reducedMotion && Number.isFinite(params?.ParamMouthForm);
        this.idleSeconds = idle ? this.idleSeconds + dt : 0;
        if (this.idleSeconds >= idleBeckonDelay(this.idleBeckons)) {
            this.idleSeconds = 0; this.idleBeckons++;
            this.performer.perform({ gesture: 'beckon', intensity: .5 });
        }
        this.performer.update(dt, controls.motion);
        // Authored gestures own head and torso. Jev supplies the idle pose only.
        const targetHeadWeight = this.performer.gesture === 'idle' ? 1 : 0;
        this.headWeight += (targetHeadWeight - this.headWeight) * (1 - Math.exp(-dt / .12));
        this.addPose(this.head, controls.head, this.headWeight);
        this.addPose(this.chest, controls.body, this.headWeight);
        if (this.vrm.lookAt) {
            this.vrm.lookAt.yaw = controls.gaze.yaw;
            this.vrm.lookAt.pitch = controls.gaze.pitch;
        }
        this.expressions.update(dt, controls);
        this.vrm.update(dt);
        const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
        if (hips) { hips.getWorldPosition(this.hipsWorld); for (const disc of this.groundShadow) disc.position.set(this.hipsWorld.x, .003, this.hipsWorld.z); }
        this.resize();
        this.rimLight.intensity = extras.rim === false ? 0 : RIM;
        if (this.aiRings?.length) { const glow = aiRingIntensity(extras); for (const material of this.aiRings) material.emissiveIntensity = glow; }
        this.renderer.render(this.scene, this.camera);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.ready = false;
        this.abort.abort();
        this.removePose();
        this.performer?.dispose();
        this.restoreSpringStep?.();
        this.faceFit?.dispose();
        this.faceFit = null;
        this.outfits?.dispose();
        this.outfits = null;
        this.materialFinish?.dispose();
        this.materialFinish = null;
        if (this.vrm) { this.scene.remove(this.vrm.scene); disposeScene(this.vrm.scene); this.vrm = null; }
        this.canvas.removeEventListener('webglcontextlost', this.contextLost);
        for (const disc of this.groundShadow || []) { disc.geometry.dispose(); disc.material.dispose(); }
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.scene.clear();
    }
}
