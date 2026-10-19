import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Conversation } from '../src/providers.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { RemoteControl } from '../src/remote-control.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';
// The long goodbye (CLOSING_SECONDS, operator 2026-10-10): the show never ends on one line; it closes over about two
// minutes at a natural break, answers goodbye comments in between, and a normal stop says it first.
const approved = { accept: true, effect: 'none', mood: 'warm' };
function fixture(t, env = {}, overrides = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', CLOSING_SECONDS: '120', ...env });
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => approved },
        conversation: new Conversation(c, ledger()), voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        research: { search: async () => { throw new Error('no search'); } }, ...overrides });
    t.after(() => e.stop('test')); return active(e);
}
async function nextPart(e) {
    for (let n = 0; n < 30 && e.running && !e.pending; n++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        if (!e.pending && e.preparationTask) await e.preparationTask;
        await new Promise(r => setImmediate(r));
    }
    return e.pending;
}
function ack(e) {
    const p = e.pending;
    if (!p.started) assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'started' }), true);
    assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'ended' }), true);
}
async function open(e) { while (!e.director.opened) { await nextPart(e); ack(e); } }
/** Play one whole turn (every part); its text, or null when nothing was ready. */
async function say(e) {
    if (!await nextPart(e)) return null;
    const turn = e.currentTurn; let text = '';
    while (e.pending) { text += e.pending.text; ack(e); if (e.currentTurn !== turn) break; await nextPart(e); }
    return text;
}
const due = e => { e.farewell.startedAt = Date.now() - 10 * 60000; e.generationRetryAt = 0; };

test('farewell: a stop request says a goodbye of several fixed lines in order, then the show ends as completed', async t => {
    const e = fixture(t), stops = [];
    e.on('stopped', r => stops.push(r));
    await open(e);
    const endAt = e.endAt;
    e.requestClose('operator');
    assert.equal(e.farewell.reason, 'operator'); assert.ok(e.farewell.lines.length >= 6);
    assert.ok(e.endAt >= Date.now() + 120000, 'the session limit waits for the goodbye'); assert.ok(e.endAt > endAt);
    due(e);
    const heard = [];
    while (e.running && heard.length < 20) { const p = await nextPart(e); if (!p) break; heard.push(p.text); ack(e); }
    assert.equal(e.running, false); assert.deepEqual(stops, ['show_completed']);
    const said = e.farewell.lines.map(l => l.text);
    assert.equal(heard.join(''), said.join(''), 'every line, in order, once');
    assert.match(said[0], /締め/); assert.match(said.at(-1), /おやすみ/);
    assert.equal(e.markers.filter(m => m.kind === 'closing').length, said.length);
});

test('farewell: a game show ends the game in the first line, then recaps on the talk screen; each aired line publishes its step', async t => {
    const e = fixture(t);
    await open(e);
    e.c.game = { title: 'Vampire Survivors' };
    const lines = e.farewellLines('time').map(l => l.text);
    assert.match(lines[0], /ゲームは.*終わりにしようか/); assert.match(lines[1], /振り返り/);
    assert.match(e.farewellLines('round_end')[0].text, /ゲームは終わりにしようか/);
    e.c.game = null; assert.match(e.farewellLines('time')[0].text, /締め/, 'a talk show keeps its own lead');
    e.c.game = { title: 'Vampire Survivors' };
    const steps = []; e.on('event', ev => { if (ev.type === 'state' && ev.data.farewell) steps.push(ev.data.farewell.step); });
    e.requestClose('time'); due(e);
    assert.match(await say(e), /ゲームは.*終わりにしようか/);
    assert.ok(steps.includes(1), 'step 1 is published once the first line has aired (the server then leaves the game screen)');
});
test('farewell: lines are spread over the goodbye (nothing is said before its time slot)', async t => {
    const e = fixture(t);
    await open(e);
    e.requestClose('time');
    assert.match(e.farewell.lines[0].text, /時間/);
    assert.equal(await say(e), e.farewell.lines[0].text, 'slot 0 is now');
    assert.equal(e.farewell.step, 1);
    assert.equal(await nextPart(e), null, 'the second line waits for its slot');
    assert.equal(e.running, true);
    due(e);
    assert.equal(await say(e), e.farewell.lines[1].text);
});

test('farewell: a goodbye comment is answered between the lines (as a reply, not a closing line)', async t => {
    const e = fixture(t);
    await open(e);
    e.requestClose('operator'); await say(e);
    const r = e.ingest({ id: 'c1', text: 'おつかれさま！', author: 'v', source: 'youtube' });
    assert.equal(r.accepted, true, 'comments are still taken during the goodbye');
    for (let n = 0; n < 10 && !e.candidates.length; n++) await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.candidates.length, 1);
    const p = await nextPart(e);
    assert.ok(p, 'the reply is not held to the goodbye slots');
    assert.equal(e.currentTurn.kind, 'reply'); ack(e);
    assert.equal(e.running, true); assert.equal(e.director.closed, false); assert.equal(e.farewell.step, 1);
    // The last line takes no more comments.
    e.farewell.step = e.farewell.lines.length - 1;
    assert.equal(e.ingest({ id: 'c2', text: 'またね', author: 'v', source: 'youtube' }).accepted, false);
});

test('farewell: a refused line is skipped; a refused last line still ends the show', async t => {
    const e = fixture(t);
    await open(e);
    e.requestClose('operator');
    const stall = Object.assign(new Error('x'), { reason: 'unsafe', code: 'GATE_REJECTED' });
    assert.equal(e.handleStall(stall, 'closing', e.metrics, 'stop', 'closing'), false);
    assert.equal(e.farewell.step, 1); assert.equal(e.running, true);
    e.farewell.step = e.farewell.lines.length - 1;
    assert.equal(e.handleStall(stall, 'closing', e.metrics, 'stop', 'closing'), true);
    assert.equal(e.running, false);
});

test('farewell: near the end the goodbye waits for a round to end; without a break it starts in time', async t => {
    const e = fixture(t);
    let brk = false; e.blocks = { atBreak: () => brk, farewell: () => [], status: () => ({}) };
    e.endAt = Date.now() + 9 * 60000; e.monitor();
    assert.equal(e.director.closing, false, 'mid-round: keep playing');
    brk = true; e.monitor();
    assert.equal(e.farewell?.reason, 'round_end');
    const f = fixture(t); f.blocks = { atBreak: () => false, farewell: () => [], status: () => ({}) };
    f.endAt = Date.now() + 11 * 60000; f.monitor(); assert.equal(f.director.closing, false);
    f.endAt = Date.now() + 149000; f.monitor();
    assert.equal(f.farewell?.reason, 'time');
});

test('farewell: CLOSING_SECONDS=0 keeps the single closing line', async t => {
    const e = fixture(t, { CLOSING_SECONDS: '0' });
    await open(e);
    e.requestClose();
    assert.equal(e.farewell, null);
    await say(e);
    assert.equal(e.running, false);
});

test('farewell: Vampire Survivors recap uses finished runs only, and a break is after the result and review', () => {
    const s = new VampireShow({ lobbyMinutes: 0 });
    s.start();
    assert.deepEqual(s.farewell(), []);
    s.night = { rounds: 3, bestSeconds: 312, bestLevel: 21, bestWeapons: ['ムチ', 'ナイフ', '聖水'] };
    const lines = s.farewell();
    assert.match(lines[0].text, /3回プレイ.*5分12秒.*レベルは21/); assert.match(lines[1].text, /武器が3つ/);
    for (const l of lines) assert.ok(l.text.length <= 110 && (l.text.match(/[。！？]/g) || []).length <= 2);
    s.phase = 'playing'; assert.equal(s.atBreak(), false);
    s.phase = 'between'; s.review = { reviewCompletedAt: null, failed: false }; assert.equal(s.atBreak(), false);
    s.review.reviewCompletedAt = Date.now(); assert.equal(s.atBreak(), true);
});

test('farewell: a remote stop says goodbye first and stops OBS after the show ended; a second stop cuts it short', async () => {
    let time = 1000000, pauses = 0;
    const e = new EventEmitter(); Object.assign(e, { running: true, panic: false, endAt: time + 200000, director: { closing: false }, closeReasons: [],
        farewellMs: () => 120000, requestClose(r) { this.director.closing = true; this.closeReasons.push(r); }, stop(r) { this.running = false; this.stopReason = r; }, emergency() { this.running = false; } });
    const obsCalls = [];
    const obs = { owned: true, async call(name) { return name === 'GetStreamStatus' ? { outputActive: false, outputReconnecting: false } : {}; }, async stopOwned() { obsCalls.push(e.running ? 'while_running' : 'after_show'); this.owned = false; } };
    const controller = new RemoteControl({ c: { mode: 'live' }, engine: e, obs, fingerprint: () => 'x', verified: () => true, outputVerified: () => true,
        setupBusy: () => false, waitForStop: async () => {}, localOrigin: () => '', now: () => time,
        pause: async () => { time += 250; if (++pauses === 4 && e.closeReasons.length === 1) e.running = false; } });
    controller.stop({ requestId: randomUUID() });
    assert.deepEqual(e.closeReasons, ['remote_operator']); assert.equal(e.running, true, 'still saying goodbye');
    await controller.task;
    assert.equal(e.running, false); assert.equal(e.stopReason, undefined, 'ended by the goodbye, not cut');
    assert.equal(obsCalls[0], 'after_show');
    // During a goodbye a second stop is immediate.
    e.running = true; obs.owned = true;
    controller.stop({ requestId: randomUUID() });
    assert.equal(e.running, false); assert.equal(e.stopReason, 'remote_operator');
    await controller.task;
});

test('farewell: overrunning its grace still ends as a completed show; a cloud voice low on budget goes to the last line', async t => {
    const e = fixture(t), stops = [];
    e.on('stopped', r => stops.push(r));
    await open(e);
    e.requestClose('operator');
    e.endAt = Date.now() - 1; e.monitor();
    assert.deepEqual(stops, ['show_completed']);
    const f = fixture(t);
    await open(f);
    f.requestClose('operator'); due(f);
    let left = 1; f.cloudSpend = () => ({ remaining: () => left, release() {}, hold() {} });
    assert.equal(await say(f), f.farewell.lines[0].text);
    left = .001; due(f);
    assert.equal(await say(f), f.farewell.lines.at(-1).text);
});

test('farewell over HTTP: stop says goodbye first; stop again, or force, ends at once', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', CLOSING_SECONDS: '120' }); c.port = 0;
    const app = createApp(c); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const control = body => fetch(base + '/api/control', { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    active(app.engine); app.engine.director.opened = true;
    const first = await control({ action: 'stop' });
    assert.equal(first.running, true); assert.equal(first.farewell.reason, 'operator');
    const second = await control({ action: 'stop' });
    assert.equal(second.running, false);
    active(app.engine);
    assert.equal((await control({ action: 'stop', force: true })).running, false, 'force skips the goodbye');
});

test('the goodbye says tonight\'s goal, whether it was reached, and if not why, from finished runs only', t => {
    const e = fixture(t); e.c.game = { id: 'vampire-survivors', title: 'Vampire Survivors' }; e.c.gameGoal = '最終ステージ・ユーダイモニアMへ';
    e.blocks = { atBreak: () => true, farewell: () => [], status: () => ({}), goalResult: marked => ({ reached: marked ?? false, rounds: 3, bestSeconds: 1519, bestLevel: 29, clock: '25:19' }) };
    let lines = e.farewellLines('time').map(l => l.text);
    assert.ok(lines.includes('今日の目標は「最終ステージ・ユーダイモニアMへ」だったね。'));
    assert.ok(lines.some(l => /届かなかった.*3回挑戦.*25:19・レベル29/.test(l)));
    assert.ok(lines.some(l => /原因/.test(l)));
    e.c.gameGoalReached = true; lines = e.farewellLines('time').map(l => l.text);
    assert.ok(lines.some(l => /達成できた/.test(l))); assert.ok(!lines.some(l => /原因/.test(l)));
    e.c.gameGoal = ''; assert.ok(!e.farewellLines('time').some(l => /今日の目標/.test(l.text)), 'no goal set: nothing said');
});
