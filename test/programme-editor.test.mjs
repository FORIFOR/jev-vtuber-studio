import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { builtinProgrammes, loadProgrammes, validateProgramme, applyEdit, saveProgramme, resetProgramme, editable, overridesDir } from '../src/programmes.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

// The programme editor: words change, structure and the tests' bounds hold, the repository file is never written.

test('every built-in programme passes the editor\'s validation (the same bounds the tests hold them to)', () => {
    for (const p of builtinProgrammes()) assert.deepEqual(validateProgramme(p, p), [], p.id);
});

test('validation names what is wrong: long demos, duplicate tasks, changed beat counts, a changed game', () => {
    const room = builtinProgrammes().find(p => p.id === 'room');
    const long = applyEdit(room, { cards: [{ id: 'room-storage', beats: [{ id: 'storage-1', demo: '一文目。二文目。三文目。' }] }] });
    assert.ok(validateProgramme(long, room).some(x => /見本（demo）は2文/.test(x)));
    const dup = applyEdit(room, { cards: [{ id: 'room-storage', beats: [{ id: 'storage-2', task: room.cards[0].beats[0].task }] }] });
    assert.ok(validateProgramme(dup, room).some(x => /課題が他の段階と同じ/.test(x)));
    const fewer = structuredClone(room); fewer.cards[0].beats.pop();
    assert.ok(validateProgramme(fewer, room).some(x => /段階の数は変えられません/.test(x)));
    assert.ok(validateProgramme({ ...room, game: 'smash-ultimate' }, room).some(x => /ゲームの指定/.test(x)));
    assert.ok(validateProgramme({ ...room, title: '' }, room).some(x => /企画名/.test(x)));
    assert.ok(validateProgramme({ ...room, openingLine: 'A。B。C。' }, room).some(x => /最初の挨拶/.test(x)));
    assert.deepEqual(validateProgramme(null), ['企画の形式が違います']);
});

test('applyEdit changes only the editor\'s fields by id; flags, ids and unknown ids are untouched; the card demo list follows', () => {
    const v = builtinProgrammes().find(p => p.id === 'noa-vampire');
    const e = applyEdit(v, { title: '  ゲーム部 改  ', hook: undefined, cards: [{ id: 'vampire-night', beats: [{ id: 'vampire-1', demo: '新しい見本。', label: '実況' }, { id: 'nope', demo: 'x' }] }, { id: 'ghost', beats: [] }] });
    assert.equal(e.title, 'ゲーム部 改'); assert.equal(e.hook, v.hook); assert.equal(e.game, 'vampire-survivors');
    const b = e.cards[0].beats.find(x => x.id === 'vampire-1'); assert.equal(b.demo, '新しい見本。'); assert.equal(b.label, '実況'); assert.equal(b.game, true);
    assert.equal(e.cards[0].beats.length, v.cards[0].beats.length); assert.ok(e.cards[0].demo.includes('新しい見本。')); assert.equal(e.custom, undefined);
    assert.deepEqual(validateProgramme(e, v), []);
});

test('save → load replaces the built-in by id under data/programmes; reset removes it; bad files are reported, not loaded', t => {
    const c = setup(t), room = builtinProgrammes().find(p => p.id === 'room');
    const bad = saveProgramme(c.dataDir, applyEdit(room, { title: '' }), room);
    assert.equal(bad.saved, false); assert.ok(bad.problems.length); assert.ok(!existsSync(overridesDir(c.dataDir)), 'nothing is written for an invalid programme');
    const ok = saveProgramme(c.dataDir, applyEdit(room, { title: '部屋の話 改' }), room);
    assert.equal(ok.saved, true); assert.ok(existsSync(join(overridesDir(c.dataDir), 'room.json')));
    const l = loadProgrammes(c.dataDir); assert.equal(l.programmes.find(p => p.id === 'room').title, '部屋の話 改'); assert.equal(l.programmes.find(p => p.id === 'room').custom, true); assert.deepEqual(l.warnings, []);
    assert.equal(l.programmes.length, builtinProgrammes().length, 'no programme is added or lost');
    assert.equal(readFileSync(new URL('../config/programmes.json', import.meta.url), 'utf8').includes('部屋の話 改'), false, 'the repository file is untouched');
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(overridesDir(c.dataDir), 'holiday.json'), '{not json'); writeFileSync(join(overridesDir(c.dataDir), 'stranger.json'), '{}');
    const w = loadProgrammes(c.dataDir); assert.equal(w.programmes.find(p => p.id === 'holiday').custom, undefined); assert.ok(w.warnings.some(x => x.startsWith('holiday:'))); assert.ok(w.warnings.some(x => x.startsWith('stranger.json')));
    assert.equal(resetProgramme(c.dataDir, 'room'), true); assert.equal(resetProgramme(c.dataDir, '../x'), false);
    assert.equal(loadProgrammes(c.dataDir).programmes.find(p => p.id === 'room').custom, undefined);
    const ed = editable(room); assert.deepEqual(Object.keys(ed.cards[0].beats[0]), ['id', 'label', 'task', 'demo', 'display', 'lobby', 'game']);
});
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

async function app(t, env = {}, overrides = {}) {
    const c = setup(t, env); c.port = 0;
    const obs = { ready: false, owned: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() {}, async connect() { throw new Error('no OBS'); }, ...overrides.obs };
    const a = createApp(c, { obs, ...overrides }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    let closed = false; const close = async () => { if (closed) return; closed = true; a.engine.stop('test'); await a.close(); }; t.after(close);
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const req = (path, data, token = c.adminToken) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { c, a, req, close };
}

test('HTTP: the editor lists, saves (validated), reloads the configuration and resets; only the admin, only while stopped', async t => {
    const { c, a, req, close } = await app(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'room' });
    assert.equal((await req('/api/programmes', null, c.viewToken)).status, 401);
    const list = await (await req('/api/programmes')).json();
    assert.equal(list.current, 'room'); assert.equal(list.programmes.length, builtinProgrammes().length); assert.ok(list.programmes[0].cards[0].beats[0].task);
    const r1 = await req('/api/programmes', { action: 'save', programme: { id: 'room', title: '', cards: [] } }), b1 = await r1.json();
    assert.equal(r1.status, 400); assert.ok(b1.problems.some(x => /企画名/.test(x)));
    const r2 = await req('/api/programmes', { action: 'save', programme: { id: 'room', title: '部屋の話 改', cards: [{ id: 'room-storage', beats: [{ id: 'storage-1', demo: '新しい見本だよ。' }] }] } }), b2 = await r2.json();
    assert.equal(r2.status, 200); assert.equal(b2.programme.custom, true); assert.equal(b2.programme.title, '部屋の話 改');
    assert.equal(c.programme.title, '部屋の話 改', 'the running configuration is rebuilt'); assert.equal(c.topicCards[0].beats[0].demo, '新しい見本だよ。');
    assert.equal(c.programmeOptions.find(p => p.id === 'room').title, '部屋の話 改', 'the settings page list follows');
    assert.equal((await req('/api/programmes', { action: 'save', programme: { id: 'nope', title: 'x' } })).status, 404);
    assert.equal((await req('/api/control', { action: 'start' })).status, 200);
    assert.equal((await req('/api/programmes', { action: 'reset', id: 'room' })).status, 409, 'not while the show runs');
    a.engine.stop('test'); await new Promise(r => setTimeout(r, 10));
    const r3 = await req('/api/programmes', { action: 'reset', id: 'room' }); assert.equal(r3.status, 200); assert.equal((await r3.json()).programme.custom, false);
    assert.equal(c.programme.title, builtinProgrammes().find(p => p.id === 'room').title);
    await close();
});

test('HTTP: readiness is one list with a verdict per step; demo mode needs no model, key or rehearsal; OBS down is a ✗ with a next step', async t => {
    const { c, req, close } = await app(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-smash', LLM_BASE_URL: 'http://127.0.0.1:9/v1', VOICEVOX_URL: 'http://127.0.0.1:9' }); // never a real local service
    assert.equal((await req('/api/readiness', null, c.viewToken)).status, 401);
    const r = await req('/api/readiness'), body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.mode, 'demo');
    const by = Object.fromEntries(body.steps.map(s => [s.id, s]));
    assert.equal(by.model.ok, null); assert.equal(by.judge.ok, null); assert.equal(by.jev, undefined); assert.equal(by.jevBilling, undefined); assert.equal(by.rehearsal.ok, null);
    assert.equal(by.obs.ok, false); assert.match(by.obs.note, /WebSocket/); assert.equal(by.obsScene.ok, null);
    assert.equal(by.switch.ok, false, 'a Switch-captured game needs the Switch page'); assert.equal(by.switch.link, '/switch');
    assert.equal(by.recording.ok, null, 'never claimed automatically');
    assert.equal(body.ready, false);
    assert.ok(body.steps.every(s => typeof s.label === 'string' && typeof s.link === 'string'));
    await close();
});
