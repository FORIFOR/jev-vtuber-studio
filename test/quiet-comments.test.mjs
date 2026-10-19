import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, engine, active, ledger, audit, defer } from './helpers.mjs';

function clock(t) { t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 }); }
function intake(t, env = {}, overrides = {}) {
    const e = active(engine(setup(t, { READ_COMMENTS: 'true', ...env }), overrides));
    t.after(() => e.stop('test')); return e;
}

test('quiet chat accepts distinct follow-ups after 1.5 seconds while duplicate and burst limits remain', t => {
    clock(t); const e = intake(t);
    assert.equal(e.ingest({ text: 'こんにちは', author: 'one' }).accepted, true);
    t.mock.timers.tick(2000);
    assert.equal(e.ingest({ text: 'いい声だね', author: 'one' }).accepted, true);
    assert.equal(e.ingest({ text: 'いい声だね', author: 'one' }).reason, 'duplicate');
    assert.equal(e.ingest({ text: 'いい\u200b声だね', author: 'one' }).reason, 'duplicate');
    t.mock.timers.tick(1500);
    assert.equal(e.ingest({ text: 'ナイス', author: 'one' }).accepted, true);
    t.mock.timers.tick(2000);
    assert.equal(e.ingest({ text: '次も楽しみ', author: 'one' }).reason, 'author_cooldown');
    assert.equal(e.intake.length, 3);
    assert.equal(e.commentArrivals.length, 4);
});

test('rapid attempts leave quiet mode and cannot flood the paid judge', t => {
    clock(t); const e = intake(t);
    e.ingest({ text: 'こんにちは', author: 'one' });
    for (let i = 0; i < 50; i++) assert.equal(e.ingest({ text: `別の文${i}`, author: 'one' }).reason, 'author_cooldown');
    t.mock.timers.tick(2000);
    assert.equal(e.ingest({ text: 'まだ早い', author: 'one' }).reason, 'author_cooldown');
    assert.equal(e.intake.length, 1);
    assert.equal(e.commentArrivals.length, 4, 'traffic memory is bounded');
    t.mock.timers.tick(60000); e.intake = [];
    assert.equal(e.ingest({ text: '落ち着いたかな', author: 'one' }).accepted, true);
    t.mock.timers.tick(2000);
    assert.equal(e.ingest({ text: '次も応援してる', author: 'one' }).accepted, true);
});

test('readout disabled or a reserved reply backlog retains the ordinary cooldown', t => {
    clock(t);
    for (const reading of [false, true]) {
        const e = intake(t, { READ_COMMENTS: String(reading) });
        e.ingest({ text: 'こんにちは', author: 'one' });
        if (reading) e.candidateSlotsUsed = () => 2;
        t.mock.timers.tick(2000);
        assert.equal(e.ingest({ text: '次も楽しみ', author: 'one' }).reason, 'author_cooldown');
    }
});

test('quiet same-viewer comments are narrated once each after independent input and output approval', async t => {
    clock(t); const reads = [], inputs = [], outputs = [];
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'true' });
    const audio = { kind: 'browser', durationMs: 200, bytes: null };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async text => { inputs.push(text); return { accept: true, readAllowed: true, action: 'reply' }; },
            speech: async text => { outputs.push(text); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async () => { throw new Error('Short acknowledgements need no LLM'); } },
        voice: { synthesize: async () => audio },
        commentVoice: { synthesize: async text => { reads.push(text); return audio; } } }));
    t.after(() => e.stop('test')); e.director.opened = true;
    for (const [i, text] of ['こんにちは', 'ナイス'].entries()) {
        if (i) t.mock.timers.tick(2000);
        assert.equal(e.ingest({ text, author: 'same-viewer', source: 'twitch' }).accepted, true);
        await e.classify(e.epoch, e.controller.signal);
        const candidate = e.candidates[0];
        await e.prepare(e.epoch, e.controller.signal);
        for (let n = 0; n < 5 && candidate.replyState !== 'completed'; n++) {
            e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
            assert.ok(e.pending);
            const p = { id: e.pending.id, lease: e.renderer.lease };
            assert.equal(e.acknowledge({ ...p, event: 'started' }), true);
            assert.equal(e.acknowledge({ ...p, event: 'ended' }), true);
        }
        assert.equal(candidate.replyState, 'completed');
    }
    assert.deepEqual(inputs, ['こんにちは', 'ナイス']);
    assert.deepEqual(reads, ['コメント。こんにちは', 'コメント。ナイス']);
    assert.equal(outputs.length, 2);
    assert.equal(e.stats.commentsRead, 2);
});

test('quote-denied text stays out of shared events while admin can review it', async t => {
    const e = intake(t, {}, { jev: { chat: async () => ({ accept: true, readAllowed: false, action: 'reply' }) } });
    const events = []; e.on('event', event => events.push(event));
    e.ingest({ text: '原文の引用は禁止されたコメント' });
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.candidates[0].readAllowed, false);
    assert.equal(e.operatorView().queue[0].text, '原文の引用は禁止されたコメント');
    assert.equal(events.find(x => x.type === 'chat')?.data.readAllowed, false);
    assert.ok(!JSON.stringify(events).includes('原文の引用は禁止されたコメント'));
});

test('quiet chat cannot override unsafe, missing, malformed or ignore verdicts', async t => {
    for (const verdict of [undefined, {}, { accept: false }, { accept: 'true', action: 'reply' }, { accept: true, action: 'ignore' }]) {
        const e = intake(t, {}, { jev: { chat: async () => verdict } });
        const events = []; e.on('event', event => events.push(event));
        e.ingest({ text: '審査で落とすテスト文' });
        await e.classify(e.epoch, e.controller.signal);
        assert.equal(e.candidates.length, 0);
        assert.equal(e.stats.accepted, 0);
        assert.equal(e.stats.dropped, 1);
        assert.ok(!events.some(x => ['chat', 'reflex', 'speech'].includes(x.type)));
    }
});

test('configured 120-second TTL admits a 70-second comment and expires it at the configured boundary', async t => {
    clock(t); let judged = 0;
    const e = intake(t, { COMMENT_TTL_MS: '120000' }, { jev: { chat: async () => { judged++; return { accept: true, action: 'reply' }; } } });
    e.ingest({ text: 'まだ返答を待っています', author: 'one' });
    t.mock.timers.tick(70000);
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(judged, 1); assert.equal(e.candidates.length, 1);
    e.ingest({ text: '期限切れになる投稿', author: 'two' });
    t.mock.timers.tick(120000);
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(judged, 1); assert.equal(e.intake.length, 0); assert.equal(e.stats.dropped, 1);
});

test('a comment that expires during judgement is counted and never published', async t => {
    clock(t); const d = defer();
    const e = intake(t, {}, { jev: { chat: () => d.promise } });
    const events = []; e.on('event', event => events.push(event));
    e.ingest({ text: '遅い審査のテスト' });
    const work = e.classify(e.epoch, e.controller.signal);
    t.mock.timers.tick(60000); d.resolve({ accept: true, readAllowed: true, action: 'reply' });
    await work;
    assert.equal(e.candidates.length, 0); assert.equal(e.stats.dropped, 1);
    assert.ok(!events.some(x => ['chat', 'reflex'].includes(x.type)));
});
