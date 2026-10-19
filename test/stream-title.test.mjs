import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';
import { StreamTitler, streamTitle } from '../src/stream-title.mjs';

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
function live(t, env = {}) {
    const c = setup(t, { STREAM_TITLE: '1', STREAM_TARGET: 'simulcast', YOUTUBE_CHANNEL_ID: 'UCnoa', YOUTUBE_CLIENT_ID: 'cid', YOUTUBE_CLIENT_SECRET: 'sec', TWITCH_CHANNEL: 'hoshiai_noa', ...env });
    c.mode = 'live'; c.gameGoal = 'マグナ礼拝堂でレリックをさがす'; c.game = { title: 'Vampire Survivors' }; c.programme = { title: 'ノアの夜ふかしゲーム部' }; c.character.name = '星藍ノア';
    c.twitchTitleAuthFile = join(c.dataDir, 'twitch', 'title-oauth.json');
    writeFileSync(join(c.dataDir, 'youtube-schedule-oauth.json'), JSON.stringify({ refresh_token: 'r' }));
    mkdirSync(join(c.dataDir, 'twitch'), { recursive: true });
    writeFileSync(c.twitchTitleAuthFile, JSON.stringify({ access_token: 'a', refresh_token: 'b', client_id: 'tc' }));
    return c;
}
function fakeApis({ activeAfter = 1, twitchScopes = ['channel:manage:broadcast'] } = {}) {
    const calls = [];
    let polls = 0;
    const fetchFn = async (url, o = {}) => {
        const u = String(url); calls.push({ url: u, method: o.method || 'GET', body: o.body });
        if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'yt' });
        if (u.includes('/liveBroadcasts?')) return reply(200, { items: ++polls > activeAfter ? [{ id: 'vid1', snippet: { channelId: 'UCnoa' } }, { id: 'other', snippet: { channelId: 'UCelse' } }] : [] });
        if (u.includes('/videos?part=snippet&id=')) return reply(200, { items: [{ snippet: { title: '前のタイトル', description: '説明', categoryId: '20', tags: ['ノア'] } }] });
        if (u.includes('/videos?part=snippet') && o.method === 'PUT') return reply(200, {});
        if (u.endsWith('/oauth2/validate')) return reply(200, { client_id: 'tc', login: 'hoshiai_noa', user_id: '42', scopes: twitchScopes, expires_in: 9000 });
        if (u.startsWith('https://api.twitch.tv/helix/channels')) return reply(204, null);
        return reply(404, {});
    };
    return { calls, fetchFn };
}

test('stream title: game, goal, programme, a number and the host; a long goal gives way, the number never does', () => {
    const c = { game: { title: 'Vampire Survivors' }, gameGoal: 'マグナ礼拝堂でレリックをさがす', programme: { title: 'ノアの夜ふかしゲーム部' }, character: { name: '星藍ノア' } };
    assert.equal(streamTitle(c, 12), '【Vampire Survivors】マグナ礼拝堂でレリックをさがす｜ノアの夜ふかしゲーム部 #12【星藍ノア / AI VTuber】');
    assert.notEqual(streamTitle(c, 12), streamTitle(c, 13));
    const long = streamTitle({ ...c, gameGoal: 'あ'.repeat(200) }, 7);
    assert.ok(long.length <= 100); assert.match(long, /…｜ノアの夜ふかしゲーム部 #7【星藍ノア \/ AI VTuber】$/);
    assert.equal(streamTitle({ character: { name: 'ノア', channel: '相談室' } }, 1), '相談室 #1【ノア / AI VTuber】');
    assert.equal(streamTitle({ ...c, gameGoal: 'マグナ礼拝堂の30分ボスに挑む', streamTitleLabel: '最終回' }, 12), '【Vampire Survivors】最終回！マグナ礼拝堂の30分ボスに挑む｜ノアの夜ふかしゲーム部【星藍ノア / AI VTuber】', 'a label takes the number\'s place');
});

test('stream titler: waits for the relay broadcast, retitles YouTube (keeping its description) and Twitch, and numbers each broadcast', async t => {
    const c = live(t), { calls, fetchFn } = fakeApis({ activeAfter: 1 });
    const slept = [];
    const titler = new StreamTitler(c, { fetchFn, sleep: async ms => { slept.push(ms); }, holdMs: [] });
    const r = await titler.apply();
    assert.equal(r.status, 'done'); assert.equal(r.number, 1); assert.equal(r.youtube, 'done vid1'); assert.equal(r.twitch, 'done');
    assert.deepEqual(slept, [10000], 'polled again while the relay had not created its broadcast yet');
    const put = JSON.parse(calls.find(x => x.method === 'PUT').body);
    assert.deepEqual(put, { id: 'vid1', snippet: { title: r.title, description: '説明', categoryId: '20', tags: ['ノア'] } });
    const patch = calls.find(x => x.method === 'PATCH');
    assert.match(patch.url, /broadcaster_id=42$/); assert.equal(JSON.parse(patch.body).title, r.title);
    const second = await new StreamTitler(c, { fetchFn, sleep: async () => {} }).apply();
    assert.equal(second.number, 2); assert.notEqual(second.title, r.title);
    assert.equal(JSON.parse(readFileSync(join(c.dataDir, 'stream-title.json'), 'utf8')).number, 2);
});

test('stream titler: never throws; a missing Twitch permission or a wrong scope is partial, no broadcast is failed; off outside live', async t => {
    const c = live(t), { fetchFn } = fakeApis({ activeAfter: 0, twitchScopes: ['channel:manage:broadcast', 'user:read:chat'] });
    const r = await new StreamTitler(c, { fetchFn, sleep: async () => {} }).apply();
    assert.equal(r.status, 'partial'); assert.equal(r.youtube, 'done vid1'); assert.match(r.twitch, /^failed: .*権限/);
    let clock = 0;
    const none = await new StreamTitler(live(t), { fetchFn: fakeApis({ activeAfter: 99 }).fetchFn, findMs: 30000, now: () => clock, sleep: async ms => { clock += ms; } }).apply();
    assert.match(none.youtube, /^failed: 配信中の YouTube の枠が見つかりません/);
    const youtubeOnly = live(t, { STREAM_TARGET: 'youtube' }), seen = fakeApis({ activeAfter: 0 });
    assert.equal((await new StreamTitler(youtubeOnly, { fetchFn: seen.fetchFn }).apply()).twitch, 'skipped');
    assert.equal(seen.calls.some(x => x.url.includes('twitch')), false);
    const demo = live(t); demo.mode = 'demo';
    assert.equal((await new StreamTitler(demo, { fetchFn: async () => { throw Error('must not call'); } }).apply()).status, 'disabled');
});

test('stream titler: a Twitch title the relay puts back right after going live is restored (live 2026-10-11)', async t => {
    const c = live(t), { calls, fetchFn: base } = fakeApis({ activeAfter: 0 });
    let shown = '', reads = 0;
    const fetchFn = async (url, o = {}) => {
        const u = String(url);
        if (u.startsWith('https://api.twitch.tv/helix/channels') && (o.method || 'GET') === 'GET') {
            reads++; calls.push({ url: u, method: 'GET' });
            // The relay overwrites the title once, just after ours.
            return reply(200, { data: [{ title: reads === 1 ? '【AI VTuber】星藍ノア｜雑談とVampire Survivors挑戦' : shown }] });
        }
        if (u.startsWith('https://api.twitch.tv/helix/channels') && o.method === 'PATCH') shown = JSON.parse(o.body).title;
        return base(url, o);
    };
    const titler = new StreamTitler(c, { fetchFn, sleep: async () => {}, holdMs: [1, 1, 1] });
    const r = await titler.apply();
    await titler.hold;
    assert.equal(calls.filter(x => x.method === 'PATCH').length, 2, 'set once, restored once');
    assert.equal(shown, r.title); assert.equal(reads, 3); assert.equal(titler.state.twitchRestored, 1);
});
