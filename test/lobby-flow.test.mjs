import test from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../src/director.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { active, audit, defer, ledger, setup, wav } from './helpers.mjs';

// All providers are local fakes. No engine, browser, controller, or network starts.
const scenes = Array.from({ length: 3 }, (_, s) => ({
    id: `scene-${s}`, title: `場面${s}`, premise: `架空の小物${s}を考える`,
    beats: Array.from({ length: 3 }, (_, b) => ({
        id: `step-${b}`, label: `段階${b}`, action: ['setup', 'complication', 'payoff'][b],
        task: `小物${s}の段階${b}を進める`, minChars: 5, maxChars: 90, demo: `小物${s}の段階${b}です。`
    }))
}));
const cards = [{ id: 'fixture', title: '架空の小物', angles: ['考える'], beats: [
    { id: 'old-lobby', label: '旧雑談', task: '旧雑談', lobby: true },
    { id: 'game-1', label: 'ゲーム1', task: '観測を話す', game: true },
    { id: 'game-2', label: 'ゲーム2', task: '観測を話す', game: true }
] }];
const approved = { accept: true, mood: 'warm', effect: 'none' };

function rig(t, { generate, speech, synthesize } = {}) {
    // Use the generic configuration, then inject this small deck. This test does
    // not depend on the editorial content or length of the production scene file.
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'room', READ_COMMENTS: 'false', SPEECH_DIRECTION: 'off' });
    Object.assign(c, { topicCards: cards, lobbyScenes: scenes, finiteProgramme: false, game: null });
    const contexts = [], synthesized = [], events = [];
    const e = new TalkEngine(c, {
        ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: speech || (async () => approved) },
        conversation: { generate: async (ctx, signal) => {
            contexts.push(ctx);
            return generate ? generate(ctx, signal) : `小さな案${contexts.length}をひとつ考えたよ。`;
        } },
        voice: { synthesize: async (text, signal) => {
            synthesized.push(text);
            return synthesize ? synthesize(text, signal) : { kind: 'wav', durationMs: 40, bytes: wav(.04) };
        } },
        research: { search: async () => { throw new Error('Unexpected search'); } }
    });
    e.blocks = new VampireShow({ lobbyMinutes: 10 }, { dataDir: c.dataDir });
    e.on('event', event => events.push(event));
    active(e); e.blocks.start(); e.director.reset(1); e.director.opened = true;
    e.endAt = Date.now() + 60 * 60000;
    t.after(() => e.stop('test'));
    return { e, contexts, synthesized, events };
}
async function publish(e) {
    e.claimRenderer('test-renderer'); e.nextTurnAt = 0; e.generationRetryAt = 0;
    await e.speakStep(e.epoch, e.controller.signal);
    return e.pending;
}
function ack(e, event, id = e.pending?.id) {
    return e.acknowledge({ id, lease: e.renderer.lease, event });
}
async function finishTurn(e) {
    const turn = e.currentTurn;
    assert.ok(turn);
    await turn.audioTask;
    for (let n = 0; e.currentTurn === turn && n < 4; n++) {
        if (!e.pending) await publish(e);
        assert.ok(e.pending);
        if (!e.pending.started) assert.equal(ack(e, 'started'), true);
        assert.equal(ack(e, 'ended'), true);
    }
    assert.notEqual(e.currentTurn, turn, 'the whole turn must finish');
}
async function prefetch(e) {
    e.startPrefetch(e.epoch, e.controller.signal);
    await e.preparationTask;
}
function heardTurn(d, serial, text = `再生した発話${serial}。`) {
    return { ...d.context(), serial, revision: d.revision, text };
}

test('scene expansion preserves authored order inside shuffled scenes and keeps game beats intact', () => {
    const before = JSON.stringify(cards), d = new Director(cards, { lobbyScenes: scenes });
    d.reset(14); const order = d.cards[0].beats.map(b => b.id);
    d.reset(14); assert.deepEqual(d.cards[0].beats.map(b => b.id), order, 'seed is reproducible');
    assert.equal(JSON.stringify(cards), before, 'reset must not mutate shared programme cards');
    assert.equal(order.includes('old-lobby'), false);
    assert.deepEqual(d.cards[0].beats.slice(-2), cards[0].beats.slice(-2));
    const lobby = d.cards[0].beats.filter(b => b.lobby);
    assert.equal(new Set(lobby.map(b => b.id)).size, 9);
    for (let i = 0; i < lobby.length; i += 3) {
        assert.deepEqual(lobby.slice(i, i + 3).map(b => b.lobbyStory.step), [1, 2, 3]);
        assert.equal(new Set(lobby.slice(i, i + 3).map(b => b.lobbyStory.sceneId)).size, 1);
    }
    assert.strictEqual(new Director(cards).cards, cards, 'unconfigured programmes retain their deck');
});

test('partial, unstarted, wrong-lease, old and duplicate ACKs cannot commit a scene turn', async t => {
    const { e } = rig(t, { generate: async () => '青いカップを考えたよ。取っ手は月の形にしよう。' });
    await publish(e);
    const firstId = e.pending.id;
    assert.equal(ack(e, 'ended'), false);
    assert.equal(e.acknowledge({ id: firstId, lease: 'old-lease', event: 'started' }), false);
    assert.equal(ack(e, 'started'), true);
    assert.equal(ack(e, 'ended'), true);
    assert.equal(e.director.beat, 0);
    assert.deepEqual(e.director.lobbyHeard, []);
    assert.deepEqual(e.director.lobbyCompleted, []);
    assert.equal(e.memory.items.length, 1, 'only the actually completed first part is general memory');
    assert.equal(ack(e, 'ended', firstId), false);
    await finishTurn(e);
    assert.equal(e.director.beat, 1);
    assert.equal(e.director.lobbyHeard.length, 1);
    assert.equal(e.director.lobbyHeard[0].text, '青いカップを考えたよ。取っ手は月の形にしよう。');
    assert.equal(ack(e, 'ended', firstId), false);
    assert.equal(e.director.lobbyHeard.length, 1);
});

test('projection and cancellation do not turn a generated continuation into heard scene history', async t => {
    const { e, contexts } = rig(t);
    await publish(e); ack(e, 'started');
    await prefetch(e);
    assert.equal(contexts[1].lobbyStory.step, 2);
    assert.deepEqual(contexts[1].lobbyStory.heard, []);
    assert.deepEqual(e.director.lobbyHeard, []);
    assert.deepEqual(e.director.lobbyCompleted, []);
    assert.ok(contexts[1].preparedContinuation?.notYetFullyHeard);
    e.cancelSpeech('test_interrupt');
    assert.equal(e.director.beat, 0);
    assert.deepEqual(e.director.context().lobbyStory.heard, []);
    assert.equal(e.prepared, null);
});

test('a selected reply discards speculation, does not consume a beat, and resumes the heard scene', async t => {
    const { e, contexts } = rig(t, { generate: async ctx => ctx.comment ? 'その形なら持ちやすそうだね。' : `架空の小物${ctx.topicBeat}を考えているよ。` });
    await publish(e); const first = e.currentTurn.text; ack(e, 'started');
    await prefetch(e); assert.equal(e.prepared.lobbyStory.step, 2);
    assert.equal(e.ingest({ text: '取っ手を丸くするのはどうかな', author: 'fixture' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.prepared, null);
    await finishTurn(e);
    assert.equal(e.director.beat, 1);
    await publish(e);
    assert.equal(e.currentTurn.kind, 'reply');
    assert.equal(e.currentTurn.lobbyStory, null);
    await finishTurn(e);
    assert.equal(e.director.beat, 1);
    assert.equal(e.director.lobbyHeard.length, 1);
    await publish(e);
    assert.equal(contexts.at(-1).lobbyStory.step, 2);
    assert.deepEqual(contexts.at(-1).lobbyStory.heard.map(x => x.text), [first]);
    assert.equal(contexts.at(-1).dialogue.length, 1);
});

test('a refused speculative step waits for the current ACK and skips only the rest of its scene', async t => {
    const { e, synthesized } = rig(t, {
        generate: async ctx => ctx.lobbyStory.step === 2 ? '拒否する続き。' : '最初の案を話したよ。',
        speech: async text => text === '拒否する続き。' ? { accept: false, reason: 'unsafe_or_uncertain' } : approved
    });
    await publish(e); const sceneId = e.currentTurn.lobbyStory.sceneId; ack(e, 'started');
    await prefetch(e);
    assert.equal(e.director.beat, 0, 'uncompleted playing speech still owns the cursor');
    assert.deepEqual(e.director.lobbyHeard, []);
    assert.deepEqual(synthesized, ['最初の案を話したよ。'], 'refused text never reaches TTS');
    await finishTurn(e);
    assert.equal(e.director.beat, 3, 'the next scene must start at its first beat, not its second');
    assert.notEqual(e.director.beatSpec().lobbyStory.sceneId, sceneId);
    assert.equal(e.director.beatSpec().lobbyStory.step, 1);
    assert.deepEqual(e.director.lobbyHeard.map(x => x.text), ['最初の案を話したよ。']);
    assert.deepEqual(e.director.lobbyCompleted, [], 'a rejected tail is not a completed scene');
});

test('cancelling a playing turn clears its speculative refusal rather than skipping a later retry', async t => {
    const { e } = rig(t, {
        generate: async ctx => ctx.lobbyStory.step === 2 ? '拒否する続き。' : '最初の案を話したよ。',
        speech: async text => text === '拒否する続き。' ? { accept: false, reason: 'unsafe_or_uncertain' } : approved
    });
    await publish(e); ack(e, 'started'); await prefetch(e);
    e.cancelSpeech('test_interrupt');
    await publish(e); await finishTurn(e);
    assert.equal(e.director.beat, 1);
    assert.equal(e.director.beatSpec().lobbyStory.step, 2);
});

test('a speculative refusal arriving after the current ACK still skips the intended remaining scene once', async t => {
    const gate = defer();
    const { e } = rig(t, {
        generate: async ctx => ctx.lobbyStory.step === 2 ? '判定待ちの続き。' : '最初の案を話したよ。',
        speech: async text => text === '判定待ちの続き。' ? gate.promise : approved
    });
    await publish(e); ack(e, 'started');
    e.startPrefetch(e.epoch, e.controller.signal);
    const task = e.preparationTask;
    await finishTurn(e);
    assert.equal(e.director.beat, 1);
    gate.resolve({ accept: false, reason: 'unsafe_or_uncertain' });
    await task;
    assert.equal(e.director.beat, 3);
    assert.equal(e.director.beatSpec().lobbyStory.step, 1);
    assert.equal(e.director.lobbyHeard.length, 1);
    assert.deepEqual(e.director.lobbyCompleted, []);
});

test('a non-speculative refusal skips a scene without inventing playback or a summary', async t => {
    const { e, synthesized } = rig(t, { speech: async () => ({ accept: false, reason: 'unsafe_or_uncertain' }) });
    await publish(e);
    assert.equal(e.pending, null);
    assert.equal(e.director.beat, 3);
    assert.equal(e.director.beatSpec().lobbyStory.step, 1);
    assert.deepEqual(synthesized, []);
    assert.deepEqual(e.director.lobbyHeard, []);
    assert.deepEqual(e.director.lobbyCompleted, []);
});

test('scene summaries require the final ACK and scene-boundary prefetch waits for that ACK', async t => {
    const { e, contexts } = rig(t);
    for (let n = 0; n < 2; n++) { await publish(e); await finishTurn(e); }
    await publish(e); ack(e, 'started');
    assert.equal(e.director.lobbyCompleted.length, 0);
    const calls = contexts.length;
    await prefetch(e);
    assert.equal(contexts.length, calls, 'no next-scene generation before the current payoff completes');
    const last = e.currentTurn.text;
    await finishTurn(e);
    assert.equal(e.director.lobbyCompleted.length, 1);
    assert.equal(e.director.lobbyCompleted[0].lastHeard, last);
    assert.deepEqual(e.director.context().lobbyStory.heard, [], 'new scene has no invented first step');
    assert.equal(e.director.context().lobbyStory.previousScenes.length, 1);
});

test('a slow generation completed after the lobby timer cannot publish the expired story', async t => {
    const delayed = defer();
    const { e, events } = rig(t, { generate: () => delayed.promise });
    const preparation = publish(e);
    await Promise.resolve();
    e.blocks.lobbyStartedAt = Date.now() - 600001; e.blocks.tick();
    assert.equal(e.blocks.leadIn.reason, 'timer');
    delayed.resolve('時間切れの雑談だよ。');
    await preparation;
    assert.equal(events.some(x => x.type === 'speech' && x.data.text === '時間切れの雑談だよ。'), false);
    assert.deepEqual(e.director.lobbyHeard, []);
});

test('the lobby deadline aborts an in-flight provider without counting a provider failure or advancing history', async t => {
    let requestSignal;
    const { e, synthesized } = rig(t, { generate: (_ctx, signal) => {
        requestSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    e.blocks.lobbyStartedAt = Date.now() - 600000 + 15;
    // This referenced timer lets the unref'ed production deadline run naturally;
    // no fake Date or timers leak into another concurrently loaded test file.
    await Promise.all([publish(e), new Promise(resolve => setTimeout(resolve, 35))]);
    assert.equal(requestSignal.aborted, true);
    assert.equal(e.preparing, null);
    assert.equal(e.pending, null);
    assert.equal(e.generationFailures, 0);
    assert.equal(e.director.beat, 0);
    assert.deepEqual(e.director.lobbyHeard, []);
    assert.deepEqual(synthesized, []);
});

test('published but unstarted lobby speech is cancelled when the lobby ends, including a late started ACK', async t => {
    const { e } = rig(t);
    await publish(e); const id = e.pending.id;
    assert.equal(e.pending.started, false);
    e.blocks.startGame('operator');
    assert.equal(ack(e, 'started', id), false, 'a late renderer start must not start an expired scene');
    assert.equal(e.pending, null);
    assert.deepEqual(e.director.lobbyHeard, []);
});

test('already playing lobby speech may finish after the timer without starting a continuation', async t => {
    const { e, contexts } = rig(t, { generate: async () => '続きの前に一案を話すね。少し丸い形にするよ。' });
    await publish(e); ack(e, 'started');
    e.blocks.startGame('timer');
    await finishTurn(e);
    assert.equal(e.director.lobbyHeard.length, 1);
    await publish(e);
    assert.equal(e.currentTurn?.utterance, 'game_fact');
    assert.equal(contexts.length, 1, 'the required fixed lead-in replaces any new scene generation');
});

test('expired lobby speech keeps its cursor until its ACK even after transition announcements are exhausted', async t => {
    const { e, contexts } = rig(t);
    await publish(e); ack(e, 'started');
    // The time-based transition may already have reached idle, and its fixed
    // announcements may have been consumed/refused, while this turn still plays.
    e.blocks.phase = 'idle'; e.blocks.leadIn = null; e.blocks.announcements = [];
    await prefetch(e);
    assert.equal(contexts.length, 1);
    assert.equal(e.director.beat, 0, 'speculative selection must not skip the live turn cursor');
    await finishTurn(e);
    assert.equal(e.director.beat, 1);
    assert.equal(e.director.lobbyHeard.length, 1, 'the completed turn remains in heard history');
    await publish(e);
    assert.equal(e.director.beatSpec().id, 'game-1', 'the first game beat is retained after the one bulk skip');
    assert.equal(e.director.index, 0);
    assert.equal(e.pending, null);
});

test('the lobby deck reaches the game once without wrapping; leaving the lobby skips all remaining scenes at once', t => {
    const { e } = rig(t);
    const ids = [];
    for (let n = 0; n < 9; n++) {
        assert.equal(e.blocksUtterance(e.director.context(), null).lobby, true);
        ids.push(e.director.beatSpec().id);
        e.director.commit(heardTurn(e.director, n + 1));
    }
    assert.equal(new Set(ids).size, 9);
    assert.equal(e.director.index, 0);
    assert.equal(e.director.beatSpec().id, 'game-1');
    assert.equal(e.blocksUtterance(e.director.context(), null).utterance, 'quiet');
    assert.equal(e.blocks.leadIn.reason, 'lobby_topics_complete');
    assert.equal(e.director.index, 0, 'completing the deck cannot loop to the same scenes');
    e.director.reset(1); e.director.opened = true; e.blocks.phase = 'playing'; e.blocks.announcements = [];
    assert.equal(e.blocksUtterance(e.director.context(), null).utterance, 'quiet');
    assert.equal(e.director.beatSpec().id, 'game-1', 'one selection skips every expired lobby beat');
    assert.deepEqual(e.director.lobbyCompleted, []);
});

test('scene history and completed summaries stay bounded across a full authored deck', () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ ...scenes[0], id: `bounded-${i}` }));
    const d = new Director(cards, { lobbyScenes: many }); d.opened = true;
    for (let n = 0; n < 48; n++) d.commit(heardTurn(d, n + 1));
    assert.ok(d.lobbyHeard.length <= 6);
    assert.equal(d.lobbyCompleted.length, 12);
    assert.equal(new Set(d.lobbyCompleted.map(x => x.sceneId)).size, 12);
    d.reset(1);
    assert.deepEqual(d.lobbyHeard, []);
    assert.deepEqual(d.lobbyCompleted, []);
});

test('three sentences are allowed for story turns and for replies (answer, then expand); four are not; the audio bound remains', async t => {
    const three = 'あ、小さいね。もう少し丸くしよう。これで決まり。';
    const a = rig(t, { generate: async () => three });
    await publish(a.e);
    assert.equal(a.e.currentTurn.parts.length, 3);
    await finishTurn(a.e);
    assert.equal(a.e.director.lobbyHeard.length, 1);
    const reply = rig(t, { generate: async () => three });
    reply.e.candidates.push({ id: 'reply-three', epoch: reply.e.epoch, created: Date.now(), kind: 'reply', text: 'もう少し丸くしたらどうかな', replyState: 'selected' });
    await publish(reply.e);
    assert.ok(reply.e.pending, 'a three-sentence reply (answer, then expand on the comment) airs');
    const four = rig(t, { generate: async () => 'あ、小さいね。もう少し丸くしよう。これで決まり。次も行こう。' });
    four.e.candidates.push({ id: 'reply-four', epoch: four.e.epoch, created: Date.now(), kind: 'reply', text: 'もう少し丸くしたらどうかな', replyState: 'selected' });
    await publish(four.e);
    assert.deepEqual(four.synthesized, [], 'a four-sentence reply cannot reach TTS');
    const long = rig(t, { generate: async () => '長い発話だよ。', synthesize: async () => ({ kind: 'wav', durationMs: 18001, bytes: wav(.04) }) });
    await publish(long.e);
    assert.equal(long.e.pending, null, 'the unchanged 18-second audio bound is enforced');
    assert.deepEqual(long.e.director.lobbyHeard, []);
    const longText = rig(t, { generate: async () => 'あ'.repeat(111) });
    await publish(longText.e);
    assert.equal(longText.e.pending, null, 'story text cannot exceed 110 characters');
    assert.deepEqual(longText.synthesized, []);
});
