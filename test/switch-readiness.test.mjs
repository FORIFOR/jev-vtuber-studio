import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSwitchCheckArgs, readSwitchConfig, captureInventory, inspectSwitchReadiness } from '../src/switch-readiness.mjs';

const inventory = async () => ({ status: 'observed', devices: [{ name: 'UGREEN USB Video', type: 'camera' }] });
function fixture(overrides = {}) {
    const calls = [];
    const replies = {
        GetVersion: { obsVersion: '32.2.2' }, GetStreamStatus: { outputActive: false, outputReconnecting: false },
        GetRecordStatus: { outputActive: false }, GetReplayBufferStatus: { outputActive: false },
        GetInputList: { inputs: [{ inputName: 'Switch映像', inputKind: 'av_capture_input_v2', unversionedInputKind: 'av_capture_input' }, { inputName: 'Jev Stage', inputKind: 'browser_source' }] },
        GetSceneList: { currentProgramSceneName: 'Noa Switch', scenes: [{ sceneName: 'Noa Switch' }] },
        GetSceneItemList: { sceneItems: [{ sourceName: 'Switch映像', sceneItemEnabled: true }] },
        GetInputPropertiesListPropertyItems: { propertyItems: [{ itemName: 'UGREEN USB Video', itemValue: 'private-device-serial', itemEnabled: true }] }, ...overrides,
    };
    const obs = { closed: false, async connect() {}, async call(type, data) { calls.push({ type, data }); if (replies[type] instanceof Error) throw replies[type]; return replies[type] ?? {}; }, close() { this.closed = true; } };
    return { obs, calls };
}

test('Switch診断は映像/音声の実証を捏造せず、OBS Get操作だけで現在のシーンとソースを観測', async () => {
    const { obs, calls } = fixture();
    const r = await inspectSwitchReadiness({ obs, inventory });
    assert.equal(r.obs.connection, 'connected');
    assert.equal(r.obs.currentScene, 'Noa Switch');
    assert.equal(r.obs.sources[0].name, 'Switch映像');
    assert.equal(r.capture.availability, 'candidate_detected');
    assert.equal(r.capture.videoSignal, 'unverified');
    assert.equal(r.capture.audioSignal, 'unverified');
    assert.equal(r.manualBroadcast.ready, false);
    assert.equal(r.pi.connection, 'unknown');
    assert.equal(r.pi.automaticControl, 'not_implemented');
    assert.deepEqual(r.actionsTaken, []);
    assert.ok(calls.every(c => c.type.startsWith('Get')));
    assert.ok(!calls.some(c => /StreamService|InputSettings|Screenshot/.test(c.type)));
    assert.ok(!JSON.stringify(r).includes('private-device-serial'));
    assert.equal(obs.closed, true);
});

test('ライブ/録画中なら既存出力終了待ちを表示し、止めたり切り替えたりしない', async () => {
    for (const kind of ['GetStreamStatus', 'GetRecordStatus', 'GetReplayBufferStatus']) {
        const { obs, calls } = fixture({ [kind]: { outputActive: true } });
        const r = await inspectSwitchReadiness({ obs, inventory, piHost: 'raspberrypi.local' });
        assert.equal(r.manualBroadcast.status, 'wait_until_current_output_ends');
        assert.equal(r.pi.connection, 'configured_unverified');
        assert.ok(calls.every(c => c.type.startsWith('Get')));
    }
});

test('OBS接続失敗・機材一覧失敗・出力状態取得失敗をunknownのまま報告、秘密を含む例外を出さない', async () => {
    const { obs } = fixture();
    obs.connect = async () => { throw new Error('password=secret-obspass'); };
    const r = await inspectSwitchReadiness({ obs, inventory: async () => { throw new Error('secret-serial'); } });
    assert.equal(r.obs.connection, 'unavailable');
    assert.equal(r.obs.streaming, null);
    assert.equal(r.capture.availability, 'unknown');
    assert.equal(r.manualBroadcast.status, 'obs_connection_required');
    assert.ok(!JSON.stringify(r).includes('secret'));
    assert.equal(obs.closed, true);
    const broken = fixture({ GetStreamStatus: new Error('OBS failure secret') });
    const r2 = await inspectSwitchReadiness({ obs: broken.obs, inventory });
    assert.equal(r2.manualBroadcast.status, 'output_state_unknown');
    assert.equal(r2.obs.streaming, null);
    const disabled = fixture({ GetReplayBufferStatus: new Error('OBS GetReplayBufferStatus failed (604)') });
    const r3 = await inspectSwitchReadiness({ obs: disabled.obs, inventory });
    assert.equal(r3.obs.replayBuffer, false);
    assert.equal(r3.manualBroadcast.status, 'needs_manual_validation');
    const unknown = fixture({ GetReplayBufferStatus: new Error('connection lost') });
    assert.equal((await inspectSwitchReadiness({ obs: unknown.obs, inventory })).manualBroadcast.status, 'output_state_unknown');
});

test('既存のキャプチャソースだけでは接続済とせず、一覧が空でも未接続と断言しない', async () => {
    const { obs } = fixture({ GetInputPropertiesListPropertyItems: { propertyItems: [] } });
    const r = await inspectSwitchReadiness({ obs, inventory: async () => ({ status: 'observed', devices: [] }) });
    assert.equal(r.capture.configuredVideoSources.length, 1);
    assert.equal(r.capture.availability, 'no_matching_candidate_observed');
    assert.equal(r.manualBroadcast.status, 'capture_connection_unverified');
});

test('macOSインベントリはメタデータ列挙のみ。デバイス固有ID・内蔵カメラ・無関係機材を出さない', async () => {
    let command;
    const r = await captureInventory({ platform: 'darwin', execute: async (...args) => {
        command = args;
        return { stdout: JSON.stringify({ SPUSBDataType: [{ _name: 'USB Bus', _items: [{ _name: 'UGREEN 25773', serial_num: 'secret-serial' }] }], SPCameraDataType: [{ _name: 'FaceTime HD Camera', 'spcamera_unique-id': 'private-id' }] }) };
    } });
    assert.equal(command[0], '/usr/sbin/system_profiler');
    assert.deepEqual(command[1], ['SPUSBDataType', 'SPCameraDataType', '-json']);
    assert.deepEqual(r.devices, [{ name: 'UGREEN 25773', type: 'usb' }]);
    assert.ok(!JSON.stringify(r).includes('secret'));
    assert.equal((await captureInventory({ platform: 'linux', execute: async () => assert.fail('must not execute') })).status, 'unknown');
});

test('明示した別Studioの設定を読み取り、コードを実行せず、ファイルを作成しない', t => {
    const dir = mkdtempSync(join(tmpdir(), 'noa-switch-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'custom'));
    writeFileSync(join(dir, '.env'), 'OBS_PASSWORD=file-secret\nOBS_URL=ws://localhost:4455\nDATA_DIR=custom\n');
    writeFileSync(join(dir, 'custom/settings.json'), JSON.stringify({ OBS_PASSWORD: 'settings-secret' }));
    const before = readdirSync(dir);
    const c = readSwitchConfig(dir, {});
    assert.equal(c.obsPassword, 'settings-secret');
    assert.equal(c.obsURL, 'ws://localhost:4455');
    assert.equal(c.configurationFound, true);
    assert.deepEqual(readdirSync(dir), before);
    for (const obsURL of ['ws://attacker.example:4455', 'wss://remote.example', 'ws://user:pass@localhost:4455', 'ws://localhost:4455/?secret=value']) {
        writeFileSync(join(dir, 'custom/settings.json'), JSON.stringify({ OBS_URL: obsURL }));
        assert.throws(() => readSwitchConfig(dir, {}), /OBS_MUST_BE_LOCAL/);
    }
});

test('引数エラーは接続せずに失敗し、入力された秘密をCLIへ再掲しない', () => {
    assert.throws(() => parseSwitchCheckArgs(['--apply'], '/tmp'), /UNKNOWN_ARGUMENT/);
    assert.throws(() => parseSwitchCheckArgs(['--studio-dir'], '/tmp'), /INVALID_ARGUMENT/);
    assert.throws(() => parseSwitchCheckArgs(['--pi-host', 'ssh://user:secret@host'], '/tmp'), /INVALID_PI_HOST/);
    const p = spawnSync(process.execPath, ['scripts/switch-check.mjs', '--credential=secret-in-command'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(p.status, 2);
    assert.ok(!p.stderr.includes('secret-in-command'));
    assert.equal(p.stdout, '');
});
