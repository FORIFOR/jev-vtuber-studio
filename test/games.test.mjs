import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gameIdOf, loadGame, listGames, loadShowModule, controllerPaths, GAMES_DIR } from '../src/games.mjs';
import { GameRunner } from '../src/game-runner.mjs';
import { OBS } from '../src/obs.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';
import { sentences } from '../src/director.mjs';

// A made-up second game, plugged in the way docs/GAMES.md describes (from games/_template): nothing in src/ names it.
function starRacer(t) {
    const dir = mkdtempSync(join(tmpdir(), 'jvs-games-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'star-racer'));
    const m = JSON.parse(readFileSync(join(GAMES_DIR, '_template', 'game.json'), 'utf8'));
    Object.assign(m, { id: 'star-racer', title: 'Star Racer' });
    Object.assign(m.controller, { command: ['node', 'drive.mjs'], args: { seconds: '--time' }, extraArgs: ['--fast'], audioArg: null, progress: { playing: '^lap ', failed: '^crash: (.*)' } });
    Object.assign(m.capture, { appName: 'Star Racer', windowTitle: 'Star Racer', bundleId: 'com.example.StarRacer', cropTopPx: 0 });
    writeFileSync(join(dir, 'star-racer', 'game.json'), JSON.stringify(m));
    const tpl = pathToFileURL(join(GAMES_DIR, '..', 'src', 'external-game-show.mjs')).href;
    writeFileSync(join(dir, 'star-racer', 'show.mjs'), readFileSync(join(GAMES_DIR, '_template', 'show.mjs'), 'utf8')
        .replace('../../src/external-game-show.mjs', tpl).replaceAll('My Game', 'Star Racer').replaceAll("'my-game'", "'racer'").replace('my-game-records', 'racer-records'));
    return { dir, game: loadGame('star-racer', dir) };
}
const withGame = (t, game, env = {}) => Object.assign(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', ...env }), { game, gameId: game.id, gameDir: '/x/racer', gameLogDir: '/x/racer/runs' });

test('games registry: each folder under games/ is a game; programmes name one; bad manifests are refused', t => {
    assert.deepEqual(listGames(), ['smash-ultimate', 'vampire-survivors'], '_template is not a game');
    const v = loadGame('vampire-survivors');
    assert.equal(v.title, 'Vampire Survivors'); assert.equal(typeof loadShowModule(v).createShow, 'function');
    assert.equal(gameIdOf({ game: 'vampire-survivors' }), 'vampire-survivors');
    assert.equal(gameIdOf({ gameMode: 'vampire' }), 'vampire-survivors', 'older programmes still work');
    assert.equal(gameIdOf({ gameMode: 'blocks' }), null, 'NOA BLOCKS runs inside the stage');
    assert.equal(loadGame('../etc'), null); assert.equal(loadGame('nope'), null);
    const { dir } = starRacer(t);
    writeFileSync(join(dir, 'star-racer', 'game.json'), JSON.stringify({ id: 'star-racer', title: 'x' }));
    assert.throws(() => loadGame('star-racer', dir), /"show" is required/);
    assert.deepEqual(controllerPaths(v, { VAMPIRE_RUNS_DIR: '/a/jvs/runs' }), { dir: '/a/jvs', logDir: '/a/jvs/runs' });
    assert.deepEqual(controllerPaths(v, { GAME_DIR: '/b/jvs' }), { dir: '/b/jvs', logDir: join('/b/jvs', 'runs') }); // the platform's separator (Windows CI)
});

test('a new game plugs in: its controller command, progress lines and limits come from its manifest', t => {
    const { game } = starRacer(t), spawned = [];
    const c = withGame(t, game, { SESSION_MINUTES: '10' });
    const child = Object.assign(new EventEmitter(), { pid: 7, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { } });
    const r = new GameRunner(c, { spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; } });
    assert.equal(r.enabled, true);
    assert.ok(r.start());
    assert.equal(spawned[0].cmd, 'node'); assert.deepEqual(spawned[0].args, ['drive.mjs', '--time', '570', '--fast']);
    assert.equal(spawned[0].opts.cwd, '/x/racer');
    child.stdout.emit('data', 'run: something\nlap 1\n');
    assert.equal(r.status().state, 'playing'); assert.equal(r.status().runs, 1, 'only its own pattern counts');
    assert.equal(r.status().game.title, 'Star Racer');
    child.stdout.emit('data', 'crash: wheel fell off\n'); child.emit('exit', 1);
    assert.equal(r.status().state, 'failed'); assert.match(r.status().detail, /wheel fell off/);
});

test('a new game plugs in: OBS gets its own scene, window and app sound, and never another app\'s window', async t => {
    const { game } = starRacer(t), c = withGame(t, game), obs = new OBS(c), calls = [];
    c.gameAudio = true;
    obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [] }
        : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [{ itemName: 'Safari — Star Racer', itemValue: 1 }, { itemName: '[Star Racer] Star Racer', itemValue: 2 }] } : {}; };
    const r = await obs.prepare('http://127.0.0.1:8787');
    assert.equal(r.scene, `${c.obsScene} - Star Racer`); assert.equal(r.game, 'Star Racer Window'); assert.equal(r.window, '[Star Racer] Star Racer');
    assert.deepEqual(calls.find(x => x.type === 'CreateInput' && x.data.inputKind === 'sck_audio_capture').data.inputSettings, { type: 1, application: 'com.example.StarRacer' });
    assert.equal(calls.find(x => x.type === 'SetInputSettings' && x.data.inputSettings?.window !== undefined).data.inputSettings.window, 2);
    obs.call = async type => type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [{ itemName: 'Finder — [Star Racer] Star Racer notes', itemValue: 3 }] } : {};
    assert.equal(await obs.refreshGameWindow(), null, 'a look-alike title is not the game');
});

test('a new game plugs in: TalkEngine runs its show — its events become gated game lines, its rule reaches the model', async t => {
    const { game } = starRacer(t), c = withGame(t, game, { READ_COMMENTS: 'false' }), generated = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async ctx => { generated.push(ctx); return 'いい感じ。'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e);
    assert.equal(e.blocks.title, 'Star Racer');
    e.blocks.start();
    assert.deepEqual(e.status().gameShow, { id: 'star-racer', title: 'Star Racer', statusKey: 'racer', external: true });
    assert.equal(e.status().racer.phase, 'lobby');
    e.blocks.startGame(); assert.equal(e.blocks.takeLine().eventId, 'intro-game-lead'); e.blocks.beginGame();
    const start = e.blocks.takeLine(); assert.match(start.text, /Star Racer/); assert.ok(sentences(start.text).length <= 2);
    e.ingestGame({ runId: 'lap-1', state: { score: 0 } }); e.ingestGame({ runId: 'lap-1', state: { score: 3 } });
    e.blocks.announcements = [];
    const u = e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null);
    assert.equal(u.utterance, 'game_reaction'); assert.match(u.template, /3/); assert.equal(u.observation.game, 'Star Racer');
    assert.match(e.blocks.promptRule('comment_reply'), /Star Racer/);
    e.ingestGame({ runId: 'lap-1', state: { score: 4, phase: 'gameover' } });
    assert.equal(e.blocks.phase, 'results'); assert.deepEqual(e.blocks.lastResult, { score: 4 });
});

test('a game\'s rule goes into the model\'s instructions, not into the untrusted context', async t => {
    const { Conversation } = await import('../src/providers.mjs');
    const c = setup(t); c.mode = 'live'; c.llmModel = 'm'; let body;
    const v = new Conversation(c, ledger(), async (u, o) => { body = JSON.parse(o.body); return new Response(JSON.stringify({ choices: [{ message: { content: 'よし。' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
    await v.generate({ utterance: 'game_commentary', observation: { game: 'Star Racer', point: 'x' }, gameRule: '遊んでいるゲーム：「Star Racer」RULE-X' });
    assert.match(body.messages[0].content, /RULE-X/);
    assert.doesNotMatch(body.messages[1].content, /RULE-X/);
});
