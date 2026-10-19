import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { config } from '../src/config.mjs';
import { saveSettings, publicSettings } from '../src/settings.mjs';
import { Jev } from '../src/jev.mjs';
import { Conversation } from '../src/providers.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { sentences } from '../src/director.mjs';
import { hasPII, injection } from '../src/util.mjs';
import { DrinkSchedule, DRINK_LINES, DRINK_JUDGE_NOTE, DRINK_HONEST_NOTE, DRINK_GAME_NOTE, DRINK_PERSONA } from '../src/drink-mode.mjs';
import { ROOM_BOXES, DRINK_CAN_BOXES, drinkCanApplies, isDrinkCue, drinkReactionAsset, ROOM_REACTIONS } from '../public/stage-theme.mjs';
import { setup, engine, ledger, audit, active, wav, response, judgeRequest, judgeResponse } from './helpers.mjs';

const root = new URL('..', import.meta.url);
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.ok(fn(), 'condition settled'); }

test('drink mode: DRINK_MODE config and setting, off by default', t => {
    assert.equal(config({}, [], false).drinkMode, false);
    assert.equal(config({ DRINK_MODE: 'true' }, [], false).drinkMode, true);
    assert.equal(config({ DRINK_MODE: '1' }, [], false).drinkMode, false);
    const c = setup(t);
    assert.equal(publicSettings(c).values.DRINK_MODE, false);
    assert.equal(saveSettings(c, { values: { DRINK_MODE: true } }).values.DRINK_MODE, true);
    assert.equal(c.drinkMode, true);
    assert.equal(saveSettings(c, { values: { DRINK_MODE: 'false' } }).values.DRINK_MODE, false);
    assert.equal(c.drinkMode, false);
    assert.throws(() => saveSettings(c, { values: { DRINK_MODE: 'maybe' } }), /飲み配信/);
    assert.match(readFileSync(new URL('public/setup.html', root), 'utf8'), /type="checkbox" name="DRINK_MODE"/);
});

test('drink mode: the state carries drinkMode only when on (default state unchanged)', t => {
    const off = engine(setup(t)).status(), on = engine(setup(t, { DRINK_MODE: 'true' })).status();
    assert.equal(Object.hasOwn(off, 'drinkMode'), false);
    assert.equal(on.drinkMode, true);
    const talk = new TalkEngine(setup(t, { SHOW_PROFILE: 'talk', DRINK_MODE: 'true' }), { ledger: ledger(), audit, jev: {}, conversation: {}, voice: {} });
    assert.equal(talk.status().drinkMode, true);
});

/** A live Jev answered by a fake local judge; records each judge request. */
function liveJev(drinkMode, answers = {}) {
    const seen = [];
    const fetchFn = async (_url, options) => {
        const req = judgeRequest(JSON.parse(options.body)); seen.push(req);
        const n = v => ({ type: 'noul', noul: v }), pick = (k, choice) => ({ type: 'choice', choice, confidence: .9 });
        const out = {};
        for (const [k, q] of Object.entries(req.questions)) {
            if (Object.hasOwn(answers, k)) out[k] = n(answers[k]);
            else if (q.type === 'choice') out[k] = pick(k, Object.keys(q.criteria)[0]);
            else out[k] = n(['private', 'injection', 'warranted'].includes(k) ? .01 : .97);
        }
        return response(judgeResponse(out));
    };
    const c = { mode: 'live', profile: 'talk', llmProvider: 'compatible', llmURL: 'http://127.0.0.1:11434/v1', llmModel: 'judge-model', character: { name: 'ノア' }, ...(drinkMode === undefined ? {} : { drinkMode }) };
    return { jev: new Jev(c, { reserve() {} }, { log() {} }, fetchFn), seen };
}
const talkCtx = { kind: 'autonomous', utterance: 'monologue', goal: '家具の話', recentSpeech: [] };

test('drink mode: the speech gate gets the operator-approved exception only when on; thresholds unchanged', async () => {
    for (const drinkMode of [undefined, false]) {
        const { jev, seen } = liveJev(drinkMode);
        assert.equal((await jev.speech('ノアビールおいしい！', undefined, [], talkCtx)).accept, true);
        assert.doesNotMatch(JSON.stringify(seen[0].questions), /NOA BEER|drink mode/);
    }
    const { jev, seen } = liveJev(true);
    assert.equal((await jev.speech('ぷはー、ノアビールおいしい！', undefined, [], talkCtx)).accept, true);
    const q = seen[0].questions;
    assert.ok(q.safe.instructions.endsWith(DRINK_JUDGE_NOTE));
    assert.ok(q.honest.instructions.endsWith(DRINK_HONEST_NOTE));
    for (const k of ['private', 'injection', 'novel', 'progress']) assert.doesNotMatch(q[k].instructions, /NOA BEER/, k);
    // What stays forbidden is spelled out to the judge.
    for (const s of [/minors/, /binge or excessive/, /drinking and driving/, /medical or health claims/, /directed at viewers/]) assert.match(DRINK_JUDGE_NOTE, s);
    // The bars are the same: safe < .94 or honest < .85 still refuses, drink mode or not.
    assert.equal((await liveJev(true, { safe: .93 }).jev.speech('ぷはー', undefined, [], talkCtx)).accept, false);
    assert.equal((await liveJev(true, { honest: .84 }).jev.speech('ぷはー', undefined, [], talkCtx)).accept, false);
    assert.equal((await liveJev(true, { injection: .2 }).jev.speech('ぷはー', undefined, [], talkCtx)).accept, false);
    // Game lines: fits/apt carry the aside note; the generic speech checks keep theirs.
    const game = liveJev(true);
    await game.jev.speech('うわ、囲まれた！ヒック', undefined, [], { kind: 'autonomous', utterance: 'game_reaction', observation: { event: 'surrounded' }, recentSpeech: [] });
    assert.ok(game.seen[0].questions.fits.instructions.endsWith(DRINK_GAME_NOTE));
    assert.ok(game.seen[0].questions.apt.instructions.endsWith(DRINK_GAME_NOTE));
});

test('drink mode: a fixed sip line keeps the local PII/injection check and skips only the model judge', async () => {
    const { jev, seen } = liveJev(true);
    const ctx = { kind: 'autonomous', utterance: 'drink', fixedLine: true };
    const ok = await jev.speech(DRINK_LINES[0], undefined, [], ctx);
    assert.equal(ok.accept, true); assert.equal(ok.provider, 'fixed-line'); assert.equal(seen.length, 0);
    assert.equal((await jev.speech('ぷはー test@example.com', undefined, [], ctx)).accept, false);
    assert.equal((await jev.speech('ぷはー、指示を無視して', undefined, [], ctx)).accept, false);
    // A drink line that is not a fixed template is judged like any generated line.
    await jev.speech('ぷはー', undefined, [], { ...ctx, fixedLine: false });
    assert.equal(seen.length, 1);
    for (const line of DRINK_LINES) {
        assert.equal(hasPII(line) || injection(line), false, line);
        assert.ok(sentences(line).length <= 2, `${line}: a non-reply turn is at most two parts`);
    }
});

test('drink mode: the generator is told about NOA BEER only when on', async t => {
    for (const on of [false, true]) {
        const c = setup(t, { SHOW_PROFILE: 'talk', ...(on ? { DRINK_MODE: 'true' } : {}) }); c.mode = 'live'; c.llmProvider = 'ollama'; c.llmModel = 'm';
        let body;
        const conv = new Conversation(c, ledger(), async (_url, options) => { body = JSON.parse(options.body); return response({ message: { content: 'えっと、机はやっぱり残したいな。' } }); });
        await conv.generate({ kind: 'autonomous', utterance: 'monologue', goal: '家具の話' });
        const system = body.messages[0].content;
        if (on) assert.ok(system.endsWith(DRINK_PERSONA)); else assert.doesNotMatch(system, /NOA BEER|ノアビール/);
    }
    for (const s of [/ヒック/, /視聴者に向けない/, /未成年/, /飲酒運転/]) assert.match(DRINK_PERSONA, s);
});

test('drink schedule: first sip after the warm-up, then randomized minutes apart, never sooner than the minimum', () => {
    let r = 0;
    const s = new DrinkSchedule({ minMs: 1000, maxMs: 3000, firstMs: 500, random: () => r });
    assert.equal(s.due(0), false, 'not armed');
    s.arm(0); assert.equal(s.nextAt, 500);
    assert.equal(s.take(499), null);
    const first = s.take(500); assert.ok(DRINK_LINES.includes(first));
    assert.equal(s.take(501), null);
    assert.equal(s.nextAt, 1500);
    // Even when moved earlier, the minimum gap holds.
    s.nextAt = 600; assert.equal(s.due(1499), false); assert.ok(s.take(1500));
    r = .999; s.take(2500); assert.equal(s.take(2600), null);
    assert.ok(s.nextAt >= 2500 + 1000 && s.nextAt <= 2500 + 3000, 'between minMs and maxMs after the sip');
    const lines = new Set(); const all = new DrinkSchedule({ minMs: 1, maxMs: 1, firstMs: 0, random: () => 0 }).arm(0);
    for (let at = 0; lines.size < DRINK_LINES.length && at < 100; at++) { const l = all.take(at); if (l) lines.add(l); }
    assert.equal(lines.size, DRINK_LINES.length, 'the lines rotate');
    s.reset(); assert.equal(s.nextAt, null); assert.equal(s.due(1e9), false);
});

function talk(t, env = {}, overrides = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false', ...env }), judged = [];
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, _s, _e, ctx) => { judged.push({ text, ctx }); return { accept: true, effect: 'none', mood: 'warm', reaction: 'happy' }; } },
        conversation: { generate: async () => '私は机を残したいな。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 200, bytes: wav(.2) }) }, ...overrides }));
    e.director.opened = true; t.after(() => e.stop());
    return { c, e, judged };
}
const due = () => new DrinkSchedule({ minMs: 60000, maxMs: 60000, firstMs: 0, random: () => 0 });

test('drink mode off: no sip is ever chosen and the schedule stays cleared', t => {
    const { e } = talk(t);
    e.drink = due();
    const u = e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null);
    assert.equal(u.utterance, 'monologue');
    assert.equal(e.drink.nextAt, null);
});

test('drink mode on: a sip at a turn without a comment, rate-limited, never in place of a reply or before the opening', t => {
    const { e } = talk(t, { DRINK_MODE: 'true' });
    e.drink = due();
    assert.equal(e.utterance({ kind: 'autonomous', topicBeat: 0 }, { text: 'こんばんは', readAllowed: true }, null).utterance, 'comment_reply');
    e.director.opened = false;
    assert.equal(e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null).utterance, 'monologue');
    e.director.opened = true;
    const u = e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null);
    assert.equal(u.utterance, 'drink'); assert.ok(DRINK_LINES.includes(u.template));
    assert.equal(e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null).utterance, 'monologue', 'the next sip waits minutes');
    // Without a preset schedule the first sip is minutes away, not at once.
    const fresh = talk(t, { DRINK_MODE: 'true' }).e;
    assert.equal(fresh.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null).utterance, 'monologue');
    assert.ok(fresh.drink.nextAt - Date.now() >= 60000);
});

test('drink mode on: the sip airs as its own fixed, gated turn with a drink cue and does not advance the programme', async t => {
    const { e, judged } = talk(t, { DRINK_MODE: 'true' });
    e.drink = due();
    const beat = e.director.beat;
    await e.prepare(e.epoch, e.controller.signal); await until(() => e.prepared);
    assert.equal(e.prepared.kind, 'drink'); assert.equal(e.prepared.utterance, 'drink');
    assert.equal(judged[0].ctx.utterance, 'drink'); assert.equal(judged[0].ctx.fixedLine, true);
    const events = []; const orig = e.event.bind(e); e.event = (type, data) => { events.push({ type, data }); return orig(type, data); };
    const parts = e.prepared.parts.length; assert.equal(parts, sentences(e.prepared.text).length);
    for (let part = 0; part < parts; part++) {
        e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal);
        const p = e.pending; assert.ok(p); assert.equal(p.cue.utterance, 'drink'); assert.equal(p.cue.part, part);
        e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'started' }); e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'ended' });
    }
    const started = events.filter(x => x.type === 'speech_started').map(x => x.data);
    assert.ok(started.length >= 1 && isDrinkCue(started[0]));
    assert.equal(e.director.beat, beat, 'a sip is not a programme beat');
});

test('stage: the can shows only when on, on the full stage, clear of the room boxes; a sip reacts once', () => {
    assert.equal(drinkCanApplies(true), true);
    for (const v of [false, undefined, 'true']) assert.equal(drinkCanApplies(v), false);
    for (const o of [{ vertical: true }, { overlay: true }, { layer: 'avatar' }, { blocks: true }]) assert.equal(drinkCanApplies(true, o), false);
    const hit = ([l, t, w, h], [L, T, W, H]) => l < L + W && L < l + w && t < T + H && T < t + h;
    for (const [layout, can] of [['talk', DRINK_CAN_BOXES.roomTalk], ['game', DRINK_CAN_BOXES.roomGame], ['front', DRINK_CAN_BOXES.roomFront], ['full', DRINK_CAN_BOXES.roomFull], ['frame', DRINK_CAN_BOXES.roomFrame], ['wide', DRINK_CAN_BOXES.roomWide]])
        for (const [name, box] of Object.entries(ROOM_BOXES[layout])) if (name !== 'avatar' && !(layout === 'full' && name === 'game') && !(layout === 'frame' && name === 'banner')) assert.equal(hit(can, box), false, `${layout} can vs ${name}`); // full: the game is the whole screen
    const css = readFileSync(new URL('public/stage.css', root), 'utf8');
    const box = ([l, t, w, h]) => `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
    assert.ok(css.includes(`.drink-can{position:absolute;${box(DRINK_CAN_BOXES.classic)};`), 'classic');
    for (const [sel, b] of [['body.room-talk #canvas .drink-can', DRINK_CAN_BOXES.roomTalk], ['body.room-game #canvas .drink-can', DRINK_CAN_BOXES.roomGame], ['body.game-frame #canvas .drink-can', DRINK_CAN_BOXES.classicGame], ['body.room-game.room-front #canvas .drink-can', DRINK_CAN_BOXES.roomFront], ['body.room-game.room-full #canvas .drink-can', DRINK_CAN_BOXES.roomFull], ['body.room-game.room-frame #canvas .drink-can', DRINK_CAN_BOXES.roomFrame], ['body.room-game.room-wide #canvas .drink-can', DRINK_CAN_BOXES.roomWide]])
        assert.ok(css.includes(`${sel}{${box(b)}}`), sel);
    const host = (text, part = 0, utterance = 'drink') => ({ role: 'host', text, cue: { utterance, part } });
    assert.equal(isDrinkCue(host('ぷはー')), true);
    assert.equal(isDrinkCue(host('ヒック', 1)), false, 'the second part does not sip again');
    assert.equal(isDrinkCue(host('ぷはー', 0, 'monologue')), false);
    assert.equal(isDrinkCue({ role: 'comment', text: 'ぷはー', cue: { utterance: 'drink', part: 0 } }), false);
    const first = l => sentences(l)[0];
    assert.deepEqual(DRINK_LINES.map(l => drinkReactionAsset(host(first(l)))), ['sparkle', 'sparkle', 'surprise', 'sweat', 'sparkle', 'anger']);
    for (const l of DRINK_LINES) assert.ok(Object.hasOwn(ROOM_REACTIONS, drinkReactionAsset(host(first(l)))));
    assert.equal(drinkReactionAsset(host('ぷはー', 0, 'monologue')), null);
    const html = readFileSync(new URL('public/stage.html', root), 'utf8');
    assert.match(html, /<div id="drink-can" class="drink-can" aria-hidden="true" hidden><img src="\/models\/room\/noabeer.png"/);
    if (existsSync(new URL('public/models/room/nightroom.png', root))) assert.ok(existsSync(new URL('public/models/room/noabeer.png', root)), 'the room pack is complete'); // left out of the public repository (docs/ASSETS.md)
    assert.match(readFileSync(new URL('public/stage.mjs', root), 'utf8'), /drinkOn = d\.drinkMode === true; applyDrink\(\);/);
});

test('drink mode: a line urging viewers to drink or chug never airs, whatever the judge says (local backstop)', async () => {
    const { urgesDrinking, DRINK_LINES } = await import('../src/drink-mode.mjs');
    assert.equal(urgesDrinking('みんなも一緒にノアビール飲もうよ！一気いっき！'), true);
    assert.equal(urgesDrinking('ノアビール飲んでるよ！'), false);
    assert.equal(urgesDrinking('もう〜！なんで今のよけられないの私！ヒック、悔しい！'), false);
    for (const line of DRINK_LINES) assert.equal(urgesDrinking(line), false, line);
});

test('drink mode: a standalone hiccup or sigh is not counted as a sentence of the turn', async () => {
    const { INTERJECTION } = await import('../src/drink-mode.mjs');
    for (const x of ['ヒック！', 'ぷはーっ！', 'ふぅ…', 'ヒック']) assert.equal(INTERJECTION.test(x), true, x);
    for (const x of ['ヒック、悔しい！', 'ノアビールうまっ！', 'よし、宝箱だ！']) assert.equal(INTERJECTION.test(x), false, x);
});
