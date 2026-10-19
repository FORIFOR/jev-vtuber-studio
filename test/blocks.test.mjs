import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLS, ROWS, mulberry32, metrics, EventTracker, planMoves, roundResult } from '../public/blocks-core.mjs';
import { BlocksShow, BLOCKS_TITLE } from '../src/blocks-show.mjs';
import { createApp, sanitizeGameReport } from '../src/server.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-blocks-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const empty = () => Array.from({ length: ROWS }, () => Array(COLS).fill(0));
const stack = h => { const b = empty(); for (let y = ROWS - h; y < ROWS; y++) b[y] = Array(COLS).fill(1).map((v, x) => x === 0 ? 0 : 1); return b; };
const snap = (o = {}) => ({ roundId: 'round-001', revision: 1, score: 0, clearedLines: 0, elapsedMs: 1000, highestStack: 3, holes: 0, danger: 'low', nextPiece: 'line', board: empty(), ...o });

test('blocks core: seeded RNG repeats, board metrics count height and holes, moves are real inputs', () => {
    const a = mulberry32(42), b = mulberry32(42);
    assert.deepEqual(Array.from({ length: 5 }, a), Array.from({ length: 5 }, b));
    const board = empty(); board[19][0] = 1; board[18][0] = 1; board[19][1] = 0; board[17][1] = 1;
    assert.deepEqual(metrics(board), { highestStack: 3, holes: 2, danger: 'low' });
    assert.equal(metrics(stack(15)).danger, 'high'); assert.equal(metrics(stack(11)).danger, 'mid');
    assert.deepEqual(planMoves(0, 4, 2, 1), ['rotateLeft', 'rotateLeft', 'moveLeft', 'moveLeft', 'moveLeft']);
    assert.deepEqual(planMoves(1, 4, 0, 6), ['rotateRight', 'moveRight', 'moveRight']);
});

test('event tracker: stable ids, one danger per episode (hysteresis), recovery counted, game over', () => {
    const t = new EventTracker('round-001');
    let ev = t.update(snap({ revision: 2, clearedLines: 2, highestStack: 5 }), { linesCleared: 2, scoreDelta: 1000 });
    assert.deepEqual(ev.map(e => [e.id, e.type, e.facts.count]), [['round-001:2:line_clear', 'line_clear', 2]]);
    assert.equal(t.update(snap({ revision: 3, highestStack: 14 }))[0].type, 'danger_enter');
    assert.equal(t.update(snap({ revision: 4, highestStack: 15 })).length, 0, 'still in danger: no repeat');
    assert.equal(t.update(snap({ revision: 5, highestStack: 12 })).length, 0, 'between thresholds: no flapping');
    assert.equal(t.update(snap({ revision: 6, highestStack: 9 }))[0].type, 'danger_exit'); assert.equal(t.dangerRecoveries, 1);
    assert.equal(t.update(snap({ revision: 7 }), { gameOver: true }).at(-1).type, 'game_over');
    assert.deepEqual(roundResult({ lines: 14, score: 9000 }, { lines: 12 }), { lines: 14, score: 9000, maxClear: 0, dangerRecoveries: 0, speed: 'normal', previousBest: 12, delta: 2, newBest: true });
});

test('round director: intro → 3-minute play → results with a real personal best → next round; stale reports ignored', t => {
    const dir = temp(t); let now = 0; const emitted = [];
    const b = new BlocksShow({ roundSeconds: 180, maxRounds: 2 }, { dataDir: dir, now: () => now, emit: (type, d) => emitted.push(d.phase), seed: () => 7 });
    b.start();
    assert.equal(b.phase, 'intro'); assert.match(b.takeLine().text, /^1回戦、標準でいくよ。まずは記録を作ろう！$/);
    assert.equal(b.ingest({ roundId: 'round-001', snapshot: snap() }).accepted, false, 'nothing counts before play starts');
    now = 6000; b.tick(); assert.equal(b.phase, 'playing');
    assert.equal(b.ingest({ roundId: 'round-999', snapshot: snap() }).reason, 'stale_round');
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 5, clearedLines: 14, score: 9000 }), events: [{ id: 'round-001:5:line_clear', type: 'line_clear', revision: 5, gameTimeMs: 60000, facts: { count: 4, totalLines: 14, scoreDelta: 3000 } }] });
    const line = b.takeLine(); assert.equal(line.kind, 'game_reaction'); assert.match(line.text, /4ライン/);
    assert.equal(b.takeLine(), null, 'an event is spoken at most once');
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 4, clearedLines: 1 }) });
    assert.equal(b.snapshot.clearedLines, 14, 'an older revision never overwrites a newer snapshot');
    now = 6000 + 180000; b.tick(); assert.equal(b.phase, 'results');
    assert.equal(b.takeLine(), null, 'one beat of silence while the result shows');
    now += 1200; assert.equal(b.takeLine().text, '時間切れ、14ライン！これが最初の記録だね。');
    assert.equal(b.takeLine().text, '最後まで崩さずに積めたね。', 'a recap from the real summary');
    assert.equal(JSON.parse(readFileSync(join(dir, 'noa-blocks-records.json'), 'utf8')).normal.lines, 14, 'the best persists');
    now += 12000; b.tick(); assert.equal(b.phase, 'between');
    assert.equal(b.chooseSpeed('次は速めがいい').text, 'わかった、次のラウンドは速めにするね！');
    now += 8000; b.tick(); assert.equal(b.phase, 'intro'); assert.equal(b.round.speed, 'fast');
    assert.equal(b.takeLine().text, '2回戦、速めでいくよ。速めは初挑戦、まずは記録を作ろう！', 'a different speed is a different record');
    const again = new BlocksShow({}, { dataDir: dir }); assert.equal(again.records.normal.lines, 14);
});

test('event policy: priority, supersede, TTL and "still true" re-check (a danger line after recovery is stale)', () => {
    let now = 0; const b = new BlocksShow({}, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 2, highestStack: 15 }), events: [
        { id: 'round-001:1:line_clear', type: 'line_clear', revision: 1, gameTimeMs: 1, facts: { count: 1 } },
        { id: 'round-001:2:danger_enter', type: 'danger_enter', revision: 2, gameTimeMs: 2, facts: { highestStack: 15 } }] });
    const l = b.takeLine(); assert.equal(l.event.type, 'danger_enter', 'single-line clears only move the face');
    assert.equal(b.stillValid(l.eventId), true);
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 3, highestStack: 8 }) });
    assert.equal(b.stillValid(l.eventId), false, 'the danger passed: do not say it now');
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 4 }), events: [{ id: 'round-001:4:line_clear', type: 'line_clear', revision: 4, gameTimeMs: 3, facts: { count: 2 } }] });
    const c = b.takeLine(); now += 7000; assert.equal(b.stillValid(c.eventId), false, 'too old to react to');
});

test('game reports are sanitized: whitelisted fields, clamped numbers, 20x10 board, events bound to the round', () => {
    const r = sanitizeGameReport({ roundId: 'round-002', snapshot: { revision: 3, score: -5, clearedLines: 1e9, highestStack: 99, danger: '<x>', nextPiece: 'line<script>', board: Array(20).fill([1, 'x', 0, 2]), evil: 1 },
        events: [{ id: 'round-002:3:line_clear', type: 'line_clear', facts: { count: 9, scoreDelta: 1 } }, { id: 'round-001:1:line_clear', type: 'line_clear' }, { id: 'round-002:4:x', type: 'rm -rf' }], summary: { maxClear: 3, dangerRecoveries: 2 } });
    assert.equal(r.snapshot.score, 0); assert.equal(r.snapshot.clearedLines, 1e5); assert.equal(r.snapshot.highestStack, 20); assert.equal(r.snapshot.danger, 'low'); assert.equal(r.snapshot.nextPiece, null);
    assert.equal(r.snapshot.board.length, 20); assert.deepEqual(r.snapshot.board[0], [1, 1, 0, 1, 0, 0, 0, 0, 0, 0]); assert.equal('evil' in r.snapshot, false);
    assert.deepEqual(r.events.map(e => e.id), ['round-002:3:line_clear']); assert.equal(r.events[0].facts.count, 4);
    assert.equal(sanitizeGameReport({ roundId: '../x' }).roundId, null);
});

function blocksEngine(t, { speech } = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' });
    const judged = [], generated = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, s, ev, ctx) => { judged.push({ text, ctx }); return speech ? speech(text, ctx) : { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { generated.push(ctx); return 'よし、次いこう。'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('no search'); } } });
    t.after(() => e.stop('test')); active(e); e.director.opened = true; e.blocks.start();
    return { e, judged, generated };
}

test('talk engine + NOA BLOCKS: announcements and events are fixed, gated lines; facts from the adapter; quiet while playing', async t => {
    const { e, judged, generated } = blocksEngine(t);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judged.at(-1).text, '1回戦、標準でいくよ。まずは記録を作ろう！'); assert.equal(judged.at(-1).ctx.utterance, 'game_fact'); assert.equal(generated.length, 0);
    assert.equal(e.prepared.kind, 'game_fact', 'an announcement does not consume a programme beat');
    e.prepared = null; e.blocks.round.startsAt = 0; e.blocks.tick(); assert.equal(e.blocks.phase, 'playing');
    const r = e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 9, clearedLines: 3 }), events: [{ id: 'round-001:9:line_clear', type: 'line_clear', revision: 9, gameTimeMs: 5000, facts: { count: 3, totalLines: 3, scoreDelta: 3000 } }] });
    assert.deepEqual(r.faces, ['excited'], 'the face reacts at once, before any words');
    e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal);
    assert.match(judged.at(-1).text, /3ライン/); assert.equal(judged.at(-1).ctx.utterance, 'game_reaction'); assert.equal(judged.at(-1).ctx.observation.facts.count, 3);
    e.prepared = null; e.lastHostEndAt = Date.now(); e.generationRetryAt = 0; const n = judged.length;
    await e.prepare(e.epoch, e.controller.signal); assert.equal(judged.length, n, 'no filler talk right after a line while the round is played');
    assert.equal(e.ingest({ text: '何のゲームしてるの？', author: 'v' }).accepted, true); await e.classify(e.epoch, e.controller.signal);
    e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judged.at(-1).text, `今は「${BLOCKS_TITLE}」をやってるよ。ブロックを回して積んで、横一列をそろえて消す落ち物パズルなんだ。`); assert.equal(judged.at(-1).ctx.utterance, 'game_fact');
    assert.equal(e.status().blocks.lines, 3, 'the stage shows the reported number');
});

test('/api/renderer/game needs the audio lease; vendored files are served by exact name only', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' }); c.port = 0;
    const a = createApp(c, { remoteOptions: false }); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const url = `http://127.0.0.1:${a.server.address().port}`, post = (p, b) => fetch(url + p, { method: 'POST', headers: { Authorization: `Bearer ${c.viewToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    assert.equal((await post('/api/renderer/game', { lease: 'nope', roundId: 'round-001' })).status, 403);
    const { lease } = await (await post('/api/renderer/claim', { client: 'obs' })).json();
    assert.equal((await (await post('/api/renderer/game', { lease, roundId: 'round-001', snapshot: snap() })).json()).accepted, false, 'not running: ignored');
    for (const f of ['/vendor/jquery-3.7.1.min.js', '/vendor/blockrain-0.2.1.jquery.js', '/vendor/blockrain-0.2.1.css']) assert.equal((await fetch(url + f)).status, 200, f);
    for (const f of ['/vendor/README.md', '/vendor/LICENSE-jquery.txt', '/vendor/../src/server.mjs']) assert.equal((await fetch(url + f)).status, 404, f);
});

test('board commentary: only new, true facts from the running round, each once, with a per-kind cooldown; else silence', () => {
    let now = 0; const b = new BlocksShow({}, { now: () => now, seed: () => 1 });
    b.records = { normal: { lines: 20 } }; b.start(); b.takeLine(); now = 6000; b.tick();
    assert.equal(b.commentary(), null, 'no clock yet: nothing to say about an empty board');
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 0, highestStack: 3 }) });
    now += 20000; assert.equal(b.commentary().text, 'まだ3段、落ち着いて平らに積んでいこう。');
    b.markCommentary(b.commentary()); assert.equal(b.commentary(), null, 'said once');
    now += 60000; b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 2, clearedLines: 14, highestStack: 5 }) });
    const c = b.commentary(); assert.match(c.text, /自己ベストのペースより\d+ライン先に行ってる！/); b.markCommentary(c);
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 3, clearedLines: 16, highestStack: 5 }) });
    assert.match(b.commentary().text, /自己ベストまであと4ライン！/, 'another kind may speak, the same kind is cooling down');
    now = b.round.endsAt - 15000; assert.equal(b.commentary().text, 'ラスト20秒！最後まで消していこう。');
});

test('a long danger that ends well gets one follow-up beat after the reaction (once per round)', () => {
    let now = 0; const b = new BlocksShow({}, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    const ev = (rev, type, h) => b.ingest({ roundId: 'round-001', snapshot: snap({ revision: rev, highestStack: h }), events: [{ id: `round-001:${rev}:${type}`, type, revision: rev, gameTimeMs: rev, facts: { highestStack: h } }] });
    ev(1, 'danger_enter', 15); assert.match(b.takeLine().text, /近い|高く|積みすぎ/);
    now += 8000; ev(2, 'danger_exit', 9); assert.match(b.takeLine().text, /助かった|持ち直した/);
    assert.equal(b.takeLine(), null, 'not straight away');
    now += 2500; const f = b.takeLine(); assert.equal(f.text, '今ちょっと静かになってたでしょ。集中してた。'); assert.equal(b.stillValid(f.eventId), true);
    now += 20000; ev(3, 'danger_enter', 15); b.takeLine(); now += 9000; ev(4, 'danger_exit', 9); b.takeLine(); now += 3000;
    assert.equal(b.takeLine(), null, 'once per round');
});

test('NOA BLOCKS demo comment replies answer by intent instead of describing the demo', async () => {
    const { blocksDemoReply } = await import('../src/providers.mjs');
    assert.match(blocksDemoReply('こんばんは〜'), /来てくれてありがとう/); assert.match(blocksDemoReply('今の消し方うまい！'), /照れる/);
    assert.doesNotMatch(blocksDemoReply('好きな食べ物は？'), /デモ/);
});


test('a same-kind reaction right after another stays a face only; it may speak again after the repeat window', () => {
    let now = 0; const b = new BlocksShow({}, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    const clear = (rev, n) => b.ingest({ roundId: 'round-001', snapshot: snap({ revision: rev }), events: [{ id: `round-001:${rev}:line_clear`, type: 'line_clear', revision: rev, gameTimeMs: rev, facts: { count: n } }] });
    clear(1, 3); assert.match(b.takeLine().text, /3ライン/);
    now += 2000; assert.deepEqual(clear(2, 3).faces, ['excited']); assert.equal(b.takeLine(), null);
    now += 7000; clear(3, 2); assert.match(b.takeLine().text, /2ライン/);
});

test('board commentary beats wait while no round is in play (intro/results/between)', t => {
    const { e } = blocksEngine(t);
    e.blocks.takeLine(); assert.equal(e.blocks.phase, 'intro');
    const beat = e.director.programme.cards[0].beats.findIndex(x => x.game === true);
    assert.deepEqual(e.blocksUtterance({ topicBeat: beat }), { utterance: 'quiet' });
    e.blocks.round.startsAt = 0; e.blocks.tick(); e.lastHostEndAt = 0;
    assert.deepEqual(e.blocksUtterance({ topicBeat: beat }), { utterance: 'quiet' }, 'the board is not running yet');
    e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 0, highestStack: 3 }) });
    e.blocks.round.endsAt -= 20000; // 20 s into the round
    const u = e.blocksUtterance({ topicBeat: beat });
    assert.equal(u.utterance, 'game_commentary'); assert.deepEqual(u.demo, ['まだ3段、落ち着いて平らに積んでいこう。']); assert.equal(u.observation.point, u.demo[0]);
    assert.deepEqual(e.blocksUtterance({ topicBeat: beat }), { utterance: 'quiet' }, 'nothing new: play quietly');
});

test('budget: a round starts only when the cloud voice can carry it; otherwise the show closes instead of going quiet', t => {
    let now = 0, left = 1; const b = new BlocksShow({ maxRounds: 3 }, { now: () => now, seed: () => 1, canAffordRound: () => left >= .03 });
    b.start(); assert.equal(b.phase, 'intro');
    now = 6000; b.tick(); now += 180000; b.tick(); assert.equal(b.phase, 'playing', 'no board, no clock: the round waits');
    b.ingest({ roundId: 'round-001', snapshot: snap() }); now += 180000; b.tick(); now += 12000; b.tick(); assert.equal(b.phase, 'between');
    left = .01; now += 8000; b.tick();
    assert.equal(b.phase, 'done'); assert.equal(b.status().closedReason, 'budget'); assert.equal(b.roundNo, 1, 'round 2 never started');
});

// The production host voice (DirectedVoice) keeps the adapter and the ledger on its router.
const cloudVoice = (spend, cloud = true, synthesize = async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) })) => ({ router: { adapter: () => ({ info: { cloud } }), spend }, synthesize });

test('budget with the production voice shape: the closing line is held from start, rounds need a round beyond it', async t => {
    const { CloudSpend } = await import('../src/cloud-spend.mjs');
    const { e } = blocksEngine(t); e.stop('test');
    const spend = new CloudSpend(temp(t), { dayUsd: .04, monthUsd: 10 });
    e.voice = cloudVoice(spend); e.start(); t.after(() => e.stop('test'));
    assert.equal(e.closingHeld, true); assert.ok(Math.abs(spend.remaining() - .035) < 1e-9, 'the goodbye is set aside first');
    assert.equal(e.canAffordRound(), true);
    spend.settle(spend.reserve(.006), { usd: .006 }); // remaining .029 < one round
    assert.equal(e.canAffordRound(), false);
    e.stop('test'); assert.ok(Math.abs(spend.remaining() - .034) < 1e-9, 'stopping releases the held closing');
    e.voice = cloudVoice(spend, false); assert.equal(e.canAffordRound(), true, 'a local voice never stops the show on cloud spend');
});

test('closing: a held reserve pays for the goodbye; with none and no room, no new closing audio is requested', async t => {
    const { CloudSpend } = await import('../src/cloud-spend.mjs');
    // Driven by hand (no worker loop); holdClosing() is what start() calls.
    const funded = new CloudSpend(temp(t), { dayUsd: .01, monthUsd: 10 }), one = blocksEngine(t);
    one.e.voice = cloudVoice(funded); one.e.closingHeld = one.e.holdClosing();
    assert.equal(one.e.closingHeld, true); assert.equal(funded.pending(), .005);
    one.e.requestClose(); await one.e.prepare(one.e.epoch, one.e.controller.signal);
    assert.equal(funded.pending(), 0, 'the held reserve was released into this closing request');
    assert.equal(one.e.prepared?.kind, 'closing');
    const broke = new CloudSpend(temp(t), { dayUsd: .001, monthUsd: 10 }), two = blocksEngine(t);
    two.e.voice = cloudVoice(broke, true, async () => { throw new Error('must not synthesize'); }); two.e.closingHeld = two.e.holdClosing();
    assert.equal(two.e.closingHeld, false); assert.equal(two.e.canAffordRound(), false);
    two.e.requestClose(); await two.e.prepare(two.e.epoch, two.e.controller.signal);
    assert.equal(two.e.running, false, 'the show ends'); assert.equal(two.generated.length, 0, 'no closing line was generated or voiced');
});

test('CloudSpend.remaining() is the smaller of the day and month headroom, after in-flight reservations', async t => {
    const { CloudSpend } = await import('../src/cloud-spend.mjs');
    const s = new CloudSpend(temp(t), { dayUsd: .25, monthUsd: 10 }, () => new Date('2026-09-27T12:00:00Z'));
    assert.equal(s.remaining(), .25);
    const id = s.reserve(.05); assert.ok(Math.abs(s.remaining() - .2) < 1e-9);
    s.settle(id, { usd: .1, audioSec: 16 }); assert.ok(Math.abs(s.remaining() - .15) < 1e-9);
});

test('result face follows the real same-speed comparison', async () => {
    const { resultFace } = await import('../src/talk-engine.mjs');
    assert.equal(resultFace({ previousBest: null }), 'excited'); assert.equal(resultFace({ previousBest: 10, newBest: true, delta: 2 }), 'excited');
    assert.equal(resultFace({ previousBest: 10, newBest: false, delta: -1 }), 'happy'); assert.equal(resultFace({ previousBest: 10, newBest: false, delta: -6 }), 'troubled');
});

test('commentary is per round: round 2 counts its own lines (no carry-over), and milestones never judge the pace', () => {
    let now = 0; const b = new BlocksShow({ maxRounds: 2 }, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 21, highestStack: 8 }) });
    now += 20000; const c1 = b.commentary(); assert.match(c1.text, /21ライン/); assert.doesNotMatch(c1.text, /いいペース/); b.markCommentary(c1);
    now = b.round.endsAt; b.tick(); now += 12000; b.tick(); now += 8000; b.tick(); now = b.round.startsAt; b.tick();
    b.ingest({ roundId: 'round-002', snapshot: snap({ roundId: 'round-002', revision: 1, clearedLines: 3, highestStack: 8 }) });
    now += 50000; assert.match(b.commentary().text, /3ライン/, 'round 2 milestones start from zero');
});

test('test-run numbers: newly generated and phrase-cache audio are counted in seconds, and the report carries the spend estimate', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'よし。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 1500, bytes: wav(1.5), stats: { engine: 'x', tiers: { cache: 1, local: 1 }, calls: 1, synthMs: 300, audioMs: 1100, cacheAudioMs: 400 } }) },
        research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e); e.director.opened = true; e.blocks.start();
    await e.prepare(e.epoch, e.controller.signal);
    const m = e.metrics.snapshot(), counters = m.counters ?? m;
    assert.equal(counters.tts_generated_local_ms, 1100, 'a local engine: generated seconds, no API fee'); assert.equal(counters.tts_generated_cloud_ms, undefined);
    assert.equal(counters.tts_cache_audio_ms, 400);
    const { createApp } = await import('../src/server.mjs');
    const c2 = setup(t); const a = createApp(c2, { remoteOptions: false }); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const r = await (await fetch(`http://127.0.0.1:${a.server.address().port}/api/programme/report`, { headers: { Authorization: `Bearer ${c2.adminToken}` } })).json();
    assert.ok('cloudSpend' in r, 'the report names the spend estimate');
    if (r.cloudSpend) { assert.equal(r.cloudSpend.basis, 'app_estimate_not_invoice'); assert.ok('session' in r.cloudSpend && 'totals' in r.cloudSpend); }
});

test('spend per broadcast: the session counter starts at zero with each show, while the day/month totals keep running', async t => {
    const { CloudSpend } = await import('../src/cloud-spend.mjs');
    const s = new CloudSpend(temp(t), { dayUsd: 1, monthUsd: 10 }, () => new Date('2026-09-28T03:00:00Z'));
    s.settle(s.reserve(.01), { usd: .01, audioSec: 60 }); // earlier today, before this show
    s.startSession(); s.settle(s.reserve(.004), { usd: .004, audioSec: 25 }); s.settle(s.reserve(.002), { usd: .002, audioSec: 12 });
    assert.deepEqual({ ...s.sessionSnapshot(), startedAt: 'x' }, { startedAt: 'x', usd: .006, audioSec: 37, requests: 2 });
    assert.equal(s.snapshot().dayUsd, .016, 'the cap still sees the whole day');
    s.startSession(); assert.equal(s.sessionSnapshot().usd, 0);
});

test('a cloud part counts as cloud-generated seconds, and the show log keeps each broadcast\'s counters and spend', async t => {
    const { CloudSpend } = await import('../src/cloud-spend.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' });
    const spend = new CloudSpend(temp(t), { dayUsd: 1, monthUsd: 10 }), logged = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'よし。' }, research: { search: async () => { throw new Error('x'); } },
        voice: { router: { adapter: () => ({ info: { cloud: true } }), spend }, synthesize: async () => ({ kind: 'wav', durationMs: 900, bytes: wav(.9), stats: { engine: 'gemini-lite-tts', tiers: { cache: 0, local: 1 }, calls: 1, synthMs: 200, audioMs: 900, cacheAudioMs: 0 } }) } });
    e.showLogger = { startSession() { }, stopSession(x) { logged.push(x); }, logCommentRead() { }, logSpeech() { } };
    e.start(); active(e); e.director.opened = true;
    assert.ok(spend.sessionSnapshot(), 'start() opens the broadcast\'s spend counter');
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.metrics.snapshot().counters.tts_generated_cloud_ms, 900);
    e.stop('test');
    const last = logged.at(-1).stats; assert.equal(last.metrics.tts_generated_cloud_ms, 900); assert.ok('cloudSpend' in last);
});

test('Studio can select NOA BLOCKS: the programme setting is checked against config/programmes.json, unknown ids are refused', async t => {
    const { saveSettings } = await import('../src/settings.mjs');
    const c = setup(t);
    saveSettings(c, { values: { SHOW_PROGRAMME: 'noa-blocks' } });
    assert.throws(() => saveSettings(c, { values: { SHOW_PROGRAMME: 'not-a-programme' } }), e => e.field === 'SHOW_PROGRAMME');
});

test('rounds fit the session: 30 min -> 8 whole rounds (the show ends on a round boundary), 15 min -> 4; a number is kept', async () => {
    const { roundsFor } = await import('../src/blocks-show.mjs');
    const cycle = { introMs: 6000, roundSeconds: 180, resultsMs: 12000, betweenMs: 8000 };
    assert.equal(roundsFor(30 * 60000, cycle), 8); assert.equal(roundsFor(15 * 60000, cycle), 4); assert.equal(roundsFor(60000, cycle), 1);
    assert.ok(8 * 206000 + 60000 <= 30 * 60000, '8 rounds plus opening/closing fit in 30 minutes');
    assert.equal(new BlocksShow({ maxRounds: 'auto' }, { sessionMs: 30 * 60000 }).cfg.maxRounds, 8);
    assert.equal(new BlocksShow({ maxRounds: 3 }, { sessionMs: 30 * 60000 }).cfg.maxRounds, 3);
});

test('speed choice in the last round: no promise of a next round that will not come', () => {
    let now = 0; const b = new BlocksShow({ maxRounds: 1 }, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    const r = b.chooseSpeed('次は速めがいい！'); assert.doesNotMatch(r.text, /次のラウンド/); assert.equal(b.nextSpeed, 'normal');
});

test('NOA BLOCKS opening and closing are fixed lines (still gated); a rejected fixed line is dropped, never rewritten by the model', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' });
    assert.ok(c.programme.openingLine && c.programme.closingLine);
    const judged = [], generated = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, s, ev, ctx) => { judged.push({ text, ctx }); return { accept: false, reason: 'unsafe_or_uncertain', effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { generated.push(ctx); return 'モデルの文'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judged[0].text, c.programme.openingLine); assert.equal(judged[0].ctx.kind, 'opening', 'the opening still goes through the gate');
    assert.equal(judged.length, 1, 'rejected once, not retried'); assert.equal(generated.length, 0, 'the model never rewrote the fixed line');
});

test('NOA BLOCKS: rejected small talk is skipped without stopping the show; two misses pause small talk for the round', async t => {
    const { e } = blocksEngine(t, { speech: () => ({ accept: false, reason: 'no_progress', effect: 'none', mood: 'warm' }) });
    e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick();
    e.lastHostEndAt = 0; e.blocksChatMisses = 0; e.blocksChatMutedRound = null;
    const chat = e.director.programme.cards[0].beats.findIndex(x => !x.game && !x.invite);
    for (let i = 0; i < 4; i++) {
        e.director.beat = chat; e.blocks.said.clear(); e.generationRetryAt = 0; e.prepared = null;
        await e.prepare(e.epoch, e.controller.signal);
        assert.equal(e.running, true, `still running after ${i + 1} rejected chat lines`);
    }
    assert.equal(e.blocksChatMutedRound, e.blocks.roundNo, 'small talk paused for this round');
    e.director.beat = chat; e.blocks.said.clear();
    assert.deepEqual(e.blocksUtterance({ topicBeat: chat }), { utterance: 'quiet' });
});

test('the speed invitation is a scripted line grounded in the show rule, not model small talk', t => {
    const { e } = blocksEngine(t);
    e.blocks.cfg.maxRounds = 3; e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick(); e.lastHostEndAt = 0;
    const invite = e.director.programme.cards[0].beats.findIndex(x => x.invite);
    const u = e.blocksUtterance({ topicBeat: invite });
    assert.equal(u.utterance, 'game_fact'); assert.match(u.template, /ゆっくり.*標準.*速め/); assert.match(u.observation.event, /選べる/);
});

test('reaction lines are not repeated in a short while: the variants rotate, and when all were said recently the face reacts alone', () => {
    let now = 0; const b = new BlocksShow({}, { now: () => now, seed: () => 1 });
    b.start(); b.takeLine(); now = 6000; b.tick();
    const texts = [];
    for (let r = 1; r <= 4; r++) {
        now += 9000; b.ingest({ roundId: 'round-001', snapshot: snap({ revision: r }), events: [{ id: `round-001:${r}:line_clear`, type: 'line_clear', revision: r, gameTimeMs: r, facts: { count: 2 } }] });
        texts.push(b.takeLine()?.text ?? null);
    }
    assert.equal(new Set(texts.slice(0, 3)).size, 3, 'three different words for three 2-line clears'); assert.equal(texts[3], null, 'a fourth identical moment: face only');
});

test('the NOA BLOCKS closing is built from tonight\'s real result, with the facts it rests on; before any round, the fixed line', t => {
    let now = 0; const b = new BlocksShow({ maxRounds: 1 }, { now: () => now, seed: () => 1 });
    b.start(); assert.equal(b.closing(), null, 'no round finished yet');
    b.takeLine(); now = 6000; b.tick(); b.ingest({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 24, score: 9000 }), summary: { maxClear: 2, dangerRecoveries: 0 } });
    now += 181000; b.tick();
    const c = b.closing(); assert.match(c.text, /2ライン同時に消すと1ラインずつより点がずっと大きい/); assert.equal(c.observation.facts.mostLinesClearedAtOnce, 2); assert.equal(c.observation.facts.pointsPerClear[3], 3000);
    const { e } = blocksEngine(t); e.blocks = b; e.requestClose();
    const u = e.utterance(e.director.context(null, null), null, null); assert.equal(u.template, c.text); assert.equal(u.observation.facts.bestLines, 24);
});

test('a refused NOA BLOCKS closing ends the show cleanly as completed (nothing unapproved is said)', async t => {
    const { e, generated } = blocksEngine(t, { speech: (text, ctx) => ctx.kind === 'closing' ? { accept: false, reason: 'no_progress', effect: 'none', mood: 'warm' } : { accept: true, effect: 'none', mood: 'warm' } });
    const stops = []; e.on('event', ev => { if (ev.type === 'stop') stops.push(ev.data.reason); });
    e.requestClose(); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.running, false); assert.deepEqual(stops, ['show_completed']); assert.equal(generated.length, 0);
});

test('a line that quotes a board number is dropped if the number changed before it airs', async () => {
    const { staleNumber } = await import('../src/talk-engine.mjs');
    assert.equal(staleNumber('これで 13 ライン目、あと少し！', { lines: 13, stack: 5 }, { lines: 16, stack: 6 }), true, '13 said, 16 on screen');
    assert.equal(staleNumber('これで１３ライン目！', { lines: 13, stack: 5 }, { lines: 16, stack: 5 }), true, 'full-width digits');
    assert.equal(staleNumber('これで 13 ライン目！', { lines: 13, stack: 5 }, { lines: 13, stack: 7 }), false, 'the quoted number is still true');
    assert.equal(staleNumber('いい感じに積めてるね。', { lines: 13, stack: 5 }, { lines: 16, stack: 7 }), false, 'no number, nothing to go stale');
    assert.equal(staleNumber('残り 1 分切った！', { lines: 13, stack: 5 }, { lines: 16, stack: 7 }), false, 'other numbers are not board numbers');
});

test('board commentary prepared during play is dropped if the round ended before it could air', async t => {
    const { e } = blocksEngine(t);
    e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick();
    e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 0, highestStack: 3 }) }); e.blocks.round.endsAt -= 20000; e.lastHostEndAt = 0;
    const beat = e.director.programme.cards[0].beats.findIndex(x => x.game === true); e.director.beat = beat;
    await e.prepare(e.epoch, e.controller.signal); assert.equal(e.prepared?.utterance, 'game_commentary');
    e.blocks.round.endsAt = Date.now() - 1; e.blocks.tick(); assert.equal(e.blocks.phase, 'results');
    e.currentTurn = e.prepared; e.prepared = null; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null, 'not published'); assert.equal(e.metrics.snapshot().counters.commentary_after_round, 1);
});

test('small talk prepared during play that would air after a game over is dropped too', async t => {
    const { e } = blocksEngine(t);
    e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick();
    e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 1, clearedLines: 0, highestStack: 3 }) }); e.lastHostEndAt = 0;
    const chat = e.director.programme.cards[0].beats.findIndex(x => !x.game && !x.invite); e.director.beat = chat;
    await e.prepare(e.epoch, e.controller.signal); assert.equal(e.prepared?.utterance, 'monologue');
    e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 2 }), events: [{ id: 'round-001:2:game_over', type: 'game_over', revision: 2, gameTimeMs: 2, facts: {} }] });
    assert.equal(e.blocks.phase, 'results');
    e.currentTurn = e.prepared; e.prepared = null; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null); assert.equal(e.metrics.snapshot().counters.commentary_after_round, 1);
});

test('time-left claims must still be true when they air; queued play lines are dropped the moment the round ends', async t => {
    const { staleTimeLeft } = await import('../src/talk-engine.mjs');
    const b = { phase: 'playing', round: { endsAt: 1000000 } };
    assert.equal(staleTimeLeft('残り 1 分だけど、慎重に積もう。', b, 1000000 - 24000), true, 'says 1 minute, 24 s left');
    assert.equal(staleTimeLeft('残り1分切った！', b, 1000000 - 58000), false);
    assert.equal(staleTimeLeft('残り２０秒！', b, 1000000 - 12000), false, 'within 15 s');
    assert.equal(staleTimeLeft('いい感じ。', b, 0), false);
    const { e } = blocksEngine(t);
    e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick(); e.ingestGame({ roundId: 'round-001', snapshot: snap({ revision: 1 }) });
    e.pending = { id: 'x', started: false, cue: { utterance: 'game_commentary' } }; e.audio.set('x', Buffer.alloc(1));
    e.blocks.round.endsAt = Date.now() - 1; const before = e.blocks.phase; e.blocks.tick();
    if (before === 'playing' && e.blocks.phase === 'results') e.dropPlayLines('round_ended');
    assert.equal(e.pending, null, 'the queued commentary is cancelled before it plays');
});
