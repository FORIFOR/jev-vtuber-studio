import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeChatStartIssue } from '../src/youtube.mjs';
import { Ledger } from '../src/store.mjs';
import { RemoteControl } from '../src/remote-control.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

const live = { mode: 'live', readComments: true, streamTarget: 'youtube', youtubeVideo: 'abcdefghijk' };
const usage = used => ({ calls: { youtube: used }, limits: { youtube: 1000 } });

test('exhausted or insufficient initial chat allowance blocks; Twitch-only and disabled reading skip', () => {
    assert.equal(youtubeChatStartIssue(live, usage(1000)).code, 'YOUTUBE_CHAT_BUDGET');
    assert.equal(youtubeChatStartIssue(live, usage(999)).code, 'YOUTUBE_CHAT_BUDGET');
    assert.equal(youtubeChatStartIssue(live, usage(998)), null);
    assert.equal(youtubeChatStartIssue({ ...live, streamTarget: 'simulcast', youtubeChannel: 'channel' }, usage(998)).code, 'YOUTUBE_CHAT_BUDGET');
    for (const overrides of [{ streamTarget: 'twitch' }, { readComments: false }, { mode: 'demo' }])
        assert.equal(youtubeChatStartIssue({ ...live, ...overrides }, usage(1000)), null);
});

test('preflight uses the refreshed UTC window without changing configured limits or consuming calls', t => {
    const c = setup(t); let now = new Date('2026-09-30T23:59:59Z');
    const ledger = new Ledger(c.dataDir, { youtube: 1000 }, () => now);
    ledger.data = { day: '2026-09-30', calls: { youtube: 1000 } };
    assert.equal(youtubeChatStartIssue(live, ledger.snapshot()).code, 'YOUTUBE_CHAT_BUDGET');
    assert.equal(ledger.data.calls.youtube, 1000);
    now = new Date('2026-10-01T00:00:00Z');
    assert.equal(youtubeChatStartIssue(live, ledger.snapshot()), null);
    assert.deepEqual(ledger.snapshot(), { day: '2026-10-01', calls: {}, limits: { youtube: 1000 } });
});

test('remote preflight rejects before memory/provider/OBS checks, independent of stale watcher state', async () => {
    let effects = 0;
    const remote = new RemoteControl({ c: live, engine: { status: () => ({ youtube: 'connected', usage: usage(1000) }) },
        obs: { call: async () => { effects++; } }, memoryPreflight: async () => { effects++; } });
    await assert.rejects(() => remote.preflight(), { code: 'YOUTUBE_CHAT_BUDGET', status: 409 });
    assert.equal(effects, 0);
});

test('local show and OBS starts return a clear 409 before any provider or output effect', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'true' });
    Object.assign(c, live, { port: 0 });
    let effects = 0;
    const ledger = { snapshot: () => usage(1000), reserve: () => { effects++; throw new Error('No paid calls allowed'); } };
    const app = createApp(c, { ledger, youtube: { watch: async () => { effects++; } },
        obs: { owned: false, ready: false, close() {}, stopOwned: async () => {}, start: async () => { effects++; } } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
        for (const [path, body] of [['/api/control', { action: 'start' }], ['/api/obs/start', { confirm: 'START' }]]) {
            for (const override of [{}, { allowUnavailableYouTubeChat: 'true' }, { allowUnavailableYouTubeChat: false }]) {
                const response = await fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...override }) });
                assert.equal(response.status, 409);
                const result = await response.json();
                assert.equal(result.code, 'YOUTUBE_CHAT_BUDGET');
                assert.match(result.error, /コメント読み上げ・返答/);
            }
        }
        assert.equal(app.engine.running, false);
        assert.equal(effects, 0);
    } finally { await app.close(); }
});

test('explicit boolean permission skips only the chat-budget block and retains the next safety check per request', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'true', MEMORY_GUARD: '1' });
    Object.assign(c, live, { port: 0 });
    let effects = 0;
    const ledger = { snapshot: () => usage(1000), reserve: () => { effects++; throw new Error('No paid calls allowed'); } };
    const app = createApp(c, { ledger, memoryRead: async () => ({ pressureLevel: 1, freePercent: 19 }),
        youtube: { watch: async () => { effects++; } },
        obs: { owned: false, ready: false, close() {}, stopOwned: async () => {}, start: async () => { effects++; } } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
        for (const [path, body] of [['/api/control', { action: 'start' }], ['/api/obs/start', { confirm: 'START' }]]) {
            const headers = { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' };
            const permitted = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ ...body, allowUnavailableYouTubeChat: true }) });
            assert.equal(permitted.status, 409);
            const blockedByMemory = await permitted.json();
            assert.notEqual(blockedByMemory.code, 'YOUTUBE_CHAT_BUDGET');
            assert.match(blockedByMemory.error, /メモリ/, 'the following memory safety check still applies');
            const nextRequest = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
            assert.equal(nextRequest.status, 409);
            assert.equal((await nextRequest.json()).code, 'YOUTUBE_CHAT_BUDGET', 'permission is not persisted');
        }
        assert.equal(app.engine.running, false); assert.equal(effects, 0);
        assert.deepEqual(ledger.snapshot(), usage(1000), 'no quota is consumed or reset');
    } finally { await app.close(); }
});
