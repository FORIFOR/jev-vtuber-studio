import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { get } from 'node:http';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { Sponsor, SponsorValidationError, SponsorConflictError, DEFAULT_SPONSOR, SPONSOR_IMAGE_LIMIT, validateSponsorImage } from '../src/sponsor.mjs';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwC1RRRX1J8qf//Z', 'base64');
const WEBP = Buffer.from('UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoCAAMAAUAmJaACdLoB+AAF9AAA/si//84ljqd3Qf/87BsS7XrAAA==', 'base64');
function chunk(type, data) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
}
function png({ width = 2, height = 3, color = 80, extra = [], raw } = {}) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const pixels = raw || Buffer.alloc((width * 4 + 1) * height, color);
    if (!raw) for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const upload = (bytes = png(), mime = 'image/png') => ({ mime, base64: bytes.toString('base64') });
const form = (changes = {}) => {
    const { image, ...settings } = DEFAULT_SPONSOR;
    return { ...settings, ...changes };
};
function workspace(t) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-sponsor-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
async function listen(t, dir) {
    const c = config({ DATA_DIR: dir }, []), app = createApp(c);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    t.after(close);
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = (path = '/api/sponsor', { method = 'GET', token = c.adminToken, data, headers = {} } = {}) => fetch(base + path, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    const save = data => request(undefined, { method: 'POST', data });
    return { ...app, c, base, request, save, close };
}
async function events(t, app) {
    const abort = new AbortController();
    const response = await fetch(`${app.base}/events`, { headers: { Authorization: `Bearer ${app.c.viewToken}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const close = async () => { abort.abort(); await reader.cancel().catch(() => {}); };
    t.after(close);
    return { close, async next() {
        for (;;) {
            const end = pending.indexOf('\n\n');
            if (end >= 0) {
                const frame = pending.slice(0, end); pending = pending.slice(end + 2);
                if (frame.startsWith('data: ')) { const event = JSON.parse(frame.slice(6)); if (event.type === 'sponsor') return event.data; }
            } else {
                const part = await reader.read(); assert.equal(part.done, false);
                pending += decoder.decode(part.value, { stream: true });
            }
        }
    } };
}

test('sponsor image inspection accepts static formats and rejects disguise, corruption, animation and unsafe dimensions', () => {
    for (const [mime, bytes] of [['image/png', png()], ['image/jpeg', JPEG], ['image/webp', WEBP]]) {
        const result = validateSponsorImage(mime, bytes);
        assert.equal(result.mime, mime); assert.equal(result.width, 2); assert.equal(result.height, 3); assert.match(result.id, /^[a-f0-9]{64}$/);
        assert.throws(() => validateSponsorImage(mime, bytes.subarray(0, -3)), SponsorValidationError);
    }
    const badPng = png(); badPng[45] ^= 1;
    const tallJpeg = Buffer.from(JPEG), sof = tallJpeg.indexOf(Buffer.from('ffc00011', 'hex')); tallJpeg.writeUInt16BE(4097, sof + 5);
    const wideWebp = Buffer.from(WEBP); wideWebp.writeUInt16LE(4097, 26);
    const animate = Buffer.alloc(18); animate.write('VP8X'); animate.writeUInt32LE(10, 4); animate[8] = 2; animate[12] = 1; animate[15] = 2;
    const animatedWebp = Buffer.concat([WEBP.subarray(0, 12), animate, WEBP.subarray(12)]); animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4);
    for (const [mime, bytes] of [
        ['image/svg+xml', Buffer.from('<svg></svg>')], ['image/gif', Buffer.from('GIF89a')], ['image/png', JPEG], ['image/jpeg', png()],
        ['image/png', badPng], ['image/png', png({ extra: [chunk('acTL', Buffer.alloc(8))] })], ['image/webp', animatedWebp],
        ['image/png', png({ width: 4097, height: 1 })], ['image/png', png({ width: 4096, height: 2000 })], ['image/jpeg', tallJpeg], ['image/webp', wideWebp],
        ['image/png', png({ raw: Buffer.alloc(1) })], ['image/png', Buffer.alloc(SPONSOR_IMAGE_LIMIT + 1)], ['image/jpeg', Buffer.concat([JPEG, JPEG])],
        ['image/jpeg', Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex')],
        ['image/webp', Buffer.from('5249464612000000574542505650384c060000002f0000000000', 'hex')]
    ]) assert.throws(() => validateSponsorImage(mime, bytes), SponsorValidationError);
});

test('operator-only sponsor writes and authenticated reads preserve host and origin boundaries', async t => {
    const dir = workspace(t), app = await listen(t, dir);
    assert.deepEqual(await (await app.request()).json(), DEFAULT_SPONSOR);
    assert.deepEqual(await (await app.request(undefined, { token: app.c.viewToken })).json(), DEFAULT_SPONSOR);
    assert.deepEqual((await (await app.request('/api/session')).json()).sponsor, DEFAULT_SPONSOR);
    assert.equal(readdirSync(dir).includes('sponsor.json'), false);
    assert.equal((await app.request(undefined, { token: '' })).status, 401);
    for (const token of ['', app.c.viewToken]) assert.equal((await app.request(undefined, { method: 'POST', token, data: form({ enabled: true }) })).status, 401);
    assert.equal((await app.request(undefined, { method: 'POST', data: form(), headers: { Origin: 'https://example.com' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
        get(`${app.base}/api/sponsor`, { headers: { Host: 'example.com', Authorization: `Bearer ${app.c.adminToken}` } }, response => {
            response.resume(); response.on('end', () => resolve(response.statusCode));
        }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    for (const data of [null, [], {}, { enabled: true }, form({ revision: undefined }), form({ revision: -1 }), form({ revision: '0' }),
        form({ enabled: 'true' }), form({ mode: 'advertiser' }), form({ title: 'x'.repeat(61) }), form({ message: 'x'.repeat(121) }),
        form({ title: '<b>Ad</b>' }), form({ message: 'x\ntext' }), form({ title: '\u202eAd' }), form({ title: '\ud800' }),
        form({ link: 'http://example.com' }), form({ link: 'javascript:alert(1)' }), form({ link: 'https://user:secret@example.com' }),
        form({ link: 'https://example.com/' + 'a'.repeat(240) }), form({ imageURL: 'https://example.com/tracker.png' }),
        form({ mode: 'sponsor', title: '', message: 'Example' }), form({ mode: 'sponsor', title: 'Example', message: '' }),
        form({ imageData: { mime: 'image/png', base64: '%%%%' } })]) {
        assert.equal((await app.save(data)).status, 400, JSON.stringify(data));
    }
    assert.deepEqual(await (await app.request()).json(), DEFAULT_SPONSOR);
    assert.equal(app.engine.running, false); assert.equal(app.obs.owned, false); assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('sponsor saves fan out over SSE, preserve/remove private images, and survive a full app restart', async t => {
    const dir = workspace(t), app = await listen(t, dir), first = await events(t, app), second = await events(t, app);
    assert.deepEqual(await first.next(), DEFAULT_SPONSOR); assert.deepEqual(await second.next(), DEFAULT_SPONSOR);
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'sponsor') delivered.push(event.data); });
    const response = await app.save(form({ enabled: true, mode: 'sponsor', title: '  Sample Company  ', message: '', imageData: upload() }));
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.revision, 1); assert.equal(saved.title, 'Sample Company'); assert.equal(saved.image.mime, 'image/png');
    assert.deepEqual(await first.next(), saved); assert.deepEqual(await second.next(), saved);
    for (const token of [app.c.adminToken, app.c.viewToken]) {
        const image = await app.request(saved.image.url, { token });
        assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
    }
    assert.equal((await app.request(saved.image.url, { token: '' })).status, 401);
    assert.equal((await app.request(`${saved.image.url}?token=${app.c.viewToken}`, { token: '' })).status, 401);
    assert.equal((await app.request('/api/sponsor/image/not-a-hash')).status, 404);
    assert.equal((await app.request('/api/sponsor/image/' + '0'.repeat(64))).status, 404);
    const file = join(dir, 'sponsor.json'), persisted = readFileSync(file, 'utf8');
    assert.equal(persisted.includes('base64'), false); assert.equal(persisted.includes('/api/'), false);
    if (process.platform !== 'win32') {
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.equal(statSync(join(dir, 'sponsor-images', saved.image.id)).mode & 0o777, 0o600);
    }
    const update = form({ revision: 1, enabled: true, mode: 'sponsor', title: saved.title, message: '', link: 'https://example.com/contact' });
    const edited = await (await app.save(update)).json();
    assert.deepEqual(edited.image, saved.image); assert.equal(edited.revision, 2);
    assert.deepEqual(await first.next(), edited); assert.deepEqual(await second.next(), edited);
    assert.deepEqual(await (await app.save({ ...update, revision: 2 })).json(), edited);
    assert.equal(delivered.length, 2, 'Redundant updates do not increment or broadcast');
    const reconnected = await events(t, app); assert.deepEqual(await reconnected.next(), edited);
    await first.close(); await second.close(); await reconnected.close(); await app.close();
    const restarted = await listen(t, dir);
    assert.deepEqual(await (await restarted.request()).json(), edited);
    assert.deepEqual(await (await events(t, restarted)).next(), edited);
    const removed = await (await restarted.save(form({ revision: 2, imageData: null }))).json();
    assert.equal(removed.image, null); assert.equal(removed.revision, 3); assert.equal(removed.enabled, false);
    assert.deepEqual(new Sponsor(dir).snapshot(), removed);
    assert.equal(restarted.engine.running, false); assert.deepEqual(restarted.engine.ledger.snapshot().calls, {});
});

test('revision conflicts prevent two operator tabs from overwriting each other', async t => {
    const app = await listen(t, workspace(t));
    const results = await Promise.all([app.save(form({ title: 'First tab' })), app.save(form({ title: 'Second tab' }))]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const current = await (await app.request()).json(), conflict = await results.find(result => result.status === 409).json();
    assert.equal(current.revision, 1); assert.deepEqual(conflict.current, current);
    assert.equal((await app.save(form({ title: current.title }))).status, 409, 'Even an old no-op must reload before saving');
    const epoch = app.engine.epoch;
    app.engine.running = true; // Simulate the guard state without starting a show or contacting a provider.
    try {
        const saved = await app.save(form({ revision: 1, enabled: true }));
        assert.equal(saved.status, 200); assert.equal(app.engine.running, true); assert.equal(app.engine.epoch, epoch);
    } finally { app.engine.running = false; }
    assert.equal(app.obs.owned, false); assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('upload body allowance is local to sponsor and rejects decoded or encoded oversize images', async t => {
    const app = await listen(t, workspace(t));
    const largeValid = png({ extra: [chunk('tEXt', Buffer.alloc(18000, 65))] });
    assert.ok(largeValid.length > 16000);
    const response = await app.save(form({ imageData: upload(largeValid) })); assert.equal(response.status, 200);
    const before = await response.json();
    assert.equal((await app.save(form({ revision: 1, imageData: upload(Buffer.alloc(SPONSOR_IMAGE_LIMIT + 1)) }))).status, 400);
    assert.equal((await app.save(form({ revision: 1, imageData: { mime: 'image/png', base64: 'A'.repeat(3 * 1024 * 1024) } }))).status, 413);
    assert.equal((await app.request('/api/avatar/wardrobe', { method: 'POST', data: { outfitId: 'x'.repeat(17000) } })).status, 400);
    assert.deepEqual(await (await app.request()).json(), before);
});

test('failed atomic settings and image saves keep the prior snapshot and produce no event or leaked paths', async t => {
    const dir = workspace(t), app = await listen(t, dir), file = join(dir, 'sponsor.json');
    const saved = await (await app.save(form({ enabled: true, imageData: upload() }))).json();
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'sponsor') delivered.push(event.data); });
    renameSync(file, `${file}.preserved`); mkdirSync(file);
    const response = await app.save(form({ revision: 1, imageData: upload(png({ color: 20 })) }));
    assert.equal(response.status, 500);
    const failure = await response.json(); assert.match(failure.error, /現在の表示を維持/); assert.equal(JSON.stringify(failure).includes(dir), false);
    assert.deepEqual(await (await app.request()).json(), saved); assert.deepEqual(delivered, []);
    assert.deepEqual(readdirSync(join(dir, 'sponsor-images')), [saved.image.id]);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    assert.equal((await app.request(saved.image.url)).status, 200);
    rmSync(file, { recursive: true }); renameSync(`${file}.preserved`, file);
    assert.deepEqual(new Sponsor(dir).snapshot(), saved);
    const imageDir = join(dir, 'sponsor-images'); renameSync(imageDir, `${imageDir}.preserved`); writeFileSync(imageDir, 'blocked');
    assert.equal((await app.save(form({ revision: 1, imageData: upload(png({ color: 20 })) }))).status, 500);
    assert.deepEqual(await (await app.request()).json(), saved); assert.deepEqual(delivered, []);
    rmSync(imageDir); renameSync(`${imageDir}.preserved`, imageDir);
    assert.deepEqual(new Sponsor(dir).snapshot(), saved);
});

test('immutable assets, copied snapshots, bounded cleanup and damaged saved state remain safe', t => {
    const dir = workspace(t), store = new Sponsor(dir);
    const initial = store.snapshot(); initial.title = 'Mutated'; assert.deepEqual(store.snapshot(), DEFAULT_SPONSOR);
    const ids = [];
    for (let index = 0; index < 14; index++) {
        store.update(form({ revision: index, imageData: upload(png({ color: index })) })); ids.push(store.snapshot().image.id);
    }
    assert.equal(readdirSync(join(dir, 'sponsor-images')).length, 9);
    assert.ok(store.image(ids.at(-1))); assert.ok(store.image(ids.at(-2))); assert.equal(store.image(ids[0]), null);
    const snapshot = store.snapshot(); snapshot.image.id = 'mutated'; assert.equal(store.snapshot().image.id, ids.at(-1));
    assert.throws(() => store.update(form({ revision: 0 })), SponsorConflictError);
    const imageFile = join(dir, 'sponsor-images', ids.at(-1)); writeFileSync(imageFile, 'corrupt');
    assert.equal(store.image(ids.at(-1)), null);
    const persisted = readFileSync(join(dir, 'sponsor.json'), 'utf8'), recovered = new Sponsor(dir);
    assert.deepEqual(recovered.snapshot(), DEFAULT_SPONSOR);
    assert.equal(readFileSync(join(dir, 'sponsor.json'), 'utf8'), persisted, 'Startup never overwrites damaged operator settings');
    recovered.update(form()); assert.equal(recovered.snapshot().revision, 1);
    assert.deepEqual(new Sponsor(dir).snapshot(), recovered.snapshot());
});
