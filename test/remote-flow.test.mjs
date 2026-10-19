// End-to-end LOCAL HTTP integration; dependencies and audio are fixtures, not real services.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createApp } from '../src/server.mjs';
import { setup, wav, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';
const options = { enabled: true, origin: 'https://studio.example.ts.net', users: ['owner@example.com'], port: 8788 };
function mobile(port, path, { headers = {}, data } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method: data ? 'POST' : 'GET', headers: {
            Host: 'studio.example.ts.net', 'Tailscale-User-Login': 'owner@example.com', 'Content-Type': 'application/json', ...headers } }, res => {
            let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
        }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
    });
}
test('local setup → real HTTP rehearsal → OBS-role WAV ACK → arm → private gateway start/stop', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    const providers = http.createServer(async (req, res) => {
        let input = ''; for await (const x of req) input += x; const body = input ? JSON.parse(input) : {};
        res.setHeader('Content-Type', 'application/json');
        const judged = req.url.endsWith('/chat/completions') && judgeRequest(body);
        if (judged) {
            const answers = Object.fromEntries(Object.entries(judged.questions).map(([k, q]) => [k,
                q.type === 'noul' ? { type: 'noul', noul: ['private', 'injection', 'warranted'].includes(k) ? 0 : 1 } : choiceAnswer(q.criteria, Object.keys(q.criteria)[0])]));
            return res.end(JSON.stringify(judgeResponse(answers)));
        }
        if (req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'こんにちは。夜の雑談を始めます。' } }] }));
        if (req.url.startsWith('/audio_query')) return res.end('{}');
        if (req.url.startsWith('/synthesis')) { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(.2)); }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => providers.listen(0, '127.0.0.1', r));
    const service = `http://127.0.0.1:${providers.address().port}`;
    Object.assign(c, { mode: 'live', allowStream: true, youtubeVideo: 'abcdefghijk', llmURL: service+'/v1', llmModel: 'fixture-model', voiceURL: service, port: 0 });
    let base = '', active = false, starts = 0;
    const obs = { owned: false, ready: true, close() {}, async call(name) {
        const settings = { url: `${base}/stage#token=${c.viewToken}&output=obs&rendererKey=${c.obsRendererToken}`, reroute_audio: true };
        return ({ GetStreamStatus: { outputActive: active, outputReconnecting: false }, GetCurrentProgramScene: { currentProgramSceneName: c.obsScene },
            GetInputSettings: { inputSettings: settings }, GetSceneItemId: { sceneItemId: 1 }, GetSceneItemEnabled: { sceneItemEnabled: true }, GetInputMute: { inputMuted: false },
            GetInputVolume: { inputVolumeMul: 1 }, GetStreamServiceSettings: { streamServiceType: 'rtmp_common', streamServiceSettings: { key: 'dummy-stream-secret', service: 'YouTube' } } })[name] || {};
    }, async start() { starts++; this.owned = true; active = true; }, async stopOwned() { if (this.owned) active = false; this.owned = false; } };
    const app = createApp(c, { obs, remoteOptions: options, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    await new Promise(r => app.remote.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data, token = c.adminToken) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    try {
        const consent = { confirm: 'ARM_VERIFIED_OUTPUT' };
        assert.equal((await req('/api/remote/arm', consent)).status, 409);
        const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json(); assert.equal(trial.ok, true);
        assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true })).status, 200);
        // A browser preview cannot satisfy the OBS-owned-output proof.
        const preview = await (await req('/api/renderer/claim', { client: 'preview' }, c.viewToken)).json();
        assert.equal(app.engine.renderer.role, 'preview');
        assert.equal((await req('/api/remote/arm', consent)).status, 409);
        await req('/api/renderer/release', { lease: preview.lease }, c.viewToken);
        const renderer = await (await req('/api/renderer/claim', { client: 'obs-fixture', rendererKey: c.obsRendererToken }, c.viewToken)).json();
        assert.equal(app.engine.renderer.role, 'obs');
        assert.equal((await req('/api/remote/arm', consent)).status, 409); // No WAV proof yet.
        assert.equal((await req('/api/control', { action: 'start' })).status, 200);
        const deadline = Date.now() + 3000;
        while (!app.engine.pending && Date.now() < deadline) await new Promise(r => setTimeout(r, 15));
        assert.equal(app.engine.pending?.kind, 'wav');
        const id = app.engine.pending.id;
        for (const event of ['started', 'ended']) {
            const ack = await (await req('/api/renderer/ack', { lease: renderer.lease, id, event }, c.viewToken)).json(); assert.equal(ack.ok, true);
        }
        await req('/api/control', { action: 'stop' });
        assert.equal((await req('/api/remote/arm', consent)).status, 200);
        const port = app.remote.server.address().port, session = await mobile(port, '/mobile/api/session');
        const headers = { Cookie: session.headers['set-cookie'][0].split(';')[0], Origin: options.origin, 'X-JVS-CSRF': session.body.csrf };
        const result = await mobile(port, '/mobile/api/action', { headers, data: { action: 'start', requestId: randomUUID(), confirm: 'START_BROADCAST', videoID: c.youtubeVideo } });
        assert.equal(result.status, 202); await app.remoteControl.task;
        assert.equal(app.engine.running, true); assert.equal(starts, 1); assert.equal(app.remoteControl.job.state, 'transmitting');
        const state = await mobile(port, '/mobile/api/state', { headers });
        assert.ok(!JSON.stringify(state).includes('dummy-stream-secret')); assert.ok(!JSON.stringify(state).includes(c.viewToken));
        const stopped = await mobile(port, '/mobile/api/action', { headers, data: { action: 'stop', requestId: randomUUID() } });
        assert.equal(stopped.status, 202); await app.remoteControl.task;
        assert.equal(app.engine.running, false); assert.equal(active, false); assert.equal(app.remoteControl.job.state, 'stopped');
    } finally { await app.close(); providers.closeAllConnections(); await new Promise(r => providers.close(r)); }
});

test('remote setup CLI is explicit, private, restart-required, and side-effect free for --help', t => {
    const c = setup(t);
    const run = args => spawnSync(process.execPath, ['scripts/remote-setup.mjs', ...args], { env: { ...process.env, DATA_DIR: c.dataDir }, encoding: 'utf8' });
    assert.equal(run(['--help']).status, 0); const path = `${c.dataDir}/remote-control.json`; assert.equal(existsSync(path), false);
    assert.equal(run(['--origin=https://studio.example.ts.net', '--user=owner@example.com']).status, 1); assert.equal(existsSync(path), false);
    const args = ['--origin=https://studio.example.ts.net', '--user=owner@example.com', '--confirm-private-network'];
    const done = run(args); assert.equal(done.status, 0, done.stderr); assert.match(done.stdout, /tailscale serve --bg/);
    assert.equal(JSON.parse(readFileSync(path)).enabled, true);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(run(args).status, 1); assert.equal(run([...args, '--replace']).status, 0);
    assert.equal(run(['--disable']).status, 0); assert.equal(JSON.parse(readFileSync(path)).enabled, false);
});
