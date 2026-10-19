import test from 'node:test';
import assert from 'node:assert/strict';
import { SponsorDraft, SponsorView, SPONSOR_DEFAULTS, sponsorLabel, sponsorLayerVisible } from '../public/sponsor-view.mjs';

const snapshot = (revision, extra = {}) => ({ ...SPONSOR_DEFAULTS, revision, enabled: true, ...extra });
const img = id => ({ id, mime: 'image/png', width: 400, height: 200, url: `/api/sponsor/image/${id}` });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness({ fetchFn, decode } = {}) {
    const parts = Object.fromEntries(['label', 'title', 'message', 'link', 'image'].map(name => [name, { textContent: '', hidden: true, removeAttribute(key) { delete this[key]; } }]));
    const root = { dataset: {}, hidden: true, querySelector(selector) { return parts[selector.match(/data-sponsor-(\w+)/)[1]]; } };
    const created = [], revoked = [], calls = [], states = [];
    const view = new SponsorView(root, {
        token: () => 'view-secret', onState: (state, revision) => states.push({ state, revision }),
        fetchFn: async (...args) => { calls.push(args); return fetchFn ? fetchFn(...args) : { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) }; },
        urlApi: { createObjectURL(blob) { const url = `blob:local-${created.length}`; created.push({ url, blob }); return url; }, revokeObjectURL(url) { revoked.push(url); } },
        imageFactory: () => ({ decode: decode || (() => Promise.resolve()) }),
    });
    return { view, root, parts, calls, created, revoked, states };
}

test('dirty draft survives a newer edit and reconnect, while a newer hide unchecks visibility', () => {
    const draft = new SponsorDraft(); draft.receive(snapshot(3));
    draft.edit({ title: '未保存の見出し', enabled: true });
    draft.receive(snapshot(4, { title: '別の画面の保存' }));
    assert.equal(draft.value.title, '未保存の見出し'); assert.equal(draft.baseRevision, 3);
    draft.receive(snapshot(4, { enabled: false }));
    assert.equal(draft.value.enabled, true, 'duplicate revisions cannot alter the draft');
    draft.receive(snapshot(5, { enabled: false }));
    assert.equal(draft.value.title, '未保存の見出し'); assert.equal(draft.value.enabled, false);
    assert.equal(draft.payload().revision, 3, 'stale draft must conflict at save instead of silently overwriting');
    draft.receive(snapshot(2, { title: '古い接続' })); assert.equal(draft.saved.revision, 5);
    draft.reset(); assert.equal(draft.dirty, false); assert.equal(draft.value.enabled, false); assert.equal(draft.baseRevision, 5);
});

test('image omission keeps the stored image, removal is explicit, and resetting releases draft data', () => {
    const draft = new SponsorDraft(); draft.receive(snapshot(1, { image: img('abc') }));
    draft.edit({ message: '文字だけ編集' }); assert.equal(Object.hasOwn(draft.payload(), 'imageData'), false);
    draft.image(null); assert.equal(draft.payload().imageData, null); assert.equal(draft.value.image, null);
    const blob = new Blob(['png'], { type: 'image/png' }); draft.image({ mime: 'image/png', base64: 'cG5n' }, blob);
    assert.equal(draft.imageBlob, blob); draft.reset();
    assert.equal(draft.imageBlob, null); assert.equal(draft.imageData, undefined); assert.equal(draft.value.image.id, 'abc');
});

test('advertising label is fixed, all operator text remains literal, and old revisions cannot re-show a hidden card', () => {
    const h = harness(); const unsafe = '<img src=x onerror=alert(1)>';
    h.view.render(snapshot(2, { mode: 'sponsor', title: unsafe, message: unsafe, link: 'https://example.com/<script>' }));
    assert.equal(h.parts.label.textContent, '広告 / PR'); assert.equal(h.parts.title.textContent, unsafe);
    assert.equal(h.parts.message.textContent, unsafe); assert.equal(h.parts.link.textContent, 'https://example.com/<script>');
    assert.equal(h.root.hidden, false); assert.equal(sponsorLabel('recruitment'), '広告募集');
    h.view.render(snapshot(3, { enabled: false })); h.view.render(snapshot(2));
    assert.equal(h.root.hidden, true); assert.equal(h.root.dataset.sponsorState, 'hidden');
});

test('image retrieval uses bearer authorization and one decoded URL survives text-only updates', async () => {
    const h = harness(); h.view.render(snapshot(1, { image: img('abc') })); await h.view.loading;
    assert.equal(h.calls[0][0], '/api/sponsor/image/abc');
    assert.equal(h.calls[0][1].headers.Authorization, 'Bearer view-secret'); assert.equal(h.parts.image.src, 'blob:local-0');
    assert.equal(h.parts.image.hidden, false); assert.equal(h.created.length, 1);
    h.view.render(snapshot(2, { image: img('abc'), title: '更新' }));
    h.view.render(snapshot(2, { image: img('abc'), title: '更新' }));
    assert.equal(h.calls.length, 1); assert.equal(h.created.length, 1);
    assert.deepEqual(h.states.at(-1), { state: 'visible', revision: 2 }, 'same image still reports the new rendered revision');
    h.view.render(snapshot(3, { image: img('def') })); await h.view.loading;
    assert.equal(h.parts.image.src, 'blob:local-1'); assert.deepEqual(h.revoked, ['blob:local-0']);
    h.view.dispose(); h.view.dispose(); assert.deepEqual(h.revoked, ['blob:local-0', 'blob:local-1']);
});

test('hide cancels a pending decode and delayed image completion cannot restore it or leak URLs', async () => {
    const decode = deferred(), h = harness({ decode: () => decode.promise });
    h.view.render(snapshot(1, { image: img('abc') })); await flush(); assert.equal(h.created.length, 1);
    h.view.render(snapshot(2, { enabled: false }));
    assert.equal(h.calls[0][1].signal.aborted, true); assert.deepEqual(h.revoked, ['blob:local-0']);
    decode.resolve(); await h.view.loading;
    assert.equal(h.root.hidden, true); assert.equal(h.parts.image.hidden, true); assert.equal(h.parts.image.src, undefined);
    assert.deepEqual(h.revoked, ['blob:local-0']);
});

test('a stale fetch cannot create a URL after replacement and local previews never fetch an image', async () => {
    const old = deferred(); const h = harness({ fetchFn: url => url.endsWith('abc') ? old.promise : Promise.resolve({ ok: true, blob: async () => new Blob(['new'], { type: 'image/png' }) }) });
    h.view.render(snapshot(1, { image: img('abc') })); const oldLoad = h.view.loading;
    h.view.render(snapshot(2, { image: img('def') })); await h.view.loading;
    old.resolve({ ok: true, blob: async () => new Blob(['old'], { type: 'image/png' }) }); await oldLoad;
    assert.equal(h.created.length, 1); assert.equal(h.parts.image.src, 'blob:local-0');
    const local = new Blob(['local'], { type: 'image/webp' });
    h.view.render({ ...SPONSOR_DEFAULTS, enabled: false }, { draft: true, imageBlob: local }); await h.view.loading;
    h.view.render({ ...SPONSOR_DEFAULTS, title: 'draft edit' }, { draft: true, imageBlob: local });
    assert.equal(h.calls.length, 2); assert.equal(h.created.length, 2); assert.equal(h.root.hidden, false);
    h.view.dispose(); assert.equal(h.revoked.length, 2);
});

test('unsupported image paths, types and failed decodes keep text only and release every URL', async () => {
    for (const image of [{ ...img('abc'), url: 'https://example.com/logo.png' }, { ...img('abc'), mime: 'image/svg+xml' }]) {
        const h = harness(); h.view.render(snapshot(1, { image })); await h.view.loading;
        assert.equal(h.calls.length, 0); assert.equal(h.root.dataset.sponsorState, 'image-error'); assert.equal(h.root.hidden, false);
    }
    const h = harness({ decode: () => Promise.reject(new Error('decode failed')) });
    h.view.render(snapshot(1, { image: img('abc') })); await h.view.loading;
    assert.equal(h.parts.image.hidden, true); assert.equal(h.root.dataset.sponsorState, 'image-error');
    assert.deepEqual(h.revoked, ['blob:local-0']);
});

test('sponsor appears once in normal output or overlay layer, and never other composition layers', () => {
    for (const layer of [null, '', 'overlay']) assert.equal(sponsorLayerVisible(layer), true);
    for (const layer of ['background', 'avatar', 'comments', 'subtitles', 'other']) {
        assert.equal(sponsorLayerVisible(layer), false);
        const h = harness(); h.view.render(snapshot(1, { image: img('abc') }), { allowed: sponsorLayerVisible(layer) });
        assert.equal(h.root.hidden, true); assert.equal(h.calls.length, 0);
    }
});

test('first reconnect snapshot can reset a missing saved store, hide old advertising and retain an unsaved draft', async () => {
    const h = harness(); h.view.render(snapshot(8, { image: img('abc'), title: 'Previously saved ad' })); await h.view.loading;
    h.view.render(snapshot(0, { enabled: false }));
    assert.equal(h.root.hidden, false, 'ordinary old events are still ignored');
    h.view.render(snapshot(0, { enabled: false }), { authoritative: true });
    assert.equal(h.root.hidden, true); assert.equal(h.root.dataset.sponsorRevision, '0');
    assert.deepEqual(h.revoked, ['blob:local-0']);
    assert.deepEqual(h.states.at(-1), { state: 'hidden', revision: 0 });
    h.view.render(snapshot(1, { title: 'New store' }));
    assert.equal(h.parts.title.textContent, 'New store'); assert.equal(h.root.hidden, false, 'new revision sequence is accepted');

    const draft = new SponsorDraft(); draft.receive(snapshot(8, { title: 'Saved old ad' }));
    draft.edit({ title: 'Unsaved operator edit', enabled: true });
    draft.receive(snapshot(0, { enabled: false }), true);
    assert.equal(draft.saved.revision, 0); assert.equal(draft.value.title, 'Unsaved operator edit');
    assert.equal(draft.value.enabled, false, 'the authoritative hide also unchecks visibility');
    assert.equal(draft.dirty, true); assert.equal(draft.payload().revision, 8, 'old draft retains conflict protection');
    draft.reset(); assert.equal(draft.value.title, SPONSOR_DEFAULTS.title); assert.equal(draft.baseRevision, 0);

    const clean = new SponsorDraft(); clean.receive(snapshot(8, { title: 'Old ad' }));
    clean.receive(snapshot(0, { enabled: false }), true);
    assert.equal(clean.value.enabled, false); assert.equal(clean.baseRevision, 0); assert.equal(clean.dirty, false);
});
