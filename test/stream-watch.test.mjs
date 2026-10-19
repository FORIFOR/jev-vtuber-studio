import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamWatch, redFlags, parseVerdict, agentCommand } from '../src/stream-watch.mjs';

const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-watch-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
// A fake agent process: answers `reply` on stdout and records what it was given.
function fakeSpawn(reply, calls = []) {
    return (cmd, args) => {
        const child = new EventEmitter(); child.stdout = new EventEmitter();
        child.stdin = { end: input => { calls.push({ cmd, args, input }); setImmediate(() => { child.stdout.emit('data', reply); child.emit('close', 0); }); } };
        child.kill = () => {};
        return child;
    };
}
const snap = (o = {}) => ({ show: { running: true, phase: 'speaking', youtubeComments: 'connected', twitchComments: 'connected', gamePhase: 'playing' }, counters: { turns_played: 10, content_rejected: 2 },
    runner: { enabled: true, state: 'playing' }, game: { run: 1, elapsed: 100 }, obs: { active: true, reconnecting: false, skippedFrames: 0 }, memory: { level: 'ok' }, ...o });

test('stream watch: off by default and never spawns anything', async t => {
    const calls = [];
    const w = new StreamWatch({ dataDir: temp(t) }, { collect: async () => snap(), spawnFn: fakeSpawn('{}', calls) });
    assert.equal(w.enabled, false); w.start(); assert.equal(w.timer, null);
    assert.equal(await w.check(), null); assert.equal(calls.length, 0);
});

test('stream watch: plain checks every minute call no agent; a flag calls it once, again only after the interval; clearing is told', async t => {
    const dir = temp(t), calls = [], notices = [];
    let s = snap(), now = Date.parse('2026-10-07T01:00:00Z');
    const w = new StreamWatch({ dataDir: dir, streamWatch: 'claude', streamWatchMinutes: 10 }, { collect: async () => s, notify: m => notices.push(m),
        spawnFn: fakeSpawn('```json\n{"status":"warn","summary":"発言が止まっています","issues":["turns_played が増えていない"],"improvements":["雑談の話題を増やす"]}\n```', calls), now: () => now });
    const minute = async (n = 1, f = () => {}) => { let e; for (let i = 0; i < n; i++) { now += 60000; f(i); e = await w.check(); } return e; };
    // Speech and the game clock move every minute: no flag, no agent, one heartbeat line only.
    await w.check(); await minute(4, i => { s = snap({ counters: { turns_played: 11 + i }, game: { run: 1, elapsed: 160 + 60 * i } }); });
    assert.equal(calls.length, 0, 'a quiet night costs no agent call');
    // Speech stops but the game goes on: flagged after five minutes, not before.
    let e = await minute(4, i => { s = snap({ counters: { turns_played: 14 }, game: { run: 1, elapsed: 400 + 60 * i } }); });
    assert.deepEqual(e.flags, []); assert.equal(calls.length, 0);
    e = await minute(1, () => { s = snap({ counters: { turns_played: 14 }, game: { run: 1, elapsed: 700 } }); });
    assert.deepEqual(e.flags, ['5分間、ノアの発言がありません']); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 9), ['-n', '10', 'claude', '-p', '--setting-sources', '', '--tools', '', '--no-session-persistence']);
    assert.ok(calls[0].input.length < 8000, 'small prompt'); assert.match(calls[0].input, /5分間、ノアの発言がありません/);
    assert.equal(e.verdict.status, 'warn'); assert.match(notices.at(-1), /配信の見守り/);
    // The same problem a minute later: its wording changed (6分), the agent is not called again within the interval.
    const flagged = notices.length;
    await minute(9, i => { s = snap({ counters: { turns_played: 14 }, game: { run: 1, elapsed: 760 + 60 * i } }); });
    assert.equal(calls.length, 1, 'no second review within ten minutes'); assert.equal(notices.length, flagged, 'no notice every minute for the same problem');
    await minute(1); assert.equal(calls.length, 2, 'reviewed again after the interval while it lasts');
    // Speech again: the flag clears and the operator is told.
    await minute(1, () => { s = snap({ counters: { turns_played: 15 }, game: { run: 1, elapsed: 1400 } }); });
    assert.equal(notices.at(-1), '配信の見守り：異常はおさまりました');
    const log = readFileSync(join(dir, 'stream-watch', '2026-10-07.jsonl'), 'utf8').trim().split('\n');
    assert.ok(log.length < 20, `flagged checks and heartbeats only (${log.length})`);
});

test('stream watch: a still game clock is flagged after three minutes of play, not during a break', async t => {
    let s = snap(), now = 0;
    const w = new StreamWatch({ dataDir: temp(t), streamWatch: 'claude' }, { collect: async () => s, spawnFn: fakeSpawn('{"status":"ok","summary":"","issues":[],"improvements":[]}'), now: () => now });
    let turns = 10; const tick = async o => { now += 60000; s = snap({ counters: { turns_played: ++turns }, ...o }); return w.check(); };
    await w.check();
    for (let i = 0; i < 4; i++) assert.deepEqual((await tick({ show: { ...snap().show, gamePhase: 'between' } })).flags, [], 'between rounds the clock may stand');
    assert.deepEqual((await tick({})).flags, []); await tick({}); await tick({});
    assert.deepEqual((await tick({})).flags, ['3分間、ゲーム内の時間が進んでいません']);
    assert.deepEqual((await tick({ game: { run: 2, elapsed: 5 } })).flags, [], 'a new run');
});

test('stream watch: a flag calls no agent under memory pressure or past the daily cap; nothing while no show runs', async t => {
    const calls = [];
    let running = true, high = true;
    const w = new StreamWatch({ dataDir: temp(t), streamWatch: 'codex', streamWatchMaxPerDay: 1 }, { collect: async () => snap({ show: { ...snap().show, running }, obs: { active: false } }),
        memoryHigh: () => high, spawnFn: fakeSpawn('{"status":"ok","summary":"","issues":[],"improvements":[]}', calls) });
    assert.equal((await w.check()).skipped, 'memory_pressure'); assert.equal(calls.length, 0);
    high = false; w.flagKey = ''; await w.check(); assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--sandbox') && calls[0].args.includes('read-only'));
    w.flagKey = ''; assert.equal((await w.check()).skipped, 'daily_cap'); assert.equal(calls.length, 1);
    running = false; assert.equal(await w.check(), null);
});

test('stream watch: checks never overlap, and an unusable answer is logged as skipped', async t => {
    const w = new StreamWatch({ dataDir: temp(t), streamWatch: 'claude' }, { collect: async () => snap({ obs: { active: false } }), spawnFn: fakeSpawn('すみません') });
    const [a, b] = await Promise.all([w.check(), w.check()]);
    assert.equal(b, null, 'the second one returns while the first is busy');
    assert.match(a.skipped, /agent_error: unusable answer/);
});

test('stream watch helpers: plain flags, verdict parsing and agent commands', () => {
    assert.deepEqual(redFlags(snap({ show: { running: false } })), []);
    assert.ok(redFlags(snap({ obs: { active: false } })).includes('OBS の配信が止まっています'));
    assert.ok(redFlags(snap({ runner: { enabled: true, state: 'failed' } })).some(f => f.includes('failed')));
    assert.ok(!redFlags(snap({ show: { ...snap().show, closing: true }, runner: { enabled: true, state: 'finished' } })).some(f => f.includes('ゲーム担当')), 'the goodbye stops the player on purpose');
    assert.ok(redFlags(snap({ title: { status: 'partial' } })).includes('配信タイトルを更新できていません'));
    assert.ok(redFlags(snap({ show: { ...snap().show, youtubeComments: 'auth_or_configuration_error' } })).some(f => f.includes('YouTube')));
    assert.equal(parseVerdict('nothing'), null); assert.equal(parseVerdict('{"status":"great"}'), null);
    assert.deepEqual(parseVerdict('{"status":"ok","summary":"s","issues":["a",1],"improvements":[]}'), { status: 'ok', summary: 's', issues: ['a'], improvements: [] });
    assert.equal(agentCommand('off', {}), null);
    assert.ok(agentCommand('claude', { streamWatchMaxUsd: .02 })[1].includes('0.02'));
});
