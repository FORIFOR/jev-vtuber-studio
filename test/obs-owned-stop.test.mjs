import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { OBS } from '../src/obs.mjs';
import { defer } from './helpers.mjs';

// Exercise the real OBS ownership/serialization code and server stopped listener.
// No server listens, provider workers run, or OBS WebSocket can be constructed.
function fixture(t, { active = false, profile = 'talk' } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'jvs-owned-stop-'));
    const c = config({ DATA_DIR: dataDir, SHOW_PROFILE: profile, READ_COMMENTS: 'false' }, []);
    Object.assign(c, { mode: 'live', allowStream: true, memoryGuard: false });
    class NoWebSocket { constructor() { assert.fail('real OBS connection forbidden'); } }
    const obs = new OBS(c, NoWebSocket), calls = [], events = [];
    const state = { active, fail: null, startGate: null, loseStartAck: false };
    obs.call = async type => {
        calls.push(type);
        if (state.fail === type) throw new Error(`mock ${type} disconnected`);
        if (type === 'GetStreamStatus') return { outputActive: state.active };
        if (type === 'StartStream') {
            if (state.startGate) { state.startGate.entered.resolve(); await state.startGate.release.promise; }
            state.active = true;
            if (state.loseStartAck) throw new Error('mock StartStream acknowledgement lost');
            return {};
        }
        if (type === 'StopStream') { state.active = false; return {}; }
        assert.fail(`unexpected OBS request: ${type}`);
    };
    const app = createApp(c, { obs, vts: { mouth() {}, close() {} },
        gameRunner: { enabled: false, status: () => ({}), stop() {} } });
    app.engine.on('event', event => events.push(event));
    t.after(async () => { try { await app.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
    function running() { app.engine.running = true; app.engine.controller = new AbortController(); }
    async function stop(reason = 'show_completed') {
        running(); app.engine.stop(reason); await app.remoteControl.waitForStop();
        assert.equal(app.engine.running, false);
    }
    return { c, obs, app, calls, events, state, running, stop, marker: join(dataDir, 'obs-owned.json') };
}

for (const reason of ['show_completed', 'session_limit', 'emergency']) {
    test(`${reason} leaves an active unowned OBS stream untouched with ALLOW_OBS_STREAM`, async t => {
        const f = fixture(t, { active: true, profile: reason === 'session_limit' ? 'playground' : 'talk' });
        f.running();
        if (reason === 'session_limit') { f.app.engine.endAt = 0; f.app.engine.monitor(); }
        else if (reason === 'emergency') f.app.engine.emergency();
        else f.app.engine.stop(reason);
        await f.app.remoteControl.waitForStop();
        assert.equal(f.app.engine.running, false);
        assert.equal(f.state.active, true, 'the externally started stream continues');
        assert.equal(f.obs.owned, false);
        assert.deepEqual(f.calls, [], 'even OBS status polling is unnecessary without ownership');
        assert.equal(existsSync(f.marker), false);
    });
}

test('show completion stops the stream started by this Studio exactly once', async t => {
    const f = fixture(t);
    await f.obs.start();
    assert.equal(f.obs.owned, true); assert.equal(existsSync(f.marker), true);
    await f.stop();
    await f.stop();
    assert.deepEqual(f.calls, ['GetStreamStatus', 'StartStream', 'GetStreamStatus', 'StopStream']);
    assert.equal(f.state.active, false); assert.equal(f.obs.owned, false);
    assert.equal(existsSync(f.marker), false);
});

test('completion releases ownership without StopStream if the owned output is already inactive', async t => {
    const f = fixture(t);
    await f.obs.start(); f.state.active = false; f.calls.length = 0;
    await f.stop();
    assert.deepEqual(f.calls, ['GetStreamStatus']);
    assert.equal(f.obs.owned, false); assert.equal(existsSync(f.marker), false);
});

test('a restarted Studio does not infer stop authority from a leftover ownership marker', async t => {
    const f = fixture(t);
    await f.obs.start();
    const marker = readFileSync(f.marker, 'utf8');
    f.obs.close();
    const restarted = new OBS(f.c);
    restarted.call = f.obs.call;
    const app = createApp(f.c, { obs: restarted, vts: { mouth() {}, close() {} },
        gameRunner: { enabled: false, status: () => ({}), stop() {} } });
    try {
        f.calls.length = 0;
        app.engine.running = true; app.engine.controller = new AbortController();
        app.engine.stop('show_completed'); await app.remoteControl.waitForStop();
        assert.equal(restarted.owned, false); assert.equal(f.state.active, true);
        assert.deepEqual(f.calls, []);
        assert.equal(readFileSync(f.marker, 'utf8'), marker, 'a restart leaves prior ownership evidence intact');
    } finally { await app.close(); }
});

for (const request of ['GetStreamStatus', 'StopStream']) {
    test(`failed ${request} during completion retains ownership, reports uncertainty, and permits retry`, async t => {
        const f = fixture(t);
        await f.obs.start(); f.calls.length = 0; f.state.fail = request;
        await f.stop();
        assert.equal(f.obs.owned, true); assert.equal(f.state.active, true);
        assert.equal(existsSync(f.marker), true);
        assert.ok(f.events.some(e => e.type === 'notice' && e.data.message.includes('OBS停止を確認できません')));
        assert.deepEqual(f.calls, request === 'GetStreamStatus' ? [request] : ['GetStreamStatus', request]);
        f.state.fail = null; f.calls.length = 0;
        await f.stop();
        assert.deepEqual(f.calls, ['GetStreamStatus', 'StopStream']);
        assert.equal(f.obs.owned, false); assert.equal(f.state.active, false);
        assert.equal(existsSync(f.marker), false);
    });
}

test('lost start acknowledgement and failed rollback retain ownership for completion cleanup', async t => {
    const f = fixture(t);
    f.state.loseStartAck = true; f.state.fail = 'StopStream';
    await assert.rejects(f.obs.start(), /acknowledgement lost/);
    assert.equal(f.obs.owned, true); assert.equal(f.state.active, true);
    assert.equal(existsSync(f.marker), true);
    f.state.fail = null; f.calls.length = 0;
    await f.stop();
    assert.deepEqual(f.calls, ['GetStreamStatus', 'StopStream']);
    assert.equal(f.obs.owned, false); assert.equal(f.state.active, false);
    assert.equal(existsSync(f.marker), false);
});

test('completion queued during StartStream still stops the newly owned output', async t => {
    const f = fixture(t), entered = defer(), release = defer();
    f.state.startGate = { entered, release };
    const start = f.obs.start();
    await entered.promise;
    const stopped = f.stop();
    release.resolve(); await start; await stopped;
    assert.deepEqual(f.calls, ['GetStreamStatus', 'StartStream', 'GetStreamStatus', 'StopStream']);
    assert.equal(f.state.active, false); assert.equal(f.obs.owned, false);
    assert.equal(existsSync(f.marker), false);
});

for (const [label, status] of [['unreported', {}], ['reconnecting', { outputActive: false, outputReconnecting: true }]]) {
    test(`an OBS output whose state is ${label} is never taken over`, async t => {
        const { obs, calls, marker } = fixture(t);
        obs.call = async type => { calls.push(type); if (type === 'GetStreamStatus') return status; assert.fail(`unexpected OBS request: ${type}`); };
        await assert.rejects(obs.start(), /refusing to take ownership/);
        assert.deepEqual(calls, ['GetStreamStatus']);
        assert.equal(obs.owned, false); assert.equal(existsSync(marker), false);
    });
}
