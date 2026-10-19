import test from 'node:test';
import assert from 'node:assert/strict';
import { OBS, OVERLAY_GAME_CHAT, OVERLAY_TALK_CHAT, OVERLAY_GAME_ACTIONS } from '../src/obs.mjs';
import { setup, engine, active } from './helpers.mjs';

const fake = (c, items) => {
    const obs = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game: { title: 'Vampire Survivors' }, ...c }), calls = [];
    obs.ready = true;
    obs.call = async (type, data) => { calls.push({ type, data }); return type === 'GetSceneItemList' ? { sceneItems: items } : {}; };
    return { obs, calls };
};
const items = [{ sourceName: 'Chat', sceneItemId: 7 }, { sourceName: 'Commands', sceneItemId: 8 }];

test('overlays: beside Noa with the commands hidden during the talk, back under the game while it plays', async () => {
    const { obs, calls } = fake({ obsChatSource: 'Chat', obsActionsSource: 'Commands' }, items);
    assert.equal(await obs.placeOverlays(true), true);
    assert.equal(calls[0].data.sceneName, 'Jev Studio - Vampire Survivors');
    assert.deepEqual(calls.find(x => x.type === 'SetSceneItemTransform').data, { sceneName: 'Jev Studio - Vampire Survivors', sceneItemId: 7, sceneItemTransform: OVERLAY_TALK_CHAT });
    assert.deepEqual(calls.find(x => x.type === 'SetSceneItemEnabled').data.sceneItemEnabled, false);
    calls.length = 0;
    await obs.placeOverlays(false);
    assert.deepEqual(calls.find(x => x.type === 'SetSceneItemTransform').data.sceneItemTransform, OVERLAY_GAME_CHAT);
    assert.equal(calls.find(x => x.type === 'SetSceneItemEnabled').data.sceneItemEnabled, true);
});

test('overlays: off unless configured; a missing source is skipped', async () => {
    const off = fake({}, items);
    assert.equal(await off.obs.placeOverlays(true), false); assert.equal(off.calls.length, 0);
    const missing = fake({ obsChatSource: 'Nope' }, items);
    assert.equal(await missing.obs.placeOverlays(true), false);
    assert.ok(!missing.calls.some(x => x.type.startsWith('SetSceneItem')));
});

test('overlays: the Studio creates its own chat and command pages, re-points an existing browser source, leaves other kinds alone', async () => {
    const calls = [], obs = new OBS({ obsScene: 'Jev Studio', obsInput: 'Jev Stage', game: { title: 'Vampire Survivors' }, obsChatSource: 'Chat', obsActionsSource: 'Commands', viewToken: 'v' });
    obs.ready = true;
    obs.call = async (type, data) => { calls.push({ type, data });
        if (type === 'GetInputList') return { inputs: [{ inputName: 'Chat', inputKind: 'browser_source' }] };
        if (type === 'GetSceneItemList') return { sceneItems: [{ sourceName: 'Chat', sceneItemId: 7 }] };
        if (type === 'CreateInput') return { sceneItemId: 9 };
        return {}; };
    await obs.ensureOverlays('http://127.0.0.1:8787', 'Jev Studio - Vampire Survivors');
    assert.equal(calls.find(x => x.type === 'SetInputSettings').data.inputSettings.url, 'http://127.0.0.1:8787/overlay-chat.html#token=v');
    const created = calls.find(x => x.type === 'CreateInput').data;
    assert.equal(created.inputName, 'Commands'); assert.equal(created.inputSettings.url, 'http://127.0.0.1:8787/overlay-actions.html#token=v');
    const placed = calls.filter(x => x.type === 'SetSceneItemTransform').map(x => [x.data.sceneItemId, x.data.sceneItemTransform]);
    assert.deepEqual(placed, [[7, OVERLAY_GAME_CHAT], [9, OVERLAY_GAME_ACTIONS]]);
    calls.length = 0;
    obs.call = async (type, data) => { calls.push({ type, data }); return type === 'GetInputList' ? { inputs: [{ inputName: 'Chat', inputKind: 'text_ft2_source_v2' }, { inputName: 'Commands', inputKind: 'browser_source' }] } : type === 'GetSceneItemList' ? { sceneItems: [] } : {}; };
    await obs.ensureOverlays('http://127.0.0.1:8787', 'S');
    assert.ok(!calls.some(x => x.data?.inputName === 'Chat' && x.type !== 'GetInputList'), 'a non-browser source of that name is not touched');
});

test('viewer comments reach the on-stream chat box with their display name unless the local check fails; Studio-local text never does', t => {
    const e = active(engine(setup(t))), shown = [];
    e.on('viewer_comment', m => shown.push(m));
    e.ingest({ text: 'こんばんは', author: 'a', id: 'y1', source: 'youtube', name: 'Noa Fan' });
    e.ingest({ text: 'hi', author: 'b', id: 't1', source: 'twitch', name: 'mail me at x@example.com' });
    e.ingest({ text: '電話 090-1234-5678', author: 'c', id: 'y2', source: 'youtube', name: 'c' });
    e.ingest({ text: 'operator note', author: 'operator' });
    e.ingest({ text: 'こんばんは', author: 'a', id: 'y1', source: 'youtube', name: 'Noa Fan' });
    assert.deepEqual(shown.map(m => [m.source, m.name, m.text]), [['youtube', 'Noa Fan', 'こんばんは'], ['twitch', '', 'hi']]);
    e.stop();
});
