import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { Jev } from '../src/jev.mjs';
import { setup, ledger, audit, active, defer, wav } from './helpers.mjs';

const approved = () => ({ accept: true, mood: 'warm', effect: 'none' });
const rejected = () => ({ accept: false, reason: 'no_progress' });
const observed = (elapsed, hp, phase = 'combat') => ({
    phase, elapsed, enemy_count_total: 40, menu: { options: [] }, inventory: [{ name: 'WHIP' }],
    player: { hp, max_hp: 120, level: 2, character: 'ANTONIO' },
});

function rig(t, judge = async () => approved()) {
    let now = 1000;
    const events = [], judgments = [], synthesized = [];
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    // Exercise production repetition and output-gate handling without any network calls.
    c.mode = 'live';
    const e = new TalkEngine(c, {
        ledger: ledger(), audit,
        jev: { speech: async (text, signal, evidence, context) => {
            judgments.push({ text, context }); return judge(text, context, signal);
        } },
        conversation: { generate: async () => 'ひと息つくなら、静かな音楽が好きだな。' },
        voice: { synthesize: async text => {
            synthesized.push(text); return { kind: 'wav', durationMs: 40, bytes: wav(.04) };
        } },
        research: { search: async () => { throw new Error('No network in transition tests'); } },
    });
    e.blocks = new VampireShow({ lobbyMinutes: 0 }, { now: () => now,
        emit: (type, data) => events.push({ type, data }) });
    active(e); e.director.opened = true; e.endAt = Date.now() + 10800000;
    t.after(() => e.stop('test'));
    return { e, events, judgments, synthesized, advance(ms) { now += ms; e.blocks.tick(); },
        time() { return now; }, completed() { return events.filter(x => x.type === 'round_review_completed'); } };
}

function gameOver(r, runId) {
    assert.equal(r.e.blocks.ingest({ runId, state: observed(20, 20) }).accepted, true);
    r.e.blocks.announcements = []; // The start announcement is unrelated to this regression.
    assert.equal(r.e.blocks.ingest({ runId, state: observed(23, 0, 'gameover') }).accepted, true);
    r.advance(1500);
}

async function prepare(r) {
    r.e.generationRetryAt = 0;
    await r.e.prepare(r.e.epoch, r.e.controller.signal);
    return r.e.prepared;
}

async function hearPrepared(r) {
    const e = r.e, turn = e.prepared;
    assert.ok(turn, 'a fully gated turn must exist before playback');
    if (turn.audioTask) await turn.audioTask;
    for (let part = 0; part < turn.parts.length; part++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        assert.ok(e.pending, `part ${part + 1} is published`);
        const data = { id: e.pending.id, lease: e.renderer.lease };
        assert.equal(e.acknowledge({ ...data, event: 'ended' }), false, 'an unstarted clip cannot release Continue');
        assert.equal(e.acknowledge({ ...data, event: 'started' }), true);
        assert.equal(e.acknowledge({ ...data, lease: 'stale-lease', event: 'ended' }), false);
        assert.equal(e.acknowledge({ ...data, event: 'ended' }), true);
    }
    assert.equal(e.currentTurn, null);
    return turn.eventId;
}

async function hearResult(r) {
    const resultId = r.e.blocks.announcements[0]?.id;
    assert.match(resultId ?? '', /^result-/);
    const turn = await prepare(r);
    if (turn) {
        assert.equal(turn.eventId, resultId);
        await hearPrepared(r);
    } else {
        // Identical result numbers may be dropped as a noncritical repetition on later rounds.
        assert.equal(r.e.blocks.announcements.some(x => x.id === resultId), false);
        assert.equal(r.e.blocks.review.completed, false);
    }
}

test('ten consecutive gameovers recover from rejected recaps, wait 60 seconds, and release only after spoken resume', async t => {
    const r = rig(t, async (_text, context) => /^recap-vampire-/.test(context.observation?.eventId ?? '') ? rejected() : approved());
    for (let round = 1; round <= 10; round++) {
        const runId = `vampire-rejection-r${round}`;
        gameOver(r, runId); await hearResult(r);
        const speechBefore = r.synthesized.length;
        assert.equal(await prepare(r), null, 'rejected primary review must never reach playback');
        assert.equal(r.synthesized.length, speechBefore, 'Jev rejection must precede TTS');
        assert.equal(r.completed().length, round - 1);
        assert.equal(r.e.blocks.intermissionChat, false, 'a rejected review is not a heard review');
        r.advance(500);
        const fallback = await prepare(r);
        assert.equal(fallback?.eventId, `recap-fallback-${runId}`);
        await hearPrepared(r);
        assert.equal(r.e.blocks.intermissionChat, true);
        assert.equal(r.completed().length, round - 1);
        const talkContext = r.e.blocksUtterance({ kind: 'autonomous', topicBeat: 0, goal: '現在の敵から逃げる' }, null);
        assert.equal(talkContext.utterance, 'monologue');
        assert.match(talkContext.goal, /ゲームオーバー後の休憩/);
        assert.doesNotMatch(talkContext.goal, /今は集中して逃げ回っている/);

        r.advance(r.e.blocks.review.chatUntil - r.time() - 1);
        assert.equal(r.e.blocks.intermissionChat, true);
        r.e.blocks.playbackCompleted(`recap-resume-${runId}`);
        assert.equal(r.completed().length, round - 1, 'a premature resume acknowledgement is ignored');
        r.advance(1);
        assert.equal(r.e.blocks.intermissionChat, false);
        assert.equal((await prepare(r))?.eventId, `recap-resume-${runId}`);
        assert.equal(r.completed().length, round - 1, 'ready audio is not completion');
        await hearPrepared(r);
        assert.equal(r.completed().length, round - 1, 'early resume playback waits only until the death-based target');
        r.advance(r.e.blocks.review.targetResumeAt - r.time());
        assert.deepEqual(r.completed().at(-1).data, { runId, tactic: 'health_priority' });
        assert.equal(r.completed().length, round);
        r.e.blocks.playbackCompleted(`recap-resume-${runId}`);
        assert.equal(r.completed().length, round, 'duplicate playback acknowledgement cannot double-release');
    }
    assert.ok(r.judgments.some(x => x.context.observation?.eventId === 'recap-vampire-rejection-r2'), 'second round uses the real gate too');
});

test('a rejected resume uses one gated alternate and still requires its own playback completion', async t => {
    const r = rig(t, async (_text, context) => context.observation?.eventId === 'recap-resume-vampire-resume-r1' ? rejected() : approved());
    gameOver(r, 'vampire-resume-r1'); await hearResult(r);
    await prepare(r); await hearPrepared(r); r.advance(60000);
    assert.equal(await prepare(r), null);
    assert.equal(r.completed().length, 0);
    r.advance(500);
    assert.equal((await prepare(r))?.eventId, 'recap-resume-fallback-vampire-resume-r1');
    assert.equal(r.completed().length, 0);
    await hearPrepared(r);
    assert.equal(r.completed().length, 1);
});

test('both review variants rejected fail explicitly without silent Continue or repeated gate calls', async t => {
    const r = rig(t, async (_text, context) => /^recap-/.test(context.observation?.eventId ?? '') ? rejected() : approved());
    gameOver(r, 'vampire-refused-r1'); await hearResult(r);
    assert.equal(await prepare(r), null);
    r.advance(500);
    assert.equal(await prepare(r), null);
    assert.equal(r.e.blocks.review.failed, true);
    assert.equal(r.events.filter(x => x.type === 'round_review_failed').length, 1);
    assert.equal(r.completed().length, 0);
    assert.ok(['health_priority', 'escape_space'].includes(r.events.find(x => x.type === 'round_review_failed').data.tactic), 'the failure carries the tactic so KEEP_LIVE can release the next round');
    r.advance(180000);
    r.e.blocks.playbackCompleted('recap-fallback-vampire-refused-r1');
    r.e.blocks.playbackCompleted('recap-resume-vampire-refused-r1');
    assert.equal(r.completed().length, 0, 'late acknowledgements cannot revive a failed review');
    assert.equal(r.e.blocks.intermissionChat, false);
    assert.equal(r.e.blocks.announcements.some(x => /^recap-/.test(x.id)), false);
});

test('a late gate completion after cancellation cannot release a review or publish stale audio', async t => {
    const pendingJudge = defer();
    const r = rig(t, async (_text, context) => context.observation?.eventId === 'recap-vampire-cancel-r1' ? pendingJudge.promise : approved());
    gameOver(r, 'vampire-cancel-r1'); await hearResult(r);
    const task = prepare(r);
    assert.equal(r.e.preparing?.eventId, 'recap-vampire-cancel-r1');
    const synthesizedBefore = r.synthesized.length;
    r.e.invalidatePreparation('topic_changed');
    pendingJudge.resolve(approved()); await task;
    assert.equal(r.e.prepared, null);
    assert.equal(r.e.pending, null);
    assert.equal(r.synthesized.length, synthesizedBefore);
    assert.equal(r.completed().length, 0);
    r.advance(500);
    const recovered = await prepare(r);
    assert.ok(recovered?.eventId?.startsWith('recap-'), 'a cancelled critical review is not lost from the workflow');
    await hearPrepared(r);
    assert.equal(r.e.blocks.intermissionChat, true);
    assert.equal(r.completed().length, 0);
});

test('a previous run cannot release Continue for a later gameover', async t => {
    const r = rig(t);
    gameOver(r, 'vampire-stale-r1');
    r.e.blocks.ingest({ runId: 'vampire-stale-r2', state: observed(20, 20) });
    r.e.blocks.announcements = [];
    r.e.blocks.ingest({ runId: 'vampire-stale-r2', state: observed(23, 0, 'gameover') });
    r.advance(1500);
    assert.equal(r.e.blocks.speechRejected('recap-vampire-stale-r1', 'no_progress'), false);
    r.e.blocks.playbackCompleted('recap-vampire-stale-r1');
    r.e.blocks.playbackCompleted('recap-resume-vampire-stale-r1');
    assert.equal(r.e.blocks.intermissionChat, false);
    assert.equal(r.completed().length, 0);
    assert.equal(r.e.blocks.review.runId, 'vampire-stale-r2');
});

test('renderer error during a critical review recovers without accepting a late end acknowledgement', async t => {
    const r = rig(t);
    gameOver(r, 'vampire-audio-r1'); await hearResult(r);
    await prepare(r);
    r.e.nextTurnAt = 0;
    await r.e.speakStep(r.e.epoch, r.e.controller.signal);
    assert.ok(r.e.pending);
    const stale = { id: r.e.pending.id, lease: r.e.renderer.lease };
    assert.equal(r.e.acknowledge({ ...stale, event: 'started' }), true);
    assert.equal(r.e.acknowledge({ ...stale, event: 'error' }), true);
    assert.equal(r.e.pending, null);
    assert.equal(r.e.acknowledge({ ...stale, event: 'ended' }), false);
    assert.equal(r.completed().length, 0);
    assert.equal(r.e.blocks.intermissionChat, false);
    r.e.claimRenderer('test-renderer'); r.advance(500);
    const recovered = await prepare(r);
    assert.equal(recovered?.eventId, 'recap-vampire-audio-r1');
    await hearPrepared(r);
    assert.equal(r.e.blocks.intermissionChat, true);
    assert.equal(r.completed().length, 0);
});

test('a failed second speech part is retried and cannot falsely count as a completed review', async t => {
    const r = rig(t);
    gameOver(r, 'vampire-tts-r1'); await hearResult(r);
    const synthesize = r.e.voice.synthesize;
    let failed = false;
    r.e.voice.synthesize = async text => {
        if (!failed && text.startsWith('次は')) { failed = true; throw new Error('Offline fixture: second TTS part unavailable'); }
        return synthesize(text);
    };
    const turn = await prepare(r); await turn.audioTask;
    assert.ok(turn.parts[1].error, 'the failure occurs after the first part was synthesized');
    r.e.nextTurnAt = 0;
    await r.e.speakStep(r.e.epoch, r.e.controller.signal);
    const first = { id: r.e.pending.id, lease: r.e.renderer.lease };
    r.e.acknowledge({ ...first, event: 'started' });
    r.e.acknowledge({ ...first, event: 'ended' });
    assert.equal(r.e.blocks.intermissionChat, false, 'one heard sentence is not the complete reflection');
    r.e.nextTurnAt = 0;
    await r.e.speakStep(r.e.epoch, r.e.controller.signal);
    assert.equal(r.e.pending, null);
    assert.equal(r.e.currentTurn, null);
    assert.equal(r.completed().length, 0);
    r.advance(500);
    assert.equal((await prepare(r))?.eventId, 'recap-vampire-tts-r1');
    await hearPrepared(r);
    assert.equal(r.e.blocks.intermissionChat, true);
    assert.equal(r.completed().length, 0);
});

test('repeated renderer failures exhaust bounded recovery and emit a single explicit failure', async t => {
    const r = rig(t);
    gameOver(r, 'vampire-bounded-r1'); await hearResult(r);
    for (let attempt = 0; attempt < 3; attempt++) {
        r.e.claimRenderer('test-renderer');
        assert.equal((await prepare(r))?.eventId, 'recap-vampire-bounded-r1');
        r.e.nextTurnAt = 0;
        await r.e.speakStep(r.e.epoch, r.e.controller.signal);
        const data = { id: r.e.pending.id, lease: r.e.renderer.lease };
        r.e.acknowledge({ ...data, event: 'started' });
        r.e.acknowledge({ ...data, event: 'error' });
        r.advance(500);
    }
    assert.equal(r.e.blocks.review.failed, true);
    assert.equal(r.events.filter(x => x.type === 'round_review_failed').length, 1);
    assert.equal(r.completed().length, 0);
    assert.equal(r.e.blocks.speechInterrupted('recap-vampire-bounded-r1'), false);
    assert.equal(r.e.blocks.announcements.some(x => /^recap-/.test(x.id)), false);
});

test('round-transition contextual judging retains safety, honesty and observation-fit checks', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live';
    const j = new Jev(c, ledger(), audit, async () => { throw new Error('No network in gate regression'); });
    let override = {};
    j.ask = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([key, q]) => {
        if (q.type === 'noul') return [key, { noul: override[key] ?? (['private', 'injection'].includes(key) ? .01 : .99) }];
        const choice = Object.keys(q.criteria)[0];
        return [key, { choice, confidence: .99 }];
    }));
    const context = { kind: 'autonomous', utterance: 'game_fact',
        roundTransition: { runId: 'vampire-gate-r2', stage: 'review' },
        observation: { phase: 'results', eventId: 'recap-vampire-gate-r2', facts: { observedLowHealth: true } },
        recentSpeech: ['最後のほうは体力が少なくなっていたね。次も頑張るね！'] };
    const speech = () => j.speech('最後のほうは体力が少なくなっていたね。次も頑張るね！', new AbortController().signal, [], context);
    assert.equal((await speech()).accept, true);
    for (const scores of [{ safe: .7 }, { private: .9 }, { injection: .9 }, { honest: .5 }]) {
        override = scores;
        const result = await speech();
        assert.equal(result.accept, false);
        assert.equal(result.reason, 'unsafe_or_uncertain');
    }
    override = { fits: .4 };
    assert.equal((await speech()).accept, false, 'a review must still match actual game evidence');
});
