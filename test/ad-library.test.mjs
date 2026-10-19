import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { AdLibrary, sniffVideo, rasterisePdf } from '../src/ad-library.mjs';
import { SponsorValidationError, SponsorConflictError } from '../src/sponsor.mjs';
import { activeAds, adSnapshot, AdRotation } from '../public/sponsor-view.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

// A 1x1 PNG, enough for the sponsor image parser.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
const id = n => `ad-${String(n).padStart(8, '0')}`;

test('ad library: media is content-addressed and sniffed; a PDF becomes an image through the local rasteriser; mismatches are refused', t => {
    const c = setup(t), lib = new AdLibrary(c.dataDir, { rasterise: bytes => bytes.toString('latin1', 0, 5) === '%PDF-' ? PNG : null });
    const img = lib.addMedia('image/png', PNG, 'logo.png'); assert.equal(img.kind, 'image'); assert.equal(img.width, 1); assert.match(img.url, /^\/api\/sponsor\/image\/[a-f0-9]{64}$/);
    const vid = lib.addMedia('video/mp4', MP4, 'cm.mp4'); assert.equal(vid.kind, 'video'); assert.equal(vid.mime, 'video/mp4');
    assert.equal(lib.addMedia('video/webm', WEBM).mime, 'video/webm');
    const pdf = lib.addMedia('application/pdf', Buffer.from('%PDF-1.4 fake'), 'flyer.pdf'); assert.equal(pdf.kind, 'image'); assert.equal(pdf.fromPdf, true);
    assert.throws(() => lib.addMedia('video/webm', MP4), SponsorValidationError, 'declared type must match the bytes');
    assert.throws(() => lib.addMedia('application/pdf', Buffer.from('not a pdf')), /PDF として読めません/);
    assert.throws(() => lib.addMedia('image/gif', PNG), /PNG \/ JPEG \/ WebP/);
    assert.throws(() => lib.addMedia('video/mp4', Buffer.alloc(0)), /空/);
    assert.equal(sniffVideo(MP4), 'video/mp4'); assert.equal(sniffVideo(PNG), null);
    assert.equal(readdirSync(join(c.dataDir, 'ad-media')).length, 3, 'one file per distinct content (the rasterised PDF equals the PNG here)');
    assert.equal(rasterisePdf(Buffer.from('%PDF-'), { platform: 'linux' }), null, 'no rasteriser outside macOS');
});

test('ad library: the list is validated whole, saved atomically with a revision, reloaded, and conflicts are refused', t => {
    const c = setup(t), lib = new AdLibrary(c.dataDir);
    const img = lib.addMedia('image/png', PNG), vid = lib.addMedia('video/mp4', MP4);
    assert.throws(() => lib.update({ revision: 0, ads: [{ id: 'x', enabled: true, title: 'a', media: null }] }), /id が重複または不正/);
    assert.throws(() => lib.update({ revision: 0, ads: [{ id: id(1), enabled: true, title: '', media: null }] }), /画像・動画か見出し/);
    assert.throws(() => lib.update({ revision: 0, ads: [{ id: id(1), enabled: true, title: 'a', media: { id: 'f'.repeat(64) } }] }), /見つかりません/);
    assert.throws(() => lib.update({ revision: 0, ads: [{ id: id(1), enabled: true, title: 'a', seconds: 5 }] }), /表示秒数/);
    assert.throws(() => lib.update({ revision: 0, ads: [{ id: id(1), enabled: true, title: 'a', link: 'http://x' }] }), /HTTPS/);
    assert.equal(lib.update({ revision: 0, ads: [{ id: id(1), enabled: true, title: 'A社', media: { id: img.id }, seconds: 30, sound: true }, { id: id(2), enabled: false, title: '', media: { id: vid.id }, sound: true }] }), true);
    const s = lib.snapshot(); assert.equal(s.revision, 1); assert.equal(s.ads[0].sound, false, 'sound is a video property'); assert.equal(s.ads[1].sound, true); assert.equal(s.ads[0].media.kind, 'image'); assert.equal(s.ads[1].media.url, `/api/sponsor/image/${vid.id}`);
    assert.throws(() => lib.update({ revision: 0, ads: [] }), SponsorConflictError);
    assert.equal(lib.update({ revision: 1, ads: s.ads.map(a => ({ ...a, media: a.media ? { id: a.media.id } : null })) }), false, 'no change, no revision');
    const again = new AdLibrary(c.dataDir); assert.equal(again.snapshot().revision, 1); assert.equal(again.snapshot().ads.length, 2); assert.equal(again.damaged, false);
    assert.equal(lib.file(vid.id).mime, 'video/mp4'); assert.equal(lib.file('zz'), null);
    // Unreferenced media older than an hour goes away on the next save; referenced media stays.
    const orphan = lib.addMedia('video/webm', WEBM).id, past = new Date(Date.now() - 2 * 3600000);
    utimesSync(join(c.dataDir, 'ad-media', orphan), past, past);
    lib.update({ revision: 1, ads: [{ id: id(1), enabled: true, title: 'A社', media: { id: img.id } }] });
    assert.ok(!existsSync(join(c.dataDir, 'ad-media', orphan))); assert.ok(existsSync(join(c.dataDir, 'ad-media', img.id)));
    writeFileSync(join(c.dataDir, 'ads.json'), '{broken'); assert.equal(new AdLibrary(c.dataDir).damaged, true);
});

test('rotation: nothing without the master switch; enabled ads take turns for their seconds; none enabled shows the card itself', () => {
    const sponsor = { revision: 3, enabled: true, mode: 'recruitment', title: '広告募集中', message: 'm', link: '', image: null };
    const ads = { revision: 2, ads: [{ id: id(1), enabled: true, title: 'A', seconds: 30, media: { kind: 'image', id: 'a'.repeat(64), mime: 'image/png', url: '/api/sponsor/image/' + 'a'.repeat(64) } }, { id: id(2), enabled: false, title: 'B' }, { id: id(3), enabled: true, title: '', seconds: 10, sound: true, media: { kind: 'video', id: 'b'.repeat(64), mime: 'video/mp4', url: '/api/sponsor/image/' + 'b'.repeat(64) } }] };
    assert.equal(activeAds({ ...sponsor, enabled: false }, ads).length, 0); assert.deepEqual(activeAds(sponsor, ads).map(a => a.id), [id(1), id(3)]);
    const snap = adSnapshot(ads.ads[2], 7); assert.equal(snap.mode, 'sponsor'); assert.equal(snap.video.sound, true); assert.equal(snap.image, null);
    const rendered = [], timers = []; let now = 0;
    const view = { render: (s, o) => rendered.push({ title: s.title, video: !!s.video, hidden: !s.enabled, authoritative: o.authoritative }) };
    const r = new AdRotation(view, { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, now: () => now });
    r.receiveAds(ads, true); assert.equal(rendered.length, 0, 'nothing until the sponsor slot is known');
    r.receiveSponsor(sponsor, true); assert.equal(rendered.at(-1).title, 'A'); assert.equal(timers.at(-1).ms, 30000);
    timers.at(-1).fn(); assert.equal(rendered.at(-1).video, true); assert.equal(timers.at(-1).ms, 10000, 'the video ad\'s own seconds');
    timers.at(-1).fn(); assert.equal(rendered.at(-1).title, 'A', 'wraps around');
    r.receiveAds({ revision: 3, ads: ads.ads.map(a => ({ ...a, enabled: a.id === id(3) })) }); assert.equal(rendered.at(-1).video, true); assert.equal(rendered.at(-1).authoritative, true);
    r.receiveAds({ revision: 4, ads: [] }); assert.equal(rendered.at(-1).title, '広告募集中', 'no enabled ad: the recruitment card');
    r.receiveSponsor({ ...sponsor, revision: 4, enabled: false }); assert.equal(rendered.at(-1).hidden, true, 'master off hides the slot');
    r.receiveAds({ revision: 1, ads: ads.ads }); assert.equal(rendered.at(-1).hidden, true, 'an older list is ignored');
});

test('HTTP: upload, list, save, fan out and serve ads; view token reads, admin writes; the stage sees the event', async t => {
    const c = setup(t); c.port = 0;
    const a = createApp(c, { obs: { ready: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() {} }, ads: new AdLibrary(c.dataDir, { rasterise: () => PNG }) });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r)); let closed = false; const close = async () => { if (closed) return; closed = true; a.engine.stop('test'); await a.close(); }; t.after(close);
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const req = (path, { method = 'GET', body, token = c.adminToken, headers = {} } = {}) => fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
    const json = (path, data, token) => req(path, { method: 'POST', body: JSON.stringify(data), token, headers: { 'Content-Type': 'application/json' } });
    assert.equal((await req('/api/ads', { token: 'nope' })).status, 401);
    assert.deepEqual(await (await req('/api/ads', { token: c.viewToken })).json(), { revision: 0, ads: [] });
    assert.equal((await req('/api/ads/media', { method: 'POST', body: PNG, token: c.viewToken, headers: { 'Content-Type': 'image/png' } })).status, 401);
    assert.equal((await req('/api/ads/media', { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/gif' } })).status, 415);
    const up = await (await req('/api/ads/media', { method: 'POST', body: PNG, headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('ロゴ.png') } })).json();
    assert.equal(up.media.kind, 'image'); assert.equal(up.media.name, 'ロゴ.png');
    const pdf = await (await req('/api/ads/media', { method: 'POST', body: Buffer.from('%PDF-1.7 x'), headers: { 'Content-Type': 'application/pdf' } })).json(); assert.equal(pdf.media.fromPdf, true);
    const vid = await (await req('/api/ads/media', { method: 'POST', body: MP4, headers: { 'Content-Type': 'video/mp4' } })).json(); assert.equal(vid.media.kind, 'video');
    const events = []; a.engine.on('event', e => { if (e.type === 'ads') events.push(e.data); });
    const bad = await json('/api/ads', { revision: 0, ads: [{ id: id(1), enabled: true, title: '', media: null }] }); assert.equal(bad.status, 400);
    const ok = await json('/api/ads', { revision: 0, ads: [{ id: id(1), enabled: true, title: 'A社', media: { id: up.media.id } }, { id: id(2), enabled: true, title: '', media: { id: vid.media.id }, sound: true }] });
    assert.equal(ok.status, 200); const body = await ok.json(); assert.equal(body.revision, 1); assert.equal(events.length, 1); assert.equal(events[0].ads[1].media.kind, 'video');
    assert.equal((await json('/api/ads', { revision: 0, ads: [] })).status, 409);
    assert.equal((await json('/api/ads', { revision: 1, ads: [] }, c.viewToken)).status, 401);
    const served = await req(`/api/sponsor/image/${vid.media.id}`, { token: c.viewToken }); assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'video/mp4');
    assert.equal((await req(`/api/sponsor/image/${up.media.id}`, { token: c.viewToken })).headers.get('content-type'), 'image/png');
    assert.equal((await req(`/api/sponsor/image/${vid.media.id}?token=${c.viewToken}`, { token: 'x' })).status, 401, 'no credentials in media URLs');
    const session = await (await req('/api/session')).json(); assert.equal(session.ads.revision, 1);
    const sse = await fetch(url + '/events?token=' + c.viewToken); const reader = sse.body.getReader(); let text = '';
    while (!text.includes('"type":"ads"')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    assert.match(text, /"type":"ads"/); await reader.cancel().catch(() => {});
    await close();
});
