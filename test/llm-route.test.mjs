import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmRoute } from '../src/llm-route.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, body: { cancel: async () => { } } });
const conf = extra => ({ llmURL: 'http://127.0.0.1:11434/v1', llmModel: 'qwen3.5:4b', judgeModel: '', llmRemoteURL: 'http://rtx.local:11434/v1', llmRemoteModel: 'qwen3.5:14b', ...extra });

test('without a remote machine nothing changes', async () => {
    const c = conf({ llmRemoteURL: '' }), calls = [];
    const r = new LlmRoute(c, { fetchFn: async url => { calls.push(url); return json({}); } });
    assert.equal(r.configured, false); await r.probe();
    assert.equal(c.llmModel, 'qwen3.5:4b'); assert.deepEqual(calls, []);
});

test('a remote machine that answers with its model is used for generation and the judge', async () => {
    const c = conf({ judgeModel: 'qwen3.5:4b' });
    const r = new LlmRoute(c, { fetchFn: async () => json({ models: [{ name: 'qwen3.5:14b' }] }) });
    const st = await r.probe();
    assert.equal(st.active, 'remote'); assert.equal(c.llmURL, 'http://rtx.local:11434/v1'); assert.equal(c.llmModel, 'qwen3.5:14b'); assert.equal(c.judgeModel, 'qwen3.5:14b');
});

test('a missing model or no answer keeps the local model and waits before probing again', async () => {
    let t = 0; const c = conf(); let probes = 0;
    const r = new LlmRoute(c, { now: () => t, retryMs: 1000, fetchFn: async () => { probes++; return json({ models: [{ name: 'llama3:8b' }] }); } });
    let st = await r.probe(); assert.equal(st.active, 'local'); assert.match(st.lastError, /not installed/); assert.equal(c.llmModel, 'qwen3.5:4b');
    await r.probe(); assert.equal(probes, 1, 'not probed again before retryMs');
    t = 1500; await r.probe(); assert.equal(probes, 2);
});

test('a request the remote machine cannot take goes to the local model at once, with the local model name', async () => {
    const c = conf(), sent = [];
    const r = new LlmRoute(c, { fetchFn: async (url, o = {}) => {
        if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.5:14b' }] });
        sent.push([url, o.body && JSON.parse(o.body).model]);
        if (url.startsWith('http://rtx.local')) throw new TypeError('fetch failed');
        return json({ message: { content: 'ok' } });
    } });
    await r.probe(); assert.equal(r.active, 'remote');
    const res = await r.fetch('http://rtx.local:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: 'qwen3.5:14b' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [['http://rtx.local:11434/api/chat', 'qwen3.5:14b'], ['http://127.0.0.1:11434/api/chat', 'qwen3.5:4b']]);
    assert.equal(r.active, 'local'); assert.equal(c.llmModel, 'qwen3.5:4b');
});

test('a remote timeout marks it down; a caller abort does not', async () => {
    const c = conf();
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' }), abort = Object.assign(new Error('a'), { name: 'AbortError' });
    let next = abort;
    const r = new LlmRoute(c, { fetchFn: async url => { if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.5:14b' }] }); throw next; } });
    await r.probe();
    const ac = new AbortController(); ac.abort();
    await assert.rejects(r.fetch('http://rtx.local:11434/api/chat', { body: '{}', signal: ac.signal }), /a/); assert.equal(r.active, 'remote');
    next = timeout;
    await assert.rejects(r.fetch('http://rtx.local:11434/api/chat', { body: '{}' }), /t/); assert.equal(r.active, 'local');
});
