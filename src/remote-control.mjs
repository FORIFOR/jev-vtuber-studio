// Limited remote broadcast control. No shell, settings writes, or renderer credentials.
import { randomUUID } from 'node:crypto';
import { hash, sleep } from './util.mjs';
import { youtubeChatStartIssue } from './youtube.mjs';

export class RemoteError extends Error {
    constructor(code, message, status = 409) { super(message); this.name = 'RemoteError'; this.code = code; this.status = status; }
}
const stable = x => x && typeof x === 'object' ? (Array.isArray(x) ? x.map(stable) : Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])]))) : x;
const requireThat = (value, code, message) => { if (!value) throw new RemoteError(code, message); };
export class RemoteControl {
    constructor({ c, engine, obs, fingerprint, verified, outputVerified, setupBusy, waitForStop, localOrigin, memoryPreflight = async () => {}, beforeStart = async () => {}, onTransmitting = () => {}, now = Date.now, pause = sleep }) {
        Object.assign(this, { c, engine, obs, fingerprint, verified, outputVerified, setupBusy, waitForStop, localOrigin, memoryPreflight, beforeStart, onTransmitting, now, pause });
        this.armReceipt = null; this.generation = 0; this.task = null; this.job = null; this.commands = new Map();
        this.lastOBS = { connected: false, active: null, reconnecting: false, checkedAt: 0 };
    }
    get busy() { return !!this.task; }
    configHash() { return hash(JSON.stringify([this.fingerprint(), this.c.allowStream, this.c.obsURL, this.c.obsPassword,
        this.c.obsScene, this.c.obsInput, this.c.streamTarget, this.c.youtubeVideo, this.c.sessionMs])); }
    hasOBSRenderer() { return !!this.engine.status().renderer && this.engine.renderer?.role === 'obs'; }
    armed() { return !!this.armReceipt && this.now() < this.armReceipt.until && this.armReceipt.configHash === this.configHash(); }
    summary() {
        const s = this.engine.status();
        return { enabled: true, armed: this.armed(), armedUntil: this.armed() ? this.armReceipt.until : null,
            name: this.c.character.name, title: this.c.character.channel, videoID: this.c.youtubeVideo,
            sessionMinutes: this.c.sessionMs / 60000, running: s.running, panic: s.panic,
            phase: s.phase, remainingMs: s.remainingMs, obsRenderer: this.hasOBSRenderer(),
            spoken: s.stats.spoken, topic: s.topic?.title || '', caption: s.pending?.started ? s.pending.text : '',
            youtube: s.youtube, obsOwned: this.obs.owned, obs: { ...this.lastOBS },
            job: this.job ? { ...this.job } : null };
    }
    async sampleOBS() {
        try {
            const r = await this.obs.call('GetStreamStatus');
            this.lastOBS = { connected: true, active: r.outputActive === true, reconnecting: r.outputReconnecting === true, checkedAt: this.now() };
        } catch { this.lastOBS = { connected: false, active: null, reconnecting: false, checkedAt: this.now() }; }
        return this.lastOBS;
    }
    ensureBase() {
        requireThat(this.c.mode === 'live' && this.c.profile === 'talk', 'LIVE_REQUIRED', 'PCで実APIの雑談モードを設定してください。');
        requireThat(this.c.allowStream, 'OUTPUT_DISABLED', 'PCで外部配信の許可を有効にしてください。');
        requireThat(this.verified(), 'REHEARSAL_REQUIRED', 'PCで実試聴と聴取確認が必要です。');
        requireThat(!this.setupBusy(), 'SETUP_BUSY', 'PCで接続設定・試聴を実行中です。');
        requireThat(!this.engine.panic, 'PANIC_LATCHED', '緊急停止中です。PCで確認して解除してください。');
        requireThat(this.c.streamTarget === 'twitch' || /^[\w-]{11}$/.test(this.c.youtubeVideo), 'VIDEO_REQUIRED', 'PCで配信先のYouTube動画を設定してください。');
        requireThat(this.hasOBSRenderer(), 'OBS_AUDIO_REQUIRED', 'OBSの専用ブラウザソースを有効にしてください。スマホは音声を再生しません。');
    }
    // Compare destination settings only in PC memory. Stream keys never leave this process.
    async inspectOutput() {
        try {
            const stream = await this.obs.call('GetStreamStatus');
            this.lastOBS = { connected: true, active: stream.outputActive === true, reconnecting: stream.outputReconnecting === true, checkedAt: this.now() };
            requireThat(!stream.outputActive && !stream.outputReconnecting, 'ALREADY_STREAMING', 'OBSが送出中です。既存の配信は引き継ぎません。');
            requireThat(stream.outputActive === false, 'OBS_STATUS_UNKNOWN', 'OBSの送出停止状態を確認できません。PCで確認してください。');
            const scene = await this.obs.call('GetCurrentProgramScene');
            requireThat(scene.currentProgramSceneName === this.c.obsScene, 'SCENE_CHANGED', 'OBSを確認済みの専用シーンへ戻してください。');
            const source = await this.obs.call('GetInputSettings', { inputName: this.c.obsInput });
            const expected = `${this.localOrigin()}/stage#token=${this.c.viewToken}${this.c.vtsEnabled ? '&avatar=external' : ''}&output=obs&rendererKey=${this.c.obsRendererToken}`;
            requireThat(source.inputSettings?.url === expected && source.inputSettings?.reroute_audio === true,
                'SOURCE_CHANGED', 'OBSの専用ソース設定が変わっています。PCでシーンを作り直して試聴してください。');
            const item = await this.obs.call('GetSceneItemId', { sceneName: this.c.obsScene, sourceName: this.c.obsInput });
            const enabled = await this.obs.call('GetSceneItemEnabled', { sceneName: this.c.obsScene, sceneItemId: item.sceneItemId });
            requireThat(enabled.sceneItemEnabled === true, 'SOURCE_HIDDEN', 'OBSの専用ソースが非表示です。');
            const mute = await this.obs.call('GetInputMute', { inputName: this.c.obsInput });
            requireThat(mute.inputMuted === false, 'SOURCE_MUTED', 'OBSのAI音声がミュートされています。');
            const volume = await this.obs.call('GetInputVolume', { inputName: this.c.obsInput });
            requireThat(Number.isFinite(volume.inputVolumeMul) && volume.inputVolumeMul > 0, 'SOURCE_SILENT', 'OBSの音量がゼロです。');
            if (this.c.streamTarget) await this.obs.assertDestination();
            const destination = await this.obs.call('GetStreamServiceSettings');
            requireThat(destination.streamServiceSettings && Object.keys(destination.streamServiceSettings).length > 0,
                'DESTINATION_REQUIRED', 'OBSの配信先を先に設定してください。');
            return hash(JSON.stringify(stable([destination.streamServiceType, destination.streamServiceSettings, source.inputSettings,
                scene.currentProgramSceneName, volume.inputVolumeMul])));
        } catch (e) {
            if (e instanceof RemoteError) throw e;
            throw new RemoteError('OBS_UNAVAILABLE', 'OBSへ接続・設定確認できません。PCのOBS起動と接続設定を確認してください。');
        }
    }
    async arm({ confirm } = {}) {
        requireThat(confirm === 'ARM_VERIFIED_OUTPUT', 'CONFIRM_REQUIRED', 'OBS録画の音声・映像と、選択した配信先・公開範囲・自動スタートを確認してください。');
        requireThat(!this.busy && !this.engine.running && !this.obs.owned, 'NOT_IDLE', 'ローカル番組とOBS送出を止めてから許可してください。');
        this.ensureBase();
        requireThat(this.outputVerified(), 'OBS_REHEARSAL_REQUIRED', '今回の起動中に、OBSの専用ソースで実WAVを再生し録画確認してください。');
        const configHash = this.configHash(), generation = this.generation;
        const outputHash = await this.inspectOutput();
        requireThat(generation === this.generation && configHash === this.configHash() && !this.engine.running, 'CHANGED', '確認中に状態が変わりました。やり直してください。');
        this.armReceipt = { until: this.now() + 8 * 60 * 60 * 1000, configHash, outputHash };
        return this.summary();
    }
    disarm() { this.armReceipt = null; this.cancelStart(); return this.summary(); }
    cancelStart() { this.generation++; }
    async preflight() {
        const chatIssue = youtubeChatStartIssue(this.c, this.engine.status().usage);
        requireThat(!chatIssue, chatIssue?.code, chatIssue?.error);
        await this.memoryPreflight();
        this.ensureBase();
        requireThat(this.armed(), 'NOT_ARMED', 'PCで「遠隔開始を8時間許可」を実行してください。再起動・設定変更後は再確認が必要です。');
        requireThat(!this.engine.running && !this.obs.owned, 'NOT_IDLE', '番組またはOBSが動作中です。二重開始はしません。');
        const receipt = this.armReceipt, outputHash = await this.inspectOutput();
        requireThat(this.armed() && receipt === this.armReceipt && outputHash === receipt.outputHash,
            'DESTINATION_CHANGED', 'OBSの配信先・ソース・音量が確認時から変わりました。PCで再確認してください。');
        return { ok: true, title: this.c.character.channel, videoID: this.c.youtubeVideo, minutes: this.c.sessionMs / 60000 };
    }
    remember(id, action) {
        requireThat(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 'REQUEST_ID', '操作IDが不正です。画面を開き直してください。');
        const old = this.commands.get(id);
        if (old) {
            requireThat(old.action === action, 'REQUEST_CONFLICT', '操作IDが別の操作に使われています。');
            return old;
        }
        return null;
    }
    start({ requestId, confirm, videoID } = {}) {
        const old = this.remember(requestId, 'start'); if (old) return { ...old.job };
        requireThat(confirm === 'START_BROADCAST' && videoID === this.c.youtubeVideo, 'CONFIRM_REQUIRED', '今回の配信先を確認して、開始を確定してください。');
        requireThat(!this.busy && !this.engine.running && !this.obs.owned, 'BUSY', '別の操作または配信が進行中です。');
        requireThat(this.armed(), 'NOT_ARMED', 'PC側の遠隔開始許可が必要です。');
        const generation = ++this.generation;
        const job = this.job = { id: randomUUID(), requestId, action: 'start', state: 'checking', at: this.now(), error: null };
        this.commands.set(requestId, { action: 'start', job }); this.trim();
        const task = this.runStart(generation, job); this.task = task;
        void task.finally(() => { if (this.task === task) this.task = null; });
        return { ...job };
    }
    trim() { while (this.commands.size > 128) this.commands.delete(this.commands.keys().next().value); }
    assertCurrent(generation) {
        requireThat(generation === this.generation && this.armed(), 'CANCELLED', '開始を取り消しました。');
        this.ensureBase();
    }
    async runStart(generation, job) {
        let beganRuntime = false;
        try {
            await this.waitForStop(); this.assertCurrent(generation);
            await this.preflight(); this.assertCurrent(generation);
            await this.engine.prepareBudgetClosing?.();
            await this.memoryPreflight(); this.assertCurrent(generation);
            job.state = 'starting_obs';
            await this.beforeStart(); this.assertCurrent(generation); // e.g. the 配信準備中 screen first (STANDBY_SECONDS)
            await this.obs.start(); this.assertCurrent(generation);
            // OBS has accepted the request; observe output before calling this a transmitting stream.
            const until = this.now() + 12000;
            while (true) {
                this.assertCurrent(generation);
                const s = await this.sampleOBS(); this.assertCurrent(generation);
                if (s.connected && s.active && !s.reconnecting) break;
                requireThat(this.now() < until, 'OUTPUT_TIMEOUT', 'OBSの送出開始を確認できません。');
                await this.pause(250);
            }
            this.assertCurrent(generation);
            await this.memoryPreflight(); this.assertCurrent(generation);
            beganRuntime = true; this.engine.start();
            job.state = 'transmitting'; // Not a claim that the YouTube player is publicly live.
            this.onTransmitting();
        } catch (e) {
            if (beganRuntime) this.engine.stop('remote_start_failed');
            try {
                await this.obs.stopOwned();
                job.state = e.code === 'CANCELLED' ? 'cancelled' : 'failed';
            } catch { job.state = 'stop_unconfirmed'; }
            job.error = e instanceof RemoteError ? e.code : 'START_FAILED';
        } finally { job.updatedAt = this.now(); }
    }
    stop({ requestId, panic = false } = {}) {
        const action = panic ? 'panic' : 'stop', old = this.remember(requestId, action); if (old) return { ...old.job };
        // Capture ownership before stop() and stopped-event cleanup clear it.
        const mayOwn = this.obs.owned || (this.busy && this.job?.action === 'start');
        this.cancelStart();
        const previous = this.task;
        const job = this.job = { id: randomUUID(), requestId, action, state: 'stopping', at: this.now(), error: null };
        this.commands.set(requestId, { action, job }); this.trim();
        // With a long goodbye configured, a remote stop says goodbye first and waits for the show to end (bounded by the
        // session's hard stop); a second stop during the goodbye cuts it short. Panic is always immediate.
        const farewell = !panic && this.engine.running && this.engine.farewellMs?.() > 0 && !this.engine.director?.closing;
        if (panic) { this.armReceipt = null; this.engine.emergency(); } else if (farewell) this.engine.requestClose('remote_operator'); else this.engine.stop('remote_operator');
        const stopping = (async () => {
            try {
                if (farewell) {
                    while (this.engine.running && this.now() < this.engine.endAt + 5000) await this.pause(250);
                    if (this.engine.running) this.engine.stop('remote_operator');
                }
                // Do not queue the cancellation behind a slow start. A late StartStream
                // still must settle before the final stop is verified.
                await this.obs.stopOwned();
                await previous;
                await this.obs.stopOwned(); await this.waitForStop();
                const until = this.now() + 12000;
                let s = await this.sampleOBS();
                // StopStream acknowledges a request, not a physically finished output.
                // Never mislabel our still-stopping output as someone else's stream.
                while (mayOwn && s.connected && (s.active || s.reconnecting) && this.now() < until) {
                    await this.pause(250); s = await this.sampleOBS();
                }
                job.state = !s.connected || s.active === null ? 'stop_unconfirmed'
                    : s.active || s.reconnecting ? (mayOwn ? 'stop_unconfirmed' : 'external_stream_active') : 'stopped';
                if (job.state === 'stop_unconfirmed') job.error = 'STOP_UNCONFIRMED';
            } catch { job.state = 'stop_unconfirmed'; job.error = 'STOP_UNCONFIRMED'; }
            finally { job.updatedAt = this.now(); }
        })();
        this.task = stopping;
        void stopping.finally(() => { if (this.task === stopping) this.task = null; });
        return { ...job };
    }
}
