import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { RemoteControl } from '../src/remote-control.mjs';
import { createRemoteServer, validateRemoteOptions } from '../src/remote-server.mjs';
import { ROOT } from '../src/config.mjs';
import { defer, setup } from './helpers.mjs';
import { createApp } from '../src/server.mjs';
const OPTIONS = { enabled: true, origin: 'https://studio.example.ts.net', users: ['owner@example.com'], port: 8788 };
function rig(overrides = {}) {
    let time = 1000000, fp = 'same', rehearsal = true, proof = true, startCalls = 0, active = false;
    const c = { mode: 'live', profile: 'talk', allowStream: true, obsScene: 'Jev Studio', obsInput: 'Jev Stage', obsURL: 'ws://127.0.0.1:4455',
        viewToken: 'private-view', obsRendererToken: 'private-renderer', youtubeVideo: 'abcdefghijk', sessionMs: 1800000, character: { name: 'ノア', channel: '夜の雑談' } };
    const e = new EventEmitter(); Object.assign(e, { running: false, panic: false, renderer: { role: 'obs' },
        status: () => ({ renderer: !!e.renderer, running: e.running, panic: e.panic, phase: e.running ? 'speaking' : 'stopped', stats: { spoken: 2 }, remainingMs: 12000, youtube: 'waiting' }),
        start() { e.running = true; }, stop() { e.running = false; }, emergency() { e.running = false; e.panic = true; } });
    const output = { url: 'http://127.0.0.1:8787/stage#token=private-view&output=obs&rendererKey=private-renderer', reroute_audio: true };
    const obs = { owned: false, async call(name) {
        return ({ GetStreamStatus: { outputActive: active, outputReconnecting: false }, GetCurrentProgramScene: { currentProgramSceneName: c.obsScene },
            GetInputSettings: { inputSettings: output }, GetSceneItemId: { sceneItemId: 1 }, GetSceneItemEnabled: { sceneItemEnabled: true },
            GetInputMute: { inputMuted: false }, GetInputVolume: { inputVolumeMul: 1 },
            GetStreamServiceSettings: { streamServiceType: 'rtmp_common', streamServiceSettings: { key: 'NEVER_EXPOSE_KEY', service: 'YouTube' } } })[name] || {};
        }, async start() { startCalls++; this.owned = true; active = true; }, async stopOwned() { if (this.owned) active = false; this.owned = false; } };
    const controller = new RemoteControl({ c, engine: e, obs, fingerprint: () => fp, verified: () => rehearsal, outputVerified: () => proof,
        setupBusy: () => false, waitForStop: async () => {}, localOrigin: () => 'http://127.0.0.1:8787', now: () => time, pause: async () => { time += 250; }, ...overrides });
    return { c, e, obs, output, controller, setTime: x => time = x, changeConfig: () => fp = 'changed', unverify: () => rehearsal = false,
        unprove: () => proof = false, get starts() { return startCalls; }, externalStream: () => active = true };
}
const arm = r => r.controller.arm({ confirm: 'ARM_VERIFIED_OUTPUT' });
const start = r => r.controller.start({ requestId: randomUUID(), confirm: 'START_BROADCAST', videoID: r.c.youtubeVideo });
test('remote is disabled without explicit options; only exact Tailscale HTTPS and allowlist accepted', () => {
    assert.equal(validateRemoteOptions({ enabled: false }), null);
    for (const origin of ['http://studio.example.ts.net', 'https://evil.com', 'https://studio.example.ts.net/x', 'https://studio.example.ts.net:444'])
        assert.throws(() => validateRemoteOptions({ ...OPTIONS, origin }));
    assert.throws(() => validateRemoteOptions({ ...OPTIONS, users: [] }));
    assert.equal(validateRemoteOptions(OPTIONS).origin, OPTIONS.origin);
});
test('arm requires live rehearsal, OBS playback proof, and explicit local consent', async () => {
    const r = rig(); await assert.rejects(() => r.controller.arm(), { code: 'CONFIRM_REQUIRED' });
    r.unprove(); await assert.rejects(() => arm(r), { code: 'OBS_REHEARSAL_REQUIRED' });
    const r2 = rig(); r2.unverify(); await assert.rejects(() => arm(r2), { code: 'REHEARSAL_REQUIRED' });
    const r3 = rig(); r3.e.renderer.role = 'preview'; await assert.rejects(() => arm(r3), { code: 'OBS_AUDIO_REQUIRED' });
});
test('arming and preflight never start a stream; permission expires after eight hours', async () => {
    const r = rig(); await arm(r); assert.equal((await r.controller.preflight()).ok, true); assert.equal(r.starts, 0);
    r.setTime(1000000 + 8*3600000); assert.equal(r.controller.armed(), false);
    await assert.rejects(() => r.controller.preflight(), { code: 'NOT_ARMED' });
});
test('destination or provider changes invalidate start permission', async () => {
    const r = rig(); await arm(r); r.changeConfig(); assert.equal(r.controller.armed(), false);
    const s = rig(); await arm(s); const old = s.obs.call.bind(s.obs);
    s.obs.call = async n => n === 'GetStreamServiceSettings' ? { streamServiceSettings: { key: 'different' } } : old(n);
    await assert.rejects(() => s.controller.preflight(), { code: 'DESTINATION_CHANGED' });
});
test('remote preflight refuses muted, hidden, zero-volume or changed OBS sources', async () => {
    const cases = [ ['GetInputMute', { inputMuted: true }, 'SOURCE_MUTED'], ['GetSceneItemEnabled', { sceneItemEnabled: false }, 'SOURCE_HIDDEN'],
        ['GetInputVolume', { inputVolumeMul: 0 }, 'SOURCE_SILENT'], ['GetInputSettings', { inputSettings: {} }, 'SOURCE_CHANGED'] ];
    for (const [call, response, code] of cases) { const r = rig(), old = r.obs.call.bind(r.obs); r.obs.call = async n => n === call ? response : old(n); await assert.rejects(() => arm(r), { code }); }
});
test('start is explicit, idempotent, and waits for observed OBS output before runtime starts', async () => {
    const r = rig(); await arm(r); assert.throws(() => r.controller.start({ requestId: randomUUID() }), { code: 'CONFIRM_REQUIRED' });
    const args = { requestId: randomUUID(), confirm: 'START_BROADCAST', videoID: r.c.youtubeVideo };
    const j = r.controller.start(args); assert.equal(r.e.running, false); assert.equal(r.controller.start(args).id, j.id);
    await r.controller.task; assert.equal(r.starts, 1); assert.equal(r.e.running, true); assert.equal(r.controller.job.state, 'transmitting');
    const serialized = JSON.stringify(r.controller.summary()); assert.ok(!serialized.includes('NEVER_EXPOSE_KEY')); assert.ok(!serialized.includes('private-view'));
});
test('stop preempts a delayed preflight and prevents any later StartStream', async () => {
    const r = rig(); await arm(r); const blocked = defer(), old = r.obs.call.bind(r.obs); let delay = true;
    r.obs.call = async n => { if (n === 'GetInputMute' && delay) await blocked.promise; return old(n); };
    start(r); await new Promise(resolve => setTimeout(resolve, 5));
    r.controller.stop({ requestId: randomUUID() }); delay = false; blocked.resolve(); await r.controller.task;
    assert.equal(r.starts, 0); assert.equal(r.e.running, false); assert.equal(r.controller.job.state, 'stopped');
});
test('stop also cleans up when OBS start acknowledgment arrives late', async () => {
    const r = rig(); await arm(r); const blocked = defer(), old = r.obs.start.bind(r.obs);
    r.obs.start = async () => { await blocked.promise; await old(); };
    start(r); await new Promise(resolve => setTimeout(resolve, 5)); r.controller.stop({ requestId: randomUUID() }); blocked.resolve(); await r.controller.task;
    assert.equal(r.obs.owned, false); assert.equal(r.e.running, false); assert.equal(r.controller.job.state, 'stopped');
});
test('panic revokes authorization and never resets the emergency latch remotely', async () => {
    const r = rig(); await arm(r); start(r); await r.controller.task;
    r.controller.stop({ requestId: randomUUID(), panic: true }); await r.controller.task;
    assert.equal(r.controller.armed(), false); assert.equal(r.e.panic, true); assert.throws(() => start(r), { code: 'NOT_ARMED' });
});
test('network failure does not report a verified stop', async () => {
    const r = rig(); r.obs.call = async () => { throw new Error('offline private-secret'); };
    r.controller.stop({ requestId: randomUUID() }); await r.controller.task;
    assert.equal(r.controller.job.state, 'stop_unconfirmed'); assert.ok(!JSON.stringify(r.controller.summary()).includes('private-secret'));
});
test('a stream started outside Studio is not stopped or claimed', async () => {
    const r = rig(); r.externalStream(); await assert.rejects(() => arm(r), { code: 'ALREADY_STREAMING' });
    r.controller.stop({ requestId: randomUUID() }); await r.controller.task;
    assert.equal(r.controller.job.state, 'external_stream_active');
});
function request(port, path, { method = 'GET', headers = {}, data } = {}) {
    return new Promise((resolve, reject) => { const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'studio.example.ts.net', 'Tailscale-User-Login': 'owner@example.com', ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode, headers: res.headers, body }); });
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined); });
}
async function httpRig(t) {
    const r = rig(); const remote = createRemoteServer(OPTIONS, r.controller, { publicDir: `${ROOT}/public` });
    await new Promise(resolve => remote.server.listen(0, '127.0.0.1', resolve)); t.after(() => remote.close());
    return { ...r, port: remote.server.address().port };
}
test('real HTTP gateway rejects missing identity, wrong user, and wrong Host', async t => {
    const r = await httpRig(t);
    for (const headers of [ { 'Tailscale-User-Login': '' }, { 'Tailscale-User-Login': 'stranger@example.com' }, { Host: 'evil.test' } ])
        assert.equal((await request(r.port, '/mobile', { headers })).status, 403);
    for (const path of ['/mobile', '/mobile/style.css', '/mobile/app.mjs', '/mobile/manifest.webmanifest', '/mobile/icon.svg'])
        assert.equal((await request(r.port, path)).status, 200);
});
test('gateway grants a secure user-bound session but refuses missing CSRF or foreign Origin', async t => {
    const r = await httpRig(t); const session = await request(r.port, '/mobile/api/session');
    const cookie = session.headers['set-cookie'][0]; assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie.split(';')[0], 'Content-Type': 'application/json', Origin: OPTIONS.origin };
    assert.equal((await request(r.port, '/mobile/api/action', { method: 'POST', headers, data: { action: 'stop', requestId: randomUUID() } })).status, 403);
    headers['X-JVS-CSRF'] = session.body.csrf;
    assert.equal((await request(r.port, '/mobile/api/action', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, data: { action: 'stop' } })).status, 403);
    assert.equal((await request(r.port, '/mobile/api/action', { method: 'POST', headers, data: { action: 'stop', requestId: randomUUID() } })).status, 202);
    await r.controller.task;
});
test('gateway has no settings, shell, render-claim, credentials, or GET start endpoint', async t => {
    const r = await httpRig(t); const session = await request(r.port, '/mobile/api/session'); const headers = { Cookie: session.headers['set-cookie'][0].split(';')[0] };
    for (const path of ['/api/session', '/api/settings', '/api/renderer/claim', '/stage', '/mobile/api/action', '/data/settings.json'])
        assert.equal((await request(r.port, path, { headers })).status, 404);
    assert.equal((await request(r.port, '/mobile?token=secret', { headers })).status, 400);
    const response = await request(r.port, '/mobile/api/action', { method: 'POST', headers: { ...headers, Origin: OPTIONS.origin, 'Content-Type': 'application/json', 'X-JVS-CSRF': session.body.csrf }, data: { action: 'shell' } });
    assert.equal(response.status, 400);
});
test('phone UI contains no renderer, speech generation, service worker, or secret storage', () => {
    const js = readFileSync(`${ROOT}/public/mobile.mjs`, 'utf8');
    for (const forbidden of ['AudioContext', '/api/renderer/', 'localStorage', 'sessionStorage', 'serviceWorker', 'adminToken', 'viewToken']) assert.ok(!js.includes(forbidden));
    assert.match(js, /visibilitychange/); assert.match(js, /crypto.randomUUID/);
});
test('main local app remains inaccessible via a reverse proxy Host; remote is opt-in', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }), app = createApp(c); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
    assert.equal(app.remote, null);
    const res = await request(app.server.address().port, '/api/session', { headers: { Authorization: `Bearer ${c.adminToken}` } }); assert.equal(res.status, 403);
});


test('StopStream acknowledgment is not confused with observed output termination', async () => {
    const r = rig(); await arm(r); start(r); await r.controller.task;
    const original = r.obs.call.bind(r.obs); let polls = 0;
    r.obs.stopOwned = async () => { r.obs.owned = false; };
    r.obs.call = async n => n === 'GetStreamStatus' ? { outputActive: ++polls < 4, outputReconnecting: false } : original(n);
    r.controller.stop({ requestId: randomUUID() }); await r.controller.task;
    assert.equal(polls, 4); assert.equal(r.controller.job.state, 'stopped');
});
test('own output staying active is STOP_UNCONFIRMED, never an external-stream claim', async () => {
    const r = rig(); await arm(r); start(r); await r.controller.task;
    r.obs.stopOwned = async () => { r.obs.owned = false; };
    r.controller.stop({ requestId: randomUUID() }); await r.controller.task;
    assert.equal(r.controller.job.state, 'stop_unconfirmed'); assert.equal(r.controller.job.error, 'STOP_UNCONFIRMED');
});
test('property order changes in OBS responses do not invalidate the verified destination', async () => {
    const r = rig(); await arm(r); const original = r.obs.call.bind(r.obs);
    r.obs.call = async n => { const response = await original(n); if (n === 'GetStreamServiceSettings') response.streamServiceSettings = { service: 'YouTube', key: 'NEVER_EXPOSE_KEY' }; return response; };
    assert.equal((await r.controller.preflight()).ok, true);
});
