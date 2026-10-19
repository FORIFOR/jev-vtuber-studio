import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { OBS, SCREENS } from '../src/obs.mjs';

// Mocked OBS RPCs only: no WebSocket, no provider, no stream.
function fixture(t, env = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'jvs-screens-'));
    const c = config({ DATA_DIR: dataDir, SHOW_PROFILE: 'talk', READ_COMMENTS: 'false', ...env }, []);
    Object.assign(c, { mode: 'live', allowStream: true, memoryGuard: false });
    class NoWebSocket { constructor() { assert.fail('real OBS connection forbidden'); } }
    const obs = new OBS(c, NoWebSocket), calls = [];
    obs.call = async (type, data) => { calls.push([type, data?.sceneName]); if (type === 'GetStreamStatus') return { outputActive: true }; return {}; };
    const app = createApp(c, { obs, vts: { mouth() {}, close() {} }, gameRunner: { enabled: false, status: () => ({}), stop() {} } });
    t.after(async () => { try { await app.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
    return { c, obs, app, calls };
}

test('a standby screen goes on air by name and "show" returns to the programme scene', async t => {
    const { obs, calls } = fixture(t);
    assert.equal(await obs.showScreen('tuning'), SCREENS.tuning);
    obs.programmeScene = 'Jev Studio - Vampire Survivors';
    assert.equal(await obs.showScreen('show'), 'Jev Studio - Vampire Survivors');
    await assert.rejects(obs.showScreen('nope'), /Unknown screen/);
    assert.deepEqual(calls, [['SetCurrentProgramScene', 'Noa 機材調整中'], ['SetCurrentProgramScene', 'Jev Studio - Vampire Survivors']]);
});

test('a completed show puts 配信終了 on air before OBS stops; an emergency stops at once', async t => {
    for (const [reason, screen] of [['show_completed', true], ['emergency', false]]) {
        const { app, obs, calls } = fixture(t, { END_SCREEN_SECONDS: '0' });
        app.c = undefined; obs.c.endScreenMs = 5; obs.owned = true;
        app.engine.running = true; app.engine.controller = new AbortController();
        app.engine.stop(reason); await app.remoteControl.waitForStop();
        const scene = calls.findIndex(c => c[0] === 'SetCurrentProgramScene'), stop = calls.findIndex(c => c[0] === 'StopStream');
        assert.ok(stop >= 0, `${reason}: OBS stops`);
        if (screen) { assert.equal(calls[scene][1], 'Noa 配信終了'); assert.ok(scene < stop); }
        else assert.equal(scene, -1);
    }
});

test('only an active output can be adopted, and adopting writes the ownership record', async t => {
    const { obs, c } = fixture(t);
    await obs.adopt(); assert.equal(obs.owned, true);
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(c.dataDir, 'obs-owned.json')));
    const idle = fixture(t).obs; idle.call = async type => type === 'GetStreamStatus' ? { outputActive: false } : {};
    await assert.rejects(idle.adopt(), /not streaming/); assert.equal(idle.owned, false);
});

test('OBS_RECORD: the Studio records its own stream (start and adoption) and stops the recording with it; off by default', async t => {
    for (const on of [true, false]) {
        const { obs, calls } = fixture(t, on ? { OBS_RECORD: 'true' } : {});
        let recording = false;
        obs.call = async type => { calls.push([type]); if (type === 'GetStreamStatus') return { outputActive: true }; if (type === 'GetRecordStatus') return { outputActive: recording }; if (type === 'StartRecord') recording = true; if (type === 'StopRecord') recording = false; return {}; };
        await obs.adopt();
        assert.equal(recording, on, 'adoption starts the recording only when OBS_RECORD=true');
        await obs.stopOwned();
        assert.equal(recording, false);
        assert.equal(calls.some(c => c[0] === 'StartRecord'), on);
        assert.ok(calls.some(c => c[0] === 'StopStream'));
    }
});
