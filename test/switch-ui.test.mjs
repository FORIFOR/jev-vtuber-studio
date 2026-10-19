import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SwitchSetup, takeAdmin, validScan } from '../public/switch.mjs';

const html = readFileSync(new URL('../public/switch.html', import.meta.url), 'utf8');
function harness() {
    let now = 10000, serial = 0;
    const timers = new Map(), calls = [], revoked = [], created = [], values = new Map([['jvs-admin', 'test-admin']]);
    class Element {
        constructor(id) { Object.assign(this, { id, value: '', textContent: '', disabled: false, hidden: false, checked: false, dataset: {}, children: [], listeners: {} }); }
        addEventListener(name, fn) { this.listeners[name] = fn; }
        replaceChildren(...items) { this.children = items; }
        removeAttribute(name) { delete this[name]; }
    }
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
    const document = { getElementById: id => { assert.ok(elements.has(id), `missing HTML id ${id}`); return elements.get(id); }, createElement: tag => new Element(tag) };
    const listeners = new Map();
    const window = { location: { hash: '', pathname: '/switch', search: '' }, history: { replaceState() {} }, sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    let handler = async path => { throw new Error(`unexpected request ${path}`); };
    const page = new SwitchSetup({ document, window, now: () => now, fetchImpl: async (path, init) => { calls.push({ path, init }); return handler(path, init); }, setTimer: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, clearTimer: id => timers.delete(id), createURL: () => { const url = `blob:fixture-${created.length}`; created.push(url); return url; }, revokeURL: url => revoked.push(url) });
    const status = (extra = {}) => ({ configured: true, obs: { connected: true, streaming: false, recording: false, replaying: false, reconnecting: false }, recording: { state: 'idle', owned: false }, ...extra });
    const json = (body, code = 200) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });
    const jpeg = () => ({ ok: true, status: 200, headers: new Map([['Content-Type', 'image/jpeg']]), blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) });
    const scan = () => ({ scanId: 'scan-1', expiresAt: now + 60000, videoDevices: [{ id: 'video-1', label: '<img src=x onerror=alert(1)> UGREEN' }], audioDevices: [{ id: 'audio-1', label: 'USB Audio' }], configured: true });
    return { page, elements, get: id => elements.get(id), calls, revoked, created, timers, status, json, jpeg, scan, handler: fn => { handler = fn; }, now: value => { now = value; }, listeners };
}

 test('hash admin moves into session storage and never remains in the URL', () => {
    const writes = [], replacements = [];
    assert.equal(takeAdmin({ location: { hash: '#admin=fixture-secret', pathname: '/switch', search: '?v=1' }, history: { replaceState: (...args) => replacements.push(args) }, storage: { getItem: () => 'old', setItem: (...args) => writes.push(args) } }), 'fixture-secret');
    assert.deepEqual(writes, [['jvs-admin', 'fixture-secret']]); assert.equal(replacements[0][2], '/switch?v=1');
    assert.equal(takeAdmin({ location: { hash: '', pathname: '/switch', search: '' }, history: {}, storage: { getItem() { throw new Error('storage denied'); } } }), '');
});

test('scan uses explicit selections and plain-text labels; opaque IDs reach prepare unchanged', async () => {
    const h = harness(); h.page.receive(h.status()); h.handler(async path => path.endsWith('/devices') ? h.json(h.scan()) : h.json(h.status()));
    await h.page.detect();
    assert.equal(h.get('video-device').value, ''); assert.equal(h.get('audio-device').value, ''); assert.equal(h.get('video-preset').value, '');
    assert.equal(h.get('prepare-scene').disabled, true); assert.equal(h.get('video-device').children[1].textContent, '<img src=x onerror=alert(1)> UGREEN');
    h.get('video-device').value = 'video-1'; h.get('audio-device').value = 'audio-1'; h.get('video-preset').value = '1080p'; h.page.selectionChanged();
    assert.equal(h.get('prepare-scene').disabled, false); await h.page.prepare();
    assert.deepEqual(JSON.parse(h.calls.find(x => x.path.endsWith('/prepare')).init.body), { scanId: 'scan-1', videoId: 'video-1', audioId: 'audio-1', quality: '1080p' });
    assert.equal(h.page.prepared(), true); assert.equal(h.get('review-checks').disabled, true);
    assert.ok(h.calls.every(x => x.init.headers.Authorization === 'Bearer test-admin'));
    assert.ok([...h.elements.values()].every(x => !x.textContent.includes('test-admin')));
});

test('expired scan, unknown device and unsupported quality never submit prepare', async () => {
    const h = harness(); h.page.scan = h.scan(); h.get('video-device').value = 'video-1'; h.get('audio-device').value = 'audio-1'; h.get('video-preset').value = '1080p';
    h.now(70000); assert.equal(validScan(h.page.scan, 70000), false); await h.page.prepare(); assert.equal(h.calls.length, 0);
    h.now(10000); h.get('video-device').value = 'built-in-not-enumerated'; await h.page.prepare(); assert.equal(h.calls.length, 0);
    h.get('video-device').value = 'video-1'; h.get('video-preset').value = '720p'; await h.page.prepare(); assert.equal(h.calls.length, 0);
});

test('double click submits one recording start, unknown outcomes block another and own recording may stop', async () => {
    const h = harness(); h.page.receive(h.status()); h.page.draw();
    let release; h.handler(path => path.endsWith('/start') ? new Promise(resolve => { release = () => resolve(h.json({ ok: true })); }) : Promise.resolve(h.json(h.status({ obs: { connected: true, streaming: false, recording: true }, recording: { state: 'recording', owned: true, remainingSeconds: 29, id: 'trial-1' } }))));
    const first = h.page.startRecording(); await h.page.startRecording();
    assert.equal(h.calls.length, 1); assert.equal(h.get('start-recording').disabled, true); assert.equal(h.page.canStart(), false);
    release(); await first; assert.equal(h.get('start-recording').disabled, true); assert.equal(h.get('stop-recording').disabled, false); assert.equal(h.get('record-countdown').textContent, '残り 29 秒');
    assert.equal([...h.timers.values()].filter(x => x.ms === 1500).length, 1);
    h.handler(async () => { throw new Error('network unavailable'); }); await h.page.refreshStatus();
    assert.equal(h.page.canStart(), false); assert.equal(h.get('stop-recording').disabled, true);
    await h.page.startRecording(); assert.equal(h.calls.filter(x => x.path.endsWith('/start')).length, 1); h.page.dispose(); assert.equal(h.timers.size, 0);
});

test('streaming, foreign recordings and missing output flags cannot start or stop a test recording', async () => {
    for (const snapshot of [{ configured: true }, { configured: true, obs: { connected: true, streaming: true, recording: false }, recording: { state: 'idle' } }, { configured: true, obs: { connected: true, streaming: false, recording: true }, recording: { state: 'recording', owned: false } }]) {
        const h = harness(); h.page.receive(snapshot); h.page.draw(); assert.equal(h.page.canStart(), false);
        await h.page.startRecording(); await h.page.stopRecording(); assert.equal(h.calls.length, 0); assert.equal(h.get('stop-recording').disabled, true);
    }
});

test('preview is manual, authenticated and releases old blobs; stale callbacks cannot reveal images', async () => {
    const h = harness(); h.page.receive(h.status()); h.page.draw(); assert.equal(h.calls.length, 0);
    h.handler(async () => h.jpeg()); await h.page.preview(); const oldLoad = h.get('preview-image').onload; oldLoad();
    assert.equal(h.get('preview-image').hidden, false); assert.equal(h.get('preview-placeholder').hidden, true);
    await h.page.preview(); assert.deepEqual(h.revoked, ['blob:fixture-0']); oldLoad(); assert.equal(h.get('preview-image').hidden, true);
    h.get('preview-image').onload(); assert.equal(h.get('preview-image').hidden, false);
    h.page.selectionChanged(); assert.equal(h.get('preview-image').hidden, true); assert.deepEqual(h.revoked, ['blob:fixture-0', 'blob:fixture-1']);
    assert.ok(h.calls.every(x => x.path === '/api/switch/preview' && x.init.method === 'GET'));
});

test('unauthorized errors clear private preview and never echo backend error strings', async () => {
    const h = harness(); h.page.receive(h.status()); h.handler(async () => h.jpeg()); await h.page.preview(); h.get('preview-image').onload();
    h.handler(async () => h.json({ error: 'secret-value-in-server-message' }, 401)); await h.page.refreshStatus();
    assert.equal(h.get('switch-app').hidden, true); assert.equal(h.get('locked').hidden, false); assert.equal(h.get('preview-image').hidden, true);
    assert.equal(h.get('notice').textContent.includes('secret-value'), false); assert.equal(h.page.canStart(), false);
});

test('unconfirmed stop, replay, reconnect or backend operation block another recording', async () => {
    for (const extra of [{ recording: { state: 'unconfirmed', owned: true } }, { obs: { connected: true, streaming: false, recording: false, replaying: true, reconnecting: false } }, { obs: { connected: true, streaming: false, recording: false, replaying: false, reconnecting: true } }, { busy: true }]) {
        const h = harness(); h.page.receive(h.status(extra)); h.page.draw(); assert.equal(h.page.canStart(), false); await h.page.startRecording(); assert.equal(h.calls.length, 0);
        if (extra.recording) assert.match(h.get('record-detail').textContent, /OBSで配信・録画・リプレイ保存が停止/);
    }
});

test('human review is separate from configured and resets when selection or recording changes', () => {
    const h = harness(); h.page.receive(h.status()); h.page.draw(); assert.equal(h.get('review-checks').disabled, true);
    h.page.receive(h.status({ recording: { state: 'completed', owned: true, id: 'record-1', path: '/recordings/test.mov' } })); h.page.draw();
    assert.equal(h.get('review-checks').disabled, false);
    for (const id of ['check-video', 'check-audio', 'check-duplicate']) h.get(id).checked = true;
    h.page.review(); assert.match(h.get('review-state').textContent, /確認しました/);
    h.page.receive(h.status({ recording: { state: 'completed', owned: true, id: 'record-2' } })); h.page.draw(); assert.equal(h.get('check-audio').checked, false);
    h.page.selectionChanged(); assert.equal(h.get('review-checks').disabled, true);
});

 test('unconfirmed recovery uses its explicit action; ordinary status refresh stays read-only', async () => {
    const h = harness(); const unconfirmed = h.status({ recording: { state: 'unconfirmed', owned: false } }); h.page.receive(unconfirmed); h.page.draw();
    assert.equal(h.get('recheck-recording').hidden, false); assert.equal(h.get('recheck-recording').disabled, false);
    h.handler(async () => h.json(unconfirmed)); await h.page.refreshStatus(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.method, 'GET');
    h.handler(async path => path.endsWith('/recheck') ? h.json({ recording: { state: 'stopped', owned: false } }) : h.json(h.status({ recording: { state: 'stopped', owned: false } })));
    await h.page.recheckRecording(); assert.equal(h.calls.filter(x => x.path.endsWith('/recheck')).length, 1); assert.equal(h.get('recheck-recording').hidden, true);
    assert.equal(h.calls.some(x => x.path.endsWith('/stop') || x.path.endsWith('/start')), false);
});

 test('a preparation accepted before status connection loss cannot expose stale prepared state', async () => {
    const h = harness(); h.page.receive(h.status()); h.page.scan = h.scan(); h.get('video-device').value = 'video-1'; h.get('audio-device').value = 'audio-1'; h.get('video-preset').value = '1080p'; h.page.selectionChanged();
    h.handler(async path => { if (path.endsWith('/prepare')) return h.json({configured:true}); throw new Error('status unavailable'); });
    await h.page.prepare(); assert.equal(h.page.prepared(), false); assert.equal(h.page.canStart(), false); assert.equal(h.get('refresh-preview').disabled, true);
});
