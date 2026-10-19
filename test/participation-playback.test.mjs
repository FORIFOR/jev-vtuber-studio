import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { active, audit, defer, ledger, setup, wav } from './helpers.mjs';

function rig(t, judge = async () => ({ accept: true, mood: 'warm', effect: 'none' })) {
    let now = 1000;
    const events = [], c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    c.mode = 'live'; c.streamTarget = 'youtube';
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { speech: judge }, conversation: { generate: async () => '少しひと息つこう。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 50, bytes: wav(.05) }) }
    }));
    e.director.opened = true; e.youtubeStatus = 'connected'; e.endAt = Date.now() + 10800000;
    e.blocks = new VampireShow({ lobbyMinutes: 0 }, { now: () => now, emit: (type, data) => events.push({ type, data }) });
    const state = phase => ({ phase, elapsed: phase === 'gameover' ? 23 : 20, inventory: [{ name: 'WHIP' }],
        player: { hp: phase === 'gameover' ? 0 : 20, max_hp: 100, level: 2, character: 'ANTONIO' } });
    e.blocks.ingest({ runId: 'run1', state: state('combat') }); e.blocks.announcements = [];
    e.blocks.ingest({ runId: 'run1', state: state('gameover') });
    now += 1500; while (e.blocks.takeLine()) { /* this fixture begins after the required recap has aired */ }
    e.blocks.setParticipationEnabled(true); e.blocks.playbackCompleted('recap-run1');
    const chatUntil = e.blocks.review.chatUntil;
    now += 1500; e.blocks.tick();
    t.after(() => e.stop('test'));
    return { e, events, chatUntil, advanceTo(value) { now = value; e.blocks.tick(); } };
}
async function prepare(r) {
    r.e.generationRetryAt = 0;
    await r.e.prepare(r.e.epoch, r.e.controller.signal);
    if (r.e.prepared?.audioTask) await r.e.prepared.audioTask;
    return r.e.prepared;
}
async function publish(r) {
    r.e.nextTurnAt = 0; r.e.claimRenderer('test-renderer');
    await r.e.speakStep(r.e.epoch, r.e.controller.signal); return r.e.pending;
}
const data = e => ({ id: e.pending.id, lease: e.renderer.lease });
async function finishResume(r) {
    r.advanceTo(r.chatUntil); const turn = await prepare(r);
    assert.equal(turn.eventId, 'recap-resume-run1', 'the optional prompt cannot block the required resume');
    for (const _part of turn.parts) {
        assert.ok(await publish(r)); const ack = data(r.e);
        assert.equal(r.e.acknowledge({ ...ack, event: 'started' }), true);
        assert.equal(r.e.acknowledge({ ...ack, event: 'ended' }), true);
    }
    assert.equal(r.events.filter(x => x.type === 'round_review_completed').length, 0, 'a short resume may finish before the death-based target');
    r.advanceTo(r.e.blocks.review.targetResumeAt);
    assert.equal(r.events.filter(x => x.type === 'round_review_completed').length, 1);
    assert.equal(r.events.filter(x => x.type === 'round_review_failed').length, 0);
}

test('disconnect cancels a prepared invitation, preserving the 60-second resume handshake', async t => {
    const r = rig(t), e = r.e; assert.equal((await prepare(r)).eventId, 'participation-run1');
    e.youtubeStatus = 'budget_waiting'; e.monitor();
    assert.equal(e.prepared, null); assert.equal(e.pending, null);
    assert.equal(e.blocks.status().participation, null);
    assert.equal(e.blocks.review.completed, false);
    await finishResume(r);
});

test('disconnect during an in-flight gate cannot publish the stale invitation when that gate returns', async t => {
    const gate = defer(), r = rig(t, () => gate.promise), e = r.e;
    const preparing = prepare(r); assert.equal(e.preparing.eventId, 'participation-run1');
    e.youtubeStatus = 'stopped'; e.monitor();
    assert.equal(e.preparing.controller.signal.aborted, true);
    gate.resolve({ accept: true, mood: 'warm', effect: 'none' }); await preparing;
    assert.equal(e.prepared, null); assert.equal(e.currentTurn, null); assert.equal(e.pending, null);
    assert.equal(e.blocks.review.failed, false);
});

test('published but unstarted invitations are canceled on monitor or on a late start ACK without losing the renderer', async t => {
    for (const viaMonitor of [true, false]) {
        const r = rig(t), e = r.e; await prepare(r); const p = await publish(r);
        assert.ok(p); const ack = data(e), cancellations = [];
        e.on('event', event => { if (event.type === 'cancel') cancellations.push(event); });
        e.youtubeStatus = 'auth_error';
        if (viaMonitor) e.monitor();
        assert.equal(e.acknowledge({ ...ack, event: 'started' }), false);
        assert.equal(e.pending, null); assert.equal(e.currentTurn, null);
        assert.equal(e.validLease(ack.lease), true);
        assert.equal(cancellations.length, 1); assert.equal(cancellations[0].data.id, ack.id);
        assert.equal(e.acknowledge({ ...ack, event: 'ended' }), false);
        await finishResume(r);
    }
});

test('expiry lets a started invitation sentence finish and drops its unplayed second sentence', async t => {
    const r = rig(t), e = r.e, turn = await prepare(r);
    assert.equal(turn.parts.length, 2); await publish(r); const ack = data(e);
    assert.equal(e.acknowledge({ ...ack, event: 'started' }), true);
    r.advanceTo(r.chatUntil - 5000); e.monitor();
    assert.equal(e.pending.id, ack.id, 'do not cut a sentence already playing');
    assert.equal(e.blocks.status().participation, null);
    assert.equal(e.acknowledge({ ...ack, event: 'ended' }), true);
    assert.equal(e.currentTurn, turn);
    assert.equal(await publish(r), null, 'the expired second part must not be published');
    assert.equal(e.currentTurn, null); assert.equal(e.blocks.review.completed, false);
    assert.equal(e.validLease(e.renderer.lease), true);
    await finishResume(r);
});
