import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// OBS 97ca37291c4e5f5c5c8a0719b8c7b897d2fbc6b5:
// plugins/mac-avcapture/OBSAVCapture.m, switchCaptureDevice: empty `device` returns before deviceInputWithDevice.
// plugins/mac-avcapture/plugin-main.m and legacy/av-capture.mm: device/use_preset/preset/enable_audio.
// plugins/mac-capture/mac-audio.c: device_id defaults to "default" and create starts capture immediately.
// audio-device-enum.c does not reject an empty UID, so we NEVER create an audio input to enumerate devices.
// https://github.com/obsproject/obs-studio/tree/97ca37291c4e5f5c5c8a0719b8c7b897d2fbc6b5/plugins
const VIDEO_KINDS = ['macos-avcapture', 'av_capture_input_v2', 'av_capture_input'];
const AUDIO_KIND = 'coreaudio_input_capture';
/** The dedicated scene and inputs this page owns. A game whose manifest says capture.kind 'switch' (docs/GAMES.md) reuses
 * the two inputs in its own programme scene, so the device is opened once and chosen in one place. */
export const SWITCH_NAMES = Object.freeze({ scene: 'JVS Switch Capture', video: 'JVS Switch Video', audio: 'JVS Switch Audio' });
const NAMES = SWITCH_NAMES;
const SCAN_TTL_MS = 5 * 60000;
const MONITOR_NONE = 'OBS_MONITORING_TYPE_NONE';
const managed = { video: ['device', 'use_preset', 'preset', 'enable_audio'], audio: ['device_id', 'enable_downmix'] };
const transformKeys = ['positionX', 'positionY', 'rotation', 'scaleX', 'scaleY', 'alignment', 'boundsType', 'boundsAlignment', 'boundsWidth', 'boundsHeight', 'cropLeft', 'cropTop', 'cropRight', 'cropBottom'];
const internal = /built[ -]?in|facetime|macbook|内蔵|continuity|iphone|ipad|既定|デフォルト/i;
const candidate = /ugreen|cm726|25773|usb|capture|hdmi|uvc/i;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const label = v => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/(?:https?|wss?):\/\/\S+/gi, '[URL]').slice(0, 120);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const transformOf = value => {
    const t = pick(value, transformKeys);
    // OBS reports 0x0 for unused bounds but its setter requires >=1. These dimensions
    // have no effect with BOUNDS_NONE and cannot be round-tripped through the RPC.
    if (t.boundsType === 'OBS_BOUNDS_NONE') { delete t.boundsWidth; delete t.boundsHeight; }
    return t;
};
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const ownershipError = () => fail('SWITCH_OWNERSHIP_CHANGED', 'Switch専用シーンまたはソースが変更されています。OBSの設定を確認してください。');
const unavailable = () => fail('SWITCH_OBS_STATE_UNKNOWN', 'OBSの状態を確認できません。接続と設定を確認してください。');
const list = (response, key, max = 512) => {
    if (!Array.isArray(response?.[key]) || response[key].length > max) throw unavailable();
    return response[key];
};

/** No stream/profile/output changes or scene selection. Device UIDs never leave this instance or OBS. */
export class SwitchSetup {
    /** sharedScene(name): a scene allowed to hold the Switch inputs besides the dedicated one (the Studio's own programme
     * scenes for a 'switch'-captured game); any other scene using them still fails the ownership check. */
    constructor({ obs, dataDir, platform = process.platform, now = Date.now, sharedScene = () => false } = {}) {
        if (!obs?.call || !dataDir) throw new TypeError('SwitchSetup requires obs and dataDir');
        Object.assign(this, { obs, dataDir, platform, now, sharedScene }); this.path = join(dataDir, 'switch-setup.json');
        this.scanCache = null; this.operations = Promise.resolve();
    }
    exclusive(fn) {
        if (typeof this.obs.serialize === 'function') return this.obs.serialize(fn);
        const p = this.operations.then(fn, fn); this.operations = p.catch(() => {}); return p;
    }
    read() {
        if (!existsSync(this.path)) return null;
        try {
            const raw = readFileSync(this.path, 'utf8'); if (raw.length > 32768) throw Error();
            const d = JSON.parse(raw);
            if (d.version !== 1 || d.sceneName !== NAMES.scene || !text(d.sceneUuid) || !object(d.inputs) || !d.inputs.video
                || Object.keys(d.inputs).some(k => !managed[k]) || Object.entries(d.inputs).some(([k, v]) => !object(v)
                    || v.name !== NAMES[k] || !text(v.uuid) || !Number.isSafeInteger(v.itemId) || v.itemId < 0
                    || !(k === 'video' ? VIDEO_KINDS.includes(v.kind) : v.kind === AUDIO_KIND) || !/^[a-f0-9]{64}$/.test(v.fingerprint))) throw Error();
            return d;
        } catch { throw ownershipError(); }
    }
    save(d) {
        mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); const temp = `${this.path}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, JSON.stringify(d), { mode: 0o600 }); renameSync(temp, this.path); }
        finally { rmSync(temp, { force: true }); }
    }
    async outputs() {
        const read = async type => {
            try { return await this.obs.call(type); }
            catch (e) { return type === 'GetReplayBufferStatus' && e.message === 'OBS GetReplayBufferStatus failed (604)' ? { outputActive: false } : null; }
        };
        const stream = await read('GetStreamStatus'), record = await read('GetRecordStatus'), replay = await read('GetReplayBufferStatus');
        const bool = v => typeof v === 'boolean' ? v : null;
        const d = { streaming: bool(stream?.outputActive), reconnecting: bool(stream?.outputReconnecting), recording: bool(record?.outputActive), replayBuffer: bool(replay?.outputActive) };
        return { ...d, state: Object.values(d).includes(true) ? 'active' : Object.values(d).includes(null) ? 'unknown' : 'stopped' };
    }
    async stopped() {
        if (this.platform !== 'darwin') throw fail('SWITCH_MACOS_REQUIRED', 'この簡単設定はmacOSのOBSに対応しています。');
        const o = await this.outputs();
        if (o.state !== 'stopped') throw fail(o.state === 'active' ? 'SWITCH_OUTPUT_ACTIVE' : 'SWITCH_OBS_STATE_UNKNOWN', '配信・録画・リプレイバッファが停止していることを確認してから設定してください。');
        return o;
    }
    async mutate(type, data) { await this.stopped(); return this.obs.call(type, data); }
    async inventory() {
        const scenes = await this.obs.call('GetSceneList'), inputs = await this.obs.call('GetInputList');
        return { scenes: list(scenes, 'scenes', 128), inputs: list(inputs, 'inputs'), current: scenes.currentProgramSceneName };
    }
    async snapshot(record, { verify = true } = {}) {
        const inv = await this.inventory();
        if (!inv.scenes.some(s => s.sceneName === record.sceneName && s.sceneUuid === record.sceneUuid)) throw ownershipError();
        const items = list(await this.obs.call('GetSceneItemList', { sceneName: record.sceneName }), 'sceneItems');
        if (items.length !== Object.keys(record.inputs).length) throw ownershipError();
        const out = {};
        for (const [key, source] of Object.entries(record.inputs)) {
            const input = inv.inputs.find(i => i.inputName === source.name && i.inputUuid === source.uuid);
            const item = items.find(i => i.sceneItemId === source.itemId && i.sourceName === source.name && i.sourceUuid === source.uuid);
            if (!input || !item || input.inputKind !== source.kind || typeof item.sceneItemEnabled !== 'boolean') throw ownershipError();
            const settings = (await this.obs.call('GetInputSettings', { inputName: source.name })).inputSettings;
            const muted = (await this.obs.call('GetInputMute', { inputName: source.name })).inputMuted;
            const monitor = (await this.obs.call('GetInputAudioMonitorType', { inputName: source.name })).monitorType;
            const transform = key === 'video' ? (await this.obs.call('GetSceneItemTransform', { sceneName: record.sceneName, sceneItemId: source.itemId })).sceneItemTransform : null;
            if (!object(settings) || typeof muted !== 'boolean' || ![MONITOR_NONE, 'OBS_MONITORING_TYPE_MONITOR_ONLY', 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'].includes(monitor) || key === 'video' && !object(transform)) throw unavailable();
            const fingerprint = hash({ settings: pick(settings, managed[key]), muted, monitor, enabled: item.sceneItemEnabled, transform: transform ? transformOf(transform) : null });
            if (verify && source.fingerprint !== fingerprint) throw ownershipError();
            out[key] = { settings, muted, monitor, enabled: item.sceneItemEnabled, transform: transform ? transformOf(transform) : null, fingerprint };
        }
        await this.assertUnshared(record, inv);
        return out;
    }
    async assertUnshared(record, inv = null) {
        inv ??= await this.inventory();
        // Reusing these inputs, or nesting the dedicated scene elsewhere, makes mutations affect another scene.
        const names = new Set([record.sceneName, ...Object.values(record.inputs).map(s => s.name)]), visited = new Set();
        const check = async (name, group = false, depth = 0) => {
            if (depth > 8 || visited.size > 128) throw ownershipError();
            const id = `${group}:${name}`; if (visited.has(id)) return; visited.add(id);
            const entries = list(await this.obs.call(group ? 'GetGroupSceneItemList' : 'GetSceneItemList', { sceneName: name }), 'sceneItems');
            for (const i of entries) { if (names.has(i.sourceName)) throw ownershipError(); if (i.isGroup) await check(i.sourceName, true, depth + 1); }
        };
        for (const scene of inv.scenes) if (scene.sceneUuid !== record.sceneUuid && !this.sharedScene(scene.sceneName)) await check(scene.sceneName);
    }
    async captureRecord(record) {
        const snapshot = await this.snapshot(record, { verify: false });
        for (const [key, s] of Object.entries(snapshot)) record.inputs[key].fingerprint = s.fingerprint;
        return record;
    }
    async removeCreated(created) {
        // Never remove a same-named replacement or a scene into which someone added an unrelated item.
        for (const source of [...created.inputs].reverse()) {
            const inv = await this.inventory(), found = inv.inputs.find(i => i.inputName === source.name);
            if (!found) continue;
            if (found.inputUuid !== source.uuid) throw ownershipError();
            await this.assertUnshared({ sceneName: NAMES.scene, sceneUuid: created.scene?.uuid ?? inv.scenes.find(s => s.sceneName === NAMES.scene)?.sceneUuid,
                inputs: { created: source } }, inv);
            await this.mutate('RemoveInput', { inputName: source.name });
        }
        if (created.scene) {
            const inv = await this.inventory(), scene = inv.scenes.find(s => s.sceneName === created.scene.name);
            if (!scene) return;
            if (scene.sceneUuid !== created.scene.uuid || list(await this.obs.call('GetSceneItemList', { sceneName: scene.sceneName }), 'sceneItems').length) throw ownershipError();
            await this.mutate('RemoveScene', { sceneName: scene.sceneName });
        }
    }
    async createInput(record, key, kind, settings, created) {
        const r = await this.mutate('CreateInput', { sceneName: record.sceneName, inputName: NAMES[key], inputKind: kind, inputSettings: settings, sceneItemEnabled: false });
        if (!text(r.inputUuid) || !Number.isSafeInteger(r.sceneItemId)) throw unavailable();
        const input = { name: NAMES[key], uuid: r.inputUuid, itemId: r.sceneItemId, kind };
        created.inputs.push(input); record.inputs[key] = input;
        return input;
    }
    async ensureOwned() {
        const existing = this.read(); if (existing) { await this.snapshot(existing); return existing; }
        const inv = await this.inventory();
        if (inv.scenes.some(s => s.sceneName === NAMES.scene) || inv.inputs.some(i => [NAMES.video, NAMES.audio].includes(i.inputName))) throw ownershipError();
        const kinds = list(await this.obs.call('GetInputKindList', { unversioned: false }), 'inputKinds'), kind = VIDEO_KINDS.find(k => kinds.includes(k));
        if (!kind) throw fail('SWITCH_CAPTURE_UNAVAILABLE', 'OBSのmacOS映像キャプチャが利用できません。');
        const created = { scene: null, inputs: [] };
        try {
            const scene = await this.mutate('CreateScene', { sceneName: NAMES.scene });
            if (!text(scene.sceneUuid)) throw unavailable();
            created.scene = { name: NAMES.scene, uuid: scene.sceneUuid };
            const record = { version: 1, sceneName: NAMES.scene, sceneUuid: scene.sceneUuid, inputs: {}, configured: false };
            await this.createInput(record, 'video', kind, { device: '', enable_audio: false, use_preset: true }, created);
            await this.mutate('SetInputMute', { inputName: NAMES.video, inputMuted: true });
            await this.mutate('SetInputAudioMonitorType', { inputName: NAMES.video, monitorType: MONITOR_NONE });
            await this.captureRecord(record); this.save(record); return record;
        } catch (e) {
            try { await this.removeCreated(created); } catch { throw fail('SWITCH_ROLLBACK_INCOMPLETE', '準備を中断しました。専用シーンの復元を確認できないため、OBSを確認してください。'); }
            throw e.code ? e : fail('SWITCH_SETUP_FAILED', 'Switch専用シーンを準備できませんでした。');
        }
    }
    async devices(inputName, propertyName) {
        const rows = list(await this.obs.call('GetInputPropertiesListPropertyItems', { inputName, propertyName }), 'propertyItems', 128), seen = new Set();
        return rows.filter(i => i.itemEnabled === true && text(i.itemValue) && !/^default$/i.test(i.itemValue) && text(i.itemName)
            && !internal.test(i.itemName) && !internal.test(i.itemValue) && !seen.has(i.itemValue) && seen.add(i.itemValue))
            .map(i => ({ value: i.itemValue, label: label(i.itemName), suggested: candidate.test(i.itemName) }));
    }
    async audioDevices() {
        const inputs = list(await this.obs.call('GetInputList'), 'inputs');
        const source = inputs.find(i => i.inputKind === AUDIO_KIND || i.unversionedInputKind === AUDIO_KIND);
        return source ? { devices: await this.devices(source.inputName, 'device_id'), discovery: 'obs_properties' }
            : { devices: [], discovery: 'existing_audio_source_required' };
    }
    scan() { return this.exclusive(async () => {
        await this.stopped(); const record = await this.ensureOwned();
        const video = await this.devices(record.inputs.video.name, 'device'), audio = await this.audioDevices();
        const wrap = values => values.map(d => ({ ...d, id: randomUUID() }));
        this.scanCache = { scanId: randomUUID(), expiresAt: this.now() + SCAN_TTL_MS, video: wrap(video), audio: wrap(audio.devices), audioDiscovery: audio.discovery };
        return { ...this.publicRecord(record), ...this.publicScan() };
    }); }
    publicScan() {
        const s = this.scanCache; if (!s || s.expiresAt <= this.now()) return null;
        const entries = items => items.map(({ id, label, suggested }) => ({ id, label, suggested }));
        return { scanId: s.scanId, expiresAt: s.expiresAt, videoDevices: entries(s.video), audioDevices: entries(s.audio), audioDiscovery: s.audioDiscovery,
            note: s.audioDiscovery === 'existing_audio_source_required' ? 'OBSに既存の音声入力ソースがないため、機器を開かずに音声候補を列挙できません。' : '機器名の候補です。選択後にSwitchの映像と音を確認してください。' };
    }
    publicRecord(r) {
        return { configured: r?.configured === true, sceneName: r?.sceneName ?? null, videoSourceName: r?.inputs.video?.name ?? null,
            audioSourceName: r?.inputs.audio?.name ?? null, quality: r?.quality ?? null, videoLabel: label(r?.videoLabel), audioLabel: label(r?.audioLabel) };
    }
    async status() {
        const output = await this.outputs(); let record = null, ownership = 'unconfigured';
        try { record = this.read(); if (record) { await this.snapshot(record); ownership = 'verified'; } }
        catch { ownership = 'unverified'; }
        return { ...this.publicRecord(record), configured: record?.configured === true && ownership === 'verified', ownership, output,
            lastScan: this.publicScan(), note: '設定完了は映像信号・音声・配信品質の確認を意味しません。' };
    }
    async validateConfigured() {
        const output = await this.stopped(), record = this.read();
        if (!record?.configured) throw fail('SWITCH_NOT_CONFIGURED', 'Switchの映像機器と音声機器を設定してください。');
        await this.snapshot(record); return { ...this.publicRecord(record), output, ownership: 'verified' };
    }
    async duplicates(record, video, audio) {
        const owned = new Set(Object.values(record.inputs).map(s => s.uuid));
        for (const input of list(await this.obs.call('GetInputList'), 'inputs')) {
            if (owned.has(input.inputUuid)) continue;
            if (!VIDEO_KINDS.includes(input.inputKind) && !['macos-avcapture-fast', AUDIO_KIND].includes(input.inputKind)) continue;
            const s = (await this.obs.call('GetInputSettings', { inputName: input.inputName })).inputSettings;
            if (!object(s)) throw unavailable();
            if (s.device === video.value || s.device_id === audio.value) throw fail('SWITCH_DEVICE_IN_USE', '選択した機器は別のOBSソースで使われています。二重取り込みを避けるため、既存ソースを確認してください。');
            if (input.inputKind === AUDIO_KIND && (!s.device_id || s.device_id === 'default')) {
                const muted = (await this.obs.call('GetInputMute', { inputName: input.inputName })).inputMuted;
                if (muted !== true) throw fail('SWITCH_DEFAULT_AUDIO_ACTIVE', '既定の音声入力が有効です。音声の二重取り込みを避けるため、OBS側で対象を確認してください。');
            }
        }
    }
    configure(selection) { return this.exclusive(async () => {
        await this.stopped();
        const cache = this.scanCache;
        if (!object(selection) || !cache || cache.expiresAt <= this.now() || selection.scanId !== cache.scanId) throw fail('SWITCH_SCAN_EXPIRED', '機器候補をもう一度読み込んでください。');
        if (!['1080p', 'device-default'].includes(selection.quality)) throw fail('SWITCH_QUALITY_INVALID', '画質を選択してください。');
        const video = cache.video.find(d => d.id === selection.videoId), audio = cache.audio.find(d => d.id === selection.audioId);
        if (!video || !audio) throw fail('SWITCH_DEVICE_REQUIRED', '映像機器と音声機器をそれぞれ選択してください。');
        const record = this.read(); if (!record) throw ownershipError();
        const before = await this.snapshot(record), previous = structuredClone(record);
        if (!(await this.devices(record.inputs.video.name, 'device')).some(d => d.value === video.value)
            || !(await this.audioDevices()).devices.some(d => d.value === audio.value)) throw fail('SWITCH_DEVICE_MISSING', '選択した機器が見つかりません。接続を確認して候補を読み直してください。');
        await this.duplicates(record, video, audio);
        const defaults = (await this.obs.call('GetInputDefaultSettings', { inputKind: record.inputs.video.kind })).defaultInputSettings;
        if (!text(defaults?.preset)) throw fail('SWITCH_PRESET_UNAVAILABLE', 'OBSの対応プリセットを確認できません。');
        const created = { scene: null, inputs: [] }; let changed = false;
        try {
            // Mute is required even when enable_audio=false: the modern plug-in declares that key
            // but does not consistently use it to suppress muxed audio. Monitoring must also be off.
            changed = true;
            await this.mutate('SetInputMute', { inputName: NAMES.video, inputMuted: true });
            await this.mutate('SetInputAudioMonitorType', { inputName: NAMES.video, monitorType: MONITOR_NONE });
            await this.mutate('SetInputSettings', { inputName: NAMES.video, inputSettings: { device: video.value, enable_audio: false, use_preset: true, preset: defaults.preset }, overlay: true });
            const presets = list(await this.obs.call('GetInputPropertiesListPropertyItems', { inputName: NAMES.video, propertyName: 'preset' }), 'propertyItems', 128);
            const preset = presets.find(p => p.itemEnabled === true && text(p.itemValue) && (selection.quality === '1080p' ? /^1920\s*[x×]\s*1080$/.test(p.itemName) : p.itemValue === defaults.preset));
            if (!preset) throw fail(selection.quality === '1080p' ? 'SWITCH_1080P_UNSUPPORTED' : 'SWITCH_PRESET_UNAVAILABLE', selection.quality === '1080p' ? 'この機器で1080pの対応プリセットを確認できません。画質を選び直してください。' : 'この機器の標準プリセットを確認できません。');
            await this.mutate('SetInputSettings', { inputName: NAMES.video, inputSettings: { preset: preset.itemValue }, overlay: true });
            if (!record.inputs.audio) await this.createInput(record, 'audio', AUDIO_KIND, { device_id: audio.value, enable_downmix: true }, created);
            else await this.mutate('SetInputSettings', { inputName: NAMES.audio, inputSettings: { device_id: audio.value, enable_downmix: true }, overlay: true });
            await this.mutate('SetInputMute', { inputName: NAMES.audio, inputMuted: false });
            await this.mutate('SetInputAudioMonitorType', { inputName: NAMES.audio, monitorType: MONITOR_NONE });
            const canvas = await this.obs.call('GetVideoSettings');
            if (![canvas.baseWidth, canvas.baseHeight].every(n => Number.isSafeInteger(n) && n >= 320 && n <= 8192)) throw unavailable();
            await this.mutate('SetSceneItemTransform', { sceneName: record.sceneName, sceneItemId: record.inputs.video.itemId, sceneItemTransform: {
                positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0,
                boundsWidth: canvas.baseWidth, boundsHeight: canvas.baseHeight, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 } });
            for (const s of Object.values(record.inputs)) await this.mutate('SetSceneItemEnabled', { sceneName: record.sceneName, sceneItemId: s.itemId, sceneItemEnabled: true });
            record.configured = true; record.quality = selection.quality; record.videoLabel = video.label; record.audioLabel = audio.label;
            await this.captureRecord(record); await this.stopped(); this.save(record);
            return { ...this.publicRecord(record), presetLabel: label(preset.itemName), ownership: 'verified', signal: 'unverified', sceneSelected: false };
        } catch (e) {
            if (changed) {
                try {
                    // Verify exact identities before any undo; never repair a same-named replacement.
                    const inv = await this.inventory();
                    if (!inv.scenes.some(s => s.sceneName === previous.sceneName && s.sceneUuid === previous.sceneUuid)) throw ownershipError();
                    await this.assertUnshared(record, inv);
                    for (const [key, s] of Object.entries(previous.inputs)) {
                        if (!inv.inputs.some(i => i.inputName === s.name && i.inputUuid === s.uuid && i.inputKind === s.kind)) throw ownershipError();
                        const old = before[key];
                        await this.mutate('SetInputSettings', { inputName: s.name, inputSettings: old.settings, overlay: false });
                        await this.mutate('SetInputMute', { inputName: s.name, inputMuted: old.muted });
                        await this.mutate('SetInputAudioMonitorType', { inputName: s.name, monitorType: old.monitor });
                        await this.mutate('SetSceneItemEnabled', { sceneName: previous.sceneName, sceneItemId: s.itemId, sceneItemEnabled: old.enabled });
                        if (old.transform) await this.mutate('SetSceneItemTransform', { sceneName: previous.sceneName, sceneItemId: s.itemId, sceneItemTransform: old.transform });
                    }
                    await this.removeCreated(created); await this.snapshot(previous); this.save(previous);
                } catch { throw fail('SWITCH_ROLLBACK_INCOMPLETE', '設定を中断しました。専用シーンの復元を確認できないため、OBSを確認してください。'); }
            }
            throw e.code ? e : fail('SWITCH_SETUP_FAILED', 'Switchの設定を適用できませんでした。以前の設定へ戻しました。');
        }
    }); }
}
