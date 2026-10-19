import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, defer, wav } from './helpers.mjs';

// Synthetic local replay: no real model, TTS service, OBS, YouTube or game capture.
const audio = () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await tick(); assert.ok(fn(), 'condition settled'); }
function fixture(t, { read = false, generate = async () => '今は3ライン消えているよ。', synthesize = async () => audio() } = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: String(read) });
    const generated = [], judged = [], published = [];
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, readAllowed: true, action: 'reply' }), speech: async (text, signal, evidence, context) => { judged.push({ text, context }); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: context => { generated.push(context); return generate(context); } },
        voice: { synthesize }, commentVoice: { synthesize: async () => audio() } }));
    e.on('event', event => { if (event.type === 'speech') published.push(event.data); });
    e.director.opened = true; e.blocks.start(); e.blocks.takeLine(); e.blocks.round.startsAt = 0; e.blocks.tick();
    report(e, 1, 3);
    t.after(() => e.stop('test'));
    return { e, generated, judged, published };
}
function report(e, revision, lines) {
    return e.ingestGame({ roundId: e.blocks.round.roundId, snapshot: { roundId: e.blocks.round.roundId, revision,
        score: 0, clearedLines: lines, elapsedMs: 1000, highestStack: 3, holes: 0, danger: 'low',
        nextPiece: 'line', board: Array.from({ length: 20 }, () => Array(10).fill(0)) } });
}
async function select(e, text = '盤面の様子を教えて') {
    assert.equal(e.ingest({ text, author: 'synthetic-viewer' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal); return e.candidates[0];
}
async function send(e) { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); return e.pending; }
function ack(e, event) { return e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event }); }
async function play(e) { const p = await send(e); assert.ok(p); assert.equal(ack(e, 'started'), true); assert.equal(ack(e, 'ended'), true); return p; }

test('freshness uses the observation from before generation, not the board after the model returns', async t => {
    const answer = defer(), { e, generated, published } = fixture(t, { generate: () => answer.promise });
    const candidate = await select(e), task = e.prepare(e.epoch, e.controller.signal);
    await until(() => generated.length); report(e, 2, 8); answer.resolve('今は3ライン消えているよ。'); await task;
    await send(e);
    assert.equal(published.length, 0, 'outdated answer never published');
    // The unheard question is requeued once and answered again from the current board.
    assert.equal(candidate.replyState, 'selected'); assert.deepEqual(e.candidates, [candidate]);
    assert.equal(e.metrics.counters.comment_requeued, 1); assert.equal(e.stats.spoken, 0);
    const again = defer(); generated.length = 0;
    const retry = e.prepare(e.epoch, e.controller.signal); await until(() => generated.length);
    again.resolve('今は8ライン消えているよ。'); await retry; await send(e);
    assert.equal(published.length, 1, 'the regenerated, current answer is spoken');
});

test('a requeued reply that goes stale again is dropped, not retried forever', async t => {
    const { e, published } = fixture(t); const candidate = await select(e);
    await e.prepare(e.epoch, e.controller.signal); e.blocks.round.roundId = 'round-002'; await send(e);
    assert.equal(candidate.replyState, 'selected');
    await e.prepare(e.epoch, e.controller.signal); e.blocks.round.roundId = 'round-003'; await send(e);
    assert.equal(published.length, 0); assert.equal(candidate.replyState, 'dropped');
    assert.equal(e.candidates.length, 0); assert.equal(e.metrics.counters.comment_requeued, 1);
});

test('a reply generated during play cannot describe that round after it ends', async t => {
    const answer = defer(), { e, generated, published } = fixture(t, { generate: () => answer.promise });
    await select(e); const task = e.prepare(e.epoch, e.controller.signal); await until(() => generated.length);
    e.blocks.phase = 'results'; answer.resolve('まだプレイ中だよ。'); await task; await send(e);
    assert.equal(published.length, 0);
});

test('narration does not hide stale game facts or reread the same comment', async t => {
    const answer = defer(), { e, published } = fixture(t, { read: true, generate: () => answer.promise });
    const candidate = await select(e); e.startPrefetch(e.epoch, e.controller.signal); await until(() => e.prepared);
    const task = e.preparationTask; assert.equal((await play(e)).role, 'comment');
    report(e, 2, 8); answer.resolve('今は3ライン消えているよ。'); await task; await send(e);
    assert.deepEqual(published.map(p => p.role), ['comment']);
    assert.equal(candidate.replyState, 'dropped'); assert.equal(e.candidates.length, 0);
    assert.equal(e.memory.items.length, 0); assert.equal(e.metrics.counters.comment_completed || 0, 0);
});

test('round change during narration drops the host answer after the narrator finishes', async t => {
    const { e, published } = fixture(t, { read: true, generate: async () => 'まだプレイ中だよ。' });
    await select(e); await e.prepare(e.epoch, e.controller.signal);
    assert.equal((await send(e)).role, 'comment'); ack(e, 'started'); e.blocks.phase = 'results';
    assert.equal(e.pending.role, 'comment', 'do not interrupt playing narration'); ack(e, 'ended'); await send(e);
    assert.deepEqual(published.map(p => p.role), ['comment']);
});

test('a stale queued host line is cancelled before its start acknowledgement', async t => {
    const { e } = fixture(t); await select(e); await e.prepare(e.epoch, e.controller.signal); await send(e);
    const id = e.pending.id; report(e, 2, 8);
    assert.equal(e.acknowledge({ id, lease: e.renderer.lease, event: 'started' }), false);
    assert.equal(e.pending, null); assert.equal(e.currentTurn, null);
    assert.equal(e.metrics.counters.comment_started || 0, 0);
});

test('the next sentence rechecks the game, while an already playing sentence can finish', async t => {
    const { e, published } = fixture(t, { generate: async () => '見ているよ。今は3ライン消えているよ。' });
    const candidate = await select(e); await e.prepare(e.epoch, e.controller.signal); await until(() => e.prepared.parts[1].audio);
    await send(e); ack(e, 'started'); report(e, 2, 8);
    await send(e); assert.ok(e.pending.started); ack(e, 'ended'); await send(e);
    assert.deepEqual(published.map(p => p.text), ['見ているよ。']);
    assert.equal(candidate.replyState, 'dropped'); assert.equal(e.metrics.counters.comment_completed || 0, 0);
});

test('unchanged narrated reply keeps its utterance cue, completes and records one interaction', async t => {
    const { e, published, judged } = fixture(t, { read: true }); const candidate = await select(e);
    await e.prepare(e.epoch, e.controller.signal); await play(e); await play(e);
    assert.deepEqual(published.map(p => p.cue.utterance), ['comment_reply', 'comment_reply']);
    assert.equal(judged.length, 1); assert.equal(candidate.replyState, 'completed');
    assert.equal(e.metrics.counters.comment_completed, 1); assert.equal(e.director.dialogue.length, 1);
});

test('irrelevant number changes do not reject an answer without that number', async t => {
    const { e, published } = fixture(t, { generate: async () => '角を空ける方針だよ。' });
    await select(e); await e.prepare(e.epoch, e.controller.signal); report(e, 2, 8); await play(e);
    assert.equal(published.length, 1); assert.equal(e.metrics.counters.comment_completed, 1);
});

test('a number already heard does not invalidate a neutral second sentence', async t => {
    const { e, published } = fixture(t, { generate: async () => '今は3ラインだよ。角を空ける方針だよ。' });
    await select(e); await e.prepare(e.epoch, e.controller.signal); await until(() => e.prepared.parts[1].audio);
    await play(e); report(e, 2, 8); await play(e);
    assert.equal(published.length, 2); assert.equal(e.metrics.counters.comment_completed, 1);
});

test('a different round invalidates the reply even when its numbers are identical', async t => {
    const { e, published } = fixture(t); const candidate = await select(e); await e.prepare(e.epoch, e.controller.signal);
    e.blocks.round.roundId = 'round-002'; await send(e);
    assert.equal(published.length, 0); assert.equal(candidate.replyState, 'selected');
    assert.equal(e.metrics.counters.reply_context_stale, 1); assert.equal(e.metrics.counters.comment_requeued, 1);
});

test('expiry before narration drops once without broadcasting the comment', async t => {
    const { e, published } = fixture(t, { read: true }); const candidate = await select(e);
    await e.prepare(e.epoch, e.controller.signal); candidate.created = Date.now() - e.c.commentTTL - 1; await send(e);
    assert.equal(published.length, 0); assert.equal(e.metrics.counters.comment_drop_expired, 1);
    assert.equal(candidate.replyState, 'dropped');
});

test('TTL expiry after narration preserves an otherwise current reply', async t => {
    const { e, published } = fixture(t, { read: true }); const candidate = await select(e);
    await e.prepare(e.epoch, e.controller.signal); await play(e); candidate.created = Date.now() - e.c.commentTTL - 1; await play(e);
    assert.deepEqual(published.map(p => p.role), ['comment', 'host']); assert.equal(candidate.replyState, 'completed');
});

test('stale start validates ACK identity before cancelling, clears audio once and preserves the lease', async t => {
    const { e } = fixture(t), cancellations = []; e.on('event', ev => { if (ev.type === 'cancel') cancellations.push(ev.data); });
    await select(e); await e.prepare(e.epoch, e.controller.signal); await send(e);
    const id = e.pending.id, lease = e.renderer.lease; assert.equal(e.audio.has(id), true); report(e, 2, 8);
    assert.equal(e.acknowledge({ id, lease: 'wrong', event: 'started' }), false); assert.ok(e.pending);
    assert.equal(e.acknowledge({ id: 'wrong', lease, event: 'started' }), false); assert.ok(e.pending);
    assert.equal(e.acknowledge({ id, lease, event: 'started' }), false);
    assert.equal(e.audio.has(id), false); assert.equal(e.renderer.lease, lease); assert.equal(cancellations.length, 1);
    assert.equal(e.acknowledge({ id, lease, event: 'started' }), false); assert.equal(cancellations.length, 1);
    assert.equal(e.memory.items.length, 0); assert.equal(e.metrics.counters.comment_started || 0, 0);
});

test('round change retires a waiting answer but retains the single-flight lock until an abort-ignoring model settles', async t => {
    const answer = defer(); let voiceCalls = 0;
    const { e, published, generated } = fixture(t, { read: true, generate: () => answer.promise, synthesize: async () => { voiceCalls++; return audio(); } });
    const candidate = await select(e); e.startPrefetch(e.epoch, e.controller.signal); await until(() => e.prepared);
    const task = e.preparationTask; await play(e); e.blocks.phase = 'results'; await send(e);
    assert.equal(e.currentTurn, null); assert.equal(e.pending, null); assert.ok(e.preparing);
    assert.equal(e.preparing.controller.signal.aborted, true); e.startPrefetch(e.epoch, e.controller.signal); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(generated.length, 1); answer.resolve('まだプレイ中だよ。'); await task;
    assert.equal(e.preparing, null); assert.equal(voiceCalls, 0); assert.equal(e.prepared, null);
    assert.deepEqual(published.map(p => p.role), ['comment']); assert.equal(candidate.replyState, 'dropped');
    assert.equal(e.candidates.length, 0); assert.equal(e.metrics.counters.comment_drop_interrupted_stale_game_context, 1);
});

test('fixed greetings remain valid across a game phase change', async t => {
    const { e, published } = fixture(t, { read: true }); const candidate = await select(e, 'こんばんは');
    await e.prepare(e.epoch, e.controller.signal); await e.prepared.audioTask; await play(e); e.blocks.phase = 'results';
    while (e.currentTurn) await play(e);
    assert.equal(candidate.replyState, 'completed'); assert.equal(published[1].cue.utterance, 'comment_ack');
});

test('a duplicate start ACK cannot cancel or count an already playing sentence twice', async t => {
    const { e } = fixture(t); await select(e); await e.prepare(e.epoch, e.controller.signal); await send(e);
    const id = e.pending.id, lease = e.renderer.lease; ack(e, 'started'); report(e, 2, 8);
    assert.equal(e.acknowledge({ id, lease, event: 'started' }), true); assert.equal(e.pending.id, id);
    assert.equal(e.metrics.counters.comment_started, 1); ack(e, 'ended'); assert.equal(e.metrics.counters.comment_completed, 1);
});
