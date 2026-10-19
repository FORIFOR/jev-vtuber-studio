// src/local-judge.mjs: the gate's typed questions answered by the local LLM. Every request goes to an injected fetchFn;
// the URLs below are never reached (a local Ollama may be running on the test machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { localJudge, toAnswers } from '../src/local-judge.mjs';
import { validateAnswers, noul, choice } from '../src/jev.mjs';
import { response, judgeRequest, judgeResponse } from './helpers.mjs';

const OLLAMA = { llmProvider: 'ollama', llmURL: 'http://127.0.0.1:9/v1', llmModel: 'conv-model' };
const COMPATIBLE = { llmProvider: 'compatible', llmURL: 'http://127.0.0.1:9/v1', llmModel: 'conv-model' };
const Q = { safe: noul('Is state.speech safe?'), route: choice('What does it need?', { reply: 'Conversation', research: 'Evidence', ignore: 'Spam' }) };
const STATE = { speech: 'こんばんは。' };

function capture(reply) {
    const calls = [];
    return { calls, fetchFn: async (u, o) => { calls.push({ u, o, body: JSON.parse(o.body) }); return response(typeof reply === 'function' ? reply() : reply); } };
}

test('Ollama: /api/chat with a JSON schema of exactly the question keys, think:false, temperature 0', async () => {
    const f = capture({ message: { content: JSON.stringify({ safe: .97, route: { choice: 'reply', confidence: .8 } }) } });
    const r = await localJudge(OLLAMA, STATE, Q, { fetchFn: f.fetchFn });
    assert.equal(f.calls.length, 1);
    const { u, o, body } = f.calls[0];
    assert.equal(u, 'http://127.0.0.1:9/api/chat', 'the /v1 suffix is dropped for the native API');
    assert.equal(o.method, 'POST'); assert.equal(o.redirect, 'error'); assert.equal(o.headers.Authorization, undefined);
    assert.equal(body.model, 'conv-model'); assert.equal(body.stream, false); assert.equal(body.think, false);
    assert.equal(body.options.temperature, 0);
    assert.deepEqual(body.format.required, ['safe', 'route']); assert.deepEqual(Object.keys(body.format.properties), ['safe', 'route']);
    assert.deepEqual(body.format.properties.safe, { type: 'number', minimum: 0, maximum: 1 });
    assert.deepEqual(body.format.properties.route.properties.choice.enum, ['reply', 'research', 'ignore']);
    assert.deepEqual(body.format.properties.route.required, ['choice', 'confidence']);
    assert.match(body.messages[0].content, /strict judge/); assert.match(body.messages[0].content, /untrusted/);
    const user = JSON.parse(body.messages[1].content);
    assert.deepEqual(user.state, STATE);
    assert.deepEqual(user.questions, { safe: { kind: 'probability', question: 'Is state.speech safe?', answer: 'probability that the answer to this question is YES' }, route: { kind: 'choice', question: 'What does it need?', options: Q.route.criteria } });
    assert.deepEqual(judgeRequest(body), { state: STATE, questions: Q }, 'the test helper decodes what the judge sends');
    assert.equal(r.answers.safe.noul, .97); assert.equal(r.answers.route.choice, 'reply');
    assert.deepEqual(Object.keys(validateAnswers(r, Q)), ['safe', 'route']);
});

test('OpenAI-compatible: /chat/completions with json_object, temperature 0, Authorization only with llmKey', async () => {
    const f = capture(judgeResponse({ safe: { type: 'noul', noul: .5 }, route: { type: 'choice', choice: 'research', confidence: .7 } }));
    const r = await localJudge(COMPATIBLE, STATE, Q, { fetchFn: f.fetchFn });
    const { u, o, body } = f.calls[0];
    assert.equal(u, 'http://127.0.0.1:9/v1/chat/completions');
    assert.equal(o.headers.Authorization, undefined); assert.equal(o.redirect, 'error');
    assert.equal(body.model, 'conv-model'); assert.equal(body.temperature, 0); assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.format, undefined); assert.equal(body.think, undefined);
    assert.deepEqual(judgeRequest(body), { state: STATE, questions: Q });
    assert.equal(validateAnswers(r, Q).route.choice, 'research');
    await localJudge({ ...COMPATIBLE, llmKey: 'k-secret' }, STATE, Q, { fetchFn: f.fetchFn });
    assert.equal(f.calls[1].o.headers.Authorization, 'Bearer k-secret');
});

test('judge settings override the conversation model, endpoint and provider', async () => {
    const f = capture({ message: { content: JSON.stringify({ safe: 1, route: { choice: 'ignore', confidence: 1 } }) } });
    await localJudge({ ...COMPATIBLE, judgeModel: 'judge-model', judgeURL: 'http://127.0.0.1:8/v1', judgeProvider: 'ollama' }, STATE, Q, { fetchFn: f.fetchFn });
    assert.equal(f.calls[0].u, 'http://127.0.0.1:8/api/chat'); assert.equal(f.calls[0].body.model, 'judge-model');
});

test('a fenced JSON reply is accepted', async () => {
    const f = capture({ choices: [{ message: { content: '```json\n{"safe": 0.9, "route": {"choice": "reply", "confidence": 0.9}}\n```' } }] });
    assert.equal((await localJudge(COMPATIBLE, STATE, Q, { fetchFn: f.fetchFn })).answers.safe.noul, .9);
});

test('toAnswers: a low-confidence choice stays the argmax and validateAnswers accepts it; confidence is kept as stated', () => {
    for (const confidence of [0, .1, .2, .34, .5, .9, 1]) {
        const r = toAnswers({ safe: .3, route: { choice: 'ignore', confidence } }, Q);
        const v = validateAnswers(r, Q);
        assert.equal(v.route.choice, 'ignore'); assert.equal(v.route.confidence, confidence);
        const p = v.route.probabilities;
        assert.deepEqual(Object.keys(p), ['reply', 'research', 'ignore']);
        assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 1e-9);
        assert.ok(p.ignore >= Math.max(...Object.values(p)), `argmax at confidence ${confidence}`);
        assert.deepEqual(v.safe, { type: 'noul', noul: .3 });
    }
    const one = { only: choice('One option', { yes: 'Yes' }) };
    assert.deepEqual(validateAnswers(toAnswers({ only: { choice: 'yes', confidence: .2 } }, one), one).only.probabilities, { yes: 1 });
});

test('missing or invalid keys, non-JSON content and unknown question types throw', async () => {
    for (const raw of [null, 'x', {}, { safe: .9 }, { route: { choice: 'reply', confidence: .9 } }, { safe: 1.2, route: { choice: 'reply', confidence: .9 } },
        { safe: '0.9', route: { choice: 'reply', confidence: .9 } }, { safe: .9, route: { choice: 'delete', confidence: .9 } },
        { safe: .9, route: { choice: 'reply', confidence: -1 } }, { safe: .9, route: { choice: 'reply' } }, { safe: .9, route: 'reply' }])
        assert.throws(() => toAnswers(raw, Q), /Local judge/, JSON.stringify(raw));
    for (const content of ['はい、安全です。', '', null, '{"safe": 0.9, ']) {
        const f = capture({ choices: [{ message: { content } }] });
        await assert.rejects(localJudge(COMPATIBLE, STATE, Q, { fetchFn: f.fetchFn }), /invalid JSON|Local judge/, String(content));
    }
    await assert.rejects(localJudge(COMPATIBLE, STATE, Q, { fetchFn: async () => response({ choices: [] }) }), /Local judge/);
    await assert.rejects(localJudge(OLLAMA, STATE, Q, { fetchFn: async () => response({}) }), /Local judge/);
    await assert.rejects(localJudge(COMPATIBLE, STATE, Q, { fetchFn: async () => response({}, 500) }), /HTTP 500/);
    await assert.rejects(localJudge(OLLAMA, STATE, { energy: { type: 'score', instructions: 'Energy', criteria: ['low', 'high'] } }, { fetchFn: async () => { throw new Error('must not be called'); } }), /cannot answer score/);
});

test('no model, or a Gemini conversation model without a local judge, throws before any request', async () => {
    let calls = 0; const fetchFn = async () => { calls++; throw new Error('must not be called'); };
    await assert.rejects(localJudge({ ...COMPATIBLE, llmModel: '' }, STATE, Q, { fetchFn }), /no model/);
    await assert.rejects(localJudge({ llmProvider: 'gemini', llmURL: 'http://127.0.0.1:9/v1', llmModel: 'gemini-x' }, STATE, Q, { fetchFn }), /Ollama or OpenAI-compatible/);
    assert.equal(calls, 0);
});

test('the judge timeout and the caller signal abort the request', async () => {
    // AbortSignal.timeout's timer does not keep Node alive: with nothing else pending (CI on Linux) the run ended before
    // it fired (cancelledByParent). The server keeps the loop alive in production; this test holds it for its duration.
    const keepAlive = setInterval(() => { }, 1000);
    try {
        const hang = (_u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason), { once: true }));
        await assert.rejects(localJudge({ ...COMPATIBLE, judgeTimeoutMs: 20 }, STATE, Q, { fetchFn: hang }), e => e.name === 'TimeoutError');
        const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
        await assert.rejects(localJudge(COMPATIBLE, STATE, Q, { fetchFn: hang, signal: ac.signal }), e => e.name === 'AbortError');
    } finally { clearInterval(keepAlive); }
});
