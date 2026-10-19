import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGame, listGames, loadShowModule } from '../src/games.mjs';
import { OBS } from '../src/obs.mjs';
import { SwitchSetup, SWITCH_NAMES } from '../src/switch-setup.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { saveSettings, publicSettings, SettingsValidationError } from '../src/settings.mjs';
import { createApp } from '../src/server.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';
import { sentences } from '../src/director.mjs';

// スマブラSP: a game a person plays on the Switch, captured from the Switch page's inputs, commented by Noa on the
// operator's reports. Nothing here opens a device, launches a program or touches a stream.
const smash = (t, env = {}) => setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-smash', ...env });
const stopped = type => ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : null;

test('smash-ultimate manifest: a person plays, the Switch page captures, no controller is launched', () => {
    assert.ok(listGames().includes('smash-ultimate'));
    const g = loadGame('smash-ultimate');
    assert.equal(g.player, 'operator'); assert.equal(g.capture.kind, 'switch'); assert.equal(g.controller, undefined);
    assert.equal(loadGame('vampire-survivors').player, 'jev', 'a game with a controller is played by Jev unless it says otherwise');
    assert.equal(loadGame('vampire-survivors').capture.kind, 'window');
    assert.equal(typeof loadShowModule(g).createShow, 'function');
});

test('config: the Smash programme loads its game with the opening talk (operator 2026-10-11: one format for every game), and the Studio learns who plays and how it is captured', t => {
    const c = smash(t);
    assert.equal(c.game.id, 'smash-ultimate'); assert.ok(c.lobbyScenes?.length, 'the opening talk comes first, as in every game programme');
    assert.deepEqual(c.programmeOptions.find(p => p.id === 'noa-smash').game, { id: 'smash-ultimate', title: 'スマブラSP', player: 'operator', capture: 'switch' });
    assert.deepEqual(c.programmeOptions.find(p => p.id === 'noa-vampire').game, { id: 'vampire-survivors', title: 'Vampire Survivors', player: 'jev', capture: 'window' });
    assert.equal(c.programmeOptions.find(p => p.id === 'room').game, null);
});

test('Smash programme: a ten-minute opening talk, then only match-related beats, nothing that needs observations, nothing invites', async () => {
    const { readFileSync } = await import('node:fs');
    const p = JSON.parse(readFileSync(new URL('../config/programmes.json', import.meta.url))).find(x => x.id === 'noa-smash'), beats = p.cards.flatMap(c => c.beats);
    assert.equal(p.game, 'smash-ultimate'); assert.ok(p.openingLine && p.closingLine); assert.equal(p.show.lobbyMinutes, 10);
    assert.ok(beats.length >= 4); assert.equal(new Set(beats.map(b => b.task)).size, beats.length); assert.ok(!beats.some(b => b.lobby === true), 'the opening talk comes from the shared lobby scenes, not from match beats');
    assert.ok(!beats.some(b => b.game === true), 'no observation feed: game beats would only be quiet');
    for (const b of beats) { assert.ok(sentences(b.demo).length <= 2); assert.ok(b.demo.length <= 180); assert.ok(b.id && b.label && b.task); assert.ok(!b.invite); }
});

test('OBS prepare for a Switch game: its own scene, the stage in the game layout, the Switch inputs placed in the frame, never created or muted here', async t => {
    const c = smash(t, { GAME_AUDIO: 'true' }), obs = new OBS(c), calls = [], items = [];
    const ids = { [`${c.obsInput} (スマブラSP)`]: 1, [SWITCH_NAMES.video]: 2, [SWITCH_NAMES.audio]: 3 };
    obs.call = async (type, data) => { calls.push({ type, data });
        if (['CreateInput', 'CreateSceneItem'].includes(type)) items.push({ sourceName: data.inputName || data.sourceName, sceneItemId: ids[data.inputName || data.sourceName] });
        return stopped(type) ?? (type === 'GetSceneList' ? { scenes: [{ sceneName: c.obsScene }, { sceneName: SWITCH_NAMES.scene }] }
        : type === 'GetInputList' ? { inputs: [{ inputName: SWITCH_NAMES.video, inputKind: 'macos-avcapture' }, { inputName: SWITCH_NAMES.audio, inputKind: 'coreaudio_input_capture' }] }
        : type === 'GetSceneItemList' ? { sceneItems: data.sceneName === `${c.obsScene} - スマブラSP` ? [...items] : [] }
        : type === 'GetSpecialInputs' ? { mic1: 'マイク' } : {}); };
    const r = await obs.prepare('http://127.0.0.1:8787');
    assert.equal(r.scene, `${c.obsScene} - スマブラSP`); assert.equal(r.game, SWITCH_NAMES.video); assert.equal(r.capture, 'switch'); assert.equal(r.window, null);
    assert.deepEqual(calls.find(x => x.type === 'CreateScene').data, { sceneName: r.scene });
    const created = calls.filter(x => x.type === 'CreateInput').map(x => x.data);
    assert.equal(created.length, 1); assert.equal(created[0].inputKind, 'browser_source'); assert.match(created[0].inputSettings.url, /&layout=game/);
    assert.deepEqual(calls.filter(x => x.type === 'CreateSceneItem').map(x => x.data.sourceName).sort(), [SWITCH_NAMES.audio, SWITCH_NAMES.video], 'the existing inputs become items of the game scene');
    assert.ok(!calls.some(x => x.type === 'SetInputSettings' && [SWITCH_NAMES.video, SWITCH_NAMES.audio].includes(x.data.inputName)), 'the device choice belongs to the Switch page');
    assert.ok(!calls.some(x => x.type === 'SetInputMute' && [SWITCH_NAMES.video, SWITCH_NAMES.audio].includes(x.data.inputName)), 'mute state belongs to the Switch page record');
    assert.ok(!calls.some(x => x.type === 'SetInputAudioMonitorType'));
    const tr = calls.find(x => x.type === 'SetSceneItemTransform').data;
    assert.equal(tr.sceneItemId, 2); assert.deepEqual([tr.sceneItemTransform.positionX, tr.sceneItemTransform.positionY, tr.sceneItemTransform.boundsWidth, tr.sceneItemTransform.boundsHeight, tr.sceneItemTransform.cropTop], [48, 120, 1120, 630, 0]);
    assert.deepEqual(calls.find(x => x.type === 'SetInputVolume' && x.data.inputName === SWITCH_NAMES.audio).data.inputVolumeDb, -10, 'the manifest level');
    assert.deepEqual(calls.find(x => x.type === 'SetInputMute' && x.data.inputName === 'マイク').data, { inputName: 'マイク', inputMuted: true });
    assert.ok(!calls.some(x => ['StartStream', 'SetStreamServiceSettings', 'StartRecord'].includes(x.type)));
    assert.ok(!calls.some(x => x.data?.sceneName === SWITCH_NAMES.scene && x.type !== 'GetSceneList'), 'the Switch page scene is not touched');
    assert.equal(await obs.refreshGameWindow(), null, 'a capture card has no window to re-point');
    await obs.setGameVisible(false);
    assert.deepEqual(calls.filter(x => x.type === 'SetSceneItemEnabled' && x.data.sceneItemEnabled === false).map(x => x.data.sceneItemId).sort(), [2, 3], 'the lobby hides picture and sound');
});

test('OBS prepare for a Switch game: game sound off keeps the audio input out of the scene; the Studio level overrides the manifest', async t => {
    const c = smash(t, { GAME_AUDIO_DB: '-20' }), obs = new OBS(c), calls = [];
    const inputs = [{ inputName: SWITCH_NAMES.video, inputKind: 'macos-avcapture' }, { inputName: SWITCH_NAMES.audio, inputKind: 'coreaudio_input_capture' }];
    obs.call = async (type, data) => { calls.push({ type, data }); return stopped(type) ?? (type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs } : type === 'GetSceneItemList' ? { sceneItems: [] } : {}); };
    await obs.prepare('http://127.0.0.1:8787');
    assert.deepEqual(calls.filter(x => x.type === 'CreateSceneItem').map(x => x.data.sourceName), [SWITCH_NAMES.video]);
    assert.ok(!calls.some(x => x.type === 'SetInputVolume' && x.data.inputName === SWITCH_NAMES.audio));
    c.gameAudio = true; calls.length = 0;
    await obs.prepare('http://127.0.0.1:8787');
    assert.equal(calls.find(x => x.type === 'SetInputVolume' && x.data.inputName === SWITCH_NAMES.audio).data.inputVolumeDb, -20);
});

test('OBS prepare for a Switch game refuses, in words, when the Switch page has not chosen a device', async t => {
    const c = smash(t), obs = new OBS(c);
    obs.call = async type => stopped(type) ?? (type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneList' ? { scenes: [] } : {});
    await assert.rejects(obs.prepare('http://127.0.0.1:8787'), /Switch接続/);
    c.gameAudio = true;
    obs.call = async type => stopped(type) ?? (type === 'GetInputList' ? { inputs: [{ inputName: SWITCH_NAMES.video, inputKind: 'macos-avcapture' }] } : type === 'GetSceneList' ? { scenes: [] } : {});
    await assert.rejects(obs.prepare('http://127.0.0.1:8787'), /音声機器が未設定/);
});

test('Switch page ownership: the Studio\'s game scenes may show the Switch inputs; any other scene still fails the check', async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jvs-smash-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const items = { 'Jev Studio - スマブラSP': [{ sourceName: 'Jev Stage (スマブラSP)' }, { sourceName: SWITCH_NAMES.video }], 'Other': [] };
    const obs = { async call(type, d) { if (type === 'GetSceneItemList') return { sceneItems: items[d.sceneName] || [] }; throw new Error(type); } };
    const record = { sceneName: SWITCH_NAMES.scene, sceneUuid: 's1', inputs: { video: { name: SWITCH_NAMES.video } } };
    const inv = { scenes: [{ sceneName: SWITCH_NAMES.scene, sceneUuid: 's1' }, { sceneName: 'Jev Studio - スマブラSP', sceneUuid: 's2' }, { sceneName: 'Other', sceneUuid: 's3' }] };
    await assert.rejects(new SwitchSetup({ obs, dataDir }).assertUnshared(record, inv), { code: 'SWITCH_OWNERSHIP_CHANGED' }, 'by default, no sharing');
    const sharing = new SwitchSetup({ obs, dataDir, sharedScene: n => n.startsWith('Jev Studio - ') });
    await sharing.assertUnshared(record, inv);
    items.Other.push({ sourceName: SWITCH_NAMES.audio }); record.inputs.audio = { name: SWITCH_NAMES.audio };
    await assert.rejects(sharing.assertUnshared(record, inv), { code: 'SWITCH_OWNERSHIP_CHANGED' });
});

test('TalkEngine: the operator\'s reports become gated game lines; log observations are refused; the stage learns who plays', async t => {
    const c = smash(t, { READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'いい感じ。' }, voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e);
    assert.deepEqual(e.status().gameShow, { id: 'smash-ultimate', title: 'スマブラSP', statusKey: 'smash', external: true });
    e.blocks.start();
    assert.equal(e.status().smash.player, 'operator'); assert.equal(e.status().smash.phase, 'lobby', 'the opening talk first');
    assert.equal(e.reportGame('match_start').accepted, false, 'no match report during the opening talk');
    assert.equal(e.blocks.startGame(), true); e.blocks.beginGame(); assert.equal(e.status().smash.phase, 'idle');
    e.blocks.announcements = []; // the game's start lines are not what this test is about
    assert.equal(e.reportGame('ko').accepted, false, 'a KO needs a match');
    assert.equal(e.reportGame('match_start').accepted, true); assert.equal(e.status().smash.phase, 'playing');
    assert.equal(e.ingestGame({ runId: 'log-1', state: { score: 1 } }).accepted, false, 'nothing observed is accepted: there is no controller');
    assert.equal(e.reportGame('ko').accepted, true); assert.equal(e.status().smash.kos, 1);
    const u = e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null);
    assert.equal(u.utterance, 'game_reaction'); assert.equal(u.observation.player, 'operator'); assert.equal(u.observation.game, 'スマブラSP');
    assert.match(e.blocks.promptRule('game_commentary'), /配信者/);
    assert.equal(e.reportGame('won').accepted, true); assert.equal(e.blocks.phase, 'results'); assert.equal(e.status().smash.wins, 1);
    assert.deepEqual(e.blocks.lastResult, { result: 'won', kos: 1, stocksLost: 0, match: 1 });
    // The result is spoken even though ending the match clears the round's queued reactions.
    const result = e.blocks.takeLine(); assert.equal(result.eventId, 'result-1'); assert.match(result.text, /勝/); assert.ok(sentences(result.text).length <= 2);
    assert.equal(e.reportGame('bogus').accepted, false);
    assert.match(e.blocks.answer('今日は何勝？').text, /1勝0敗/);
    assert.equal(e.reportGame('match_start').accepted, true); assert.equal(e.reportGame('lost').accepted, true);
    assert.match(e.blocks.takeLine().text, /負け|惜しかった/, 'a loss is spoken too');
});

test('every fixed Smash line is at most two sentences (the gate\'s turn bound)', async () => {
    const { createShow } = await import('../games/smash-ultimate/show.mjs');
    const s = createShow({}, {});
    for (const pool of Object.values(s.game.lines)) for (const line of pool) assert.ok(sentences(line.replace(/\{\w+\}/g, '3')).length <= 2, line);
    for (const line of [s.game.startLine, s.game.waitLine, ...s.game.leadInLines]) assert.ok(sentences(line).length <= 2, line);
});

test('settings: game sound, its level, the controller folder and the cost cap are saved from the Studio and validated', t => {
    const c = smash(t);
    assert.equal(c.gameAudio, false); assert.equal(c.gameAudioDb, null);
    const r = saveSettings(c, { values: { GAME_AUDIO: true, GAME_AUDIO_DB: '-12', GAME_MAX_COST_USD: '', OBS_BGM_VOLUME_DB: '-30' } });
    assert.equal(c.gameAudio, true); assert.equal(c.gameAudioDb, -12); assert.equal(c.gameMaxCostUsd, null); assert.equal(c.obsBgmVolumeDb, -30);
    assert.equal(r.values.GAME_AUDIO, true); assert.equal(r.values.GAME_AUDIO_DB, -12);
    const v = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }); // the controller folder matters to a Jev-played game
    saveSettings(v, { values: { GAME_DIR: '/Users/me/jev-vampire-survivors', GAME_MAX_COST_USD: '2.5' } });
    assert.equal(v.gameDir, '/Users/me/jev-vampire-survivors'); assert.equal(v.gameLogDir, '/Users/me/jev-vampire-survivors/runs'); assert.equal(v.gameMaxCostUsd, 2.5);
    assert.equal(publicSettings(v).values.GAME_DIR, '/Users/me/jev-vampire-survivors');
    assert.equal(r.programmes.find(p => p.id === 'noa-smash').game.capture, 'switch');
    saveSettings(c, { values: { GAME_AUDIO: false, GAME_AUDIO_DB: '' } }); assert.equal(c.gameAudio, false); assert.equal(c.gameAudioDb, null);
    for (const values of [{ GAME_AUDIO_DB: '5' }, { GAME_AUDIO_DB: 'loud' }, { GAME_MAX_COST_USD: '-1' }, { GAME_DIR: 'relative/path' }, { OBS_BGM_FILE: 'bgm.mp3' }, { GAME_AUDIO: 'yes' }])
        assert.throws(() => saveSettings(c, { values }), SettingsValidationError, JSON.stringify(values));
    assert.equal(publicSettings(c).values.GAME_AUDIO, false);
});

test('HTTP: the Studio\'s match report drives the Smash show; after the opening talk the picture comes on with the game, with no controller to launch', async t => {
    const c = smash(t); c.port = 0; const visible = [];
    const obs = { ready: true, owned: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible(v) { visible.push(v); }, async refreshGameWindow() { return null; } };
    const a = createApp(c, { obs }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    let closed = false; const close = async () => { if (closed) return; closed = true; a.engine.stop('test'); await a.close(); }; t.after(close);
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const req = (data) => fetch(url + '/api/control', { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await req({ action: 'start' })).status, 200); assert.equal(a.engine.running, true);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(visible.every(v => v === false), 'the opening talk hides the game picture');
    a.engine.blocks.cfg.leadInMaxMs = 300; // the lead-in is not spoken in this fixture: open the game screen soon
    assert.equal((await req({ action: 'start-game' })).status, 200);
    for (let i = 0; i < 40 && visible.at(-1) !== true; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(visible.at(-1), true, 'no controller to start: the game picture comes on with the game');
    assert.equal((await req({ action: 'start-game' })).status, 409, 'only once, only from the talk');
    assert.equal((await req({ action: 'game-report', event: 'match_start' })).status, 200);
    const s = await (await req({ action: 'game-report', event: 'ko' })).json();
    assert.equal(s.smash.phase, 'playing'); assert.equal(s.smash.kos, 1); assert.equal(s.smash.player, 'operator');
    assert.equal((await req({ action: 'game-report', event: 'nonsense' })).status, 409);
    assert.equal((await req({ action: 'game-report', event: 'lost' })).status, 200); assert.equal(a.engine.blocks.phase, 'results');
    assert.equal(a.engine.status().gameRunner?.enabled ?? false, false);
    await close(); // before the temp data dir goes away
});
