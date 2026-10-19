import test from 'node:test';
import assert from 'node:assert/strict';
import { goLive } from '../public/go-live.mjs';
// Operator 2026-10-10: when 「配信を始める」 fails after the show started, the show is stopped again (never left
// running with no stream).
function rig({ fail = null, voice = true } = {}) {
    const calls = []; let running = false, t = 0;
    const api = async (path, body) => {
        calls.push(body?.action ? `${path}:${body.action}${body.force ? ':force' : ''}` : path);
        if (fail === path) throw new Error(`${path} failed`);
        if (path === '/api/control' && body.action === 'start') running = true;
        if (path === '/api/control' && body.action === 'stop') running = false;
        if (path === '/api/session') return { status: { running, hasPlayedLiveAudio: voice, renderer: voice }, gameRunner: { enabled: false } };
        return {};
    };
    const said = [];
    return { calls, said, get running() { return running; },
        run: () => goLive({ api, say: x => said.push(x), now: () => t, sleep: async ms => { t += ms; }, waitMs: 10000, gameGraceMs: 2000 }) };
}
test('go live: every step in order', async () => {
    const r = rig(); const out = await r.run();
    assert.equal(out.ok, true); assert.equal(r.running, true);
    assert.deepEqual(r.calls, ['/api/obs/prepare', '/api/control:start', '/api/session', '/api/obs/start']);
});
test('go live: OBS failing to start stops the show again (and only the Studio-owned output)', async () => {
    const r = rig({ fail: '/api/obs/start' }); const out = await r.run();
    assert.equal(out.ok, false); assert.equal(out.rolledBack, true); assert.equal(r.running, false);
    assert.deepEqual(r.calls.slice(-2), ['/api/obs/stop', '/api/control:stop:force']);
    assert.match(r.said.at(-1), /番組を止めました/);
});
test('go live: the voice never reaching OBS stops the show again', async () => {
    const r = rig({ voice: false }); const out = await r.run();
    assert.equal(out.rolledBack, true); assert.equal(r.running, false);
    assert.match(out.error, /OBSで再生されません/);
});
test('go live: a failure before the show started stops nothing', async () => {
    const r = rig({ fail: '/api/control' }); const out = await r.run();
    assert.equal(out.ok, false); assert.equal(out.rolledBack, false);
    assert.ok(!r.calls.includes('/api/obs/stop'));
});
