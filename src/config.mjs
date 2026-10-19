import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { VOICE_FAMILIES } from '../public/voice-acting.mjs';
import { PROVIDERS, CLOUD, isGeminiVoice } from './tts-adapters.mjs';
import { gameIdOf, loadGame, controllerPaths } from './games.mjs';
import { loadProgrammes } from './programmes.mjs';
import { lobbyCards } from './lobby-scenes.mjs';

/** The opening-talk scenes: data/lobby-scenes.json when the operator saved one (a character's own stories), else the
 * built-in config/lobby-scenes.json. A file that does not fit is left out with a warning rather than stopping the show. */
function lobbyScenesFor(dataDir, warnings) {
    const builtin = JSON.parse(readFileSync(`${ROOT}/config/lobby-scenes.json`, 'utf8')).scenes;
    const own = `${dataDir}/lobby-scenes.json`;
    if (!existsSync(own)) return builtin;
    try {
        const scenes = JSON.parse(readFileSync(own, 'utf8')).scenes;
        lobbyCards([{ id: 'probe', title: 'probe', angles: ['probe'], beats: [{ lobby: true }] }], scenes); // the Director's own validation
        return scenes;
    } catch { warnings.push('lobby-scenes.json: 保存した雑談の場面を読めないため、組み込みを使います'); return builtin; }
}

/** What the Studio shows about a programme: its id and title and, for a game programme, the game it plays and how
 * (who plays, how OBS captures it) so the settings page can explain the choice without reading manifests. */
function programmeOption(p) {
    const gameId = gameIdOf(p); let g = null;
    try { g = gameId ? loadGame(gameId) : null; } catch { g = null; }
    // style: 'game' (a game from games/), 'blocks' (the built-in block game), 'consult' (talk; the built-in game fills quiet time) or 'talk'.
    const style = g ? 'game' : p.gameMode === 'blocks' ? 'blocks' : p.gameMode === true ? 'consult' : 'talk';
    return { id: p.id, title: p.title, style, game: g ? { id: g.id, title: g.title, player: g.player, capture: g.capture.kind } : null };
}
export const ROOT = resolve(import.meta.dirname, '..');
const STYLE_NAME = /^[\p{L}\p{N} _()（）・.-]{1,32}$/u;
/** HOST_STYLE_MAP: a JSON object keyed by voice family, valued by a style id (31-bit) or a style name. Never echoes the input. */
export function parseStyleMap(text = '') {
    if (text === undefined || text === null || text === '') return Object.freeze({});
    const bad = () => new Error('Invalid HOST_STYLE_MAP');
    if (typeof text !== 'string' || text.length > 1000) throw bad();
    let v;
    try { v = JSON.parse(text); } catch { throw bad(); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
    const keys = Object.keys(v);
    if (keys.length > VOICE_FAMILIES.length || keys.some(k => !VOICE_FAMILIES.includes(k))) throw bad();
    for (const k of keys) {
        const x = v[k];
        if (!(Number.isInteger(x) && x >= 0 && x <= 2147483647) && !(typeof x === 'string' && STYLE_NAME.test(x))) throw bad();
    }
    return Object.freeze(Object.fromEntries(keys.sort().map(k => [k, v[k]])));
}
export function config(env = process.env, argv = process.argv, readSettings = true) {
    const dataDir = resolve(env.DATA_DIR || `${ROOT}/data`);
    const settingsFile = `${dataDir}/settings.json`;
    if (readSettings && existsSync(settingsFile)) env = { ...env, ...JSON.parse(readFileSync(settingsFile, 'utf8')) };
    const num = (key, fallback, min, max) => {
        const n = Number(env[key] || fallback);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)
            throw new Error(`Invalid ${key}`);
        return n;
    };
    const banner = v => String(v ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 40);
    const token = key => {
        if (env[key] && env[key].length < 24)
            throw new Error(`${key} must be at least 24 characters`);
        return env[key] || randomBytes(24).toString('hex');
    };
    const mode = argv.includes('--demo') ? 'demo' : (env.MODE || 'demo');
    if (!['demo', 'live'].includes(mode))
        throw new Error('MODE must be demo or live');
    const provider = env.LLM_PROVIDER || 'compatible';
    if (!['compatible', 'gemini', 'ollama'].includes(provider))
        throw new Error('Invalid LLM_PROVIDER');
    // Built-in programmes, with the operator's saved edits (data/programmes/<id>.json) in their place (src/programmes.mjs).
    const { programmes, warnings: programmeWarnings } = loadProgrammes(dataDir);
    const programmeId = env.SHOW_PROGRAMME || 'room';
    const programme = programmes.find(x => x.id === programmeId);
    if (!programme) throw new Error('Invalid SHOW_PROGRAMME');
    // A game played outside the Studio (games/<id>/game.json): its controller plays with Jev, its show module comments.
    const gameId = gameIdOf(programme), game = gameId ? loadGame(gameId) : null;
    if (gameId && !game) throw new Error(`Programme ${programmeId}: game "${gameId}" is not in games/`);
    const gamePaths = controllerPaths(game, env);
    // The host's identity lives in config/character.json (name, show title, persona, and the OBS/Twitch names that carry
    // the name); settings and env override single fields, so a different character is a config change, not a code change.
    const character = JSON.parse(readFileSync(`${ROOT}/config/character.json`, 'utf8'));
    const c = {
        mode, profile: env.SHOW_PROFILE || 'talk', port: num('PORT', 8787, 1024, 65535), host: env.HOST || '127.0.0.1', allowedHosts: env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',').map(s => s.trim()).filter(Boolean) : [], adminToken: token('ADMIN_TOKEN'), viewToken: token('VIEW_TOKEN'),
        dataDir,
        memoryGuard: env.MEMORY_GUARD === '1', keepLive: env.KEEP_LIVE === '1',
        // Disk headroom (src/disk-guard.mjs), live mode unless DISK_GUARD=0: a start needs DISK_START_GB free after old
        // files are pruned (player logs > DISK_RUNS_DAYS, Studio logs > DISK_LOGS_DAYS, OBS recordings past the newest
        // DISK_KEEP_RECORDINGS); on air below DISK_LOW_GB the recording stops, below DISK_CRITICAL_GB the show says goodbye.
        diskGuard: { enabled: env.DISK_GUARD !== '0', startGb: num('DISK_START_GB', 20, 1, 2000), lowGb: num('DISK_LOW_GB', 8, 1, 2000), criticalGb: num('DISK_CRITICAL_GB', 3, 1, 2000),
            keepRecordings: num('DISK_KEEP_RECORDINGS', 2, 0, 100), runsDays: num('DISK_RUNS_DAYS', 7, 1, 365), logsDays: num('DISK_LOGS_DAYS', 14, 1, 365) },
        // The goodbye (src/talk-engine.mjs farewell): CLOSING_SECONDS > 0 says goodbye over about that long (recap, thanks,
        // replies to goodbye comments, then the last line) instead of one line; within WIND_DOWN_MINUTES of the end it starts
        // when a game round ends (a natural break), and a normal stop also says it first. 0: the single closing line as before.
        closingMs: num('CLOSING_SECONDS', 0, 0, 600) * 1000, windDownMs: num('WIND_DOWN_MINUTES', 10, 0, 120) * 60000,
        closingNotice: String(env.CLOSING_NOTICE || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60),
        // Viewer comment text and authors in data/show-log.jsonl are erased after this many days (src/show-logger.mjs).
        commentRetentionDays: num('COMMENT_RETENTION_DAYS', 7, 1, 365),
        obsChatSource: env.OBS_CHAT_SOURCE || '', obsActionsSource: env.OBS_ACTIONS_SOURCE || '',
        // The person's mic for a voice handoff (src/control.mjs): an OBS input, muted unless a person has Noa's voice.
        obsHumanMicSource: env.OBS_HUMAN_MIC_SOURCE || '',
        // The startup banner's phone URL when HOST=0.0.0.0 (the operator's tailnet name or address; empty = not shown).
        tailscaleHost: /^[A-Za-z0-9.-]{1,253}$/.test(env.TAILSCALE_HOST || '') ? env.TAILSCALE_HOST : '',
        // How that person is heard (src/human-voice.mjs): passthrough (the mic as it is), resynth (transcribed and spoken in
        // Noa's TTS voice), rvc (an external RVC app feeds the mic input).
        humanVoiceMode: ['resynth', 'rvc'].includes(env.HUMAN_VOICE_MODE) ? env.HUMAN_VOICE_MODE : 'passthrough',
        // Phase 4 (docs/CONTROL.md): hand over at once with a fade (immediate) or after the sentence on air (sentence, at
        // most 4 s); a fixed bridge line when the AI takes the voice back with nothing prepared.
        handoffTiming: env.HANDOFF_TIMING === 'sentence' ? 'sentence' : 'immediate', resumeBridge: env.RESUME_BRIDGE !== 'false',
        // The voice-call partner (docs/COLLAB.md): local whisper.cpp, the partner's name, and how long they may talk over
        // Noa before she stops (ms; 0 = she finishes her line).
        sttURL: env.STT_URL || 'http://127.0.0.1:8178', sttLanguage: env.STT_LANGUAGE || 'ja', collabName: env.COLLAB_NAME || '',
        collabBargeInMs: num('COLLAB_BARGE_IN_MS', 700, 0, 5000),
        // On-stream look (public/stage-theme.mjs): 'classic' (default) or 'room' (Noa's night room; also moves the OBS game capture and overlays).
        stageTheme: env.STAGE_THEME === 'room' ? 'room' : 'classic',
        // The room theme's game layout: 'side' (Noa in the top-right box), 'front' (Noa in front of the game's lower-right
        // corner) or 'full' (operator 2026-10-19, 案C: the game fills the screen; public/stage-theme.mjs ROOM_BOXES).
        roomGameLayout: ['front', 'full', 'frame', 'wide'].includes(env.ROOM_GAME_LAYOUT) ? env.ROOM_GAME_LAYOUT : 'side',
        // The frame layout's name banner (operator 2026-10-19, 案D): a hashtag, a social handle and a catchphrase; empty = not shown.
        stageHashtag: banner(env.STAGE_HASHTAG), stageSocial: banner(env.STAGE_SOCIAL), stageTagline: banner(env.STAGE_TAGLINE),
        // NOA BEER drinking stream (src/drink-mode.mjs; operator-approved exception 2026-10-10). Off unless DRINK_MODE=true.
        drinkMode: env.DRINK_MODE === 'true',
        // Operator 2026-10-10: record the broadcast locally (OBS recording) for clips and shorts afterwards. Off unless true.
        obsRecord: env.OBS_RECORD === 'true',
        // Optional English subtitle under the host's Japanese caption (CAPTION_EN=true): a local-LLM translation, display only.
        captionEn: env.CAPTION_EN === 'true',
        // Optional stream watch (src/stream-watch.mjs): off unless STREAM_WATCH is claude or codex. Plain checks run every
        // minute; the agent is called only while something is flagged, at most every STREAM_WATCH_MINUTES for the same problem.
        streamWatch: ['claude', 'codex'].includes(env.STREAM_WATCH) ? env.STREAM_WATCH : 'off', streamWatchMinutes: num('STREAM_WATCH_MINUTES', 10, 5, 60),
        streamWatchMaxPerDay: num('STREAM_WATCH_MAX_PER_DAY', 48, 1, 288), streamWatchModel: /^[\w.:-]{1,64}$/.test(env.STREAM_WATCH_MODEL || '') ? env.STREAM_WATCH_MODEL : '',
        streamWatchMaxUsd: Number.isFinite(Number(env.STREAM_WATCH_MAX_USD)) && Number(env.STREAM_WATCH_MAX_USD) > 0 ? Math.min(1, Number(env.STREAM_WATCH_MAX_USD)) : .05,
        // Local judge (no remote Jev): the safety/quality gate runs on the local LLM. With a Gemini conversation model the
        // judge still runs locally (JUDGE_BASE_URL, Ollama by default) and needs JUDGE_MODEL.
        // Unset = the conversation model's endpoint, read when judging (so the judge always follows LLM_BASE_URL).
        judgeProvider: provider === 'gemini' ? 'ollama' : '', judgeURL: (env.JUDGE_BASE_URL || (provider === 'gemini' ? 'http://127.0.0.1:11434/v1' : '')).replace(/\/$/, ''),
        judgeModel: env.JUDGE_MODEL || '', judgeTimeoutMs: num('JUDGE_TIMEOUT_MS', 20000, 3000, 120000),
        llmProvider: provider, llmURL: (env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, ''), llmKey: env.LLM_API_KEY || '', llmModel: env.LLM_MODEL || '',
        // Optional bigger model on another machine (src/llm-route.mjs; e.g. an RTX 5080 Ubuntu box's Ollama on the LAN): used
        // only while it answers and has the model, else the model above. Ollama only (its /api/tags tells what is installed).
        llmRemoteURL: provider === 'ollama' && /^https?:\/\/[^\s/]+(:\d+)?(\/v1)?\/?$/.test(env.LLM_REMOTE_URL || '') ? env.LLM_REMOTE_URL.replace(/\/$/, '') : '',
        llmRemoteModel: /^[\w.:/-]{1,80}$/.test(env.LLM_REMOTE_MODEL || '') ? env.LLM_REMOTE_MODEL : '',
        judgeRemoteModel: /^[\w.:/-]{1,80}$/.test(env.JUDGE_REMOTE_MODEL || '') ? env.JUDGE_REMOTE_MODEL : '',
        geminiKey: env.GEMINI_API_KEY || '', geminiModel: env.GEMINI_MODEL || '',
        voiceURL: (env.VOICEVOX_URL || 'http://127.0.0.1:50021').replace(/\/$/, ''), speaker: num('VOICEVOX_SPEAKER', 3, 0, 10000),
        searchURL: env.JEV_SEARCH_URL || '', game, gameId, gameDir: gamePaths.dir, gameLogDir: gamePaths.logDir, gameAudio: String(env.GAME_AUDIO || env.VAMPIRE_GAME_AUDIO || '').toLowerCase() === 'true', gameTimeScale: Number(env.GAME_TIME_SCALE) || null, obsBgmFile: env.OBS_BGM_FILE || '', obsBgmVolumeDb: Number.isFinite(Number(env.OBS_BGM_VOLUME_DB)) && env.OBS_BGM_VOLUME_DB !== undefined && env.OBS_BGM_VOLUME_DB !== '' ? Number(env.OBS_BGM_VOLUME_DB) : -24, gameExecutable: env.GAME_EXECUTABLE || env.VAMPIRE_PYTHON || '', gameMaxCostUsd: Number(env.GAME_MAX_COST_USD || env.VAMPIRE_MAX_COST_USD) || null, gameCharacter: /^[A-Z][A-Z0-9_]{1,31}$/.test(env.GAME_CHARACTER || '') ? env.GAME_CHARACTER : '', gameStage: /^[A-Z][A-Z0-9_]{1,31}(,[A-Z][A-Z0-9_]{1,31}){0,7}$/.test(env.GAME_STAGE || '') ? env.GAME_STAGE : '', gameGoal: String(env.GAME_GOAL || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60), gameAudioDb: env.GAME_AUDIO_DB !== undefined && env.GAME_AUDIO_DB !== '' && Number.isFinite(Number(env.GAME_AUDIO_DB)) ? Number(env.GAME_AUDIO_DB) : null, sessionMs: num('SESSION_MINUTES', 15, 1, 300) * 60000,
        turnGapMs: num('TURN_GAP_MS', 250, 0, 60000), gameEnabled: env.SHOW_PROFILE === 'playground' && env.GAME_ENABLED !== 'false',
        maxIntake: num('MAX_CHAT_QUEUE', 20, 1, 100), maxCandidates: num('MAX_REPLY_QUEUE', 2, 1, 5),
        commentTTL: num('COMMENT_TTL_MS', 60000, 1000, 120000),
        maxTurnAudioMs: num('MAX_TURN_AUDIO_MS', 18000, 3000, 30000), maxReactionAudioMs: num('MAX_REACTION_AUDIO_MS', 1200, 0, 3000), gameController: env.GAME_CONTROLLER || 'rule',
        voiceSpeed: Number(env.VOICEVOX_SPEED || 1.06),
        voiceCredit: env.VOICEVOX_CREDIT || '',
        readComments: env.READ_COMMENTS !== 'false',
        commentSpeaker: num('COMMENT_VOICEVOX_SPEAKER', 1, 0, 10000),
        commentSpeed: Number(env.COMMENT_VOICEVOX_SPEED || 1.15),
        commentVoiceCredit: env.COMMENT_VOICEVOX_CREDIT || '',
        maxReadChars: num('MAX_READ_COMMENT_CHARS', 120, 10, 300),
        maxReadAudioMs: num('MAX_READ_AUDIO_MS', 10000, 1000, 20000),
        replyTtsProvider: env.REPLY_TTS_PROVIDER || 'voicevox',
        supertonicURL: (env.SUPERTONIC_URL || 'http://127.0.0.1:7788').replace(/\/$/, ''),
        geminiTtsVoice: env.GEMINI_TTS_VOICE || 'Kore', geminiTtsStyle: env.GEMINI_TTS_STYLE || '', geminiTtsMaxUsd: Number(env.GEMINI_TTS_MAX_USD || 3), geminiTtsMaxUsdMonth: Number(env.GEMINI_TTS_MAX_USD_MONTH || 10), geminiTtsStream: env.GEMINI_TTS_STREAM !== 'false',
        supertonicVoice: env.SUPERTONIC_VOICE || 'F1',
        supertonicSteps: num('SUPERTONIC_STEPS', 8, 2, 32),
        supertonicSpeed: Number(env.SUPERTONIC_SPEED || 1.05),
        aivisURL: (env.AIVIS_URL || 'http://127.0.0.1:10101').replace(/\/$/, ''), aivisStyle: num('AIVIS_STYLE', 0, 0, 2147483647),
        aivisSpeed: Number(env.AIVIS_SPEED || 1), aivisIntonation: Number(env.AIVIS_INTONATION || 1), aivisTempo: Number(env.AIVIS_TEMPO || 1), aivisCredit: env.AIVIS_CREDIT || '',
        sbv2URL: (env.SBV2_URL || 'http://127.0.0.1:5055').replace(/\/$/, ''), sbv2Model: env.SBV2_MODEL || '', sbv2Speaker: env.SBV2_SPEAKER || '', sbv2Style: env.SBV2_STYLE || 'Neutral',
        sbv2StyleWeight: Number(env.SBV2_STYLE_WEIGHT || 1), sbv2Speed: Number(env.SBV2_SPEED || 1), sbv2Credit: env.SBV2_CREDIT || '',
        hostStyleMap: parseStyleMap(env.HOST_STYLE_MAP),
        speechDirection: env.SPEECH_DIRECTION || 'off', reactionAudio: env.REACTION_AUDIO === 'true', phraseCache: env.PHRASE_CACHE === 'true',
        programmeId, programme, programmeOptions: programmes.map(p => programmeOption(p)), programmeWarnings, finiteProgramme: true,
        topicCards: env.SHOW_PROFILE === 'playground' ? JSON.parse(readFileSync(`${ROOT}/config/topics.json`, 'utf8')) : programme.cards,
        // Opening talk before a game (lobbyMinutes > 0): the authored lobby scenes (docs/LOBBY_TALK.md) open any game programme.
        lobbyScenes: game && Number(programme.show?.lobbyMinutes) > 0 && env.SHOW_PROFILE !== 'playground' ? lobbyScenesFor(dataDir, programmeWarnings) : null,
        // Clip studio (src/clip-studio.mjs, scripts/clip-studio.mjs): after a completed live show with OBS_RECORD, edited
        // clips, Shorts and thumbnails are made from the recording and published (CLIP_PRIVACY, public by default) within
        // CLIP_DAILY_UNITS of YouTube quota a day. CLIP_AUTO=0 turns the automatic run off (npm run clips still works).
        clipStudio: { auto: env.CLIP_AUTO !== '0', privacy: ['public', 'unlisted', 'private'].includes(env.CLIP_PRIVACY) ? env.CLIP_PRIVACY : 'public', dailyUnits: num('CLIP_DAILY_UNITS', 6500, 1650, 100000),
            ffmpeg: env.CLIP_FFMPEG || (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg'), recordingsDir: env.CLIP_RECORDINGS_DIR || '',
            // The recording is removed once its clips and Shorts are rendered, a rendered file once uploaded (CLIP_KEEP_RECORDINGS=1 keeps recordings).
            keepRecordings: env.CLIP_KEEP_RECORDINGS === '1',
            // Operator 2026-10-13: the operator posts by hand (投稿メモ.txt); CLIP_UPLOAD=1 uploads within the daily budget instead.
            upload: env.CLIP_UPLOAD === '1' },
        // STANDBY_SECONDS > 0: the stream opens on the 配信準備中 screen this long before the show begins (src/talk-engine.mjs standby).
        standbyMs: num('STANDBY_SECONDS', 0, 0, 600) * 1000, endScreenMs: num('END_SCREEN_SECONDS', 0, 0, 120) * 1000, obsURL: env.OBS_URL || 'ws://127.0.0.1:4455', obsPassword: env.OBS_PASSWORD || '', obsScene: env.OBS_SCENE || 'Jev Studio', obsInput: env.OBS_INPUT || 'Jev Stage', allowStream: env.ALLOW_OBS_STREAM === 'true',
        streamTarget: env.STREAM_TARGET || '', obsYouTubeProfile: env.OBS_YOUTUBE_PROFILE || character.obs?.youtubeProfile || '無題', obsTwitchProfile: env.OBS_TWITCH_PROFILE || character.obs?.twitchProfile || `${character.name} - Twitch`, obsSimulcastProfile: env.OBS_SIMULCAST_PROFILE || character.obs?.simulcastProfile || `${character.name} - 同時配信`, obsBgmSource: env.OBS_BGM_SOURCE || character.obs?.bgmSource || 'BGM',
        twitchEnabled: env.TWITCH_ENABLED === 'true', twitchChannel: env.TWITCH_CHANNEL || character.twitch?.channel || '', twitchAuthFile: resolve(env.TWITCH_AUTH_FILE || `${ROOT}/data/twitch/oauth.json`), twitchTitleAuthFile: resolve(env.TWITCH_TITLE_AUTH_FILE || `${ROOT}/data/twitch/title-oauth.json`),
        // A new title on YouTube and Twitch for every broadcast (src/stream-title.mjs); STREAM_TITLE=0 turns it off.
        streamTitle: env.STREAM_TITLE !== '0', streamTitleLabel: String(env.STREAM_TITLE_LABEL || '').slice(0, 20),
        youtubeChannel: env.YOUTUBE_CHANNEL_ID || '', youtubeVideo: env.YOUTUBE_VIDEO_ID || '', youtubeKey: env.YOUTUBE_API_KEY || '', youtubeTransport: env.YOUTUBE_TRANSPORT || 'stream', youtubeClient: env.YOUTUBE_CLIENT_ID || '', youtubeSecret: env.YOUTUBE_CLIENT_SECRET || '', youtubeRefresh: env.YOUTUBE_REFRESH_TOKEN || '', youtubePollMs: num('YOUTUBE_POLL_MIN_MS', 1000, 1000, 300000),
        vtsEnabled: env.VTS_ENABLED === 'true', vtsURL: env.VTS_URL || 'ws://127.0.0.1:8001',
        limits: { jev: num('MAX_JEV_CALLS', 3000, 1, 100000), llm: num('MAX_LLM_CALLS', 600, 1, 10000), tts: num('MAX_TTS_CALLS', 600, 1, 10000), search: num('MAX_SEARCH_CALLS', 50, 1, 1000), youtube: num('MAX_YOUTUBE_CALLS', 1000, 1, 10000) },
        character,
    };
    if (!Array.isArray(c.character.topics) || !c.character.topics.length || c.character.topics.some(x => typeof x !== 'string'))
        throw new Error('Invalid character topics');
    // Endpoints are operator configuration, never model/chat-controlled. No insecure remote credential transport.
    for (const u of [c.judgeURL, c.llmURL, c.voiceURL, c.searchURL, c.supertonicURL, c.aivisURL, c.sbv2URL].filter(Boolean)) {
        const url = new URL(u);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
            throw new Error('Invalid provider URL');
        if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(url.hostname))
            throw new Error('Remote providers require HTTPS');
    }
    for (const u of [c.obsURL, c.vtsURL]) {
        const url = new URL(u);
        if (!['ws:', 'wss:'].includes(url.protocol) || (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(url.hostname)))
            throw new Error('Unsafe local WebSocket endpoint');
    }
    if (c.mode === 'live') {
        if (!(c.judgeModel || (provider !== 'gemini' && c.llmModel)))
            throw new Error(provider === 'gemini' ? 'Live mode requires JUDGE_MODEL (the local judge) when LLM_PROVIDER is gemini' : 'Live mode requires LLM_MODEL (or JUDGE_MODEL) for the local judge');
        if (provider !== 'gemini' && !c.llmModel)
            throw new Error('Live mode requires LLM_MODEL');
        if (provider === 'gemini' && (!c.geminiKey || !c.geminiModel))
            throw new Error('Live mode requires GEMINI_API_KEY and GEMINI_MODEL');
    }
    if (!['talk', 'playground'].includes(c.profile)) throw new Error('Invalid SHOW_PROFILE');
    if (!['', 'youtube', 'twitch', 'simulcast'].includes(c.streamTarget)) throw new Error('Invalid STREAM_TARGET');
    if (!['stream', 'poll'].includes(c.youtubeTransport)) throw new Error('Invalid YOUTUBE_TRANSPORT');
    if (!Number.isFinite(c.voiceSpeed) || c.voiceSpeed < .5 || c.voiceSpeed > 2) throw new Error('Invalid VOICEVOX_SPEED');
    if (!PROVIDERS.includes(c.replyTtsProvider)) throw new Error('Invalid REPLY_TTS_PROVIDER');
    if (!['rule', 'jev'].includes(c.gameController)) throw new Error('Invalid GAME_CONTROLLER');
    if (!isGeminiVoice(c.geminiTtsVoice)) throw new Error('Invalid GEMINI_TTS_VOICE');
    if (typeof c.geminiTtsStyle !== 'string' || c.geminiTtsStyle.length > 200 || /[<>\u0000-\u001f\u007f]/.test(c.geminiTtsStyle)) throw new Error('Invalid GEMINI_TTS_STYLE');
    if (!Number.isFinite(c.geminiTtsMaxUsd) || c.geminiTtsMaxUsd < 0 || c.geminiTtsMaxUsd > 100) throw new Error('Invalid GEMINI_TTS_MAX_USD');
    if (!Number.isFinite(c.geminiTtsMaxUsdMonth) || c.geminiTtsMaxUsdMonth < 0 || c.geminiTtsMaxUsdMonth > 1000) throw new Error('Invalid GEMINI_TTS_MAX_USD_MONTH');
    if (c.mode === 'live' && CLOUD.includes(c.replyTtsProvider) && !c.geminiKey) throw new Error('Live mode requires GEMINI_API_KEY for Gemini TTS');
    if (!Number.isFinite(c.commentSpeed) || c.commentSpeed < .5 || c.commentSpeed > 2) throw new Error('Invalid COMMENT_VOICEVOX_SPEED');
    if (!Number.isFinite(c.supertonicSpeed) || c.supertonicSpeed < .5 || c.supertonicSpeed > 2) throw new Error('Invalid SUPERTONIC_SPEED');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(c.supertonicVoice)) throw new Error('Invalid SUPERTONIC_VOICE');
    const range = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
    for (const [key, v, min, max] of [['AIVIS_SPEED', c.aivisSpeed, .5, 2], ['AIVIS_INTONATION', c.aivisIntonation, 0, 2], ['AIVIS_TEMPO', c.aivisTempo, 0, 2], ['SBV2_STYLE_WEIGHT', c.sbv2StyleWeight, 0, 5], ['SBV2_SPEED', c.sbv2Speed, .5, 2]])
        if (!range(v, min, max)) throw new Error(`Invalid ${key}`);
    if (typeof c.sbv2Model !== 'string' || (c.sbv2Model && !/^[\p{L}\p{N}._-]{1,64}$/u.test(c.sbv2Model))) throw new Error('Invalid SBV2_MODEL');
    if (typeof c.sbv2Speaker !== 'string' || (c.sbv2Speaker && !/^[^\u0000-\u001f\u007f<>&]{1,40}$/u.test(c.sbv2Speaker))) throw new Error('Invalid SBV2_SPEAKER');
    if (typeof c.sbv2Style !== 'string' || !STYLE_NAME.test(c.sbv2Style)) throw new Error('Invalid SBV2_STYLE');
    if (!['off', 'reaction', 'jev'].includes(c.speechDirection)) throw new Error('Invalid SPEECH_DIRECTION');
    if (c.reactionAudio && c.speechDirection === 'off') throw new Error('Invalid REACTION_AUDIO (requires SPEECH_DIRECTION)');
    if (c.phraseCache && c.speechDirection === 'off') throw new Error('Invalid PHRASE_CACHE (requires SPEECH_DIRECTION)');
    c.defaultPersona = c.character.persona;
    if (env.CHARACTER_NAME) c.character.name = String(env.CHARACTER_NAME).slice(0, 24);
    if (env.SHOW_TITLE) c.character.channel = String(env.SHOW_TITLE).slice(0, 48);
    if (env.CHARACTER_PERSONA) c.character.persona = String(env.CHARACTER_PERSONA).slice(0, 2000);
    Object.defineProperty(c, 'settingsEnv', { value: { ...env }, configurable: true, writable: true });
    return c;
}
export function loadEnv() { const p = `${ROOT}/.env`; if (existsSync(p))
    process.loadEnvFile(p); }
