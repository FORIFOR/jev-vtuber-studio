import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import { config } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';
import { AvatarMode } from '../src/avatar-mode.mjs';
import { AVATAR_MODES, DEFAULT_AVATAR_MODE, isAvatarMode } from '../public/avatar-modes.mjs';
import { OUTFITS } from '../public/avatar-outfits.mjs';

function workspace(t) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-avatar-mode-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

// The real app, local HTTP server and filesystem are used without provider overrides or starting a show.
async function listen(t, dataDir) {
    const c = config({ DATA_DIR: dataDir }, []);
    const app = createApp(c);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    t.after(close);
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = (path = '/api/avatar/mode', { method = 'GET', token = c.adminToken, data, headers = {} } = {}) => fetch(base + path, {
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

test('avatar modes expose only the existing 2D and 3D renderers and preserve the current 2D default', () => {
    assert.deepEqual(AVATAR_MODES, [{ id: 'noa', label: '2D' }, { id: 'vrm', label: '3D' }]);
    assert.equal(DEFAULT_AVATAR_MODE, 'noa');
    assert.equal(Object.isFrozen(AVATAR_MODES), true);
    for (const mode of AVATAR_MODES) {
        assert.equal(Object.isFrozen(mode), true);
        assert.equal(isAvatarMode(mode.id), true);
    }
    for (const mode of [null, undefined, {}, ['vrm'], '3D', 'external', '../noa', '']) assert.equal(isAvatarMode(mode), false);
});

test('avatar mode API preserves view/admin, host and origin boundaries and rejects invalid modes', async t => {
    const dir = workspace(t), app = await listen(t, dir), initial = { mode: 'noa', revision: 0 };
    assert.deepEqual(await (await app.request()).json(), initial);
    assert.equal(readdirSync(dir).includes('avatar-mode.json'), false, 'An upgrade must not overwrite an unsaved 2D selection');
    assert.deepEqual(await (await app.request(undefined, { token: app.c.viewToken })).json(), initial);
    const session = await (await app.request('/api/session')).json();
    assert.deepEqual(session.avatarMode, initial);
    assert.deepEqual(session.memory, app.memory.state);
    assert.equal(session.streamTarget, app.c.streamTarget);
    assert.equal(session.gameRunner.enabled, false);
    assert.equal(session.rehearsalApproved, false);
    assert.equal((await app.request(undefined, { token: '' })).status, 401);
    for (const token of ['', app.c.viewToken])
        assert.equal((await app.request(undefined, { method: 'POST', token, data: { mode: 'noa' } })).status, 401);
    assert.equal((await app.request(undefined, { method: 'POST', data: { mode: 'noa' }, headers: { Origin: 'https://example.com' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
        get(`${app.base}/api/avatar/mode`, { headers: { Host: 'example.com', Authorization: `Bearer ${app.c.adminToken}` } }, response => {
            response.resume(); response.on('end', () => resolve(response.statusCode));
        }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    for (const data of [null, [], {}, { mode: 'external' }, { mode: '../Noa.vrm' }, { mode: ['vrm'] }, { mode: 'vrm', revision: 9 }])
        assert.equal((await app.request(undefined, { method: 'POST', data })).status, 400);
    assert.deepEqual(await (await app.request()).json(), initial);
    assert.equal(app.engine.running, false);
    assert.equal(app.obs.owned, false);
    assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('initial 2D changes to 3D and back for all viewers, persists across restart and suppresses duplicate broadcasts', async t => {
    const dir = workspace(t), app = await listen(t, dir), file = join(dir, 'avatar-mode.json');
    const first = await events(t, app), second = await events(t, app);
    const initial = { mode: 'noa', revision: 0 };
    assert.deepEqual(await first.next('avatar_mode'), initial);
    assert.deepEqual(await second.next('avatar_mode'), initial);
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'avatar_mode') delivered.push(event.data); });
    for (const [index, mode] of ['vrm', 'noa'].entries()) {
        const selected = { mode, revision: index + 1 };
        const response = await app.request(undefined, { method: 'POST', data: { mode } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), selected);
        assert.deepEqual(await first.next('avatar_mode'), selected);
        assert.deepEqual(await second.next('avatar_mode'), selected);
        const persisted = readFileSync(file, 'utf8');
        assert.deepEqual(JSON.parse(persisted), { version: 1, ...selected });
        assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { mode } })).json(), selected);
        assert.equal(readFileSync(file, 'utf8'), persisted);
        assert.equal(delivered.length, index + 1);
    }
    const expected = delivered.at(-1), reconnected = await events(t, app);
    assert.deepEqual(await reconnected.next('avatar_mode'), expected);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    await first.close(); await second.close(); await reconnected.close(); await app.close();
    const restarted = await listen(t, dir);
    assert.deepEqual(await (await restarted.request()).json(), expected);
    assert.deepEqual((await (await restarted.request('/api/session')).json()).avatarMode, expected);
    assert.deepEqual(await (await events(t, restarted)).next('avatar_mode'), expected);
    assert.equal(restarted.engine.running, false);
    assert.deepEqual(restarted.engine.ledger.snapshot().calls, {});
});

test('a previously saved 3D choice is kept despite the 2D default, including after restart', async t => {
    const dir = workspace(t), mode = new AvatarMode(dir), file = join(dir, 'avatar-mode.json');
    assert.deepEqual(mode.snapshot(), { mode: 'noa', revision: 0 });
    assert.equal(mode.select({ mode: 'vrm' }), true);
    const saved = readFileSync(file, 'utf8'), expected = { mode: 'vrm', revision: 1 };
    assert.deepEqual(JSON.parse(saved), { version: 1, ...expected });
    const app = await listen(t, dir);
    assert.deepEqual(await (await app.request()).json(), expected);
    assert.deepEqual((await (await app.request('/api/session')).json()).avatarMode, expected);
    const viewer = await events(t, app);
    assert.deepEqual(await viewer.next('avatar_mode'), expected);
    assert.equal(readFileSync(file, 'utf8'), saved);
    await viewer.close(); await app.close();
    const restarted = await listen(t, dir);
    assert.deepEqual(await (await restarted.request()).json(), expected);
    assert.deepEqual(await (await events(t, restarted)).next('avatar_mode'), expected);
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.equal(restarted.engine.running, false);
    assert.deepEqual(restarted.engine.ledger.snapshot().calls, {});
});

test('avatar switching preserves the independent wardrobe, renderer lease and stopped audio state', async t => {
    const app = await listen(t, workspace(t));
    const claim = await (await app.request('/api/renderer/claim', {
        method: 'POST', token: app.c.viewToken, data: { client: randomUUID() }
    })).json();
    assert.equal(claim.acquired, true);
    const renderer = { ...app.engine.renderer }, epoch = app.engine.epoch;
    const outfit = { outfitId: OUTFITS[1].id };
    const wardrobe = await (await app.request('/api/avatar/wardrobe', { method: 'POST', data: outfit })).json();
    const eventsSeen = [];
    app.engine.on('event', event => { eventsSeen.push(event.type); });
    for (const mode of ['vrm', 'noa']) {
        assert.equal((await app.request(undefined, { method: 'POST', data: { mode } })).status, 200);
        assert.deepEqual(await (await app.request('/api/avatar/wardrobe')).json(), wardrobe);
        assert.deepEqual(app.engine.renderer, renderer);
        assert.equal(app.engine.validLease(claim.lease), true);
        assert.equal(app.engine.epoch, epoch);
        assert.equal(app.engine.pending, null);
        assert.equal(app.engine.running, false);
    }
    assert.deepEqual(eventsSeen, ['avatar_mode', 'avatar_mode']);
    const mode = await (await app.request()).json();
    assert.equal((await app.request('/api/avatar/wardrobe', { method: 'POST', data: { outfitId: OUTFITS[2].id } })).status, 200);
    assert.deepEqual(await (await app.request()).json(), mode);
    assert.equal(app.obs.owned, false);
    assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('real filesystem save failure retains the previous avatar mode without broadcasting or leaking paths', async t => {
    const dir = workspace(t), app = await listen(t, dir), file = join(dir, 'avatar-mode.json');
    const selected = { mode: 'vrm', revision: 1 };
    assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { mode: 'vrm' } })).json(), selected);
    renameSync(file, `${file}.preserved`);
    mkdirSync(file);
    const delivered = [];
    app.engine.on('event', event => { if (event.type === 'avatar_mode') delivered.push(event.data); });
    const response = await app.request(undefined, { method: 'POST', data: { mode: 'noa' } });
    assert.equal(response.status, 500);
    const error = await response.json();
    assert.match(error.error, /現在の表示を維持/);
    assert.equal(JSON.stringify(error).includes(dir), false);
    assert.deepEqual(await (await app.request()).json(), selected);
    assert.deepEqual(delivered, []);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
    rmSync(file, { recursive: true });
    renameSync(`${file}.preserved`, file);
    assert.deepEqual(new AvatarMode(dir).snapshot(), selected);
});

test('release OBS-priority lease takeover preserves avatar selection and keeps later previews from reclaiming audio', async t => {
    const app = await listen(t, workspace(t));
    const preview = await (await app.request('/api/renderer/claim', {
        method: 'POST', token: app.c.viewToken, data: { client: randomUUID() }
    })).json();
    assert.equal(preview.acquired, true);
    const selected2D = { mode: 'noa', revision: 0 };
    assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { mode: 'noa' } })).json(), selected2D);
    const wardrobe = await (await app.request('/api/avatar/wardrobe')).json();
    const output = await (await app.request('/api/renderer/claim', {
        method: 'POST', token: app.c.viewToken, data: { client: randomUUID(), rendererKey: app.c.obsRendererToken }
    })).json();
    assert.equal(output.acquired, true);
    assert.equal(app.engine.renderer.role, 'obs');
    assert.equal(app.engine.validLease(preview.lease), false);
    assert.deepEqual(await (await app.request()).json(), selected2D);
    assert.deepEqual(await (await app.request('/api/avatar/wardrobe')).json(), wardrobe);
    const selected3D = { mode: 'vrm', revision: 1 };
    assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { mode: 'vrm' } })).json(), selected3D);
    assert.equal(app.engine.validLease(output.lease), true);
    assert.equal(app.engine.renderer.role, 'obs');
    const laterPreview = await (await app.request('/api/renderer/claim', {
        method: 'POST', token: app.c.viewToken, data: { client: randomUUID() }
    })).json();
    assert.deepEqual(laterPreview, { acquired: false });
    assert.deepEqual((await (await app.request('/api/session')).json()).avatarMode, selected3D);
    assert.equal(app.engine.running, false);
    assert.equal(app.obs.owned, false);
    assert.deepEqual(app.engine.ledger.snapshot().calls, {});
});

test('damaged saved avatar mode is reported without overwriting it and can be explicitly repaired', async t => {
    const dir = workspace(t), mode = new AvatarMode(dir), file = join(dir, 'avatar-mode.json');
    mode.select({ mode: 'vrm' });
    truncateSync(file, 8);
    const damaged = readFileSync(file, 'utf8'), loaded = new AvatarMode(dir);
    assert.equal(loaded.snapshot().mode, DEFAULT_AVATAR_MODE);
    assert.match(loaded.snapshot().warning, /保存済みのアバター表示を読み込めませんでした/);
    assert.match(loaded.snapshot().warning, /標準の2D/);
    assert.equal(readFileSync(file, 'utf8'), damaged);
    const snapshot = loaded.snapshot(); snapshot.mode = 'vrm';
    assert.equal(loaded.snapshot().mode, DEFAULT_AVATAR_MODE);
    const app = await listen(t, dir), stream = await events(t, app);
    assert.deepEqual(await (await app.request()).json(), loaded.snapshot());
    assert.deepEqual(await stream.next('avatar_mode'), loaded.snapshot());
    assert.equal(readFileSync(file, 'utf8'), damaged);
    const restored = { mode: DEFAULT_AVATAR_MODE, revision: 1 };
    assert.deepEqual(await (await app.request(undefined, { method: 'POST', data: { mode: DEFAULT_AVATAR_MODE } })).json(), restored);
    assert.deepEqual(await stream.next('avatar_mode'), restored);
    assert.deepEqual(new AvatarMode(dir).snapshot(), restored);
});
