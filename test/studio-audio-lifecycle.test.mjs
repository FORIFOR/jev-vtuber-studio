import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual Studio audition lifecycle with only fetch/DOM/URL boundaries
// substituted. No browser, audio engine or live service is started.
const studio = readFileSync(new URL('../public/studio.mjs', import.meta.url), 'utf8');
const lifecycle = studio.slice(studio.indexOf('const trialAudioURLs ='), studio.indexOf("$('go-live').onclick ="));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness() {
    const elements = new Map(), routes = new Map(), urls = new Map(), revoked = [], events = [], listeners = new Map();
    let serial = 0;
    const $ = id => {
        if (!elements.has(id)) {
            let source = '';
            elements.set(id, { id, paused: false, hidden: true, listeners: new Map(),
                get src() { return source; }, set src(value) { source = value; events.push(['src', id, value]); },
                pause() { this.paused = true; events.push(['pause', id]); },
                play() { this.paused = false; events.push(['play', id]); return Promise.resolve(); },
                removeAttribute(name) { assert.equal(name, 'src'); source = ''; events.push(['remove', id]); },
                load() { events.push(['load', id]); },
                addEventListener(name, listener) { this.listeners.set(name, listener); },
                removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); },
            });
        }
        return elements.get(id);
    };
    const context = vm.createContext({ $, admin: 'fixture',
        fetch: async path => {
            const result = routes.get(path);
            return result ? await result : { ok: true, blob: async () => ({ path }) };
        },
        URL: { createObjectURL(blob) { const url = `blob:trial-${++serial}`; urls.set(url, blob); return url; },
            revokeObjectURL(url) { assert.ok(urls.delete(url), 'each created URL is revoked exactly once'); revoked.push(url); events.push(['revoke', url]); } },
        addEventListener(name, listener) { listeners.set(name, listener); },
    });
    vm.runInContext(lifecycle, context);
    return { $, routes, urls, revoked, events,
        audio: (path, el) => vm.runInContext('audioBlob', context)(path, el),
        link: (el, next) => context.linkTrialAudio(el, next),
        clear: () => context.clearTrialAudio(),
        close: () => $('live-dialog').listeners.get('close')(),
        pagehide: persisted => listeners.get('pagehide')({ persisted }),
    };
}

test('audition replacement keeps the playing take until new bytes arrive and retains replay until cleanup', async () => {
    const h = harness(), el = h.$('live-audio');
    await h.audio('/old.wav', el);
    const old = el.src, response = deferred(); h.routes.set('/new.wav', response.promise);
    const next = h.audio('/new.wav', el);
    assert.equal(el.src, old); assert.equal(el.paused, false); assert.deepEqual(h.revoked, []);
    const blob = { exactBytes: new Uint8Array([1, 2, 3]) };
    response.resolve({ ok: true, blob: async () => blob });
    assert.equal(await next, true);
    assert.notEqual(el.src, old); assert.equal(el.paused, false);
    assert.deepEqual(h.revoked, [old]); assert.equal(h.urls.get(el.src), blob);
    assert.ok(h.events.findIndex(x => x[0] === 'src' && x[2] === el.src) < h.events.findIndex(x => x[0] === 'revoke'));
    assert.equal(h.urls.size, 1, 'the newly playing/replayable take is not revoked on load or ended');
});

test('failed replacement leaves the previous audition usable', async () => {
    const h = harness(), el = h.$('live-audio'); await h.audio('/old.wav', el);
    const old = el.src;
    h.routes.set('/gone.wav', { ok: false });
    await assert.rejects(h.audio('/gone.wav', el), /試聴音声が失効/);
    h.routes.set('/broken.wav', { ok: true, blob: async () => { throw new Error('read failed'); } });
    await assert.rejects(h.audio('/broken.wav', el), /read failed/);
    assert.equal(el.src, old); assert.equal(el.paused, false); assert.deepEqual(h.revoked, []); assert.equal(h.urls.size, 1);
});

test('closing a trial releases all three player resources after pausing and is idempotent', async () => {
    const h = harness();
    for (const id of ['live-audio', 'live-comment-audio', 'live-library-audio']) await h.audio(`/${id}.wav`, h.$(id));
    h.events.length = 0; h.close();
    assert.equal(h.urls.size, 0); assert.equal(h.revoked.length, 3);
    for (let i = 0; i < 3; i++) assert.deepEqual(h.events.slice(i * 4, i * 4 + 4).map(x => x[0]), ['pause', 'remove', 'load', 'revoke']);
    h.close(); assert.equal(h.revoked.length, 3);
});

test('a late response cannot recreate a Blob URL after dialog close', async () => {
    const h = harness(), response = deferred(), el = h.$('live-audio');
    h.routes.set('/late.wav', response.promise);
    const pending = h.audio('/late.wav', el);
    h.close(); response.resolve({ ok: true, blob: async () => ({}) });
    assert.equal(await pending, false); assert.equal(h.urls.size, 0); assert.equal(el.src, '');
    assert.equal(await h.audio('/next.wav', el), true); assert.equal(h.urls.size, 1);
});

test('cleanup removes audition continuation listeners before another trial can play', async () => {
    const h = harness(), first = h.$('live-audio'), second = h.$('live-comment-audio');
    await h.audio('/first.wav', first); await h.audio('/second.wav', second);
    h.link(first, second); assert.ok(first.listeners.has('ended'));
    first.onended = () => assert.fail('stale trial callback');
    h.close(); assert.equal(first.listeners.has('ended'), false); assert.equal(first.onended, null);
    await h.audio('/new-first.wav', first); await h.audio('/new-second.wav', second);
    h.link(first, second); first.listeners.get('ended')();
    assert.equal(h.events.filter(x => x[0] === 'play').length, 1);
});

test('pagehide preserves bfcache replay but disposes audio when leaving the document', async () => {
    const h = harness(), el = h.$('live-audio'); await h.audio('/old.wav', el);
    const old = el.src; h.pagehide(true);
    assert.equal(el.src, old); assert.equal(el.paused, false); assert.equal(h.urls.size, 1);
    h.pagehide(false); assert.equal(el.src, ''); assert.equal(h.urls.size, 0);
});
