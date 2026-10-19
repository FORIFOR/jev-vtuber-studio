import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { Twitch, chatMessage, reconnectURL } from '../src/twitch.mjs';
import { setup, engine, active, response } from './helpers.mjs';
const packet = (time = Date.now()) => ({ metadata: { message_type: 'notification', message_timestamp: new Date(time).toISOString() }, payload: { subscription: { type: 'channel.chat.message' }, event: { broadcaster_user_id: '1', chatter_user_id: '2', message_id: 'm1', message: { text: 'こんにちは' } } } });
test('Twitch drops stale, duplicate, wrong-channel and oversized events', () => {
    const now = Date.now(), seen = new Set();
    assert.equal(chatMessage(packet(now - 1), '1', now, seen, now), null);
    assert.equal(chatMessage(packet(now), 'wrong', now, seen, now), null);
    const chat = chatMessage(packet(now), '1', now, seen, now);
    assert.equal(chat.source, 'twitch'); assert.notEqual(chat.author, '2');
    assert.equal(chatMessage(packet(now), '1', now, seen, now), null);
    const big = packet(now); big.payload.event.message.text = 'a'.repeat(501);
    assert.equal(chatMessage(big, '1', now, new Set(), now), null);
});
test('Twitch source retains normal privacy and command-injection gates', t => {
    const e = active(engine(setup(t)));
    assert.equal(e.ingest({ source: 'twitch', author: 'a', text: 'こんにちは' }).accepted, true);
    assert.equal(e.intake[0].source, 'twitch');
    assert.equal(e.ingest({ source: 'twitch', author: 'b', text: 'test@example.com' }).reason, 'local_gate'); e.stop();
});
test('reconnect URLs are restricted to Twitch websocket host', () => {
    assert.equal(reconnectURL('wss://eventsub.wss.twitch.tv/ws?x=1'), 'wss://eventsub.wss.twitch.tv/ws?x=1');
    for (const u of ['https://eventsub.wss.twitch.tv/ws','wss://evil.example/ws','wss://user@eventsub.wss.twitch.tv/ws']) assert.throws(() => reconnectURL(u));
});
test('demo and disabled modes make no Twitch requests', async t => {
    const c = setup(t); const a = new Twitch(c, { fetchFn: () => { throw Error('network'); } });
    await a.watch(() => {}, () => {}, new AbortController().signal);
    c.twitchEnabled = true; await a.watch(() => {}, () => {}, new AbortController().signal);
});
test('refresh rotation saves new private token and validates intended identity', async t => {
    const c = setup(t); c.twitchAuthFile = `${c.dataDir}/oauth.json`; c.twitchChannel = 'hoshiai_noa';
    writeFileSync(c.twitchAuthFile, JSON.stringify({ client_id: 'client', access_token: 'old', refresh_token: 'old-refresh' }));
    let n = 0;
    const a = new Twitch(c, { fetchFn: async () => {
        n++; if (n === 1) return response({}, 401);
        if (n === 2) return response({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 14400 });
        return response({ client_id: 'client', login: 'hoshiai_noa', user_id: '1', scopes: ['user:read:chat'], expires_in: 14400 });
    } });
    assert.equal((await a.credentials()).user_id, '1');
    assert.equal(JSON.parse(readFileSync(c.twitchAuthFile)).refresh_token, 'new-refresh');
    assert.equal(statSync(c.twitchAuthFile).mode & 0o777, 0o600);
});
test('socket subscribes to own chat and abort closes connection', async t => {
    const c = setup(t); let socket, body;
    class WS extends EventTarget { constructor() { super(); socket = this; } close() { this.closed = true; } sendPacket(p) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(p) })); } }
    const a = new Twitch(c, { WebSocketImpl: WS, fetchFn: async (_, o) => { body = JSON.parse(o.body); return response({ data: [] }); } });
    const ctl = new AbortController();
    const work = a.session({ access_token: 'secret', client_id: 'client', user_id: '1', expires_in: 3600 }, () => {}, s => { if (s === 'connected') ctl.abort(); }, ctl.signal, new Set(), Date.now());
    socket.sendPacket({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'session', keepalive_timeout_seconds: 10 } } });
    await work; assert.equal(socket.closed, true); assert.deepEqual(body.condition, { broadcaster_user_id: '1', user_id: '1' });
    assert.equal(body.type, 'channel.chat.message');
});
