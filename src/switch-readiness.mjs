import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const capturePattern = /ugreen|cm726|25773|usb[ _-]?video|capture|hdmi|uvc/i;
const videoKinds = /^(macos-avcapture|av_capture_input|dshow_input|v4l2_input)(?:_v\d+)?$/;
const allowed = new Set(['GetVersion', 'GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus', 'GetInputList', 'GetSceneList', 'GetSceneItemList', 'GetInputPropertiesListPropertyItems']);
const label = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/(?:wss?|https?):\/\/\S+/gi, '[URL非表示]').slice(0, 160);
const boolean = value => typeof value === 'boolean' ? value : null;

export function parseSwitchCheckArgs(argv, root) {
    const options = { studioDir: root, piHost: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--studio-dir' || arg === '--pi-host') {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENT');
            if (arg === '--studio-dir') options.studioDir = resolve(value);
            else {
                if (value.length > 253 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value)) throw new Error('INVALID_PI_HOST');
                options.piHost = value;
            }
        } else throw new Error('UNKNOWN_ARGUMENT');
    }
    return options;
}

// Read only the configuration values this diagnostic needs. Importing a different
// checkout's JavaScript, running loadEnv(), and constructing the Studio are avoided.
export function readSwitchConfig(studioDir, env = process.env) {
    const root = resolve(studioDir);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error('STUDIO_DIRECTORY_MISSING');
    const read = path => {
        if (statSync(path).size > 2 * 1024 * 1024) throw new Error('CONFIG_TOO_LARGE');
        return readFileSync(path, 'utf8');
    };
    const envPath = join(root, '.env');
    const fromFile = existsSync(envPath) ? parseEnv(read(envPath)) : {};
    const merged = { ...fromFile, ...env };
    const dataDir = resolve(root, merged.DATA_DIR || 'data');
    const settingsPath = join(dataDir, 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(read(settingsPath)) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('INVALID_SETTINGS');
    const effective = { ...merged, ...settings };
    const obsURL = effective.OBS_URL || 'ws://127.0.0.1:4455';
    const u = new URL(obsURL);
    // Metadata diagnosis has no reason to send a password to an arbitrary host.
    if (!['ws:', 'wss:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('OBS_MUST_BE_LOCAL');
    return { obsURL, obsPassword: String(effective.OBS_PASSWORD || ''), configurationFound: existsSync(envPath) || existsSync(settingsPath) };
}

export async function captureInventory({ platform = process.platform, execute = exec } = {}) {
    if (platform !== 'darwin') return { status: 'unknown', reason: 'MACOS_INVENTORY_ONLY', devices: [] };
    try {
        // This lists metadata; it does not run ffmpeg/AVFoundation or open a camera.
        const { stdout } = await execute('/usr/sbin/system_profiler', ['SPUSBDataType', 'SPCameraDataType', '-json'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
        const data = JSON.parse(stdout), found = [];
        const walk = (values, type) => {
            for (const value of Array.isArray(values) ? values : []) {
                const name = label(value._name);
                if (name && capturePattern.test(name)) found.push({ name, type });
                walk(value._items, type);
            }
        };
        walk(data.SPUSBDataType, 'usb');
        walk(data.SPCameraDataType, 'camera');
        return { status: 'observed', devices: found, note: '名称で抽出した候補です。候補が空でも未接続とは断定しません。' };
    } catch { return { status: 'unknown', reason: 'INVENTORY_UNAVAILABLE', devices: [] }; }
}

export async function inspectSwitchReadiness({ obs, inventory = captureInventory, piHost = null, now = () => new Date() }) {
    const report = {
        checkedAt: now().toISOString(), scope: 'read_only_metadata',
        obs: { connection: 'unknown', streaming: null, recording: null, replayBuffer: null, currentScene: null, sources: [], scenes: [], errors: [] },
        capture: { availability: 'unknown', inventory: null, enumeratedDevices: [], configuredVideoSources: [], videoSignal: 'unverified', audioSignal: 'unverified' },
        pi: { targetSpecified: !!piHost, connection: piHost ? 'configured_unverified' : 'unknown', automaticControl: 'not_implemented' },
        manualBroadcast: { ready: false, status: 'needs_manual_validation' },
        actionsTaken: [],
    };
    const read = async (type, data = {}) => {
        if (!allowed.has(type)) throw new Error('READ_ONLY_REQUEST_REQUIRED');
        try { return await obs.call(type, data); }
        catch (error) {
            // OBS returns 604 when this optional output is disabled, rather than
            // returning outputActive=false. Other failures remain unknown.
            if (type === 'GetReplayBufferStatus' && error.message === 'OBS GetReplayBufferStatus failed (604)') return { outputActive: false, disabled: true };
            report.obs.errors.push(type); return null;
        }
    };
    try {
        await obs.connect();
        report.obs.connection = 'connected';
        // Sequential, small requests avoid competing with the running programme.
        const version = await read('GetVersion');
        report.obs.version = version ? label(version.obsVersion) : null;
        const stream = await read('GetStreamStatus');
        const record = await read('GetRecordStatus');
        const replay = await read('GetReplayBufferStatus');
        report.obs.streaming = boolean(stream?.outputActive);
        report.obs.reconnecting = boolean(stream?.outputReconnecting);
        report.obs.recording = boolean(record?.outputActive);
        report.obs.replayBuffer = boolean(replay?.outputActive);
        const inputs = await read('GetInputList');
        const sourceInputs = Array.isArray(inputs?.inputs) ? inputs.inputs.slice(0, 128) : [];
        report.obs.sources = sourceInputs.map(s => ({ name: label(s.inputName), kind: label(s.unversionedInputKind || s.inputKind) }));
        report.obs.sourcesTruncated = (inputs?.inputs?.length || 0) > sourceInputs.length;
        const scenes = await read('GetSceneList');
        report.obs.currentScene = scenes ? label(scenes.currentProgramSceneName) : null;
        const sceneList = Array.isArray(scenes?.scenes) ? scenes.scenes.slice(0, 30) : [];
        report.obs.scenesTruncated = (scenes?.scenes?.length || 0) > sceneList.length;
        for (const scene of sceneList) {
            const items = await read('GetSceneItemList', { sceneName: scene.sceneName });
            report.obs.scenes.push({ name: label(scene.sceneName), items: items ? (items.sceneItems || []).slice(0, 128).map(s => ({ name: label(s.sourceName), enabled: boolean(s.sceneItemEnabled), group: !!s.isGroup })) : null });
        }
        const captureInputs = sourceInputs.filter(s => videoKinds.test(s.unversionedInputKind || s.inputKind || ''));
        report.capture.configuredVideoSources = captureInputs.map(s => label(s.inputName));
        for (const source of captureInputs.slice(0, 8)) {
            const kind = source.unversionedInputKind || source.inputKind;
            const devices = await read('GetInputPropertiesListPropertyItems', { inputName: source.inputName, propertyName: /^(macos-avcapture|av_capture_input)/.test(kind) ? 'device' : 'device_id' });
            for (const item of devices?.propertyItems || []) {
                if (!item.itemEnabled || !capturePattern.test(String(item.itemName))) continue;
                report.capture.enumeratedDevices.push({ source: label(source.inputName), name: label(item.itemName) });
            }
        }
    } catch {
        report.obs.connection = 'unavailable';
        report.obs.errors.push('OBS_CONNECTION_UNAVAILABLE');
    } finally { obs.close(); }
    try { report.capture.inventory = await inventory(); }
    catch { report.capture.inventory = { status: 'unknown', reason: 'INVENTORY_UNAVAILABLE', devices: [] }; }
    if (report.capture.enumeratedDevices.length || report.capture.inventory.devices?.length) report.capture.availability = 'candidate_detected';
    else if (report.capture.inventory.status === 'observed') report.capture.availability = 'no_matching_candidate_observed';
    report.manualBroadcast.status = report.obs.connection !== 'connected' ? 'obs_connection_required'
        : report.obs.streaming || report.obs.reconnecting || report.obs.recording || report.obs.replayBuffer ? 'wait_until_current_output_ends'
        : report.obs.streaming === null || report.obs.recording === null || report.obs.replayBuffer === null ? 'output_state_unknown'
        : report.capture.availability !== 'candidate_detected' ? 'capture_connection_unverified'
        : report.capture.configuredVideoSources.length === 0 ? 'capture_source_setup_required' : 'needs_manual_validation';
    report.manualBroadcast.requiredChecks = ['Switch映像が動くこと', 'ゲーム音とホストの声を録画で試聴', '3D表示と音声同期', '10分のローカル録画で負荷・欠落・音ズレを確認'];
    return report;
}
