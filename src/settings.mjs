import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { config, parseStyleMap } from './config.mjs';
import { request } from './util.mjs';
import { Conversation, wavDuration } from './providers.mjs';
import { SupertonicVoice, CommentVoice } from './voice-routing.mjs';
import { Jev, Effects } from './jev.mjs';
import { sentences } from './director.mjs';
import { DirectedVoice } from './voice-router.mjs';
import { SpeechDirector, effectiveMode } from './speech-director.mjs';
import { ReactionAudioCache } from './reaction-audio.mjs';
import { joinParts, plannedSilenceMs } from './audio-bus.mjs';
import { createAdapter, CLOUD } from './tts-adapters.mjs';

/** SBV2 models whose licence requires an on-screen credit. Checked at rehearsal and again at every start (local and remote),
 * and fingerprinted as a boolean so clearing the credit after a passing rehearsal invalidates it. */
export const creditMissing = c => c.replyTtsProvider === 'sbv2' && /amitaro|koharune/i.test(c.sbv2Model || '') && !String(c.sbv2Credit || '').trim();

export const FIELDS = {
    STREAM_TARGET: 'streamTarget',
    MODE: 'mode', TYPESAFE_API_KEY: 'jevKey', LLM_PROVIDER: 'llmProvider', LLM_BASE_URL: 'llmURL', LLM_MODEL: 'llmModel', LLM_API_KEY: 'llmKey',
    GEMINI_API_KEY: 'geminiKey', GEMINI_MODEL: 'geminiModel', VOICEVOX_URL: 'voiceURL', VOICEVOX_SPEAKER: 'speaker', VOICEVOX_SPEED: 'voiceSpeed', VOICEVOX_CREDIT: 'voiceCredit',
    YOUTUBE_VIDEO_ID: 'youtubeVideo', YOUTUBE_API_KEY: 'youtubeKey', YOUTUBE_TRANSPORT: 'youtubeTransport', OBS_URL: 'obsURL', OBS_PASSWORD: 'obsPassword',
    READ_COMMENTS: 'readComments', COMMENT_VOICEVOX_SPEAKER: 'commentSpeaker', COMMENT_VOICEVOX_SPEED: 'commentSpeed', COMMENT_VOICEVOX_CREDIT: 'commentVoiceCredit',
    MAX_READ_COMMENT_CHARS: 'maxReadChars', MAX_READ_AUDIO_MS: 'maxReadAudioMs',
    REPLY_TTS_PROVIDER: 'replyTtsProvider', SUPERTONIC_URL: 'supertonicURL', SUPERTONIC_VOICE: 'supertonicVoice', SUPERTONIC_STEPS: 'supertonicSteps', SUPERTONIC_SPEED: 'supertonicSpeed', GEMINI_TTS_VOICE: 'geminiTtsVoice', GEMINI_TTS_STYLE: 'geminiTtsStyle', GEMINI_TTS_MAX_USD: 'geminiTtsMaxUsd', GEMINI_TTS_MAX_USD_MONTH: 'geminiTtsMaxUsdMonth', GEMINI_TTS_STREAM: 'geminiTtsStream',
    AIVIS_URL: 'aivisURL', AIVIS_STYLE: 'aivisStyle', AIVIS_SPEED: 'aivisSpeed', AIVIS_INTONATION: 'aivisIntonation', AIVIS_TEMPO: 'aivisTempo', AIVIS_CREDIT: 'aivisCredit',
    SBV2_URL: 'sbv2URL', SBV2_MODEL: 'sbv2Model', SBV2_SPEAKER: 'sbv2Speaker', SBV2_STYLE: 'sbv2Style', SBV2_STYLE_WEIGHT: 'sbv2StyleWeight', SBV2_SPEED: 'sbv2Speed', SBV2_CREDIT: 'sbv2Credit',
    HOST_STYLE_MAP: 'hostStyleMap', SPEECH_DIRECTION: 'speechDirection', REACTION_AUDIO: 'reactionAudio', PHRASE_CACHE: 'phraseCache',
    SHOW_PROGRAMME: 'programmeId', SESSION_MINUTES: null, ALLOW_OBS_STREAM: 'allowStream', CHARACTER_NAME: null, SHOW_TITLE: null, CHARACTER_PERSONA: null,
    // Game programmes (docs/GAMES.md): game sound and its level, where a Jev-played game's controller lives, its cost cap.
    GAME_AUDIO: 'gameAudio', GAME_AUDIO_DB: 'gameAudioDb', GAME_DIR: 'gameDir', GAME_EXECUTABLE: 'gameExecutable', GAME_MAX_COST_USD: 'gameMaxCostUsd', GAME_CHARACTER: 'gameCharacter', GAME_GOAL: 'gameGoal', GAME_STAGE: 'gameStage', OBS_BGM_FILE: 'obsBgmFile', OBS_BGM_VOLUME_DB: 'obsBgmVolumeDb', GAME_TIME_SCALE: 'gameTimeScale',
    // On-stream look: classic or room (public/stage-theme.mjs).
    STAGE_THEME: 'stageTheme', ROOM_GAME_LAYOUT: 'roomGameLayout', STAGE_HASHTAG: 'stageHashtag', STAGE_SOCIAL: 'stageSocial', STAGE_TAGLINE: 'stageTagline',
    // NOA BEER drinking stream (src/drink-mode.mjs): off unless turned on.
    DRINK_MODE: 'drinkMode', OBS_RECORD: 'obsRecord',
    // Voice handoff (src/control.mjs): the OBS input of the person's mic; empty = HUMAN cannot be chosen.
    OBS_HUMAN_MIC_SOURCE: 'obsHumanMicSource', HUMAN_VOICE_MODE: 'humanVoiceMode', HANDOFF_TIMING: 'handoffTiming', RESUME_BRIDGE: 'resumeBridge',
    // Voice-call partner (docs/COLLAB.md).
    STT_URL: 'sttURL', STT_LANGUAGE: 'sttLanguage', COLLAB_NAME: 'collabName', COLLAB_BARGE_IN_MS: 'collabBargeInMs'
};
const NUMBERS = { COLLAB_BARGE_IN_MS: [0, 5000], GAME_AUDIO_DB: [-60, 0], OBS_BGM_VOLUME_DB: [-60, 0], GAME_MAX_COST_USD: [0, 100] };
const PATHS = new Set(['GAME_DIR', 'GAME_EXECUTABLE', 'OBS_BGM_FILE']);
const SECRETS = new Set(['TYPESAFE_API_KEY', 'LLM_API_KEY', 'GEMINI_API_KEY', 'YOUTUBE_API_KEY', 'OBS_PASSWORD']);
export function videoID(value) {
    if (!value) return '';
    if (/^[\w-]{11}$/.test(value)) return value;
    let u; try { u = new URL(value); } catch { throw new Error('YouTubeの動画URLまたは11文字の動画IDを入力してください'); }
    if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(u.hostname) || u.protocol !== 'https:') throw new Error('YouTubeのHTTPS動画URLを入力してください');
    const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/^\/(?:live|shorts)\/([\w-]{11})/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw new Error('動画IDを確認できません');
    return id;
}
export function publicSettings(c) {
    const values = {}, configured = {};
    for (const [k, prop] of Object.entries(FIELDS)) {
        if (SECRETS.has(k)) { configured[k] = !!c[prop]; continue; }
        const v = prop ? c[prop] : undefined;
        // Objects (HOST_STYLE_MAP) travel as their canonical JSON text; an empty one as ''.
        if (v && typeof v === 'object') { values[k] = Object.keys(v).length ? JSON.stringify(v) : ''; continue; }
        values[k] = prop ? v : k === 'SESSION_MINUTES' ? c.sessionMs / 60000 : k === 'CHARACTER_NAME' ? c.character.name : k === 'SHOW_TITLE' ? c.character.channel : c.character.persona;
    }
    return { values, configured, programmes: c.programmeOptions, suggestedPersona: c.defaultPersona };
}
export class SettingsValidationError extends Error {
    constructor(field, message) {
        super(message); this.name = 'SettingsValidationError'; this.field = field;
    }
}
function settingText(field, value, c = null) {
    if (field === 'HOST_STYLE_MAP') {
        const t = String(value).trim();
        if (!t) return '';
        // Canonical JSON; the error never echoes the input.
        try { return JSON.stringify(parseStyleMap(t)); }
        catch { throw new SettingsValidationError(field, 'HOST_STYLE_MAP: {"joy":"Happy"} の形式で、neutral/calm/joy/surprise/shy/think/worry とスタイルを指定してください。'); }
    }
    // The programmes on offer are the ones in config/programmes.json (the same list Studio shows).
    const programmeIds = c?.programmeOptions?.map(p => p.id) ?? ['room', 'holiday', 'robot', 'consultation'];
    if (field === 'SHOW_PROGRAMME' && !programmeIds.includes(String(value))) throw new SettingsValidationError(field, '一覧から企画を選んでください。');
    if (field === 'GAME_CHARACTER' || field === 'GAME_STAGE') {
        const t = String(value).trim().toUpperCase();
        // A stage may be a comma list played in order, the last one repeated (FOREST,LIBRARY).
        const ok = field === 'GAME_STAGE' ? /^[A-Z][A-Z0-9_]{1,31}(,[A-Z][A-Z0-9_]{1,31}){0,7}$/ : /^[A-Z][A-Z0-9_]{1,31}$/;
        if (t && !ok.test(t)) throw new SettingsValidationError(field, 'ゲーム内のID（例: IMELDA, FOREST）を英大文字で入力してください。ステージは「FOREST,LIBRARY」のように順番に並べられます。空欄なら画面で選ばれているものを使います。');
        return t;
    }
    if (field === 'STAGE_THEME') { const t = String(value).trim(); if (t && !['classic', 'room'].includes(t)) throw new SettingsValidationError(field, '画面テーマはクラシックかノアの夜の部屋を選んでください。'); return t; }
    if (field === 'HANDOFF_TIMING') { const t = String(value).trim(); if (t && !['immediate', 'sentence'].includes(t)) throw new SettingsValidationError(field, '交代のタイミングは「すぐ」か「文の切れ目」を選んでください。'); return t; }
    if (field === 'RESUME_BRIDGE') { if (!['true', 'false'].includes(String(value))) throw new SettingsValidationError(field, 'つなぎの一言はオンかオフを選んでください。'); return String(value); }
    if (field === 'HUMAN_VOICE_MODE') { const t = String(value).trim(); if (t && !['passthrough', 'resynth', 'rvc'].includes(t)) throw new SettingsValidationError(field, '人間の声の出し方は「そのまま」「コハクで読み直し」「RVC」から選んでください。'); return t; }
    if (field === 'ROOM_GAME_LAYOUT') { const t = String(value).trim(); if (t && !['side', 'front', 'full', 'frame', 'wide'].includes(t)) throw new SettingsValidationError(field, 'ゲーム画面の配置は「横（side）」「ゲームの前（front）」「全画面（full）」「枠つき（frame）」「ゲームを大きく（wide）」から選んでください。'); return t; }
    if (['STAGE_HASHTAG', 'STAGE_SOCIAL', 'STAGE_TAGLINE'].includes(field)) { const t = String(value).replace(/[<>\u0000-\u001f]/g, '').trim(); if (t.length > 40) throw new SettingsValidationError(field, '40文字までにしてください。'); return t; }
    if (field === 'OBS_RECORD') { if (!['true', 'false'].includes(String(value))) throw new SettingsValidationError(field, '録画はオンかオフを選んでください。'); return String(value); }
    if (field === 'DRINK_MODE') { if (!['true', 'false'].includes(String(value))) throw new SettingsValidationError(field, '飲み配信モードはオンかオフを選んでください。'); return String(value); }
    if (field === 'GAME_AUDIO') { if (!['true', 'false'].includes(String(value))) throw new SettingsValidationError(field, 'ゲーム音はオンかオフを選んでください。'); return String(value); }
    if (Object.hasOwn(NUMBERS, field)) {
        const t = String(value).trim(); if (t === '') return '';
        const [min, max] = NUMBERS[field], n = Number(t);
        if (!Number.isFinite(n) || n < min || n > max) throw new SettingsValidationError(field, `${field}: ${min}〜${max} の数値、または空欄にしてください。`);
        return String(n);
    }
    if (PATHS.has(field)) {
        const t = String(value).trim(); if (t === '') return '';
        if (!t.startsWith('/') || /[\u0000-\u001f\u007f]/.test(t) || t.length > 1024) throw new SettingsValidationError(field, `${field}: このPC上の絶対パス（/ から始まる）を入力してください。`);
        return t;
    }
    const multiline = field === 'CHARACTER_PERSONA';
    const text = multiline ? String(value).replace(/\r\n?/g, '\n') : String(value);
    const max = multiline ? 2000 : field === 'CHARACTER_NAME' ? 24 : field === 'SHOW_TITLE' ? 48 : 2500;
    if (text.length > max) throw new SettingsValidationError(field, `${field}: ${max}文字以内で入力してください。`);
    const forbidden = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
    if (forbidden.test(text)) throw new SettingsValidationError(field, multiline
        ? '話し方には改行・タブ以外の制御文字を含められません。'
        : `${field}: 改行・制御文字は使用できません。`);
    return text.trim();
}
export function saveSettings(c, { values = {}, clear = [] }) {
    if (!values || Array.isArray(values) || typeof values !== 'object' || !Array.isArray(clear)) throw new Error('Invalid settings payload');
    const p = join(c.dataDir, 'settings.json');
    const stored = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    const next = { ...stored };
    for (const [k, v] of Object.entries(values)) {
        if (!Object.hasOwn(FIELDS, k) || !['string', 'number', 'boolean'].includes(typeof v)) throw new Error('Unsupported setting');
        const text = settingText(k, v, c);
        if (SECRETS.has(k) && v === '') continue; // An empty password field means keep; deletion is explicit.
        try { next[k] = k === 'YOUTUBE_VIDEO_ID' ? videoID(text) : text; }
        catch (e) { throw new SettingsValidationError(k, e.message); }
    }
    for (const k of clear) { if (!SECRETS.has(k)) throw new Error('Unsupported secret deletion'); next[k] = ''; }
    const candidate = config({ ...c.settingsEnv, ...next, DATA_DIR: c.dataDir }, [], false);
    // Preserve control/view credentials and listener identity across configuration changes.
    Object.assign(candidate, { adminToken: c.adminToken, viewToken: c.viewToken, port: c.port, host: c.host });
    writeFileSync(`${p}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${p}.tmp`, p); chmodSync(p, 0o600);
    Object.assign(c, candidate);
    c.settingsEnv = candidate.settingsEnv;
    return publicSettings(c);
}
export function diagnosticError(e) {
    const status = e.status || Number(e.message?.match(/HTTP (\d{3})/)?.[1]);
    const coded = { TTS_ENGINE_DOWN: '選んだ音声エンジンに接続できません。起動状態とURLを確認してください。別の声へは切り替えません。',
        TTS_ENGINE_MISMATCH: '指定ポートで別のサービスが応答しました。AivisSpeech（:10101）/ Style-Bert-VITS2（:5055推奨。macOSの:5000はAirPlay）を確認してください。',
        TTS_REJECTED: '音声エンジンが設定を拒否しました。スタイルID・モデル名・スタイル名（HOST_STYLE_MAP）を確認してください。',
        PLAN_INVARIANT: '話し方の演出で文章が一致しなかったため送出していません。',
        CREDIT_REQUIRED: 'このモデルは画面と配信説明にクレジット表記が必要です（SBV2_CREDIT）。' };
    if (typeof e.code === 'string' && Object.hasOwn(coded, e.code)) return coded[e.code];
    if (e.code === 'TTS_BUDGET') return e.status === 429 ? 'Gemini TTS の1日あたりの利用上限に達しました（無料枠は1モデル10回/日）。課金を有効にするか翌日まで待ってください。別の声へは切り替えません。' : 'クラウド音声の1日／1か月の上限額（GEMINI_TTS_MAX_USD／GEMINI_TTS_MAX_USD_MONTH）に達したため発話を保留しています。別の声へは切り替えません。';
    if (e.message === 'Turn audio too long') return '1ターンの音声が上限（MAX_TURN_AUDIO_MS）を超えました。';
    if (e.code === 'SUPERTONIC_NOT_READY') return '日本語対応のSupertonic 3サーバーを起動してください。v1/v2へ自動切替はしません。';
    if (status === 401) return '認証失敗 (401)。APIキーを確認してください。';
    if (status === 403) return '権限または割当を確認してください (403)。';
    if (status === 404) return '接続先またはモデルが見つかりません (404)。';
    if (status === 429) return '利用量・同時実行の制限に達しました (429)。';
    if (status >= 500) return `接続先のエラー (${status})。時間を空けて再試行してください。`;
    if (['TimeoutError', 'AbortError'].includes(e.name)) return '時間切れ、または中断されました。';
    if (/Output gate/.test(e.message)) return '生成文がローカル判定を通りませんでした。';
    return '接続先、起動状態、モデル設定、音声設定を確認してください。';
}
export async function detect(c, fetchFn = fetch) {
    const result = { models: [], speakers: [], supertonic: null, aivis: null, sbv2: null, errors: [], warnings: [] };
    try {
        const r = c.llmProvider === 'ollama'
            ? await request(`${c.llmURL.replace(/\/v1$/, '')}/api/tags`, { fetchFn, timeout: 4000 })
            : c.llmProvider === 'compatible' ? await request(`${c.llmURL}/models`, { headers: c.llmKey ? { Authorization: `Bearer ${c.llmKey}` } : {}, fetchFn, timeout: 4000 }) : null;
        result.models = (r?.models || r?.data || []).slice(0, 200).map(x => x.name || x.id).filter(x => typeof x === 'string');
    } catch (e) { result.errors.push({ provider: 'LLM', error: diagnosticError(e) }); }
    try {
        const r = await request(`${c.voiceURL}/speakers`, { fetchFn, timeout: 4000 });
        if (!Array.isArray(r)) throw new Error('Invalid speakers');
        result.speakers = r.flatMap(x => (x.styles || []).map(style => ({ id: style.id, name: `${x.name} / ${style.name}`, credit: `VOICEVOX:${x.name}` }))).slice(0, 300);
    } catch (e) { result.errors.push({ provider: 'VOICEVOX', error: diagnosticError(e) }); }
    if (c.replyTtsProvider === 'supertonic') {
        try { result.supertonic = await new SupertonicVoice(c, null, fetchFn).health(); }
        catch (e) { result.errors.push({ provider: 'Supertonic', error: diagnosticError(e) }); }
        if (c.supertonicSpeed < .7) result.warnings.push('SUPERTONIC_SPEED は0.7以上にしてください（演出経路では0.7に補正）。');
    }
    if (c.replyTtsProvider === 'aivisspeech') {
        try {
            // The identity probe (manifest name + uuid) runs even before a style is chosen, so the picker can be filled.
            const a = createAdapter('aivisspeech', { ...c, aivisStyle: c.aivisStyle || 1 }, fetchFn);
            const { version } = await a.probe(), styles = await a.voices(), uuid = styles.find(x => x.id === c.aivisStyle)?.speakerUuid;
            result.aivis = { version, styles, license: typeof uuid === 'string' ? await a.license(uuid) : null };
        } catch (e) { result.errors.push({ provider: 'AivisSpeech', error: diagnosticError(e) }); }
    }
    if (CLOUD.includes(c.replyTtsProvider)) {
        // Free metadata GET only: verifies the key and model, never synthesizes (no charge).
        try { const a = createAdapter(c.replyTtsProvider, c, fetchFn); result.gemini = { ...(await a.probe()), voices: await a.voices() }; }
        catch (e) { result.errors.push({ provider: 'Gemini TTS', error: diagnosticError(e) }); }
        result.warnings.push('Gemini TTS は有料のクラウド音声です（1時間の発話で約$0.54〜0.81、2027年から倍額）。無料枠では入力がGoogleの製品改善に使われます。');
    }
    if (c.replyTtsProvider === 'sbv2') {
        try { result.sbv2 = { models: await createAdapter('sbv2', c, fetchFn).voices() }; }
        catch (e) { result.errors.push({ provider: 'Style-Bert-VITS2', error: diagnosticError(e) }); }
    }
    return result;
}
export async function rehearse(c, ledger, audit, overrides = {}) {
    if (c.mode !== 'live') throw new Error('実APIモードを保存してから試聴してください');
    const conversation = overrides.conversation || new Conversation(c, ledger);
    const jev = overrides.jev || new Jev(c, ledger, audit);
    let library = overrides.library;
    if (!library) { library = new ReactionAudioCache(join(c.dataDir, 'voice')); library.reload(); }
    const voice = overrides.voice || new DirectedVoice(c, ledger, { library });
    // The operator hears whole WAVs in rehearsal; streaming is a live-delivery detail of the same voice and style.
    voice.streamingAllowed = false;
    const checks = [], signal = AbortSignal.timeout(65000);
    const director = new SpeechDirector(c), mode = c.profile === 'talk' ? effectiveMode(c) : 'off';
    const kinds = () => voice.clipKinds?.() ?? [];
    // Delivery questions ride in the same Jev request only in 'jev' mode; otherwise today's 2-argument call.
    const judge = t => mode === 'jev' ? jev.speech(t, signal, [], null, { chunks: director.prepare(t).flat.slice(0, 4), clipKinds: kinds() }) : jev.speech(t, signal);
    let text, audio, commentAudio, libraryAudio = null, summary = null;
    const trialComment = '好きな家具は何ですか？';
    try {
        let t = performance.now();
        const genContext = { kind: c.readComments ? 'reply' : 'opening', comment: c.readComments ? trialComment : null, commentReadByNarrator: c.readComments, topic: c.topicCards[0].title, allowQuestion: false, memory: { recentSpeech: [] } };
        text = await conversation.generate(genContext, signal);
        checks.push({ name: '文章生成', ok: true, ms: Math.round(performance.now() - t) });
        t = performance.now();
        let verdict = await judge(text);
        if (!verdict.accept) {
            text = await conversation.generate({ ...genContext, repair: { reason: verdict.reason, instruction: '家具の好みを1〜2文でシンプルに答える。名乗りや実体験は作らない。' } }, signal);
            verdict = await judge(text);
            if (!verdict.accept) throw new Error('Output gate rejected speech');
        }
        checks.push({ name: 'ローカル判定', ok: true, ms: Math.round(performance.now() - t) });
        t = performance.now();
        // Every profile: a credit-required voice never renders (and so never passes) without its credit.
        if (creditMissing(c)) throw Object.assign(new Error('Credit required'), { code: 'CREDIT_REQUIRED' });
        if (c.profile !== 'talk') {
            audio = await voice.synthesize(text, signal);
            if (audio.kind !== 'wav' || !audio.bytes?.length) throw new Error('No WAV');
            checks.push({ name: '音声合成', ok: true, ms: Math.round(performance.now() - t) });
        } else {
            try { await voice.warmup?.(signal); } catch {}
            // The same per-part path as TalkEngine: director → router → bus → finalize, parts joined with 60 ms gaps.
            const parts = sentences(text);
            // A reply may answer and then expand on the comment in a third sentence (providers.mjs).
            if (parts.length > 3 || text.length > 220) throw new Error('Speech exceeds turn bound');
            const plan = mode === 'off' ? null : director.plan(text, verdict, { clipKinds: kinds() });
            const effects = new Effects(), rendered = [];
            let total = 0, cache = 0, local = 0, clip = null, clipMs = 0;
            for (let i = 0; i < parts.length; i++) {
                const next = plan && i === 0 && parts.length > 1 ? (voice.estimateAudioMs?.(parts[1]) || parts[1].length * 170) + plannedSilenceMs(plan.parts[1]) : 0;
                let a = plan ? await voice.synthesize(parts[i], signal, { ...plan.parts[i], budgetMs: c.maxTurnAudioMs - (total - clipMs) - next }) : await voice.synthesize(parts[i], signal);
                if (a?.kind !== 'wav' || !a.bytes?.length) throw new Error('No WAV');
                let ms = 0;
                if (Number.isFinite(a.durationMs)) ms = a.durationMs;
                else try { ms = Math.ceil(wavDuration(a.bytes) * 1000); } catch { ms = 0; }
                total += ms;
                // As on air: part 0's clip is exempt from the later parts' checks (TalkEngine turn.clipMs).
                if (i === 0) clipMs = Math.min(Number.isFinite(a.clipMs) ? a.clipMs : 0, c.maxReactionAudioMs ?? 1200);
                if (total - (i ? clipMs : 0) > c.maxTurnAudioMs) throw new Error('Turn audio too long');
                const tiers = a.stats?.tiers;
                cache += tiers?.cache ?? 0; local += tiers?.local ?? 1;
                if (typeof a.finalize === 'function') {
                    const p = plan?.parts[i], e = effects.take(p ? { ...verdict, reaction: p.head, delivery: { intensity: p.intensity } } : verdict);
                    a = a.finalize({ reaction: e.reaction ?? 'neutral', intensity: e.intensity });
                }
                clip ??= a.clip ?? null;
                rendered.push(a);
            }
            audio = joinParts(rendered, 60);
            libraryAudio = typeof voice.audition === 'function' ? await voice.audition(signal) : null;
            summary = { provider: c.replyTtsProvider, mode, parts: rendered.length, cache, local, clip };
            checks.push({ name: '音声合成', ok: true, ms: Math.round(performance.now() - t), detail: summary });
        }
        if (c.readComments) {
            t = performance.now();
            const narrator = overrides.commentVoice || new CommentVoice(c, ledger);
            commentAudio = await narrator.synthesize(`コメント。${trialComment}`, signal);
            if (commentAudio.kind !== 'wav' || !commentAudio.bytes?.length) throw new Error('No comment WAV');
            checks.push({ name: 'コメント読み上げ / VOICEVOX', ok: true, ms: Math.round(performance.now() - t) });
        }
        return { ok: true, checks, text, audio, commentAudio, libraryAudio, library: library.status?.() ?? null, voice: summary ?? null, trialComment: c.readComments ? trialComment : null, heard: false };
    } catch (e) {
        checks.push({ name: ['文章生成', 'ローカル判定', '音声合成', 'コメント読み上げ / VOICEVOX'][checks.length] || '試聴', ok: false, error: diagnosticError(e) });
        return { ok: false, checks, heard: false };
    }
}
