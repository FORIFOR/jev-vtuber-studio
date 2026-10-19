import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeYouTubeChat } from '../src/youtube-check.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

// Injected YouTube API only: no Google, OBS or provider traffic.
const live = { mode: 'live', readComments: true, streamTarget: 'youtube', youtubeVideo: 'abcdefghijk' };
const ledger = (used = 0) => { const calls = { youtube: used }; return { calls, reserve(k) { calls[k] = (calls[k] || 0) + 1; }, snapshot: () => ({ calls: { ...calls }, limits: { youtube: 1000 } }) }; };
const youtube = { token: async () => 'access' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const googleError = (status, reason, message = '') => reply(status, { error: { code: status, message, errors: [{ reason }] } });
function api(routes) {
    const seen = [];
    const fetchFn = async url => {
        const u = new URL(url); seen.push(`${u.pathname.replace('/youtube/v3/', '')}?${u.searchParams.get('broadcastStatus') || ''}`);
        for (const [match, answer] of routes) if (u.pathname.endsWith(match)) return typeof answer === 'function' ? answer(u) : answer;
        throw new Error(`unexpected ${url}`);
    };
    return { fetchFn, seen };
}
const liveVideo = () => reply(200, { items: [{ snippet: { title: '夜ふかし相談室' }, liveStreamingDetails: { actualStartTime: '2026-10-09T10:00:00Z', activeLiveChatId: 'chat-1' } }] });

test('a readable chat passes and logs every step it took', async () => {
    const { fetchFn, seen } = api([['/videos', liveVideo], ['/liveChat/messages', reply(200, { items: [{ id: 'm1' }] })]]);
    const r = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn });
    assert.equal(r.ok, true); assert.equal(r.code, 'OK'); assert.equal(r.liveChatId, 'chat-1');
    assert.deepEqual(r.log.map(x => [x.step, x.ok]), [['取得枠', true], ['認証', true], ['配信枠', true], ['チャット', true], ['コメントの読み込み', true]]);
    assert.deepEqual(seen, ['videos?', 'liveChat/messages?']);
});

test('the API disabled in Google Cloud is reported with its reason, the failing step and what to do', async () => {
    const { fetchFn } = api([['/videos', googleError(403, 'accessNotConfigured', 'YouTube Data API v3 has not been used in project 123 before or it is disabled.')]]);
    const r = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn });
    assert.equal(r.ok, false); assert.equal(r.code, 'FORBIDDEN');
    assert.match(r.message, /HTTP 403 accessNotConfigured/); assert.match(r.hint, /YouTube Data API v3」が無効/);
    assert.deepEqual(r.log.at(-1), { ...r.log.at(-1), step: '配信枠の確認', ok: false });
    assert.match(r.log.at(-1).detail, /disabled/);
});

test('quota, missing OAuth, a chat that is off, an ended broadcast and no broadcast each name their cause', async () => {
    const quota = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn: api([['/videos', googleError(403, 'quotaExceeded')]]).fetchFn });
    assert.equal(quota.code, 'QUOTA'); assert.match(quota.hint, /割り当て/);
    const noAuth = await probeYouTubeChat(live, { youtube: { token: async () => { throw Object.assign(new Error('YouTube OAuth credentials missing'), { code: 'CONFIGURATION' }); } }, ledger: ledger(), fetchFn: api([]).fetchFn });
    assert.equal(noAuth.code, 'AUTH'); assert.match(noAuth.hint, /youtube:auth/);
    const off = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn: api([['/videos', reply(200, { items: [{ snippet: {}, liveStreamingDetails: { scheduledStartTime: 'x' } }] })], ['/liveBroadcasts', reply(200, { items: [{ snippet: {} }] })]]).fetchFn });
    assert.equal(off.code, 'CHAT_DISABLED'); assert.match(off.hint, /チャットを有効/);
    const ended = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn: api([['/videos', reply(200, { items: [{ snippet: {}, liveStreamingDetails: { actualEndTime: '2026-10-08T00:00:00Z' } }] })]]).fetchFn });
    assert.equal(ended.code, 'ENDED');
    const none = await probeYouTubeChat({ ...live, youtubeVideo: '' }, { youtube, ledger: ledger(), fetchFn: api([]).fetchFn });
    assert.equal(none.code, 'NO_BROADCAST'); assert.match(none.hint, /予約枠/);
    const budget = await probeYouTubeChat(live, { youtube, ledger: ledger(999), fetchFn: api([]).fetchFn });
    assert.equal(budget.code, 'YOUTUBE_CHAT_BUDGET');
});

test('a reservation before going live is checked through its own chat id', async () => {
    const { fetchFn, seen } = api([['/videos', reply(200, { items: [{ snippet: { title: '予約' }, liveStreamingDetails: { scheduledStartTime: '2026-10-09T10:00:00Z' } }] })],
        ['/liveBroadcasts', reply(200, { items: [{ snippet: { liveChatId: 'chat-upcoming' } }] })], ['/liveChat/messages', reply(200, { items: [] })]]);
    const r = await probeYouTubeChat(live, { youtube, ledger: ledger(), fetchFn });
    assert.equal(r.ok, true); assert.equal(r.liveChatId, 'chat-upcoming'); assert.deepEqual(seen, ['videos?', 'liveBroadcasts?', 'liveChat/messages?']);
    assert.match(r.log.find(x => x.step === '配信枠').detail, /配信開始前/);
});

test('simulcast finds the channel broadcast, live or upcoming', async () => {
    const { fetchFn, seen } = api([['/liveBroadcasts', u => reply(200, { items: u.searchParams.get('broadcastStatus') === 'upcoming' ? [{ id: 'vid-up', snippet: { channelId: 'UC1', liveChatId: 'chat-sim' } }] : [] })],
        ['/videos', reply(200, { items: [{ snippet: {}, liveStreamingDetails: { scheduledStartTime: 'x' } }] })], ['/liveChat/messages', reply(200, { items: [] })]]);
    const r = await probeYouTubeChat({ ...live, streamTarget: 'simulcast', youtubeVideo: '', youtubeChannel: 'UC1' }, { youtube, ledger: ledger(), fetchFn });
    assert.equal(r.ok, true); assert.equal(r.videoId, 'vid-up');
    assert.deepEqual(seen, ['liveBroadcasts?active', 'liveBroadcasts?upcoming', 'videos?', 'liveChat/messages?']);
});

test('Twitch-only, comment reading off, no destination and demo skip the check without any request', async () => {
    for (const c of [{ ...live, streamTarget: 'twitch' }, { ...live, readComments: false }, { ...live, streamTarget: '' }, { ...live, mode: 'demo' }]) {
        const r = await probeYouTubeChat(c, { youtube, ledger: ledger(), fetchFn: api([]).fetchFn });
        assert.equal(r.ok, true); assert.equal(r.skipped, true); assert.deepEqual(r.log, []);
    }
});

function app(t, fetchFn, extra = {}) {
    const c = setup(t, { READ_COMMENTS: 'true' });
    Object.assign(c, { mode: 'live', allowStream: false, streamTarget: 'youtube', youtubeVideo: 'abcdefghijk', youtubeClient: 'client', youtubeSecret: 'secret', youtubeRefresh: 'refresh', memoryGuard: false, port: 0, ...extra });
    const obs = { ready: true, owned: false, close() {}, async connect() {}, async call(type) { if (type === 'GetStreamServiceSettings') return { streamServiceSettings: { key: 'obs-key' } }; return {}; }, async prepare() { return {}; }, async stopOwned() {} };
    const a = createApp(c, { obs, youtube: { token: async () => 'access', fetchFn, watch: async () => {} }, youtubeFetch: fetchFn, vts: { mouth() {}, close() {} } });
    t.after(() => a.close());
    return { c, a };
}
async function post(a, c, path, body) {
    await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${a.server.address().port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
}

test('HTTP: a show does not start while comments cannot be read; the 409 carries the log for the operator', async t => {
    const { c, a } = app(t, api([['/videos', googleError(403, 'accessNotConfigured')]]).fetchFn);
    const r = await post(a, c, '/api/control', { action: 'start' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'FORBIDDEN'); assert.equal(r.body.chat.ok, false);
    assert.ok(r.body.chat.log.some(x => !x.ok && /accessNotConfigured/.test(x.detail)));
    assert.equal(a.engine.running, false);
});

test('HTTP: the chat check endpoint answers with the same verdict', async t => {
    const { c, a } = app(t, api([['/videos', liveVideo], ['/liveChat/messages', reply(200, { items: [] })]]).fetchFn);
    const r = await post(a, c, '/api/youtube/chat-check', {});
    assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.liveChatId, 'chat-1');
});

test('HTTP: a reservation is bound to OBS\'s stream key and becomes the chat the Studio reads', async t => {
    const bodies = [];
    const fetchFn = async (url, o) => {
        if (url.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'schedule-access' });
        const u = new URL(url);
        if (u.pathname.endsWith('/liveStreams')) return reply(200, { items: [{ id: 'stream-1', snippet: { title: 'OBS' }, cdn: { ingestionInfo: { streamName: 'obs-key' } } }] });
        if (u.pathname.endsWith('/liveBroadcasts') && o.method === 'POST') { bodies.push(JSON.parse(o.body)); return reply(200, { id: 'newvideo123' }); }
        if (u.pathname.endsWith('/liveBroadcasts/bind')) { assert.equal(u.searchParams.get('streamId'), 'stream-1'); return reply(200, {}); }
        throw new Error(`unexpected ${url}`);
    };
    const { c, a } = app(t, fetchFn);
    writeFileSync(join(c.dataDir, 'youtube-schedule-oauth.json'), JSON.stringify({ refresh_token: 'refresh-schedule' }));
    const start = new Date(Date.now() + 3600000).toISOString();
    const r = await post(a, c, '/api/youtube/schedule', { title: 'ノアの夜ふかし相談室', description: '雑談', start, privacy: 'unlisted' });
    assert.equal(r.status, 200); assert.equal(r.body.id, 'newvideo123'); assert.equal(r.body.url, 'https://www.youtube.com/watch?v=newvideo123');
    assert.equal(bodies[0].status.privacyStatus, 'unlisted'); assert.equal(bodies[0].snippet.title, 'ノアの夜ふかし相談室');
    assert.equal(c.youtubeVideo, 'newvideo123', 'the new reservation is the chat the Studio reads');
});

test('HTTP: without the schedule authorization the operator is told how to grant it', async t => {
    const { c, a } = app(t, async () => { throw new Error('no request expected'); });
    const r = await post(a, c, '/api/youtube/schedule', { title: 'x', start: new Date(Date.now() + 3600000).toISOString() });
    assert.ok(r.status >= 400); assert.match(r.body.error, /youtube:auth -- --schedule/);
    assert.equal(c.youtubeVideo, 'abcdefghijk');
});
