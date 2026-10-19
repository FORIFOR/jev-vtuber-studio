import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from '../src/server.mjs';
import { OBS, obsAuth } from '../src/obs.mjs';
import { setup, defer } from './helpers.mjs';
async function app(t, overrides = {}, env = {}) { const c = setup(t, env); c.port = 0; const a = createApp(c, overrides); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close()); const url = `http://127.0.0.1:${a.server.address().port}`; const req = (path, data, token = c.adminToken, headers = {}) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: data ? JSON.stringify(data) : undefined }); return { ...a, c, url, req }; }
test('HTTP admin auth is required and view capability cannot control the show', async (t) => { const a = await app(t); assert.equal((await a.req('/api/session', null, 'wrong')).status, 401); const s = await (await a.req('/api/session')).json(); assert.equal(s.viewToken, a.c.viewToken); assert.equal((await a.req('/api/control', { action: 'start' }, a.c.viewToken)).status, 401); assert.equal((await a.req('/api/control', { action: 'start' })).status, 200); assert.equal(a.engine.running, true); await a.req('/api/control', { action: 'stop' }); });
test('HTTP requests reject cross-origin commands and invalid Host headers', async (t) => { const a = await app(t); assert.equal((await a.req('/api/control', { action: 'start' }, a.c.adminToken, { Origin: 'https://evil.example' })).status, 403); const status = await new Promise((resolve, reject) => { const req = http.get(a.url + '/healthz', { headers: { Host: 'evil.example' } }, r => { r.resume(); resolve(r.statusCode); }); req.on('error', reject); }); assert.equal(status, 403); assert.equal(a.engine.running, false); });
test('private files, code outside public root and stale WAV files are not served', async (t) => { const a = await app(t); for (const path of ['/.env', '/src/config.mjs', '/data/usage.json', '/audio/00000000-0000-0000-0000-000000000000.wav'])
    assert.equal((await a.req(path)).status, 404); assert.equal((await a.req('/stage')).headers.get('referrer-policy'), 'no-referrer'); const health = JSON.stringify(await (await a.req('/healthz')).json()); assert.ok(!health.includes(a.c.adminToken)); });
test('viewer can claim audio but cannot acquire it for a competing renderer', async (t) => { const a = await app(t), claim = await (await a.req('/api/renderer/claim', { client: 'first' }, a.c.viewToken)).json(); assert.ok(claim.acquired); assert.equal((await (await a.req('/api/renderer/claim', { client: 'second' }, a.c.viewToken)).json()).acquired, false); assert.equal((await (await a.req('/api/renderer/release', { lease: claim.lease }, a.c.viewToken)).json()).released, true); });
test('SSE contains a sanitized initial state and authenticates the view token', async (t) => { const a = await app(t); assert.equal((await fetch(a.url + '/events')).status, 401); const controller = new AbortController(); const r = await fetch(a.url + '/events?token=' + a.c.viewToken, { signal: controller.signal }); const reader = r.body.getReader(), chunk = await reader.read(); assert.match(new TextDecoder().decode(chunk.value), /"type":"state"/); controller.abort(); await reader.cancel().catch(() => { }); });
test('OBS never starts with demo or incomplete live readiness', async (t) => { let starts = 0; const a = await app(t, { obs: { owned: false, ready: false, start: async () => { starts++; }, stopOwned: async () => { }, close() { } } }); assert.equal((await a.req('/api/obs/start', { confirm: 'START' })).status, 400); assert.equal(starts, 0); });
test('HTTP OBS prepare hides the game after preparing a stopped lobby, without changing the response', async t => {
    const calls = [], prepared = { scene: 'prepared game scene' };
    const obs = { close() {}, async stopOwned() {}, async prepare() { calls.push('prepare'); return prepared; }, async setGameVisible(value) { calls.push(['visible', value]); } };
    const a = await app(t, { obs }, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' });
    assert.equal(a.engine.running, false); assert.equal(a.engine.blocks.phase, 'lobby');
    const response = await a.req('/api/obs/prepare', {});
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), prepared);
    assert.deepEqual(calls, ['prepare', ['visible', false]]);
});
test('HTTP OBS prepare leaves non-lobby game visibility unchanged', async t => {
    const visible = [];
    const obs = { close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible(value) { visible.push(value); } };
    const a = await app(t, { obs }, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' });
    a.engine.blocks.phase = 'playing';
    assert.equal((await a.req('/api/obs/prepare', {})).status, 200);
    assert.deepEqual(visible, []); assert.equal(a.engine.blocks.phase, 'playing');
});
test('HTTP OBS prepare does not require game visibility support without an external game', async t => {
    const a = await app(t, { obs: { close() {}, async stopOwned() {}, async prepare() { return {}; } } });
    assert.ok(!a.c.game);
    assert.equal((await a.req('/api/obs/prepare', {})).status, 200);
});
test('HTTP OBS prepare remains compatible with lobby OBS mocks without visibility support', async t => {
    const a = await app(t, { obs: { close() {}, async stopOwned() {}, async prepare() { return {}; } } }, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' });
    assert.equal(a.engine.blocks.phase, 'lobby');
    assert.equal((await a.req('/api/obs/prepare', {})).status, 200);
});
test('HTTP OBS prepare reports a failed lobby visibility update instead of readiness', async t => {
    const a = await app(t, { obs: { close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() { throw new Error('visibility update failed'); } } }, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' });
    const response = await a.req('/api/obs/prepare', {});
    assert.equal(response.status, 400); assert.ok((await response.json()).error, 'visibility failure must not return the prepared result');
});
test('OBS start/stop serialization does not lose a stop requested during StartStream', async (t) => { const c = setup(t); c.mode = 'live'; c.allowStream = true; const obs = new OBS(c), gate = defer(), started = defer(), calls = []; let active = false; obs.call = async (type) => { calls.push(type); if (type === 'GetStreamStatus')
    return { outputActive: active }; if (type === 'StartStream') {
    started.resolve();
    await gate.promise;
    active = true;
} if (type === 'StopStream')
    active = false; return {}; }; const begin = obs.start(); await started.promise; const end = obs.stopOwned(); gate.resolve(); await begin; await end; assert.deepEqual(calls, ['GetStreamStatus', 'StartStream', 'GetStreamStatus', 'StopStream']); assert.equal(active, false); assert.equal(obs.owned, false); assert.equal(existsSync(`${c.dataDir}/obs-owned.json`), false); });
test('a lost StartStream acknowledgement still triggers cleanup of owned output', async (t) => { const c = setup(t); c.mode = 'live'; c.allowStream = true; const obs = new OBS(c); let active = false; obs.call = async (type) => { if (type === 'GetStreamStatus')
    return { outputActive: active }; if (type === 'StartStream') {
    active = true;
    throw new Error('timeout');
} if (type === 'StopStream')
    active = false; return {}; }; await assert.rejects(obs.start(), /timeout/); assert.equal(active, false); assert.equal(obs.owned, false); });
test('OBS rejects takeover of a pre-existing external stream', async (t) => { const c = setup(t); c.mode = 'live'; c.allowStream = true; const obs = new OBS(c); obs.call = async () => ({ outputActive: true }); await assert.rejects(obs.start(), /ownership/); assert.equal(obs.owned, false); assert.equal(existsSync(`${c.dataDir}/obs-owned.json`), false); });
test('OBS prepare makes one browser source with dedicated audio and no stream-key changes', async (t) => { const c = setup(t), obs = new OBS(c), calls = []; obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : {}; }; await obs.prepare('http://127.0.0.1:8787'); const input = calls.find(x => x.type === 'CreateInput').data; assert.equal(input.inputSettings.width, 1920); assert.equal(input.inputSettings.height, 1080); assert.equal(input.inputSettings.reroute_audio, true); assert.match(input.inputSettings.url, /#token=/); assert.ok(!calls.some(x => x.type === 'StartStream' || x.type === 'SetStreamServiceSettings')); });
test('OBS websocket hello, identify and RPC responses implement v5 message envelopes', async (t) => { const c = setup(t); c.obsPassword = 'password'; let identify; class FakeWS extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.emit({ op: 0, d: { authentication: { salt: 'salt', challenge: 'challenge' } } })); }
    emit(x) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(x) })); }
    send(raw) { const m = JSON.parse(raw); if (m.op === 1) {
        identify = m;
        queueMicrotask(() => this.emit({ op: 2, d: { negotiatedRpcVersion: 1 } }));
    } if (m.op === 6)
        queueMicrotask(() => this.emit({ op: 7, d: { requestId: m.d.requestId, requestType: m.d.requestType, requestStatus: { result: true }, responseData: { outputActive: false } } })); }
    close() { this.dispatchEvent(new Event('close')); }
} const obs = new OBS(c, FakeWS); assert.deepEqual(await obs.call('GetStreamStatus'), { outputActive: false }); assert.equal(identify.d.rpcVersion, 1); assert.equal(identify.d.authentication, obsAuth('password', 'salt', 'challenge')); obs.close(); });
test('OBS prepare for Vampire Survivors: its own scene, the stage in the game layout, the game window over the frame; no stream changes', async (t) => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }), obs = new OBS(c), calls = [];
    obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [{ sceneName: c.obsScene }] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [{ sourceName: `${c.obsInput} (Vampire Survivors)`, sceneItemId: 1 }, { sourceName: 'Vampire Survivors Window', sceneItemId: 2 }] }
        : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [{ itemName: '[Google Chrome] Vampire Survivors - Steam', itemValue: 5 }, { itemName: '[Vampire Survivors] Vampire Survivors', itemValue: 35799 }] }
        : type === 'GetSpecialInputs' ? { desktop1: null, desktop2: null, mic1: 'マイク', mic2: null } : {}; };
    const r = await obs.prepare('http://127.0.0.1:8787');
    assert.equal(r.scene, `${c.obsScene} - Vampire Survivors`);
    assert.deepEqual(calls.find(x => x.type === 'CreateScene').data, { sceneName: r.scene }, 'a new scene; the Noa scene is not modified');
    const [stage, game] = calls.filter(x => x.type === 'CreateInput').map(x => x.data);
    assert.equal(stage.inputKind, 'browser_source'); assert.match(stage.inputSettings.url, /#token=.*&layout=game/); assert.equal(stage.sceneName, r.scene);
    assert.equal(game.inputKind, 'screen_capture'); assert.equal(game.inputSettings.type, 1, 'a window capture (ScreenCaptureKit)');
    assert.deepEqual(calls.find(x => x.type === 'SetInputSettings' && x.data.inputSettings.window).data.inputSettings, { window: 35799 }, 'pointed at the game window by name');
    assert.equal(r.window, '[Vampire Survivors] Vampire Survivors', 'never a browser tab that mentions the game');
    assert.deepEqual(calls.find(x => x.type === 'SetInputMute' && x.data.inputName === 'マイク').data, { inputName: 'マイク', inputMuted: true }, 'the global microphone never airs');
    assert.deepEqual(r.mutedGlobalAudio, ['マイク']);
    const tr = calls.find(x => x.type === 'SetSceneItemTransform').data;
    assert.equal(tr.sceneItemId, 2); assert.deepEqual([tr.sceneItemTransform.positionX, tr.sceneItemTransform.positionY, tr.sceneItemTransform.boundsWidth, tr.sceneItemTransform.boundsHeight], [48, 120, 1120, 630], 'matches .vs-frame in stage.css');
    assert.ok(!calls.some(x => ['StartStream', 'SetStreamServiceSettings', 'StartRecord'].includes(x.type)));
    assert.ok(!calls.some(x => x.data?.sceneName === c.obsScene && x.type !== 'GetSceneList'), 'nothing is added to the existing scene');
    assert.ok(!calls.some(x => x.data?.inputKind === 'sck_audio_capture'), 'no game sound unless VAMPIRE_GAME_AUDIO=true');
});
test('OBS prepare for Vampire Survivors with game sound: the game app audio, below the voice', async (t) => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_GAME_AUDIO: 'true' }), obs = new OBS(c), calls = [];
    obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [] } : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [] } : {}; };
    await obs.prepare('http://127.0.0.1:8787');
    const audio = calls.find(x => x.type === 'CreateInput' && x.data.inputKind === 'sck_audio_capture').data;
    assert.deepEqual(audio.inputSettings, { type: 1, application: 'com.poncle.VampireSurvivors' });
    assert.equal(calls.find(x => x.type === 'SetInputVolume').data.inputVolumeDb, -14);
});
test('the OBS output takes the voice over from a preview; a preview never takes it back from OBS', async (t) => {
    const a = await app(t);
    const preview = await (await a.req('/api/renderer/claim', { client: 'preview' }, a.c.viewToken)).json(); assert.ok(preview.acquired);
    const obs = await (await a.req('/api/renderer/claim', { client: 'obs', rendererKey: a.c.obsRendererToken }, a.c.viewToken)).json();
    assert.ok(obs.acquired, 'going live does not wait for the preview to be muted'); assert.equal(a.engine.renderer.role, "obs");
    assert.equal((await (await a.req('/api/renderer/claim', { client: 'preview' }, a.c.viewToken)).json()).acquired, false);
    assert.equal((await (await a.req('/api/renderer/claim', { client: 'other', rendererKey: 'wrong' }, a.c.viewToken)).json()).acquired, false, 'only the real OBS key takes over');
});
test('OBS prepare for Vampire Survivors with background music: the file looped, quiet, for the whole show', async (t) => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', OBS_BGM_FILE: '/music/loop.wav' }), obs = new OBS(c), calls = [];
    obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [] } : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [] } : {}; };
    await obs.prepare('http://127.0.0.1:8787');
    const bgm = calls.find(x => x.type === 'CreateInput' && x.data.inputName === 'Noa BGM').data;
    assert.equal(bgm.inputKind, 'ffmpeg_source'); assert.equal(bgm.inputSettings.local_file, '/music/loop.wav'); assert.equal(bgm.inputSettings.looping, true);
    assert.equal(calls.find(x => x.type === 'SetInputVolume' && x.data.inputName === 'Noa BGM').data.inputVolumeDb, -24);
    const none = new OBS(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' })), c2 = []; none.call = async (type, data) => { c2.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [] } : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [] } : {}; };
    await none.prepare('http://127.0.0.1:8787'); assert.ok(!c2.some(x => x.data?.inputName === 'Noa BGM'), 'no music unless a file is set');
});
test('HTTP OBS unreachable: a clear instruction instead of the bare socket error (2026-10-10 hung OBS WebSocket)', async t => {
    for (const message of ['OBS disconnected', 'OBS connection timeout']) {
        const obs = { close() {}, async stopOwned() {}, async prepare() { throw new Error(message); }, async setGameVisible() {} };
        const a = await app(t, { obs });
        const r = await a.req('/api/obs/prepare', {}); const body = await r.json();
        assert.equal(r.status, 503); assert.equal(body.code, 'OBS_UNREACHABLE'); assert.match(body.error, /OBSを再起動/);
    }
});
