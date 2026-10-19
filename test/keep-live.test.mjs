import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryGuard } from '../src/memory-guard.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active } from './helpers.mjs';

function rig(t, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env });
    const calls = { generate: 0, speech: 0 };
    const voice = { synthesize: async () => { throw new Error('Must not synthesize'); }, clipKinds: () => [], available: () => false, retryAt: () => 0,
        estimateAudioMs: s => s.length * 100, estimateSynthMs: () => 0, status: () => ({ direction: c.speechDirection, main: { id: 'mock', state: 'down' } }) };
    const e = new TalkEngine(c, { ledger: ledger(), audit, voice,
        jev: { chat: async () => ({ accept: true, readAllowed: true, action: 'reply' }), speech: async () => { calls.speech++; return { accept: true }; } },
        conversation: { generate: async () => { calls.generate++; return 'こんばんは。'; } }, research: { search: async () => { throw new Error('Talk must not search'); } } });
    const stopped = []; e.on('stopped', r => stopped.push(r));
    t.after(() => e.stop('test'));
    return { c, e, calls, stopped };
}

test('KEEP_LIVE is opt-in', t => { assert.equal(setup(t).keepLive, false); assert.equal(setup(t, { KEEP_LIVE: '1' }).keepLive, true); });

test('MemoryGuard without sustained stops: a lasting warning is reported but only the hard limits are critical', async () => {
    let t = 0, v = { pressureLevel: 2, freePercent: 35 }; const events = [];
    const g = new MemoryGuard({ enabled: true, sustainedStops: false, now: () => t, read: async () => v, onCritical: s => events.push(s) });
    await g.sample(); t = 60000; const s = await g.sample();
    assert.equal(events.length, 0); assert.equal(s.level, 'warning'); assert.equal(s.reason, 'sustained_warning');
    v = { pressureLevel: 1, freePercent: 9 }; await g.sample(); assert.equal(events.at(-1).reason, 'low_headroom');
    v = { pressureLevel: 1, freePercent: 40 }; await g.sample();
    v = { pressureLevel: 4, freePercent: 40 }; await g.sample(); assert.equal(events.at(-1).reason, 'os_critical');
    v = { pressureLevel: 1, freePercent: 4 }; await g.sample(); assert.equal(events.at(-1).immediate, true);
    g.close();
});

test('KEEP_LIVE: repeated provider failures hold the show instead of stopping it, and spend nothing', async t => {
    const { e, calls, stopped } = rig(t, { KEEP_LIVE: '1' });
    active(e);
    for (let i = 0; i < 6; i++) { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); }
    assert.equal(e.running, true); assert.deepEqual(stopped, []); assert.equal(e.generationFailures, 6);
    assert.equal(calls.generate, 0); assert.equal(calls.speech, 0);
    assert.ok(e.generationRetryAt > Date.now(), 'still backing off between retries');
});

test('without KEEP_LIVE the same failures still stop the show', async t => {
    const { e, stopped } = rig(t);
    active(e);
    for (let i = 0; i < 4; i++) { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); }
    assert.equal(e.running, false); assert.deepEqual(stopped, ['provider_failures']);
});

test('KEEP_LIVE: refused lines are dropped and pause generation after three misses; a refused closing still ends the show', t => {
    const { e, stopped } = rig(t, { KEEP_LIVE: '1' });
    active(e);
    const stall = reason => Object.assign(new Error('stalled'), { code: 'CONTENT_STALLED', reason });
    for (const reason of ['near_duplicate', 'no_progress']) assert.equal(e.handleStall(stall(reason), 'monologue', e.metrics, 'stop'), false);
    assert.equal(e.stallHoldUntil, undefined);
    assert.equal(e.handleStall(stall('near_duplicate'), 'monologue', e.metrics, 'stop'), false);
    assert.ok(e.stallHoldUntil > Date.now() + 10000); assert.equal(e.contentStalls, 0);
    assert.equal(e.running, true); assert.deepEqual(stopped, []); assert.equal(e.metrics.counters.content_stall_holds, 3);
    assert.equal(e.handleStall(stall('no_progress'), 'closing', e.metrics, 'stop'), true);
    assert.equal(e.running, false); assert.deepEqual(stopped, ['content_stalled']);
});

test('KEEP_LIVE: a round review that fails the gate is skipped and the next round is released; otherwise the show closes', async t => {
    const { createApp } = await import('../src/server.mjs');
    for (const keepLive of [true, false]) {
        const c = setup(t, keepLive ? { KEEP_LIVE: '1' } : {}); c.mode = 'demo';
        const reviews = [], closes = [];
        const gameRunner = { enabled: false, start() {}, stop() {}, status: () => ({}), completeReview: x => { reviews.push(x); return true; } };
        const app = createApp(c, { remoteOptions: null, gameRunner, obs: { owned: false, ready: false, stopOwned: async () => {}, close() {} } });
        t.after(() => app.close());
        app.engine.running = true; app.engine.requestBudgetClose = reason => closes.push(reason);
        app.engine.event('round_review_failed', { runId: 'vampire-live-x-r3', tactic: 'escape_space', reason: 'speech_rejected:unsafe_or_uncertain' });
        if (keepLive) { assert.deepEqual(reviews, [{ runId: 'vampire-live-x-r3', tactic: 'escape_space', skipped: true }]); assert.deepEqual(closes, []); }
        else { assert.deepEqual(reviews, []); assert.deepEqual(closes, ['round_review_failed']); }
        app.engine.running = false;
    }
});

test('KEEP_LIVE: a talk beat that keeps failing is skipped every sixth failure, so one line cannot hold the show for hours', async t => {
    const { c, e } = rig(t, { KEEP_LIVE: '1' });
    e.voice.available = () => true;
    e.conversation.generate = async () => 'ひとつ。ふたつ。みっつ。'; // always over the 2-sentence bound
    active(e); e.director.opened = true;
    const before = `${e.director.index}:${e.director.beat}`;
    for (let i = 0; i < 5; i++) { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); }
    assert.equal(`${e.director.index}:${e.director.beat}`, before, 'held for the first five');
    e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal);
    assert.notEqual(`${e.director.index}:${e.director.beat}`, before, 'moved past it on the sixth');
    assert.equal(e.running, true);
});
