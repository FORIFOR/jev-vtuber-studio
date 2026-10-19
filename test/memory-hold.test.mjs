import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHold } from '../src/memory-guard.mjs';
import { Conversation } from '../src/providers.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit } from './helpers.mjs';

const normal = (at, freePercent = 40) => ({ at, level: 'normal', freePercent });

test('MemoryHold: one hold per episode; it ends after 20 s of readings good enough to start a broadcast', () => {
    const h = new MemoryHold();
    assert.equal(h.critical({ at: 0 }), true); assert.equal(h.critical({ at: 1000 }), false);
    assert.equal(h.update(normal(5000)), false);
    assert.equal(h.update({ at: 15000, level: 'warning', freePercent: 30 }), false); // a warning restarts the count
    assert.equal(h.update(normal(20000, 24)), false);                               // below the start bar
    assert.equal(h.update(normal(25000)), false); assert.equal(h.update(normal(44000)), false);
    assert.equal(h.update(normal(45000)), true); assert.equal(h.held, false);
});

test('MemoryHold: a hold that comes back soon after a resume needs a longer calm (no flapping), capped at 5 min', () => {
    const h = new MemoryHold();
    h.critical({ at: 0 }); h.update(normal(1000)); h.update(normal(21000)); // resumed at 21 s
    h.critical({ at: 60000 }); assert.equal(h.recoverMs, 40000);
    h.update(normal(61000)); assert.equal(h.update(normal(91000)), false); assert.equal(h.update(normal(101000)), true);
    for (let k = 0, t = 200000; k < 6; k++, t += 400000) { h.critical({ at: t }); h.update(normal(t + 1)); h.update(normal(t + 300001)); }
    assert.equal(h.recoverMs, 300000);
    h.critical({ at: 99e6 }); assert.equal(h.recoverMs, 20000); // long after the last resume: back to the base
});

test('Conversation.release unloads the local Ollama model; other providers have nothing to release', async t => {
    const c = setup(t, { LLM_PROVIDER: 'ollama', LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LLM_MODEL: 'noa-model' }); c.mode = 'live';
    const calls = []; const conv = new Conversation(c, ledger(), async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); });
    assert.equal(await conv.release(), true);
    assert.deepEqual(calls, [{ url: 'http://127.0.0.1:11434/api/generate', body: { model: 'noa-model', keep_alive: 0 } }]);
    const g = setup(t, { LLM_PROVIDER: 'gemini' }); g.mode = 'live';
    assert.equal(await new Conversation(g, ledger(), async () => { throw new Error('must not call'); }).release(), false);
});

test('TalkEngine memory hold: nothing new is prepared while held; release lifts it', t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', KEEP_LIVE: '1' }); let generated = 0;
    const voice = { synthesize: async () => { throw new Error('no'); }, clipKinds: () => [], available: () => false, retryAt: () => 0, estimateAudioMs: s => s.length * 100, estimateSynthMs: () => 0, status: () => ({ main: { id: 'mock', state: 'down' } }) };
    const e = new TalkEngine(c, { ledger: ledger(), audit, voice, jev: { chat: async () => ({ accept: true }), speech: async () => ({ accept: true }) }, conversation: { generate: async () => { generated++; return 'こんばんは。'; } }, research: { search: async () => { throw new Error('no'); } } });
    t.after(() => e.stop('test'));
    const events = []; e.on('event', ev => { if (ev.type === 'memory_hold') events.push(ev.data); });
    e.setMemoryHold(true, 'low_headroom');
    e.startPrefetch(e.epoch, new AbortController().signal);
    assert.equal(e.preparationTask ?? null, null); assert.equal(generated, 0);
    e.setMemoryHold(false, 'memory_recovered');
    assert.deepEqual(events.map(x => x.held), [true, false]);
});

test('KEEP_LIVE server: critical and even emergency memory hold the talk and keep the broadcast; recovery resumes it', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { MEMORY_GUARD: '1', KEEP_LIVE: '1' }); c.mode = 'live';
    let now = 0, freePercent = 9, pressureLevel = 1, stops = 0, released = 0, closing = null;
    const app = createApp(c, { remoteOptions: null, memoryNow: () => now, memoryRead: async () => ({ pressureLevel, freePercent }),
        obs: { owned: true, ready: false, stopOwned: async () => { stops++; }, close() {} },
        conversation: { generate: async () => { throw new Error('Must not call'); }, release: async () => { released++; return true; } } });
    app.engine.running = true; app.engine.requestBudgetClose = r => { closing = r; };
    const holds = []; app.engine.setMemoryHold = (on, reason) => holds.push([on, reason]);
    await app.memory.sample();
    assert.deepEqual(holds, [[true, 'low_headroom']]); assert.equal(released, 1);
    freePercent = 4; now = 5000; await app.memory.sample(); // emergency: still no stop, no second release
    assert.equal(app.engine.running, true); assert.equal(stops, 0); assert.equal(closing, null); assert.equal(released, 1);
    freePercent = 40; now = 10000; await app.memory.sample(); now = 29000; await app.memory.sample();
    assert.equal(holds.length, 1);
    now = 30000; await app.memory.sample();
    assert.deepEqual(holds.at(-1), [false, 'memory_recovered']);
    app.engine.running = false; await app.close();
});
