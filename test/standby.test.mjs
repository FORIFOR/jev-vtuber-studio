import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/providers.mjs';
import { TalkEngine, STANDBY_CHECK_LINE } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';
// Standby (STANDBY_SECONDS, operator 2026-10-11 show format: 配信準備中 1 min → talk → game → goodbye → end screen).
const approved = { accept: true, effect: 'none', mood: 'warm' };
function fixture(t, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', STANDBY_SECONDS: '60', ...env }); c.mode = 'live';
    const judged = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, signal, evidence, ctx) => { judged.push({ text, ctx }); return approved; } },
        conversation: new Conversation(c, ledger()), voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        research: { search: async () => { throw new Error('no search'); } } });
    t.after(() => e.stop('test')); active(e); e.standby = e.standbyMode(); e.standbyFrom = Date.now(); return { e, judged };
}
async function step(e, n = 10) {
    for (let i = 0; i < n && e.running && !e.pending; i++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        if (!e.pending && e.preparationTask) await e.preparationTask;
        await new Promise(r => setImmediate(r));
    }
    return e.pending;
}
function ack(e) {
    const p = e.pending;
    assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'started' }), true);
    assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'ended' }), true);
}

test('standby: one gated audio-check line proves the live audio, then the show holds silent until released; the held time is not the show\'s', async t => {
    const { e, judged } = fixture(t);
    assert.equal(e.standby, 'check'); assert.equal(e.lastAudioOK, false);
    const p = await step(e);
    assert.equal(p.text, STANDBY_CHECK_LINE); assert.equal(judged[0].text, STANDBY_CHECK_LINE, 'the check line passes the gate like every line');
    assert.equal(judged[0].ctx.fixedLine, true);
    ack(e);
    assert.equal(e.lastAudioOK, true, 'OBS may start now (its precondition is a played line)');
    await step(e, 3);
    assert.equal(e.standby, 'hold'); assert.equal(e.pending, null, 'nothing is said while the 配信準備中 screen is on air');
    assert.equal(e.director.opened, false, 'the opening is kept for the viewers');
    e.standbyFrom -= 60000; const endAt = e.endAt;
    assert.equal(e.releaseStandby(), true);
    assert.equal(e.standby, null); assert.ok(e.endAt >= endAt + 60000, 'the standby minute does not shorten the show');
    e.c.mode = 'demo'; // the rest of the show from the offline stand-ins (no model call in tests)
    const first = await step(e);
    assert.ok(first && first.text !== STANDBY_CHECK_LINE, 'the show begins after the release');
});

test('standby: a release before the audio check passed waits for it; off without STANDBY_SECONDS or outside live', async t => {
    const { e } = fixture(t);
    assert.equal(e.releaseStandby(), false); assert.equal(e.standby, 'check');
    await step(e); ack(e); await step(e, 2);
    assert.equal(e.standby, null, 'released as soon as the check passed');
    assert.equal(fixture(t, { STANDBY_SECONDS: '0' }).e.standby, null);
    const demo = fixture(t).e; demo.c.mode = 'demo'; assert.equal(demo.standbyMode(), null, 'demo mode never holds');
});

test('standby over HTTP: OBS starts on the 配信準備中 screen; after STANDBY_SECONDS the programme scene goes on air and the show is released', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', STANDBY_SECONDS: '1', ALLOW_OBS_STREAM: 'true' }); c.mode = 'live'; c.standbyMs = 150;
    const scenes = [], calls = [];
    const obs = { ready: true, owned: false, close() {}, async call() { return {}; }, async connect() {}, async prepare() { return {}; }, async stopOwned() {},
        async start() { calls.push(['start', scenes.at(-1)]); this.owned = true; }, async showScreen(n) { scenes.push(n); return n; }, async adopt() { this.owned = true; } };
    const app = createApp(c, { obs, remoteOptions: null, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(async () => { app.engine.stop('test'); await app.close(); });
    const e = app.engine; e.running = true; e.epoch = 1; e.controller = new AbortController(); e.standby = 'hold'; e.standbyFrom = Date.now(); e.lastAudioOK = true;
    e.claimRenderer('r'); let released = 0; e.releaseStandby = () => { released++; e.standby = null; return true; };
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/obs/start`, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'START', allowUnavailableYouTubeChat: true }) });
    assert.equal(r.status, 200, await r.text());
    assert.deepEqual(calls, [['start', 'standby']], 'the stream begins on the 配信準備中 screen');
    assert.equal(released, 0);
    // The standby screen hides the stage and OBS drops its renderer: /healthz says so, the supervisor waits (live 2026-10-11).
    const health = async () => (await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`)).json();
    obs.screen = 'standby'; e.renderer = null;
    assert.equal((await health()).offStage, true, 'off stage while the standby screen is up');
    for (let i = 0; i < 40 && !released; i++) await new Promise(r => setTimeout(r, 25));
    assert.deepEqual(scenes, ['standby', 'show']); assert.equal(released, 1);
    obs.screen = 'show';
    const after = await health();
    assert.equal(after.offStage, false); assert.equal(after.renderer, false, 'a missing renderer on the programme scene is a dead audio path again');
    e.running = false;
});

test('standby: a stop while holding ends at once (nothing aired, no goodbye to wait for)', async t => {
    const { e } = fixture(t); const stops = []; e.on('stopped', r => stops.push(r));
    await step(e); ack(e); await step(e, 2); assert.equal(e.standby, 'hold');
    e.requestClose('operator');
    assert.equal(e.running, false); assert.deepEqual(stops, ['stopped_in_standby']);
});
