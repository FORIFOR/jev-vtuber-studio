import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameRunner } from '../src/game-runner.mjs';
import { setup } from './helpers.mjs';

const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kills = []; c.kill = sig => c.kills.push(sig); return c; };

test('game runner: only for the Vampire Survivors programme with a runs folder; limits follow the session', t => {
    assert.equal(new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-blocks', VAMPIRE_RUNS_DIR: '/x/jvs/runs' })).enabled, false);
    assert.equal(new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' })).enabled, false, 'no runs folder: nothing to start');
    const r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs', SESSION_MINUTES: '30', VAMPIRE_GAME_AUDIO: 'true' }), { now: () => Date.UTC(2026, 8, 29, 12, 0, 0) });
    assert.equal(r.enabled, true); assert.equal(r.repo, '/x/jvs');
    assert.deepEqual(r.limits(), { seconds: 1770, cost: 1.03, calls: 9810 });
    assert.deepEqual(r.args(), ['-u', 'tools/auto_session.py', '--session', 'live-20260929T120000', '--seconds', '1770', '--max-calls', '9810', '--max-cost', '1.03', '--levelup-pause', '5', '--max-runs', '0', '--run-game-seconds', '86400', '--stage-advance', 'runs', '--audio']);
    const capped = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs', VAMPIRE_MAX_COST_USD: '.5' }));
    assert.equal(capped.limits().cost, .5, 'an explicit cost cap wins');
});

test('game runner: starts once, reports progress from the player\'s own lines, stops like Ctrl+C', t => {
    const spawned = [], events = [], child = fakeChild();
    const r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }), {
        spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; }, emit: (type, data) => events.push([type, data.state, data.detail]) });
    assert.equal(r.start(), true); assert.equal(r.start(), false, 'one player at a time');
    assert.equal(spawned.length, 1); assert.equal(spawned[0].opts.cwd, '/x/jvs'); assert.equal(spawned[0].opts.detached, true);
    assert.ok(!('TYPESAFE_API_KEY' in spawned[0].opts.env) && !('ADMIN_TOKEN' in spawned[0].opts.env), 'no Studio secrets (or empty keys) reach the player');
    assert.equal(spawned[0].opts.env.PATH, process.env.PATH);
    child.stdout.emit('data', 'Bridge is up.\nsetup: press_start\nrun: -m vampire_agent --env /secret/.env play --session x-r1\n');
    assert.deepEqual(r.status().state, 'playing'); assert.equal(r.status().detail, 'プレイ中（1回目）');
    child.stdout.emit('data', 'run 1 ended (gameover); restarting the game for the next run\nrun: -m vampire_agent ');
    child.stdout.emit('data', '--session x-r2\n');
    assert.equal(r.status().detail, 'プレイ中（2回目）', 'a line split across chunks is read whole');
    assert.ok(!JSON.stringify(events).includes('/secret'), 'raw output (paths, keys) never reaches the Studio');
    const killed = []; const orig = process.kill; process.kill = (pid, sig) => { killed.push([pid, sig]); }; t.after(() => { process.kill = orig; });
    assert.equal(r.stop(), true); assert.deepEqual(killed, [[-4242, 'SIGINT']], 'the whole player group gets Ctrl+C');
    child.emit('exit', 130);
    assert.equal(r.status().state, 'stopped'); assert.equal(r.stop(), false);
});

test('game runner: a player that cannot start or fails is reported, not retried', t => {
    const child = fakeChild(), r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }), { spawnFn: () => child });
    r.start(); child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
    assert.equal(r.status().state, 'failed'); assert.match(r.status().detail, /ENOENT/);
    const c2 = fakeChild(), r2 = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }), { spawnFn: () => c2 });
    r2.start(); c2.stderr.emit('data', 'auto_session failed: Setup did not reach the stage START\n'); c2.emit('exit', 1);
    assert.equal(r2.status().state, 'failed');
});

test('with an opening talk the game waits: started (for the time left) only when the operator announces it; OBS shows it once the controller plays', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }); c.port = 0;
    const starts = [], visible = [], overlays = []; let stops = 0;
    const gameRunner = { enabled: true, start: ms => { starts.push(ms); return true; }, stop() { stops++; }, status: () => ({ enabled: true, state: 'idle', limits: { minutes: 1, maxCostUsd: .1 } }) };
    const obs = { ready: true, owned: false, close() {}, async call() { return {}; }, async prepare() { return {}; }, async stopOwned() {}, async setGameVisible(v) { visible.push(v); return true; }, async refreshGameWindow() { return null; }, async placeOverlays(talk) { overlays.push(talk); } };
    const app = createApp(c, { gameRunner, obs, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(async () => { app.engine.stop('test'); await app.close(); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await req('/api/obs/prepare', {})).status, 200);
    assert.deepEqual(visible, [false], 'preparing the stopped lobby hides the capture');
    assert.equal((await req('/api/control', { action: 'start' })).status, 200);
    assert.equal(app.engine.blocks.phase, 'lobby'); assert.deepEqual(starts, [], 'no game during the opening talk'); assert.deepEqual(visible, [false, false]);
    app.engine.blocks.cfg.leadInMaxMs = 300; // the lead-in is not spoken in this fixture: open the game screen soon
    assert.equal((await req('/api/control', { action: 'start-game' })).status, 200);
    assert.deepEqual(starts, [], 'the lead-in first: the game is not started with the button press');
    for (let i = 0; i < 40 && !starts.length; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(starts.length, 1); assert.ok(starts[0] > 0 && starts[0] <= c.sessionMs, 'the game gets the show time that is left');
    assert.ok(visible.every(v => v === false), 'hidden while the controller sets the game up');
    app.engine.event('game_runner', { enabled: true, state: 'playing' });
    for (let i = 0; i < 20 && visible.at(-1) !== true; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(visible.at(-1), true, 'the game is shown once its controller plays'); assert.ok(visible.slice(0, -1).every(v => v === false), 'and hidden until then');
    assert.equal((await req('/api/control', { action: 'start-game' })).status, 409, 'only once, only from the talk');
    // The goodbye (operator 2026-10-11): the player stops and Noa ends the game on the game screen; once that first line
    // has aired the game leaves the screen and the overlays move beside Noa (the talk layout).
    app.engine.event(app.engine.blocks.statusKey, { phase: 'playing' }); overlays.length = 0; const shown = visible.length;
    app.engine.event('farewell', { reason: 'time', lines: 9, ms: 180000 });
    app.engine.event('state', { running: true, farewell: { reason: 'time', step: 0, lines: 9 } });
    assert.equal(stops, 1); assert.equal(visible.length, shown, 'the game stays on screen for the first line'); assert.deepEqual(overlays, []);
    app.engine.event('state', { running: true, farewell: { reason: 'time', step: 1, lines: 9 } });
    assert.equal(visible.at(-1), false); assert.deepEqual(overlays, [true]);
    app.engine.event(app.engine.blocks.statusKey, { phase: 'between' });
    assert.deepEqual(overlays, [true], 'a later game phase does not bring the game layout back during the goodbye');
    app.engine.event('farewell', { reason: 'time', lines: 9, ms: 180000 }); assert.equal(stops, 1, 'once');
    await req('/api/control', { action: 'stop' });
});

test('review handshake isolates sessions and rejects stale runs, paths and arbitrary tactics', async t => {
    const { readFileSync, existsSync } = await import('node:fs');
    const child = fakeChild(), r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }), { spawnFn: () => child });
    r.start();
    const runId = `vampire-${r.session}-r1`;
    assert.equal(r.completeReview({ runId: 'vampire-old-r1', tactic: 'health_priority' }), false);
    assert.equal(r.completeReview({ runId: runId + '/../bad', tactic: 'health_priority' }), false);
    assert.equal(r.completeReview({ runId, tactic: 'arbitrary command' }), false);
    assert.equal(existsSync(`${r.reviewDir}/${runId}.json`), false);
    assert.equal(r.completeReview({ runId, tactic: 'health_priority' }), true);
    assert.equal(JSON.parse(readFileSync(`${r.reviewDir}/${runId}.json`)).playbackCompleted, true);
    assert.equal(r.completeReview({ runId, tactic: 'escape_space', skipped: true }), true);
    assert.deepEqual(JSON.parse(readFileSync(`${r.reviewDir}/${runId}.json`)), { runId, tactic: 'escape_space', playbackCompleted: true, reviewSkipped: true });
    // A retried start (…-r1-a2) is answered under its own name; anything else after the run number is not.
    assert.equal(r.completeReview({ runId: `${runId}-a2`, tactic: 'health_priority' }), true);
    assert.equal(existsSync(`${r.reviewDir}/${runId}-a2.json`), true);
    assert.equal(r.completeReview({ runId: `${runId}-b2`, tactic: 'health_priority' }), false);
    child.emit('exit', 0);
    assert.equal(r.completeReview({ runId, tactic: 'health_priority' }), false);
});

test('game runner: switchPlayer toggles between AI and human (observe/resume)', async t => {
    const spawned = [];
    let currentChild = null;
    // A writable game folder: the mode file must be written (Phase 5: a failed write is an error, no longer ignored).
    const gameDir = mkdtempSync(join(tmpdir(), 'jvs-game-')); t.after(() => rmSync(gameDir, { recursive: true, force: true }));
    const r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs', GAME_DIR: gameDir }), {
        spawnFn: (cmd, args, opts) => {
            const child = fakeChild();
            spawned.push({ cmd, args, opts, child });
            currentChild = child;
            return child;
        }
    });

    // Start with default AI mode
    assert.equal(r.player, 'ai');
    assert.equal(r.start(), true);
    assert.equal(spawned.length, 1);
    assert.ok(!spawned[0].args.includes('--observe'));

    // Switch to human player seamlessly (no process kill or respawn)
    const resHuman = await r.switchPlayer('human');
    assert.equal(resHuman.ok, true);
    assert.equal(r.player, 'human');
    assert.equal(spawned.length, 1, 'switching player must NOT kill or respawn the game process');
    assert.match(r.status().detail, /あなたがプレイ中/);

    // Switch back to AI mode seamlessly
    const resAI = await r.switchPlayer('ai');
    assert.equal(resAI.ok, true);
    assert.equal(r.player, 'ai');
    assert.equal(spawned.length, 1, 'switching back to AI must NOT kill or respawn the game process');
    assert.match(r.status().detail, /AI（ノア）がプレイ中/);
});

test('server API: /api/game/player and /api/control switch-player route', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }); c.port = 0;
    const switched = [];
    const gameRunner = {
        enabled: true,
        player: 'ai',
        status: () => ({ enabled: true, player: gameRunner.player, state: 'playing' }),
        switchPlayer: async p => { switched.push(p); gameRunner.player = p; return { ok: true, player: p }; }
    };
    const obs = { ready: true, owned: false, close() {}, async call() { return {}; }, async prepare() { return {}; }, async stopOwned() {} };
    const app = createApp(c, { gameRunner, obs, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(async () => { app.engine.stop('test'); await app.close(); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = (path, data) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    // Test /api/game/player endpoint
    const r1 = await req('/api/game/player', { player: 'human' });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.ok, true);
    assert.equal(d1.player, 'human');
    assert.deepEqual(switched, ['human']);

    // Test /api/control with action switch-player
    const r2 = await req('/api/control', { action: 'switch-player', player: 'ai' });
    assert.equal(r2.status, 200);
    assert.deepEqual(switched, ['human', 'ai']);
});

test('game runner: offline plays at 2x speed, streaming plays at 1x speed', t => {
    const r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }));
    // When stream is not active (offline/stopped), default speed is 2.0x
    assert.equal(r.status().streaming, false);
    assert.equal(r.status().speed, 2.0);

    // When stream starts, speed switches to 1.0x
    r.setStreaming(true);
    assert.equal(r.status().streaming, true);
    assert.equal(r.status().speed, 1.0);

    // When stream stops, speed returns to 2.0x
    r.setStreaming(false);
    assert.equal(r.status().streaming, false);
    assert.equal(r.status().speed, 2.0);
});

test('game runner: the character and stage come from the settings; the manifest passes only its non-secret switches', t => {
    const spawned = [];
    const r = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs', SESSION_MINUTES: '30', GAME_CHARACTER: 'IMELDA', GAME_STAGE: 'FOREST' }),
        { now: () => Date.UTC(2026, 8, 29, 12, 0, 0), spawnFn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return fakeChild(); } });
    const args = r.args();
    assert.deepEqual(args.slice(args.indexOf('--character'), args.indexOf('--character') + 4), ['--character', 'IMELDA', '--stage', 'FOREST']);
    assert.equal(r.start(), true);
    assert.equal(spawned[0].opts.env.NOA_LOCAL_CHOOSER, '1', 'the manifest switch reaches the player');
    const bad = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs', GAME_CHARACTER: 'imelda; rm -rf /' }));
    assert.ok(!bad.args().includes('--character'), 'an invalid id is ignored, never passed through');
    const keyed = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: '/x/jvs/runs' }), { spawnFn: (cmd, args, opts) => { spawned.push({ opts }); return fakeChild(); } });
    keyed.c.game = { ...keyed.c.game, controller: { ...keyed.c.game.controller, env: { NOA_LOCAL_CHOOSER: '1', TYPESAFE_API_KEY: 'x', SOME_TOKEN: 'y' } } };
    keyed.start();
    const env = spawned.at(-1).opts.env;
    assert.ok(!('TYPESAFE_API_KEY' in env) && !('SOME_TOKEN' in env), 'a key-like name in the manifest is never passed');
});
