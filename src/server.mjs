import { MemoryGuard, MemoryHold } from './memory-guard.mjs';
import { DiskGuard, prune as pruneFiles } from './disk-guard.mjs';
import { StreamTitler } from './stream-title.mjs';
import { StreamWatch } from './stream-watch.mjs';
import { spawn } from 'node:child_process';
import { RemoteControl } from './remote-control.mjs';
import { createRemoteServer, loadRemoteOptions } from './remote-server.mjs';
import { randomUUID } from 'node:crypto';
import { TalkEngine } from './talk-engine.mjs';
import { publicSettings, saveSettings, detect, rehearse, diagnosticError, creditMissing } from './settings.mjs';
import { GameRunner } from './game-runner.mjs';
import http from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadEnv, ROOT } from './config.mjs';
import { fetchTopics, saveTopicScenes } from './lobby-topics.mjs';
import { LlmRoute } from './llm-route.mjs';
import { equal, hash } from './util.mjs';
import { Ledger, Audit } from './store.mjs';
import { Jev } from './jev.mjs';
import { Conversation, Research } from './providers.mjs';
import { CommentVoice } from './voice-routing.mjs';
import { DirectedVoice } from './voice-router.mjs';
import { ReactionAudioCache } from './reaction-audio.mjs';
import { Engine } from './engine.mjs';
import { OBS } from './obs.mjs';
import { Control, ControlError } from './control.mjs';
import { SpeechToText, SttError } from './stt.mjs';
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, validHotkeys } from '../public/hotkeys.mjs';
import { SwitchSetup } from './switch-setup.mjs';
import { SwitchRecording } from './switch-recording.mjs';
import { VTubeStudio } from './vts.mjs';
import { YouTube, youtubeChatStartIssue } from './youtube.mjs';
import { probeYouTubeChat } from './youtube-check.mjs';
import { accessToken, scheduleBroadcast, scheduleRequest } from './youtube-schedule.mjs';
import { grpcAvailable } from './youtube-stream.mjs';
import { loadProgrammes, builtinProgrammes, editable, applyEdit, saveProgramme, resetProgramme } from './programmes.mjs';
import { AdLibrary, AD_UPLOAD_LIMIT, AD_UPLOAD_TYPES } from './ad-library.mjs';
import { readBillingHold, clearBillingHold } from './jev.mjs';
import { Twitch } from './twitch.mjs';
import { ShowLogger } from './show-logger.mjs';
import { PARAMS, clampParam } from '../public/avatar-rig.mjs';
import { serveVrmAsset } from './vrm-assets.mjs';
import { AvatarWardrobe, WardrobeValidationError } from './avatar-wardrobe.mjs';
import { AvatarMode, AvatarModeValidationError } from './avatar-mode.mjs';
import { Sponsor, SponsorValidationError, SponsorConflictError, SPONSOR_BODY_LIMIT } from './sponsor.mjs';
const VENDOR = new Set(['/vendor/jquery-3.7.1.min.js', '/vendor/blockrain-0.2.1.jquery.js', '/vendor/blockrain-0.2.1.css']);
const int = (v, lo, hi) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo;
/** What an operator may be told about a failed request: the error's own words with secrets-shaped parts removed
 * (URLs with credentials or tokens, long hex/base64 runs, absolute paths under home), at most 200 characters. */
export function errorDetail(e) {
    const text = String(e?.message || e?.code || e?.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/(?:wss?|https?):\/\/[^\s"']+/gi, '[URL]').replace(/\/(?:Users|home)\/[^\s"':]+/g, '[path]')
        .replace(/\b[a-f0-9]{24,}\b/gi, '[token]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]').replace(/\s+/g, ' ').trim();
    return text ? `${e?.code && !text.includes(String(e.code)) ? `${e.code}: ` : ''}${text}`.slice(0, 200) : '';
}
/** Stage game reports are untrusted input: whitelisted fields, numbers clamped, a 20x10 board of 0/1, known event types. */
export function sanitizeGameReport(d = {}) {
    const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null, types = new Set(['line_clear', 'danger_enter', 'danger_exit', 'game_over']);
    const board = Array.isArray(snap?.board) && snap.board.length === 20 ? snap.board.map(r => Array.from({ length: 10 }, (_, x) => Array.isArray(r) && r[x] ? 1 : 0)) : null;
    const roundId = /^round-\d{3}$/.test(String(d.roundId)) ? String(d.roundId) : null;
    const snapshot = snap && roundId ? { roundId, revision: int(snap.revision, 0, 1e7), score: int(snap.score, 0, 1e9), clearedLines: int(snap.clearedLines, 0, 1e5), elapsedMs: int(snap.elapsedMs, 0, 36e5),
        highestStack: int(snap.highestStack, 0, 20), holes: int(snap.holes, 0, 200), danger: ['low', 'mid', 'high'].includes(snap.danger) ? snap.danger : 'low',
        nextPiece: /^[a-zA-Z]{1,16}$/.test(String(snap.nextPiece)) ? String(snap.nextPiece) : null, board } : null;
    const events = (Array.isArray(d.events) ? d.events.slice(0, 20) : []).filter(e => types.has(e?.type) && typeof e.id === 'string' && e.id.length <= 80 && e.id.startsWith(`${roundId}:`))
        .map(e => ({ id: e.id, type: e.type, revision: int(e.revision, 0, 1e7), gameTimeMs: int(e.gameTimeMs, 0, 36e5), facts: { count: int(e.facts?.count, 0, 4), totalLines: int(e.facts?.totalLines, 0, 1e5), scoreDelta: int(e.facts?.scoreDelta, 0, 1e6), highestStack: int(e.facts?.highestStack, 0, 20), score: int(e.facts?.score, 0, 1e9) } }));
    const summary = d.summary && typeof d.summary === 'object' ? { maxClear: int(d.summary.maxClear, 0, 4), dangerRecoveries: int(d.summary.dangerRecoveries, 0, 1000) } : null;
    return { roundId, snapshot, events, summary };
}
async function body(req) { if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('JSON required'); let s = ''; for await (const b of req) {
    s += b;
    if (Buffer.byteLength(s) > 16000)
        throw new Error('Request too large');
} return JSON.parse(s || '{}'); }
// Image uploads have their own limit; the existing small JSON routes keep theirs.
async function sponsorBody(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new SponsorValidationError('JSON required');
    return new Promise((resolveBody, reject) => {
        let size = 0, chunks = [], tooLarge = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > SPONSOR_BODY_LIMIT) {
                chunks = [];
                if (!tooLarge) { tooLarge = true; const error = new SponsorValidationError('画像を含む広告設定は 3MiB 以下にしてください。'); error.status = 413; reject(error); }
            } else if (!tooLarge) chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return;
            try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch { reject(new SponsorValidationError('広告設定の JSON を確認してください。')); }
        });
        req.on('error', reject);
        req.on('aborted', () => reject(new SponsorValidationError('画像の送信が中断されました。')));
    });
}
/** A raw upload (an ad's image, video or PDF) bounded by limit; rejected before buffering when the declared size is over. */
function rawBody(req, limit) {
    return new Promise((resolveBody, reject) => {
        if (Number(req.headers['content-length']) > limit) { const e = new SponsorValidationError('ファイルが大きすぎます。'); e.status = 413; return reject(e); }
        let size = 0, chunks = [], tooLarge = false;
        req.on('data', chunk => { size += chunk.length; if (size > limit) { chunks = []; if (!tooLarge) { tooLarge = true; const e = new SponsorValidationError('ファイルが大きすぎます。'); e.status = 413; reject(e); } } else if (!tooLarge) chunks.push(chunk); });
        req.on('end', () => { if (!tooLarge) resolveBody(Buffer.concat(chunks)); });
        req.on('error', reject); req.on('aborted', () => reject(new SponsorValidationError('送信が中断されました。')));
    });
}
export function createApp(c, overrides = {}) {
    c.obsRendererToken = randomUUID();
    const remoteOptions = overrides.remoteOptions ?? loadRemoteOptions(c.dataDir);
    if (remoteOptions?.port === c.port) throw new Error('Remote control requires a separate port');
    const ledger = overrides.ledger || new Ledger(c.dataDir, c.limits), audit = overrides.audit || new Audit(c.dataDir);
    const showLogger = overrides.showLogger || new ShowLogger(c.dataDir, { retentionDays: c.commentRetentionDays });
    // The voice library is file-only (no provider I/O) and never reloaded mid-show.
    const library = overrides.library || new ReactionAudioCache(join(c.dataDir, 'voice'));
    if (!overrides.library) library.reload();
    // The optional remote model (src/llm-route.mjs): probed now and every minute; the generator and judge use its fetch.
    const llmRoute = new LlmRoute(c, { fetchFn: overrides.llmFetch || fetch });
    const llmRouteTimer = llmRoute.configured ? setInterval(() => llmRoute.probe().catch(() => { }), 60000) : null;
    if (llmRoute.configured) llmRoute.probe().then(st => audit.log('llm_route', st)).catch(() => { });
    const jev = overrides.jev || new Jev(c, ledger, audit, llmRoute.fetch), conversation = overrides.conversation || new Conversation(c, ledger, llmRoute.fetch), voice = overrides.voice || new DirectedVoice(c, ledger, { library }), research = overrides.research || new Research(c, ledger), youtube = overrides.youtube || new YouTube(c, ledger);
    const Runtime = c.profile === 'talk' ? TalkEngine : Engine;
    const commentVoice = overrides.commentVoice || new CommentVoice(c, ledger);
    const engine = new Runtime(c, { jev, conversation, voice, commentVoice, research, ledger, audit, youtube, twitch: overrides.twitch || new Twitch(c), showLogger });
    if (typeof voice.status === 'function' && 'onEvent' in voice) voice.onEvent = (kind, detail) => {
        engine.note(kind, detail);
        if (kind === 'voice_circuit') {
            engine.event('notice', { message: '音声エンジンが応答しません。回復を待って再開します（別の声へは切り替えません）。' });
            audit.log('voice_circuit', { provider: c.replyTtsProvider, reason: String(detail) });
        }
    };
    const obs = overrides.obs || new OBS(c), vts = overrides.vts || new VTubeStudio(c);
    // Who speaks as Noa (AI / a person) and whether she takes up comments (docs/CONTROL.md).
    const control = new Control(c, { engine, obs, audit, MeterOBS: overrides.MeterOBS === undefined ? OBS : overrides.MeterOBS });
    // The voice-call partner's speech to text: the local whisper.cpp server (docs/COLLAB.md).
    const stt = overrides.stt || new SpeechToText(c, overrides.sttFetch || fetch);
    let sttNoticeAt = 0;
    const switchOBS = overrides.switchOBS || new OBS(c);
    // The Studio's own game scenes (`<OBS_SCENE> - <game title>`) may show the Switch inputs (a 'switch'-captured game).
    const switchSetup = overrides.switchSetup || new SwitchSetup({ obs: switchOBS, dataDir: c.dataDir, sharedScene: name => typeof name === 'string' && name.startsWith(`${c.obsScene} - `) });
    const switchRecording = overrides.switchRecording || new SwitchRecording({ obs: new OBS(c), validate: () => switchSetup.validateConfigured() });
    let switchOperation = false, legacyOperation = false;
    const switchBusy = () => switchOperation || switchRecording.busy;
    const switchConflict = message => Object.assign(new Error(message), { code: 'SWITCH_CONFLICT', status: 409 });
    const assertLegacyAllowed = async () => {
        if (switchBusy()) throw switchConflict('Switchの設定・テスト録画が終わってから操作してください。');
        const configured = switchSetup.read();
        // A game captured from the Switch airs from its own scene; only a Mac-window game must not start under the Switch scene.
        if (configured && c.game?.capture?.kind !== 'switch') {
            const current = await switchOBS.call('GetCurrentProgramScene');
            if (current.currentProgramSceneName === configured.sceneName)
                throw switchConflict('Switch専用シーンを選択中です。通常番組を始める前にOBSを元の番組シーンへ戻してください。');
        }
        if (switchBusy()) throw switchConflict('Switchの設定・テスト録画が終わってから操作してください。');
    };
    const switchStatus = async () => {
        const s = await switchSetup.status(), o = s.output;
        return { ...s, busy: switchBusy() || legacyOperation || setupBusy, recording: switchRecording.snapshot(),
            obs: { connected: o.state !== 'unknown', streaming: o.streaming, recording: o.recording, replaying: o.replayBuffer, reconnecting: o.reconnecting } };
    };
    /** Reload the configuration from the saved settings (as saveSettings does) after a file under data/ changed. */
    const rebuildConfig = () => {
        const candidate = config({ ...c.settingsEnv, DATA_DIR: c.dataDir }, [], false);
        Object.assign(candidate, { adminToken: c.adminToken, viewToken: c.viewToken, port: c.port, host: c.host });
        Object.assign(c, candidate); c.settingsEnv = candidate.settingsEnv;
    };
    const programmesNow = () => loadProgrammes(c.dataDir);
    const wardrobe = new AvatarWardrobe(c.dataDir);
    const avatarMode = new AvatarMode(c.dataDir);
    const sponsor = new Sponsor(c.dataDir);
    const ads = overrides.ads || new AdLibrary(c.dataDir);
    const clients = new Set();
    let setupBusy = false, rehearsal = null, settingsRevision = 0, obsProof = null;
    const checkFingerprint = () => hash(JSON.stringify([c.mode, c.judgeURL, c.judgeModel, c.llmProvider, c.llmURL, c.llmModel, c.llmKey, c.geminiKey, c.geminiModel, c.voiceURL, c.speaker, c.voiceSpeed, c.character, c.programmeId, c.topicCards, c.readComments, c.commentSpeaker, c.commentSpeed, c.maxReadChars, c.maxReadAudioMs, c.replyTtsProvider, c.supertonicURL, c.supertonicVoice, c.supertonicSteps, c.supertonicSpeed, c.geminiTtsVoice, c.geminiTtsStyle,
        c.aivisURL, c.aivisStyle, c.aivisSpeed, c.aivisIntonation, c.aivisTempo, c.sbv2URL, c.sbv2Model, c.sbv2Speaker, c.sbv2Style, c.sbv2StyleWeight, c.sbv2Speed, c.hostStyleMap, c.speechDirection, c.reactionAudio, c.phraseCache, library.fingerprint?.() ?? '',
        // Credit strings stay out; whether a required credit is present does not.
        creditMissing(c)]));
    /** Library reload is a setup action: any change of what can air resets rehearsal, hearing, OBS proof and the remote arm. */
    const reloadLibrary = () => {
        const before = checkFingerprint(); library.reload();
        const changed = before !== checkFingerprint();
        if (changed) { resetChecks(); engine.lastAudioOK = false; voice.cache?.clear(); }
        return changed;
    };
    // The operator's "heard it" is kept per configuration (voice, models, library...): a restart does not ask again, any
    // change of what can air does. Each start then re-runs the same trial automatically and starts only if it passes.
    const APPROVAL_MS = 30 * 24 * 3600 * 1000, approvalFile = () => join(c.dataDir, 'rehearsal-approval.json');
    // One approval per exact setting heard (each still expires after APPROVAL_MS): switching programme and back again
    // does not ask to listen again for a setting already heard, while any new setting still must be heard.
    const approvals = () => { try { const a = JSON.parse(readFileSync(approvalFile(), 'utf8')); const list = Array.isArray(a.approvals) ? a.approvals : a.fingerprint ? [a] : [];
        return list.filter(x => typeof x?.fingerprint === 'string' && Number.isFinite(x.heardAt) && Date.now() - x.heardAt < APPROVAL_MS); } catch { return []; } };
    const savedApproval = () => approvals().find(a => a.fingerprint === checkFingerprint()) || null;
    const saveApproval = () => { try { const f = approvalFile(), now = checkFingerprint();
        const list = [{ fingerprint: now, heardAt: Date.now() }, ...approvals().filter(a => a.fingerprint !== now)].slice(0, 12);
        writeFileSync(`${f}.tmp`, JSON.stringify({ approvals: list }), { mode: 0o600 }); renameSync(`${f}.tmp`, f); } catch { } };
    /** One screen's answer to "can this show start?": each step with its verdict and where to fix it. Probes only the
     * configured local services and OBS (and the YouTube video when chat is on); nothing starts. ok: true | false | null (not needed). */
    const readiness = async () => {
        const live = c.mode === 'live', steps = [], at = Date.now();
        const add = (id, label, ok, note, link) => steps.push({ id, label, ok, note, link });
        let d; try { d = await detect(c); } catch (e) { d = { models: [], errors: [{ provider: 'LLM', error: diagnosticError(e) }, { provider: 'VOICEVOX', error: diagnosticError(e) }] }; }
        const err = name => d.errors.find(x => x.provider === name)?.error || null;
        const voiceName = { voicevox: 'VOICEVOX', supertonic: 'Supertonic', aivisspeech: 'AivisSpeech', sbv2: 'Style-Bert-VITS2', 'gemini-tts': 'Gemini TTS', 'gemini-lite-tts': 'Gemini TTS' }[c.replyTtsProvider] || 'VOICEVOX';
        const modelNamed = c.llmProvider === 'gemini' ? !!c.geminiKey && !!c.geminiModel : !!c.llmModel;
        add('model', '会話モデル', live ? !err('LLM') && modelNamed : null, !live ? 'DEMOでは使いません' : err('LLM') || (modelNamed ? `接続できました（${c.llmProvider === 'gemini' ? c.geminiModel : c.llmModel}）` : 'モデル名を選んで保存してください'), '/setup#providers');
        add('voice', `ホストの声（${voiceName}）`, !err(voiceName), err(voiceName) || '接続できました', '/setup#providers');
        add('commentVoice', 'コメント読み上げ（VOICEVOX）', c.readComments ? !err('VOICEVOX') : null, !c.readComments ? '読み上げは使いません' : err('VOICEVOX') || '接続できました', '/setup#providers');
        const judgeModel = c.judgeModel || (c.llmProvider !== 'gemini' ? c.llmModel : '');
        const hold = readBillingHold(c);
        if (hold) add('jevBilling', 'ゲーム操作の支払い停止', false, `HTTP 402 で停止中（${hold.heldAt ? hold.heldAt.slice(0, 16).replace('T', ' ') + ' UTC' : '時刻不明'}）。ゲーム側の残高を確認してから解除してください`, '/setup#readiness');
        add('judge', 'ローカル判定（安全審査）', live ? !!judgeModel && (c.judgeModel ? true : !err('LLM')) : null, !live ? 'DEMOでは使いません' : !judgeModel ? 'JUDGE_MODEL（または会話モデル）を設定してください' : `ローカルLLM（${judgeModel}）で判定します。判定できない文は流しません`, '/setup#providers');
        add('rehearsal', '試聴（開始時に自動検証）', live ? (rehearsal ? !!rehearsal.ok : null) : null, !live ? 'DEMOでは不要' : !rehearsal ? '開始時に自動で検証します' : rehearsal.ok ? '検証済み' : '前回の検証が失敗しました。試聴で原因を確認してください', '/setup#trial');
        try { await obs.connect(); } catch { }
        add('obs', 'OBS 接続', !!obs.ready, obs.ready ? '接続できました' : 'OBS の WebSocket（URL・パスワード）を確認してください', '/setup#broadcast');
        let sceneName = null, sceneOk = null;
        if (obs.ready) {
            sceneName = c.game ? obs.gameSources().scene : c.obsScene;
            try { sceneOk = ((await obs.call('GetSceneList')).scenes || []).some(x => x.sceneName === sceneName); } catch { sceneOk = false; }
        }
        add('obsScene', 'OBS 専用シーン', sceneOk, sceneName ? (sceneOk ? `${sceneName} があります` : `${sceneName} がありません。スタジオで「OBSに専用シーンを作る」を押してください`) : 'OBS 接続後に確認します', '/');
        if (c.game?.capture?.kind === 'switch') {
            let sw = null; try { sw = await switchSetup.status(); } catch { }
            add('switch', 'Switch の映像機器', !!sw?.configured, sw?.configured ? `${sw.videoLabel || '機器'} を設定済み（映像信号は未確認）` : 'Switch接続で映像と音声の機器を選んでください', '/switch');
        }
        // Simulcast with a channel id: the live broadcast is discovered on the channel at start (src/youtube.mjs), so a saved
        // video URL is not used and cannot be "ended".
        const discover = c.streamTarget === 'simulcast' && !!c.youtubeChannel;
        if (live && c.readComments && discover) add('youtube', 'YouTube 配信枠', null, '同時配信：配信開始後にチャンネルの配信中の枠を自動で見つけます', '/setup#broadcast');
        else if (live && c.readComments && c.youtubeVideo) {
            try { const r = await youtube.get('videos', { part: 'liveStreamingDetails', id: c.youtubeVideo }), det = r.items?.[0]?.liveStreamingDetails;
                const state = det?.actualEndTime ? 'ended' : det?.activeLiveChatId ? 'live' : 'waiting';
                add('youtube', 'YouTube 配信枠', state !== 'ended', { live: '配信中の枠です', waiting: '配信開始待ちの枠です（開始後にチャットへ接続）', ended: '終了した枠です。新しい動画URLを設定してください' }[state], '/setup#broadcast'); }
            catch (e) { add('youtube', 'YouTube 配信枠', false, diagnosticError(e), '/setup#broadcast'); }
        } else add('youtube', 'YouTube 配信枠', null, live && c.readComments ? '動画URL未設定（コメントなしで進行）' : '不要', '/setup#broadcast');
        // A spent daily budget or missing streaming packages silently left YouTube comments unread on 2026-10-05.
        if (live && c.readComments && c.streamTarget !== 'twitch' && (c.youtubeVideo || discover)) {
            const issue = youtubeChatStartIssue(c, ledger.snapshot());
            add('youtubeBudget', 'YouTube コメントの残り枠', !issue, issue ? issue.error : '本日の取得枠に余裕があります', '/setup#broadcast');
            if (c.youtubeTransport === 'stream')
                add('youtubeStream', 'YouTube コメントの常時接続', grpcAvailable(), grpcAvailable() ? '常時接続の部品があります' : '常時接続の部品がありません（npm run setup:youtube）。都度取得になり、取得枠を早く使い切ります', '/setup#broadcast');
        }
        add('recording', '録画で映像と音を確認', null, 'ローカル録画を再生し、声・ゲーム音・口パクを人が確認します（自動判定なし）', c.game?.capture?.kind === 'switch' ? '/switch' : '/');
        return { ready: steps.every(x => x.ok !== false), steps, mode: c.mode, checkedAt: at };
    };
    const resetChecks = () => { rehearsal = null; obsProof = null; settingsRevision++; remoteControl.disarm(); }; 
    let origin = `http://127.0.0.1:${c.port}`;
    let obsStopPromise = Promise.resolve();
    let memoryStopTimer, lastMemoryLevel;
    const memoryHold = new MemoryHold();
    // Audit only retains whitelisted metadata: put diagnostic values in state, never credentials.
    const memoryAudit = s => ({ reason: s.reason || s.level, state: JSON.stringify({ level: s.level, pressureLevel: s.pressureLevel, freePercent: s.freePercent, warningMs: s.warningMs }) });
    const memory = new MemoryGuard({ enabled: c.memoryGuard && c.mode === 'live', read: overrides.memoryRead, ...(overrides.memoryNow ? { now: overrides.memoryNow } : {}), sustainedStops: !c.keepLive,
        onChange: state => {
            if (state.level !== lastMemoryLevel) { audit.log('memory_state', memoryAudit(state)); lastMemoryLevel=state.level; } engine.event('memory', state);
            if (memoryHold.update(state)) { audit.log('memory_resume', memoryAudit(state)); engine.setMemoryHold(false, 'memory_recovered'); engine.event('notice', { message: 'メモリが回復しました。話を再開します。' }); }
        },
        onCritical: state => {
            if (!engine.running && !obs.owned) return;
            // KEEP_LIVE: the broadcast stays up. The talk holds (the line on air finishes, nothing new starts, the game
            // pauses) and the local conversation model is released, the largest single holder (~6 GB for the 9B);
            // the talk resumes after 20 s of normal readings (longer if it keeps coming back). Nothing else is closed or killed.
            if (c.keepLive) {
                if (!engine.running || !memoryHold.critical(state)) return;
                audit.log('memory_hold', memoryAudit(state));
                engine.setMemoryHold(true, state.reason || 'memory_pressure');
                engine.event('notice', { message: 'メモリの余裕が減ったため、配信は続けたまま話を一時停止し、会話モデルを解放しました。回復したら自動で再開します。' });
                conversation.release?.().then(released => audit.log('memory_release', { reason: released ? 'llm_unloaded' : 'llm_not_local', state: '{}' }))
                    .catch(e => audit.log('memory_release', { reason: 'llm_release_failed', state: JSON.stringify({ status: e.status ?? null }) }));
                return;
            }
            audit.log('memory_pressure_stop', memoryAudit(state));
            const forceStop = () => { engine.stop('memory_pressure'); obs.stopOwned().catch(() => engine.event('notice', {message:'OBS停止を確認できません。OBS画面で確認してください。'})); };
            if (state.immediate) { forceStop(); return; }
            engine.event('notice', {message:'メモリの余裕が減っています。終了の挨拶をして配信を停止します。'});
            memoryStopTimer ??= setTimeout(forceStop, 20000);
            engine.requestBudgetClose?.('memory_pressure');
        } });
    memory.start();
    const dg = c.diskGuard || {};
    const disk = new DiskGuard({ enabled: !!dg.enabled && c.mode === 'live', path: c.dataDir, ...(overrides.diskRead ? { read: overrides.diskRead } : {}),
        startGb: dg.startGb, lowGb: dg.lowGb, criticalGb: dg.criticalGb,
        onChange: s => { audit.log('disk_state', { reason: s.level, state: JSON.stringify({ freeGb: s.freeGb }) }); engine.event('disk', s); },
        onLow: s => {
            if (!engine.running && !obs.owned) return;
            audit.log('disk_low', { reason: s.level, state: JSON.stringify({ freeGb: s.freeGb }) });
            obs.stopRecording().then(stopped => engine.event('notice', { message: stopped ? `ディスクの空きが${s.freeGb}GBに減ったため、録画だけ止めました。配信は続けます。` : `ディスクの空きが${s.freeGb}GBです。` }));
        },
        onCritical: s => {
            if (!engine.running) return;
            audit.log('disk_critical', { reason: s.level, state: JSON.stringify({ freeGb: s.freeGb }) });
            engine.event('notice', { message: `ディスクの空きが${s.freeGb}GBしかありません。終了の挨拶をして配信を終えます。` });
            engine.requestClose?.('disk_low');
        } });
    disk.start();
    // A new title on YouTube and Twitch once OBS transmits (src/stream-title.mjs); a failure is reported, the stream goes on.
    // Standby (STANDBY_SECONDS): the stream opens on the 配信準備中 screen; after that long the programme scene goes on air and
    // the held show begins (src/talk-engine.mjs standby). A failed scene switch still releases the show (and says so).
    let standbyTimer = null;
    // The phone remote starts OBS before the show (no standby yet): the screen goes up for it too.
    const standbyScreen = async () => { if (c.standbyMs > 0 && c.mode === 'live' && (!engine.running || engine.standby)) await obs.showScreen('standby'); };
    const scheduleShow = () => {
        if (!(c.standbyMs > 0) || !engine.standby) return;
        clearTimeout(standbyTimer);
        const epoch = engine.epoch;
        standbyTimer = setTimeout(async () => {
            if (!engine.alive(epoch)) return;
            try { await obs.showScreen('show'); } catch { engine.event('notice', { message: '配信準備中の画面から番組の画面に切り替えられませんでした。OBS で番組のシーンにしてください。' }); }
            engine.releaseStandby?.(); audit.log('standby_released', {});
        }, c.standbyMs);
        standbyTimer.unref?.();
    };
    engine.on('stopped', () => { clearTimeout(standbyTimer); standbyTimer = null; });
    const titler = overrides.titler || new StreamTitler(c);
    const retitle = () => { if (!titler.enabled) return; void titler.apply().then(r => {
        audit.log('stream_title', { reason: r.status, state: JSON.stringify({ number: r.number, youtube: r.youtube, twitch: r.twitch }) });
        engine.event('notice', { message: r.status === 'done' ? `配信タイトルを「${r.title}」にしました。` : `配信タイトルを更新できませんでした（YouTube: ${r.youtube} / Twitch: ${r.twitch}）。` });
    }); };
    // Before a start: old player logs, Studio logs and OBS recordings past the newest few go (src/disk-guard.mjs prune).
    const pruneDisk = async () => {
        if (!disk.enabled) return;
        const recordingsDir = obs.ready ? await obs.recordDirectory() : '';
        const r = pruneFiles({ runsDir: c.gameLogDir || '', dataDir: c.dataDir, recordingsDir, keepRecordings: dg.keepRecordings, runsDays: dg.runsDays, logsDays: dg.logsDays });
        if (r.removed.length) {
            const gb = Math.round(r.bytes / 1024 ** 3 * 10) / 10;
            audit.log('disk_prune', { count: r.removed.length, reason: `${gb}GB` });
            engine.event('notice', { message: `古いファイルを${r.removed.length}件整理しました（${gb}GB）。` });
        }
    };
    engine.on('stopped', () => { clearTimeout(memoryStopTimer); memoryStopTimer = null; memoryHold.reset(); });
    const remoteControl = new RemoteControl({ c, engine, obs, fingerprint: checkFingerprint,
        memoryPreflight: async () => { await assertLegacyAllowed(); await memory.assertStart(); },
        verified: () => !!rehearsal?.ok && !creditMissing(c),
        outputVerified: () => !!obsProof && obsProof.fingerprint === checkFingerprint(),
        setupBusy: () => setupBusy || switchBusy() || legacyOperation, waitForStop: () => obsStopPromise, localOrigin: () => origin, beforeStart: standbyScreen, onTransmitting: () => { scheduleShow(); retitle(); } });
    const remote = remoteOptions ? createRemoteServer(remoteOptions, remoteControl, { publicDir: `${ROOT}/public` }) : null;
    // Permission to start a stream is not ownership of an already active OBS output.
    engine.on('stopped', reason => { remoteControl.cancelStart(); vts.mouth(0); obsStopPromise = (async () => {
        if (c.endScreenMs > 0 && obs.owned && reason === 'show_completed') { try { await obs.showScreen('ended'); await new Promise(r => setTimeout(r, c.endScreenMs)); } catch { } }
        return obs.stopOwned();
    })().catch(() => engine.event('notice', { message: 'OBS停止を確認できません。OBS画面で配信停止を確認してください。' })); });
    // Clip studio (scripts/clip-studio.mjs, operator 2026-10-11): once a completed live show has stopped OBS (and its
    // recording), edited clips, Shorts and thumbnails are made from the recording and published, in a low-priority child
    // process; what the day's YouTube budget cannot take waits in the queue, retried every hour.
    let clipJob = null;
    const clipsRun = (args = [], why = '') => {
        if (clipJob || !existsSync(`${ROOT}/scripts/clip-studio.mjs`)) return false;
        mkdirSync(join(c.dataDir, 'post-stream'), { recursive: true });
        const log = openSync(join(c.dataDir, 'post-stream', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), 'a');
        clipJob = spawn('nice', ['-n', '15', process.execPath, `${ROOT}/scripts/clip-studio.mjs`, ...args], { cwd: ROOT, stdio: ['ignore', log, log], env: process.env });
        audit.log('clips_started', { reason: why });
        clipJob.on('exit', code => { clipJob = null; closeSync(log); audit.log('clips_finished', { reason: String(code) }); engine.event('notice', { message: code === 0 ? (c.clipStudio?.upload ? '切り抜き・ショートの作成と投稿の処理が終わりました。' : '切り抜き・ショートを作りました（投稿用のタイトルと説明は data/post-stream の 投稿メモ.txt）。') : '切り抜きの処理が途中で止まりました（data/post-stream の記録を確認してください）。' }); });
        clipJob.on('error', () => { clipJob = null; closeSync(log); });
        return true;
    };
    const clipsAuto = () => c.mode === 'live' && c.obsRecord && c.clipStudio?.auto && !overrides.noClips;
    engine.on('stopped', reason => {
        if (reason !== 'show_completed' || !clipsAuto()) return;
        const after = obsStopPromise;
        // The recording file is complete once OBS has stopped it; a short wait lets OBS finish writing.
        Promise.resolve(after).then(() => setTimeout(() => { if (clipsRun([], 'show_completed')) engine.event('notice', { message: '配信の録画から、切り抜き・ショート・サムネイルを作り始めました。' }); }, 15000).unref?.());
    });
    const clipsQueueTimer = setInterval(() => {
        if (!clipsAuto() || clipJob || engine.running) return;
        try { if (JSON.parse(readFileSync(join(c.dataDir, 'post-stream', 'queue.json'), 'utf8')).items.some(x => x.status === 'pending')) clipsRun(['--upload-queue'], 'queue'); } catch { }
    }, 3600000); clipsQueueTimer.unref?.();
    // A game from games/<id>: its controller (Jev playing via the manifest's command) starts and stops with the show,
    // however it is started (Studio, phone remote). Only the show's own state drives it.
    // The show knows who has the controls (Phase 5): its lines and the stage label follow the runtime player.
    const gameRunner = overrides.gameRunner || new GameRunner(c, { emit: (type, data) => { if (type === 'game_runner') engine.blocks?.setRuntimePlayer?.(data?.player); engine.event(type, data); } });
    control.gameRunner = gameRunner; // F7 / game-toggle (Phase 6)
    // The operator's hotkeys (Phase 6): data/hotkeys.json, else the defaults (public/hotkeys.mjs).
    const hotkeysFile = join(c.dataDir, 'hotkeys.json');
    const hotkeys = () => { try { return validHotkeys(JSON.parse(readFileSync(hotkeysFile, 'utf8'))); } catch { return { ...DEFAULT_HOTKEYS }; } };
    let showRunning = false, gamePhase = null;
    engine.on('event', event => {
        // if (event.type === 'game_runner' && ['finished','failed'].includes(event.data?.state) && engine.running && c.jevSessionMaxUsd) engine.requestBudgetClose?.(event.data.state === 'failed' ? 'game_runner_failed' : 'game_runner_finished');
        if (event.type === 'budget_closing') gameRunner.stop();
        if (event.type === 'round_review_failed' && engine.running && c.keepLive) {
            // KEEP_LIVE: a review that cannot pass the gate is skipped (nothing unreviewed airs) and the next round starts.
            audit.log('round_review_skipped', { id: event.data.runId, reason: event.data.reason });
            engine.event('notice', { message: '振り返りが審査を通らなかったため省略して、次のラウンドへ進みます。' });
            if (!gameRunner.completeReview?.({ runId: event.data.runId, tactic: event.data.tactic, skipped: true })) engine.requestBudgetClose?.('round_review_failed');
        }
        else if (event.type === 'round_review_failed' && engine.running) {
            audit.log('round_review_failed', { id: event.data.runId, reason: event.data.reason });
            engine.event('notice', { message: '再開前の音声確認を完了できませんでした。終了の挨拶をして停止します。' });
            engine.requestBudgetClose?.('round_review_failed');
        }
        if (event.type === 'round_review_completed' && engine.running && !engine.budgetClosingRequested) gameRunner.completeReview?.(event.data);
    });
    const gameShowKey = c.game ? engine.blocks?.statusKey : null; // the event type the game's show reports its phase with
    // The game picture appears when its controller starts, or at once for a game a person plays (nothing to launch).
    const gameStarts = () => gameRunner.enabled || c.game?.player === 'operator';
    const gameVisible = visible => { if (obs.ready && c.game) obs.setGameVisible(visible).catch(() => { }); };
    // A controller sets the game up first (menus, the game's Twitch channel): its picture appears once it plays.
    let captureOnPlay = false;
    const startGame = remainingMs => { if (gameRunner.enabled) { captureOnPlay = true; gameRunner.start(remainingMs); } else gameVisible(true); };
    engine.on('event', event => {
        if (gameShowKey && event.type === gameShowKey) {
            // The opening talk ended (operator or time limit): now the game starts, for the show time that is left.
            const phase = event.data?.phase;
            if (gamePhase === 'lobby' && phase !== 'lobby' && showRunning && gameStarts()) startGame(engine.running ? engine.endAt - Date.now() : undefined);
            if (phase === 'lobby') gameVisible(false);
            gamePhase = phase;
            return;
        }
        if (event.type === 'game_runner' && captureOnPlay && event.data?.state === 'playing') { captureOnPlay = false; gameVisible(true); }
        if (event.type !== 'state') return;
        const running = !!event.data?.running;
        gameRunner.setStreaming?.(running);
        // Without an opening talk the game starts with the show; with one, it waits for the game to be announced.
        if (running && !showRunning && gameStarts() && engine.blocks?.phase !== 'lobby') startGame();
        showRunning = running;
    });
    engine.on('stopped', () => { captureOnPlay = false; showRunning = false; gameRunner.setStreaming?.(false); if (!gameRunner.standalone) gameRunner.stop();
        // 2026-10-19: after a stop the closed game's last frame stayed on the OBS scene under the stage: take it off.
        gameVisible(false); });
    // A game may relaunch its window for every run (Vampire Survivors does): re-point the OBS game capture on each run.
    engine.on('event', event => { if (gameShowKey && event.type === gameShowKey && event.data?.phase === 'playing' && obs.ready) obs.refreshGameWindow().catch(() => { }); });
    // On-stream chat box and Noa's commands (OBS_CHAT_SOURCE / OBS_ACTIONS_SOURCE, public/overlay-*.html): the Studio's own
    // YouTube and Twitch receivers feed the chat, the run-log feed's game_actions feed the commands. Nothing is fetched twice.
    const overlayChat = [], overlayClients = { chat: new Set(), actions: new Set() };
    const overlaySend = (kind, data) => { const line = `data: ${JSON.stringify(data)}\n\n`; for (const r of overlayClients[kind]) { if (r.writableLength > 64000) { r.destroy(); overlayClients[kind].delete(r); } else r.write(line); } };
    engine.on('viewer_comment', m => { overlayChat.push(m); if (overlayChat.length > 30) overlayChat.shift(); overlaySend('chat', m); });
    engine.on('event', event => { if (event.type === 'game_actions') overlaySend('actions', event.data?.items || []); });
    // Chat / command overlays follow the show: beside Noa during the opening talk, under the game while it plays.
    let overlaysTalk = null, closingTalk = false;
    const placeOverlays = talk => {
        if (!obs.ready || typeof obs.placeOverlays !== 'function' || talk === overlaysTalk) return;
        overlaysTalk = talk;
        obs.placeOverlays(talk).catch(() => { overlaysTalk = null; });
    };
    engine.on('event', event => {
        if (!gameShowKey || event.type !== gameShowKey || !event.data?.phase) return;
        placeOverlays(closingTalk || event.data.phase === 'lobby');
    });
    engine.on('stopped', () => placeOverlays(true)); // stopped: the stage shows the talk look, so the chat goes back beside Noa
    // The goodbye is talk, not play (operator 2026-10-11): when it begins the game player stops (its picture stays while
    // Noa ends the game in one line); once that first line has aired the game leaves the screen, the overlays move beside
    // Noa and the stage takes the opening-talk layout (public/stage.mjs reads the state's farewell step).
    let closingGameStopped = false;
    engine.on('event', event => {
        if (event.type === 'farewell' && c.game && !closingGameStopped) {
            closingGameStopped = true; captureOnPlay = false;
            if (!gameRunner.standalone) gameRunner.stop();
        }
        if (event.type !== 'state' || !event.data?.running) return;
        if (!event.data.farewell) { closingTalk = false; closingGameStopped = false; return; }
        if (c.game && !closingTalk && event.data.farewell.step >= 1) { closingTalk = true; gameVisible(false); placeOverlays(true); }
    });
    // Optional stream watch (off unless STREAM_WATCH=claude|codex): a small snapshot every few minutes, reviewed by a local agent.
    const streamWatch = overrides.streamWatch || new StreamWatch(c, {
        collect: async () => {
            const st = engine.status(), counters = st.metrics?.counters || {}, show = engine.blocks;
            let obsStatus = null;
            if (obs.ready) { try { const r = await obs.call('GetStreamStatus'); obsStatus = { active: !!r.outputActive, reconnecting: !!r.outputReconnecting, skippedFrames: r.outputSkippedFrames, totalFrames: r.outputTotalFrames, durationMs: r.outputDuration }; } catch { obsStatus = null; } }
            const pick = ['turns_played', 'content_rejected', 'content_stall_stops', 'content_stall_skips', 'generation_failure', 'audio_part_failure', 'chat_received', 'chat_selected', 'comment_completed', 'comment_fixed_ack', 'speech_direction_failure', 'tts_stream_truncated'];
            return { show: { running: st.running, phase: st.phase, closing: !!st.farewell, youtubeComments: st.youtube, twitchComments: st.twitch, gamePhase: show?.phase ?? null, remainingMin: Math.round((st.remainingMs || 0) / 60000), queue: st.queue },
                counters: Object.fromEntries(pick.filter(k => counters[k] !== undefined).map(k => [k, counters[k]])),
                runner: gameRunner.enabled ? { enabled: true, state: gameRunner.status().state, detail: String(gameRunner.status().detail || '').slice(0, 80), runs: gameRunner.status().runs } : { enabled: false },
                game: show?.snapshot ? { run: show.roundNo ?? null, elapsed: show.snapshot.elapsed ?? null, level: show.snapshot.level ?? null, hpRatio: show.snapshot.hpRatio ?? null, enemies: show.snapshot.enemies ?? null } : null,
                obs: obsStatus, memory: { level: memory.state?.level, freePercent: memory.state?.freePercent ?? null }, disk: { level: disk.state?.level, freeGb: disk.state?.freeGb ?? null }, title: { status: titler.state.status } };
        },
        notify: message => engine.event('notice', { message }),
        memoryHigh: () => ['warning', 'critical'].includes(memory.state?.level) || (Number.isFinite(memory.state?.freePercent) && memory.state.freePercent < 15),
    }).start();
    engine.on('event', event => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) {
        if (res.writableLength > 256000) {
            res.destroy();
            clients.delete(res);
            continue;
        }
        res.write(data);
    } });
    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
        let releaseLegacy = false, adminRequest = false;
        const json = (status, x) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(x)); };
        try {
            const activePort = server.address()?.port || c.port;
            origin = `http://127.0.0.1:${activePort}`;
            const validHosts = new Set([`127.0.0.1:${activePort}`, `localhost:${activePort}`]);
            if (!validHosts.has(req.headers.host))
                return json(403, { error: 'Invalid Host' });
            const u = new URL(req.url, origin);
            if (req.headers.origin && !new Set([origin, `http://localhost:${activePort}`]).has(req.headers.origin))
                return json(403, { error: 'Cross-origin request blocked' });
            const bearer = req.headers.authorization?.replace(/^Bearer /, '');
            const isAdmin = equal(bearer, c.adminToken); adminRequest = isAdmin;
            const view = bearer || u.searchParams.get('token');
            const isView = equal(view, c.viewToken) || isAdmin;
            if (req.method === 'GET' && u.pathname === '/healthz')
                return json(200, { ok: true, pid: process.pid, mode: c.mode, running: engine.running, phase: engine.phase, ownedOBS: obs.owned, renderer: engine.status().renderer, offStage: !!engine.standby || (!!obs.screen && obs.screen !== 'show') });
            if (req.method === 'GET' && u.pathname === '/api/session') {
                if (!isAdmin)
                    return json(401, { error: 'Unauthorized' });
                return json(200, { memory: memory.state, viewToken: c.viewToken, streamTarget: c.streamTarget, llmRoute: llmRoute.status(), youtubeBroadcast: { videoId: youtube.videoId || c.youtubeVideo || null, discovered: !!youtube.videoId, readComments: !!c.readComments, scheduleAuthorized: existsSync(join(c.dataDir, 'youtube-schedule-oauth.json')) }, status: engine.status(), gameRunner: gameRunner.status(), jev: jev.status(), wardrobe: wardrobe.snapshot(), avatarMode: avatarMode.snapshot(), sponsor: sponsor.snapshot(), ads: ads.snapshot(), allowStream: c.allowStream, obsConnected: obs.ready, obsOwned: obs.owned, vtsEnabled: c.vtsEnabled, vtsReady: vts.ready, searchConfigured: !!c.searchURL, rehearsalOK: !!rehearsal?.ok, rehearsalHeard: !!rehearsal?.heard, rehearsalApproved: !!savedApproval(), setup: publicSettings(c) });
            }
            if (req.method === 'GET' && (u.pathname === '/api/comments' || u.pathname === '/api/chat')) {
                if (!isView) return json(401, { error: 'Unauthorized' });
                return json(200, {
                    ok: true,
                    transport: c.youtubeTransport || 'stream',
                    youtubeStatus: engine.youtubeStatus || 'not_connected',
                    twitchStatus: engine.twitchStatus || 'not_connected',
                    commentsPaused: !!engine.commentsPaused,
                    stats: engine.stats,
                    participation: engine.participation?.summary?.() || null,
                    queue: (engine.intake || []).map(m => ({ id: m.id, text: m.text, source: m.source, created: m.created })),
                    candidates: (engine.candidates || []).map(m => ({ id: m.id, text: m.text, source: m.source, kind: m.kind, replyState: m.replyState })),
                    recent: (engine.recentComments || []).slice(-50)
                });
            }
            if (req.method === 'GET' && u.pathname === '/api/programmes') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                const { programmes, warnings } = programmesNow();
                return json(200, { programmes: programmes.map(editable), warnings, current: c.programmeId });
            }
            if (req.method === 'GET' && u.pathname === '/api/readiness') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (setupBusy || switchBusy() || legacyOperation) return json(409, { error: '試聴・接続確認の完了を待ってください。' });
                setupBusy = true;
                try { return json(200, await readiness()); } finally { setupBusy = false; }
            }
            if (req.method === 'GET' && u.pathname === '/api/sponsor') {
                if (!isView) return json(401, { error: 'Unauthorized' });
                return json(200, sponsor.snapshot());
            }
            if (req.method === 'GET' && u.pathname === '/api/ads') {
                if (!isView) return json(401, { error: 'Unauthorized' });
                return json(200, ads.snapshot());
            }
            if (req.method === 'GET' && u.pathname.startsWith('/api/sponsor/image/')) {
                // Images are fetched as authenticated blobs; never place credentials in an image URL.
                if (!isAdmin && !equal(bearer, c.viewToken)) return json(401, { error: 'Unauthorized' });
                const id = u.pathname.slice('/api/sponsor/image/'.length), image = sponsor.image(id) || ads.file(id);
                if (!image) return json(404, { error: 'Image not found' });
                res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length });
                return res.end(image.bytes);
            }
            if (req.method === 'GET' && u.pathname === '/api/avatar/wardrobe') {
                if (!isView) return json(401, { error: 'Unauthorized' });
                return json(200, wardrobe.snapshot());
            }
            if (req.method === 'GET' && u.pathname === '/api/avatar/mode') {
                if (!isView) return json(401, { error: 'Unauthorized' });
                return json(200, avatarMode.snapshot());
            }
            if (req.method === 'GET' && u.pathname.startsWith('/api/switch/')) {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (u.pathname === '/api/switch/status') return json(200, await switchStatus());
                if (u.pathname === '/api/switch/preview') {
                    if (switchBusy() || legacyOperation || setupBusy || engine.running || obs.owned || remoteControl.busy)
                        throw switchConflict('設定・番組・録画を停止してから映像を確認してください。');
                    const ready = await switchSetup.validateConfigured();
                    const image = await switchOBS.call('GetSourceScreenshot', { sourceName: ready.sceneName, imageFormat: 'jpg', imageWidth: 1280, imageCompressionQuality: 70 });
                    if (typeof image.imageData !== 'string' || image.imageData.length > 3000000 || !/^data:image\/jpe?g;base64,[A-Za-z0-9+/=]+$/.test(image.imageData))
                        throw switchConflict('OBSから確認画像を取得できませんでした。');
                    const bytes = Buffer.from(image.imageData.slice(image.imageData.indexOf(',') + 1), 'base64');
                    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length }); return res.end(bytes);
                }
                return json(404, { error: 'Not found' });
            }
            if (req.method === 'GET' && u.pathname === '/api/obs/destination') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                return json(200, await obs.destination());
            }
            if (req.method === 'GET' && u.pathname === '/api/programme/report') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                const includeTranscript = u.searchParams.get('transcript') === 'true' || !!u.searchParams.get('session');
                const sessionParam = u.searchParams.get('session');
                const analysis = includeTranscript ? showLogger.analyzeSession(sessionParam) : null;
                const sessions = includeTranscript ? showLogger.getSessions().slice(0, 10) : undefined;
                return json(200, { version: '0.2.0-rc.6', programme: c.programmeId, mode: c.mode,
                    basis: 'local_playback_end_ack_not_YouTube_analytics', markers: [...(engine.markers || [])],
                    metrics: engine.metrics?.snapshot() || null, transcriptIncluded: !!analysis,
                    participation: includeTranscript ? analysis?.participation || null : engine.participation?.snapshot() || null,
                    recentParticipation: await showLogger.participationSessions(6),
                    // Estimated cloud voice spend (local estimate from generated audio; not a Google invoice). `session` is this
                    // broadcast; `totals` are the day/month running totals the caps apply to. Null when no cloud voice is set up.
                    cloudSpend: engine.voice?.router?.spend ? { basis: 'app_estimate_not_invoice', session: engine.voice.router.spend.sessionSnapshot(), totals: engine.voice.router.spend.snapshot() } : null,
                    ...(includeTranscript ? {
                        analysis: analysis?.summary || null,
                        timeline: analysis?.timeline || [],
                        session: analysis ? {
                            id: analysis.sessionId,
                            programmeTitle: analysis.programmeTitle,
                            durationFormatted: analysis.durationFormatted,
                            durationSec: analysis.durationSec,
                            startedAt: analysis.startedAt,
                            stoppedAt: analysis.stoppedAt,
                            stopReason: analysis.stopReason
                        } : null,
                        recentSessions: sessions
                    } : {}) });
            }
            if (req.method === 'GET' && u.pathname === '/api/programme/analysis') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                const sessionParam = u.searchParams.get('session');
                const analysis = showLogger.analyzeSession(sessionParam);
                const sessions = showLogger.getSessions().slice(0, 20);
                return json(200, { ok: true, session: analysis, recentSessions: sessions });
            }
            if (req.method === 'GET' && u.pathname === '/api/post-stream') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                const read = f => { try { return JSON.parse(readFileSync(join(c.dataDir, 'post-stream', f), 'utf8')); } catch { return null; } };
                const q = read('queue.json');
                return json(200, { running: !!clipJob, auto: !!clipsAuto(), status: read('status.json'), queue: q ? q.items.map(x => ({ id: x.id, kind: x.kind, title: x.meta?.title, status: x.status, videoId: x.videoId || null, error: x.error || null })) : [] });
            }
            // The operator's hotkeys (Phase 6): the Studio, the Live Control Panel and scripts/global-hotkeys.mjs read them.
            if (u.pathname === '/api/hotkeys' && (req.method === 'GET' || req.method === 'POST')) {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (req.method === 'GET') return json(200, { map: hotkeys(), defaults: DEFAULT_HOTKEYS, actions: HOTKEY_ACTIONS });
                const data = await body(req);
                let map;
                try { map = data.reset === true ? { ...DEFAULT_HOTKEYS } : validHotkeys(data.map); } catch (e) { return json(400, { error: e.message }); }
                writeFileSync(hotkeysFile, JSON.stringify(map, null, 2));
                audit.log('hotkeys_saved', { keys: Object.keys(map).length });
                return json(200, { map, defaults: DEFAULT_HOTKEYS, actions: HOTKEY_ACTIONS });
            }
            if (req.method === 'GET' && u.pathname === '/api/monitor') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                const s = engine.status();
                return json(200, { ...engine.operatorView(), programme: s.topic ? { title: s.topic.title, progress: s.topic.progress, stage: s.topic.stage, commentsPaused: s.commentsPaused } : null,
                    // The voice call, for the operator only (transcripts never go to the view-token event stream).
                    collab: engine.collab ? { speaking: engine.collab.speakingFor() > 0, dialogue: engine.collab.dialogue(6), stt: { error: stt.lastError, ms: stt.lastMs } } : null,
                    avatar: { vtsEnabled: c.vtsEnabled, vtsReady: vts.ready, renderer: s.renderer } });
            }
            if (req.method === 'GET' && u.pathname === '/api/remote/access') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                return json(200, { ...remoteControl.summary(), enabled: !!remote, origin: remoteOptions?.origin || '' });
            }
            if (req.method === 'GET' && u.pathname === '/api/settings') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                return json(200, { ...publicSettings(c), library: library.status(), rehearsal: rehearsal ? { ok: rehearsal.ok, heard: rehearsal.heard, checks: rehearsal.checks } : null });
            }
            if (req.method === 'GET' && u.pathname.startsWith('/api/setup/comment-audio/')) {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (!rehearsal?.ok || u.pathname !== `/api/setup/comment-audio/${rehearsal.id}.wav` || !rehearsal.commentAudio) return json(404, { error: 'Trial expired' });
                res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(rehearsal.commentAudio.bytes);
            }
            if (req.method === 'GET' && u.pathname.startsWith('/api/setup/library-audio/')) {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (!rehearsal?.ok || u.pathname !== `/api/setup/library-audio/${rehearsal.id}.wav` || !rehearsal.libraryAudio) return json(404, { error: 'Trial expired' });
                res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(rehearsal.libraryAudio.bytes);
            }
            if (req.method === 'GET' && u.pathname.startsWith('/api/setup/audio/')) {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (!rehearsal?.audio || u.pathname !== `/api/setup/audio/${rehearsal.id}.wav`) return json(404, { error: 'Trial audio expired' });
                res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(rehearsal.audio.bytes);
            }
            if (req.method === 'GET' && (u.pathname === '/overlay/chat-events' || u.pathname === '/overlay/action-events')) {
                const kind = u.pathname === '/overlay/chat-events' ? 'chat' : 'actions';
                if (!isView)
                    return json(401, { error: 'Unauthorized' });
                if (overlayClients[kind].size >= 4)
                    return json(429, { error: 'Too many viewers' });
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
                if (kind === 'chat') for (const m of overlayChat) res.write(`data: ${JSON.stringify(m)}\n\n`);
                else res.write(`data: ${JSON.stringify(engine.gameActions?.items || [])}\n\n`);
                overlayClients[kind].add(res);
                const t = setInterval(() => res.write(': heartbeat\n\n'), 10000);
                req.on('close', () => { clearInterval(t); overlayClients[kind].delete(res); });
                return;
            }
            if (req.method === 'GET' && u.pathname === '/events') {
                if (!isView)
                    return json(401, { error: 'Unauthorized' });
                if (clients.size >= 12)
                    return json(429, { error: 'Too many viewers' });
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
                res.write(`data: ${JSON.stringify({ type: 'state', data: engine.status(), at: Date.now() })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'wardrobe', data: wardrobe.snapshot(), at: Date.now() })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'avatar_mode', data: avatarMode.snapshot(), at: Date.now() })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'sponsor', data: sponsor.snapshot(), at: Date.now() })}\n\n`);
                res.write(`data: ${JSON.stringify({ type: 'ads', data: ads.snapshot(), at: Date.now() })}\n\n`);
                clients.add(res);
                const t = setInterval(() => res.write(': heartbeat\n\n'), 10000);
                req.on('close', () => { clearInterval(t); clients.delete(res); });
                return;
            }
            if (req.method === 'GET' && /^\/audio\/[a-f0-9-]{36}\.wav$/.test(u.pathname)) {
                if (!isView)
                    return json(401, { error: 'Unauthorized' });
                const bytes = engine.audio.get(u.pathname.slice(7, -4));
                if (!bytes)
                    return json(404, { error: 'Audio expired' });
                res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
                res.end(bytes);
                return;
            }
            if (req.method === 'GET' && /^\/audio\/[a-f0-9-]{36}\.pcm$/.test(u.pathname)) {
                if (!isView)
                    return json(401, { error: 'Unauthorized' });
                const st = engine.streams.get(u.pathname.slice(7, -4));
                if (!st)
                    return json(404, { error: 'Audio expired' });
                // Chunked raw PCM16 mono, replayed from the start, then followed live until the part ends.
                res.writeHead(200, { 'Content-Type': `audio/L16; rate=${st.rate}; channels=1` });
                const unsubscribe = st.subscribe(chunk => { if (chunk) res.write(chunk); else res.end(); });
                req.on('close', unsubscribe);
                return;
            }
            if (req.method === 'POST' && u.pathname.startsWith('/api/renderer/')) {
                if (!isView)
                    return json(401, { error: 'Unauthorized' });
                const data = await body(req);
                if (u.pathname === '/api/renderer/claim') {
                    // The OBS output (its key is only in the URL the Studio gave OBS) takes the voice over from a preview:
                    // going live must not depend on muting a preview tab first. A preview never takes it from OBS.
                    const obsClaim = equal(data.rendererKey, c.obsRendererToken);
                    if (obsClaim && engine.renderer?.role === 'preview' && engine.renderer.client !== data.client && engine.renderer.until > Date.now()) {
                        engine.cancelSpeech?.('renderer_takeover'); engine.renderer = null;
                    }
                    const r = engine.claimRenderer(data.client);
                    if (r.acquired) engine.renderer.role = equal(data.rendererKey, c.obsRendererToken) ? 'obs' : 'preview';
                    return json(200, r);
                }
                // The stage faded the AI voice out after a handoff (src/control.mjs latency): only the audio owner reports.
                if (u.pathname === '/api/renderer/handoff') return json(200, { ok: engine.validLease(data.lease) && control.reportSilent(data.seq) });
                if (u.pathname === '/api/renderer/release')
                    return json(200, { released: engine.releaseRenderer(data.lease) });
                if (u.pathname === '/api/renderer/ack') {
                    const proved = data.event === 'ended' && ['wav', 'stream'].includes(engine.pending?.kind) && engine.renderer?.role === 'obs';
                    const ok = engine.acknowledge(data);
                    if (ok && proved) obsProof = { fingerprint: checkFingerprint(), at: Date.now() };
                    return json(200, { ok });
                }
                if (u.pathname === '/api/renderer/game') {
                    // Only the current audio-lease owner runs the game; its reports are validated field by field.
                    if (!engine.validLease(data.lease) || typeof engine.ingestGame !== 'function') return json(403, { error: 'Invalid renderer' });
                    return json(200, engine.ingestGame(sanitizeGameReport(data)));
                }
                if (u.pathname === '/api/renderer/avatar') {
                    if (!engine.validLease(data.lease) || !data.params || typeof data.params !== 'object')
                        return json(403, { error: 'Invalid renderer' });
                    const params = {};
                    for (const id of Object.keys(PARAMS)) if (Number.isFinite(data.params[id])) params[id] = clampParam(id, data.params[id]);
                    // The narrator is not the avatar's voice.
                    if (engine.pending?.role === 'comment') params.ParamMouthOpenY = 0;
                    const forwarded = vts.frame(params);
                    return json(200, { ok: true, forward: vts.ready, forwarded });
                }
                if (u.pathname === '/api/renderer/mouth') {
                    if (!engine.validLease(data.lease) || !Number.isFinite(data.value))
                        return json(403, { error: 'Invalid renderer' });
                    vts.mouth(engine.pending?.role === 'comment' ? 0 : data.value);
                    return json(200, { ok: true });
                }
                return json(404, { error: 'Not found' });
            }
            if (req.method === 'POST' && u.pathname === '/api/ads/media') {
                // One creative file in, one content-addressed descriptor out; it is shown only once saved into the list.
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                try {
                    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
                    if (!AD_UPLOAD_TYPES.includes(mime)) return json(415, { error: '画像（PNG / JPEG / WebP）、動画（MP4 / WebM）、PDF のいずれかを選んでください。' });
                    const bytes = await rawBody(req, AD_UPLOAD_LIMIT);
                    const name = decodeURIComponent(String(req.headers['x-file-name'] || '')).slice(0, 80);
                    return json(200, { media: ads.addMedia(mime, bytes, name) });
                } catch (error) {
                    if (error instanceof SponsorValidationError) return json(error.status || 400, { error: error.message });
                    try { audit.log('ad_media_error', { reason: error.name }); } catch { }
                    return json(500, { error: 'ファイルを保存できませんでした。保存先を確認してから、もう一度お試しください。' });
                }
            }
            if (req.method === 'POST' && u.pathname === '/api/ads') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                try {
                    const data = await sponsorBody(req);
                    if (ads.update(data)) engine.event('ads', ads.snapshot());
                    return json(200, ads.snapshot());
                } catch (error) {
                    if (error instanceof SponsorValidationError) return json(error.status || 400, { error: error.message });
                    if (error instanceof SponsorConflictError) return json(409, { error: error.message, current: ads.snapshot() });
                    try { audit.log('ads_save_error', { reason: error.name }); } catch { }
                    return json(500, { error: '広告一覧を保存できませんでした。現在の表示を維持します。' });
                }
            }
            if (req.method === 'POST' && u.pathname === '/api/sponsor') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                try {
                    const data = await sponsorBody(req);
                    if (sponsor.update(data)) engine.event('sponsor', sponsor.snapshot());
                    return json(200, sponsor.snapshot());
                } catch (error) {
                    if (error instanceof SponsorValidationError) return json(error.status || 400, { error: error.message });
                    if (error instanceof SponsorConflictError) return json(409, { error: error.message, current: sponsor.snapshot() });
                    try { audit.log('sponsor_save_error', { reason: error.name }); } catch { /* Still return a safe error when storage is unavailable. */ }
                    return json(500, { error: '広告設定を保存できませんでした。現在の表示を維持します。保存先を確認してから、もう一度お試しください。' });
                }
            }
            // One utterance of the person speaking as Noa (HUMAN_VOICE_MODE=resynth, public/collab.html "中の人のマイク"):
            // transcribed only while they have the voice, then spoken in Noa's TTS voice (src/human-voice.mjs).
            if (req.method === 'POST' && u.pathname === '/api/human/segment') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (typeof engine.humanHeard !== 'function') return json(400, { error: 'この番組では使えません。' });
                let wav;
                try { wav = await rawBody(req, 2_000_000); } catch (e) { return json(e.status || 400, { error: e.message }); }
                const no = engine.humanAccepts();
                if (no) return json(200, { accepted: false, reason: no }); // never transcribed while the AI has the voice
                engine.humanActiveAt = Date.now(); // the person is speaking: the AI's resume line waits for a pause
                try {
                    const r = await stt.transcribe(wav);
                    if (!r.text) return json(200, { accepted: false, reason: r.skipped });
                    return json(200, { ...engine.humanHeard(r.text), text: r.text, sttMs: stt.lastMs });
                } catch (e) {
                    if (!(e instanceof SttError)) throw e;
                    if (['NOT_WAV', 'BAD_FORMAT'].includes(e.code)) return json(400, { error: e.message, code: e.code });
                    audit.log('stt_error', { code: e.code, who: 'human' });
                    if (Date.now() - sttNoticeAt > 30000) { sttNoticeAt = Date.now(); engine.event('notice', { message: '音声認識（whisper-server）に失敗したため、中の人の発言を声にできませんでした。' }); }
                    return json(503, { error: e.message, code: e.code });
                }
            }
            // One utterance of the voice-call partner (public/collab.html): a 16-bit PCM WAV cut at a pause -> whisper -> Noa.
            if (req.method === 'POST' && u.pathname === '/api/collab/segment') {
                if (!isAdmin) return json(401, { error: 'Unauthorized' });
                if (typeof engine.collabHeard !== 'function') return json(400, { error: 'この番組では使えません。' });
                let wav;
                try { wav = await rawBody(req, 2_000_000); } catch (e) { return json(e.status || 400, { error: e.message }); }
                try {
                    const r = await stt.transcribe(wav);
                    if (!r.text) return json(200, { accepted: false, reason: r.skipped });
                    return json(200, { ...engine.collabHeard(r.text), text: r.text, sttMs: stt.lastMs });
                } catch (e) {
                    if (!(e instanceof SttError)) throw e;
                    if (['NOT_WAV', 'BAD_FORMAT'].includes(e.code)) return json(400, { error: e.message, code: e.code });
                    // Unheard is unanswered: the show goes on; the operator is told (at most every 30 s).
                    audit.log('stt_error', { code: e.code });
                    if (Date.now() - sttNoticeAt > 30000) { sttNoticeAt = Date.now(); engine.event('notice', { message: '音声認識（whisper-server）に失敗したため、通話相手の発言を聞き取れませんでした。' }); }
                    return json(503, { error: e.message, code: e.code });
                }
            }
            if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
                if (!isAdmin)
                    return json(401, { error: 'Unauthorized' });
                const data = await body(req);
                // The capture page saw the partner start / stop speaking (turn taking and barge-in, src/collab.mjs).
                if (u.pathname === '/api/collab/speaking') { engine.collab?.speaking(data.on === true); return json(200, { ok: true }); }
                if (u.pathname === '/api/game/player') {
                    const target = data.player || (gameRunner.player === 'human' ? 'ai' : 'human');
                    const result = await gameRunner.switchPlayer(target);
                    return json(200, { ok: true, player: gameRunner.player, result, gameRunner: gameRunner.status() });
                }
                if (u.pathname === '/api/game/runner') {
                    if (data.action === 'start') {
                        const ok = gameRunner.start(data.seconds ? data.seconds * 1000 : undefined, { player: data.player || gameRunner.player, standalone: true });
                        return json(200, { ok, gameRunner: gameRunner.status() });
                    }
                    if (data.action === 'stop') {
                        const ok = gameRunner.stop();
                        return json(200, { ok, gameRunner: gameRunner.status() });
                    }
                    return json(400, { error: 'Unknown action' });
                }
                if (u.pathname === '/api/remote/disarm') return json(200, remoteControl.disarm());
                if (u.pathname === '/api/remote/arm') {
                    if (!remote) return json(409, { error: '先に npm run remote:setup を実行し、再起動してください。' });
                    try { return json(200, await remoteControl.arm(data)); }
                    catch (e) { return json(e.status || 409, { error: e.message, code: e.code }); }
                }
                if (remoteControl.busy && !(u.pathname === '/api/control' && ['stop', 'panic'].includes(data.action)) && u.pathname !== '/api/obs/stop')
                    return json(409, { error: '遠隔操作を処理中です。停止操作は利用できます。' });
                const legacyStart = ['/api/obs/prepare', '/api/obs/start', '/api/setup/rehearse', '/api/programme/select'].includes(u.pathname) || u.pathname === '/api/control' && ['start', 'start-game'].includes(data.action);
                if (legacyStart) {
                    if (legacyOperation || setupBusy || switchBusy()) throw switchConflict('現在の接続確認・開始操作が終わるまでお待ちください。');
                    legacyOperation = true; releaseLegacy = true;
                } else if (legacyOperation && (u.pathname.startsWith('/api/setup/') || u.pathname === '/api/settings' || u.pathname === '/api/obs/destination'))
                    throw switchConflict('現在の接続確認・開始操作が終わるまでお待ちください。');
                if (u.pathname.startsWith('/api/switch/')) {
                    if (u.pathname === '/api/switch/recording/stop') return json(200, { recording: await switchRecording.stop() });
                    if (!['/api/switch/devices', '/api/switch/prepare', '/api/switch/recording/start', '/api/switch/recording/recheck'].includes(u.pathname)) return json(404, { error: 'Not found' });
                    if (switchBusy() || legacyOperation || setupBusy || engine.running || obs.owned || remoteControl.busy)
                        throw switchConflict('番組・配信・試聴・テスト録画が終わってからSwitchを設定してください。');
                    switchOperation = true; remoteControl.disarm();
                    try {
                        if (u.pathname === '/api/switch/devices') return json(200, await switchSetup.scan());
                        if (u.pathname === '/api/switch/prepare') return json(200, await switchSetup.configure(data));
                        if (u.pathname === '/api/switch/recording/recheck') return json(200, { recording: await switchRecording.reconcile() });
                        await memory.assertStart();
                        return json(200, { recording: await switchRecording.start() });
                    } finally { switchOperation = false; }
                }
                if (switchBusy() && (u.pathname.startsWith('/api/setup/') || u.pathname === '/api/settings' || u.pathname === '/api/programme/select' || u.pathname === '/api/obs/destination' || u.pathname === '/api/obs/prepare' || u.pathname === '/api/obs/start' || u.pathname === '/api/control' && ['start', 'start-game'].includes(data.action)))
                    throw switchConflict('Switchの設定・テスト録画が終わってから操作してください。');
                if (u.pathname === '/api/avatar/wardrobe') {
                    try {
                        if (wardrobe.select(data)) engine.event('wardrobe', wardrobe.snapshot());
                        return json(200, wardrobe.snapshot());
                    } catch (error) {
                        if (error instanceof WardrobeValidationError) return json(400, { error: error.message });
                        try { audit.log('wardrobe_save_error', { reason: error.name }); } catch { /* The save error still needs a response when the data directory is unavailable. */ }
                        return json(500, { error: '衣装を保存できませんでした。現在の衣装を維持します。保存先を確認してから、もう一度お試しください。' });
                    }
                }
                if (u.pathname === '/api/avatar/mode') {
                    try {
                        if (avatarMode.select(data)) engine.event('avatar_mode', avatarMode.snapshot());
                        return json(200, avatarMode.snapshot());
                    } catch (error) {
                        if (error instanceof AvatarModeValidationError) return json(400, { error: error.message });
                        try { audit.log('avatar_mode_save_error', { reason: error.name }); } catch { /* The save error still needs a response when the data directory is unavailable. */ }
                        return json(500, { error: 'アバター表示を保存できませんでした。現在の表示を維持します。保存先を確認してから、もう一度お試しください。' });
                    }
                }
                if (u.pathname === '/api/obs/destination') {
                    if (engine.running || obs.owned || setupBusy) return json(409, { error: '番組・配信・試聴を停止してから切り替えてください。' });
                    setupBusy = true;
                    try {
                        const destination = await obs.selectDestination(data.target, target => saveSettings(c, { values: { STREAM_TARGET: target } }));
                        remoteControl.disarm(); obsProof = null; engine.lastAudioOK = false;
                        return json(200, destination);
                    } finally { setupBusy = false; }
                }
                if (u.pathname === '/api/programmes') {
                    // The operator's edit of a programme's words: validated like the built-ins, saved under data/, live at the next start.
                    if (engine.running || obs.owned || setupBusy) return json(409, { error: '番組と試聴を停止してから企画を編集してください。' });
                    if (data.action === 'reset') {
                        if (!builtinProgrammes().some(p => p.id === data.id)) return json(404, { error: '企画が見つかりません。' });
                        resetProgramme(c.dataDir, data.id); rebuildConfig();
                        return json(200, { programme: editable(programmesNow().programmes.find(p => p.id === data.id)), reset: true });
                    }
                    if (data.action !== 'save' || !data.programme || typeof data.programme !== 'object') return json(400, { error: 'Unknown action' });
                    const id = String(data.programme.id || ''), current = programmesNow().programmes.find(p => p.id === id), builtin = builtinProgrammes().find(p => p.id === id);
                    if (!current || !builtin) return json(404, { error: '企画が見つかりません。' });
                    const r = saveProgramme(c.dataDir, applyEdit(current, data.programme), builtin);
                    if (!r.saved) return json(400, { error: '企画を保存できません。指摘を直してください。', problems: r.problems });
                    rebuildConfig();
                    return json(200, { programme: editable(programmesNow().programmes.find(p => p.id === id)), saved: true });
                }
                const applySettings = values => {
                    const before = checkFingerprint(); const r = saveSettings(c, values); remoteControl.disarm();
                    const changed = before !== checkFingerprint(); if (changed) resetChecks(); obs.close(); vts.close();
                    youtube.access = null; jev.openUntil = 0; jev.failures = 0;
                    if (changed) { engine.lastAudioOK = false; voice.cache?.clear(); commentVoice.cache?.clear(); }
                    return { ...r, checksInvalidated: changed };
                };
                if (u.pathname === '/api/programme/select') {
                    // One tap from the studio: choose the programme (and with it the game), then build its OBS scene.
                    if (engine.running || obs.owned || setupBusy) return json(409, { error: '番組を終了してから切り替えてください。' });
                    const option = (c.programmeOptions || []).find(p => p.id === data.id);
                    if (!option) return json(404, { error: '企画が見つかりません。' });
                    const changed = c.programmeId !== option.id;
                    const r = changed ? applySettings({ values: { SHOW_PROGRAMME: option.id } }) : { checksInvalidated: false };
                    let prepared = null;
                    try {
                        await assertLegacyAllowed();
                        try { await obs.connect(); } catch { }
                        if (!obs.ready) throw new Error('OBSに接続できません。OBSを起動してから、もう一度選んでください。');
                        const p = await obs.prepare(origin);
                        prepared = { ok: true, scene: p.scene };
                    } catch (e) { prepared = { ok: false, error: e.message }; }
                    const heard = c.mode === 'demo' || !!savedApproval();
                    let switchReady = null;
                    if (c.game?.capture?.kind === 'switch') { try { switchReady = !!(await switchSetup.status())?.configured; } catch { switchReady = false; } }
                    return json(200, { programme: option, changed, checksInvalidated: !!r.checksInvalidated, obs: prepared, heard, switchReady });
                }
                if (u.pathname.startsWith('/api/setup/') || u.pathname === '/api/settings') {
                    if (engine.running || obs.owned || setupBusy) return json(409, { error: '番組と試聴を停止してから設定してください。' });
                    if (u.pathname === '/api/settings') return json(200, applySettings(data));
                    if (u.pathname === '/api/setup/jev-hold') {
                        // The operator checked the game controller's paid account: clear its 402 hold.
                        if (data.action !== 'clear') return json(400, { error: 'Unknown action' });
                        clearBillingHold(c); audit.log('jev_billing_hold_cleared', {});
                        return json(200, { hold: readBillingHold(c) });
                    }
                    if (u.pathname === '/api/setup/heard') {
                        if (!rehearsal?.ok || data.id !== rehearsal.id || data.heard !== true) return json(400, { error: '試聴をやり直してください。' });
                        if (c.readComments && (!rehearsal.commentAudio || data.commentHeard !== true)) return json(400, { error: 'コメント用VOICEVOXの声も試聴して確認してください。' });
                        if (rehearsal.libraryAudio && data.libraryHeard !== true) return json(400, { error: '反応音・定型フレーズ・声のスタイル見本も試聴して確認してください。' });
                        rehearsal.heard = true; saveApproval(); return json(200, { heard: true });
                    }
                    setupBusy = true;
                    try {
                        if (u.pathname === '/api/setup/detect') return json(200, await detect(c));
                        if (u.pathname === '/api/setup/library') {
                            if (data.action !== 'reload') return json(400, { error: 'Unknown action' });
                            const changed = reloadLibrary();
                            return json(200, { status: library.status(), checksInvalidated: changed });
                        }
                        if (u.pathname === '/api/setup/rehearse') {
                            if (data.confirm !== 'RUN_CHECK') return json(400, { error: 'APIへの送信と利用料を確認してください。' });
                            await assertLegacyAllowed();
                            reloadLibrary();
                            rehearsal = { ...await rehearse(c, ledger, audit, { library }), id: randomUUID(), settingsRevision };
                            const { audio, commentAudio, libraryAudio, ...safe } = rehearsal;
                            return json(200, { ...safe, audio: audio ? `/api/setup/audio/${rehearsal.id}.wav` : null, commentAudio: commentAudio ? `/api/setup/comment-audio/${rehearsal.id}.wav` : null,
                                libraryAudio: libraryAudio ? `/api/setup/library-audio/${rehearsal.id}.wav` : null, libraryIndex: libraryAudio?.index ?? [] });
                        }
                        if (u.pathname === '/api/setup/youtube') {
                            if (!c.youtubeVideo) return json(400, { error: '対象の動画URLを設定してください。' });
                            const r = await youtube.get('videos', { part: 'liveStreamingDetails', id: c.youtubeVideo });
                            const details = r.items?.[0]?.liveStreamingDetails;
                            return json(200, { state: details?.actualEndTime ? 'ended' : details?.activeLiveChatId ? 'live' : 'waiting_for_broadcast' });
                        }
                        if (u.pathname === '/api/setup/obs') { await obs.connect(); return json(200, { connected: obs.ready }); }
                        return json(404, { error: 'Not found' });
                    } catch (e) { if (e.code?.startsWith('SWITCH_')) throw e; return json(400, { error: diagnosticError(e) }); }
                    finally { setupBusy = false; }
                }
                // Pre-stream YouTube comment check: every step against the API the receiver uses, with its log.
                if (u.pathname === '/api/youtube/chat-check')
                    return json(200, await probeYouTubeChat(c, { youtube, ledger, fetchFn: overrides.youtubeFetch || youtube.fetchFn }));
                // Reserve a YouTube broadcast (予約枠) bound to OBS's stream key; its chat becomes the one the Studio reads.
                if (u.pathname === '/api/youtube/schedule') {
                    if (engine.running || obs.owned) return json(409, { error: '配信中は予約枠を作れません。番組の終了後に作ってください。' });
                    const request = scheduleRequest(data);
                    const file = join(c.dataDir, 'youtube-schedule-oauth.json');
                    let refreshToken = '';
                    try { refreshToken = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).refresh_token || '' : ''; } catch { refreshToken = ''; }
                    const fetchFn = overrides.youtubeFetch || youtube.fetchFn || fetch;
                    const token = await accessToken({ clientId: c.youtubeClient, clientSecret: c.youtubeSecret, refreshToken }, fetchFn);
                    // OBS's own key picks the channel's stream; OBS being offline only matters when the channel has several.
                    let streamKey = '';
                    try { await obs.connect(); streamKey = (await obs.call('GetStreamServiceSettings'))?.streamServiceSettings?.key || ''; } catch { streamKey = ''; }
                    const made = await scheduleBroadcast(request, { token, streamKey, fetchFn });
                    audit.log('youtube_scheduled', { id: made.id, state: request.privacy });
                    if (data.useForChat !== false) { saveSettings(c, { values: { YOUTUBE_VIDEO_ID: made.id } }); remoteControl.disarm(); }
                    return json(200, { ...made, start: request.start, privacy: request.privacy, videoId: c.youtubeVideo });
                }
                if (u.pathname === '/api/control') {
                    if (data.action === 'start') {
                        await assertLegacyAllowed();
                        if (c.mode === 'live' && readBillingHold(c)) return json(409, { error: 'ゲーム操作側に支払い停止の記録（HTTP 402）があります。ゲーム側の残高を確認してから、設定の準備状況で「課金停止を解除」を押してください。' });
                        // Comments must be readable before a show starts, unless the operator saw why not and chose to go on.
                        if (data.allowUnavailableYouTubeChat !== true) {
                            const chat = await probeYouTubeChat(c, { youtube, ledger, fetchFn: overrides.youtubeFetch || youtube.fetchFn });
                            if (!chat.ok) { audit.log('youtube_chat_unavailable', { reason: chat.code }); return json(409, { code: chat.code, error: chat.message, chat }); }
                        } else if (c.mode === 'live' && c.readComments && c.streamTarget && c.streamTarget !== 'twitch') audit.log('youtube_chat_override', {});
                        await memory.assertStart();
                        await pruneDisk(); await disk.assertStart();
                        await obsStopPromise;
                        if (setupBusy) return json(409, { error: '試聴・接続確認の完了後に開始してください。' });
                        if (engine.panic) engine.reset();
                        // Operator 2026-10-10: no 「聞こえた」 press is needed to start. Unless a trial for these settings just passed,
                        // the start runs the automatic check (generate → gate → voice → comment voice) and starts only when it passes;
                        // the stream itself still waits for the stage's first played audio before OBS goes live.
                        if (c.mode === 'live' && c.profile === 'talk' && !(rehearsal?.ok && rehearsal.settingsRevision === settingsRevision)) {
                            setupBusy = true;
                            try { reloadLibrary(); rehearsal = { ...await rehearse(c, ledger, audit, { library }), id: randomUUID(), settingsRevision, auto: true }; }
                            finally { setupBusy = false; }
                            if (!rehearsal.ok) return json(409, { error: `開始前の自動検証に失敗しました（${rehearsal.checks?.find(x => !x.ok)?.name || '試聴'}：${rehearsal.checks?.find(x => !x.ok)?.error || '不明'}）。` });
                        }
                        if (c.mode === 'live' && creditMissing(c)) return json(409, { error: diagnosticError({ code: 'CREDIT_REQUIRED' }) });
                        await engine.prepareBudgetClosing?.();
                        await memory.assertStart();
                        await assertLegacyAllowed();
                        engine.start();
                    }
                    else if (data.action === 'stop') {
                        // With a long goodbye configured, stop says goodbye first (the show then ends and OBS stops as at the
                        // end of a show); stop again during the goodbye, or force, cuts it short. Panic is always immediate.
                        if (data.force !== true && engine.running && engine.farewellMs?.() > 0 && !engine.director?.closing) engine.requestClose('operator');
                        else { remoteControl.cancelStart(); engine.stop(); await obsStopPromise; }
                    }
                    else if (data.action === 'panic') {
                        remoteControl.disarm(); engine.emergency();
                        await obsStopPromise;
                    }
                    else if (data.action === 'finish' && engine.requestClose) {
                        // A person speaking as Noa hands back first: the goodbye is the AI's, after the mic is confirmed muted.
                        if (engine.control.voice === 'human') { try { await control.setVoice('ai'); } catch (e) { if (e instanceof ControlError) return json(e.status, { error: e.message }); throw e; } }
                        engine.requestClose();
                    }
                    else if (['voice', 'listening', 'avatar', 'hotkey'].includes(data.action)) {
                        try {
                            if (data.action === 'voice') await control.setVoice(data.to);
                            else if (data.action === 'listening') control.setListening(data.to);
                            else if (data.action === 'avatar') control.setAvatar(data.to, data.face ?? null);
                            else await control.hotkey(data.name, data.by === 'global' ? 'global_hotkey' : 'hotkey');
                        }
                        catch (e) { if (e instanceof ControlError) return json(e.status, { error: e.message }); throw e; }
                    }
                    else if (data.action === 'next-topic' && engine.nextTopic) engine.nextTopic();
                    else if (data.action === 'add-topic') {
                        if (!data.title || typeof data.title !== 'string') return json(400, { error: '話題のタイトルを入力してください。' });
                        if (typeof engine.addTopic !== 'function') return json(400, { error: 'この番組では話題の追加は使えません。' });
                        const card = engine.addTopic(data.title, data.angles, data.jumpNow === true);
                        return json(200, { ok: true, card, status: engine.status() });
                    }
                    else if (data.action === 'start-game') {
                        await assertLegacyAllowed();
                        if (!engine.running || !engine.blocks?.startGame?.('operator')) return json(409, { error: 'ゲームを始められる状態ではありません（番組の開始後、雑談中のみ）。' });
                        engine.dropPlayLines?.('game_starting'); // prepared small talk that has not started gives way to the lead-in
                    }
                    else if (data.action === 'game-report') {
                        // A person at the controls tells the Studio what just happened (match start, KO, result); the show turns it into gated lines.
                        if (typeof engine.reportGame !== 'function') return json(400, { error: 'この番組では使えません。' });
                        const r = engine.reportGame(data.event);
                        if (!r.accepted) return json(409, { error: r.message || 'いまは報告できません（ゲームの開始後に使えます）。' });
                    }
                    else if (data.action === 'pause-comments' && c.profile === 'talk') control.setListening(engine.control.listening === 'muted' ? 'comments' : 'muted');
                    else if (data.action === 'switch-player' || data.action === 'set-game-player') {
                        const target = data.player || (gameRunner.player === 'human' ? 'ai' : 'human');
                        await gameRunner.switchPlayer(target);
                    }
                    else if (data.action === 'reset')
                        engine.reset();
                    else
                        return json(400, { error: 'Unknown action' });
                    return json(200, engine.status());
                }
                if (u.pathname === '/api/chat')
                    return json(200, engine.ingest({ text: data.text, author: 'operator' }));
                // The operator's own line for Noa to say next (talk shows): gated like every line, never interrupting.
                if (u.pathname === '/api/operator/say') {
                    if (typeof engine.sayOperator !== 'function') return json(400, { error: 'この番組では使えません。' });
                    return json(200, engine.sayOperator(data.text));
                }
                // Fresh opening-talk topics before a show (src/lobby-topics.mjs): today's headlines become the first lobby
                // scenes. Only between shows: the Director reads the scenes when a show starts.
                if (u.pathname === '/api/lobby/topics') {
                    if (engine.running) return json(409, { error: '番組の開始前に使えます。' });
                    if (!c.lobbyScenes) return json(400, { error: 'この番組には冒頭の雑談がありません。' });
                    const topics = await fetchTopics(overrides.topicsFetch || fetch);
                    if (!topics.length) return json(200, { ok: false, topics: [], error: '話題を取得できませんでした（前回の雑談テーマのまま）。' });
                    const builtin = JSON.parse(readFileSync(join(ROOT, 'config', 'lobby-scenes.json'), 'utf8')).scenes;
                    const { scenes, memo } = saveTopicScenes(c.dataDir, builtin, topics);
                    c.lobbyScenes = scenes;
                    audit.log('lobby_topics', { topics: topics.map(t => t.title) });
                    return json(200, { ok: true, topics: topics.map(t => ({ title: t.title, category: t.category })), memo });
                }
                // The stream's goal box (GAME_GOAL), changeable at any time (operator, live 2026-10-15): the box updates at
                // once and settings.json keeps it; nothing else is reloaded, so OBS and the show are untouched.
                if (u.pathname === '/api/operator/goal') {
                    // {reached: true|false|null} alone marks whether tonight's goal was reached (for the goodbye's recap).
                    if (data.text === undefined && 'reached' in data) {
                        c.gameGoalReached = data.reached === null ? null : !!data.reached;
                        audit.log('goal_reached', { reached: c.gameGoalReached });
                        return json(200, { ok: true, goal: c.gameGoal, reached: c.gameGoalReached });
                    }
                    const goal = String(data.text ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);
                    if (!goal) return json(400, { error: '目標を入力してください。' });
                    const p = join(c.dataDir, 'settings.json');
                    const stored = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
                    writeFileSync(`${p}.tmp`, JSON.stringify({ ...stored, GAME_GOAL: goal }, null, 2) + '\n', { mode: 0o600 });
                    renameSync(`${p}.tmp`, p);
                    c.gameGoal = goal; c.gameGoalReached = null; if (c.settingsEnv) c.settingsEnv.GAME_GOAL = goal;
                    audit.log('goal_changed', { goal });
                    engine.event('state', engine.status());
                    return json(200, { ok: true, goal });
                }
                // Standby screens on air (配信準備中・少し離席中・機材調整中・配信終了) and back to the programme ('show').
                if (u.pathname === '/api/obs/adopt') {
                    if (data.confirm !== 'ADOPT') return json(400, { error: 'Confirm with ADOPT' });
                    await obs.connect(); await obs.adopt(); audit.log('obs_adopted', {});
                    engine.releaseStandby?.(); // an adopted stream is already on air: no standby minute
                    return json(200, { owned: obs.owned });
                }
                if (u.pathname === '/api/obs/screen') {
                    if (!['standby', 'away', 'tuning', 'ended', 'show'].includes(data.screen)) return json(400, { error: 'Unknown screen' });
                    await obs.connect();
                    const scene = await obs.showScreen(data.screen);
                    audit.log('obs_screen', { state: data.screen });
                    return json(200, { scene });
                }
                if (u.pathname === '/api/obs/prepare') {
                    await assertLegacyAllowed();
                    if (setupBusy) throw switchConflict('試聴・接続確認の完了を待ってください。');
                    if (engine.running)
                        throw new Error('Stop the local show before preparing OBS');
                    const prepared = await obs.prepare(origin);
                    // Preparing can recreate an enabled capture after the lobby event has already passed.
                    // Keep it in sync with the centred opening-talk layout before reporting readiness.
                    if (c.game && engine.blocks?.phase === 'lobby') await obs.setGameVisible?.(false);
                    return json(200, prepared);
                }
                if (u.pathname === '/api/obs/start') {
                    await assertLegacyAllowed();
                    const chatIssue = youtubeChatStartIssue(c, ledger.snapshot());
                    if (chatIssue && data.allowUnavailableYouTubeChat !== true) return json(409, chatIssue);
                    await memory.assertStart();
                    await disk.assertStart();
                    if (data.confirm !== 'START' || !engine.running || !engine.status().renderer || !engine.lastAudioOK)
                        throw new Error('Verify live audio, renderer and running show, then explicitly confirm START');
                    if (c.streamTarget && data.target !== c.streamTarget) throw new Error('配信先が変更されました。もう一度確認してください。');
                    const epoch = engine.epoch;
                    await standbyScreen();
                    try { await obs.start(); } catch (e) { if (c.standbyMs > 0 && engine.standby) obs.showScreen('show').catch(() => { }); throw e; }
                    if (!engine.alive(epoch) || !engine.status().renderer) {
                        await obs.stopOwned();
                        throw new Error('Show stopped during OBS startup');
                    }
                    gameRunner.setStreaming?.(true);
                    scheduleShow(); retitle();
                    return json(200, { streaming: true });
                }
                if (u.pathname === '/api/obs/stop') {
                    remoteControl.cancelStart(); await obs.stopOwned();
                    gameRunner.setStreaming?.(false);
                    return json(200, { streaming: false });
                }
                if (u.pathname === '/api/vts/connect') {
                    await vts.connect();
                    return json(200, { connected: vts.ready });
                }
                return json(404, { error: 'Not found' });
            }
            if (req.method !== 'GET')
                return json(405, { error: 'Method not allowed' });
            if (await serveVrmAsset(u.pathname, `${ROOT}/public`, res)) return;
            // Vendored, unmodified third-party browser files: an exact allowlist, never a directory listing.
            if (VENDOR.has(u.pathname)) {
                res.writeHead(200, { 'Content-Type': u.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
                return res.end(readFileSync(resolve(`${ROOT}/public`, u.pathname.slice(1))));
            }
            // The layered avatar's parts + manifest, and an optional painted room: flat names under two fixed folders.
            if (/^\/models\/(noa|room)\/[A-Za-z0-9]+\.(png|json)$/.test(u.pathname)) {
                const file = resolve(`${ROOT}/public`, u.pathname.slice(1));
                if (!existsSync(file)) return json(404, { error: 'Not found' });
                res.writeHead(200, { 'Content-Type': u.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/png' });
                return res.end(readFileSync(file));
            }
            const path = u.pathname === '/' ? '/index.html' : u.pathname === '/stage' ? '/stage.html' : u.pathname === '/setup' ? '/setup.html' : u.pathname === '/switch' ? '/switch.html' : u.pathname === '/collab' ? '/collab.html' : u.pathname === '/control' ? '/control.html' : u.pathname;
            if (!/^\/[a-z0-9_-]+\.(html|css|mjs|png)$/i.test(path))
                return json(404, { error: 'Not found' });
            const file = resolve(`${ROOT}/public`, path.slice(1));
            if (!existsSync(file) || !statSync(file).isFile())
                return json(404, { error: 'Not found' });
            const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png' }[extname(file)];
            res.writeHead(200, { 'Content-Type': type });
            res.end(readFileSync(file));
        }
        catch (e) {
            // The cause stays with the operator: the local audit log always, the response only for the admin (the view
            // token gets the generic message). Never the raw message: URLs, tokens and paths are taken out first.
            const detail = errorDetail(e);
            audit.log('request_error', { reason: e.name, ...(e.code ? { code: String(e.code) } : {}), detail });
            if (e.code?.startsWith('SWITCH_')) return json(e.status || 409, { error: e.message, code: e.code });
            if (e.code === 'MEMORY_UNSAFE' || e.code === 'DISK_LOW') return json(409, {error:e.message});
            if (e.name === 'SettingsValidationError') return json(400, { error: e.message, field: e.field });
            // 2026-10-10: OBS 32.2.2's WebSocket sometimes stops answering new clients (TCP open, no handshake) and only an
            // OBS restart recovers it; the bare 'OBS disconnected' told the operator nothing.
            if (!res.headersSent && /^OBS (disconnected|connection timeout)$/.test(e.message || ''))
                return json(503, { error: 'OBSに接続できません。OBSが起動しているか確認してください。起動しているのに続く場合は、配信・録画が止まっていることを確かめてからOBSを再起動してください。', code: 'OBS_UNREACHABLE', ...(adminRequest && detail ? { detail } : {}) });
            if (!res.headersSent)
                json(400, { error: /^(OBS|Invalid |Live mode requires|YouTube|動画|実API)/.test(e.message || '') ? e.message : '操作を完了できませんでした。設定・状態・入力を確認してください。', ...(adminRequest && detail ? { detail } : {}) });
            else
                res.end();
        } finally { if (releaseLegacy) legacyOperation = false; }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 40;
    return { server, engine, obs, remote, remoteControl, memory, disk, titler, streamWatch, switchSetup, switchRecording, async close() { clearInterval(clipsQueueTimer); clearInterval(llmRouteTimer); memory.close(); disk.close(); streamWatch.stop(); clearTimeout(memoryStopTimer); await remote?.close(); engine.stop('shutdown'); await remoteControl.task; await obsStopPromise; await switchRecording.close(); switchOBS.close(); vts.close(); obs.close(); for (const res of clients)
            res.end(); clients.clear(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        loadEnv();
        const c = config();
        const p = `${c.dataDir}/youtube-oauth.json`;
        if (!c.youtubeRefresh && existsSync(p))
            c.youtubeRefresh = JSON.parse(readFileSync(p, 'utf8')).refresh_token || '';
        const app = createApp(c);
        let analyticsChild, performanceChild;
        app.server.listen(c.port, c.host, async () => {
            if (c.mode === 'live') {
                performanceChild = spawn(process.execPath, ['--max-old-space-size=256', resolve(ROOT, 'scripts/stream-performance.mjs')], {cwd:ROOT, env:{...process.env, JVS_PARENT_PID:String(process.pid)}, stdio:'ignore'});
                performanceChild.on('error', () => console.error('Performance monitor unavailable.'));
            }
            if (process.env.AUDIENCE_ANALYTICS === '1' && c.mode === 'live') {
                analyticsChild = spawn(process.execPath, ['--max-old-space-size=256', resolve(ROOT, 'scripts/audience-analytics.mjs')], {cwd:ROOT, env:{...process.env, JVS_PARENT_PID:String(process.pid)}, stdio:'ignore'});
                analyticsChild.on('error', () => console.error('Audience analytics could not start; Studio remains available.'));
            }
            if (app.remote) {
                try { await app.remote.listen(); console.log(`Mobile control: ${app.remote.options.origin}/mobile (private Tailscale Serve; local verification required)`); }
                catch (e) { console.error(`Mobile listener unavailable: ${e.code || e.name}`); }
            }
            const hostDisplay = c.host === '0.0.0.0' ? '127.0.0.1' : c.host;
            let accessMsg = `\nJev VTuber Studio v0.2.0-rc.6 | ${c.mode.toUpperCase()}\nControl: http://${hostDisplay}:${c.port}/setup#admin=${c.adminToken}\nStage:   http://${hostDisplay}:${c.port}/stage#token=${c.viewToken}`;
            // The operator's own tailnet address (TAILSCALE_HOST), never one written into the source.
            if (c.host === '0.0.0.0' && c.tailscaleHost) {
                accessMsg += `\nTailscale (Phone): http://${c.tailscaleHost}:${c.port}/setup#admin=${c.adminToken}`;
            }
            accessMsg += `\nNo external stream starts automatically. Keep control URL private.\n`;
            console.log(accessMsg);
        });
        app.server.on('error', e => { console.error(`Server: ${e.code || e.name}`); process.exitCode = 1; });
        let closing = false;
        const stop = async () => { if (closing)
            return; closing = true; analyticsChild?.kill(); performanceChild?.kill(); const t = setTimeout(() => process.exit(1), 12000); await app.close(); clearTimeout(t); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
