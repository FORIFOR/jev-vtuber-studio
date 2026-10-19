import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { Ledger } from '../src/store.mjs';
import { YouTube } from '../src/youtube.mjs';
import { setup, response, engine, active } from './helpers.mjs';

const midnight = Date.parse('2026-10-01T00:00:00Z');
const message = (id, at = Date.now()) => ({ id, snippet: { type: 'textMessageEvent', publishedAt: new Date(at).toISOString(), displayMessage: id } });
function fixture(t, limit = 2, patch = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: midnight - 3000 });
    const c = setup(t);
    Object.assign(c, { mode: 'live', youtubeVideo: 'video', youtubeKey: 'test-key', ...patch });
    const ledger = new Ledger(c.dataDir, { youtube: limit });
    const controller = new AbortController();
    t.after(() => controller.abort());
    return { c, ledger, controller };
}
const tick = async (t, ms) => { t.mock.timers.tick(ms); await flush(); };

test('exhausted receiver waits locally, then renews the chat without replaying history or duplicates', async t => {
    const { c, ledger, controller } = fixture(t);
    const calls = [], streams = [], messages = [], statuses = [];
    const youtube = new YouTube(c, ledger, async url => {
        calls.push(url);
        return response({ items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-' + calls.length } }] });
    }, async function* (options) {
        streams.push(options);
        if (streams.length === 1) yield { nextPageToken: 'old-cursor', items: [message('seen')] };
        else {
            yield { items: [message('backlog', midnight - 1), message('seen'), message('new')] };
            yield { offlineAt: new Date().toISOString() };
        }
    });
    const watching = youtube.watch(m => messages.push(m.id), s => statuses.push(s), controller.signal);
    await flush();
    await tick(t, 1000);
    assert.equal(statuses.at(-1), 'budget_waiting');
    const saved = readFileSync(ledger.path, 'utf8');
    await tick(t, 1999);
    assert.equal(calls.length, 1);
    assert.equal(streams.length, 1);
    assert.equal(readFileSync(ledger.path, 'utf8'), saved);
    await tick(t, 1);
    await watching;
    assert.deepEqual(messages, ['seen', 'new']);
    assert.deepEqual(streams.map(s => [s.liveChatId, s.pageToken]), [['chat-1', ''], ['chat-2', '']]);
    assert.equal(statuses.filter(s => s === 'budget_waiting').length, 1);
    assert.equal(statuses.at(-1), 'ended');
    assert.deepEqual(ledger.snapshot(), { day: '2026-10-01', calls: { youtube: 2 }, limits: { youtube: 2 } });
});

test('an initially exhausted receiver makes no OAuth or API requests before the UTC reset', async t => {
    const { c, ledger, controller } = fixture(t, 2, { youtubeKey: '', youtubeClient: 'client', youtubeSecret: 'secret', youtubeRefresh: 'refresh' });
    ledger.reserve('youtube'); ledger.reserve('youtube');
    const calls = [], statuses = [];
    const youtube = new YouTube(c, ledger, async url => {
        calls.push(url);
        return response(url.includes('oauth2') ? { access_token: 'access' } : { items: [{ liveStreamingDetails: { actualEndTime: new Date().toISOString() } }] });
    });
    const watching = youtube.watch(() => assert.fail('ended broadcast cannot ingest'), s => statuses.push(s), controller.signal);
    await tick(t, 2999);
    assert.deepEqual(calls, []);
    assert.equal(ledger.snapshot().calls.youtube, 2);
    await tick(t, 1);
    await watching;
    assert.equal(calls.length, 2);
    assert.equal(statuses.at(-1), 'ended');
    assert.equal(ledger.snapshot().calls.youtube, 1);
});

test('stopping during quota wait cancels the timer and prevents next-day reconnection', async t => {
    const { c, ledger, controller } = fixture(t, 1);
    ledger.reserve('youtube');
    const youtube = new YouTube(c, ledger, () => assert.fail('network forbidden'));
    const statuses = [];
    const watching = youtube.watch(() => assert.fail('ingest forbidden'), s => statuses.push(s), controller.signal);
    assert.deepEqual(statuses, ['budget_waiting']);
    controller.abort(new Error('operator stop'));
    await watching;
    await tick(t, 86400000);
    assert.deepEqual(statuses, ['budget_waiting']);
    assert.equal(JSON.parse(readFileSync(ledger.path, 'utf8')).calls.youtube, 1);
});

test('a zero cap stays asleep across reset and synchronous stop is also safe', async t => {
    const { c, ledger, controller } = fixture(t, 0);
    let checks = 0;
    const snapshot = ledger.snapshot.bind(ledger);
    ledger.snapshot = () => { checks++; return snapshot(); };
    const youtube = new YouTube(c, ledger, () => assert.fail('network forbidden'));
    const statuses = [];
    const watching = youtube.watch(() => {}, s => statuses.push(s), controller.signal);
    await tick(t, 3000);
    await tick(t, 59999);
    assert.equal(checks, 2);
    await tick(t, 1);
    assert.equal(checks, 3);
    controller.abort();
    await watching;
    assert.deepEqual(statuses, ['budget_waiting']);
    const other = new AbortController();
    await youtube.watch(() => {}, () => other.abort(), other.signal);
});

test('simulcast rediscovers the current own broadcast after a quota pause', async t => {
    const { c, ledger, controller } = fixture(t, 3, { streamTarget: 'simulcast', youtubeChannel: 'own', youtubeClient: 'client', youtubeSecret: 'secret', youtubeRefresh: 'refresh' });
    let discovery = 0;
    const videos = [], streams = [];
    const youtube = new YouTube(c, ledger, async url => {
        if (url.includes('oauth2')) return response({ access_token: 'access' });
        if (url.includes('liveBroadcasts')) {
            discovery++;
            return response({ items: [{ id: 'other', snippet: { channelId: 'other-channel' } }, { id: 'own-' + discovery, snippet: { channelId: 'own' } }] });
        }
        const id = new URL(url).searchParams.get('id'); videos.push(id);
        return response({ items: [{ liveStreamingDetails: { activeLiveChatId: id + '-chat' } }] });
    }, async function* ({ liveChatId, pageToken }) {
        streams.push([liveChatId, pageToken]);
        if (streams.length === 1) yield { nextPageToken: 'old', items: [] };
        // An ended simulcast chat now means "find the next broadcast" (the relay may open a new one): end the test here.
        else { controller.abort(); yield { offlineAt: new Date().toISOString() }; }
    });
    const watching = youtube.watch(() => {}, () => {}, controller.signal);
    await flush(); await tick(t, 1000); await tick(t, 2000);
    await watching;
    assert.deepEqual(videos, ['own-1', 'own-2']);
    assert.deepEqual(streams, [['own-1-chat', ''], ['own-2-chat', '']]);
    assert.equal(ledger.snapshot().calls.youtube, 3);
});

test('polling transport also recovers after reset with a fresh chat cursor', async t => {
    const { c, ledger, controller } = fixture(t, 2, { youtubeTransport: 'poll' });
    t.mock.timers.setTime(midnight - 20000);
    const calls = [], statuses = [];
    const youtube = new YouTube(c, ledger, async url => {
        calls.push(url);
        if (url.includes('/videos?')) return response({ items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' } }] });
        if (calls.length === 2) return response({ nextPageToken: 'old', items: [], pollingIntervalMillis: 15000 });
        return response({ offlineAt: new Date().toISOString() });
    });
    const watching = youtube.watch(() => {}, s => statuses.push(s), controller.signal);
    await flush(); await tick(t, 15000);
    assert.equal(statuses.at(-1), 'budget_waiting');
    await tick(t, 5000); await watching;
    assert.equal(calls.length, 4);
    assert.equal(new URL(calls.at(-1)).searchParams.has('pageToken'), false);
    assert.equal(statuses.at(-1), 'ended');
});

test('a concurrent local reservation enters wait; a provider 403 is reported and retried only after a long pause', async t => {
    const { c, ledger, controller } = fixture(t, 1);
    const reserve = ledger.reserve.bind(ledger);
    let raced = false;
    ledger.reserve = kind => { if (!raced) { raced = true; reserve(kind); } reserve(kind); };
    const statuses = [];
    const youtube = new YouTube(c, ledger, () => assert.fail('network forbidden while exhausted'));
    const watching = youtube.watch(() => {}, s => statuses.push(s), controller.signal);
    await flush();
    assert.deepEqual(statuses, ['budget_waiting']);
    controller.abort(); await watching;
    t.mock.timers.setTime(midnight);
    let calls = 0;
    const roomy = new Ledger(setup(t).dataDir, { youtube: 100 });   // room left, so only the provider's 403 holds it back
    const denied = new YouTube({ ...c, youtubeQuotaRetryMs: 900000 }, roomy, async () => { calls++; return response({ error: { message: 'provider limit reached' } }, 403); });
    const deniedStatuses = [], stop = new AbortController();
    const deniedWatch = denied.watch(() => {}, s => deniedStatuses.push(s), stop.signal);
    await flush();
    assert.deepEqual(deniedStatuses, ['permission_or_quota_error']);
    const first = calls;
    t.mock.timers.tick(60000); await flush();
    assert.equal(calls, first, 'no retry within the pause');
    t.mock.timers.tick(900000); await flush();
    assert.ok(calls > first, 'looks again after the pause');
    stop.abort(); await deniedWatch;
});

test('engine stop clears the waiting UI and aborts its receiver worker', t => {
    const c = setup(t), e = active(engine(c));
    e.youtubeStatus = 'budget_waiting';
    e.stop();
    assert.equal(e.youtubeStatus, 'stopped');
    assert.equal(e.controller.signal.aborted, true);
});

test('a refused stream (gRPC 8) hands the chat to gentle polling at once, then tries the stream again after the pause', async t => {
    const { c, ledger, controller } = fixture(t, 100, { youtubeQuotaRetryMs: 600000 });
    const statuses = [], got = [], urls = [];
    let streams = 0;
    const youtube = new YouTube(c, ledger, async url => {
        urls.push(url);
        if (url.includes('/videos')) return response({ items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-1' } }] });
        return response({ items: [message('m' + urls.length, Date.now() + 1000)], pollingIntervalMillis: 1000, nextPageToken: 'p' });
    }, async function* () { streams++; throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { code: 8 }); yield null; });
    const watching = youtube.watch(m => got.push(m.text), s => statuses.push(s), controller.signal);
    await flush(); await flush(); await flush();
    assert.equal(streams, 1);
    assert.ok(statuses.includes('polling_degraded'), statuses.join());
    assert.ok(!statuses.includes('permission_or_quota_error'), 'no dark 15 minutes');
    assert.ok(urls.some(u => u.includes('liveChat/messages')), 'the REST list carries the chat');
    const polls = urls.filter(u => u.includes('liveChat/messages')).length;
    await tick(t, 5000);
    assert.equal(urls.filter(u => u.includes('liveChat/messages')).length, polls, 'polls at most every 10 s');
    for (let i = 0; i < 70; i++) await tick(t, 10000);
    assert.ok(streams >= 2, 'the stream is tried again after the pause');
    controller.abort(); await watching;
});

test('simulcast: when the relay ends its broadcast mid-show, the reader finds the new one instead of stopping (live 2026-10-11)', async t => {
    const { c, ledger, controller } = fixture(t, 100, { streamTarget: 'simulcast', youtubeChannel: 'UCnoa', youtubeVideo: 'stale-setting', youtubeRetryMs: 0, youtubeKey: '', youtubeClient: 'id', youtubeSecret: 'secret', youtubeRefresh: 'refresh' });
    const asked = [], statuses = [], messages = [], chats = [];
    let live = 'first';
    const youtube = new YouTube(c, ledger, async url => {
        const u = String(url); asked.push(u);
        if (u.includes('oauth2')) return response({ access_token: 'token', expires_in: 3600 });
        if (u.includes('/liveBroadcasts?')) return response({ items: [{ id: live, snippet: { channelId: 'UCnoa' } }] });
        return response({ items: [{ liveStreamingDetails: { activeLiveChatId: `chat-${live}` } }] });
    }, async function* (o) {
        chats.push(o.liveChatId);
        if (o.liveChatId === 'chat-first') { yield { items: [message('one')] }; live = 'second'; yield { offlineAt: new Date().toISOString() }; }
        else { yield { items: [message('two')] }; controller.abort(); }
    });
    const watching = youtube.watch(m => messages.push(m.id), s => statuses.push(s), controller.signal);
    for (let i = 0; i < 20 && !controller.signal.aborted; i++) await tick(t, 5000);
    await watching;
    assert.deepEqual(chats, ['chat-first', 'chat-second']);
    assert.deepEqual(messages, ['one', 'two']);
    assert.ok(statuses.includes('waiting_for_broadcast') && !statuses.includes('ended'));
    assert.equal(youtube.videoId, 'second', 'the broadcast actually read (not the stale setting) is what the Studio shows');
    assert.ok(!asked.some(u => u.includes('stale-setting')));
});
