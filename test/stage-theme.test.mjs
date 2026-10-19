import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { OBS, OVERLAY_GAME_CHAT, OVERLAY_TALK_CHAT, OVERLAY_GAME_ACTIONS, ROOM_GAME_CAPTURE, ROOM_OVERLAY_TALK_CHAT, ROOM_OVERLAY_GAME_CHAT, ROOM_OVERLAY_GAME_ACTIONS, ROOM_FRONT_GAME_CAPTURE, ROOM_FRONT_OVERLAY_GAME_CHAT, ROOM_WIDE_GAME_CAPTURE, ROOM_WIDE_OVERLAY_GAME_CHAT, ROOM_WIDE_OVERLAY_GAME_ACTIONS, ROOM_FULL_GAME_CAPTURE, ROOM_FULL_OVERLAY_GAME_CHAT, ROOM_FULL_OVERLAY_GAME_ACTIONS, ROOM_FRAME_GAME_CAPTURE, ROOM_FRAME_OVERLAY_GAME_CHAT, ROOM_FRAME_OVERLAY_GAME_ACTIONS } from '../src/obs.mjs';
import { config } from '../src/config.mjs';
import { saveSettings, publicSettings } from '../src/settings.mjs';
import { resolveStageTheme, roomApplies, roomTopic, chatBadges, ROOM_BOXES, speechReactionAsset, GameReactionTracker, ReactionGate, ROOM_REACTIONS, REACTION_GAP_MS, reactionBox } from '../public/stage-theme.mjs';
import { setup, engine } from './helpers.mjs';

const root = new URL('..', import.meta.url);
const game = { title: 'Vampire Survivors', capture: { cropTopPx: 56 } };
const fakeObs = (c, items = [{ sourceName: 'Chat', sceneItemId: 7 }, { sourceName: 'Commands', sceneItemId: 8 }]) => {
    const obs = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, obsChatSource: 'Chat', obsActionsSource: 'Commands', viewToken: 'v', ...c }), calls = [];
    obs.ready = true;
    obs.call = async (type, data) => { calls.push({ type, data }); return type === 'GetSceneItemList' ? { sceneItems: items } : type === 'GetInputList' ? { inputs: [{ inputName: 'Chat', inputKind: 'browser_source' }, { inputName: 'Commands', inputKind: 'browser_source' }] } : {}; };
    return { obs, calls };
};

test('theme: STAGE_THEME config and setting; classic by default; a view URL pins it, else the Studio state', t => {
    assert.equal(config({}, [], false).stageTheme, 'classic');
    assert.equal(config({ STAGE_THEME: 'room' }, [], false).stageTheme, 'room');
    assert.equal(config({ STAGE_THEME: 'neon' }, [], false).stageTheme, 'classic');
    const c = setup(t);
    assert.equal(publicSettings(c).values.STAGE_THEME, 'classic');
    assert.equal(saveSettings(c, { values: { STAGE_THEME: 'room' } }).values.STAGE_THEME, 'room');
    assert.equal(c.stageTheme, 'room');
    assert.throws(() => saveSettings(c, { values: { STAGE_THEME: 'neon' } }), /画面テーマ/);
    assert.equal(resolveStageTheme(null, undefined), 'classic');
    assert.equal(resolveStageTheme(null, 'room'), 'room');
    assert.equal(resolveStageTheme('classic', 'room'), 'classic');
    assert.equal(resolveStageTheme('bogus', 'room'), 'room');
    assert.equal(roomApplies('room'), true);
    for (const o of [{ vertical: true }, { overlay: true }, { layer: 'avatar' }, { blocks: true }, { inBrowserGame: true }]) assert.equal(roomApplies('room', o), false);
    assert.equal(roomApplies('classic'), false);
});

test('theme: the state carries stageTheme only in the room theme (classic state unchanged)', t => {
    const classic = engine(setup(t)).status(), room = engine(setup(t, { STAGE_THEME: 'room' })).status();
    assert.equal(Object.hasOwn(classic, 'stageTheme'), false);
    assert.equal(room.stageTheme, 'room');
});

test('obs classic: stage URLs, game capture and overlay spots are unchanged', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', streamTarget: 'simulcast' });
    assert.equal(o.gameStageSettings('http://127.0.0.1:8787').url, 'http://127.0.0.1:8787/stage#token=v&layout=game&simulcast=1&actions=external');
    assert.deepEqual(o.gameCaptureTransform(game.capture), { positionX: 48, positionY: 120, cropTop: 56, cropBottom: 0, cropLeft: 0, cropRight: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1120, boundsHeight: 630, boundsAlignment: 0 });
    const { obs, calls } = fakeObs({});
    await obs.placeOverlays(true);
    assert.deepEqual(calls.filter(x => x.type.startsWith('Set')).map(x => [x.type, x.data.sceneItemTransform ?? x.data.sceneItemEnabled]), [['SetSceneItemTransform', OVERLAY_TALK_CHAT], ['SetSceneItemEnabled', false]]);
    calls.length = 0;
    await obs.ensureOverlays('http://o', 'S');
    const settings = calls.filter(x => x.type === 'SetInputSettings').map(x => x.data.inputSettings);
    assert.deepEqual(settings.map(s => [s.url, s.width, s.height]), [['http://o/overlay-chat.html#token=v', 556, 175], ['http://o/overlay-actions.html#token=v', 556, 175]]);
    assert.deepEqual(calls.filter(x => x.type === 'SetSceneItemTransform').map(x => x.data.sceneItemTransform), [OVERLAY_GAME_CHAT, OVERLAY_GAME_ACTIONS]);
});

test('obs room: the game window fills the frame window; chat and commands land on the frame boxes at their sizes', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', stageTheme: 'room' });
    assert.equal(o.gameStageSettings('http://h').url, 'http://h/stage#token=v&layout=game&actions=external&theme=room&chat=1');
    const [x, y, w, h] = ROOM_BOXES.game.game;
    assert.deepEqual(o.gameCaptureTransform(game.capture), { positionX: x, positionY: y, cropTop: 56, cropBottom: 0, cropLeft: 0, cropRight: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: w, boundsHeight: h, boundsAlignment: 0 });
    assert.deepEqual(ROOM_GAME_CAPTURE, { positionX: x, positionY: y, boundsWidth: w, boundsHeight: h });
    const box = spot => [spot.transform.positionX, spot.transform.positionY, spot.size.width, spot.size.height];
    assert.deepEqual(box(ROOM_OVERLAY_TALK_CHAT), ROOM_BOXES.talk.chat);
    assert.deepEqual(box(ROOM_OVERLAY_GAME_CHAT), ROOM_BOXES.game.chat);
    // The command strip sits inside the game window's bottom edge, clear of every other box.
    const [ax, ay, aw, ah] = box(ROOM_OVERLAY_GAME_ACTIONS);
    assert.ok(ax >= x && ay >= y && ax + aw <= x + w && ay + ah <= y + h);
    const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    for (const k of ['avatar', 'goal', 'chat', 'selected', 'subtitle', 'pr']) assert.ok(!overlaps([ax, ay, aw, ah], ROOM_BOXES.game[k]), k);

    const { obs, calls } = fakeObs({ stageTheme: 'room' });
    await obs.placeOverlays(true);
    assert.deepEqual(calls.filter(x => x.type.startsWith('Set')).map(x => [x.type, x.data.inputSettings ?? x.data.sceneItemTransform ?? x.data.sceneItemEnabled]),
        [['SetInputSettings', { width: 464, height: 284 }], ['SetSceneItemTransform', ROOM_OVERLAY_TALK_CHAT.transform], ['SetSceneItemEnabled', false]]);
    calls.length = 0;
    await obs.placeOverlays(false);
    assert.deepEqual(calls.filter(x => x.type.startsWith('Set')).map(x => [x.type, x.data.inputSettings ?? x.data.sceneItemTransform ?? x.data.sceneItemEnabled]),
        [['SetInputSettings', { width: 424, height: 182 }], ['SetSceneItemTransform', ROOM_OVERLAY_GAME_CHAT.transform], ['SetSceneItemTransform', ROOM_OVERLAY_GAME_ACTIONS.transform], ['SetSceneItemEnabled', true]]);
    calls.length = 0;
    await obs.ensureOverlays('http://o', 'S');
    assert.deepEqual(calls.filter(x => x.type === 'SetInputSettings').map(x => [x.data.inputSettings.url, x.data.inputSettings.width, x.data.inputSettings.height]),
        [['http://o/overlay-chat.html#token=v&theme=room', 424, 182], ['http://o/overlay-actions.html#token=v&theme=room', 780, 36]]);
});

test('room page: frames, served images and the call to chat are in place; classic stage files keep their rules', () => {
    const html = readFileSync(new URL('public/stage.html', root), 'utf8'), css = readFileSync(new URL('public/stage.css', root), 'utf8');
    assert.match(html, /id="room-ui"/); assert.match(html, /💬 チャットでゲームに参加してノアを助けてね！/); assert.match(html, /Twitchのコメントはゲームにも反映されるよ/);
    // The room pack's images are the operator's; the public repository leaves them out (docs/ASSETS.md).
    if (existsSync(new URL('public/models/room/nightroom.png', root))) for (const n of ['nightroom', 'reactanger', 'reactsweat', 'reacttears', 'reactsparkle', 'reactsurprise', 'reactsuccess', 'reactfailure'])
        assert.ok(existsSync(new URL(`public/models/room/${n}.png`, root)), n);
    // Never the classic painted-room slot (docs/ART_BRIEF.md): that would change the classic look.
    assert.ok(!existsSync(new URL('public/models/room/background.png', root)) && !existsSync(new URL('public/models/room/desk.png', root)));
    // Every room rule is scoped under the theme (or hides the room-only elements by default).
    const room = css.slice(css.indexOf('/* ---- STAGE_THEME=room'));
    for (const rule of room.split('}').map(r => r.trim()).filter(r => r && !r.startsWith('@') && !/^\d|^from|^to|^0%/.test(r))) {
        const sel = rule.replace(/\/\*[\s\S]*?\*\//g, '').split('{')[0].trim();
        if (!sel || /^(0%|100%|\d+%|from|to)/.test(sel)) continue;
        assert.ok(/theme-room|room-talk|room-game|^\.room-|#canvas:has\(#picked\.show\) \.room-/.test(sel), sel);
    }
    // Text boxes in the CSS match the pack's coordinates.
    assert.match(css, /body\.room-talk #room-topic-text\{left:1410px;top:108px;width:448px;height:51px\}/);
    assert.match(css, /body\.room-game #room-topic-text\{left:840px;top:61px;width:390px;height:53px/);
    assert.match(css, /body\.room-talk #canvas #picked\{left:1430px;top:695px;width:428px;height:66px\}/);
    assert.match(css, /body\.room-game #canvas #vs-frame\{left:32px;top:140px;width:1376px;height:774px/);
});

test('room topic: a live question first, then the goal (game) or the talk topic', () => {
    const now = 1000, base = { running: true, streamTarget: 'simulcast', youtube: 'listening', twitch: 'connected', topic: { title: '服の居場所' } };
    assert.deepEqual(roomTopic(base, {}, now), { label: '今日のテーマ', text: '服の居場所' });
    const vs = { gameShow: { external: true, statusKey: 'v', goal: 'レベル80' }, v: { phase: 'playing' } };
    assert.deepEqual(roomTopic({ ...base, ...vs }, { game: true }, now), { label: '今日の目標', text: 'レベル80' });
    assert.deepEqual(roomTopic({ ...base, ...vs, gameShow: { ...vs.gameShow, goal: '' } }, { game: true }, now), { label: '今日の目標', text: '80レベルを超える' });
    const asked = { ...base, ...vs, v: { phase: 'playing', participation: { text: 'どの武器？', startedAt: 0, expiresAt: 5000 } } };
    assert.deepEqual(roomTopic(asked, { game: true }, now), { label: 'いまのお題', text: 'どの武器？' });
    assert.deepEqual(chatBadges('simulcast'), { youtube: true, twitch: true });
    assert.deepEqual(chatBadges('youtube'), { youtube: true, twitch: false });
    assert.deepEqual(chatBadges('twitch'), { youtube: false, twitch: true });
});

test('reactions: speech and game moments map to stickers; anger only on real frustration', () => {
    const s = (reaction, extra = {}) => speechReactionAsset({ id: 'x', role: 'host', reaction, ...extra });
    assert.equal(s('troubled'), 'sweat'); assert.equal(s('shock'), 'surprise'); assert.equal(s('surprised'), 'surprise');
    assert.equal(s('laugh'), 'sparkle'); assert.equal(s('excited'), 'sparkle');
    assert.equal(s('happy'), null); assert.equal(s('happy', { intensity: 'high' }), 'sparkle'); assert.equal(s('embarrassed'), null); assert.equal(s('neutral'), null);
    assert.equal(s('troubled', { affect: { frustration: .8 } }), 'anger');
    assert.equal(s('laugh', { affect: { frustration: .9 } }), 'sparkle', 'never anger on a happy line');
    assert.equal(s('troubled', { affect: { frustration: .5 } }), 'sweat');
    assert.equal(speechReactionAsset({ role: 'comment', reaction: 'shock' }), null, 'the comment reader gets none');

    const g = new GameReactionTracker(), st = (o = {}) => ({ phase: 'playing', run: 1, recent: [], lastResult: null, ...o });
    assert.deepEqual(g.update(st({ recent: [{ type: 'hp_low', gameSeconds: 5 }] })), [], 'the first status a view sees is not replayed');
    assert.deepEqual(g.update(st({ recent: [{ type: 'hp_low', gameSeconds: 5 }, { type: 'boss', gameSeconds: 9 }] })).map(x => x.asset), ['surprise']);
    assert.deepEqual(g.update(st({ recent: [{ type: 'level_up', gameSeconds: 12, facts: { level: 9 } }, { type: 'level_up', gameSeconds: 14, facts: { level: 10 } }] })).map(x => x.asset), ['success']);
    const over = id => st({ phase: 'results', lastResult: { roundId: id, reason: 'game_over', newBest: false } });
    assert.deepEqual(g.update(over('r1')).map(x => x.asset), ['failure']);
    assert.deepEqual(g.update(over('r1')), [], 'a result reacts once');
    assert.deepEqual(g.update(over('r2')).map(x => x.asset), ['failure']);
    assert.deepEqual(g.update(over('r3')).map(x => x.asset), ['tears'], 'every third game over in a row');
    assert.deepEqual(g.update(st({ phase: 'results', lastResult: { roundId: 'r4', reason: 'game_over', newBest: true } })).map(x => x.asset), ['success']);
});

test('reactions: rate limited — one at a time, a gap between, a cooldown per sticker, each moment once', () => {
    let now = 0; const gate = new ReactionGate({ now: () => now });
    assert.deepEqual(gate.offer('sweat', 'a'), { asset: 'sweat', ms: ROOM_REACTIONS.sweat.ms });
    now = 500; assert.equal(gate.offer('sparkle', 'b'), null, 'one sticker at a time');
    assert.equal(gate.offer('success', 'c')?.asset, 'success', 'a more important one takes over');
    now = 500 + ROOM_REACTIONS.success.ms + 10; assert.equal(gate.offer('sparkle', 'd'), null, 'the gap after a sticker');
    now = 500 + REACTION_GAP_MS + 10; assert.equal(gate.offer('sparkle', 'd')?.asset, 'sparkle');
    now += REACTION_GAP_MS + 10; assert.equal(gate.offer('sparkle', 'e'), null, 'sparkle cooldown');
    assert.equal(gate.offer('surprise', 'c'), null, 'the same moment never twice');
    assert.equal(gate.offer('surprise', 'f')?.asset, 'surprise');
    now += ROOM_REACTIONS.anger.cooldownMs; assert.equal(gate.offer('anger', 'g')?.asset, 'anger');
    now += REACTION_GAP_MS + 10; assert.equal(gate.offer('anger', 'h'), null, 'anger is rare');
    assert.equal(gate.offer('nope', 'i'), null);
});

test('reactions: stickers sit around the head inside the canvas; none for an external avatar', () => {
    const talk = { left: 408, top: 24, width: 792, height: 1056 }, gameBox = { left: 1438, top: 24, width: 448, height: 597 };
    for (const asset of Object.keys(ROOM_REACTIONS)) for (const [box, mode] of [[talk, 'noa'], [talk, 'vrm'], [gameBox, 'noa'], [gameBox, 'vrm']]) {
        const r = reactionBox(asset, box, mode);
        assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.size <= 1920 && r.top + r.size <= 1080, `${asset} ${mode}`);
        assert.ok(r.size > 20 && r.size < 1000);
    }
    const sweat = reactionBox('sweat', talk, 'noa'), head = { x: 408 + .585 * 792, y: 24 + .34 * 1056 };
    assert.ok(sweat.left + sweat.size / 2 > head.x, 'beside the head, to the side');
    assert.equal(reactionBox('sweat', talk, 'external'), null);
});

// ROOM_GAME_LAYOUT=front (operator 2026-10-19, design 案A): Noa stands in front of the game's lower-right corner.
test('front layout: setting and state; boxes keep clear of each other except Noa in front of the game', t => {
    assert.equal(config({}, [], false).roomGameLayout, 'side');
    assert.equal(config({ ROOM_GAME_LAYOUT: 'front' }, [], false).roomGameLayout, 'front');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { ROOM_GAME_LAYOUT: 'front' } }).values.ROOM_GAME_LAYOUT, 'front');
    assert.equal(c.roomGameLayout, 'front');
    assert.throws(() => saveSettings(c, { values: { ROOM_GAME_LAYOUT: 'left' } }), /ゲーム画面の配置/);
    assert.equal(engine(setup(t, { STAGE_THEME: 'room', ROOM_GAME_LAYOUT: 'front' })).status().roomGameLayout, 'front');
    assert.equal(Object.hasOwn(engine(setup(t, { ROOM_GAME_LAYOUT: 'front' })).status(), 'roomGameLayout'), false, 'classic: nothing');
    assert.equal(Object.hasOwn(engine(setup(t, { STAGE_THEME: 'room' })).status(), 'roomGameLayout'), false, 'side: nothing');
    const B = ROOM_BOXES.front, inside = ([a, b, w, h]) => a >= 0 && b >= 0 && a + w <= 1920 && b + h <= 1080;
    const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    const keys = Object.keys(B);
    for (const k of keys) if (k !== 'avatar') assert.ok(inside(B[k]), k);
    for (const [i, a] of keys.entries()) for (const b of keys.slice(i + 1))
        assert.equal(overlaps(B[a], B[b]), [a, b].sort().join() === 'avatar,game', `${a}/${b}`);
    assert.ok(overlaps(B.avatar, B.game), 'Noa is in front of the game');
    // the game window is 16:9
    assert.equal(Math.round(B.game[2] * 9 / 16), B.game[3]);
});

test('obs front: the capture fills the bigger window, the game goes under the stage, chat takes the column', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', stageTheme: 'room', roomGameLayout: 'front' });
    assert.equal(o.gameStageSettings('http://h').url, 'http://h/stage#token=v&layout=game&actions=external&theme=room&chat=1&gamelayout=front');
    const [x, y, w, h] = ROOM_BOXES.front.game;
    assert.deepEqual(ROOM_FRONT_GAME_CAPTURE, { positionX: x, positionY: y, boundsWidth: w, boundsHeight: h });
    assert.deepEqual(o.gameCaptureTransform(game.capture), { positionX: x, positionY: y, cropTop: 56, cropBottom: 0, cropLeft: 0, cropRight: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: w, boundsHeight: h, boundsAlignment: 0 });
    const box = spot => [spot.transform.positionX, spot.transform.positionY, spot.size.width, spot.size.height];
    assert.deepEqual(box(ROOM_FRONT_OVERLAY_GAME_CHAT), ROOM_BOXES.front.chat);
    // the command strip stays inside the game window, clear of Noa and the other boxes
    const [ax, ay, aw, ah] = box(ROOM_OVERLAY_GAME_ACTIONS);
    assert.ok(ax >= x && ay >= y && ax + aw <= x + w && ay + ah <= y + h);
    const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    for (const k of ['avatar', 'goal', 'chat', 'selected', 'subtitle', 'pr']) assert.ok(!overlaps([ax, ay, aw, ah], ROOM_BOXES.front[k]), k);
    const { obs, calls } = fakeObs({ stageTheme: 'room', roomGameLayout: 'front' });
    await obs.placeOverlays(false);
    assert.deepEqual(calls.filter(x => x.type.startsWith('Set')).map(x => [x.type, x.data.inputSettings ?? x.data.sceneItemTransform ?? x.data.sceneItemEnabled]),
        [['SetInputSettings', { width: 384, height: 500 }], ['SetSceneItemTransform', ROOM_FRONT_OVERLAY_GAME_CHAT.transform], ['SetSceneItemTransform', ROOM_OVERLAY_GAME_ACTIONS.transform], ['SetSceneItemEnabled', true]]);
    calls.length = 0;
    await obs.placeOverlays(true);
    assert.deepEqual(calls.find(x => x.type === 'SetSceneItemTransform').data.sceneItemTransform, ROOM_OVERLAY_TALK_CHAT.transform, 'the opening talk keeps the room talk spot');
});

test('obs front: prepareGame puts the game window at the bottom (the side layout keeps the stage there)', async () => {
    const run = async extra => {
        const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', stageTheme: 'room', ...extra }), calls = [];
        o.ready = true;
        const items = [{ sourceName: 'Jev Stage (Vampire Survivors)', sceneItemId: 1, sceneItemEnabled: true }, { sourceName: 'Vampire Survivors Window', sceneItemId: 2, sceneItemEnabled: true }];
        o.call = async (type, data) => { calls.push({ type, data }); return type === 'GetSceneItemList' ? { sceneItems: items } : type === 'GetSceneList' ? { scenes: [{ sceneName: 'Jev Studio - Vampire Survivors' }] }
            : type === 'GetInputList' ? { inputs: [{ inputName: 'Jev Stage (Vampire Survivors)', inputKind: 'browser_source' }, { inputName: 'Vampire Survivors Window', inputKind: 'screen_capture' }] } : {}; };
        o.refreshGameWindow = async () => null; o.muteGlobalAudio = async () => [];
        await o.prepareGame('http://h');
        return calls.filter(x => x.type === 'SetSceneItemIndex').map(x => [x.data.sceneItemId, x.data.sceneItemIndex]);
    };
    assert.deepEqual(await run({ roomGameLayout: 'front' }), [[2, 0]], 'front: the game window under the stage');
    assert.deepEqual(await run({}), [[1, 0]], 'side: the stage under the game window');
});

test('front page: the stage is transparent over the game window and its rules are scoped', () => {
    const html = readFileSync(new URL('public/stage.html', root), 'utf8'), css = readFileSync(new URL('public/stage.css', root), 'utf8');
    assert.match(html, /class="rf rf-front"/);
    const [x, y, w, h] = ROOM_BOXES.front.game;
    assert.ok(css.includes(`clip-path:path(evenodd,"M0 0H1920V1080H0Z M${x} ${y}H${x + w}V${y + h}H${x}Z")`), 'the hole is the game window');
    assert.ok(css.includes(`body.room-game.room-front #canvas #vs-frame{left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:transparent}`));
    const [ax, ay, aw] = ROOM_BOXES.front.avatar;
    assert.ok(css.includes(`body.room-game.room-front #canvas #avatar{left:${ax}px;top:${ay}px;width:${aw}px;z-index:4}`));
    const [cx, cy, cw, ch] = ROOM_BOXES.front.subtitle;
    assert.ok(css.includes(`body.room-game.room-front #canvas #caption-box{left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px}`));
    const [gx, gy, gw, gh] = ROOM_BOXES.front.goal;
    assert.ok(css.includes(`body.room-game.room-front #room-topic-text{left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px}`));
    const [px, py] = ROOM_BOXES.front.pr;
    assert.ok(css.includes(`body.room-game.room-front #canvas #sponsor-card{left:${px}px;top:${py}px;transform:scale(.8)}`), 'the 480-wide card at 384');
    const [sx, sy, sw, sh] = ROOM_BOXES.front.selected;
    assert.ok(css.includes(`#canvas #picked{left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px}`));
});

// ROOM_GAME_LAYOUT=full (operator 2026-10-19, design 案C): the game fills the screen.
test('full layout: setting and state; the overlays keep off the HUD strip and the centre, and clear of each other', t => {
    assert.equal(config({ ROOM_GAME_LAYOUT: 'full' }, [], false).roomGameLayout, 'full');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { ROOM_GAME_LAYOUT: 'full' } }).values.ROOM_GAME_LAYOUT, 'full');
    assert.equal(engine(setup(t, { STAGE_THEME: 'room', ROOM_GAME_LAYOUT: 'full' })).status().roomGameLayout, 'full');
    const B = ROOM_BOXES.full, overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    assert.deepEqual(B.game, [0, 0, 1920, 1080]);
    const hud = [0, 0, 1920, 130], player = [780, 380, 360, 320]; // Vampire's own HUD strip (games/vampire-survivors stage.hud); the player stays at the centre
    const parts = Object.keys(B).filter(k => k !== 'game'), together = new Set(['selected,subtitle', 'bar,goal']);
    for (const k of parts) { assert.ok(!overlaps(B[k], hud), `${k} vs HUD`); assert.ok(!overlaps(B[k], player), `${k} vs player`); }
    for (const [i, a] of parts.entries()) for (const b of parts.slice(i + 1))
        assert.equal(overlaps(B[a], B[b]), together.has([a, b].sort().join()), `${a}/${b}`);
    for (const k of parts) if (k !== 'avatar') assert.ok(B[k][0] >= 0 && B[k][1] >= 0 && B[k][0] + B[k][2] <= 1920 && B[k][1] + B[k][3] <= 1080, k);
});

test('obs full: the capture fills the canvas under the stage; chat up the left edge with fading rows; commands above the bar', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', stageTheme: 'room', roomGameLayout: 'full' });
    assert.equal(o.gameStageSettings('http://h').url, 'http://h/stage#token=v&layout=game&actions=external&theme=room&chat=1&gamelayout=full');
    assert.deepEqual(ROOM_FULL_GAME_CAPTURE, { positionX: 0, positionY: 0, boundsWidth: 1920, boundsHeight: 1080 });
    assert.deepEqual(o.gameCaptureTransform(game.capture), { positionX: 0, positionY: 0, cropTop: 56, cropBottom: 0, cropLeft: 0, cropRight: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080, boundsAlignment: 0 });
    const box = spot => [spot.transform.positionX, spot.transform.positionY, spot.size.width, spot.size.height];
    assert.deepEqual(box(ROOM_FULL_OVERLAY_GAME_CHAT), ROOM_BOXES.full.chat);
    const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    for (const k of Object.keys(ROOM_BOXES.full).filter(k => k !== 'game')) assert.ok(!overlaps(box(ROOM_FULL_OVERLAY_GAME_ACTIONS), ROOM_BOXES.full[k]), `commands vs ${k}`);
    const { obs, calls } = fakeObs({ stageTheme: 'room', roomGameLayout: 'full' });
    await obs.placeOverlays(false);
    assert.deepEqual(calls.filter(x => x.type.startsWith('Set')).map(x => [x.type, x.data.inputSettings ?? x.data.sceneItemTransform ?? x.data.sceneItemEnabled]),
        [['SetInputSettings', { width: 496, height: 390 }], ['SetSceneItemTransform', ROOM_FULL_OVERLAY_GAME_CHAT.transform], ['SetInputSettings', { width: 700, height: 32 }], ['SetSceneItemTransform', ROOM_FULL_OVERLAY_GAME_ACTIONS.transform], ['SetSceneItemEnabled', true]]);
    calls.length = 0;
    await obs.ensureOverlays('http://o', 'S');
    assert.deepEqual(calls.filter(x => x.type === 'SetInputSettings').map(x => [x.data.inputSettings.url, x.data.inputSettings.width, x.data.inputSettings.height]),
        [['http://o/overlay-chat.html#token=v&theme=room&fade=1', 496, 390], ['http://o/overlay-actions.html#token=v&theme=room', 700, 32]]);
});

test('full page: transparent over the whole game, a speech bubble, scoped rules', () => {
    const html = readFileSync(new URL('public/stage.html', root), 'utf8'), css = readFileSync(new URL('public/stage.css', root), 'utf8');
    assert.match(html, /class="rf rf-full"/);
    assert.ok(css.includes('body.room-game.room-full #canvas{background:transparent}'));
    const at = (sel, [x, y, w, h]) => assert.ok(css.includes(`${sel}{left:${x}px;top:${y}px;width:${w}px;height:${h}px`), sel);
    at('body.room-game.room-full #canvas #caption-box', ROOM_BOXES.full.subtitle);
    at('body.room-game.room-full #canvas #picked', ROOM_BOXES.full.selected);
    at('body.room-game.room-full #room-topic-text', ROOM_BOXES.full.goal);
    const [ax, ay, aw] = ROOM_BOXES.full.avatar;
    assert.ok(css.includes(`body.room-game.room-full #canvas #avatar{left:${ax}px;top:${ay}px;width:${aw}px;z-index:4`));
    const [px, py] = ROOM_BOXES.full.pr;
    assert.ok(css.includes(`body.room-game.room-full #canvas #sponsor-card{left:${px}px;top:${py}px;transform:scale(.66667)}`), 'the 480-wide card at 320');
    const over = readFileSync(new URL('public/overlay.css', root), 'utf8');
    assert.match(over, /body\.theme-room\.fade \.m:nth-last-child/);
});

// ROOM_GAME_LAYOUT=frame (operator 2026-10-19, design 案D after a reference screen).
test('frame layout: setting, banner texts and state; boxes clear of each other except what sits in the game window', t => {
    assert.equal(config({ ROOM_GAME_LAYOUT: 'frame' }, [], false).roomGameLayout, 'frame');
    assert.equal(config({ STAGE_SOCIAL: ' @a<b>c ' }, [], false).stageSocial, '@abc');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { ROOM_GAME_LAYOUT: 'frame', STAGE_SOCIAL: '@hoshiAI_noa', STAGE_HASHTAG: '#ノア' } }).values.STAGE_SOCIAL, '@hoshiAI_noa');
    assert.throws(() => saveSettings(c, { values: { STAGE_TAGLINE: 'あ'.repeat(41) } }), /40文字/);
    const st = engine(setup(t, { STAGE_THEME: 'room', ROOM_GAME_LAYOUT: 'frame', STAGE_SOCIAL: '@n', STAGE_TAGLINE: 'ことば' })).status();
    assert.equal(st.roomGameLayout, 'frame'); assert.deepEqual(st.banner, { hashtag: '', social: '@n', tagline: 'ことば' });
    assert.equal(Object.hasOwn(engine(setup(t, { STAGE_THEME: 'room', ROOM_GAME_LAYOUT: 'full' })).status(), 'banner'), false, 'only the frame layout');
    // Noa's figure, not her mostly transparent 3:4 canvas (public/models/noa/model.json: the figure spans x 245-1137,
    // from y 72, of the 1200-wide canvas).
    const [ax, ay, aw] = ROOM_BOXES.frame.avatar, s = aw / 1200;
    const B = { ...ROOM_BOXES.frame, avatar: [ax + 245 * s, ay + 72 * s, (1137 - 245) * s, 1080 - (ay + 72 * s)] };
    const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    assert.equal(Math.round(B.game[2] * 9 / 16), B.game[3], 'the game window is 16:9');
    const inGame = new Set(['nowPlaying', 'subtitle', 'selected', 'avatar']), together = new Set(['selected,subtitle', 'avatar,banner', 'avatar,pr']); // Noa stands in front of the banner's right end; the estimate of her figure reaches the ad's last pixels (the 2026-10-19 render shows her head clear of it)
    const keys = Object.keys(B);
    for (const [i, a] of keys.entries()) for (const b of keys.slice(i + 1)) {
        const pair = [a, b].sort().join(), inside = (a === 'game' && inGame.has(b)) || (b === 'game' && inGame.has(a));
        if (inside) assert.ok(overlaps(B[a], B[b]), `${pair}: inside the game window`);
        else if (!together.has(pair)) assert.ok(!overlaps(B[a], B[b]), pair); // allowed neighbours may touch, need not
    }
    const hud = [8, 8, 1680, 115]; // Vampire's own HUD strip at the game window's top
    for (const k of ['nowPlaying', 'subtitle', 'selected', 'avatar']) assert.ok(!overlaps(B[k], hud), `${k} vs HUD`);
});

test('obs frame: capture in the frame window under the stage; chat in the LIVE CHAT panel as cards; commands along the bottom edge', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', stageTheme: 'room', roomGameLayout: 'frame' });
    assert.equal(o.gameStageSettings('http://h').url, 'http://h/stage#token=v&layout=game&actions=external&theme=room&chat=1&gamelayout=frame');
    const [x, y, w, h] = ROOM_BOXES.frame.game;
    assert.deepEqual(ROOM_FRAME_GAME_CAPTURE, { positionX: x, positionY: y, boundsWidth: w, boundsHeight: h });
    const box = spot => [spot.transform.positionX, spot.transform.positionY, spot.size.width, spot.size.height];
    assert.deepEqual(box(ROOM_FRAME_OVERLAY_GAME_CHAT), ROOM_BOXES.frame.chat);
    const [ax, ay, aw, ah] = box(ROOM_FRAME_OVERLAY_GAME_ACTIONS), overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    assert.ok(ax >= x && ay >= y && ax + aw <= x + w && ay + ah <= y + h, 'inside the game window');
    for (const k of Object.keys(ROOM_BOXES.frame).filter(k => k !== 'game')) assert.ok(!overlaps([ax, ay, aw, ah], ROOM_BOXES.frame[k]), `commands vs ${k}`);
    const { obs, calls } = fakeObs({ stageTheme: 'room', roomGameLayout: 'frame' });
    await obs.ensureOverlays('http://o', 'S');
    assert.deepEqual(calls.filter(x => x.type === 'SetInputSettings').map(x => [x.data.inputSettings.url, x.data.inputSettings.width, x.data.inputSettings.height]),
        [['http://o/overlay-chat.html#token=v&theme=room&style=card', 188, 240], ['http://o/overlay-actions.html#token=v&theme=room', 700, 24]]);
});

test('frame page: hole for the game, the column, the banner; scoped rules', () => {
    const html = readFileSync(new URL('public/stage.html', root), 'utf8'), css = readFileSync(new URL('public/stage.css', root), 'utf8');
    assert.match(html, /class="rf rf-framed"/); assert.match(html, /M24 8H1672A16 16 0 0 1 1688 24V937/, 'the sky has the game window cut out');
    for (const id of ['frame-time', 'frame-date', 'frame-title', 'frame-hashtag', 'frame-social', 'frame-tagline']) assert.match(html, new RegExp(`id="${id}"`), id);
    const at = (sel, [x, y, w, h]) => assert.ok(css.includes(`${sel}{left:${x}px;top:${y}px;width:${w}px;height:${h}px`), sel);
    at('body.room-game.room-frame #canvas #vs-frame', ROOM_BOXES.frame.game);
    at('body.room-game.room-frame #canvas #caption-box', ROOM_BOXES.frame.subtitle);
    at('body.room-game.room-frame #canvas #picked', ROOM_BOXES.frame.selected);
    const [ax, ay, aw] = ROOM_BOXES.frame.avatar;
    assert.ok(css.includes(`body.room-game.room-frame #canvas #avatar{left:${ax}px;top:${ay}px;width:${aw}px;`));
    const [px, py, pw] = ROOM_BOXES.frame.pr;
    assert.ok(css.includes(`body.room-game.room-frame #canvas #sponsor-card{left:${px}px;top:${py}px;transform:scale(${String(Number((pw / 480).toFixed(5))).replace(/^0/, '')})}`), 'the 480-wide card at the column width');
    assert.match(readFileSync(new URL('public/overlay.css', root), 'utf8'), /body\.theme-room\.card \.n/);
});

// ROOM_GAME_LAYOUT=wide (operator 2026-10-19, 没入型 案1, Smash): the game as big as it fits, nothing over the picture.
test('wide layout: setting and state; nothing but the game inside the game window; Noa\'s figure outside it', t => {
    assert.equal(config({ ROOM_GAME_LAYOUT: 'wide' }, [], false).roomGameLayout, 'wide');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { ROOM_GAME_LAYOUT: 'wide' } }).values.ROOM_GAME_LAYOUT, 'wide');
    assert.equal(engine(setup(t, { STAGE_THEME: 'room', ROOM_GAME_LAYOUT: 'wide' })).status().roomGameLayout, 'wide');
    const [ax, ay, aw] = ROOM_BOXES.wide.avatar, s = aw / 1200;
    const figure = [ax + 245 * s, ay + 72 * s, (1137 - 245) * s, aw * 4 / 3 - 72 * s]; // the canvas cuts her at its bottom
    const B = { ...ROOM_BOXES.wide, avatar: figure }, overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
    const inside = ([a, b, w, h]) => a >= 0 && b >= 0 && a + w <= 1920 && b + h <= 1080;
    assert.equal(B.game[2] * 9 / 16, B.game[3], 'the game window is 16:9');
    const keys = Object.keys(B);
    for (const [i, a] of keys.entries()) { assert.ok(inside(B[a]), a); for (const b of keys.slice(i + 1)) assert.ok(!overlaps(B[a], B[b]), [a, b].join()); }
});

test('obs wide: capture in the game window under the stage; chat under Noa as cards; commands inside the game window', async () => {
    const o = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game, viewToken: 'v', obsActionsSource: 'Commands', obsChatSource: 'Chat', stageTheme: 'room', roomGameLayout: 'wide' });
    assert.equal(o.gameStageSettings('http://h').url, 'http://h/stage#token=v&layout=game&actions=external&theme=room&chat=1&gamelayout=wide');
    const [x, y, w, h] = ROOM_BOXES.wide.game;
    assert.deepEqual(ROOM_WIDE_GAME_CAPTURE, { positionX: x, positionY: y, boundsWidth: w, boundsHeight: h });
    assert.deepEqual(o.gameCaptureTransform({ cropTopPx: 0 }).boundsWidth, w);
    const box = spot => [spot.transform.positionX, spot.transform.positionY, spot.size.width, spot.size.height];
    assert.deepEqual(box(ROOM_WIDE_OVERLAY_GAME_CHAT), ROOM_BOXES.wide.chat);
    const [cx, cy, cw, ch] = box(ROOM_WIDE_OVERLAY_GAME_ACTIONS);
    assert.ok(cx >= x && cy >= y && cx + cw <= x + w && cy + ch <= y + h, 'commands inside the game window');
    const { obs, calls } = fakeObs({ stageTheme: 'room', roomGameLayout: 'wide' });
    await obs.ensureOverlays('http://o', 'S');
    assert.deepEqual(calls.filter(x => x.type === 'SetInputSettings').map(x => [x.data.inputSettings.url, x.data.inputSettings.width, x.data.inputSettings.height]),
        [['http://o/overlay-chat.html#token=v&theme=room&style=card', 292, 200], ['http://o/overlay-actions.html#token=v&theme=room', 700, 32]]);
});

test('wide page: a hole for the game in the dimmed room, the column and the strip; scoped rules', () => {
    const html = readFileSync(new URL('public/stage.html', root), 'utf8'), css = readFileSync(new URL('public/stage.css', root), 'utf8');
    assert.match(html, /class="rf rf-wide"/);
    const [x, y, w, h] = ROOM_BOXES.wide.game;
    assert.ok(css.includes(`M0 0H1920V1080H0Z M${x} ${y}H${x + w}V${y + h}H${x}Z`), 'the room picture has the game window cut out');
    const at = (sel, [l, t, bw, bh]) => assert.ok(css.includes(`${sel}{left:${l}px;top:${t}px;width:${bw}px;height:${bh}px`), sel);
    at('body.room-game.room-wide #canvas #vs-frame', ROOM_BOXES.wide.game);
    at('body.room-game.room-wide #canvas #caption-box', ROOM_BOXES.wide.subtitle);
    at('body.room-game.room-wide #room-topic-text', ROOM_BOXES.wide.goal);
    at('body.room-game.room-wide .room-idle,body.room-game.room-wide #canvas #picked', ROOM_BOXES.wide.selected);
    const [ax, ay, aw] = ROOM_BOXES.wide.avatar;
    assert.ok(css.includes(`body.room-game.room-wide #canvas #avatar{left:${ax}px;top:${ay}px;width:${aw}px;`));
    const [px, py, pw] = ROOM_BOXES.wide.pr;
    assert.ok(css.includes(`body.room-game.room-wide #canvas #sponsor-card{left:${px}px;top:${py}px;transform:scale(${String(Number((pw / 480).toFixed(5))).replace(/^0/, '')})}`), 'the 480-wide card at the column width');
});
