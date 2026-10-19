import { basename, extname, isAbsolute } from 'node:path';

// A separate OBS socket observes output transitions. Losing it revokes ownership;
// a later recording started in OBS is never adopted or stopped by this test.
export async function watchRecording(obs, onState, onLost) {
    await obs.connect();
    const ws = obs.ws;
    if (!ws?.addEventListener || !ws?.send) throw new Error('OBSの録画状態を監視できません。');
    const message = event => { try { const m = JSON.parse(String(event.data)); if (m.op === 5 && m.d?.eventType === 'RecordStateChanged') onState(m.d.eventData); } catch {} };
    ws.addEventListener('message', message); ws.addEventListener('close', onLost); ws.addEventListener('error', onLost);
    ws.send(JSON.stringify({ op: 3, d: { eventSubscriptions: 64 } }));
    return () => { ws.removeEventListener('message', message); ws.removeEventListener('close', onLost); ws.removeEventListener('error', onLost); };
}

export class SwitchRecording {
    constructor({ obs, validate, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), watch = watchRecording }) {
        Object.assign(this, { obs, validate, now, setTimer, clearTimer, watch });
        this.state = 'idle'; this.owned = false; this.timer = null; this.endAt = 0; this.file = null; this.error = ''; this.restoring = false;
    }
    get busy() { return this.restoring || !!this.stopTask || ['starting', 'recording', 'stopping'].includes(this.state); }
    snapshot() { return { state: this.state, owned: this.owned, remainingSeconds: this.state === 'recording' ? Math.max(0, Math.ceil((this.endAt - this.now()) / 1000)) : 0,
        path: this.file || null, name: this.file ? basename(this.file) : null, error: this.error || null }; }
    cancelTimer() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
    lose() { this.cancelTimer(); this.owned = false; this.state = 'unconfirmed'; this.error = 'OBSとの接続が切れました。録画の停止をOBSで確認してください。'; }
    event(d) {
        if (this.state === 'starting' && d?.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') this.startInterrupted = true;
        if (!this.owned || !d) return;
        if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING' && this.state !== 'stopping') this.state = 'stopping';
        if (d.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
            this.owned = false; this.cancelTimer(); this.acceptFile(d.outputPath); this.state = this.file ? 'completed' : 'stopped';
            void this.restore();
        }
    }
    acceptFile(path) { if (typeof path === 'string' && isAbsolute(path) && /\.(mp4|mkv|mov|flv|ts)$/i.test(extname(path)) && !/[\u0000-\u001f]/.test(path)) this.file = path; }
    assertStarting() { if (this.state !== 'starting' || this.startInterrupted) throw new Error('録画開始中にOBSの状態が変わりました。'); }
    async start() {
        if (this.busy || this.state === 'unconfirmed') throw new Error('録画が進行中、または停止未確認です。OBSを確認してください。');
        this.state = 'starting'; this.file = null; this.error = ''; this.owned = false; this.previousScene = null; this.muted = []; this.startInterrupted = false;
        try {
            const configured = await this.validate(); this.scene = configured.sceneName;
            if (!this.scene) throw new Error('先にSwitchの映像と音声を設定してください。');
            await this.obs.assertOutputsStopped();
            this.unwatch?.(); this.unwatch = await this.watch(this.obs, d => this.event(d), () => { if (this.owned || this.state === 'starting') this.lose(); });
            this.previousScene = (await this.obs.call('GetCurrentProgramScene')).currentProgramSceneName;
            if (!this.previousScene) throw new Error('元のOBSシーンを確認できません。');
            // Global microphones/desktop sources otherwise enter every scene. Silence them only
            // for this test; restore previous settings after every output is confirmed stopped.
            const globals = await this.obs.call('GetSpecialInputs');
            for (const name of new Set(Object.values(globals).filter(v => typeof v === 'string' && v))) {
                const state = await this.obs.call('GetInputMute', { inputName: name });
                if (state.inputMuted !== true && state.inputMuted !== false) throw new Error('グローバル音声の状態を確認できません。');
                if (!state.inputMuted) { await this.obs.assertOutputsStopped(); this.assertStarting(); this.muted.push(name); await this.obs.call('SetInputMute', { inputName: name, inputMuted: true }); }
            }
            await this.obs.assertOutputsStopped();
            this.assertStarting();
            await this.obs.call('SetCurrentProgramScene', { sceneName: this.scene });
            await this.obs.assertOutputsStopped();
            this.assertStarting();
            await this.obs.call('StartRecord');
            this.assertStarting();
            this.owned = true; this.state = 'recording'; this.endAt = this.now() + 30000;
            this.timer = this.setTimer(() => { void this.stop().catch(() => {}); }, 30000);
            return this.snapshot();
        } catch (error) {
            if (this.state !== 'unconfirmed') { this.state = 'failed'; this.error = 'テスト録画を開始できませんでした。OBSの出力状態とSwitch設定を確認してください。'; }
            await this.restore();
            throw error;
        }
    }
    async restore() {
        if (this.restoreTask) return this.restoreTask;
        this.restoring = true; this.restoreTask = this.restoreImpl();
        try { const restored = await this.restoreTask; if (!restored) this.state = 'unconfirmed'; return restored; } finally { this.restoring = false; this.restoreTask = null; }
    }
    async restoreImpl() {
        try {
            await this.obs.assertOutputsStopped();
            const current = await this.obs.call('GetCurrentProgramScene');
            if (this.previousScene && current.currentProgramSceneName === this.scene && this.previousScene !== this.scene)
                await this.obs.call('SetCurrentProgramScene', { sceneName: this.previousScene });
            for (const name of this.muted || []) {
                const s = await this.obs.call('GetInputMute', { inputName: name });
                if (s.inputMuted === true) await this.obs.call('SetInputMute', { inputName: name, inputMuted: false });
            }
            this.muted = []; this.previousScene = null; return true;
        } catch { this.error = '元のシーン・音声設定を復元できませんでした。OBSを確認して再確認してください。'; return false; }
    }
    async stop() {
        if (!this.owned) return this.snapshot();
        if (this.stopTask) return this.stopTask;
        this.stopTask = this.finish();
        try { return await this.stopTask; } finally { this.stopTask = null; }
    }
    async finish() {
        this.cancelTimer();
        try {
            const status = await this.obs.call('GetRecordStatus');
            if (!this.owned) return this.snapshot();
            if (status.outputActive !== true && status.outputActive !== false) throw new Error('Unknown recording state');
            if (status.outputActive === false) { this.owned = false; this.state = 'stopped'; await this.restore(); return this.snapshot(); }
            this.state = 'stopping';
            const result = await this.obs.call('StopRecord');
            this.owned = false; this.acceptFile(result.outputPath); this.state = this.file ? 'completed' : 'stopped';
            await this.restore(); return this.snapshot();
        } catch { this.lose(); return this.snapshot(); }
    }
    async reconcile() {
        if (this.state !== 'unconfirmed') return this.snapshot();
        // Read-only output checks can clear a lost connection, but never adopt an active recording.
        await this.obs.assertOutputsStopped();
        if (await this.restore()) { this.state = 'stopped'; this.error = ''; }
        return this.snapshot();
    }
    async close() { this.cancelTimer(); await this.stop(); this.unwatch?.(); this.obs.close(); }
}
