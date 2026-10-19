// The local judge has no bypass (operator decision 2026-10-09): the regex-only mode (JEV_MODE=local / BYPASS_JEV /
// NO_JEV), its Studio toggle and the automatic fallback were removed. Only DEMO uses rule-based stand-ins; in live
// mode every line is judged, and a judge failure fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Jev, noul } from '../src/jev.mjs';
import { config } from '../src/config.mjs';
import { setup, ledger, audit, response } from './helpers.mjs';

const OFFLINE = 'http://127.0.0.1:9/v1'; // never a real service: every request goes to the injected fetchFn

test('live mode has no bypass: legacy bypass settings are ignored and there is no mode toggle', t => {
    for (const env of [{}, { JEV_MODE: 'local' }, { BYPASS_JEV: 'true' }, { NO_JEV: 'true' }, { JEV_FALLBACK: 'true' }]) {
        const c = setup(t, { MODE: 'live', LLM_MODEL: 'judge-model', LLM_BASE_URL: OFFLINE, ...env });
        const jev = new Jev(c, ledger(), audit, async () => { throw new Error('offline'); });
        assert.equal(jev.isBypassed, false, JSON.stringify(env));
        assert.deepEqual(jev.status(), { mode: 'local', model: 'judge-model', failures: 0, lastMs: null });
        assert.equal(jev.setMode, undefined); assert.equal(jev.fallbackActive, undefined);
    }
    const demo = new Jev(setup(t), ledger(), audit);
    assert.equal(demo.isBypassed, true); assert.equal(demo.status().mode, 'demo');
    assert.equal(config({ MODE: 'live', LLM_MODEL: 'm', JEV_MODE: 'local' }, [], false).bypassJev, undefined);
});

for (const [name, fetchFn] of [
    ['an unreachable judge', async () => { throw new TypeError('fetch failed'); }],
    ['an HTTP error', async () => response({}, 500)],
    ['non-JSON content', async () => response({ choices: [{ message: { content: 'はい、安全です。' } }] })],
    ['a missing answer key', async () => response({ choices: [{ message: { content: '{}' } }] })],
]) {
    test(`a judge failure fails closed (${name}): speech throws, a comment is neither answered nor read`, async t => {
        const c = setup(t, { MODE: 'live', LLM_MODEL: 'judge-model', LLM_BASE_URL: OFFLINE });
        let calls = 0; const jev = new Jev(c, ledger(), audit, async (...a) => { calls++; return fetchFn(...a); });
        await assert.rejects(jev.speech('こんばんは、今日もよろしくね。'));
        assert.equal(calls, 1, 'the judge was asked: nothing is aired unjudged');
        const r = await jev.chat('こんばんは！');
        assert.equal(calls, 2);
        assert.equal(r.accept, false); assert.equal(r.ackOnly, true); assert.equal(r.readAllowed, false); assert.equal(r.reason, 'judge_unavailable');
        assert.notEqual(r.provider, 'local-fallback'); assert.equal(jev.isBypassed, false);
        await assert.rejects(jev.ask({ x: 1 }, { ok: noul('Read x') }));
    });
}

test('without a judge model a live gate refuses instead of passing', async t => {
    const c = setup(t, { LLM_BASE_URL: OFFLINE }); c.mode = 'live';
    let calls = 0; const jev = new Jev(c, ledger(), audit, async () => { calls++; throw new Error('must not be called'); });
    await assert.rejects(jev.speech('こんばんは。'), /no model/);
    const r = await jev.chat('こんばんは！'); assert.equal(r.accept, false); assert.equal(r.readAllowed, false);
    assert.equal(calls, 0);
});

test('a fixed game line is gated by the local check only; generated talk still asks the judge', async t => {
    const { Jev } = await import('../src/jev.mjs');
    const { setup } = await import('./helpers.mjs');
    const c = setup(t, { MODE: 'live', LLM_MODEL: 'fixture', SHOW_PROFILE: 'talk' }); c.mode = 'live';
    let calls = 0;
    const jev = new Jev(c, { reserve() {} }, { log() {} }, async () => { calls++; throw new Error('judge unavailable'); });
    const fixed = await jev.speech('1分経過。まだまだいくよ。', undefined, [], { kind: 'autonomous', utterance: 'game_commentary', fixedLine: true, recentSpeech: [] });
    assert.equal(fixed.accept, true); assert.equal(calls, 0);
    assert.deepEqual(await jev.speech('連絡先 test@example.com です。', undefined, [], { kind: 'autonomous', utterance: 'game_commentary', fixedLine: true }), { accept: false, effect: 'none' });
    await assert.rejects(jev.speech('今日は何して遊ぼうかな。', undefined, [], { kind: 'autonomous', utterance: 'monologue', fixedLine: false, recentSpeech: [] }));
    assert.equal(calls, 1, 'generated talk asks the judge');
});
