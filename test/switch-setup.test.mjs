import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchSetup } from '../src/switch-setup.mjs';

const clone = v => structuredClone(v), NONE = 'OBS_MONITORING_TYPE_NONE';
const transform = () => ({ positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_NONE', boundsAlignment: 0,
    boundsWidth: 0, boundsHeight: 0, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 });
function harness(t, { audioSource = true } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'noa-switch-setup-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    let serial = 10, now = 1000000;
    const state = { scenes: [{ sceneName: 'Existing Programme', sceneUuid: 'scene-existing', items: [] }], current: 'Existing Programme', inputs: [],
        stream: { outputActive: false, outputReconnecting: false }, record: { outputActive: false }, replay: { outputActive: false },
        videoDevices: [{ itemName: 'FaceTime HD Camera', itemValue: 'BUILTIN-PRIVATE', itemEnabled: true }, { itemName: 'UGREEN USB Video', itemValue: 'VIDEO-UID-PRIVATE', itemEnabled: true },
            { itemName: 'Other USB Video', itemValue: 'VIDEO2-UID-PRIVATE', itemEnabled: true }, { itemName: 'Disconnected USB Video', itemValue: 'offline', itemEnabled: false }],
        audioDevices: [{ itemName: 'Default', itemValue: 'default', itemEnabled: true }, { itemName: 'MacBook Pro Microphone', itemValue: 'builtin-audio', itemEnabled: true },
            { itemName: 'USB Audio', itemValue: 'AUDIO-UID-PRIVATE', itemEnabled: true }, { itemName: 'Other USB Audio', itemValue: 'AUDIO2-UID-PRIVATE', itemEnabled: true }],
        presets: [{ itemName: 'High', itemValue: 'AVCaptureSessionPresetHigh', itemEnabled: true }, { itemName: '1920x1080', itemValue: 'AVCaptureSessionPreset1920x1080', itemEnabled: true }], fail: null, replayDisabled: false };
    if (audioSource) state.inputs.push({ inputName: 'Mic/Aux', inputUuid: 'existing-mic', inputKind: 'coreaudio_input_capture', settings: { device_id: 'builtin-audio', enable_downmix: true }, muted: true, monitor: NONE });
    const calls = [], mutations = [];
    const obs = { async call(type, d = {}) {
        calls.push({ type, data: clone(d) });
        if (!type.startsWith('Get')) mutations.push({ type, data: clone(d) });
        if (state.fail?.(type, d)) throw Error('private diagnostic or serial must never escape');
        const input = () => { const i = state.inputs.find(i => i.inputName === d.inputName); if (!i) throw Error('missing input'); return i; };
        const scene = () => { const s = state.scenes.find(s => s.sceneName === d.sceneName); if (!s) throw Error('missing scene'); return s; };
        const item = () => { const i = scene().items.find(i => i.sceneItemId === d.sceneItemId); if (!i) throw Error('missing item'); return i; };
        if (type === 'GetStreamStatus') return clone(state.stream);
        if (type === 'GetRecordStatus') return clone(state.record);
        if (type === 'GetReplayBufferStatus') { if (state.replayDisabled) throw Error('OBS GetReplayBufferStatus failed (604)'); return clone(state.replay); }
        if (type === 'GetSceneList') return { currentProgramSceneName: state.current, scenes: state.scenes.map(({ sceneName, sceneUuid }) => ({ sceneName, sceneUuid })) };
        if (type === 'GetInputList') return { inputs: state.inputs.map(({ inputName, inputUuid, inputKind }) => ({ inputName, inputUuid, inputKind })) };
        if (type === 'GetInputKindList') return { inputKinds: ['macos-avcapture', 'macos-avcapture-fast', 'coreaudio_input_capture'] };
        if (type === 'GetInputDefaultSettings') return { defaultInputSettings: { device: '', use_preset: true, preset: 'AVCaptureSessionPresetHigh', enable_audio: true } };
        if (type === 'GetSceneItemList') return { sceneItems: clone(scene().items) };
        if (type === 'GetInputSettings') return { inputKind: input().inputKind, inputSettings: clone(input().settings) };
        if (type === 'GetInputMute') return { inputMuted: input().muted };
        if (type === 'GetInputAudioMonitorType') return { monitorType: input().monitor };
        if (type === 'GetSceneItemTransform') return { sceneItemTransform: clone(item().transform) };
        if (type === 'GetInputPropertiesListPropertyItems') {
            input();
            return { propertyItems: clone(d.propertyName === 'device' ? state.videoDevices : d.propertyName === 'device_id' ? state.audioDevices : d.propertyName === 'preset' ? state.presets : []) };
        }
        if (type === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 };
        if (type === 'CreateScene') { const s = { sceneName: d.sceneName, sceneUuid: `scene-${++serial}`, items: [] }; state.scenes.push(s); return { sceneUuid: s.sceneUuid }; }
        if (type === 'CreateInput') {
            assert.equal(d.sceneItemEnabled, false); assert.ok(!state.inputs.some(i => i.inputName === d.inputName));
            const uuid = `input-${++serial}`, id = ++serial;
            state.inputs.push({ inputName: d.inputName, inputUuid: uuid, inputKind: d.inputKind, settings: clone(d.inputSettings), muted: false, monitor: NONE });
            scene().items.push({ sceneItemId: id, sourceName: d.inputName, sourceUuid: uuid, inputKind: d.inputKind, sceneItemEnabled: false, transform: transform() });
            return { inputUuid: uuid, sceneItemId: id };
        }
        if (type === 'SetInputMute') { input().muted = d.inputMuted; return {}; }
        if (type === 'SetInputAudioMonitorType') { input().monitor = d.monitorType; return {}; }
        if (type === 'SetInputSettings') { input().settings = d.overlay ? { ...input().settings, ...clone(d.inputSettings) } : clone(d.inputSettings); return {}; }
        if (type === 'SetSceneItemEnabled') { item().sceneItemEnabled = d.sceneItemEnabled; return {}; }
        if (type === 'SetSceneItemTransform') {
            for (const key of ['boundsWidth', 'boundsHeight']) if (d.sceneItemTransform[key] !== undefined && d.sceneItemTransform[key] < 1) throw Error('OBS bounds must be at least 1');
            item().transform = { ...item().transform, ...clone(d.sceneItemTransform) }; return {};
        }
        if (type === 'RemoveInput') { input(); state.inputs = state.inputs.filter(i => i.inputName !== d.inputName); for (const s of state.scenes) s.items = s.items.filter(i => i.sourceName !== d.inputName); return {}; }
        if (type === 'RemoveScene') { scene(); state.scenes = state.scenes.filter(s => s.sceneName !== d.sceneName); return {}; }
        throw Error(`Unexpected OBS method: ${type}`);
    } };
    const setup = new SwitchSetup({ obs, dataDir, platform: 'darwin', now: () => now });
    const choose = scan => ({ scanId: scan.scanId, videoId: scan.videoDevices[0]?.id, audioId: scan.audioDevices[0]?.id, quality: '1080p' });
    return { setup, obs, state, calls, mutations, dataDir, choose, advance(ms) { now += ms; }, get now() { return now; } };
}

test('scan creates only empty disabled video in its own scene, exposes opaque options and selects nothing', async t => {
    const h = harness(t), original = clone(h.state.scenes[0]), scan = await h.setup.scan();
    assert.equal(scan.configured, false); assert.equal(scan.videoDevices.length, 2); assert.equal(scan.audioDevices.length, 2);
    assert.equal(scan.videoDevices[0].label, 'UGREEN USB Video'); assert.equal(scan.audioDiscovery, 'obs_properties');
    assert.doesNotMatch(JSON.stringify(scan), /UID-PRIVATE|BUILTIN|builtin-audio|device_id/);
    assert.equal(h.state.current, 'Existing Programme'); assert.deepEqual(h.state.scenes[0], original);
    const create = h.mutations.filter(c => c.type === 'CreateInput'); assert.equal(create.length, 1);
    assert.deepEqual(create[0].data.inputSettings, { device: '', enable_audio: false, use_preset: true });
    assert.equal(create[0].data.sceneItemEnabled, false); assert.equal(h.state.inputs.find(i => i.inputName === scan.videoSourceName).muted, true);
    assert.equal((await h.setup.status()).ownership, 'verified'); assert.ok((await h.setup.status()).lastScan);
    h.advance(300001); assert.equal((await h.setup.status()).lastScan, null);
    assert.doesNotMatch(readFileSync(join(h.dataDir, 'switch-setup.json'), 'utf8'), /UID-PRIVATE|device_id|BUILTIN/);
});

test('without an existing audio input scan never creates or opens a default/empty audio source', async t => {
    const h = harness(t, { audioSource: false }), scan = await h.setup.scan();
    assert.equal(scan.audioDiscovery, 'existing_audio_source_required'); assert.deepEqual(scan.audioDevices, []);
    assert.equal(h.mutations.some(c => c.type === 'CreateInput' && c.data.inputKind === 'coreaudio_input_capture'), false);
    await assert.rejects(h.setup.configure(h.choose(scan)), { code: 'SWITCH_DEVICE_REQUIRED' });
});

test('streaming, reconnecting, recording, replay and unknown outputs refuse all mutations', async t => {
    for (const state of [{ stream: { outputActive: true, outputReconnecting: false } }, { stream: { outputActive: false, outputReconnecting: true } },
        { record: { outputActive: true } }, { replay: { outputActive: true } }, { replay: {} }, { stream: { outputActive: false } }]) {
        const h = harness(t); Object.assign(h.state, state); await assert.rejects(h.setup.scan()); assert.equal(h.mutations.length, 0);
    }
    const h = harness(t); h.state.replayDisabled = true; assert.ok((await h.setup.scan()).scanId);
});

test('explicit selection applies only enumerated 1080p, one audio path and fits existing canvas without switching scenes', async t => {
    const h = harness(t), scan = await h.setup.scan(); const original = clone(h.state.scenes[0]);
    const r = await h.setup.configure(h.choose(scan)); assert.equal(r.configured, true); assert.equal(r.sceneSelected, false); assert.equal(r.signal, 'unverified');
    const video = h.state.inputs.find(i => i.inputName === r.videoSourceName), audio = h.state.inputs.find(i => i.inputName === r.audioSourceName);
    assert.equal(video.settings.device, 'VIDEO-UID-PRIVATE'); assert.equal(video.settings.preset, 'AVCaptureSessionPreset1920x1080');
    assert.equal(video.settings.enable_audio, false); assert.equal(video.muted, true); assert.equal(video.monitor, NONE);
    assert.equal(audio.settings.device_id, 'AUDIO-UID-PRIVATE'); assert.equal(audio.muted, false); assert.equal(audio.monitor, NONE);
    const scene = h.state.scenes.find(s => s.sceneName === r.sceneName); assert.equal(scene.items.length, 2); assert.ok(scene.items.every(i => i.sceneItemEnabled));
    assert.equal(scene.items[0].transform.boundsWidth, 1920); assert.equal(scene.items[0].transform.boundsHeight, 1080); assert.equal(scene.items[0].transform.boundsType, 'OBS_BOUNDS_SCALE_INNER');
    assert.equal(h.state.current, 'Existing Programme'); assert.deepEqual(h.state.scenes[0], original);
    assert.equal(h.calls.some(c => /SetCurrent|SetVideoSettings|StartStream|StreamService|Profile/.test(c.type)), false);
    assert.equal((await h.setup.validateConfigured()).ownership, 'verified');
    assert.doesNotMatch(JSON.stringify(await h.setup.status()), /UID-PRIVATE|device_id/);
});

test('1080p unsupported is an explicit error and restores the previously empty source', async t => {
    const h = harness(t), scan = await h.setup.scan(), before = clone(h.state.inputs);
    h.state.presets[1].itemEnabled = false;
    await assert.rejects(h.setup.configure(h.choose(scan)), { code: 'SWITCH_1080P_UNSUPPORTED' });
    assert.deepEqual(h.state.inputs, before); assert.equal((await h.setup.status()).configured, false); assert.equal((await h.setup.status()).ownership, 'verified');
    assert.equal(h.mutations.some(c => c.type === 'CreateInput' && c.data.inputKind === 'coreaudio_input_capture'), false);
});

test('only explicit standard quality uses the enabled OBS default preset', async t => {
    const h = harness(t), scan = await h.setup.scan(); h.state.presets[1].itemEnabled = false;
    const r = await h.setup.configure({ ...h.choose(scan), quality: 'device-default' });
    assert.equal(r.quality, 'device-default'); assert.equal(r.presetLabel, 'High');
    assert.equal(h.state.inputs.find(i => i.inputName === r.videoSourceName).settings.preset, 'AVCaptureSessionPresetHigh');
});

test('stale/forged choices, unplugged devices and missing explicit audio are rejected before capture changes', async t => {
    for (const action of ['expired', 'forged', 'unplugged', 'missing-audio']) {
        const h = harness(t), scan = await h.setup.scan(), selected = h.choose(scan), baseline = h.mutations.length;
        if (action === 'expired') h.advance(300001);
        if (action === 'forged') selected.videoId = 'VIDEO-UID-PRIVATE';
        if (action === 'unplugged') h.state.videoDevices = [];
        if (action === 'missing-audio') delete selected.audioId;
        await assert.rejects(h.setup.configure(selected)); assert.equal(h.mutations.length, baseline);
    }
});

test('same named unowned scenes, source replacement, changed device and source reuse are never adopted', async t => {
    const h = harness(t); h.state.scenes.push({ sceneName: 'JVS Switch Capture', sceneUuid: 'foreign', items: [] });
    await assert.rejects(h.setup.scan(), { code: 'SWITCH_OWNERSHIP_CHANGED' }); assert.equal(h.mutations.length, 0);
    for (const kind of ['replacement', 'device-change', 'reuse']) {
        const h = harness(t), scan = await h.setup.scan(), video = h.state.inputs.find(i => i.inputName === scan.videoSourceName), baseline = h.mutations.length;
        if (kind === 'replacement') video.inputUuid = 'foreign';
        if (kind === 'device-change') video.settings.device = 'UNAPPROVED-CAMERA';
        if (kind === 'reuse') h.state.scenes[0].items.push({ sourceName: video.inputName, sourceUuid: video.inputUuid, sceneItemId: 999, sceneItemEnabled: true });
        await assert.rejects(h.setup.configure(h.choose(scan)), { code: 'SWITCH_OWNERSHIP_CHANGED' }); assert.equal(h.mutations.length, baseline);
        assert.equal((await h.setup.status()).ownership, 'unverified');
    }
});

test('owned settings survive restart and can reconfigure without duplicate sources', async t => {
    const h = harness(t), scan = await h.setup.scan(); await h.setup.configure(h.choose(scan));
    const resumed = new SwitchSetup({ obs: h.obs, dataDir: h.dataDir, platform: 'darwin', now: () => h.now });
    assert.equal((await resumed.validateConfigured()).configured, true);
    const next = await resumed.scan(); await resumed.configure({ scanId: next.scanId, videoId: next.videoDevices[1].id, audioId: next.audioDevices[1].id, quality: 'device-default' });
    assert.equal(h.state.inputs.filter(i => i.inputName.startsWith('JVS Switch')).length, 2);
    assert.equal(h.state.inputs.find(i => i.inputName === 'JVS Switch Video').settings.device, 'VIDEO2-UID-PRIVATE');
});

test('failed reconfiguration restores both previously selected devices and their valid ownership record', async t => {
    const h = harness(t), scan = await h.setup.scan(); await h.setup.configure(h.choose(scan));
    const before = clone(h.state.inputs), next = await h.setup.scan(); h.state.presets[1].itemEnabled = false;
    await assert.rejects(h.setup.configure({ scanId: next.scanId, videoId: next.videoDevices[1].id, audioId: next.audioDevices[1].id, quality: '1080p' }), { code: 'SWITCH_1080P_UNSUPPORTED' });
    assert.deepEqual(h.state.inputs, before); const current = await h.setup.validateConfigured(); assert.equal(current.videoLabel, 'UGREEN USB Video'); assert.equal(current.quality, '1080p');
});

test('persistence failure rolls capture configuration back before reporting failure', async t => {
    const h = harness(t), scan = await h.setup.scan(), before = clone(h.state.inputs), save = h.setup.save.bind(h.setup); let failed = false;
    h.setup.save = record => { if (record.configured && !failed) { failed = true; throw Error('private path'); } return save(record); };
    await assert.rejects(h.setup.configure(h.choose(scan)), e => e.code === 'SWITCH_SETUP_FAILED' && !/private/.test(e.message));
    assert.deepEqual(h.state.inputs, before); const status = await h.setup.status(); assert.equal(status.configured, false); assert.equal(status.ownership, 'verified');
});

test('an existing same-device capture or unmuted default microphone prevents duplicate audio capture', async t => {
    for (const device of ['AUDIO-UID-PRIVATE', 'default']) {
        const h = harness(t), scan = await h.setup.scan(), baseline = h.mutations.length;
        h.state.inputs[0].settings.device_id = device; h.state.inputs[0].muted = false;
        await assert.rejects(h.setup.configure(h.choose(scan)), { code: device === 'default' ? 'SWITCH_DEFAULT_AUDIO_ACTIVE' : 'SWITCH_DEVICE_IN_USE' });
        assert.equal(h.mutations.length, baseline);
    }
});

test('partial configure failure removes new audio and restores settings, transforms and enabled flags', async t => {
    const h = harness(t), scan = await h.setup.scan(), beforeInputs = clone(h.state.inputs), beforeScenes = clone(h.state.scenes);
    let failed = false; h.state.fail = type => type === 'SetSceneItemTransform' && !failed && (failed = true);
    await assert.rejects(h.setup.configure(h.choose(scan)), e => e.code === 'SWITCH_SETUP_FAILED' && !/private/.test(e.message));
    assert.deepEqual(h.state.inputs, beforeInputs); assert.deepEqual(h.state.scenes, beforeScenes); assert.equal((await h.setup.status()).ownership, 'verified');
});

test('a newly active output prevents rollback writes and reports incomplete restoration honestly', async t => {
    const h = harness(t), scan = await h.setup.scan();
    h.state.fail = type => { if (type !== 'GetVideoSettings') return false; h.state.record.outputActive = true; return true; };
    await assert.rejects(h.setup.configure(h.choose(scan)), { code: 'SWITCH_ROLLBACK_INCOMPLETE' });
    const at = h.calls.findLastIndex(c => c.type === 'GetVideoSettings');
    assert.equal(h.calls.slice(at + 1).some(c => !c.type.startsWith('Get')), false);
    assert.equal((await h.setup.status()).configured, false);
});

test('rollback after canvas fit restores BOUNDS_NONE without sending OBS-invalid zero bounds', async t => {
    const h = harness(t), scan = await h.setup.scan(); let failed = false;
    h.state.fail = (type, d) => type === 'SetSceneItemEnabled' && d.sceneItemEnabled && !failed && (failed = true);
    await assert.rejects(h.setup.configure(h.choose(scan)), { code: 'SWITCH_SETUP_FAILED' });
    const scene = h.state.scenes.find(s => s.sceneName === scan.sceneName);
    assert.equal(scene.items[0].transform.boundsType, 'OBS_BOUNDS_NONE'); assert.equal(scene.items[0].sceneItemEnabled, false);
    assert.equal((await h.setup.status()).ownership, 'verified');
    assert.equal(h.mutations.some(c => c.type === 'SetSceneItemTransform' && (c.data.sceneItemTransform.boundsWidth === 0 || c.data.sceneItemTransform.boundsHeight === 0)), false);
});

test('rollback never removes a newly created input after it is shared into an unrelated scene', async t => {
    const h = harness(t); let failed = false;
    h.state.fail = type => {
        if (type !== 'SetInputMute' || failed) return false;
        failed = true; const v = h.state.inputs.find(i => i.inputName === 'JVS Switch Video');
        h.state.scenes[0].items.push({ sourceName: v.inputName, sourceUuid: v.inputUuid, sceneItemId: 999, sceneItemEnabled: true }); return true;
    };
    await assert.rejects(h.setup.scan(), { code: 'SWITCH_ROLLBACK_INCOMPLETE' });
    assert.equal(h.mutations.some(c => c.type === 'RemoveInput' || c.type === 'RemoveScene'), false);
    assert.equal(h.state.scenes[0].items.length, 1);
});

test('creation failure removes only newly created sources and the empty owned scene', async t => {
    const h = harness(t); let failed = false;
    h.state.fail = type => type === 'SetInputMute' && !failed && (failed = true);
    await assert.rejects(h.setup.scan(), { code: 'SWITCH_SETUP_FAILED' });
    assert.deepEqual(h.state.scenes.map(s => s.sceneName), ['Existing Programme']); assert.deepEqual(h.state.inputs.map(i => i.inputName), ['Mic/Aux']);
});

test('non-macOS and unconfigured validation fail without mutation; status stays read-only', async t => {
    const h = harness(t), other = new SwitchSetup({ obs: h.obs, dataDir: h.dataDir, platform: 'linux' });
    await assert.rejects(other.scan(), { code: 'SWITCH_MACOS_REQUIRED' }); await assert.rejects(h.setup.validateConfigured(), { code: 'SWITCH_NOT_CONFIGURED' });
    assert.equal((await h.setup.status()).configured, false); assert.equal(h.mutations.length, 0);
});
