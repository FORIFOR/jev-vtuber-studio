import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, errorDetail } from '../src/server.mjs';
import { commentAck } from '../src/comment-ack.mjs';
import { repetitionReason } from '../src/content-quality.mjs';
import { ExternalGameShow } from '../src/external-game-show.mjs';
import { OBS } from '../src/obs.mjs';
import { setup } from './helpers.mjs';

// Operator-facing causes and a character that is configuration, not code.

test('errorDetail: the error\'s words without URLs, home paths or token-shaped runs; empty for nothing', () => {
    assert.equal(errorDetail(Object.assign(new Error('fetch failed ws://127.0.0.1:4455/'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED: fetch failed [URL]');
    assert.equal(errorDetail(new Error('/Users/me/secret/settings.json: key abcdef0123456789abcdef0123456789 rejected')), '[path]: key [token] rejected');
    assert.equal(errorDetail(new Error('word '.repeat(100))).length, 200);
    assert.equal(errorDetail({}), ''); assert.equal(errorDetail(null), '');
});

test('HTTP: a failed admin request carries its sanitized cause; the generic message alone goes to everyone else', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0;
    const obs = { ready: true, owned: false, close() {}, async stopOwned() {}, async prepare() { return {}; }, async setGameVisible() {} };
    const a = createApp(c, { obs }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    let closed = false; const close = async () => { if (closed) return; closed = true; a.engine.stop('test'); await a.close(); }; t.after(close);
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const post = (path, data, token) => fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await post('/api/control', { action: 'start' }, c.adminToken)).status, 200);
    const r = await post('/api/obs/prepare', {}, c.adminToken), body = await r.json();
    assert.equal(r.status, 400); assert.match(body.error, /操作を完了できませんでした/); assert.equal(body.detail, 'Stop the local show before preparing OBS');
    const v = await post('/api/obs/prepare', {}, c.viewToken);
    assert.equal(v.status, 401); assert.equal((await v.json()).detail, undefined, 'the view token learns nothing');
    await close();
});

test('character: the OBS profile and Twitch defaults come from config/character.json, env and settings override them', t => {
    const c = setup(t);
    assert.equal(c.obsTwitchProfile, c.character.obs.twitchProfile); assert.equal(c.obsSimulcastProfile, c.character.obs.simulcastProfile);
    assert.equal(c.twitchChannel, c.character.twitch.channel); assert.equal(c.obsBgmSource, c.character.obs.bgmSource);
    const d = setup(t, { OBS_TWITCH_PROFILE: 'Mina - Twitch', OBS_BGM_SOURCE: 'Mina BGM', TWITCH_CHANNEL: 'mina_live', CHARACTER_NAME: 'ミナ' });
    assert.equal(d.obsTwitchProfile, 'Mina - Twitch'); assert.equal(d.obsBgmSource, 'Mina BGM'); assert.equal(d.twitchChannel, 'mina_live'); assert.equal(d.character.name, 'ミナ');
});

test('character: the OBS BGM source takes the configured name', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', OBS_BGM_SOURCE: 'Mina BGM' }), obs = new OBS(c), calls = [];
    c.obsBgmFile = '/music/x.mp3';
    obs.call = async (type, data) => { calls.push({ type, data }); return ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type) ? { outputActive: false } : type === 'GetSceneList' ? { scenes: [] } : type === 'GetInputList' ? { inputs: [] } : type === 'GetSceneItemList' ? { sceneItems: [] } : type === 'GetInputPropertiesListPropertyItems' ? { propertyItems: [] } : {}; };
    await obs.prepare('http://127.0.0.1:8787');
    assert.ok(calls.some(x => x.type === 'CreateInput' && x.data.inputName === 'Mina BGM' && x.data.inputKind === 'ffmpeg_source'));
    assert.ok(!calls.some(x => x.data?.inputName === 'Noa BGM'));
});

test('character: compliments to the host by her configured name are acknowledged; another name is not assumed', () => {
    assert.equal(commentAck('ノアかわいい', 0).kind, 'compliment');
    assert.equal(commentAck('ミナちゃんかわいい', 0, 'ミナ').kind, 'compliment');
    assert.equal(commentAck('ノアかわいい', 0, 'ミナ'), null, 'the old name is not special once the character changes');
    assert.equal(commentAck('猫かわいい', 0, 'ミナ'), null, 'not every subject is the host');
    assert.equal(repetitionReason('こんばんは、ミナです。今夜もよろしく。', [], 'autonomous'), 'intro_repeated', 'the repeated-intro detector is not tied to one name');
});

test('character: game prompt rules name the configured host, not a fixed one', () => {
    const s = new ExternalGameShow({ title: 'G', what: 'w', statusKey: 'g', startLine: 'x', policy: {}, lines: {} }, {}, { name: 'ミナ' });
    assert.match(s.promptRule('monologue'), /ミナが操作している/); assert.doesNotMatch(s.promptRule('monologue'), /ノア/);
    assert.match(new ExternalGameShow({ title: 'G', what: 'w', statusKey: 'g', startLine: 'x', policy: {}, lines: {} }).promptRule('monologue'), /ノアが操作している/, 'the default stays');
});

test('first run: DEMO prepares the budget farewell with browser speech instead of refusing to start; live without voice bytes says why', async t => {
    const { TalkEngine } = await import('../src/talk-engine.mjs');
    const { ledger, audit } = await import('./helpers.mjs');
    const mk = (c, synth) => new TalkEngine(c, { ledger: ledger(), audit, jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'x' }, voice: { synthesize: synth }, research: { search: async () => { throw new Error('x'); } } });
    const demo = setup(t, { SHOW_PROFILE: 'talk', MEMORY_GUARD: '1' });
    const e = mk(demo, async text => ({ kind: 'browser', durationMs: Math.max(3000, text.length * 130), bytes: null }));
    await e.prepareBudgetClosing(); assert.ok(e.budgetFarewell, 'a demo farewell is as available as any demo line');
    const live = setup(t, { SHOW_PROFILE: 'talk', MEMORY_GUARD: '1' }); live.mode = 'live';
    await assert.rejects(mk(live, async () => ({ kind: 'wav', durationMs: 0, bytes: null })).prepareBudgetClosing(), /締めの挨拶の音声を用意できません/);
});

test('lobby scenes: a file under data/ replaces the built-in opening talk; a malformed one is reported and the built-in stays', t => {
    const { writeFileSync } = require('node:fs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' });
    assert.ok(c.lobbyScenes.some(s => s.id === 'hoshiai-letterplay'), 'built-in by default');
    const own = { scenes: [{ id: 'mine', title: '私の話', premise: 'p', beats: [{ id: 'a', label: 'l', action: 'imagine', task: 't', minChars: 10, maxChars: 60, demo: 'd' }, { id: 'b', label: 'l', action: 'imagine', task: 't2', minChars: 10, maxChars: 60, demo: 'd2' }] }] };
    writeFileSync(join(c.dataDir, 'lobby-scenes.json'), JSON.stringify(own));
    const d = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', DATA_DIR: c.dataDir });
    assert.deepEqual(d.lobbyScenes.map(s => s.id), ['mine']); assert.deepEqual(d.programmeWarnings, []);
    writeFileSync(join(c.dataDir, 'lobby-scenes.json'), JSON.stringify({ scenes: [{ id: 'bad' }] }));
    const w = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', DATA_DIR: c.dataDir });
    assert.ok(w.lobbyScenes.some(s => s.id === 'hoshiai-letterplay')); assert.ok(w.programmeWarnings.some(x => x.startsWith('lobby-scenes.json')));
});
import { createRequire } from 'node:module'; import { join } from 'node:path'; const require = createRequire(import.meta.url);
