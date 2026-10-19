import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { AvatarWardrobe } from '../src/avatar-wardrobe.mjs';
import { DEFAULT_OUTFIT_ID, OUTFITS } from '../public/avatar-outfits.mjs';

function workspace(t) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-wardrobe-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// These tests start the production app without dependency overrides. The show is never started.
async function listen(t, dataDir) {
    const c = config({ DATA_DIR: dataDir }, []);
    const app = createApp(c);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    t.after(close);
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = (path = '/api/avatar/wardrobe', { method = 'GET', token = c.adminToken, data, headers = {} } = {}) => fetch(base + path, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    return { ...app, c, base, request, close };
}

async function events(t, app) {
    const abort = new AbortController();
    const response = await fetch(`${app.base}/events`, {
        headers: { Authorization: `Bearer ${app.c.viewToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)])
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const close = async () => { abort.abort(); await reader.cancel().catch(() => {}); };
    t.after(close);
    return { close, async next(type) {
        for (;;) {
            const end = pending.indexOf('\n\n');
            if (end >= 0) {
                const frame = pending.slice(0, end); pending = pending.slice(end + 2);
                if (frame.startsWith('data: ')) {
                    const event = JSON.parse(frame.slice(6));
                    if (event.type === type) return event.data;
                }
                continue;
            }
            const part = await reader.read();
            assert.equal(part.done, false, 'SSE should remain open');
            pending += decoder.decode(part.value, { stream: true });
        }
    } };
}

test('wardrobe API retains existing authentication, origin and host restrictions', async t => {
    const app = await listen(t, workspace(t));
    const initial = { outfitId: DEFAULT_OUTFIT_ID, revision: 0 };
    assert.deepEqual(await (await app.request()).json(), initial);
    assert.deepEqual(await (await app.request(undefined, { token: app.c.viewToken })).json(), initial);
    const session = await (await app.request('/api/session')).json();
    assert.deepEqual(session.wardrobe, initial);
    assert.equal((await app.request(undefined, { token: '' })).status, 401);
    const selection = { outfitId: OUTFITS[1].id };
    for (const token of ['', app.c.viewToken])
        assert.equal((await app.request(undefined, { method: 'POST', token, data: selection })).status, 401);
    assert.equal((await app.request(undefined, { method: 'POST', data: selection, headers: { Origin: 'https://example.com' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
        get(`${app.base}/api/avatar/wardrobe`, { headers: { Host: 'example.com', Authorization: `Bearer ${app.c.adminToken}` } }, response => {
            response.resume(); response.on('end', () => resolve(response.statusCode));
        }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    for (const data of [null, [], {}, { outfitId: '../Noa.vrm' }, { outfitId: DEFAULT_OUTFIT_ID, revision: 9 }])
        assert.equal((await app.request(undefined, { method: 'POST', data })).status, 400);
    assert.deepEqual(await (await app.request()).json(), initial);
    assert.equal(app.engine.running, false);
    assert.equal(app.obs.owned, false);
    assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('saved wardrobe reaches every viewer and reconnect, survives restart, and skips redundant selections', async t => {
    const dir = workspace(t), app = await listen(t, dir);
    const first = await events(t, app), second = await events(t, app);
    const initial = { outfitId: DEFAULT_OUTFIT_ID, revision: 0 };
    assert.deepEqual(await first.next('wardrobe'), initial);
    assert.deepEqual(await second.next('wardrobe'), initial);
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'wardrobe') delivered.push(event.data); });
    for (const [index, outfit] of OUTFITS.slice(1).entries()) {
        const selected = { outfitId: outfit.id, revision: index + 1 };
        const response = await app.request(undefined, { method: 'POST', data: { outfitId: outfit.id } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), selected);
        assert.deepEqual(await first.next('wardrobe'), selected);
        assert.deepEqual(await second.next('wardrobe'), selected);
        const persisted = readFileSync(join(dir, 'avatar-wardrobe.json'), 'utf8');
        assert.deepEqual(JSON.parse(persisted), { version: 1, ...selected });
        assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { outfitId: outfit.id } })).json(), selected);
        assert.equal(readFileSync(join(dir, 'avatar-wardrobe.json'), 'utf8'), persisted);
        assert.equal(delivered.length, index + 1);
    }
    const expected = delivered.at(-1), reconnected = await events(t, app);
    assert.deepEqual(await reconnected.next('wardrobe'), expected);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'avatar-wardrobe.json')).mode & 0o777, 0o600);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    await first.close(); await second.close(); await reconnected.close(); await app.close();
    const restarted = await listen(t, dir);
    assert.deepEqual(await (await restarted.request()).json(), expected);
    assert.deepEqual((await (await restarted.request('/api/session')).json()).wardrobe, expected);
    assert.deepEqual(await (await events(t, restarted)).next('wardrobe'), expected);
    assert.equal(restarted.engine.running, false);
    assert.deepEqual(restarted.engine.ledger.snapshot().calls, {});
});

test('real filesystem save failure keeps the previous wardrobe and emits no selection event', async t => {
    const dir = workspace(t), app = await listen(t, dir), file = join(dir, 'avatar-wardrobe.json');
    const selected = { outfitId: OUTFITS[1].id, revision: 1 };
    assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { outfitId: selected.outfitId } })).json(), selected);
    renameSync(file, `${file}.preserved`);
    mkdirSync(file);
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'wardrobe') delivered.push(event.data); });
    const response = await app.request(undefined, { method: 'POST', data: { outfitId: OUTFITS[2].id } });
    assert.equal(response.status, 500);
    const error = await response.json();
    assert.match(error.error, /現在の衣装を維持/);
    assert.equal(JSON.stringify(error).includes(dir), false);
    assert.deepEqual(await (await app.request()).json(), selected);
    assert.deepEqual(delivered, []);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    rmSync(file, { recursive: true });
    renameSync(`${file}.preserved`, file);
    assert.deepEqual(new AvatarWardrobe(dir).snapshot(), selected);
});

test('damaged saved wardrobe is reported without overwriting it and can be explicitly repaired', t => {
    const dir = workspace(t), wardrobe = new AvatarWardrobe(dir), file = join(dir, 'avatar-wardrobe.json');
    wardrobe.select({ outfitId: OUTFITS[1].id });
    truncateSync(file, 8);
    const damaged = readFileSync(file, 'utf8'), loaded = new AvatarWardrobe(dir);
    assert.equal(loaded.snapshot().outfitId, DEFAULT_OUTFIT_ID);
    assert.match(loaded.snapshot().warning, /保存済みの衣装を読み込めませんでした/);
    assert.equal(readFileSync(file, 'utf8'), damaged);
    const snapshot = loaded.snapshot(); snapshot.outfitId = OUTFITS[2].id;
    assert.equal(loaded.snapshot().outfitId, DEFAULT_OUTFIT_ID);
    assert.equal(loaded.select({ outfitId: DEFAULT_OUTFIT_ID }), true);
    assert.deepEqual(new AvatarWardrobe(dir).snapshot(), { outfitId: DEFAULT_OUTFIT_ID, revision: 1 });
});
