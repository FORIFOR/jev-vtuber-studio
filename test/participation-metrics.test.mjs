import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParticipationMetrics } from '../src/participation-metrics.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { active, audit, engine, ledger, setup, wav } from './helpers.mjs';

test('participation separates platforms and measures only the first approved host playback start', () => {
    let now = 100;
    const m = new ParticipationMetrics({ now: () => now });
    const a = m.receive({ source: 'youtube', author: 'same-person' });
    m.receive({ source: 'youtube', author: 'same-person' });
    const b = m.receive({ source: 'twitch', author: 'same-person' });
    m.playbackStarted(a); assert.equal(m.snapshot().youtube.replied, 0, 'unapproved input is not an answer');
    m.approve(a); m.approve(a); m.approve(b);
    now = 300; m.playbackStarted(a, 'comment');
    assert.equal(m.snapshot().youtube.replied, 0, 'narration is not the host reply');
    now = 1600; m.playbackStarted(a); m.playbackStarted(a);
    now = 2200; m.playbackStarted(b);
    const s = m.snapshot();
    assert.deepEqual(s.youtube, { received: 2, approved: 1, readStarted: 1, replied: 1, uniqueParticipants: 1,
        uniqueParticipantsIsLowerBound: false, responseLatencyMs: { samples: 1, last: 1500, p50: 1500, p95: 1500, max: 1500 } });
    assert.equal(s.twitch.replied, 1); assert.equal(s.twitch.uniqueParticipants, 1);
    assert.equal(s.participationRate, null); assert.equal(s.uniqueViewers, null);
    assert.equal(s.returningParticipants, null); assert.equal(s.staffAndBotExclusion, 'unavailable');
    assert.equal(JSON.stringify(s).includes('same-person'), false);
});

test('local and demo tests are excluded; bounded identifiers become a lower bound and are erased on stop', () => {
    const m = new ParticipationMetrics({ maxParticipants: 2 });
    assert.equal(m.receive({ source: 'local', author: 'operator' }), null);
    assert.equal(m.receive({ source: 'demo', author: 'operator' }), null);
    for (const author of ['one', 'two', 'three', 'one']) m.receive({ source: 'youtube', author });
    const s = m.snapshot();
    assert.equal(s.excludedLocalOrDemo, 2); assert.equal(s.youtube.received, 4);
    assert.equal(s.youtube.uniqueParticipants, 2); assert.equal(s.youtube.uniqueParticipantsIsLowerBound, true);
    assert.equal(m.sources.youtube.participants.size, 2);
    const hashed = [...m.sources.youtube.participants];
    const other = new ParticipationMetrics(); other.receive({ source: 'youtube', author: 'one' });
    assert.notEqual(hashed[0], [...other.sources.youtube.participants][0], 'identities cannot be linked across sessions');
    m.close(); assert.equal(m.sources.youtube.participants.size, 0); assert.deepEqual(m.snapshot(), s);
    assert.equal(m.receive({ source: 'youtube', author: 'late' }), null);
    const demo = new ParticipationMetrics({ mode: 'demo' });
    demo.receive({ source: 'youtube', author: 'fake' });
    assert.equal(demo.snapshot().youtube.received, 0); assert.equal(demo.snapshot().excludedLocalOrDemo, 1);
});

test('short reactions by different people or platforms are admitted while same-person spam and event redelivery remain blocked', t => {
    const e = active(engine(setup(t))); t.after(() => e.stop());
    assert.equal(e.ingest({ source: 'youtube', id: 'a', author: 'viewer1', text: 'ナイス' }).accepted, true);
    assert.equal(e.ingest({ source: 'youtube', id: 'b', author: 'viewer2', text: 'ナイス' }).accepted, true);
    assert.equal(e.ingest({ source: 'twitch', id: 'a', author: 'viewer1', text: 'ナイス' }).accepted, true);
    assert.equal(e.ingest({ source: 'youtube', id: 'c', author: 'viewer1', text: 'ナイス' }).reason, 'duplicate');
    assert.equal(e.ingest({ source: 'youtube', id: 'a', author: 'viewer3', text: '新しい文に偽装' }).reason, 'duplicate');
    assert.equal(e.ingest({ source: 'youtube', id: 'd', author: 'viewer1', text: 'また次のコメント' }).reason, 'author_cooldown');
    assert.equal(e.ingest({ source: 'twitch', id: 'b', author: 'viewer2', text: 'test@example.com' }).reason, 'local_gate');
});

function fixture(t) {
    const c = { ...setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'true' }), mode: 'live' };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async text => ({ accept: text !== '拒否', action: 'reply', readAllowed: true }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'ありがとう。次もやってみるね。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 100, bytes: wav(.1) }) },
        commentVoice: { synthesize: async () => ({ kind: 'wav', durationMs: 100, bytes: wav(.1) }) } }));
    e.director.opened = true;
    e.showLogger.startSession({ mode: 'live' });
    t.after(() => e.stop()); return e;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function pending(e) {
    for (let i = 0; i < 100; i++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        if (e.pending) return e.pending;
        await tick();
    }
    assert.fail('Expected local fake audio to be ready');
}
function ack(e, event) { return e.acknowledge({ lease: e.renderer.lease, id: e.pending.id, event }); }

test('engine records platform receive → approval → actual narrator/host start and persists aggregate reports', async t => {
    const e = fixture(t), sid = e.showLogger.currentSessionId;
    e.ingest({ source: 'twitch', author: 'private-viewer-A', text: '拒否', id: 'rejected' });
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.status().participation.twitch.received, 1);
    assert.equal(e.status().participation.twitch.approved, 0);
    e.ingest({ source: 'youtube', author: 'private-viewer-B', text: 'その家具が好きです', id: 'accepted' });
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.status().participation.youtube.approved, 1);
    assert.equal(e.status().participation.youtube.replied, 0);
    const first = await pending(e);
    assert.equal(first.role, 'comment');
    assert.equal(e.acknowledge({ id: first.id, lease: 'wrong', event: 'started' }), false);
    assert.equal(e.status().participation.youtube.readStarted, 0);
    assert.equal(ack(e, 'ended'), false);
    ack(e, 'started'); ack(e, 'started');
    assert.equal(e.status().participation.youtube.readStarted, 1);
    assert.equal(e.status().participation.youtube.replied, 0);
    ack(e, 'ended');
    assert.equal((await pending(e)).role, 'host');
    assert.equal(e.status().participation.youtube.replied, 0, 'ready audio is not counted as heard');
    ack(e, 'started'); ack(e, 'started');
    assert.equal(e.status().participation.youtube.replied, 1);
    assert.equal(e.status().participation.youtube.responseLatencyMs.samples, 1);
    e.recordParticipation(true);
    const before = e.showLogger.analyzeSession(sid).participation;
    e.stop();
    assert.deepEqual(e.showLogger.analyzeSession(sid).participation, before);
    const entries = readFileSync(join(e.c.dataDir, 'show-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const aggregates = entries.filter(x => x.type === 'participation' || x.type === 'show_stop');
    assert.ok(aggregates.length >= 2);
    for (const secret of ['private-viewer-A', 'private-viewer-B', 'その家具が好きです']) assert.equal(JSON.stringify(aggregates).includes(secret), false);
});

test('selected comment connection alone controls participation invitation eligibility', t => {
    const e = fixture(t);
    e.c.streamTarget = 'youtube'; e.youtubeStatus = 'budget_waiting'; e.twitchStatus = 'connected';
    assert.equal(e.participationConnected(), false);
    e.youtubeStatus = 'connected'; assert.equal(e.participationConnected(), true);
    e.commentsPaused = true; assert.equal(e.participationConnected(), false);
    e.commentsPaused = false; e.c.streamTarget = 'twitch'; e.twitchStatus = 'stopped';
    assert.equal(e.participationConnected(), false);
    e.c.streamTarget = 'simulcast'; e.youtubeStatus = 'polling_degraded';
    assert.equal(e.participationConnected(), true);
    e.stop(); assert.equal(e.participationConnected(), false);
});
