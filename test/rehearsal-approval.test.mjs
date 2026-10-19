// LOCAL HTTP integration with fixture providers: a start runs the automatic trial (no 「聞こえた」 press needed,
// operator 2026-10-10); an operator's "heard it" is still remembered per configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server.mjs';
import { setup, wav, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';

async function providers(t, { failVoice = false } = {}) {
    const state = { failVoice };
    const server = http.createServer(async (req, res) => {
        let input = ''; for await (const x of req) input += x; const body = input ? JSON.parse(input) : {};
        res.setHeader('Content-Type', 'application/json');
        const judged = req.url.endsWith('/chat/completions') && judgeRequest(body);
        if (judged) {
            const answers = Object.fromEntries(Object.entries(judged.questions).map(([k, q]) => [k,
                q.type === 'noul' ? { type: 'noul', noul: ['private', 'injection', 'warranted'].includes(k) ? 0 : 1 } : choiceAnswer(q.criteria, Object.keys(q.criteria)[0])]));
            return res.end(JSON.stringify(judgeResponse(answers)));
        }
        if (req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'こんにちは。夜の雑談を始めます。' } }] }));
        if (state.failVoice && (req.url.startsWith('/audio_query') || req.url.startsWith('/synthesis'))) { res.statusCode = 503; return res.end('{}'); }
        if (req.url.startsWith('/audio_query')) return res.end('{}');
        if (req.url.startsWith('/synthesis')) { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(.2)); }
        res.statusCode = 404; res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}`, state };
}

async function studio(t, c) {
    const obs = { owned: false, ready: true, close() {}, async call() { return {}; }, async start() {}, async stopOwned() {} };
    const app = createApp(c, { obs, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    return { app, req, close: async () => { await req('/api/control', { action: 'stop' }); await app.close(); } };
}

test('no 「聞こえた」 press is needed: every start runs the automatic trial; a failing one never starts the show', async t => {
    const p = await providers(t);
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false' });
    Object.assign(c, { mode: 'live', llmURL: p.url + '/v1', llmModel: 'fixture-model', voiceURL: p.url, port: 0 });

    const first = await studio(t, c);
    assert.equal((await (await first.req('/api/session')).json()).rehearsalApproved, false, 'never heard');
    assert.equal((await first.req('/api/control', { action: 'start' })).status, 200, 'the automatic trial passed: the show starts');
    assert.equal(first.app.engine.running, true);
    await first.close();

    p.state.failVoice = true;
    const second = await studio(t, c);
    const failed = await second.req('/api/control', { action: 'start' });
    assert.equal(failed.status, 409); assert.match((await failed.json()).error, /自動検証に失敗/);
    assert.equal(second.app.engine.running, false, 'a failing automatic trial never starts the show');
    await second.close();
    p.state.failVoice = false;

    c.speaker = 99; // a different voice: checked again automatically, no listening asked
    const third = await studio(t, c);
    assert.equal((await third.req('/api/control', { action: 'start' })).status, 200);
    await third.close();
});

test('every heard setting stays approved on its own: switching back needs no new listening, a new setting does', async t => {
    const p = await providers(t);
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false' });
    Object.assign(c, { mode: 'live', llmURL: p.url + '/v1', llmModel: 'fixture-model', voiceURL: p.url, port: 0 });
    const hear = async () => { const s = await studio(t, c); const trial = await (await s.req('/api/setup/rehearse', { confirm: 'RUN_CHECK' })).json();
        assert.equal((await s.req('/api/setup/heard', { id: trial.id, heard: true })).status, 200); await s.close(); };
    const approved = async () => { const s = await studio(t, c); const v = (await (await s.req('/api/session')).json()).rehearsalApproved; await s.close(); return v; };
    const original = c.speaker;
    await hear();
    c.speaker = 77; assert.equal(await approved(), false, 'a new voice was never heard');
    await hear();
    c.speaker = original; assert.equal(await approved(), true, 'back to the first voice: already heard');
    c.speaker = 77; assert.equal(await approved(), true, 'and the second one too');
    c.speaker = 78; assert.equal(await approved(), false, 'a third voice still must be heard');
});
