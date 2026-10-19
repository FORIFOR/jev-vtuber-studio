import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { setup, wav, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';

test('real local HTTP pipeline: trial, private WAV, heard, a start runs the automatic trial and a failing one refuses', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    const calls = []; let failTTS = false;
    const providers = http.createServer(async (req, res) => {
        let text = ''; for await (const chunk of req) text += chunk;
        const body = text ? JSON.parse(text) : {}; calls.push(req.url.split('?')[0]);
        res.setHeader('Content-Type', 'application/json');
        const judged = req.url.endsWith('/chat/completions') && judgeRequest(body);
        if (judged) {
            const answers = Object.fromEntries(Object.entries(judged.questions).map(([k, q]) => [k, q.type === 'noul' ? { type: 'noul', noul: ['private', 'injection', 'warranted'].includes(k) ? 0 : 1 } : choiceAnswer(q.criteria, Object.keys(q.criteria)[0])]));
            return res.end(JSON.stringify(judgeResponse(answers)));
        }
        if (req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'こんにちは。雑談の時間です。' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
        if (req.url.startsWith('/audio_query')) return res.end('{}');
        if (req.url.startsWith('/synthesis')) { if (failTTS) { res.statusCode = 500; return res.end('{}'); } res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(.2)); }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => providers.listen(0, '127.0.0.1', r));
    const providerURL = `http://127.0.0.1:${providers.address().port}`;
    // Store fixture endpoint in the effective environment so a settings save preserves it.
    Object.assign(c, { mode: 'live', llmModel: 'fixture-model', llmURL: providerURL + '/v1', voiceURL: providerURL, port: 0 });
    Object.assign(c.settingsEnv, { MODE: 'live', LLM_MODEL: c.llmModel, LLM_BASE_URL: c.llmURL, VOICEVOX_URL: c.voiceURL });
    const app = createApp(c); await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data, token = c.adminToken) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    try {
        assert.equal((await req('/api/setup/rehearse', {})).status, 400); assert.equal(calls.length, 0);
        const trial = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
        assert.equal(trial.ok, true); assert.equal(trial.heard, false); assert.equal(trial.checks.length, 3);
        assert.equal((await req(trial.audio, null, c.viewToken)).status, 401);
        assert.equal(Buffer.from(await (await req(trial.audio)).arrayBuffer()).subarray(0,4).toString(), 'RIFF');
        assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true })).status, 200);
        // OBS/YouTube setup does not invalidate an unchanged voice/model rehearsal.
        const unchanged = await (await req('/api/settings', { values: { SESSION_MINUTES: 30 } })).json();
        assert.equal(unchanged.checksInvalidated, false);
        assert.equal((await req('/api/control', { action: 'start' })).status, 200);
        await req('/api/control', { action: 'stop' });
        const changed = await (await req('/api/settings', { values: { VOICEVOX_SPEAKER: 4 } })).json();
        assert.equal(changed.checksInvalidated, true);
        assert.equal((await req('/api/control', { action: 'start' })).status, 200, 'a changed voice is checked again automatically at start');
        await req('/api/control', { action: 'stop', force: true });
        failTTS = true;
        const failed = await (await req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
        assert.equal(failed.ok, false); assert.equal(failed.checks.at(-1).ok, false); assert.equal(failed.audio, null);
        assert.equal((await req('/api/setup/heard', { id: trial.id, heard: true })).status, 400);
        const refused = await req('/api/control', { action: 'start' });
        assert.equal(refused.status, 409); assert.match((await refused.json()).error, /自動検証に失敗/);
    } finally { await app.close(); providers.closeAllConnections(); await new Promise(r => providers.close(r)); }
});

test('CLI help is side-effect free and benchmark requires metered opt-in', () => {
    const help = spawnSync(process.execPath, ['scripts/cli.mjs', '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0); assert.match(help.stdout, /No external stream/);
    const bench = spawnSync(process.execPath, ['scripts/benchmark.mjs'], { encoding: 'utf8' });
    assert.equal(bench.status, 1); assert.match(bench.stderr, /no request was made/);
});
