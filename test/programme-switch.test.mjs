// The studio's one-tap programme switch: saves the programme (and with it the game), prepares its OBS scene, and says
// plainly what is still missing. Local only: a fake OBS, no providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

async function studio(t, c, obsOverrides = {}) {
    const prepared = [];
    const obs = { owned: false, ready: true, close() {}, async connect() {}, async call() { return {}; }, async start() {}, async stopOwned() {},
        async prepare(origin) { prepared.push({ origin, game: c.game?.id ?? null }); return { scene: c.game ? `Jev Studio - ${c.game.title}` : 'Jev Studio' }; }, ...obsOverrides };
    const app = createApp(c, { obs, youtube: { watch: async () => {} } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.close());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const req = async (path, data) => { const r = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); return { status: r.status, body: await r.json() }; };
    return { app, req, prepared };
}

test('one tap selects the programme, its game and its OBS scene, and the session shows the new choice', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false' });
    const s = await studio(t, c);
    const list = (await s.req('/api/session')).body.setup.programmes;
    assert.deepEqual(list.find(p => p.id === 'noa-smash').style, 'game');
    assert.deepEqual(list.find(p => p.id === 'noa-blocks').style, 'blocks');
    assert.deepEqual(list.find(p => p.id === 'room').style, 'talk');
    const r = await s.req('/api/programme/select', { id: 'noa-smash' });
    assert.equal(r.status, 200);
    assert.equal(r.body.programme.game.id, 'smash-ultimate');
    assert.deepEqual(r.body.obs, { ok: true, scene: 'Jev Studio - スマブラSP' });
    assert.equal(r.body.changed, true);
    assert.equal(s.prepared.at(-1).game, 'smash-ultimate', 'OBS is prepared for the new game, not the old one');
    assert.equal((await s.req('/api/session')).body.setup.values.SHOW_PROGRAMME, 'noa-smash');
    const back = await s.req('/api/programme/select', { id: 'noa-vampire' });
    assert.equal(back.body.programme.game.id, 'vampire-survivors'); assert.equal(s.prepared.at(-1).game, 'vampire-survivors');
    const again = await s.req('/api/programme/select', { id: 'noa-vampire' });
    assert.equal(again.body.changed, false, 'choosing the current programme only re-prepares OBS');
});

test('an OBS problem is reported in words, the choice itself is kept', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false' });
    const s = await studio(t, c, { async prepare() { throw new Error('OBSの「Jev Stage」はStudioの専用ソースとして使えない設定です。'); } });
    const r = await s.req('/api/programme/select', { id: 'room' });
    assert.equal(r.status, 200);
    assert.equal(r.body.obs.ok, false); assert.match(r.body.obs.error, /専用ソース/);
    assert.equal((await s.req('/api/session')).body.setup.values.SHOW_PROGRAMME, 'room');
});

test('unknown programmes and a running show are refused without changing anything', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'false' });
    const s = await studio(t, c);
    const before = (await s.req('/api/session')).body.setup.values.SHOW_PROGRAMME;
    assert.equal((await s.req('/api/programme/select', { id: 'no-such-show' })).status, 404);
    s.app.engine.running = true;
    const busy = await s.req('/api/programme/select', { id: 'noa-smash' });
    s.app.engine.running = false;
    assert.equal(busy.status, 409); assert.match(busy.body.error, /終了してから/);
    assert.equal((await s.req('/api/session')).body.setup.values.SHOW_PROGRAMME, before);
    assert.equal(s.prepared.length, 0);
});
