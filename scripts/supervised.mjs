// Separate process watchdog. Never auto-restarts a show or starts an external stream.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { config, loadEnv, ROOT } from '../src/config.mjs';
import { OBS } from '../src/obs.mjs';
import { sleep } from '../src/util.mjs';
loadEnv();
try {
    const c = config(), marker = `${c.dataDir}/obs-owned.json`;
    if (existsSync(marker))
        throw new Error('Stale OBS ownership marker exists. Confirm OBS is stopped, then remove data/obs-owned.json before starting another supervised session.');
    const child = spawn(process.execPath, ['--max-old-space-size=1024', `${ROOT}/src/server.mjs`, ...(c.mode === 'demo' ? ['--demo'] : [])], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, MODE: c.mode, PORT: String(c.port), ADMIN_TOKEN: c.adminToken, VIEW_TOKEN: c.viewToken, DATA_DIR: c.dataDir } });
    // Keep the Mac awake while the Studio runs (an idle sleep stopped a batch for 3.5 h on 2026-10-05); caffeinate exits
    // on its own with this watchdog (-w). Best effort: a missing binary only loses the guard.
    if (process.platform === 'darwin') {
        try { spawn('/usr/bin/caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).on('error', () => { }).unref(); } catch { }
    }
    let stopped = false, exited = false, misses = 0, noAudioAt = 0;
    const obs = new OBS(c);
    async function stop(reason) {
        if (stopped)
            return;
        stopped = true;
        console.error(`Supervisor stopping: ${reason}`);
        if (!exited)
            child.kill('SIGTERM');
        for (let i = 0; i < 40 && !exited; i++)
            await sleep(250);
        if (!exited)
            child.kill('SIGKILL');
        // Recover only this child PID's ownership intent; never take over unrelated OBS output.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                if (!existsSync(marker))
                    break;
                const ownership = JSON.parse(readFileSync(marker, 'utf8'));
                if (ownership.pid !== child.pid) {
                    console.error('Unrelated ownership marker: refusing OBS changes.');
                    break;
                }
                obs.owned = true;
                await obs.stopOwned();
                break;
            }
            catch {
                console.error('OBS stop could not be confirmed; check the OBS output manually.');
                await sleep(1000);
            }
        }
        obs.close();
        if (existsSync(marker))
            process.exitCode = 1;
    }
    child.on('error', () => { exited = true; void stop('child_spawn_error'); });
    child.on('exit', code => { exited = true; if (code)
        process.exitCode = 1; void stop('child_exit'); });
    process.on('SIGINT', () => { void stop('operator_interrupt'); });
    process.on('SIGTERM', () => { void stop('operator_termination'); });
    await sleep(1800);
    while (!stopped) {
        try {
            const r = await fetch(`http://127.0.0.1:${c.port}/healthz`, { signal: AbortSignal.timeout(1200), redirect: 'error' }), h = await r.json();
            if (!r.ok || h.pid !== child.pid)
                throw new Error('Wrong or unhealthy server');
            misses = 0;
            // Between shows no renderer is expected: only a running show without one is a dead audio path.
            // A still screen (standby, away, ended: offStage) hides the stage, and with it the renderer, on purpose.
            if (h.running && h.ownedOBS && !h.renderer && !h.offStage) {
                noAudioAt ||= Date.now();
                if (Date.now() - noAudioAt > 15000) {
                    await stop('audio_renderer_missing');
                    break;
                }
            }
            else
                noAudioAt = 0;
        }
        catch {
            if (++misses >= 3) {
                await stop('healthcheck_failed');
                break;
            }
        }
        await sleep(2000);
    }
}
catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
