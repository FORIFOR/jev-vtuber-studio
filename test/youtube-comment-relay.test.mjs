import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenIds, YouTubeCommentRelay } from '../scripts/youtube-comment-relay.mjs';
import { hash, sleep } from '../src/util.mjs';

const video = 'abcdefghijk', baseTime = Date.parse('2026-10-01T00:00:00Z');
const status = (overrides = {}) => ({ running: true, epoch: 7, youtube: 'budget_exhausted', remainingMs: 60000, ...overrides });
const message = (id, at = baseTime, text = 'a real viewer comment') => ({ id, snippet: {
    type: 'textMessageEvent', publishedAt: new Date(at).toISOString(), textMessageDetails: { messageText: text },
} });
function fixture(overrides = {}) {
    const logs = [];
    const relay = new YouTubeCommentRelay({ video, session: async () => status(), resolveChat: async () => 'chat',
        stream: async function* () {}, forward: async () => ({ accepted: true, id: 'engine-id' }),
        log: x => logs.push(x), now: () => baseTime, ...overrides });
    return { relay, logs };
}

test('only new, timely valid text enters the queue; reconnect pages are deduplicated and logs omit prose', () => {
    const { relay, logs } = fixture({ now: () => baseTime + 65000 });
    relay.startedAt = baseTime;
    relay.receive({ items: [message('history', baseTime - 1), message('stale', baseTime + 1), message('future', baseTime + 65001),
        message('fresh', baseTime + 64000), message('empty', baseTime + 64000, ''), message('oversize', baseTime + 64000, 'x'.repeat(501))] });
    relay.receive({ items: [message('fresh', baseTime + 64000)] });
    assert.equal(relay.queue.length, 1);
    assert.equal(relay.queue[0].id, hash(`${video}:fresh`));
    assert.equal(logs[0].source, 'youtube');
    assert.equal(JSON.stringify(logs).includes('a real viewer comment'), false);
});

test('hashed IDs survive receiver restarts and dedupe storage remains bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'youtube-relay-test-'));
    try {
        const path = join(dir, 'seen.json'), id = hash('message');
        new SeenIds(path).add(id);
        const next = new SeenIds(path);
        assert.equal(next.has(id), true);
        assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))), ['ids']);
        const bounded = new SeenIds();
        for (let i = 0; i < 5001; i++) bounded.add(hash(String(i)));
        assert.equal(bounded.ids.size, 5000);
        assert.equal(bounded.has(hash('0')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanly ending RPCs cannot exceed the explicit request cap', async () => {
    let calls = 0;
    const { relay } = fixture({ maxRpcs: 2, wait: (ms, signal) => sleep(Math.min(ms, 2), signal),
        stream: async function* () { calls++; } });
    assert.equal(await relay.run(), 'rpc_limit');
    assert.equal(calls, 2);
    assert.equal(relay.rpcStarts, 2);
});

test('every forwarding attempt is spaced by at least seven seconds and marked local in engine', async () => {
    let now = baseTime; const sent = [];
    const { relay, logs } = fixture({ now: () => now, wait: async ms => { now += ms; },
        forward: async text => { sent.push({ text, at: now }); if (sent.length === 2) relay.stop('operator_stop'); return { accepted: true }; } });
    relay.startedAt = baseTime; relay.epoch = 7; relay.endAt = baseTime + 60000;
    relay.receive({ items: [message('one'), message('two')] });
    await relay.forwardLoop();
    assert.equal(sent.length, 2);
    assert.ok(sent[1].at - sent[0].at >= 7000);
    assert.equal(logs.filter(x => x.event === 'forwarded').every(x => x.engineSource === 'local'), true);
});

for (const [name, updated, reason] of [
    ['stopped Studio', { running: false }, 'studio_stopped'],
    ['new Studio epoch', { epoch: 8 }, 'session_changed'],
    ['native receiver resumed', { youtube: 'connected' }, 'native_receiver_state_changed'],
]) {
    test(`${name} prevents a queued comment from being forwarded`, async () => {
        let sent = 0;
        const { relay } = fixture({ session: async () => status(updated), forward: async () => { sent++; } });
        relay.startedAt = baseTime; relay.epoch = 7; relay.endAt = baseTime + 60000;
        relay.receive({ items: [message('pending')] });
        await relay.forwardLoop();
        assert.equal(relay.reason, reason);
        assert.equal(sent, 0);
        assert.equal(relay.queue.length, 0);
    });
}

test('independent lifecycle monitor aborts a silent long-lived stream', async () => {
    let sessions = 0, streamAborted = false;
    const { relay } = fixture({ healthMs: 2, session: async () => status({ running: ++sessions === 1 }),
        stream: async function* ({ signal }) {
            try { await sleep(10000, signal); } catch { streamAborted = signal.aborted; }
        } });
    assert.equal(await relay.run(), 'studio_stopped');
    assert.equal(streamAborted, true);
});

test('auth or quota failure stops after one RPC without retry', async () => {
    const { relay } = fixture({ stream: async function* () { throw Object.assign(new Error('secret provider detail'), { code: 7 }); } });
    assert.equal(await relay.run(), 'youtube_auth_quota_or_configuration');
    assert.equal(relay.rpcStarts, 1);
});

test('fixed deadline aborts a silent stream without forwarding history', async () => {
    const { relay } = fixture({ maxMs: 5, stream: async function* ({ signal }) { await sleep(10000, signal); } });
    assert.equal(await relay.run(), 'session_deadline');
    assert.equal(relay.forwarded, 0);
});
