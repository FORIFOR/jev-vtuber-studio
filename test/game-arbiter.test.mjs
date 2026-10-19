import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameRunner, ACK_WAIT_MS } from '../src/game-runner.mjs';
import { VampireShow } from '../src/vampire-show.mjs';
import { RunLogFeed } from '../src/run-log-feed.mjs';
import { setup } from './helpers.mjs';

// NOA Studio Phase 5 (operator 2026-10-19, docs/GAMES.md): game control handoff. The mode file carries an epoch and is
// written whole; the controller's answer for that epoch confirms the owner (released inputs / a fresh state); without
// it the switch stands with a warning. While a person plays, the show says so (stage: AIが実況中) and the lines do not
// claim the AI plays; the controller's observe records keep the facts fresh.
function runner(t, { running = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'noa-arbiter-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const events = [];
    const r = new GameRunner({ gameDir: dir, game: { id: 'vampire-survivors', title: 'Vampire Survivors', controller: { command: 'x', logDir: 'runs' } } }, { emit: (type, data) => events.push([type, data]) });
    if (running) { r.child = { pid: 1 }; r.state = 'playing'; }
    const mode = () => JSON.parse(readFileSync(join(dir, '.local', 'noa-player-mode.json'), 'utf8'));
    // A controller that answers the current epoch after ms.
    const answer = (ms, fields = {}) => setTimeout(() => { const m = mode(); writeFileSync(join(dir, '.local', 'noa-player-ack.json'), JSON.stringify({ epoch: m.epoch, mode: m.mode, ...fields })); }, ms);
    return { dir, r, events, mode, answer };
}

test('to a person: switching until the controller answers the epoch (inputs released); the mode file is written whole', async t => {
    const { dir, r, events, mode, answer } = runner(t);
    answer(120, { released: true, phase: 'combat' });
    const run = r.switchPlayer('human');
    await new Promise(res => setTimeout(res, 20));
    assert.equal(r.switching, true); assert.equal(r.status().switching, true);
    const result = await run;
    assert.deepEqual([result.player, result.confirmed, result.warning], ['human', true, undefined]);
    assert.equal(mode().mode, 'human'); assert.equal(mode().epoch, 1);
    assert.ok(r.ack.ms >= 100 && r.ack.ms < ACK_WAIT_MS);
    assert.equal(r.status().ack.mode, 'human'); assert.equal(r.switching, false);
    assert.deepEqual(readdirSync(join(dir, '.local')).filter(f => f.endsWith('.tmp')), []);
    assert.ok(events.some(([type, d]) => type === 'game_runner' && d.switching) && events.at(-1)[1].switching === false);
});

test('no answer within 1.5 s: the switch stands with a warning; an old epoch\'s answer does not count', async t => {
    const { dir, r } = runner(t);
    mkdirSync(join(dir, '.local'), { recursive: true });
    writeFileSync(join(dir, '.local', 'noa-player-ack.json'), JSON.stringify({ epoch: 0, mode: 'human' }));
    const result = await r.switchPlayer('human');
    assert.equal(result.player, 'human'); assert.equal(result.confirmed, false);
    assert.match(result.warning, /確認できません/);
    assert.match(r.status().warning, /AIの入力を放したことを確認できません/);
});

test('back to the AI: the answer carries the phase it acts on; not running needs no answer; a failed write keeps the owner', async t => {
    const { r, answer } = runner(t);
    answer(10, { released: true }); await r.switchPlayer('human');
    answer(10, { released: false, phase: 'levelup' });
    const back = await r.switchPlayer('ai');
    assert.equal(back.confirmed, true); assert.match(r.detail, /levelupの画面の終わり待ち/);
    const idle = runner(t, { running: false });
    const quick = await idle.r.switchPlayer('human');
    assert.equal(quick.confirmed, false); assert.equal(quick.warning, undefined, 'nothing to answer when no controller runs');
    const bad = new GameRunner({ gameDir: join(idle.dir, '.local', 'noa-player-mode.json', 'not-a-dir'), game: {} });
    writeFileSync(join(idle.dir, 'file'), 'x');
    bad.c.gameDir = join(idle.dir, 'file'); // a file where the folder should be: the mode file cannot be written
    await assert.rejects(bad.switchPlayer('human'), /書けませんでした/);
    assert.equal(bad.player, 'ai');
});

test('switches run in order; the same press twice within 250 ms is one', async t => {
    const { r, answer } = runner(t, { running: false });
    const runs = ['human', 'ai', 'human'].map(p => r.switchPlayer(p));
    await Promise.all(runs);
    assert.equal(r.player, 'human'); assert.equal(r.epoch, 3);
    await Promise.all([r.switchPlayer('ai'), r.switchPlayer('ai')]);
    assert.equal(r.epoch, 4);
    void answer;
});

test('while a person plays the show says so: status player operator (AIが実況中), lines never claim the AI plays', () => {
    const s = new VampireShow({ lobbyMinutes: 0 });
    assert.match(s.promptRule('game_commentary'), /が操作しているプレイヤーとして一人称で話す/);
    assert.equal(s.status().player, undefined);
    s.setRuntimePlayer('human');
    assert.equal(s.status().player, 'operator'); assert.equal(s.status().playedBy, 'person');
    assert.match(s.promptRule('game_commentary'), /中の人（人間）がゲームを操作していて/);
    assert.doesNotMatch(s.promptRule('game_commentary'), /が操作しているプレイヤーとして一人称で話す/);
    s.setRuntimePlayer('ai');
    assert.equal(s.status().player, undefined);
});

test('the controller\'s observe records (a person playing) reach the show as observations', t => {
    const dir = mkdtempSync(join(tmpdir(), 'noa-observe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let now = Date.now(); const got = [], feed = new RunLogFeed(dir, d => got.push(d), { now: () => now });
    mkdirSync(join(dir, 'run1'));
    const path = join(dir, 'run1', 'decisions.jsonl');
    writeFileSync(path, JSON.stringify({ event: 'observe', phase: 'combat', state: { phase: 'combat', seq: 4, elapsed: 61, player: { hp: 80, max_hp: 100, level: 7 } }, applied: false }) + '\n');
    utimesSync(path, new Date(now + 10), new Date(now + 10));
    now += 50; feed.poll();
    assert.ok(got.some(d => d.state?.seq === 4), 'an observe record is an observation');
});

test('HTTP: the game switch reaches the show (stage label) through the runner event', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }); c.port = 0;
    const a = createApp(c, { obs: { close() { }, async stopOwned() { }, async setHumanMic() { } }, MeterOBS: null });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    try {
        const url = `http://127.0.0.1:${a.server.address().port}`;
        const r = await fetch(url + '/api/game/player', { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ player: 'human' }) });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).player, 'human');
        assert.equal(a.engine.blocks.status().player, 'operator');
    } finally { await a.close(); }
});
