import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GameRunner } from '../src/game-runner.mjs';
import { setup } from './helpers.mjs';

// The optional external controller lives outside this repository. These tests use its real
// parser and decision compactor, but never launch the game, load .env or request an API.
const gameDir = process.env.VAMPIRE_TEST_GAME_DIR || join(homedir(), 'Projects/jev-vampire-survivors');
const python = process.env.VAMPIRE_TEST_PYTHON || join(gameDir, '.venv/bin/python');
const options = { skip: !existsSync(python) || !existsSync(join(gameDir, 'tools/auto_session.py')), timeout: 10000 };
const env = () => Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
const imports = `
import json, sys, time
from tools.auto_session import wait_for_review
from vampire_agent.policy import apply_next_tactic, compact_decision, prepare_decision, demo_state
args = json.loads(sys.argv[1])
`;
function inspect(code, args) {
    return JSON.parse(execFileSync(python, ['-c', imports + code, JSON.stringify(args)], {
        cwd: gameDir, env: env(), encoding: 'utf8', timeout: 5000,
    }));
}
function runner(t) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4242;
    let launched;
    const instance = new GameRunner(setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', VAMPIRE_RUNS_DIR: join(gameDir, 'runs') }), {
        spawnFn: (cmd, args, opts) => { launched = { cmd, args, opts }; return child; },
    });
    assert.equal(instance.start(), true);
    return { instance, child, launched, runId: `vampire-${instance.session}-r1` };
}

test('real Node → Python review handshake carries each allowed tactic into the next compact decision', options, t => {
    const { instance, launched, runId } = runner(t);
    assert.equal(launched.opts.env.NOA_ROUND_REVIEW_DIR, instance.reviewDir);
    assert.equal(statSync(instance.reviewDir).mode & 0o777, 0o700);
    for (const tactic of ['health_priority', 'escape_space']) {
        assert.equal(instance.completeReview({ runId, tactic }), true);
        const file = join(instance.reviewDir, `${runId}.json`);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(existsSync(`${file}.tmp`), false, 'only an atomic completed acknowledgement is visible');
        const result = inspect(`
tactic = wait_for_review(args['directory'], args['runId'], 1000, now=lambda: 0, sleep=lambda _: None)
context, candidates = prepare_decision(demo_state())
before = sorted(candidates)
apply_next_tactic(context, tactic)
compact, compact_candidates = compact_decision(context, candidates)
print(json.dumps({'tactic': tactic, 'adjustment': compact.get('previous_run_adjustment'),
    'actionsPreserved': before == sorted(compact_candidates),
    'untrusted': apply_next_tactic({}, 'execute arbitrary command')}))
`, { directory: launched.opts.env.NOA_ROUND_REVIEW_DIR, runId });
        assert.equal(result.tactic, tactic);
        assert.match(result.adjustment, tactic === 'health_priority' ? /clearance over XP/ : /extra clearance/);
        assert.equal(result.actionsPreserved, true, 'the tactic adds context without inventing movement actions');
        assert.deepEqual(result.untrusted, {});
    }
});

test('Python waits for the actual atomic acknowledgement written by the running Studio controller', options, async t => {
    const { instance, runId } = runner(t);
    const file = join(instance.reviewDir, `${runId}.json`);
    writeFileSync(file, JSON.stringify({ runId, tactic: 'health_priority', playbackCompleted: false }), { mode: 0o600 });
    const child = spawn(python, ['-u', '-c', imports + `
print('READY', flush=True)
tactic = wait_for_review(args['directory'], args['runId'], time.monotonic() + 64)
print(json.dumps({'tactic': tactic}), flush=True)
`, JSON.stringify({ directory: instance.reviewDir, runId })], { cwd: gameDir, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', error = '', released = false;
    child.stderr.on('data', part => { error += part; });
    child.stdout.on('data', part => { output += part; });
    await new Promise((resolve, reject) => {
        const onData = () => { if (output.includes('READY\n')) { child.stdout.off('data', onData); resolve(); } };
        child.stdout.on('data', onData); child.once('error', reject);
        child.once('exit', () => { if (!output.includes('READY\n')) reject(new Error(`Python did not enter wait: ${error}`)); });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, 'playbackCompleted:false cannot release Continue');
    assert.equal(output.trim(), 'READY');
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    released = instance.completeReview({ runId, tactic: 'escape_space' });
    assert.equal(released, true);
    assert.equal(await exited, 0, error);
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { tactic: 'escape_space' });
});

test('stale sessions, other rounds, path traversal and invalid payloads cannot release the Python controller', options, t => {
    const old = runner(t);
    assert.equal(old.instance.completeReview({ runId: old.runId, tactic: 'health_priority' }), true);
    old.child.emit('exit', 0);
    assert.equal(old.instance.completeReview({ runId: old.runId, tactic: 'health_priority' }), false);
    const current = runner(t), { instance, runId } = current;
    assert.notEqual(instance.reviewDir, old.instance.reviewDir);
    for (const badId of [old.runId, `${runId}/../../escape`, `${runId}.json`, `../${runId}`]) {
        assert.equal(instance.completeReview({ runId: badId, tactic: 'health_priority' }), false);
    }
    assert.equal(instance.completeReview({ runId, tactic: 'arbitrary command' }), false);
    assert.deepEqual(readdirSync(instance.reviewDir), []);
    const result = inspect(`
from pathlib import Path
def attempt(directory, run_id):
    clock = [0]
    def sleep(seconds): clock[0] += seconds
    value = wait_for_review(directory, run_id, 61, now=lambda: clock[0], sleep=sleep)
    return {'value': value, 'waited': clock[0]}
attempts = [attempt(args['oldDirectory'], args['runId']), attempt(args['directory'], args['runId'])]
path = Path(args['directory']) / (args['runId'] + '.json')
for payload in [
    {'runId': args['oldRunId'], 'playbackCompleted': True, 'tactic': 'health_priority'},
    {'runId': args['runId'], 'playbackCompleted': False, 'tactic': 'health_priority'},
    {'runId': args['runId'], 'playbackCompleted': True, 'tactic': 'arbitrary command'},
    [], None, 1,
]:
    path.write_text(json.dumps(payload))
    attempts.append(attempt(args['directory'], args['runId']))
path.write_text('{incomplete atomic write')
attempts.append(attempt(args['directory'], args['runId']))
print(json.dumps(attempts))
`, { directory: instance.reviewDir, runId, oldDirectory: old.instance.reviewDir, oldRunId: old.runId });
    for (const attempt of result) { assert.equal(attempt.value, null); assert.equal(attempt.waited, 1); }
});

test('review waiting remains bounded by 180 seconds and reserves the final 60 seconds of the show', options, t => {
    const { instance, runId } = runner(t);
    const result = inspect(`
attempts = []
for deadline in [1000, 90, 60, 45]:
    clock = [0]
    def sleep(seconds): clock[0] += seconds
    value = wait_for_review(args['directory'], args['runId'], deadline, now=lambda: clock[0], sleep=sleep)
    attempts.append({'deadline': deadline, 'value': value, 'waited': clock[0]})
print(json.dumps(attempts))
`, { directory: instance.reviewDir, runId });
    assert.deepEqual(result, [
        { deadline: 1000, value: null, waited: 180 },
        { deadline: 90, value: null, waited: 30 },
        { deadline: 60, value: null, waited: 0 },
        { deadline: 45, value: null, waited: 0 },
    ]);
});
