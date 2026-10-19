const API = '/api/switch';
const QUALITY = new Set(['1080p', 'device-default']);
const ACTIVE = new Set(['starting', 'recording', 'stopping']);
const ERROR_COPY = {
    SWITCH_MACOS_REQUIRED: 'この簡単設定はmacOSのOBSに対応しています。',
    SWITCH_CAPTURE_UNAVAILABLE: 'OBSの映像キャプチャが利用できません。OBSのインストールと権限を確認してください。',
    SWITCH_SETUP_FAILED: 'Switch専用シーンを準備できませんでした。OBSで接続とソースを確認してください。',
    SWITCH_QUALITY_INVALID: '映像の取り込み方法を選択してください。',
    SWITCH_NOT_CONFIGURED: '先にSwitchの映像・音声を設定して、専用シーンを準備してください。',
    SWITCH_OUTPUT_ACTIVE: 'OBSで配信・録画・リプレイ保存が動作中です。終了してから操作してください。',
    SWITCH_OBS_STATE_UNKNOWN: 'OBSの出力状態を確認できません。OBSで確認してから状態を更新してください。',
    SWITCH_SCAN_EXPIRED: '検出結果の有効時間が切れました。もう一度デバイスを探してください。',
    SWITCH_DEVICE_REQUIRED: '映像デバイスと音声デバイスを選択してください。',
    SWITCH_DEVICE_MISSING: '選択した機器が見つかりません。接続を確認して再検出してください。',
    SWITCH_DEVICE_IN_USE: '選択した機器はOBSの別ソースで使用中です。OBSの設定を確認してください。',
    SWITCH_DEFAULT_AUDIO_ACTIVE: 'OBSの既定の音声入力が有効です。二重音を防ぐため、OBSの音声設定を確認してください。',
    SWITCH_1080P_UNSUPPORTED: 'この機器では1080pの対応プリセットを確認できません。別の取り込み方法を自分で選択してください。',
    SWITCH_OWNERSHIP_CHANGED: '専用シーンの内容が変更されています。OBSで確認してから設定をやり直してください。',
    SWITCH_ROLLBACK_INCOMPLETE: 'OBSの変更を元に戻せませんでした。OBSでシーンと音声を確認してください。',
    OBS_CONNECTION_UNAVAILABLE: 'OBSに接続できません。OBSを起動し、StudioのOBS接続設定を確認してください。',
    OBS_UNAVAILABLE: 'OBSに接続できません。OBSを起動し、接続設定を確認してください。',
    OBS_PERMISSION_REQUIRED: 'OBSにカメラ・マイクの権限が必要です。macOSのプライバシーとセキュリティでOBSを許可し、再検出してください。',
    PERMISSION_REQUIRED: 'OBSにカメラ・マイクの権限が必要です。macOSのプライバシーとセキュリティを確認してください。',
    NO_CAPTURE_DEVICE: 'キャプチャー機器が見つかりません。HDMI IN・USB・電源を確認して再検出してください。',
    SCAN_EXPIRED: '検出結果の有効時間が切れました。もう一度「デバイスを探す」を押してください。',
    INVALID_SCAN: '検出結果を更新する必要があります。もう一度デバイスを探してください。',
    DEVICE_NOT_FOUND: '選択した機器が見つかりません。接続を確認して再検出してください。',
    UNSUPPORTED_PRESET: 'この機器では1080pの対応プリセットを確認できません。別の取り込み方法を自分で選択してください。',
    UNSUPPORTED_QUALITY: '選んだ取り込み方法に対応していません。設定を確認してください。',
    OUTPUT_ACTIVE: 'OBSで出力中です。現在の配信・録画が終了してから操作してください。',
    RECORDING_ACTIVE: 'すでに録画中です。録画状態を更新してください。',
    RECORDING_NOT_OWNED: 'この画面の確認録画ではないため、停止できません。',
    NOT_PREPARED: '先にOBS専用シーンを準備してください。',
    PREVIEW_UNAVAILABLE: '静止画を取得できませんでした。OBSと機器の接続を確認してください。',
};
const clean = (value, max = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';

export function takeAdmin({ location, history, storage }) {
    const hash = new URLSearchParams(location.hash.slice(1));
    let saved = ''; try { saved = storage.getItem('jvs-admin') || ''; } catch {}
    const admin = hash.get('admin') || saved;
    if (hash.has('admin')) {
        try { storage.setItem('jvs-admin', admin); } catch {}
        history.replaceState(null, '', location.pathname + location.search);
    }
    return admin;
}

export function validScan(scan, now = Date.now()) {
    const expires = typeof scan?.expiresAt === 'number' ? scan.expiresAt : Date.parse(scan?.expiresAt);
    return typeof scan?.scanId === 'string' && scan.scanId.length > 0 && Number.isFinite(expires) && expires > now
        && Array.isArray(scan.videoDevices) && Array.isArray(scan.audioDevices);
}

export function selectedDevice(scan, kind, id) {
    return id ? scan?.[kind]?.find(item => item?.id === id && typeof item.label === 'string') || null : null;
}

// Missing or unknown output state always blocks a recording start.
export function recordingView(snapshot) {
    const recording = snapshot?.recording;
    const state = typeof recording?.state === 'string' ? recording.state : 'unknown';
    return { state: ['idle', 'starting', 'recording', 'stopping', 'completed', 'stopped', 'failed', 'unconfirmed'].includes(state) ? state : 'unknown',
        owned: recording?.owned === true, remainingSeconds: Number.isFinite(recording?.remainingSeconds) ? Math.max(0, Math.min(30, Math.ceil(recording.remainingSeconds))) : null,
        id: clean(recording?.id || recording?.name, 160), path: clean(recording?.path, 1024) };
}

export class SwitchSetup {
    constructor({ document, window, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), createURL = value => URL.createObjectURL(value), revokeURL = value => URL.revokeObjectURL(value) }) {
        Object.assign(this, { document, window, fetchImpl, now, setTimer, clearTimer, createURL, revokeURL });
        this.$ = id => document.getElementById(id);
        this.admin = takeAdmin({ location: window.location, history: window.history, storage: window.sessionStorage });
        this.scan = null; this.snapshot = null; this.statusKnown = false; this.needsPrepare = false; this.busy = ''; this.disposed = false; this.tracking = false;
        this.previewURL = null; this.previewSerial = 0; this.pollTimer = null; this.controllers = new Set(); this.completedId = '';
        this.bind(); this.draw();
    }
    bind() {
        this.$('unlock').addEventListener('submit', event => {
            event.preventDefault(); this.admin = this.$('admin-key').value.trim(); this.$('admin-key').value = '';
            try { this.window.sessionStorage.setItem('jvs-admin', this.admin); } catch {}
            void this.refreshStatus();
        });
        this.$('detect').addEventListener('click', () => void this.detect());
        for (const id of ['video-device', 'audio-device', 'video-preset']) this.$(id).addEventListener('change', () => this.selectionChanged());
        this.$('prepare-scene').addEventListener('click', () => void this.prepare());
        this.$('refresh-preview').addEventListener('click', () => void this.preview());
        this.$('start-recording').addEventListener('click', () => void this.startRecording());
        this.$('stop-recording').addEventListener('click', () => void this.stopRecording());
        this.$('recheck-recording').addEventListener('click', () => void this.recheckRecording());
        this.$('refresh-status').addEventListener('click', () => void this.refreshStatus());
        for (const id of ['check-video', 'check-audio', 'check-duplicate']) this.$(id).addEventListener('change', () => this.review());
        this.onPageHide = () => this.dispose(); this.window.addEventListener('pagehide', this.onPageHide);
    }
    notice(message, bad = false) { this.$('notice').textContent = message; this.$('notice').dataset.error = String(bad); }
    async request(path, data, { image = false } = {}) {
        if (!this.admin) throw Object.assign(new Error('管理URLから接続してください。'), { status: 401 });
        const controller = new AbortController(); this.controllers.add(controller);
        const timer = this.setTimer(() => controller.abort(), 25000);
        try {
            const response = await this.fetchImpl(API + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.admin}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal, cache: 'no-store', redirect: 'error' });
            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                const code = typeof body.code === 'string' ? body.code : body.error;
                throw Object.assign(new Error(ERROR_COPY[code] || (response.status === 401 ? '管理キーを確認して、接続し直してください。' : '操作を完了できませんでした。接続・選択・OBSの状態を確認してください。')), { status: response.status, code });
            }
            if (!image) return await response.json();
            const type = response.headers.get('Content-Type')?.split(';')[0];
            if (type !== 'image/jpeg') throw new Error('プレビューの形式を確認できませんでした。');
            const size = Number(response.headers.get('Content-Length'));
            if (size > 4 * 1024 * 1024) throw new Error('プレビュー画像が大きすぎます。');
            const blob = await response.blob();
            if (!blob.size || blob.size > 4 * 1024 * 1024) throw new Error('プレビュー画像を確認できませんでした。');
            return blob;
        } finally { this.clearTimer(timer); this.controllers.delete(controller); }
    }
    async action(kind, fn) {
        if (this.busy || this.disposed) return;
        this.busy = kind; this.draw();
        try { await fn(); }
        catch (error) {
            if (this.disposed) return;
            if (error.status === 401) { this.admin = ''; this.statusKnown = false; this.resetPreview(); try { this.window.sessionStorage.removeItem('jvs-admin'); } catch {} }
            this.notice(error.name === 'AbortError' ? '応答を確認できませんでした。「状態を更新」でOBSの状態を確認してください。' : error.message, true);
        } finally { this.busy = ''; if (!this.disposed) { this.draw(); this.schedulePoll(); } }
    }
    async refreshStatus() {
        return this.action('status', async () => {
            try { this.receive(await this.request('/status')); this.notice('OBSと確認録画の状態を更新しました。'); }
            catch (error) { this.statusKnown = false; throw error; }
        });
    }
    receive(snapshot) {
        this.snapshot = snapshot; this.statusKnown = true;
        const recording = recordingView(snapshot);
        if (['completed', 'stopped'].includes(recording.state)) {
            const id = recording.id || recording.path;
            if (id && id !== this.completedId) { this.completedId = id; this.clearReview(); }
            this.tracking = false;
        } else if (ACTIVE.has(recording.state)) { this.tracking = true; this.clearReview(); }
        else if (['idle', 'failed', 'unconfirmed'].includes(recording.state)) this.tracking = false;
    }
    options(id, placeholder, devices) {
        const select = this.$(id), options = [];
        for (const item of [{ id: '', label: placeholder }, ...devices]) {
            if (typeof item?.id !== 'string' || typeof item.label !== 'string') continue;
            const option = this.document.createElement('option'); option.value = item.id; option.textContent = clean(item.label, 160); options.push(option);
        }
        select.replaceChildren(...options); select.value = '';
    }
    async detect() {
        return this.action('detect', async () => {
            this.notice('OBSから接続候補を探しています。'); this.scan = null; this.needsPrepare = true; this.resetPreview(); this.clearReview();
            this.options('video-device', '検出してから選択', []); this.options('audio-device', '検出してから選択', []); this.options('video-preset', '取り込み方法を選択', []);
            const scan = await this.request('/devices', {});
            if (!validScan(scan, this.now())) throw new Error('検出結果を確認できませんでした。もう一度デバイスを探してください。');
            this.scan = scan;
            this.options('video-device', scan.videoDevices.length ? '映像デバイスを選択' : '映像デバイスを検出できません', scan.videoDevices);
            this.options('audio-device', scan.audioDevices.length ? '音声デバイスを選択' : '音声デバイスを検出できません', scan.audioDevices);
            this.options('video-preset', '取り込み方法を選択', [{ id: '1080p', label: '1080p（OBSの対応プリセットがある場合）' }, { id: 'device-default', label: '機器の既定（解像度は機器に依存）' }]);
            this.notice('候補を更新しました。接続したキャプチャー機器を選んでください。');
        });
    }
    selection() { return { scanId: this.scan?.scanId, videoId: this.$('video-device').value, audioId: this.$('audio-device').value, quality: this.$('video-preset').value }; }
    selectionReady() { const x = this.selection(); return validScan(this.scan, this.now()) && !!selectedDevice(this.scan, 'videoDevices', x.videoId) && !!selectedDevice(this.scan, 'audioDevices', x.audioId) && QUALITY.has(x.quality); }
    selectionChanged() { this.needsPrepare = true; this.resetPreview(); this.clearReview(); this.draw(); }
    async prepare() {
        if (!this.selectionReady()) { this.notice('映像・音声・取り込み方法を選択してください。検出結果が古い場合は再検出してください。', true); return; }
        return this.action('prepare', async () => {
            this.notice('OBS専用シーンを準備しています。'); this.statusKnown = false; this.resetPreview(); this.clearReview();
            await this.request('/prepare', this.selection()); this.needsPrepare = false;
            this.receive(await this.request('/status'));
            this.notice('OBS専用シーンを準備しました。次にプレビューの静止画を確認してください。');
        });
    }
    prepared() { return this.statusKnown && this.snapshot?.configured === true && !this.needsPrepare; }
    resetPreview() {
        ++this.previewSerial; const img = this.$('preview-image'); img.onload = null; img.onerror = null; img.removeAttribute('src'); img.hidden = true;
        if (this.previewURL) this.revokeURL(this.previewURL); this.previewURL = null;
        this.$('preview-placeholder').hidden = false; this.$('preview-state').textContent = '自動更新はしません。';
    }
    async preview() {
        if (!this.prepared()) return;
        return this.action('preview', async () => {
            this.resetPreview(); const serial = this.previewSerial;
            const blob = await this.request('/preview', undefined, { image: true });
            if (this.disposed || serial !== this.previewSerial) return;
            const url = this.createURL(blob), img = this.$('preview-image'); this.previewURL = url;
            img.onload = () => { if (this.disposed || serial !== this.previewSerial) return; img.hidden = false; this.$('preview-placeholder').hidden = true; this.$('preview-state').textContent = `${new Date(this.now()).toLocaleTimeString('ja-JP')} に取得した静止画`; };
            img.onerror = () => { if (serial !== this.previewSerial) return; this.resetPreview(); this.notice('静止画を表示できませんでした。もう一度更新してください。', true); };
            img.src = url; this.notice('静止画を取得しました。ゲームの映像を確認してください。');
        });
    }
    canStart() { const r = recordingView(this.snapshot); return this.prepared() && this.snapshot?.obs?.connected === true && this.snapshot?.obs?.streaming === false && this.snapshot?.obs?.recording === false && this.snapshot?.obs?.replaying === false && this.snapshot?.obs?.reconnecting === false && this.snapshot?.busy !== true && ['idle', 'completed', 'stopped', 'failed'].includes(r.state); }
    async startRecording() {
        if (!this.canStart()) return;
        return this.action('start', async () => {
            this.tracking = true; this.statusKnown = false; this.clearReview(); this.notice('30秒の確認録画を開始しています。');
            await this.request('/recording/start', {});
            this.receive(await this.request('/status')); this.notice('確認録画の状態を確認しています。終了までお待ちください。');
        });
    }
    async stopRecording() {
        const r = recordingView(this.snapshot); if (!this.statusKnown || !r.owned || !ACTIVE.has(r.state)) return;
        return this.action('stop', async () => {
            this.statusKnown = false; this.notice('この確認録画を停止しています。');
            await this.request('/recording/stop', {}); this.receive(await this.request('/status')); this.notice('確認録画の状態を更新しました。');
        });
    }
    async recheckRecording() {
        if (!this.statusKnown || recordingView(this.snapshot).state !== 'unconfirmed') return;
        return this.action('recheck', async () => {
            this.notice('OBSの全出力が停止しているか再確認しています。');
            await this.request('/recording/recheck', {}); this.receive(await this.request('/status'));
            this.notice('OBSの録画状態を再確認しました。元のシーンと音声設定もOBSで確認してください。');
        });
    }
    schedulePoll() {
        if (this.pollTimer) this.clearTimer(this.pollTimer); this.pollTimer = null;
        if (this.tracking && !this.disposed && this.admin) this.pollTimer = this.setTimer(() => { this.pollTimer = null; void this.refreshStatus(); }, 1500);
    }
    clearReview() { for (const id of ['check-video', 'check-audio', 'check-duplicate']) this.$(id).checked = false; }
    review() {
        const enabled = !this.$('review-checks').disabled;
        const complete = enabled && ['check-video', 'check-audio', 'check-duplicate'].every(id => this.$(id).checked);
        this.$('review-state').textContent = !enabled ? '録画が完了すると、確認項目を使えます。' : complete ? 'この録画の映像・ゲーム音・二重音を確認しました。' : '保存した録画を開き、目と耳で確認してください。';
    }
    draw() {
        const authorized = !!this.admin; this.$('locked').hidden = authorized; this.$('switch-app').hidden = !authorized;
        const disabled = !!this.busy, r = this.statusKnown ? recordingView(this.snapshot) : { state: 'unknown' };
        const active = ACTIVE.has(r.state), outputBusy = this.snapshot?.busy === true || ['streaming', 'recording', 'replaying', 'reconnecting'].some(key => this.snapshot?.obs?.[key] === true), video = selectedDevice(this.scan, 'videoDevices', this.$('video-device').value), audio = selectedDevice(this.scan, 'audioDevices', this.$('audio-device').value);
        const scanReady = validScan(this.scan, this.now());
        this.$('detect').disabled = disabled || active || outputBusy; this.$('detect').textContent = this.busy === 'detect' ? '探しています…' : 'デバイスを探す';
        this.$('video-device').disabled = disabled || active || outputBusy || !scanReady || !this.scan.videoDevices.length;
        this.$('audio-device').disabled = disabled || active || outputBusy || !scanReady || !this.scan.audioDevices.length;
        this.$('video-preset').disabled = disabled || active || outputBusy || !scanReady || !video;
        this.$('device-state').textContent = !this.scan ? 'まだ検出していません。' : !scanReady ? '検出結果の有効時間が切れました。再検出してください。' : `映像 ${this.scan.videoDevices.length} 件・音声 ${this.scan.audioDevices.length} 件の候補を検出しました。`;
        const missing = !!this.scan && (!this.scan.videoDevices.length || !this.scan.audioDevices.length);
        this.$('device-help').hidden = !missing && !this.scan?.note; this.$('device-help').dataset.warning = 'true';
        this.$('device-help').textContent = this.scan?.audioDiscovery === 'existing_audio_source_required' ? '音声候補を取得できませんでした。OBS側で接続した機器の音声入力を確認し、再検出してください。' : this.scan?.note ? clean(this.scan.note, 600) : '機器の候補を検出できませんでした。HDMI IN・USB・Switchの電源を確認してください。OBSのカメラ／マイク権限が未許可の場合も、候補を取得できないことがあります。';
        this.$('preset-help').textContent = '1080pが未対応の場合はエラーを表示します。別の画質へ自動で切り替えません。';
        this.$('selection-summary').textContent = video && audio ? `映像：${clean(video.label, 160)} ／ 音声：${clean(audio.label, 160)}` : this.prepared() ? '専用シーンが設定済みです。映像と音声は録画で確認してください。' : '映像・音声・取り込み方法を選択してください。';
        this.$('obs-state').textContent = !this.statusKnown ? '状態を確認できていません' : this.snapshot?.obs?.connected === true ? '接続済み' : '接続を確認してください';
        this.$('prepare-scene').disabled = disabled || active || outputBusy || !this.selectionReady();
        this.$('prepare-scene').textContent = this.busy === 'prepare' ? '準備しています…' : 'OBS専用シーンを準備';
        this.$('prepare-state').textContent = this.prepared() ? '設定済み。映像・音声の確認は次の手順で行います。' : '未準備、または選択を変更しました。';
        this.$('refresh-preview').disabled = disabled || active || outputBusy || !this.prepared();
        this.$('refresh-preview').textContent = this.busy === 'preview' ? '取得しています…' : 'プレビュー静止画を更新';
        const recordText = { idle: '録画は停止中', starting: '確認録画を開始しています', recording: r.owned ? '30秒の確認録画中' : 'OBSで別の録画中', stopping: '確認録画を保存しています', completed: '確認録画が完了しました', stopped: '確認録画を途中で停止しました', unconfirmed: '録画の停止を確認できていません', failed: '確認録画を完了できませんでした', unknown: '録画状態を確認できていません' };
        this.$('record-state').textContent = recordText[r.state]; this.$('record-light').dataset.active = String(active);
        this.$('record-countdown').textContent = active && r.remainingSeconds !== null && r.remainingSeconds !== undefined ? `残り ${r.remainingSeconds} 秒` : '';
        this.$('record-detail').textContent = this.snapshot?.recording?.error && r.state !== 'unconfirmed' ? '録画の停止・元のシーンと音声設定をOBSで確認してください。' : active ? '録画終了後、元のOBSシーンに戻ります。' : r.state === 'unconfirmed' ? 'OBSで配信・録画・リプレイ保存が停止していることを確認し、下の再確認ボタンを押してください。停止済みの場合だけ元のシーンへ戻します。' : r.state === 'unknown' ? '状態を更新してから録画してください。' : '録画中だけ専用シーンへ切り替えます。';
        this.$('start-recording').disabled = disabled || !this.canStart(); this.$('stop-recording').disabled = disabled || !this.statusKnown || !r.owned || !active;
        this.$('recheck-recording').hidden = r.state !== 'unconfirmed'; this.$('recheck-recording').disabled = disabled || r.state !== 'unconfirmed';
        this.$('recheck-recording').textContent = this.busy === 'recheck' ? '停止を再確認しています…' : 'OBSで停止を確認したので再確認';
        this.$('refresh-status').disabled = disabled; this.$('start-recording').textContent = this.busy === 'start' ? '開始を確認しています…' : '30秒のローカル録画を開始';
        const completed = this.statusKnown && ['completed', 'stopped'].includes(r.state) && !!(r.id || r.path) && !this.needsPrepare;
        this.$('record-result').hidden = !completed; this.$('record-path').textContent = completed && r.path ? r.path : '保存先はOBSで確認できます。';
        this.$('review-checks').disabled = !completed || disabled; this.review();
    }
    dispose() { this.disposed = true; this.clearTimer(this.pollTimer); for (const c of this.controllers) c.abort(); this.resetPreview(); this.window.removeEventListener('pagehide', this.onPageHide); }
}

if (typeof document !== 'undefined' && document.getElementById('switch-app')) {
    const page = new SwitchSetup({ document, window });
    if (page.admin) void page.refreshStatus(); else page.notice('管理URLから開くか、管理キーを入力して接続してください。');
}
