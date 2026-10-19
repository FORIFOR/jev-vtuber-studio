import test from 'node:test';
import assert from 'node:assert/strict';
import { VampireShow } from '../src/vampire-show.mjs';
import { sentences } from '../src/director.mjs';

const state = (phase = 'combat') => ({ phase, elapsed: phase === 'gameover' ? 21 : 20,
    player: { hp: phase === 'gameover' ? 0 : 20, max_hp: 100, level: 2, character: 'ANTONIO' },
    inventory: [{ name: 'WHIP' }], enemies: [], menu: { options: [] } });
const drain = show => { const lines = []; for (let line; (line = show.takeLine());) lines.push(line); return lines; };
function fixture() {
    let now = 0;
    const events = [], show = new VampireShow({ lobbyMinutes: 0 }, { now: () => now, emit: (type, data) => events.push({ type, data }) });
    show.start();
    return { show, events, setTime(value) { now = value; }, finish(runId) {
        show.ingest({ runId, state: state() }); drain(show);
        show.ingest({ runId, state: state('gameover') });
        now += 1500;
        const lines = drain(show);
        assert.deepEqual(lines.map(line => line.eventId), [`result-${runId}`, `recap-${runId}`], 'result and reflection stay ahead of any invitation');
        show.playbackCompleted(`recap-${runId}`);
        return now;
    } };
}

test('one optional prompt follows the reflection ACK; the stage waits for its own playback ACK', () => {
    const f = fixture(), s = f.show; s.setParticipationEnabled(true);
    const breakStart = f.finish('r1');
    assert.equal(s.status().participation, null);
    assert.equal(s.takeLine(), null, 'the short pause follows the completed reflection');
    f.setTime(breakStart + 1500);
    const line = s.takeLine();
    assert.equal(line.eventId, 'participation-r1');
    assert.equal(line.kind, 'game_fact');
    assert.ok(sentences(line.text).length <= 2);
    assert.equal(line.facts.changesGame, false);
    assert.equal(s.status().participation, null, 'taking a line is not proof that it was heard');
    assert.equal(s.takeLine(), null, 'one question only');
    s.playbackCompleted('participation-unrelated');
    assert.equal(s.status().participation, null);
    s.playbackCompleted(line.eventId);
    const prompt = s.status().participation;
    assert.equal(prompt.kind, 'emoji');
    assert.equal(prompt.expiresAt, s.review.endedAt + 50000);
    assert.equal(prompt.startedAt, breakStart + 1500);
    assert.ok(line.text.startsWith(prompt.text));
    assert.equal(f.events.filter(event => event.type === 'round_review_completed').length, 0, 'a participation ACK never resumes the game');
    s.playbackCompleted(line.eventId);
    assert.deepEqual(s.status().participation, prompt, 'a duplicate ACK does not prolong the question');
});

test('no answer and no invitation ACK leave the exact 60-second review/resume sequence intact', () => {
    const f = fixture(), s = f.show; s.setParticipationEnabled(true);
    const breakStart = f.finish('r1');
    f.setTime(s.review.chatUntil - 5000); s.tick();
    assert.equal(s.status().participation, null);
    assert.equal(s.stillValid('participation-r1'), false);
    assert.equal(s.takeLine(), null, 'an unanswered stale question is removed before the resume');
    f.setTime(s.review.chatUntil - 1); s.tick();
    assert.equal(s.intermissionChat, true);
    assert.equal(s.takeLine(), null);
    f.setTime(s.review.chatUntil); s.tick();
    assert.equal(s.intermissionChat, false);
    const resume = s.takeLine(); assert.equal(resume.eventId, 'recap-resume-r1');
    assert.equal(f.events.filter(event => event.type === 'round_review_completed').length, 0);
    s.playbackCompleted('participation-r1');
    assert.equal(s.status().participation, null, 'late speech completion cannot revive an expired prompt');
    s.playbackCompleted(resume.eventId);
    assert.equal(f.events.filter(event => event.type === 'round_review_completed').length, 0);
    f.setTime(s.review.targetResumeAt); s.tick();
    assert.deepEqual(f.events.filter(event => event.type === 'round_review_completed').map(event => event.data), [{ runId: 'r1', tactic: 'health_priority' }]);
});

test('comment reception must be enabled; disconnect discards queued or already displayed prompts', () => {
    const disabled = fixture(); disabled.finish('disabled');
    disabled.setTime(4000);
    assert.equal(disabled.show.takeLine(), null, 'default is disabled until a receiver is connected');
    for (const heard of [false, true]) {
        const f = fixture(), s = f.show; s.setParticipationEnabled(true);
        const breakStart = f.finish('r1');
        f.setTime(breakStart + 1500);
        if (heard) { s.playbackCompleted(s.takeLine().eventId); assert.ok(s.status().participation); }
        s.setParticipationEnabled(false);
        assert.equal(s.status().participation, null);
        assert.equal(s.takeLine(), null);
        assert.equal(s.stillValid('participation-r1'), false);
        s.playbackCompleted('participation-r1');
        s.setParticipationEnabled(true);
        assert.equal(s.status().participation, null);
        assert.equal(s.takeLine(), null, 'a reconnect does not repeat the invitation');
    }
});

test('a rejected or interrupted optional question never fails the required reflection/resume handshake', () => {
    for (const outcome of ['speechRejected', 'speechInterrupted']) {
        const f = fixture(), s = f.show; s.setParticipationEnabled(true);
        const breakStart = f.finish('r1');
        f.setTime(breakStart + 1500); const question = s.takeLine();
        assert.equal(s[outcome](question.eventId, 'test'), false);
        assert.equal(s.review.failed, false);
        assert.equal(s.status().participation, null);
        f.setTime(s.review.chatUntil); s.tick();
        const resume = s.takeLine(); assert.equal(resume.eventId, 'recap-resume-r1');
        s.playbackCompleted(resume.eventId);
        f.setTime(s.review.targetResumeAt); s.tick();
        assert.equal(s.review.completed, true);
        assert.equal(f.events.filter(event => event.type === 'round_review_failed').length, 0);
    }
});

test('rapid rounds do not repeat requests; later breaks rotate a single prompt and discard the previous one', () => {
    const f = fixture(), s = f.show; s.setParticipationEnabled(true);
    const first = f.finish('r1'); f.setTime(first + 1500);
    const question = s.takeLine(); s.playbackCompleted(question.eventId);
    assert.equal(s.status().participation.kind, 'emoji');
    f.setTime(100000); f.finish('r2'); f.setTime(103000);
    assert.equal(s.takeLine(), null, 'less than five minutes: no new request');
    s.playbackCompleted(question.eventId);
    assert.equal(s.status().participation, null, 'a previous run ACK cannot restore its question');
    f.setTime(301500); const third = f.finish('r3'); f.setTime(third + 1500);
    const choice = s.takeLine(); s.playbackCompleted(choice.eventId);
    assert.equal(s.status().participation.kind, 'choice');
    assert.deepEqual(s.status().participation.options, ['のんびり', 'わくわく']);
    assert.equal(s.takeLine(), null);
    assert.ok(sentences(choice.text).length <= 2);
    s.start();
    assert.equal(s.status().participation, null);
    assert.equal(s.participationEnabled, false, 'a fresh show needs a freshly confirmed connection');
});
