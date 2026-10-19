import test from 'node:test';
import assert from 'node:assert/strict';
import { NOA_EFFECTS, MAX_EFFECT_MS, telopFrom, eventTypeOf, speechEffect, gameEffect, EffectDirector } from '../public/effect-director.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { ROWS, COLS } from '../public/blocks-core.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

const said = (text, reaction, cue = {}, extra = {}) => ({ id: `p-${Math.random()}`, role: 'host', text, reaction, cue: { epoch: 1, ...cue }, ...extra });

test('six presets, each one act (fx + telop style + optional sound), never longer than 3 s; normal/focused have none', () => {
    assert.deepEqual(Object.keys(NOA_EFFECTS).sort(), ['joy', 'laugh', 'record', 'shy', 'surprise', 'trouble']);
    for (const p of Object.values(NOA_EFFECTS)) { assert.ok(p.ms <= MAX_EFFECT_MS && p.fx); }
    for (const r of ['neutral', 'nod', 'thinking', 'listen']) assert.equal(speechEffect(said('ここ、空けときたいんだよね……', r, { utterance: 'game_commentary' })), null, r);
});

test('whether to fire at all: ordinary thanks only smile; a real game success shines; a viewer\'s worry never gets a comic sweat', () => {
    assert.equal(speechEffect(said('コメントありがとう！', 'happy', { utterance: 'comment_reply' })), null, 'plain thanks: the face does it');
    assert.equal(speechEffect(said('いいね、3ライン！', 'happy', { utterance: 'game_reaction', eventId: 'round-001:9:line_clear' })).preset, 'joy');
    assert.equal(speechEffect(said('よしっ！今のでだいぶ助かった！', 'excited', { utterance: 'game_reaction', eventId: 'follow-round-001:4:danger_exit' })).preset, 'joy');
    assert.equal(speechEffect(said('それはつらかったね。', 'troubled', { utterance: 'comment_reply' })), null, 'no sweat on a viewer\'s worry');
    assert.equal(speechEffect(said('あー……今のは私の置き方が悪かった。', 'troubled', { utterance: 'game_reaction', eventId: 'round-001:3:game_over' })).preset, 'trouble');
    assert.equal(speechEffect(said('……そんな褒める？ちょっと照れるんだけど。', 'embarrassed', { utterance: 'comment_reply' })).preset, 'shy');
    assert.equal(speechEffect(said('えっ、待って！そこ入らない！', 'surprised', { utterance: 'game_reaction' })).preset, 'surprise');
    assert.equal(speechEffect({ ...said('コメント。うまい！', 'listen'), role: 'comment' }), null, 'the narrator reading a comment gets nothing');
    assert.equal(eventTypeOf('round-002:14:danger_exit'), 'danger_exit'); assert.equal(eventTypeOf('result-round-001'), 'result');
});

test('telops lift one whole clause of the spoken line: negations and conditions stay with their words', () => {
    assert.equal(telopFrom('よしっ！今のでだいぶ助かった！', 'joy'), '今のでだいぶ助かった！');
    assert.equal(telopFrom('えっ、待って！そこ入らない！', 'surprise'), '待って！');
    assert.equal(telopFrom('いいね、3ライン！', 'joy'), '3ライン！');
    assert.equal(telopFrom('失敗したら、やばい！', 'surprise'), null, 'a clause after a condition is never shown alone');
    assert.equal(telopFrom('そこ入らない！', 'surprise'), 'そこ入らない！', 'the negation is part of the clause');
    assert.equal(telopFrom('今日はとても長い説明をしているところなんだけど聞いてね！', 'joy'), null, 'too long to read at a glance');
    assert.equal(telopFrom('よし！', 'record'), null, 'record has no telop (the board banner names it)');
});

test('limits in code: each event once, one lead at a time (higher priority may take over), cooldown per preset, no stale session', () => {
    let now = 0; const d = new EffectDirector({ now: () => now }); d.setEpoch(1);
    const joy = speechEffect(said('いいね、3ライン！', 'happy', { utterance: 'game_reaction', eventId: 'round-001:9:line_clear' }));
    assert.ok(d.offer(joy)); assert.equal(d.offer(joy), null, 'same event twice');
    now += 500; assert.equal(d.offer(speechEffect(said('……照れる。', 'embarrassed', { utterance: 'comment_reply' }))), null, 'one lead at a time');
    const surprise = speechEffect(said('えっ、待って！', 'surprised', { utterance: 'game_reaction' })); assert.ok(d.offer(surprise), 'a stronger moment takes over');
    now += 2000; assert.equal(d.offer(speechEffect(said('よし、2ライン！', 'happy', { utterance: 'game_reaction', eventId: 'round-001:12:line_clear' }))), null, 'joy is cooling down');
    now += 6000; assert.ok(d.offer(speechEffect(said('よし、2ライン！', 'happy', { utterance: 'game_reaction', eventId: 'round-001:20:line_clear' }))));
    now += 7000; assert.equal(d.offer(speechEffect(said('えっ！', 'surprised', { utterance: 'game_reaction', epoch: 0 }))), null, 'another session');
    d.setEpoch(2); assert.equal(d.active, null, 'a new session drops what was on screen');
    assert.ok(d.offer({ ...NOA_EFFECTS.record, preset: 'record', key: 'k', ms: 99999 }).ms <= MAX_EFFECT_MS);
});

test('record celebration only when seen live (playing → results) for a first record / new best; never on reconnect', () => {
    const playing = { phase: 'playing', roundId: 'round-001' }, results = r => ({ phase: 'results', roundId: 'round-001', lastResult: { roundId: 'round-001', ...r } });
    assert.equal(gameEffect(playing, results({ previousBest: null, newBest: true })).preset, 'record');
    assert.equal(gameEffect(playing, results({ previousBest: 30, newBest: false, delta: -4 })), null, 'no celebration for a miss');
    assert.equal(gameEffect(undefined, results({ previousBest: null, newBest: true })), null, 'a stage that connects during results does not replay it');
    assert.equal(gameEffect({ phase: 'results', roundId: 'round-001' }, results({ previousBest: null, newBest: true })), null);
});

// Same path as production: real game event → approved line → published part → playback ACK → speech_started → effect.
test('replay through the engine: the effect comes from the real speech_started (after the playback ACK), never before', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm', reaction: 'happy' }) },
        conversation: { generate: async () => 'よし。' }, voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e); e.director.opened = true; e.blocks.start(); e.blocks.takeLine();
    e.blocks.round.startsAt = 0; e.blocks.tick();
    const board = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    e.ingestGame({ roundId: 'round-001', snapshot: { roundId: 'round-001', revision: 9, score: 3000, clearedLines: 3, elapsedMs: 5000, highestStack: 4, holes: 0, danger: 'low', nextPiece: 'line', board },
        events: [{ id: 'round-001:9:line_clear', type: 'line_clear', revision: 9, gameTimeMs: 5000, facts: { count: 3, totalLines: 3, scoreDelta: 3000 } }] });
    const events = []; e.on('event', ev => events.push(ev));
    for (let n = 0; n < 30 && !e.pending; n++) { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); if (!e.pending && e.preparationTask) await e.preparationTask; await new Promise(r => setImmediate(r)); }
    assert.ok(e.pending, 'the reaction line was published');
    assert.equal(events.filter(ev => ev.type === 'speech_started').length, 0, 'no effect while the audio has not started');
    assert.equal(e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'started' }), true);
    const started = events.find(ev => ev.type === 'speech_started').data;
    assert.equal(started.cue.utterance, 'game_reaction'); assert.equal(started.cue.eventId, 'round-001:9:line_clear');
    const fx = new EffectDirector(); fx.setEpoch(started.cue.epoch);
    const shown = fx.offer(speechEffect(started));
    assert.equal(shown.preset, 'joy'); assert.equal(shown.telop, telopFrom(started.text, 'joy')); assert.ok(started.text.includes(shown.telop), 'the telop is words she actually says');
    assert.equal(fx.offer(speechEffect(started)), null, 'a replayed/duplicated start never fires twice');
});
