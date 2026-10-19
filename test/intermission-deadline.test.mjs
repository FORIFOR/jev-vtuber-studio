import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, defer } from './helpers.mjs';

const audio = { kind: 'browser', durationMs: 200, bytes: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }); c.mode = 'live';
    let generated = 0, judged = 0, spoken = 0;
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply', readAllowed: false }), speech: async () => { judged++; return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async () => { generated++; return '新しい工夫を一つ試せるのは楽しいね。'; } },
        voice: { synthesize: async () => { spoken++; return audio; } }, ...overrides }));
    e.renderer.until = Date.now() + 120000; // Simulate the renderer's regular heartbeats during fake-clock advances.
    e.director.opened = true; e.blocks.phase = 'between';
    e.blocks.review = { runId: 'test-round', reviewCompletedAt: Date.now() - 1000, chatUntil: Date.now() + 10000, targetResumeAt: Date.now() + 15000, completed: false, failed: false };
    t.after(() => e.stop('test'));
    return { e, counts: () => ({ generated, judged, spoken }) };
}

test('optional intermission generation that crosses the chat deadline never invokes gate or voice', async t => {
    const pending = defer(); const { e, counts } = fixture(t, { conversation: { generate: () => pending.promise } });
    const task = e.prepare(e.epoch, e.controller.signal); await tick();
    t.mock.timers.tick(10000); pending.resolve('新しい工夫を一つ試せるのは楽しいね。'); await task;
    assert.equal(e.prepared, null); assert.deepEqual(counts(), { generated: 0, judged: 0, spoken: 0 });
});

test('an unpublished prepared intermission line expires at the deadline', async t => {
    const { e } = fixture(t); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.intermissionDeadline, e.blocks.review.chatUntil);
    t.mock.timers.tick(10000); await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null); assert.equal(e.currentTurn, null);
    assert.equal(e.metrics.counters.intermission_chat_expired, 1); assert.equal(e.director.committedTurns, 0);
});

test('after the break chat deadline optional beats stay quiet while viewer replies remain eligible', async t => {
    const { e, counts } = fixture(t); t.mock.timers.tick(10000);
    await e.prepare(e.epoch, e.controller.signal); assert.equal(e.prepared, null); assert.equal(counts().generated, 0);
    e.generationRetryAt = 0; e.ingest({ text: '好きな音は？', author: 'viewer' }); await e.classify(e.epoch, e.controller.signal);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.utterance, 'comment_reply'); assert.equal(e.prepared.intermissionDeadline, null); assert.equal(counts().generated, 1);
});

test('an intermission utterance already playing completes both sentences after the optional deadline', async t => {
    const { e } = fixture(t, { conversation: { generate: async () => '一つ工夫を試せるのが楽しいね。違う見方も探してみたいな。' } });
    await e.prepare(e.epoch, e.controller.signal); await e.prepared.audioTask;
    await e.speakStep(e.epoch, e.controller.signal);
    const ack = event => e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event });
    assert.equal(ack('started'), true); t.mock.timers.tick(10000); assert.equal(ack('ended'), true);
    e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending.text, '違う見方も探してみたいな。'); assert.equal(ack('started'), true); assert.equal(ack('ended'), true);
    assert.equal(e.director.committedTurns, 1); assert.equal(e.metrics.counters.intermission_chat_expired, undefined);
});

test('the optional deadline aborts a hanging provider and frees preparation for a required line', async t => {
    let aborted = false;
    const { e, counts } = fixture(t, { conversation: { generate: (_context, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) } });
    const task = e.prepare(e.epoch, e.controller.signal); await tick(); assert.ok(e.preparing);
    t.mock.timers.tick(10000); await task;
    assert.equal(aborted, true); assert.equal(e.preparing, null); assert.equal(e.prepared, null);
    assert.equal(e.metrics.counters.intermission_generation_expired, 1); assert.equal(e.generationFailures, 0);
    e.blocks.announce('resume-test', 'それじゃ、次の回を始めよう。', 0, '次の回を始める案内', {});
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.text, 'それじゃ、次の回を始めよう。');
    assert.equal(e.prepared.intermissionDeadline, null); assert.equal(counts().spoken, 1);
});
