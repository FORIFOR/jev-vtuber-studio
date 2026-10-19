import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the production stage lifecycle without opening a GPU context. The
// only substitutes are DOM surfaces and deferred asset/WebGL loader boundaries;
// this is not a rendering, texture-memory or live-audio verification.
const stage = readFileSync(new URL('../public/stage.mjs', import.meta.url), 'utf8');
const lifecycle = stage.slice(stage.indexOf('function showAvatar('), stage.indexOf('function applyAvatarMode('))
    .replace("await import('./noa-vrm-avatar.mjs')", 'await loadAvatarModule()');
function deferred() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function harness() {
    const elements = new Map(), models = [], moduleLoads = [], modelLoads = [], layerLoads = [];
    const element = id => ({
        id, hidden: false, dataset: {}, listeners: new Map(),
        addEventListener(name, handler) { this.listeners.set(name, handler); },
        removeEventListener(name) { this.listeners.delete(name); },
        cloneNode() { return element(id); },
        replaceWith(next) { elements.set(id, next); },
    });
    const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    class NoaVrmAvatar {
        constructor(canvas) { this.canvas = canvas; this.ready = false; this.disposed = false; this.disposeCalls = 0; models.push(this); }
        async load() { await (modelLoads.shift()?.promise || Promise.resolve()); this.ready = true; return this; }
        setOutfit(outfit) { this.outfit = outfit; }
        resume() { this.resumed = true; }
        dispose() { this.disposeCalls++; this.disposed = true; this.ready = false; }
    }
    class NoaAvatarV4 {
        async load() { await (layerLoads.shift()?.promise || Promise.resolve()); this.ready = true; return this; }
        resume() { this.resumed = true; }
    }
    const context = vm.createContext({
        $, console: { error() {} }, document: { body: { classList: { toggle() {} } } },
        params: new URLSearchParams(), NoaAvatarV4, LayerAvatar: NoaAvatarV4,
        loadAvatarModule: async () => { await (moduleLoads.shift()?.promise || Promise.resolve()); return { NoaVrmAvatar }; },
    });
    vm.runInContext(`
        let avatarMode = 'builtin', requestedAvatarMode = 'noa';
        let layerAvatar = null, vrmAvatar = null, stageDisposed = false;
        let layerLoading = null, vrmLoading = null, avatarEpoch = 0, vrmLoadEpoch = 0, fallbackEpoch = -1;
        let avatarSelectionStarted = false, retiredVrmCanvas = false;
        const canvas = $('canvas'), reducedMotion = false, outfitId = 'midnight-hoodie', avatar = { reaction: null };
        let vrmCanvas = $('noa-vrm');
        function onVrmContextLost() {}
        ${lifecycle}
    `, context);
    return {
        context, models, moduleLoads, modelLoads, layerLoads,
        select: mode => context.selectAvatarMode(mode),
        state: () => vm.runInContext('({avatarMode, requestedAvatarMode, state: canvas.dataset.avatarState, vrmAvatar, vrmLoading, retiredVrmCanvas})', context),
    };
}

test('successful 3D to 2D replacement releases the VRM only after the 2D asset is ready', async () => {
    const h = harness();
    await h.select('vrm');
    const model = h.models[0], load = deferred(); h.layerLoads.push(load);
    const switching = h.select('noa');
    await flush();
    assert.equal(h.state().avatarMode, 'vrm');
    assert.equal(model.disposeCalls, 0, 'a working image remains visible while 2D loads');
    load.resolve(); await switching;
    assert.equal(h.state().avatarMode, 'noa');
    assert.equal(model.disposeCalls, 1);
    assert.equal(h.state().vrmAvatar, null);
    assert.equal(h.state().vrmLoading, null);
    assert.equal(h.state().retiredVrmCanvas, true);
    await h.select('vrm');
    assert.equal(h.models.length, 2, 'returning to 3D creates a fresh, valid renderer');
    assert.equal(h.models[1].outfit, 'midnight-hoodie');
    assert.equal(h.models[1].resumed, true);
});

test('failed 2D replacement keeps the working 3D renderer available', async () => {
    const h = harness(); await h.select('vrm');
    const load = deferred(); h.layerLoads.push(load);
    const switching = h.select('noa');
    load.reject(new Error('Missing 2D image')); await switching;
    assert.equal(h.state().avatarMode, 'vrm');
    assert.equal(h.state().state, 'fallback');
    assert.equal(h.models[0].disposeCalls, 0);
});

test('switching to SVG, PNG or external composition also releases 3D resources', async () => {
    for (const mode of ['builtin', 'png', 'external']) {
        const h = harness(); await h.select('vrm'); await h.select(mode);
        assert.equal(h.state().avatarMode, mode);
        assert.equal(h.models[0].disposeCalls, 1);
        assert.equal(h.state().vrmAvatar, null);
    }
});

test('a cancelled module import allocates no VRM after another avatar was selected', async () => {
    const h = harness(), importing = deferred(); h.moduleLoads.push(importing);
    const abandoned = h.select('vrm');
    await h.select('noa');
    importing.resolve(); await abandoned;
    assert.equal(h.state().avatarMode, 'noa');
    assert.equal(h.models.length, 0);
    assert.equal(h.state().vrmLoading, null);
});

test('cancelled model loading releases once and cannot retire or replace a later 3D attempt', async () => {
    const h = harness(), downloading = deferred(); h.modelLoads.push(downloading);
    const abandoned = h.select('vrm'); await flush();
    assert.equal(h.models.length, 1);
    await h.select('noa');
    assert.equal(h.models[0].disposeCalls, 1);
    await h.select('vrm');
    const fresh = h.models[1];
    downloading.resolve(); await abandoned;
    assert.equal(h.state().avatarMode, 'vrm');
    assert.equal(h.state().vrmAvatar, fresh);
    assert.equal(fresh.disposeCalls, 0);
    assert.equal(h.models[0].disposeCalls, 1);
    assert.equal(h.state().vrmLoading, null);
});

test('a delayed stale import cannot allocate over a newer successful renderer', async () => {
    const h = harness(), importing = deferred(); h.moduleLoads.push(importing);
    const abandoned = h.select('vrm');
    await h.select('builtin');
    await h.select('vrm');
    const fresh = h.models[0];
    importing.resolve(); await abandoned;
    assert.equal(h.models.length, 1);
    assert.equal(h.state().vrmAvatar, fresh);
    assert.equal(fresh.disposeCalls, 0);
});
