import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Jev, readBillingHold, billingHoldPath, controllerHoldPath, writeBillingHold } from '../src/jev.mjs';
import { Ledger } from '../src/store.mjs';
import { GameRunner } from '../src/game-runner.mjs';
import { setup, judgeRequest, judgeResponse, choiceAnswer } from './helpers.mjs';

// The Studio no longer calls a paid API (local judge, 2026-10-09): only a game controller keeps its own HTTP 402 hold
// (<GAME_DIR>/.local/jev-payment-hold.json), and that hold still blocks launching the controller and starting the show.
const OFFLINE = 'http://127.0.0.1:9/v1'; // requests only reach the injected fetchFn / nothing real
const live = (t, env = {}) => { const c = setup(t, { MODE: 'live', LLM_MODEL: 'judge-model', LLM_BASE_URL: OFFLINE, VOICEVOX_URL: 'http://127.0.0.1:9', ...env }); return c; };
const NOUL = { private: .01, injection: .01, warranted: .1 };
const okAnswer = (_url, options) => {
    const { questions } = judgeRequest(JSON.parse(options.body));
    const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'noul' ? { type: 'noul', noul: NOUL[k] ?? .97 } : choiceAnswer(q.criteria, Object.keys(q.criteria)[0])]));
    return new Response(JSON.stringify(judgeResponse(answers)), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('a 402 from the judge endpoint writes no hold: that line fails closed and the next one is judged again', async t => {
    const c = live(t); let status = 402, calls = 0;
    const jev = new Jev(c, new Ledger(c.dataDir, c.limits), { log() {} }, async (...a) => { calls++; return status === 402 ? new Response('{}', { status }) : okAnswer(...a); });
    let ended = null; jev.onCreditEnd = reason => { ended = reason; };
    await assert.rejects(jev.speech('こんばんは。', AbortSignal.timeout(2000)), /HTTP 402/);
    assert.equal(ended, null); assert.equal(existsSync(billingHoldPath(c.dataDir)), false); assert.equal(readBillingHold(c), null);
    status = 200;
    assert.equal((await jev.speech('こんばんは、今日もよろしくね。', AbortSignal.timeout(2000))).accept, true);
    assert.equal(calls, 2);
});

test("a leftover Studio hold file (from the remote-Jev era) is no longer a hold", t => {
    const c = live(t); writeBillingHold(c, 'studio_http_402');
    assert.ok(existsSync(billingHoldPath(c.dataDir))); assert.equal(readBillingHold(c), null);
});

test("the controller's hold stops the Studio launching it", t => {
    const c = live(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }); c.gameDir = join(c.dataDir, 'controller');
    mkdirSync(join(c.gameDir, '.local'), { recursive: true });
    writeFileSync(controllerHoldPath(c.gameDir), JSON.stringify({ held_at: '2026-10-03T15:53:36Z', reason: 'run_http_402' }));
    let spawned = 0; const r = new GameRunner(c, { spawnFn: () => { spawned++; return new EventEmitter(); } });
    assert.equal(r.start(), false); assert.equal(spawned, 0); assert.match(r.status().detail, /HTTP 402/);
    assert.deepEqual(readBillingHold(c), { source: 'game', heldAt: '2026-10-03T15:53:36Z', reason: 'run_http_402' });
    // Without a hold the controller launches; its own 402 marker fails the run.
    rmSync(controllerHoldPath(c.gameDir));
    const child = Object.assign(new EventEmitter(), { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    const r2 = new GameRunner(c, { spawnFn: () => child }); assert.ok(r2.start());
    child.stdout.emit('data', 'auto_session failed: Jevの支払い・クレジット確認が必要です（HTTP 402）\n');
    assert.equal(r2.status().state, 'failed'); assert.match(r2.status().detail, /HTTP 402/);
});

test('HTTP: a controller hold refuses a live start; readiness shows the controller hold and no Jev key', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = live(t, { SHOW_PROFILE: 'talk' }); c.port = 0; c.gameDir = join(c.dataDir, 'controller');
    mkdirSync(join(c.gameDir, '.local'), { recursive: true });
    writeFileSync(controllerHoldPath(c.gameDir), JSON.stringify({ held_at: '2026-10-03T15:53:36Z', reason: 'run_http_402' }));
    const obs = { ready: false, owned: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() {}, async connect() { throw new Error('no OBS'); } };
    const a = createApp(c, { obs }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    let closed = false; const close = async () => { if (closed) return; closed = true; a.engine.stop('test'); await a.close(); }; t.after(close);
    const url = `http://127.0.0.1:${a.server.address().port}`, H = { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' };
    const start = await fetch(url + '/api/control', { method: 'POST', headers: H, body: JSON.stringify({ action: 'start' }) });
    assert.equal(start.status, 409); assert.match((await start.json()).error, /HTTP 402/); assert.equal(a.engine.running, false);
    const ids = (await (await fetch(url + '/api/readiness', { headers: H })).json()).steps.map(s => s.id);
    assert.ok(ids.includes('judge')); assert.ok(!ids.includes('jev'));
    // The game controller's hold is shown (with the clear button in the setup page) only while it exists.
    assert.ok(ids.includes('jevBilling'));
    rmSync(controllerHoldPath(c.gameDir)); writeBillingHold(c, 'studio_http_402');
    const again = await fetch(url + '/api/control', { method: 'POST', headers: H, body: JSON.stringify({ action: 'start' }) });
    assert.doesNotMatch((await again.json()).error || '', /HTTP 402/, 'a Studio-side record alone does not hold the show');
    await close();
});

test('HTTP: the operator can clear the controller hold', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = live(t, { SHOW_PROFILE: 'talk' }); c.port = 0; c.gameDir = join(c.dataDir, 'controller');
    mkdirSync(join(c.gameDir, '.local'), { recursive: true });
    writeFileSync(controllerHoldPath(c.gameDir), JSON.stringify({ held_at: '2026-10-03T15:53:36Z', reason: 'run_http_402' }));
    const obs = { ready: false, owned: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() {}, async connect() { throw new Error('no OBS'); } };
    const a = createApp(c, { obs }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    t.after(async () => { a.engine.stop('test'); await a.close(); });
    const url = `http://127.0.0.1:${a.server.address().port}`, H = { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' };
    const r = await fetch(url + '/api/setup/jev-hold', { method: 'POST', headers: H, body: JSON.stringify({ action: 'clear' }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).hold, null);
    assert.equal(readBillingHold(c), null);
});
