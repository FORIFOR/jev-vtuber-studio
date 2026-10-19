import test from 'node:test';
import assert from 'node:assert/strict';
import { VampireShow, snapshotOf, roundReviewOf } from '../src/vampire-show.mjs';
import { sentences } from '../src/director.mjs';

const state = (elapsed, hp = 120, extra = {}) => ({ phase: 'combat', elapsed, enemy_count_total: 12,
    player: { hp, max_hp: 120, level: 2, character: 'ANTONIO' }, inventory: [{ name: 'WHIP' }], ...extra });
const snap = (...args) => snapshotOf(state(...args));
const dead = (elapsed = 60) => snap(elapsed, 0, { phase: 'gameover' });
const drain = show => { const lines = []; for (let line; (line = show.takeLine());) lines.push(line); return lines; };

test('different measured ending situations produce different recaps and compatible next experiments', () => {
    const health = roundReviewOf(dead(), [snap(48, 110), snap(58, 20)]);
    assert.equal(health.kind, 'health_drop');
    assert.equal(health.tactic, 'health_priority');
    assert.match(health.event, /10秒の間に体力が110から20/, 'the measurement reaches the gate as a fact'); assert.match(health.text, /体力が一気に減/);
    assert.equal(health.facts.healthPercentPointDrop, 75);
    const fast = roundReviewOf(dead(), [snap(58, 20, { enemies: Array.from({ length: 4 }, () => ({ velocity_x: 1.8 })) })]);
    assert.equal(fast.kind, 'fast_enemies');
    assert.equal(fast.tactic, 'escape_space', 'the terminal low-health sample must not erase observed movement pressure');
    assert.match(fast.event, /速い敵が同時に4体/); assert.match(fast.text, /速い敵がたくさん/);
    const crowd = roundReviewOf(dead(), [snap(48, 120, { enemy_count_total: 25 }), snap(58, 120, { enemy_count_total: 50 })]);
    assert.equal(crowd.kind, 'enemy_growth');
    assert.equal(crowd.tactic, 'escape_space');
    assert.match(crowd.event, /25体から50体/); assert.match(crowd.text, /敵がどんどん増えて/);
    for (const review of [health, fast, crowd]) {
        assert.ok(sentences(review.text).length <= 2);
        assert.ok(review.text.length <= 220);
        assert.doesNotMatch(review.text, /[0-9０-９]/, 'spoken recaps carry no counts (live gate: counted recaps fell under safe/honest)');
        assert.match(review.event, /敗因の断定でも.*効果を証明するものでもない/);
        assert.doesNotMatch(review.text, /せいで|原因は.*だった|おかげで|学習した|強くなった/);
    }
});

test('missing, stale, future, and terminal data cannot become a fabricated low-health explanation', () => {
    for (const [end, samples] of [
        [dead(), []],
        [dead(), [snap(2, 10)]],
        [dead(), [snap(62, 10)]],
        [dead(), [snap(60, 0)]],
        [snapshotOf({ phase: 'gameover' }), [snap(58, 10)]],
        [dead(), [snapshotOf({ phase: 'combat', elapsed: 58 })]],
    ]) {
        const review = roundReviewOf(end, samples);
        assert.equal(review.kind, 'uncertain');
        assert.equal(review.facts.observedLowHealth, false);
        assert.equal(review.tactic, 'escape_space');
        assert.match(review.text, /原因はまだ決めつけられない/);
    }
});

test('recovery and changed maximum HP do not create a fictitious health loss', () => {
    const recovered = roundReviewOf(dead(), [snap(48, 10), snap(58, 100)]);
    assert.equal(recovered.facts.observedLowHealth, false);
    assert.notEqual(recovered.kind, 'low_health');
    const changedMaximum = roundReviewOf(dead(), [snap(48, 100, { player: { hp: 100, max_hp: 100 } }), snap(58, 100, { player: { hp: 100, max_hp: 200 } })]);
    assert.equal(changedMaximum.facts.healthPercentPointDrop, null);
    assert.notEqual(changedMaximum.kind, 'health_drop');
    assert.doesNotMatch(changedMaximum.text, /減って/);
});

test('prior comparison stays within the same character and never changes a tactic just for variety', () => {
    const samples = [snap(58, 20, { enemy_count_total: 45 })];
    const previous = { runId: 'earlier', character: 'ANTONIO', seconds: 50, kind: 'low_health' };
    const review = roundReviewOf(dead(), samples, previous);
    assert.equal(review.kind, 'enemy_count', 'a second measured signal is discussed instead of repeating the same generic observation');
    assert.equal(review.tactic, 'health_priority', 'the experiment still follows the strongest evidence');
    assert.match(review.event, /前回より10秒長く/); assert.doesNotMatch(review.text, /[0-9]/);
    assert.deepEqual(review.facts.comparison, { runId: 'earlier', secondsDelta: 10 });
    const otherCharacter = roundReviewOf(dead(), samples, { ...previous, character: 'IMELDA' });
    assert.equal(otherCharacter.facts.comparison, null);
    assert.equal(otherCharacter.kind, 'low_health');
    assert.doesNotMatch(otherCharacter.text, /前回より/);
});

function rig() {
    let now = 1000;
    const events = [], show = new VampireShow({ lobbyMinutes: 0 }, { now: () => now, emit: (type, data) => events.push({ type, data, at: now }) });
    show.ingest({ runId: 'r1', state: state(58, 20) }); drain(show);
    show.ingest({ runId: 'r1', state: state(60, 0, { phase: 'gameover' }) });
    const endedAt = now;
    return { show, events, endedAt, at(ms) { now = endedAt + ms; show.tick(); }, completed: () => events.filter(e => e.type === 'round_review_completed') };
}

test('a 30-second result/review ACK delay fits inside the 60-second break instead of adding another minute', () => {
    const r = rig(), s = r.show;
    r.at(30000); const review = drain(s).find(l => l.eventId === 'recap-r1');
    assert.ok(review);
    s.playbackCompleted(review.eventId);
    assert.equal(s.intermissionRemainingMs, 25000);
    assert.equal(s.review.targetResumeAt, r.endedAt + 60000);
    r.at(54999); assert.equal(s.takeLine(), null);
    r.at(55000); const resume = s.takeLine();
    assert.equal(resume.eventId, 'recap-resume-r1');
    r.at(60000); assert.equal(r.completed().length, 0, 'the target time cannot replace required playback');
    s.playbackCompleted(resume.eventId);
    assert.equal(r.completed().length, 1);
    assert.equal(r.completed()[0].at - r.endedAt, 60000, 'old additive timing would have waited until 90 seconds plus resume speech');
});

test('an early complete resume waits only to the target, without replay or accepting an old ACK', () => {
    const r = rig(), s = r.show;
    r.at(10000); drain(s); s.playbackCompleted('recap-r1');
    const until = s.review.chatUntil;
    r.at(20000); s.playbackCompleted('recap-r1');
    assert.equal(s.review.chatUntil, until);
    assert.equal(s.speechInterrupted('recap-r1'), false, 'completed reflection cannot be queued again');
    r.at(55000); const resume = s.takeLine(); s.playbackCompleted(resume.eventId);
    assert.equal(s.speechInterrupted(resume.eventId), false, 'a heard resume is not repeated during the remaining deadline');
    r.at(59999); assert.equal(r.completed().length, 0); assert.equal(s.takeLine(), null);
    r.at(60000); assert.equal(r.completed().length, 1);
    s.playbackCompleted(resume.eventId); r.at(65000);
    assert.equal(r.completed().length, 1);
});

test('a review completed after the target queues the resume immediately and skips expired optional chat', () => {
    const r = rig(), s = r.show; s.setParticipationEnabled(true);
    r.at(75000); drain(s);
    assert.equal(s.takeLine(), null, 'time alone never queues the resume before the required review ACK');
    s.playbackCompleted('recap-r1');
    assert.equal(s.intermissionChat, false);
    assert.equal(s.participationQuestion, null);
    const resume = s.takeLine(); assert.equal(resume.eventId, 'recap-resume-r1');
    assert.equal(r.completed().length, 0);
    r.at(77000); s.playbackCompleted(resume.eventId);
    assert.equal(r.completed()[0].at - r.endedAt, 77000, 'late speech adds only its real duration, not another 60-second wait');
});

test('the separately gated shorter review retains its factual basis and allowlisted plan', () => {
    const r = rig(), s = r.show; r.at(1500);
    const primary = drain(s).find(l => l.eventId === 'recap-r1');
    assert.equal(s.speechRejected(primary.eventId, 'no_progress'), true);
    r.at(2000); const fallback = s.takeLine();
    assert.equal(fallback.eventId, 'recap-fallback-r1');
    assert.deepEqual(fallback.facts, primary.facts);
    assert.equal(fallback.text, 'おつかれさま。次はもう少し慎重に動いてみるね。', 'the alternative is short and claims nothing measured');
    assert.match(s.review.lines[fallback.eventId].event, /17パーセント/, 'the factual basis still reaches the gate');
    s.playbackCompleted(primary.eventId);
    assert.equal(s.review.reviewCompletedAt, null, 'the rejected primary cannot satisfy the replacement');
    s.playbackCompleted(fallback.eventId);
    assert.equal(s.intermissionChat, true);
});
