import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Control, ControlError, MANUAL_FACES } from '../src/control.mjs';
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, keyName, validHotkeys, nextListening } from '../public/hotkeys.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

// NOA Studio Phase 6 (operator 2026-10-19, docs/CONTROL.md): the Live Control Panel (/control), hotkeys resolved by the
// server on the current state (the same from the Studio, the panel and scripts/global-hotkeys.mjs), the operator's own
// key map, and the Avatar Controller (manual face over every automatic reaction).
const root = new URL('..', import.meta.url);
function fixture(t) {
    const c = setup(t, { SHOW_PROFILE: 'talk', OBS_HUMAN_MIC_SOURCE: 'Mic' }); c.mode = 'live';
    const obs = { calls: [], async setHumanMic(name, on) { obs.calls.push(on); } };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => '星の話をしよう。' },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 500, bytes: wav(.1) }) }, commentVoice: { synthesize: async () => ({ kind: 'browser', durationMs: 200, bytes: null }) } }));
    e.director.opened = true; e.standby = null;
    const control = new Control(c, { engine: e, obs, audit });
    t.after(() => e.stop());
    return { c, e, obs, control };
}

test('hotkeys resolve on the current state: voice toggle, mute, resume, take over, listening, avatar, game', async t => {
    const { e, obs, control } = fixture(t);
    await control.hotkey('voice-toggle'); assert.equal(e.control.voice, 'human');
    await control.hotkey('voice-toggle'); assert.equal(e.control.voice, 'ai');
    await control.hotkey('mute'); assert.equal(e.control.voice, 'none');
    await control.hotkey('resume'); assert.equal(e.control.voice, 'ai');
    await control.hotkey('take-over'); assert.equal(e.control.voice, 'human');
    assert.deepEqual(obs.calls, [true, false, true]);
    e.control.listening = 'discord_first';
    await control.hotkey('listening-toggle'); assert.equal(e.control.listening, 'comments_first');
    await control.hotkey('avatar-toggle'); assert.equal(e.control.avatar, 'manual');
    await assert.rejects(control.hotkey('game-toggle'), /ゲームがありません/);
    let switched = 0; control.gameRunner = { enabled: true, switchPlayer: async () => { switched++; } };
    await control.hotkey('game-toggle'); assert.equal(switched, 1);
    await assert.rejects(control.hotkey('self-destruct'), ControlError);
});

test('Avatar Controller: manual holds the operator\'s face; auto gives it back; faces are presets', t => {
    const { e, control } = fixture(t);
    assert.deepEqual([e.control.avatar, e.control.face], ['auto', null]);
    control.setAvatar('manual', 'happy');
    assert.deepEqual([e.status().control.avatar, e.status().control.face], ['manual', 'happy']);
    control.setAvatar('manual');
    assert.equal(e.control.face, 'happy', 'manual keeps the face');
    control.setAvatar('auto');
    assert.equal(e.control.face, null);
    assert.throws(() => control.setAvatar('manual', 'angry-at-viewers'), ControlError);
    assert.throws(() => control.setAvatar('puppet'), ControlError);
    assert.ok(MANUAL_FACES.includes('neutral') && MANUAL_FACES.includes('surprised'));
    e.stop(); assert.equal(e.control.avatar, 'auto', 'a show ends in auto');
});

test('key names and the operator\'s map: function keys, modifier combos, no bare letters, each action once', () => {
    assert.equal(keyName({ key: 'F6', code: 'F6' }), 'F6');
    assert.equal(keyName({ key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+M');
    assert.equal(keyName({ key: 'm', code: 'KeyM' }), null, 'a bare letter is typing');
    assert.equal(keyName({ key: 'Enter', code: 'Enter' }), null);
    assert.deepEqual(validHotkeys({ F6: 'voice-toggle', 'Cmd+1': 'mute' }), { F6: 'voice-toggle', 'Cmd+1': 'mute' });
    assert.throws(() => validHotkeys({ M: 'mute' }), /使えないキー/);
    assert.throws(() => validHotkeys({ F6: 'launch' }), /不明な操作/);
    assert.throws(() => validHotkeys({ F6: 'mute', F7: 'mute' }), /2つのキー/);
    assert.deepEqual(Object.values(DEFAULT_HOTKEYS).sort(), ['game-toggle', 'listening-toggle', 'mute', 'resume', 'voice-toggle']);
    for (const a of Object.values(DEFAULT_HOTKEYS)) assert.ok(HOTKEY_ACTIONS[a]);
    assert.equal(nextListening('muted'), 'comments'); assert.equal(nextListening('both'), 'discord_first');
});

test('HTTP: hotkeys are saved per operator, validated, reset; a hotkey action and the avatar act through /api/control', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', HUMAN_VOICE_MODE: 'resynth' }); c.port = 0;
    const a = createApp(c, { obs: { close() { }, async stopOwned() { }, async setHumanMic() { } }, MeterOBS: null });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    try {
        const url = `http://127.0.0.1:${a.server.address().port}`;
        const req = (path, data, token = c.adminToken) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
        assert.deepEqual((await (await req('/api/hotkeys')).json()).map, DEFAULT_HOTKEYS);
        assert.equal((await req('/api/hotkeys', null, c.viewToken)).status, 401);
        assert.equal((await req('/api/hotkeys', { map: { M: 'mute' } })).status, 400);
        let r = await req('/api/hotkeys', { map: { F13: 'voice-toggle', 'Ctrl+Alt+9': 'mute' } });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(readFileSync(`${c.dataDir}/hotkeys.json`, 'utf8')), { F13: 'voice-toggle', 'Ctrl+Alt+9': 'mute' });
        assert.deepEqual((await (await req('/api/hotkeys')).json()).map, { F13: 'voice-toggle', 'Ctrl+Alt+9': 'mute' });
        assert.deepEqual((await (await req('/api/hotkeys', { reset: true })).json()).map, DEFAULT_HOTKEYS);
        active(a.engine);
        r = await req('/api/control', { action: 'hotkey', name: 'voice-toggle', by: 'global' });
        assert.equal(r.status, 200); assert.equal((await r.json()).control.voice, 'human');
        r = await req('/api/control', { action: 'avatar', to: 'manual', face: 'surprised' });
        assert.equal((await r.json()).control.face, 'surprised');
        assert.equal((await req('/api/control', { action: 'hotkey', name: 'nope' })).status, 400);
        for (const path of ['/control', '/control.mjs', '/control.css', '/hotkeys.mjs']) assert.equal((await fetch(url + path)).status, 200, path);
    } finally { a.engine.stop(); await a.close(); }
});

test('stage holds a manual face; the panel and the global helper exist with their keys', () => {
    const stage = readFileSync(new URL('public/stage.mjs', root), 'utf8');
    assert.match(stage, /if \(manualFace\) return 0; \/\/ the operator leads the face/);
    assert.match(stage, /d\.control\?\.avatar === 'manual'/);
    const html = readFileSync(new URL('public/control.html', root), 'utf8');
    for (const id of ['lcp-takeover', 'lcp-resume', 'lcp-mute', 'lcp-stop', 'lcp-status', 'lcp-keys']) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const v of ['ai', 'human', 'none']) assert.match(html, new RegExp(`data-voice="${v}"`));
    for (const g of ['ai', 'human', 'off']) assert.match(html, new RegExp(`data-game="${g}"`));
    assert.match(readFileSync(new URL('scripts/hotkeys.swift', root), 'utf8'), /RegisterEventHotKey/);
    assert.equal(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts.hotkeys, 'node scripts/global-hotkeys.mjs');
});
