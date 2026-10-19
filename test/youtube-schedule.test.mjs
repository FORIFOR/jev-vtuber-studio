import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleRequest, scheduleBroadcast, pickStream, accessToken } from '../src/youtube-schedule.mjs';

const NOW = Date.parse('2026-10-06T09:00:00Z');
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('the request is checked before anything reaches YouTube', () => {
    const r = scheduleRequest({ title: ' ノアの配信 ', start: '2026-10-06T19:00:00+09:00' }, NOW);
    assert.deepEqual(r, { title: 'ノアの配信', description: '', start: '2026-10-06T10:00:00.000Z', privacy: 'public' });
    assert.throws(() => scheduleRequest({ title: '', start: '2026-10-06T19:00:00+09:00' }, NOW), /タイトル/);
    assert.throws(() => scheduleRequest({ title: 'x'.repeat(101), start: '2026-10-06T19:00:00+09:00' }, NOW), /タイトル/);
    assert.throws(() => scheduleRequest({ title: 'a<b>', start: '2026-10-06T19:00:00+09:00' }, NOW), /タイトル/);
    assert.throws(() => scheduleRequest({ title: 't', start: 'tonight' }, NOW), /開始日時が読めません/);
    assert.throws(() => scheduleRequest({ title: 't', start: '2026-10-05T19:00:00+09:00' }, NOW), /過去/);
    assert.throws(() => scheduleRequest({ title: 't', start: '2026-10-06T19:00:00+09:00', privacy: 'friends' }, NOW), /公開範囲/);
});

test('the stream bound is the one carrying OBS\'s key, or the only one', () => {
    const a = { id: 'A', cdn: { ingestionInfo: { streamName: 'key-a' } } }, b = { id: 'B', cdn: { ingestionInfo: { streamName: 'key-b' } } };
    assert.equal(pickStream({ items: [a, b] }, 'key-b').id, 'B');
    assert.equal(pickStream({ items: [a] }).id, 'A', 'no OBS key known: the only stream');
    assert.throws(() => pickStream({ items: [a] }, 'other'), /直接送っていない/, 'OBS sends elsewhere (a relay): never bind');
    assert.throws(() => pickStream({ items: [a, b] }, 'other'), /直接送っていない/);
    assert.throws(() => pickStream({ items: [a, b] }), /一致するもの/);
    assert.throws(() => pickStream({ items: [] }), /ありません/);
});

test('insert then bind, with the scheduled time, privacy and auto start; the URL is returned', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
        if (url.includes('liveStreams')) return json(200, { items: [{ id: 'S1', snippet: { title: 'OBS' }, cdn: { ingestionInfo: { streamName: 'k' } } }] });
        if (url.includes('liveBroadcasts/bind')) return json(200, { id: 'B1' });
        return json(200, { id: 'B1' });
    };
    const req = scheduleRequest({ title: 'T', description: 'D', start: '2026-10-06T19:00:00+09:00', privacy: 'unlisted' }, NOW);
    const made = await scheduleBroadcast(req, { token: 'tok', streamKey: 'k', fetchFn });
    assert.deepEqual(made, { id: 'B1', url: 'https://www.youtube.com/watch?v=B1', streamTitle: 'OBS' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(c => c.auth === 'Bearer tok'));
    const insert = calls[1];
    assert.equal(insert.method, 'POST');
    assert.deepEqual(insert.body.snippet, { title: 'T', description: 'D', scheduledStartTime: '2026-10-06T10:00:00.000Z' });
    assert.equal(insert.body.status.privacyStatus, 'unlisted');
    assert.equal(insert.body.contentDetails.enableAutoStart, true);
    assert.match(calls[2].url, /liveBroadcasts\/bind\?id=B1&.*streamId=S1/);
});

test('API and token errors are reported without the token or response body', async () => {
    const fail = async () => json(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } });
    const req = scheduleRequest({ title: 'T', start: '2026-10-06T19:00:00+09:00' }, NOW);
    await assert.rejects(scheduleBroadcast(req, { token: 'secret-token', fetchFn: fail }), e => /HTTP 403 \(insufficientPermissions\)/.test(e.message) && !e.message.includes('secret-token'));
    await assert.rejects(accessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, async () => json(400, { error: 'invalid_grant' })), /invalid_grant/);
    await assert.rejects(accessToken({ clientId: 'c', clientSecret: 's', refreshToken: '' }), /--schedule/);
});
