import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TalkEngine } from '../src/talk-engine.mjs';
import { saveSettings } from '../src/settings.mjs';
import { setup, active, ledger, audit, defer, wav } from './helpers.mjs';

export function make(t, overrides = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'ひとつめの文です。ふたつめの文です。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 200, bytes: wav(.2) }) }, ...overrides }));
    t.after(() => e.stop()); e.director.opened = true;
    return e;
}
function ack(e, event) { return e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event }); }
async function comment(e, text = '明るい部屋も好きです') {
    const r = e.ingest({ text, author: 'viewer' }); assert.ok(r.accepted);
    await e.classify(e.epoch, e.controller.signal); return r.id;
}

test('R01: unresolved prefetch cannot block ready part two', { timeout: 4000 }, async t => {
    const gate = defer(); let calls = 0;
    const e = make(t, { conversation: { generate: () => ++calls === 1 ? Promise.resolve('ひとつめ。ふたつめ。') : gate.promise } });
    t.after(() => gate.resolve('次の発言です。'));
    await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    const pendingStep = e.speakStep(e.epoch, e.controller.signal);
    assert.equal(await Promise.race([pendingStep.then(() => 'returned'), delay(100).then(() => 'blocked')]), 'returned');
    assert.ok(e.currentTurn.parts[1].audio);
    ack(e, 'ended'); e.nextTurnAt = 0;
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending.text, 'ふたつめ。');
    assert.equal(calls, 2); gate.resolve('次の発言です。'); await tick();
});

test('R02: prefetch respects retry deadline while approved audio continues', async t => {
    let now = Date.now(), calls = 0; t.mock.method(Date, 'now', () => now);
    const e = make(t, { conversation: { generate: async () => { if (++calls > 1) throw Object.assign(new Error('fixture unavailable'), { status: 503 }); return 'ひとつめ。ふたつめ。'; } } });
    await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    await e.prepare(e.epoch, e.controller.signal); // First failed speculative request.
    assert.equal(calls, 2);
    await e.speakStep(e.epoch, e.controller.signal); await tick();
    assert.equal(calls, 2, 'must not retry at next 200ms speech tick');
    now += 200; ack(e, 'ended'); e.nextTurnAt = 0;
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(e.pending.text, 'ふたつめ。');
    ack(e, 'started'); ack(e, 'ended');
    assert.equal(e.generationRetryAt, now + 1800, 'playback ACK must not erase generation backoff');
    now += 1799; await e.prepare(e.epoch, e.controller.signal); assert.equal(calls, 2);
    now += 1; await e.prepare(e.epoch, e.controller.signal); assert.equal(calls, 3);
    assert.equal(e.generationRetryAt, now + 4000, 'generation failures survive unrelated completed playback');
});

test('R03: topic transition requeues an approved but unplayed comment exactly once', async t => {
    const e = make(t); e.director.beat = 8;
    await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    const id = await comment(e); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.candidate.id, id);
    ack(e, 'ended'); e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
    ack(e, 'started'); ack(e, 'ended');
    assert.equal(e.director.revision, 1);
    assert.equal(e.candidates.filter(c => c.id === id).length, 1);
    e.invalidatePreparation('next_topic'); assert.equal(e.candidates.filter(c => c.id === id).length, 1);
    e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.currentTurn.candidate.id, id); ack(e, 'started'); ack(e, 'ended');
    e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started'); ack(e, 'ended');
    assert.equal(e.director.dialogue.length, 1);
    assert.equal(e.metrics.counters.comment_completed, 1);
});

test('R04: expired prepared reply is discarded before any subtitle or audio event', async t => {
    const e = make(t), events = []; e.on('event', x => events.push(x));
    await comment(e); await e.prepare(e.epoch, e.controller.signal);
    e.prepared.candidate.created -= 70000;
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(events.filter(x => x.type === 'speech').length, 0);
    assert.equal(e.stats.dropped, 1); assert.equal(e.metrics.counters.comment_drop_expired, 1);
});

test('R05: persona accepts normalized multiline text without weakening key validation', t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    saveSettings(c, { values: { CHARACTER_PERSONA: '穏やかに話す。\r\n質問は少なく。\r声は明るく。' } });
    assert.equal(c.character.persona, '穏やかに話す。\n質問は少なく。\n声は明るく。');
    assert.throws(() => saveSettings(c, { values: { TYPESAFE_API_KEY: 'bad\nkey' } }));
    assert.throws(() => saveSettings(c, { values: { CHARACTER_PERSONA: 'bad\0text' } }));
});

test('R06: source gitignore excludes dummy secrets but keeps example and source', t => {
    const root = resolve(import.meta.dirname, '..');
    assert.ok(existsSync(join(root, '.gitignore')), 'source distribution must include .gitignore');
    const dir = mkdtempSync(join(tmpdir(), 'jev-gitignore-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync(join(root, '.gitignore'), join(dir, '.gitignore'));
    mkdirSync(join(dir, 'data')); writeFileSync(join(dir, '.env'), 'DUMMY=not-a-key'); writeFileSync(join(dir, 'data/settings.json'), '{}');
    writeFileSync(join(dir, '.env.example'), 'EXAMPLE='); writeFileSync(join(dir, 'source.mjs'), '');
    const run = args => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    run(['init', '--quiet']);
    const tracked = run(['ls-files', '--others', '--exclude-standard']).trim().split('\n');
    assert.ok(!tracked.includes('.env')); assert.ok(!tracked.includes('data/settings.json'));
    assert.ok(tracked.includes('.env.example')); assert.ok(tracked.includes('source.mjs'));
});

async function waitFor(fn, timeout = 2500) {
    const start = performance.now();
    while (!fn()) { if (performance.now() - start > timeout) throw new Error('Fixture condition timed out'); await delay(5); }
}

test('R01 worker: approved second audio is sent while a three-second generation is still unresolved', { timeout: 6000 }, async t => {
    const gate = defer(); let calls = 0, released = false;
    const e = make(t, { conversation: { generate: () => ++calls === 1 ? Promise.resolve('最初の文。次の文。') : gate.promise } });
    t.after(() => { released = true; gate.resolve('次のターン。'); });
    await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    const worker = e.worker(() => e.speakStep(e.epoch, e.controller.signal), 200, e.epoch, e.controller.signal);
    await waitFor(() => calls === 2);
    ack(e, 'ended');
    await waitFor(() => e.pending?.text === '次の文。');
    assert.equal(released, false); ack(e, 'started'); ack(e, 'ended');
    await delay(3000); assert.equal(calls, 2); assert.equal(e.pending, null);
    released = true; gate.resolve('次のターン。'); await waitFor(() => e.pending?.text === '次のターン。');
    e.stop(); await worker;
});

test('R02 worker: real timer loop waits at least two seconds before its first retry', { timeout: 6000 }, async t => {
    const failures = []; let calls = 0;
    const e = make(t, { conversation: { generate: async () => {
        if (++calls === 1) return '現在のお話です。';
        failures.push(performance.now()); throw Object.assign(new Error('fixture'), { status: 503 });
    } } });
    await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    const worker = e.worker(() => e.speakStep(e.epoch, e.controller.signal), 200, e.epoch, e.controller.signal);
    await waitFor(() => failures.length === 2, 4000);
    assert.ok(failures[1] - failures[0] >= 1950, 'allow timer granularity, not 200ms rapid retries');
    assert.ok(e.running); assert.ok(e.pending.started);
    t.diagnostic(`mock-provider retry interval: ${Math.round(failures[1] - failures[0])}ms; not an API latency benchmark`);
    e.stop(); await worker;
});

test('cancelled in-flight comment keeps its reservation once and its generation lock until settle', async t => {
    const gate = defer(); let generations = 0, tts = 0;
    const e = make(t, { conversation: { generate: () => ++generations === 1 ? gate.promise : Promise.resolve('返答です。') }, voice: { synthesize: async () => { tts++; return { kind: 'wav', durationMs: 200, bytes: wav(.2) }; } } });
    const id = await comment(e); const job = e.prepare(e.epoch, e.controller.signal);
    e.nextTopic(); e.nextTopic();
    assert.equal(e.candidates.filter(m => m.id === id).length, 1); assert.ok(e.preparing);
    await e.prepare(e.epoch, e.controller.signal); assert.equal(generations, 1);
    gate.resolve('古い回答。'); await job; assert.equal(tts, 0);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.candidate.id, id); assert.equal(e.prepared.revision, e.director.revision); assert.equal(tts, 1);
});

test('generation failure requeues a comment, then retries it without judging the input twice', async t => {
    let now = Date.now(), calls = 0, judges = 0; t.mock.method(Date, 'now', () => now);
    const e = make(t, { conversation: { generate: async () => { if (++calls === 1) throw new Error('fixture'); return '返答です。'; } },
        jev: { chat: async () => { judges++; return { accept: true, action: 'reply' }; }, speech: async () => ({ accept: true }) } });
    const id = await comment(e); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.candidates[0].id, id); assert.equal(e.stats.dropped, 0);
    now = e.generationRetryAt; await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.currentTurn.candidate.id, id); ack(e, 'started'); ack(e, 'ended');
    assert.equal(judges, 1); assert.equal(e.metrics.counters.comment_completed, 1);
});

test('held and playing comment reservations count against paid admission capacity', async t => {
    const gate = defer(); let calls = 0, judges = 0;
    const e = make(t, { conversation: { generate: () => ++calls === 1 ? Promise.resolve('最初の返答。') : gate.promise },
        jev: { chat: async () => { judges++; return { accept: true, action: 'reply' }; }, speech: async () => ({ accept: true }) } });
    t.after(() => gate.resolve('二番目の返答。'));
    for (let i = 0; i < 10; i++) e.ingest({ text: `異なる質問${i}`, author: `viewer-${i}` });
    await e.classify(e.epoch, e.controller.signal); await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    await e.classify(e.epoch, e.controller.signal); e.startPrefetch(e.epoch, e.controller.signal);
    for (let i = 0; i < 10; i++) await e.classify(e.epoch, e.controller.signal);
    assert.equal(judges, 2); assert.equal(e.candidateSlotsUsed(), 2); assert.equal(e.intake.length, 8);
    e.stop(); gate.resolve('二番目の返答。'); await e.preparationTask;
});

test('expired queued and old-session candidates are terminally accounted without generation', async t => {
    const e = make(t); const id = await comment(e);
    e.candidates[0].epoch--; e.director.closing = true;
    e.requestClose(); // Already closing: no extra transition.
    e.director.closing = false;
    const other = { ...e.candidates[0], id: 'expired', epoch: e.epoch, created: Date.now() - e.c.commentTTL };
    e.candidates.push(other);
    await e.prepare(e.epoch, e.controller.signal);
    assert.ok(e.prepared); assert.equal(e.prepared.candidate, null);
    assert.equal(e.stats.dropped, 2); assert.equal(e.metrics.counters.comment_drop_session_changed, 1); assert.equal(e.metrics.counters.comment_drop_expired, 1);
    assert.equal(e.candidates.some(m => m.id === id), false);
});

test('reply TTL is checked before publication but does not truncate an already published answer', async t => {
    const e = make(t); await comment(e); await e.speakStep(e.epoch, e.controller.signal);
    ack(e, 'started'); ack(e, 'ended'); e.currentTurn.candidate.created -= 70000;
    e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending); ack(e, 'started'); ack(e, 'ended');
    assert.equal(e.metrics.counters.comment_completed, 1); assert.equal(e.stats.dropped, 0);
});

test('renderer loss requeues unpublished replies but never replays a partially published one', async t => {
    const e = make(t); const id = await comment(e); await e.prepare(e.epoch, e.controller.signal);
    e.releaseRenderer(e.renderer.lease);
    assert.equal(e.candidates[0].id, id);
    e.claimRenderer('test-renderer'); e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal); ack(e, 'started');
    e.releaseRenderer(e.renderer.lease);
    assert.equal(e.candidates.length, 0); assert.equal(e.stats.dropped, 1);
    assert.equal(e.metrics.counters.comment_drop_interrupted_renderer_released, 1);
});

test('closing clears unplayed replies with a reason, rather than replaying them after the goodbye', async t => {
    const e = make(t); await comment(e); await e.prepare(e.epoch, e.controller.signal);
    e.requestClose(); assert.equal(e.prepared, null); assert.equal(e.candidates.length, 0);
    assert.equal(e.stats.dropped, 1); assert.equal(e.metrics.counters.comment_drop_closing, 1);
});

test('stop and restart cannot publish cancelled generations or duplicate their comment records', async t => {
    const gate = defer(); let tts = 0;
    const e = make(t, { conversation: { generate: () => gate.promise }, voice: { synthesize: async () => { tts++; } } });
    await comment(e); const job = e.prepare(e.epoch, e.controller.signal);
    e.stop(); active(e); e.director.opened = true; gate.resolve('古い生成結果。'); await job;
    assert.equal(tts, 0); assert.equal(e.candidates.length, 0); assert.equal(e.prepared, null); assert.equal(e.pending, null);
});

test('multiline setting errors are field-specific and never echo secret values', t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    for (const value of ['x\0y', 'x\u001by', 'x\u0085y', 'x'.repeat(2001)]) {
        assert.throws(() => saveSettings(c, { values: { CHARACTER_PERSONA: value } }), e => e.field === 'CHARACTER_PERSONA');
    }
    saveSettings(c, { values: { CHARACTER_PERSONA: '一行目。\n\t二行目。' } });
    assert.equal(c.character.persona, '一行目。\n\t二行目。');
    assert.throws(() => saveSettings(c, { values: { TYPESAFE_API_KEY: 'SECRET-DUMMY\nVALUE' } }), e => e.field === 'TYPESAFE_API_KEY' && !e.message.includes('SECRET-DUMMY'));
});
