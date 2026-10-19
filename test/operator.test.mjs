import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

function engine(t, verdict = { accept: true, effect: 'none', mood: 'warm' }) {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    const judged = [], generated = [], events = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, s, ev, ctx) => { judged.push({ text, ctx }); return typeof verdict === 'function' ? verdict(text) : verdict; } },
        conversation: { generate: async ctx => { generated.push(ctx); return 'モデルの文'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    e.on('event', ev => { if (ev.type === 'operator') events.push(ev.data); });
    t.after(() => e.stop('test'));
    return { e, c, judged, generated, events };
}

test('operator line: refused before the show runs; checked for length, control characters and a bounded queue', t => {
    const { e } = engine(t);
    assert.deepEqual(e.sayOperator('こんばんは'), { accepted: false, reason: 'not_running' });
    active(e);
    assert.equal(e.sayOperator('').reason, 'invalid_text'); assert.equal(e.sayOperator('あ'.repeat(121)).reason, 'invalid_text');
    assert.equal(e.sayOperator('一行目\n二行目').reason, 'invalid_text');
    for (let i = 0; i < 3; i++) assert.equal(e.sayOperator(`お知らせ${i}`).accepted, true);
    assert.equal(e.sayOperator('四つ目').reason, 'queue_full');
});

test('operator line: spoken next exactly as written, gated for safety as an operator line, not a programme beat', async t => {
    const { e, judged, generated, events } = engine(t);
    active(e); e.blocks.start(); e.director.opened = true;
    const beat = e.director.beat;
    const r = e.sayOperator('見に来てくれてありがとう！');
    assert.equal(r.accepted, true); assert.equal(events[0].state, 'queued');
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judged.at(-1).text, '見に来てくれてありがとう！', 'the operator\'s words, not a rewrite');
    assert.equal(judged.at(-1).ctx.utterance, 'operator', 'the gate knows it is the operator\'s line');
    assert.equal(generated.length, 0, 'the model never rewrote it');
    assert.equal(e.prepared.kind, 'operator'); assert.equal(e.prepared.text, '見に来てくれてありがとう！');
    assert.equal(events.at(-1).state, 'approved');
    e.director.commit(e.prepared);
    assert.equal(e.director.beat, beat, 'it does not use up a beat of the programme');
});

test('operator line: a refused line is reported and dropped; the show keeps running', async t => {
    const { e, events } = engine(t, { accept: false, reason: 'unsafe_or_uncertain', effect: 'none', mood: 'warm' });
    active(e); e.blocks.start(); e.director.opened = true;
    e.sayOperator('これは通らない想定の文');
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(events.at(-1).state, 'rejected'); assert.equal(events.at(-1).reason, 'unsafe_or_uncertain');
    assert.equal(e.running, true); assert.equal(e.prepared, null); assert.equal(e.operatorLines.length, 0, 'not retried');
});

test('operator line: a not-yet-started autonomous line being prepared gives way; a comment reply keeps its place', t => {
    const { e } = engine(t);
    active(e); e.director.opened = true;
    const aborted = [];
    e.prepared = { kind: 'autonomous', utterance: 'game_commentary', published: 0, candidate: null, controller: { abort: () => aborted.push('auto') } };
    e.sayOperator('次はこれを話して');
    assert.deepEqual(aborted, ['auto']); assert.equal(e.prepared, null);
    e.prepared = { kind: 'reply', utterance: 'comment_reply', published: 0, candidate: { id: 'c1', text: 'やあ' }, ownsCandidate: false, controller: { abort: () => aborted.push('reply') } };
    e.sayOperator('これも');
    assert.deepEqual(aborted, ['auto'], 'the comment reply was not set aside'); assert.ok(e.prepared);
    e.prepared = null;
});

test('operator line: a prepared line cancelled by a game event goes back to the front of the queue and airs next', async t => {
    const { e, judged } = engine(t);
    active(e); e.blocks.start(); e.director.opened = true;
    e.sayOperator('ジャジャーン！おまたせ！');
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.kind, 'operator'); assert.equal(e.operatorLines.length, 0);
    e.invalidatePreparation('stale');                       // e.g. a round started before it aired (live 2026-10-10)
    assert.deepEqual(e.operatorLines.map(x => x.text), ['ジャジャーン！おまたせ！']);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared.kind, 'operator'); assert.equal(judged.filter(x => x.text === 'ジャジャーン！おまたせ！').length, 2);
});

test('operator line: a preparation dropped because the programme moved on (no cancel call) keeps the line', async t => {
    let bump = true;
    const { e } = engine(t, () => { if (bump) { bump = false; e.director.revision++; } return { accept: true, effect: 'none', mood: 'warm' }; });
    active(e); e.blocks.start(); e.director.opened = true;
    e.sayOperator('ジャジャーン！ノアビールあけちゃった！');
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared, null, 'the stale preparation was not kept');
    assert.deepEqual(e.operatorLines.map(x => x.text), ['ジャジャーン！ノアビールあけちゃった！']);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared?.kind, 'operator');
});
test('operator line: more than two sentences is refused when typed (live 2026-10-10: one such line kept Noa silent for four hours)', t => {
    const { e } = engine(t); active(e); e.director.opened = true;
    assert.deepEqual(e.sayOperator('おまたせ！ちょっと止まっちゃってごめんね！ここから再開するよ！'), { accepted: false, reason: 'too_many_sentences' });
    assert.equal(e.operatorLines.length, 0);
    assert.equal(e.sayOperator('おまたせ！ここから再開するよ！').accepted, true);
    e.c.drinkMode = true; // a standalone hiccup does not count, as in the turn bound
    assert.equal(e.sayOperator('おまたせ！ここから再開するよ！ヒック！').accepted, true);
});
test('operator line: a line that fails its turn bound is dropped at once; another failure puts it back only once', async t => {
    const { e, events } = engine(t); active(e); e.director.opened = true;
    const prep = async () => { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); };
    // A line over the bound that reached the queue anyway (e.g. queued before this check) is refused on its first failure.
    e.operatorLines.push({ id: 'long', text: 'ひとつ。ふたつ。みっつ。', at: Date.now(), failures: 0 });
    await prep();
    assert.equal(e.operatorLines.length, 0); assert.ok(events.some(x => x.id === 'long' && x.state === 'rejected'));
    // Any other failure (here TTS): put back once, then let go; the show goes on to other lines.
    let fail = true; e.voice.synthesize = async () => { if (fail) throw new Error('tts down'); return { kind: 'wav', durationMs: 40, bytes: wav(.04) }; };
    assert.equal(e.sayOperator('おしらせだよ。').accepted, true);
    await prep(); assert.equal(e.operatorLines.length, 1, 'put back after the first failure');
    await prep(); assert.equal(e.operatorLines.length, 0, 'let go after the second');
    fail = false; await prep();
    assert.ok(e.prepared && e.prepared.utterance !== 'operator', 'other lines are prepared again');
});
test('game event during play: small talk still being written yields to the event line', async t => {
    const { e } = engine(t); active(e); e.director.opened = true;
    const b = e.blocks; b.phase = 'playing'; b.round = { roundId: 'r1', best: null }; b.snapshot = null;
    const controller = new AbortController();
    e.preparing = { utterance: 'monologue', controller, ownsCandidate: false };
    b.ingest = () => ({ accepted: true, faces: ['excited'] });
    e.ingestGame({ runId: 'r1', state: {} });
    assert.equal(controller.signal.aborted, true);
    // A comment reply or an event line being prepared is left alone.
    const c2 = new AbortController(); e.preparing = { utterance: 'comment_reply', controller: c2, ownsCandidate: false };
    e.ingestGame({ runId: 'r1', state: {} });
    assert.equal(c2.signal.aborted, false);
    e.preparing = null;
});
