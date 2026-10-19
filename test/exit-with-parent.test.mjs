import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { exitWithParent } from '../src/util.mjs';
// Live 2026-10-10: helpers orphaned by a kill -9 hot restart kept logging in to OBS with a stale config until OBS's
// WebSocket stopped answering. A spawned helper now exits once its server is gone.
test('exitWithParent: only with JVS_PARENT_PID; exits once reparented', async () => {
    assert.equal(exitWithParent({}), null, 'run by hand: nothing changes');
    let ppid = 42, exited = 0;
    const timer = exitWithParent({ JVS_PARENT_PID: '42' }, { every: 5, exit: () => exited++, ppid: () => ppid });
    await new Promise(r => setTimeout(r, 20)); assert.equal(exited, 0);
    ppid = 1; await new Promise(r => setTimeout(r, 20)); assert.ok(exited >= 1);
    clearInterval(timer);
});
test('exitWithParent: a real helper exits after its parent is killed with SIGKILL', { timeout: 20000 }, async () => {
    const util = new URL('../src/util.mjs', import.meta.url).href;
    // parent → helper; the helper prints its pid and keeps running until its parent is gone.
    const helper = `import { exitWithParent } from ${JSON.stringify(util)}; exitWithParent(process.env, { every: 100 }); console.log(process.pid); setInterval(() => {}, 1000);`;
    const parentCode = `const { spawn } = await import('node:child_process'); const c = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(helper)}], { env: { ...process.env, JVS_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode], { stdio: ['ignore', 'pipe', 'inherit'] });
    const childPid = await new Promise(r => parent.stdout.once('data', d => r(Number(String(d).trim()))));
    assert.ok(childPid > 0);
    parent.kill('SIGKILL');
    const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(alive(), false, 'the orphaned helper exited');
});
