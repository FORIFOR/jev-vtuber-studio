import test from 'node:test';
import assert from 'node:assert/strict';
import { OBS } from '../src/obs.mjs';
import { setup } from './helpers.mjs';

const origin = 'http://127.0.0.1:8787';
const stageURL = suffix => `${origin}/stage#token=previous-capability${suffix || ''}`;
const mutations = calls => calls.filter(x => /^(Set|Create|Remove|Start|Stop)/.test(x.type));
function fixture(t, { env = {}, inputs = [], settings = {}, activity = {}, items = [] } = {}) {
    const c = setup(t, env), obs = new OBS(c), calls = [];
    c.obsRendererToken = 'current-renderer-capability';
    obs.call = async (type, data) => {
        calls.push({ type, data });
        if (['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type)) return { outputActive: false };
        if (type === 'GetSceneList') return { scenes: [{ sceneName: c.obsScene }] };
        if (type === 'GetInputList') return { inputs };
        if (type === 'GetInputSettings') return { inputSettings: settings[data.inputName] };
        // obs-websocket 5.x GetSourceActive uses sourceName (not inputName).
        // https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#getsourceactive
        if (type === 'GetSourceActive') {
            assert.deepEqual(Object.keys(data), ['sourceName']);
            assert.ok(inputs.some(input => input.inputName === data.sourceName));
            return activity[data.sourceName] || { videoActive: false, videoShowing: false };
        }
        if (type === 'GetSceneItemList') return { sceneItems: items };
        if (type === 'GetInputPropertiesListPropertyItems') return { propertyItems: [] };
        if (type === 'GetSpecialInputs') return {};
        if (type.startsWith('Get')) throw Error(`Unsupported OBS fixture request: ${type}`);
        return {};
    };
    return { c, obs, calls };
}

test('prepare refuses every active or unknown output without changing any source', async t => {
    for (const [request, response] of [
        ['GetStreamStatus', { outputActive: true }], ['GetStreamStatus', { outputActive: false, outputReconnecting: true }],
        ['GetRecordStatus', { outputActive: true }], ['GetReplayBufferStatus', { outputActive: true }],
        ['GetStreamStatus', {}], ['GetRecordStatus', {}], ['GetReplayBufferStatus', {}],
    ]) {
        const r = fixture(t), call = r.obs.call;
        r.obs.call = (type, data) => type === request ? Promise.resolve(response) : call(type, data);
        await assert.rejects(r.obs.prepare(origin), /停止/);
        assert.deepEqual(mutations(r.calls), []);
    }
    const r = fixture(t), call = r.obs.call;
    r.obs.call = (type, data) => type === 'GetReplayBufferStatus' ? Promise.reject(Error('connection lost')) : call(type, data);
    await assert.rejects(r.obs.prepare(origin), /connection lost/);
    assert.deepEqual(mutations(r.calls), []);
});

test('prepare checks outputs again after inspection and accepts only unavailable-replay InvalidResourceState 604', async t => {
    const r = fixture(t), call = r.obs.call; let checks = 0;
    r.obs.call = (type, data) => type === 'GetStreamStatus' ? Promise.resolve({ outputActive: ++checks > 1 }) : call(type, data);
    await assert.rejects(r.obs.prepare(origin), /停止/); assert.deepEqual(mutations(r.calls), []);
    const disabled = fixture(t), invoke = disabled.obs.call;
    disabled.obs.call = (type, data) => type === 'GetReplayBufferStatus' ? Promise.reject(Error('OBS GetReplayBufferStatus failed (604)')) : invoke(type, data);
    await disabled.obs.prepare(origin);
    assert.ok(disabled.calls.some(x => x.type === 'CreateInput'));
    for (const status of [204, 500, 504, 600]) {
        const invalid = fixture(t), call = invalid.obs.call;
        invalid.obs.call = (type, data) => type === 'GetReplayBufferStatus' ? Promise.reject(Error(`OBS GetReplayBufferStatus failed (${status})`)) : call(type, data);
        await assert.rejects(invalid.obs.prepare(origin), /failed/);
        assert.deepEqual(mutations(invalid.calls), []);
    }
});

test('new normal, layered and game stages retire when hidden without changing render quality or audio routing', async t => {
    for (const variant of [
        { env: {}, options: {}, count: 1 },
        { env: {}, options: { mode: 'layered' }, count: 5 },
        { env: { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire' }, options: {}, count: 1 },
    ]) {
        const r = fixture(t, variant); await r.obs.prepare(origin, variant.options);
        const sources = r.calls.filter(x => x.type === 'CreateInput' && x.data.inputKind === 'browser_source');
        assert.equal(sources.length, variant.count);
        for (const { data: { inputSettings: s } } of sources) {
            assert.deepEqual([s.width, s.height, s.fps, s.shutdown, s.restart_when_active], [1920, 1080, 30, true, false]);
            assert.ok(s.url.includes(r.c.viewToken));
        }
        assert.equal(sources.filter(x => x.data.inputSettings.reroute_audio).length, 1);
        assert.ok(!r.calls.some(x => ['StartStream', 'StartRecord', 'SetStreamServiceSettings', 'SetVideoSettings'].includes(x.type)));
    }
});

test('existing target requires exact source kind and stage URL ownership before any mutation', async t => {
    for (const [kind, url] of [
        ['image_source', stageURL()], ['browser_source', 'https://example.test/stage#token=private'],
        ['browser_source', `${origin}/other#token=private`], ['browser_source', `${origin}/stage?token=private`],
        ['browser_source', stageURL('&layer=avatar')], ['browser_source', stageURL('&layout=game')],
    ]) {
        const r = fixture(t); r.obs.call = async (type, data) => {
            r.calls.push({ type, data });
            if (['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(type)) return { outputActive: false };
            if (type === 'GetInputList') return { inputs: [{ inputName: r.c.obsInput, inputKind: kind }] };
            if (type === 'GetInputSettings') return { inputSettings: { url } };
            throw Error('Unexpected mutation');
        };
        await assert.rejects(r.obs.prepare(origin), /専用ソース/);
        assert.deepEqual(mutations(r.calls), []);
    }
});

test('inactive known stage is retired only after replacement is selected; unrelated and visible sources stay intact', async t => {
    const inputs = [
        { inputName: 'JVS Background', inputKind: 'browser_source' },
        { inputName: 'JVS Avatar', inputKind: 'browser_source' },
        { inputName: 'JVS Comment', inputKind: 'browser_source' },
        { inputName: 'JVS Overlay', inputKind: 'browser_source' },
        { inputName: 'Someone else', inputKind: 'browser_source' },
    ];
    const r = fixture(t, { inputs, settings: {
        'JVS Background': { url: stageURL('&layer=background'), shutdown: false, width: 1234 },
        'JVS Avatar': { url: stageURL('&layer=avatar'), shutdown: false },
        'JVS Comment': { url: 'https://other.test/stage#token=private&layer=comments', shutdown: false },
        'JVS Overlay': { url: stageURL('&layer=overlay'), shutdown: true },
        'Someone else': { url: stageURL(), shutdown: false },
    }, activity: { 'JVS Avatar': { videoActive: false, videoShowing: true } } });
    await r.obs.prepare(origin);
    const edits = r.calls.filter(x => x.type === 'SetInputSettings');
    assert.deepEqual(edits, [{ type: 'SetInputSettings', data: { inputName: 'JVS Background', inputSettings: { shutdown: true }, overlay: true } }]);
    assert.ok(r.calls.indexOf(edits[0]) > r.calls.findIndex(x => x.type === 'SetCurrentProgramScene'));
    assert.ok(!r.calls.some(x => x.type === 'GetInputSettings' && x.data.inputName === 'Someone else'));
});

test('GetSourceActive requires both official response flags to be false before retirement', async t => {
    for (const active of [{ videoActive: true, videoShowing: false }, { videoActive: false, videoShowing: true }, { videoActive: false }, {}]) {
        const r = fixture(t, { inputs: [{ inputName: 'JVS Background', inputKind: 'browser_source' }], settings: {
            'JVS Background': { url: stageURL('&layer=background'), shutdown: false },
        }, activity: { 'JVS Background': active } });
        await r.obs.prepare(origin);
        assert.deepEqual(r.calls.find(x => x.type === 'GetSourceActive').data, { sourceName: 'JVS Background' });
        assert.ok(!r.calls.some(x => x.type === 'SetInputSettings'));
    }
});

test('retirement waits briefly for the old stage to leave a scene transition', async t => {
    const r = fixture(t, { inputs: [{ inputName: 'JVS Background', inputKind: 'browser_source' }], settings: {
        'JVS Background': { url: stageURL('&layer=background'), shutdown: false },
    } }), invoke = r.obs.call; let reads = 0;
    r.obs.call = async (type, data) => {
        const response = await invoke(type, data);
        return type === 'GetSourceActive' && ++reads === 1 ? { videoActive: true, videoShowing: true } : response;
    };
    await r.obs.prepare(origin);
    assert.equal(reads, 2);
    assert.deepEqual(r.calls.filter(x => x.type === 'SetInputSettings').map(x => x.data), [
        { inputName: 'JVS Background', inputSettings: { shutdown: true }, overlay: true },
    ]);
    const lastRead = r.calls.findLastIndex(x => x.type === 'GetSourceActive');
    const change = r.calls.findIndex(x => x.type === 'SetInputSettings');
    assert.ok(r.calls.slice(lastRead + 1, change).some(x => x.type === 'GetInputSettings'), 'ownership is checked after the wait');
    assert.ok(r.calls.slice(lastRead + 1, change).some(x => x.type === 'GetRecordStatus'), 'output is checked after the wait');
});

test('a persistently visible stage is left alone after the bounded observation window', { timeout: 5000 }, async t => {
    const r = fixture(t, { inputs: [{ inputName: 'JVS Background', inputKind: 'browser_source' }], settings: {
        'JVS Background': { url: stageURL('&layer=background'), shutdown: false },
    }, activity: { 'JVS Background': { videoActive: false, videoShowing: true } } });
    const start = performance.now();
    await r.obs.prepare(origin);
    const elapsed = performance.now() - start, reads = r.calls.filter(x => x.type === 'GetSourceActive');
    assert.ok(reads.length > 1 && reads.length <= 7);
    assert.ok(elapsed >= 1400 && elapsed < 3000, 'does not wait indefinitely for a visible preview');
    assert.ok(!r.calls.some(x => x.type === 'SetInputSettings'));
});

test('official RPC error envelope preserves GetReplayBufferStatus 604 handling', async t => {
    class ProtocolWS extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.emit({ op: 0, d: { rpcVersion: 1 } })); }
        emit(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
        send(raw) {
            const message = JSON.parse(raw);
            if (message.op === 1) return queueMicrotask(() => this.emit({ op: 2, d: { negotiatedRpcVersion: 1 } }));
            const { requestType, requestId } = message.d;
            assert.ok(['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus'].includes(requestType));
            const unavailable = requestType === 'GetReplayBufferStatus';
            queueMicrotask(() => this.emit({ op: 7, d: { requestType, requestId,
                requestStatus: unavailable ? { result: false, code: 604, comment: 'Replay buffer is not available.' } : { result: true, code: 100 },
                ...(!unavailable ? { responseData: { outputActive: false } } : {}),
            } }));
        }
        close() { this.dispatchEvent(new Event('close')); }
    }
    const obs = new OBS(setup(t), ProtocolWS);
    t.after(() => obs.close());
    await obs.assertOutputsStopped();
});

test('existing current stage is updated once, re-enabled and supplied with fresh renderer identity', async t => {
    const r = fixture(t), invoke = r.obs.call;
    r.obs.call = (type, data) => {
        if (type === 'GetInputList') return Promise.resolve({ inputs: [{ inputName: r.c.obsInput, inputKind: 'browser_source' }] });
        if (type === 'GetInputSettings') return Promise.resolve({ inputSettings: { url: stageURL(), shutdown: false } });
        if (type === 'GetSceneItemList') return Promise.resolve({ sceneItems: [{ sourceName: r.c.obsInput, sceneItemId: 42, sceneItemEnabled: false }] });
        return invoke(type, data);
    };
    await r.obs.prepare(origin);
    const edits = r.calls.filter(x => x.type === 'SetInputSettings'); assert.equal(edits.length, 1);
    const s = edits[0].data.inputSettings;
    assert.equal(s.shutdown, true); assert.match(s.url, /&output=obs&rendererKey=current-renderer-capability$/);
    assert.ok(r.calls.some(x => x.type === 'SetSceneItemEnabled' && x.data.sceneItemId === 42 && x.data.sceneItemEnabled === true));
    assert.equal(r.calls.at(-1).type, 'SetCurrentProgramScene');
});

test('retirement rechecks source ownership and output state immediately before changing settings', async t => {
    for (const change of ['ownership', 'output']) {
        const r = fixture(t, { inputs: [{ inputName: 'JVS Background', inputKind: 'browser_source' }], settings: {
            'JVS Background': { url: stageURL('&layer=background'), shutdown: false },
        } }), invoke = r.obs.call; let selected = false;
        r.obs.call = (type, data) => {
            if (type === 'SetCurrentProgramScene') selected = true;
            if (selected && change === 'ownership' && type === 'GetInputSettings') return Promise.resolve({ inputSettings: { url: 'https://other.test/' } });
            if (selected && change === 'output' && type === 'GetRecordStatus') return Promise.resolve({ outputActive: true });
            return invoke(type, data);
        };
        if (change === 'output') await assert.rejects(r.obs.prepare(origin), /停止/); else await r.obs.prepare(origin);
        assert.ok(!r.calls.some(x => x.type === 'SetInputSettings'));
    }
});

test('a stage left on a local Studio port that no longer answers is re-pointed; a running one is never taken', async t => {
    const old = 'http://127.0.0.1:8795/stage#token=old-capability';
    for (const [answers, outcome] of [[false, 'repointed'], [true, 'refused']]) {
        const r = fixture(t, { inputs: [{ inputName: 'Jev Stage', inputKind: 'browser_source' }], settings: { 'Jev Stage': { url: old } } });
        const asked = []; r.c.originAnswers = async o => { asked.push(o); return answers; };
        if (outcome === 'refused') {
            await assert.rejects(r.obs.prepare(origin), /いま動いている別のStudio（127\.0\.0\.1:8795）/);
            assert.ok(!r.calls.some(x => x.type === 'SetInputSettings'), 'a Studio that still answers keeps its stage');
        } else {
            await r.obs.prepare(origin);
            const set = r.calls.find(x => x.type === 'SetInputSettings' && x.data.inputName === 'Jev Stage');
            assert.ok(set && new URL(set.data.inputSettings.url).origin === origin, 'the stage now shows this Studio');
        }
        assert.deepEqual(asked, ['http://127.0.0.1:8795']);
    }
});

test('a foreign page under the stage name is never re-pointed and the message says what to do', async t => {
    for (const url of ['https://example.test/stage#token=x', 'http://192.168.1.5:8795/stage#token=x', `http://127.0.0.1:8795/other#token=x`]) {
        const r = fixture(t, { inputs: [{ inputName: 'Jev Stage', inputKind: 'browser_source' }], settings: { 'Jev Stage': { url } } });
        r.c.originAnswers = async () => { throw Error('must not probe a foreign page'); };
        await assert.rejects(r.obs.prepare(origin), /名前を変えるか削除/);
        assert.ok(!r.calls.some(x => x.type === 'SetInputSettings'));
    }
});
