import { randomUUID } from 'node:crypto';
import { Engine } from './engine.mjs';
import { Director, sentences } from './director.mjs';
import { Metrics } from './metrics.mjs';
import { ContentStalledError, repetitionReason, similarity } from './content-quality.mjs';
import { ShowLogger } from './show-logger.mjs';
import { hasPII, injection } from './util.mjs';
import { CLOUD } from './tts-adapters.mjs';
import { BlocksShow } from './blocks-show.mjs';
import { RunLogFeed } from './run-log-feed.mjs';
import { fixedAck } from './providers.mjs';
import { DrinkSchedule, INTERJECTION } from './drink-mode.mjs';
// A fixed thank-you is judged on its own text (it never quotes or answers the comment): measured on live Jev 2026-10-07,
// with the comment in the context a viewer's nationality pushed even 'ナマステ！コメントありがとう！' over the privacy bar (.09-.10).
const FIXED_ACK_GOAL = '受け取った視聴者コメントに、決まったお礼の一言で応える';
import { publicGameDecision, publicGameAction, ACTION_LOG_SIZE } from './game-decision.mjs';
import { loadShowModule } from './games.mjs';
import { commentAck } from './comment-ack.mjs';
import { SpeechDirector, effectiveMode } from './speech-director.mjs';
import { plannedSilenceMs } from './audio-bus.mjs';
import { CollabSession, PARTNER_ACTIVE_MS } from './collab.mjs';
import { hearsPartner, partnerLeads, takesComments } from './control.mjs';
import { HumanLines } from './human-voice.mjs';
import { ResumeBridge } from './resume-bridge.mjs';

const planInvariant = () => Object.assign(new Error('Direction altered text'), { code: 'PLAN_INVARIANT' });
/** Engine-side counters only; tiers, engine names and timings never reach pending or the stage. */
const STAR_REACTIONS = ['やった、星ゲット！', 'よし、取れた！', 'あ、取れた取れた！', 'ふふ、星いただき！', 'やった、もう一個！'];
function voiceStats(metrics, audio) {
    const s = audio?.stats;
    if (!s) return;
    metrics.count('tts_tier_cache', s.tiers?.cache || 0); metrics.count('tts_tier_local', s.tiers?.local || 0); metrics.count('tts_engine_calls', s.calls || 0);
    // Seconds, not calls: newly generated audio (a cloud voice bills it whether or not it airs; a local one costs no
    // API fee) and reused phrase-cache audio. A streamed (cloud) part's length is only known when its stream ends.
    if (!s.stream) metrics.count(CLOUD.includes(s.engine) ? 'tts_generated_cloud_ms' : 'tts_generated_local_ms', s.audioMs || 0);
    metrics.count('tts_cache_audio_ms', s.cacheAudioMs || 0);
    if (s.synthMs > 0 && s.audioMs > 0) metrics.record('tts_rtf_permille', 1000 * s.synthMs / s.audioMs);
    if (s.stream && Number.isFinite(s.firstChunkMs)) metrics.record('tts_first_chunk_ms', s.firstChunkMs);
}
// Standby (STANDBY_SECONDS, operator 2026-10-11 show format): the stream opens on the 配信準備中 screen for a minute and
// Noa's first words are for the viewers. Before OBS starts, one fixed line proves the live audio path (OBS start requires a
// played line); then the show holds, silent, until the server puts the programme scene on air and releases it.
export const STANDBY_CHECK_LINE = 'マイクチェック、よし。今夜もよろしくね。';

/** Speech ≤ maxTurnAudioMs; a reaction sound adds at most maxReactionAudioMs on top (absolute ceiling = both). */
const reactionAllowance = (audio, c) => Math.min(Number.isFinite(audio.clipMs) ? audio.clipMs : 0, c.maxReactionAudioMs ?? 1200);
/** One speculative job, one playback owner. Approval always precedes publication. */
// One 3-minute round speaking ~40% of the time ≈ 72 s of new audio ≈ $0.011 on Flash-Lite, $0.016 on Flash (25 tok/s,
// $6 / $9 per 1M audio tokens until 2026-12-31). Twice the Flash figure leaves room for results and replies.
const ROUND_RESERVE_USD = .03;
// The closing line (~6 s ≈ $0.0014 on Flash) is held from show start, with room for one retry, so a show that stops
// for budget can still say goodbye in the same voice instead of requesting audio it can no longer pay for.
const CLOSING_RESERVE_USD = .005;
// The long goodbye (CLOSING_SECONDS, operator 2026-10-10: 「いきなり終わらないで、区切りの良い時に2分ほど挨拶してから終了」).
// Forced this long before the end when no break came; the hard stop waits this much past the goodbye's planned length.
const FAREWELL_LEAD_MS = 30000, FAREWELL_GRACE_MS = 60000;
const RESULT_FACE_DELAY_MS = 700;
// A reply to the voice-call partner (docs/COLLAB.md): a conversation turn, not a viewer answer.
const COLLAB_REPLY_GOAL = '通話相手の今の言葉に、会話として自然に応える。質問には答えを最初に言う。聞き取れない部分は決めつけない。';
const COLLAB_TTL_MS = 20000;
// Resume preparation (docs/CONTROL.md, Phase 4): the AI's first line after a handoff is made while the person speaks,
// during a pause of 2 s; it is used only while fresh (resynth: no newer line of theirs; at most 60 s, else 45 s).
const RESUME_PAUSE_MS = 2000;
const resumeFreshMs = c => c.humanVoiceMode === 'resynth' ? 60000 : 45000;
const COMMENT_REPLY_GOAL = '今回のコメントの質問には答えを最初に、感想や意見にはその内容に合う短い受け止めを返す。直前の発言と現在の観測で分かる範囲だけを使い、不明なことは不明と伝える。別のお題への展開や質問の付け足しは要らない。';
const COMMENT_REPLY_REPAIR = '直前案は放送されていない。failedCriteria は不足した審査項目（novel は既出内容の繰り返し、progress は今回のコメントへの直接回答）。直前案の言い換えや無関係な新しい話題ではなく、コメントが求めた答えや対象を、直前の発言と観測に照らして具体的に一つ返す。不明なら分かる範囲を短く明示する。準備や意気込みだけに戻さず、挨拶・質問・引用を足さない。';
const contentRefusal = e => e?.code === 'CONTENT_STALLED' || e?.code === 'GATE_REJECTED';
const refusalDropReason = e => e?.reason === 'no_progress' ? 'content_no_progress' : e?.reason === 'quote_denied' ? 'output_quote_denied' : 'output_unsafe_or_uncertain';
const blockNumbers = b => b.numbers();
/** True when the text quotes a board number that has since changed (whole numbers only, half/full-width digits). */
export function staleNumber(text, then, now) {
    const said = new Set((String(text).normalize('NFKC').match(/\d+/g) || []).map(Number));
    return Object.keys(then || {}).some(k => Number.isFinite(then?.[k]) && Number.isFinite(now?.[k]) && then[k] !== now[k] && said.has(then[k]));
}
/** True when the text says how much time is left ("残り1分", "残り20秒") and that is off by more than 15 s now. */
export function staleTimeLeft(text, b, now = Date.now()) {
    const m = /残り\s*(\d+)\s*(分|秒)/.exec(String(text).normalize('NFKC'));
    if (!m || !b?.round?.endsAt || b.phase !== 'playing') return false;
    const claimed = Number(m[1]) * (m[2] === '分' ? 60 : 1), left = (b.round.endsAt - now) / 1000;
    return Math.abs(claimed - left) > 15;
}
const DRINK_GOAL = 'NOA BEERを一口飲んだ一言（飲み配信の演出）';
/** The talk after a game-over review, one concrete topic per line in turn. Live 2026-10-07..10: one open goal (the fun,
 * a favourite way to play, the next idea) got the review's plan said again (rejected as no_progress 91 times) or the same
 * 「ゲームオーバーだったけど楽しかった」 every round; the one fresh line named a weapon from the run. */
const INTERMISSION_TOPICS = [
    o => o.weapons?.length ? 'さっきの回で持っていた武器（observation.weapons）から一つ選んで名前を出し、その武器が好きな気持ちを一言話す（「名前の響きが好き」「また使いたい」など）。見た目・効果・強さは作らない。' : null,
    () => 'このゲームで好きな瞬間（宝箱を開ける時、レベルアップで武器を選ぶ時、敵がまとめて消える時など）を一つ選び、好きな理由を一言で話す。',
    () => '今の気分（楽しい、ちょっと悔しい、わくわくする等）をノアの気持ちとして具体的に一言話す。数字は言わない。',
    () => '休憩の間にしたいこと（伸びをする、目を休める、深呼吸する等）を一つ選び、「〜したい気分」として一言話す。実際にしたとは言わない。',
];
export function intermissionGoal(observation = {}, n = 0) {
    let topic = null;
    for (let i = 0; !topic && i < INTERMISSION_TOPICS.length; i++) topic = INTERMISSION_TOPICS[(n + i) % INTERMISSION_TOPICS.length](observation);
    return `ゲームオーバー後の休憩。${topic}振り返りと次に試す作戦はもう話したので言い直さず、「ゲームオーバー」「もう一回」も繰り返さない。現在プレイ中とは言わず、直前の話を繰り返さない。`;
}
const SPEED_INVITE = '次のラウンドの速さは、コメントで「ゆっくり」「標準」「速め」から選べるよ。';
/** The face for a finished round, from the real comparison with the same-speed best. */
export const resultFace = r => !r ? 'happy' : r.previousBest === null || r.newBest ? 'excited' : r.delta >= -2 ? 'happy' : 'troubled';
export class TalkEngine extends Engine {
    constructor(c, deps) {
        super(c, deps);
        this.commentVoice = deps.commentVoice;
        this.showLogger = deps.showLogger || (c.dataDir ? new ShowLogger(c.dataDir, { retentionDays: c.commentRetentionDays }) : null);
        // NOA BLOCKS: the stage plays, this directs rounds; the show then ends with the rounds, not with the topic cards.
        // A game from games/<id> (e.g. Vampire Survivors): played outside the studio by its controller; the controller's log
        // feeds the round director its show module creates. (Every game show lives in `this.blocks`: same surface, so the
        // gate, stale checks and faces apply to any of them; docs/GAMES.md.)
        const emit = (type, data) => this.event(type, data);
        this.blocks = c.programme?.gameMode === 'blocks' ? new BlocksShow(c.programme.show, { dataDir: c.dataDir, emit, canAffordRound: () => this.canAffordRound(), sessionMs: c.sessionMs })
            : c.game ? loadShowModule(c.game).createShow(c.programme.show, { dataDir: c.dataDir, emit, name: c.character.name, viewerVotes: ['twitch', 'simulcast'].includes(c.streamTarget) }) : null;
        this.director = new Director(c.topicCards, { finite: c.finiteProgramme && !this.blocks, programme: c.programme, lobbyScenes: c.lobbyScenes }); this.markers = []; this.metrics = new Metrics();
        this.preparing = null; this.prepared = null; this.currentTurn = null;
        this.preparationTask = null; this.classifying = false;
        this.turnFailures = 0; this.generationFailures = 0; this.generationRetryAt = 0;
        this.generationSerial = 0; this.commentsPaused = false; this.closingRequested = false; this.contentStalls = 0; this.reactedScore = 0;
        this.speechDirector = new SpeechDirector(c); this.lastDelivery = null; this.lastEnded = null;
        this.operatorLines = []; this.operatorTaken = new Map(); this.farewell = null;
        this.gameDecisionCursor = null; this.gameActions = null; this.gameActionsTimer = null;
        // The voice-call partner (src/collab.mjs): Noa's published lines are remembered to drop her own voice heard back.
        this.collab = new CollabSession();
        this.humanLines = new HumanLines(); // a person's lines in Noa's own voice (HUMAN_VOICE_MODE=resynth, src/human-voice.mjs)
        this.bridge = new ResumeBridge(); // a fixed line when the AI takes the voice back with nothing prepared (src/resume-bridge.mjs)
        this.on('event', ev => { if (ev.type === 'speech' && ev.data?.role !== 'comment' && typeof ev.data?.text === 'string') this.collab.said(ev.data.text); });
    }
    /** The AI (or a person) leaves the voice: from the AI everything stops; from a person their queue stops but what they
     * said is kept for the AI's first line. The bridge lines are made ready at the first handoff of a show. */
    humanTakeover(to = 'human', from = 'ai') {
        super.humanTakeover(to);
        if (from === 'human') this.humanLines.clear(); else this.humanLines.reset();
        if (this.c.resumeBridge !== false) void this.bridge.prepare(
            text => this.jev.speech(text, this.controller?.signal, [], { kind: 'autonomous', utterance: 'operator', goal: '人間からAIに交代した直後の短いつなぎの一言', recentSpeech: [] }),
            text => this.synthHuman(text));
    }
    /** Back to the AI: the person's queued lines are dropped and one still playing stops; a fresh prepared resume line airs
     * at once (it already knew what they said), else a bridge line airs while the first line is made. */
    aiResume(heldMs) {
        if (this.pending?.human) super.cancelSpeech('voice_handoff'); // the base cancel: the prepared resume line is kept
        const said = [...this.humanLines.said], p = this.prepared;
        const fresh = !!p?.resume && Date.now() - p.resume.at < resumeFreshMs(this.c) && p.resume.seq === this.humanLines.seq;
        const inFlight = !!this.preparing?.resume;
        this.humanLines.reset();
        super.aiResume(heldMs);
        if (fresh || inFlight) this.handoffResume = null; // its context already had the handoff
        else {
            if (p) this.invalidatePreparation('resume_stale');
            if (said.length) this.handoffResume = { ...this.handoffResume, said };
        }
        if (!fresh) this.playBridge();
    }
    endHandoff(reason) { this.humanLines?.reset(); this.bridge?.reset(); super.endHandoff(reason); }
    playBridge() {
        if (this.c.resumeBridge === false || this.pending || !this.renderer || !this.validLease(this.renderer.lease)) return;
        const line = this.bridge.take();
        if (line) this.publishFixed(line.text, line.voice, { bridge: true });
    }
    /** Air a line that is already voiced (a person's line, a bridge line), outside the turn machinery. */
    publishFixed(text, v, flags) {
        const id = randomUUID();
        if (v.bytes) this.audio.set(id, v.bytes);
        this.pending = { id, epoch: this.epoch, text, role: 'host', reaction: 'neutral', kind: v.kind, durationMs: v.durationMs, ...(v.lipSync ? { lipSync: v.lipSync } : {}), started: false, deadline: Date.now() + 8000, sources: [], ...flags };
        this.event('speech', { ...this.pending, audio: v.kind === 'wav' ? `/audio/${id}.wav` : null });
    }
    /** While a person (or nobody) has the voice: keep the AI's first line ready, made in a pause and refreshed. */
    resumeStep(epoch, signal) {
        if (!this.director.opened || this.director.closing || this.pending || this.currentTurn || this.memoryHold) return;
        const p = this.prepared;
        if (p) {
            if (!(p.resume && Date.now() - p.resume.at < resumeFreshMs(this.c) && p.resume.seq === this.humanLines.seq)) this.invalidatePreparation('resume_stale');
            return;
        }
        if (this.preparing || this.humanLines.items.length || Date.now() - (this.humanActiveAt || 0) < RESUME_PAUSE_MS) return;
        this.startPrefetch(epoch, signal, { resume: true });
    }
    /** Whether a person's transcribed line would be spoken now (null) or why not; checked before transcribing, so the
     * person's mic is never transcribed while the AI has the voice. */
    humanAccepts() {
        if (!this.running) return 'not_running';
        if (this.control.voice === 'none') return 'muted';
        if (this.control.voice !== 'human') return 'ai_voice';
        if (this.c.humanVoiceMode !== 'resynth') return 'not_resynth';
        return null;
    }
    /** A person's line (resynth): spoken in Noa's TTS voice without the gate (operator decision 2026-10-19: a person's own
     * speech is not gated), after the local PII/injection check (operator decision 2026-10-19 for resynth: it is read in
     * Noa's voice and may be misheard). A dropped line is reported to the operator without its text. */
    humanHeard(text) {
        const no = this.humanAccepts();
        if (no) return { accepted: false, reason: no };
        if (typeof text !== 'string' || !text.trim()) return { accepted: false, reason: 'invalid' };
        if (hasPII(text) || injection(text)) {
            this.metrics.count('human_line_local_gate'); this.audit.log('human_line_drop', { reason: 'local_gate' });
            this.event('notice', { message: '中の人の発言を1つ読み上げませんでした（個人情報や指示の可能性）。' });
            return { accepted: false, reason: 'local_gate' };
        }
        this.humanActiveAt = Date.now();
        this.humanLines.add(text, t => this.synthHuman(t));
        return { accepted: true };
    }
    async synthHuman(text) {
        // Whole WAVs (no streaming): the next line is synthesized while the current one plays.
        const streaming = this.voice.streamingAllowed;
        try { this.voice.streamingAllowed = false; return await this.voice.synthesize(text, this.controller?.signal); }
        finally { this.voice.streamingAllowed = streaming; }
    }
    /** While a person has the voice (resynth): air their next ready line, in order, one at a time; and keep the AI's
     * resume line ready. */
    humanStep(epoch, signal) {
        if (!this.alive(epoch) || !this.renderer || !this.validLease(this.renderer.lease)) return;
        this.resumeStep(epoch, signal);
        if (this.control.voice !== 'human' || this.c.humanVoiceMode !== 'resynth' || this.pending) return;
        const item = this.humanLines.ready();
        if (!item) return;
        const v = item.voice;
        if (item.error || !(v?.bytes || v?.kind === 'browser')) {
            this.metrics.count('human_line_tts_failure');
            this.event('notice', { message: '中の人の発言を1つ、声にできませんでした。音声エンジンを確認してください。' });
            return;
        }
        this.humanActiveAt = Date.now();
        this.humanLines.aired(item.text);
        this.publishFixed(item.text, v, { human: true });
    }
    // The Studio's comment pause is the listening mode of src/control.mjs (muted = comments shown, not taken up).
    get commentsPaused() { return !!this.control && !takesComments(this.control.listening); }
    set commentsPaused(v) { if (this.control) this.control.listening = v ? 'muted' : 'comments'; }
    status() {
        return { ...super.status(), profile: 'talk', topic: this.director?.snapshot(), metrics: this.metrics?.snapshot(),
            programmeMarkers: [...(this.markers || [])], standby: this.standby ?? null, farewell: this.farewell ? { reason: this.farewell.reason, step: this.farewell.step, lines: this.farewell.lines.length } : null, commentsPaused: this.commentsPaused, prepared: !!this.prepared, preparing: !!this.preparing,
            generationRetryInMs: Math.max(0, this.generationRetryAt - Date.now()),
            ...(this.blocks ? { [this.blocks.statusKey || 'blocks']: this.blocks.status(), gameShow: { id: this.c.game?.id || 'blocks', title: this.blocks.title, statusKey: this.blocks.statusKey || 'blocks', external: !!this.c.game, ...(this.c.gameGoal ? { goal: this.c.gameGoal } : {}) } } : {}), replySlotsUsed: this.candidateSlotsUsed(), voiceCredit: [this.hostCredit(), this.c.readComments ? this.c.commentVoiceCredit : ''].filter(Boolean).join(' / '), readComments: this.c.readComments, replyTtsProvider: this.c.replyTtsProvider };
    }
    hostCredit() {
        const c = this.c, credits = { supertonic: 'Host: Supertonic 3', aivisspeech: c.aivisCredit || 'Host: AivisSpeech', sbv2: c.sbv2Credit || 'Host: Style-Bert-VITS2', 'gemini-tts': 'Host voice: Gemini TTS (Google, AI-generated)', 'gemini-lite-tts': 'Host voice: Gemini TTS (Google, AI-generated)' };
        return Object.hasOwn(credits, c.replyTtsProvider) ? credits[c.replyTtsProvider] : c.voiceCredit;
    }
    start() {
        if (this.running) return;
        this.director = new Director(this.c.topicCards, { finite: this.c.finiteProgramme && !this.blocks, programme: this.c.programme, lobbyScenes: this.c.lobbyScenes }); this.markers = []; this.metrics = new Metrics(); this.currentTurn = null; this.prepared = null;
        this.budgetClosingRequested = false; this.closingRequested = false; this.commentsPaused = false; this.handoffCloseNoted = false; this.collab.reset(); this.turnFailures = 0; this.turn = 0; this.contentStalls = 0; this.reactedScore = 0;
        this.generationFailures = 0; this.generationRetryAt = 0; this.lastDelivery = null; this.lastEnded = null; this.drink?.reset();
        this.gameDecisionCursor = null; this.gameActions = null; clearTimeout(this.gameActionsTimer); this.gameActionsTimer = null;
        this.closingHeld = this.holdClosing(); this.blocksChatMisses = 0; this.blocksChatMutedRound = null; this.operatorLines = []; this.operatorTaken = new Map(); this.budgetClosingReason = null; this.farewell = null;
        this.voice?.router?.spend?.startSession?.(); // report this broadcast's spend, not the day's running total
        const prog = this.c.programme || {};
        this.showLogger?.startSession({
            programmeId: this.c.programmeId || prog.id,
            programmeTitle: prog.title || this.director?.card?.title || '企画雑談',
            mode: this.c.mode,
            characterName: this.c.character?.name
        });
        if (this.blocks) this.blocks.start();
        if (this.c.game?.controller && this.c.gameLogDir) {
            const k = this.c.game.controller;
            this.gameFeed?.stop(); this.gameFeed = new RunLogFeed(this.c.gameLogDir, d => this.ingestGame(d, { fromLog: true }), { ...(k.logFile ? { logFile: k.logFile } : {}), ...(k.choicePhases ? { choicePhases: k.choicePhases } : {}) }).start();
        }
        // A cancelled provider that ignores Abort keeps its slot until it settles.
        // Do not start overlapping generations just because a new session began.
        super.start();
        this.standby = this.standbyMode(); this.standbyFrom = Date.now(); this.standbyRelease = false;
        // Warm the one configured engine on its own queue; a failure never blocks or stops the show.
        try { const w = this.voice.warmup?.(this.controller?.signal, { burnIn: true }); w?.catch?.(() => {}); } catch {}
        if (this.blocks && this.running) this.workers.push(this.worker(() => {
            const before = this.blocks.phase;
            this.blocks.tick();
            // Results: the board stops and Noa looks at it (stage); a moment later her face answers the real result.
            if (before === 'playing' && this.blocks.phase === 'results') {
                this.resultFaceAt = Date.now() + RESULT_FACE_DELAY_MS;
                this.dropPlayLines('round_ended');
                if (typeof this.affect?.appraiseGameEvent === 'function') {
                    const res = this.blocks.lastResult || {};
                    this.affect.appraiseGameEvent('game_over', { isStreak: !res.newBest });
                }
            }
            if (this.resultFaceAt && Date.now() >= this.resultFaceAt) { this.resultFaceAt = 0; this.reflex(resultFace(this.blocks.lastResult), 'game'); }
            if (this.blocks.phase === 'done' && !this.director.closing) { if (this.blocks.closedReason === 'budget') this.note('blocks_budget_close', 'voice budget below one round'); this.requestClose(); }
        }, 250, this.epoch, this.controller.signal));
    }
    queueView() {
        const now = Date.now(), seen = new Set(), out = [];
        for (const [owner, state] of [[this.currentTurn, 'answering'], [this.prepared, 'prepared'], [this.preparing, 'preparing']]) {
            const m = owner?.candidate;
            if (!m || seen.has(m.id) || ['dropped', 'completed'].includes(m.replyState)) continue;
            seen.add(m.id); out.push({ id: m.id, text: m.text, state, source: m.source, ageMs: Math.max(0, now - m.created), readAllowed: m.readAllowed === true, picked: true });
        }
        return [...out, ...super.queueView().filter(x => !seen.has(x.id))];
    }
    /** A semantic no_progress stall skips the beat (or drops the reply) so a long show keeps going; nothing unapproved
     * airs. A lexical loop, a closing, or 3 stalls in a row still stop the show. Returns true when it stopped. */
    handleStall(e, kind, metrics, message, utterance = null) {
        e.handled = true;
        this.showLogger?.logStalled({ reason: e.reason });
        // NOA BLOCKS small talk is optional: the rounds carry the show, so a rejected (or repeated) chat line is dropped
        // and skipped without counting toward the stop. Two misses in a row pause small talk for the rest of the round.
        // Nothing rejected ever airs; the stop rule still applies to every other line.
        // A NOA BLOCKS show whose goodbye line is refused still ended on schedule: finish cleanly without speaking it
        // (the stage shows its end card), recorded as completed with the refusal noted, not as a content failure.
        // A refused line of the long goodbye is skipped (nothing unapproved airs); only the last line ends the show if refused.
        if (this.farewell && (kind === 'closing' || utterance === 'closing') && this.farewell.step < this.farewell.lines.length - 1) {
            metrics.count('farewell_line_skipped'); this.note('farewell_skip', e.reason || e.code); this.farewell.step++; this.event('state', this.status()); return false;
        }
        if (this.blocks && (kind === 'closing' || utterance === 'closing')) {
            metrics.count('closing_refused_clean_end'); this.note('closing_refused', e.reason);
            this.stop('show_completed'); return true;
        }
        // In NOA BLOCKS the round director guarantees the show moves on, so every line except the opening and the closing
        // is optional: a rejected or repeated line is dropped (never retried, never aired) and does not count toward the
        // stop. Model-written small talk that misses twice in a row pauses for the rest of the round.
        if (this.blocks && !['opening', 'closing'].includes(kind) && !['opening', 'closing'].includes(utterance)) {
            metrics.count('blocks_line_skips');
            if (utterance === 'monologue' && ++this.blocksChatMisses >= 2) { this.blocksChatMutedRound = this.blocks.roundNo; this.note('blocks_chat_paused', `round ${this.blocks.roundNo}`); }
            return false;
        }
        // KEEP_LIVE: a line that cannot pass is dropped, never aired, and never ends the show (a refused closing still
        // does). Three misses in a row pause generation for 15 s so a stuck topic cannot spin through the daily budget.
        if (this.c.keepLive && kind !== 'closing') {
            metrics.count('content_stall_holds'); this.note('stall_hold', `${kind} · ${e.reason}`);
            if (++this.contentStalls >= 3) { this.contentStalls = 0; this.stallHoldUntil = Date.now() + 15000; }
            this.event('notice', { message: '審査を通る内容にならなかったため、この話は飛ばして次へ進みます。' });
            return false;
        }
        // Skippable: the gate said 'not progress' or 'not safe/certain' for this line. A lexical loop is not.
        if (!(e.reason === 'no_progress' || e.code === 'GATE_REJECTED') || kind === 'closing' || ++this.contentStalls >= 3) {
            metrics.count('content_stall_stops');
            this.event('notice', { message });
            this.stop('content_stalled'); return true;
        }
        metrics.count('content_stall_skips'); this.note('stall_skip', `${kind} · ${this.contentStalls}/3`);
        this.event('notice', { message: '審査を通る内容にならなかったため、この話は飛ばして次へ進みます。' });
        return false;
    }
    /** What kind of line this is decides what the gate asks: a comment reply and a monologue must progress the talk;
     * game lines must fit what was actually observed. Game facts come from the adapter, never from the model. */
    utterance(ctx, candidate, game) {
        // A programme may fix its opening/closing lines (NOA BLOCKS: the board does not exist yet at the opening, and the
        // goodbye must not depend on generation). They still pass the full gate; only the words are not model-written.
        // NOA BLOCKS closes on tonight's real result (the gate sees the same facts); before any round, the fixed line.
        if (ctx.kind === 'closing' && this.farewell) return this.farewellUtterance();
        const night = ctx.kind === 'closing' ? this.blocks?.closing() : null;
        if (night) return { utterance: 'closing', template: night.text, observation: night.observation };
        const fixed = ctx.kind === 'opening' ? this.c.programme?.openingLine : ctx.kind === 'closing' ? this.c.programme?.closingLine : null;
        if (typeof fixed === 'string' && fixed) return { utterance: ctx.kind, template: fixed };
        if (['opening', 'closing', 'unavailable'].includes(ctx.kind)) return { utterance: ctx.kind };
        // The voice-call partner: a conversation turn in any programme (a game show still gives what is observed).
        if (candidate?.collab) return { utterance: 'collab_reply', ...(this.blocks ? { observation: this.blocks.observation() } : {}) };
        // A line the operator typed: spoken as written (still gated), next after the line on air; not a programme beat.
        if (!candidate && this.operatorLines.length) {
            const o = this.operatorLines.shift(); this.operatorTaken.set(o.id, o);
            return { utterance: 'operator', template: o.text, operatorId: o.id, ...(this.blocks ? { observation: this.blocks.observation() } : {}) };
        }
        if (this.blocks) return this.blocksUtterance(ctx, candidate);
        const observation = game ? { game: game.title, what: game.goal, status: game.justGotStar ? 'just_got_star' : game.distance <= 1 ? 'star_adjacent' : game.distance <= 3 ? 'star_near' : 'star_far',
            lastMove: game.lastAction, score: game.score, paused: !!game.paused } : null;
        if (candidate?.ackOnly) return { utterance: 'fixed_ack', observation, template: fixedAck(candidate.text), goal: FIXED_ACK_GOAL };
        if (candidate) {
            // "What game is this?" gets a fixed answer from the adapter (still gated), never a model guess.
            const asksGame = game && /(何|なん|どんな)の?ゲーム|ゲーム(名|の名前|は何|なに)|何(して|やって)(る|い)/.test(candidate.text || '');
            // A factual game answer is judged on fit to the adapter's facts, not on editorial novelty.
            if (asksGame) return { utterance: 'game_fact', observation, template: `今は「${game.title}」をやってるよ。${game.goal}なんだ。` };
            return { utterance: 'comment_reply', observation };
        }
        if (game && game.score > this.reactedScore)
            // A star is a fixed, observed event: a short fixed reaction (still gated) beats a model that adds metaphors.
            return { utterance: 'game_reaction', observation: { ...observation, eventId: `star-${game.score}`, event: '星をひとつ取った' },
                goal: '今起きたこと（星を取った）に、配信者の短い一言で反応する（10〜25字、実況口調、たとえ話なし）', template: STAR_REACTIONS[(game.score - 1) % STAR_REACTIONS.length] };
        const sip = this.drinkUtterance();
        if (sip) return sip;
        if (game && this.director.beatSpec(ctx.topicBeat).game === true) return { utterance: 'game_commentary', observation };
        return { utterance: 'monologue' };
    }
    /** DRINK_MODE (src/drink-mode.mjs, operator-approved 2026-10-10): a fixed sip line when one is due. Asked only for a
     * turn without a comment and after any game event line, so a sip never interrupts a line on air, a reply or a game
     * reaction; the schedule keeps sips minutes apart. Off: nothing is scheduled and every turn is as before. */
    drinkUtterance(now = Date.now()) {
        if (this.c.drinkMode !== true) { this.drink?.reset(); return null; }
        if (!this.director.opened || this.director.closing) return null;
        this.drink ??= new DrinkSchedule();
        const text = this.drink.arm(now).take(now);
        return text ? { utterance: 'drink', template: text, goal: DRINK_GOAL } : null;
    }
    blocksUtterance(ctx, candidate) {
        const b = this.blocks;
        b.setParticipationEnabled?.(this.participationConnected());
        const observation = b.observation();
        if (candidate?.ackOnly) return { utterance: 'fixed_ack', observation, template: fixedAck(candidate.text), goal: FIXED_ACK_GOAL };
        if (candidate) {
            const text = candidate.text || '', speed = b.chooseSpeed(text);
            if (speed) return { utterance: 'game_fact', observation: { ...observation, event: speed.eventText, facts: speed.facts }, template: speed.text };
            if (/(何|なん|どんな)の?ゲーム|ゲーム(名|の名前|は何|なに)|何(して|やって)(る|い)/.test(text))
                return { utterance: 'game_fact', observation, template: `今は「${b.title}」をやってるよ。${b.what}なんだ。` };
            // A question about the run: answered from the observation, judged as a game fact answering the comment.
            const fact = b.answer?.(text);
            if (fact) return { utterance: 'game_fact', observation: { ...observation, event: fact.event, facts: fact.facts }, template: fact.text };
            // A greeting, first visit, cheer or compliment: a short fixed answer, judged on responding to it naturally.
            const ack = commentAck(text, this.director.committedTurns, this.c.character?.name);
            if (ack) return { utterance: 'comment_ack', observation, template: ack.template };
            return { utterance: 'comment_reply', observation };
        }
        if (this.affect?.tone) b.tone = this.affect.tone();
        const line = b.takeLine();
        if (line) return { roundTransition: b.transitionInfo?.(line.eventId) || null, utterance: line.kind, observation: { ...observation, eventId: line.eventId, event: line.eventText ?? line.event?.type ?? line.kind, facts: line.facts ?? line.event?.facts ?? null }, template: line.text };
        // DRINK_MODE: a sip comes after the game's own lines, never during the lead-in to the game screen.
        if (!(b.phase === 'lobby' && b.leadIn)) { const sip = this.drinkUtterance(); if (sip) return sip; }
        // Opening talk before the game (Vampire Survivors lobby): only the lobby's talk beats, with no game in the model's
        // context (the game is announced later by a fixed line). Story beats never wrap within the lobby.
        if (b.intermissionChat) return { utterance: 'monologue', observation, goal: intermissionGoal(observation, this.intermissionTopicNo = (this.intermissionTopicNo || 0) + 1), intermission: true, intermissionDeadline: Number.isFinite(b.intermissionRemainingMs) ? Date.now() + b.intermissionRemainingMs : null };
        // The review/resume lines above own a bounded break. Once its chat window closes, do not fall through to a
        // normal talk beat and extend it. Replies still take the candidate path above.
        if (b.phase === 'between' && Number.isFinite(b.review?.chatUntil)) return { utterance: 'quiet' };
        const lobbySpec = this.director.beatSpec(ctx.topicBeat);
        if (b.phase === 'lobby') {
            if (b.leadIn) return { utterance: 'quiet' }; // the lead-in was said: no more talk before the game screen opens
            if (!lobbySpec.lobby) { b.startGame?.('lobby_topics_complete'); return { utterance: 'quiet' }; }
            return { utterance: 'monologue', lobby: true };
        }
        if (lobbySpec.lobby) { this.director.skipLobby(); return { utterance: 'quiet' }; }
        // While a round is played, the game is the show: no filler talk within a few seconds of the last line.
        if (b.phase === 'playing' && Date.now() - (this.lastHostEndAt || 0) < (b.cfg.quietMs ?? 7000)) return { utterance: 'quiet' };
        const spec = this.director.beatSpec(ctx.topicBeat);
        if (spec.game === true) {
            // Board talk only about a board in play, and only when something new is true; otherwise play quietly.
            const c = b.phase === 'playing' ? b.commentary() : null;
            if (!c) return { utterance: 'quiet' };
            b.markCommentary(c);
            return { utterance: 'game_commentary', observation: { ...observation, point: c.text }, demo: [c.text], ...(b.fixedCommentary ? { template: c.text } : {}) };
        }
        // Chat beats air once per show (the speed invitation once per round): no lines on a loop.
        const key = spec.invite ? `beat-${spec.id}-${b.roundNo}` : `beat-${spec.id}`;
        if (b.said.has(key)) { this.director.skipBeat(); return { utterance: 'quiet' }; }
        b.said.add(key);
        // The speed invitation is a fact about the show: a scripted line judged against that fact, not model small talk.
        if (spec.invite && b.roundNo < b.cfg.maxRounds) return { utterance: 'game_fact', template: SPEED_INVITE,
            observation: { ...observation, eventId: `invite-${b.round?.roundId}`, event: '視聴者はコメントで次のラウンドの速さ（ゆっくり・標準・速め）を選べる', facts: { choices: ['ゆっくり', '標準', '速め'], appliesTo: 'next round' } } };
        if (spec.invite) { this.director.skipBeat(); return { utterance: 'quiet' }; } // no next round to choose for
        if (this.blocksChatMutedRound === b.roundNo) { this.director.skipBeat(); return { utterance: 'quiet' }; }
        return { utterance: 'monologue', observation };
    }
    /** The paid-voice ledger when the host voice is a cloud engine (DirectedVoice keeps it on its router), else null. */
    cloudSpend() {
        const r = this.voice?.router ?? this.voice;
        let cloud = false; try { cloud = !!r?.adapter?.()?.info?.cloud; } catch { }
        return cloud && r?.spend ? r.spend : null;
    }
    /** A new round needs ROUND_RESERVE_USD left after in-flight requests and the held closing line. Local voices: always. */
    canAffordRound() {
        const spend = this.cloudSpend();
        if (!spend) return true;
        if (this.closingHeld === false) return false; // cannot even guarantee the goodbye: do not start a round
        return spend.remaining() >= ROUND_RESERVE_USD;
    }
    holdClosing() {
        const spend = this.cloudSpend();
        if (!spend) return null;
        try { spend.hold('closing', CLOSING_RESERVE_USD); return true; } catch { this.note('closing_unfunded', 'voice budget below the closing reserve'); return false; }
    }
    releaseClosing() { this.cloudSpend()?.release('closing'); }
    /** Queue a line the operator wants Noa to say next. It never interrupts the line on air: a not-yet-started
     * autonomous or game line being prepared is set aside so this one comes next; comment replies keep their place. */
    sayOperator(text) {
        const t = typeof text === 'string' ? text.trim() : ''; // exactly as typed (no width normalisation)
        if (!this.running) return { accepted: false, reason: 'not_running' };
        if (this.director.closing) return { accepted: false, reason: 'closing' };
        if (!t || t.length > 120 || /[\u0000-\u001f\u007f]/.test(t)) return { accepted: false, reason: 'invalid_text' };
        // Live 2026-10-10: a three-sentence line was accepted, failed the turn bound on every preparation, was put back
        // each time and, ahead of every game line, kept Noa silent for four hours. A line over the bound is refused here.
        if (this.boundedSentences(t) > 2) return { accepted: false, reason: 'too_many_sentences' };
        if (this.operatorLines.length >= 3) return { accepted: false, reason: 'queue_full' };
        const line = { id: randomUUID(), text: t, at: Date.now(), failures: 0 };
        this.operatorLines.push(line);
        const next = this.prepared || this.preparing;
        if (next && !next.candidate && !['opening', 'closing'].includes(next.kind) && next.utterance !== 'operator' && !(next.published > 0) && !(next.turn?.published > 0)) this.invalidatePreparation('operator_line', false);
        this.event('operator', { id: line.id, state: 'queued', text: t });
        return { accepted: true, id: line.id };
    }
    /** When a round ends, lines about that round's play that have not started yet are dropped (queued, prepared or
     * still being prepared). Comment replies are kept (they are answers, not play-by-play). */
    dropPlayLines(reason) {
        const play = u => ['game_commentary', 'monologue'].includes(u);
        if (this.pending && !this.pending.started && play(this.pending.cue?.utterance)) { this.metrics.count('commentary_after_round'); this.cancelSpeech(reason); return; }
        if ((this.prepared && play(this.prepared.utterance)) || (this.preparing && play(this.preparing.utterance))) { this.metrics.count('commentary_after_round'); this.invalidatePreparation(reason, false); }
    }
    /** The operator's report from a game a person plays (manifest player 'operator'): the show's report() makes it an
     * event with the same gated lines and faces as an observed one. Nothing is spoken that was not reported. */
    reportGame(event) {
        if (!this.blocks || !this.running) return { accepted: false, reason: 'not_running', message: '番組の開始後に報告できます。' };
        if (this.c.game?.player !== 'operator' || typeof this.blocks.operatorReport !== 'function') return { accepted: false, reason: 'not_operator_game', message: 'この番組のゲームは報告の対象ではありません。' };
        const r = this.blocks.operatorReport(event);
        if (this.control.voice === 'ai') for (const face of r.faces || []) this.reflex(face, 'game'); // a person speaking leads Noa's face
        if (r.accepted) {
            this.note('game_event', String(event));
            // The reaction goes next: talk or commentary that has not started yet gives way (a reaction lives only
            // a few seconds; behind a prepared line it expired unspoken). Comment replies are kept.
            this.dropPlayLines('game_report');
        }
        return r;
    }
    /** Stage reports (lease-checked by the server): real board events; each gets an instant wordless face. */
    ingestGame(data, { fromLog = false } = {}) {
        if (!this.blocks || !this.running) return { accepted: false, reason: 'no_blocks_show' };
        const r = this.blocks.ingest(data);
        for (const face of r.faces || []) this.reflex(face, 'game');
        // A game event during play outranks small talk still being written: the model line (with its gate, 20-40 s under
        // load) would hold the only preparation slot until the event's line expired (2026-10-10 review: most 30 s+ silences
        // were a monologue being written and refused). It is set aside, not skipped; the event's line is prepared next.
        const p = this.preparing;
        if (r.accepted && r.faces?.length && p && p.utterance === 'monologue' && !p.lobbyStory && !p.intermissionDeadline && !this.director.closing) {
            this.metrics.count('monologue_yielded_to_game'); this.invalidatePreparation('game_event', false);
        }
        // A board game reports its events; the Vampire show finds its own in the observed state (r.events).
        const gameEvents = r.events ?? data?.events;
        if (r.accepted && gameEvents?.length) {
            this.note('game_event', gameEvents.map(e => e.type).join(','));
            for (const e of gameEvents) {
                if (typeof this.affect?.appraiseGameEvent === 'function') {
                    this.affect.appraiseGameEvent(e.type, e.facts || {});
                }
            }
        }
        // The renderer's /api/game report cannot supply this provenance argument. Rebuild the small
        // allowlisted DTO before the shared event stream; no decision is retained in status/reconnect.
        if (fromLog && r.accepted && this.c.game?.id === 'vampire-survivors' && this.blocks.phase === 'playing'
            && data.runId === this.blocks.round?.roundId) {
            const d = publicGameDecision(data.decision), prev = this.gameDecisionCursor;
            if (d && d.runId === data.runId && (!prev || prev.epoch !== this.epoch || prev.runId !== d.runId || (d.sequence > prev.sequence && d.attempt > prev.attempt))) {
                this.gameDecisionCursor = { epoch: this.epoch, runId: d.runId, sequence: d.sequence, attempt: d.attempt };
                this.event('game_decision', { ...d, epoch: this.epoch });
            }
            this.pushGameAction(data.runId, publicGameAction(data.action));
        }
        return r;
    }
    /** The stage's always-on action log: the last ACTION_LOG_SIZE commands of the current run, sent at most twice a second. */
    pushGameAction(runId, action) {
        if (!action) return;
        if (this.gameActions?.runId !== runId || this.gameActions.epoch !== this.epoch) this.gameActions = { runId, epoch: this.epoch, items: [] };
        const items = this.gameActions.items;
        if (items.length && action.seq <= items[items.length - 1].seq) return;
        items.push(action); if (items.length > ACTION_LOG_SIZE) items.shift();
        if (this.gameActionsTimer) return;
        this.gameActionsTimer = setTimeout(() => {
            this.gameActionsTimer = null;
            const a = this.gameActions;
            if (this.running && a && a.epoch === this.epoch) this.event('game_actions', { runId: a.runId, epoch: a.epoch, items: a.items.map(x => ({ ...x })) });
        }, 500);
    }
    markReacted(eventId) { const n = Number(String(eventId).split('-')[1]); if (Number.isFinite(n)) this.reactedScore = Math.max(this.reactedScore, n); }
    candidateSlotsUsed() {
        const owners = [this.preparing, this.prepared, this.currentTurn];
        return this.candidates.length + owners.filter(x => x?.ownsCandidate && x.candidate).length;
    }
    ingest(m) {
        // A paused (muted) comment is still shown in the chat box: Engine.ingest drops it after the display.
        if (this.director.closing && !this.farewellTakesComments()) {
            if (this.running && typeof m?.text === 'string' && m.text.trim() && m.text.length <= 500) this.participation.receive(m);
            return { accepted: false, reason: 'comments_paused' };
        }
        const result = super.ingest(m);
        if (result.accepted) {
            this.intake.at(-1).receivedMono = performance.now();
            this.metrics.count('chat_received');
        } else this.metrics.count(`chat_drop_${result.reason}`);
        return result;
    }
    async classify(epoch, signal) {
        if (this.control.voice !== 'ai') return;
        if (this.classifying || (this.director.closing && !this.farewellTakesComments()) || !this.alive(epoch)) return;
        this.classifying = true;
        const before = new Set(this.candidates.map(x => x.id));
        try {
            await super.classify(epoch, signal);
            if (!this.alive(epoch)) return;
            if (this.director.closing && !this.farewellTakesComments()) { this.dropQueued('closing'); return; }
            // Talk mode never pretends to search.
            for (const m of this.researchQueue.splice(0)) this.candidates.push({ ...m, kind: 'unavailable' });
            const selected = this.candidates.filter(x => !before.has(x.id));
            for (const m of selected) m.replyState = 'selected';
            if (selected.length) {
                if (this.preparing?.kind === 'autonomous' || this.prepared?.kind === 'autonomous') this.invalidatePreparation('comment_selected');
                this.metrics.count('chat_selected', selected.length);
            }
        } finally { this.classifying = false; }
    }
    async researchStep() { }
    participationConnected() {
        const target = this.c.streamTarget;
        return this.running && !this.commentsPaused && !this.director.closing &&
            ((target !== 'twitch' && ['connected', 'listening', 'polling_degraded'].includes(this.youtubeStatus)) ||
             (target !== 'youtube' && this.twitchStatus === 'connected'));
    }
    staleParticipation(turn) {
        return String(turn?.eventId || '').startsWith('participation-') &&
            (!this.participationConnected() || !this.blocks?.stillValid(turn.eventId));
    }
    /** Check the fact snapshot that supplied this line, not the board when generation happened to finish.
     * Host parts are checked separately: an already heard sentence cannot make a neutral continuation stale. */
    staleGameSpeech(turn, text) {
        if (!this.blocks || !turn) return null;
        if (turn.utterance === 'closing') return null; // the goodbye's recap is tonight's summary, frozen when the goodbye began
        if (turn.eventId && !this.blocks.stillValid(turn.eventId)) return { reason: 'stale_event', metric: 'event_line_stale' };
        const changedRound = turn.roundAt && (this.blocks.phase !== turn.roundAt.phase || this.blocks.round?.roundId !== turn.roundAt.roundId);
        if (changedRound && turn.candidate && ['comment_reply', 'game_fact'].includes(turn.utterance))
            return { reason: 'stale_game_context', metric: 'reply_context_stale' };
        if (changedRound && turn.roundAt.phase === 'playing' && ['game_commentary', 'monologue'].includes(turn.utterance))
            return { reason: 'round_ended', metric: 'commentary_after_round' };
        if ((turn.boardAt && staleNumber(text, turn.boardAt, blockNumbers(this.blocks))) || staleTimeLeft(text, this.blocks))
            return { reason: 'stale_number', metric: 'number_line_stale' };
        return null;
    }
    retireStaleGameSpeech(turn, stale) {
        this.metrics.count(stale.metric); this.note(stale.reason, turn.utterance || turn.kind);
        // Narration already published is never replayed. A viewer's question nobody has heard yet is answered once more
        // from the current game (requeued, so generation sees the new snapshot); a second stale answer is dropped.
        const retry = !!turn.candidate && !turn.published && !turn.candidate.freshnessRequeued;
        if (retry) turn.candidate.freshnessRequeued = true;
        this.releaseCandidate(turn, stale.reason, retry);
        turn.controller.abort();
        if (this.currentTurn === turn) this.currentTurn = null;
        if (this.prepared === turn) this.prepared = null;
        // Keep any in-flight provider's preparation lock until its finally; no overlapping generation on cancellation.
        super.cancelSpeech(stale.reason);
    }
    reconcileParticipation() {
        this.blocks?.setParticipationEnabled?.(this.participationConnected());
        if ((this.staleParticipation(this.preparing) && !this.preparing.controller.signal.aborted) || this.staleParticipation(this.prepared))
            this.invalidatePreparation('participation_unavailable', false);
        // A sentence already playing may finish naturally. An unstarted sentence (including the next part)
        // must not invite replies after the receiver disconnects or the optional question expires.
        if (this.staleParticipation(this.currentTurn) && !this.pending?.started) {
            this.metrics.count('participation_speech_cancelled');
            this.cancelSpeech('participation_unavailable'); return true;
        }
        return false;
    }
    monitor() {
        this.reconcileParticipation();
        // Barge-in: the partner talks over Noa for longer than a backchannel (COLLAB_BARGE_IN_MS; 0 = never): she stops.
        const barge = this.c.collabBargeInMs;
        if (this.running && barge > 0 && this.pending && this.control.voice === 'ai' && hearsPartner(this.control.listening) && this.collab.speakingFor() >= barge) {
            this.metrics.count('collab_barge_in'); this.cancelSpeech('collab_barge_in');
        }
        // The goodbye overran even its grace (e.g. many replies): end as a completed show (the stage shows its end card).
        if (this.running && this.farewell && Date.now() >= this.endAt) { this.note('farewell_timeout', `line ${this.farewell.step + 1}/${this.farewell.lines.length}`); this.stop('show_completed'); return; }
        if (this.running && !this.director.closing) {
            const left = this.endAt - Date.now(), farewellMs = this.farewellMs();
            let due = null;
            if (!farewellMs) { if (left <= Math.min(20000, this.c.sessionMs / 4)) due = 'operator'; }
            // Near the end the goodbye waits for a natural break (a game round over); without one it starts in time anyway.
            else if (left <= farewellMs + Math.min(FAREWELL_LEAD_MS, this.c.sessionMs / 8)) due = 'time';
            else if (left <= this.c.windDownMs && this.blocks?.atBreak?.()) due = 'round_end';
            // A person speaking as Noa is never cut into by the AI's goodbye: the operator hands back (or presses finish).
            if (due && this.control.voice !== 'ai') {
                if (!this.handoffCloseNoted) { this.handoffCloseNoted = true; this.event('notice', { message: 'お別れの時間です。AIに戻すか「挨拶して終了」を押すと、お別れを始めます。' }); }
            } else if (due) this.requestClose(due);
        }
        super.monitor();
    }
    candidateInvalidReason(candidate) {
        if (!candidate) return null;
        if (candidate.epoch !== this.epoch) return 'session_changed';
        if (!Number.isFinite(candidate.created) || Date.now() - candidate.created >= (candidate.collab ? COLLAB_TTL_MS : this.c.commentTTL || 60000)) return 'expired';
        return null;
    }
    /** What the voice-call partner said (server: capture page -> whisper -> here). Kept as call history; answered when
     * the listening mode hears the partner and the AI has the voice. Their words are input like a comment: the local
     * PII/injection check here, and Noa's reply passes the full gate (operator decision 2026-10-19: no Jev.chat call). */
    collabHeard(text) {
        if (!this.running) return { accepted: false, reason: 'not_running' };
        if (typeof text !== 'string' || !text.trim()) return { accepted: false, reason: 'invalid' };
        if (hasPII(text) || injection(text)) { this.metrics.count('collab_drop_local_gate'); this.audit.log('collab_drop', { reason: 'local_gate' }); return { accepted: false, reason: 'local_gate' }; }
        if (this.collab.isEcho(text)) { this.metrics.count('collab_drop_echo'); return { accepted: false, reason: 'echo' }; }
        if (!hearsPartner(this.control.listening)) return { accepted: false, reason: 'not_listening' };
        this.collab.heard(text);
        // A person speaking as Noa answers the partner themself; the AI keeps the call for when it has the voice again.
        if (this.control.voice !== 'ai') return { accepted: false, reason: 'human_voice' };
        if (this.director.closing && !this.farewellTakesComments()) return { accepted: false, reason: 'closing' };
        this.metrics.count('collab_heard');
        // Consecutive pieces of one turn that are not being answered yet are one utterance.
        const queued = this.candidates.find(x => x.collab && x.replyState === 'selected');
        if (queued) { queued.text = `${queued.text} ${text}`.slice(-300); queued.created = Date.now(); }
        else {
            const m = { id: randomUUID(), text, source: 'collab', collab: true, kind: 'reply', readAllowed: false, created: Date.now(), epoch: this.epoch, replyState: 'selected' };
            // Comments first / both by age: behind the queued comments; partner first / partner only: at the head.
            if (['comments_first', 'both'].includes(this.control.listening)) this.candidates.push(m); else this.candidates.unshift(m);
        }
        if (this.preparing?.kind === 'autonomous' || this.prepared?.kind === 'autonomous') this.invalidatePreparation('collab_heard');
        return { accepted: true };
    }
    /** The next candidate this mode lets Noa take up: partner first holds comments back while the partner is in the call. */
    takeCandidate() {
        const holdComments = this.control.listening === 'discord_first' && this.collab.activeWithin(PARTNER_ACTIVE_MS);
        for (let i = 0; i < this.candidates.length;) {
            const m = this.candidates[i], reason = this.candidateInvalidReason(m);
            if (reason) { this.candidates.splice(i, 1); this.dropCandidate(m, reason); continue; }
            if (holdComments && !m.collab) { i++; continue; }
            return this.candidates.splice(i, 1)[0];
        }
        return null;
    }
    dropCandidate(candidate, reason) {
        if (!candidate || ['dropped', 'completed'].includes(candidate.replyState)) return;
        candidate.replyState = 'dropped';
        this.stats.dropped++; this.metrics.count(`comment_drop_${reason}`);
        this.audit.log('chat_drop', { id: candidate.id, reason });
    }
    dropQueued(reason) {
        for (const m of [...this.intake.splice(0), ...this.candidates.splice(0), ...this.researchQueue.splice(0)]) this.dropCandidate(m, reason);
    }
    /** Release exactly once; never replay an answer already published to a renderer. */
    releaseCandidate(owner, reason, retry = true) {
        if (!owner?.ownsCandidate || !owner.candidate) return;
        owner.ownsCandidate = false;
        const m = owner.candidate;
        const invalid = this.candidateInvalidReason(m);
        if (owner.published > 0) { this.dropCandidate(m, `interrupted_${reason}`); return; }
        if (invalid || !retry || !this.running || this.director.closing) {
            this.dropCandidate(m, invalid || (this.director.closing ? 'closing' : reason)); return;
        }
        if (['dropped', 'completed'].includes(m.replyState) || this.candidates.some(x => x.id === m.id)) return;
        // Reservations normally keep this queue below its bound. If an external
        // caller changed it, retain the earlier accepted reply and account for eviction.
        while (this.candidates.length >= (this.c.maxCandidates || 2)) this.dropCandidate(this.candidates.pop(), 'reservation_replaced');
        m.replyState = 'selected'; this.candidates.unshift(m);
        this.metrics.count('comment_requeued'); this.audit.log('chat_requeue', { id: m.id, reason });
    }
    async prepareBudgetClosing() {
        if (!this.c.memoryGuard || this.budgetFarewell) return;
        const text = '今日はここまでにするね、おつかれさま、また次の配信で会おうね！';
        const signal = AbortSignal.timeout(65000);
        const verdict = await this.jev.speech(text, signal, [], {kind:'closing',utterance:'operator',goal:'配信を終了する短い挨拶。視聴者数や反応を断定しない。',recentSpeech:[]});
        if (!verdict.accept) throw new Error('締めの挨拶が出力検査を通りませんでした。');
        const streaming = this.voice.streamingAllowed;
        let audio;
        try { this.voice.streamingAllowed = false; audio = await this.voice.synthesize(text, signal); }
        finally { this.voice.streamingAllowed = streaming; }
        // DEMO speaks through the browser (no bytes); that farewell is as available as every other demo line.
        if (!(audio.bytes || audio.kind === 'browser') || audio.durationMs > this.c.maxTurnAudioMs) throw new Error('締めの挨拶の音声を用意できません。声の接続（設定ページ 02）を確認してください。');
        this.budgetFarewell = {text,verdict,audio};
    }
    requestBudgetClose(reason) {
        if (!this.running || this.budgetClosingRequested) return;
        this.budgetClosingRequested = true; this.budgetClosingReason = reason;
        this.note('budget_closing', reason); this.event('budget_closing', {reason});
        if (!this.budgetFarewell) { this.stop('budget_without_farewell'); return; }
        this.generationRetryAt = 0;
        this.requestClose();
    }
    requestClose(reason = 'operator') {
        if (!this.running || this.director.closing) return;
        // Nothing has aired yet during standby (the silent hold before the programme scene): no goodbye to say, stop now.
        if (this.standby) { this.note('standby', `stopped before the show began · ${reason}`); this.stop('stopped_in_standby'); return; }
        this.director.closing = true; this.closingRequested = true;
        this.dropQueued('closing'); this.invalidatePreparation('closing', false);
        // A budget goodbye keeps its one pre-approved line; otherwise the long goodbye when configured.
        const ms = this.budgetClosingRequested ? 0 : this.farewellMs();
        if (!ms) return;
        const lines = this.farewellLines(reason), now = Date.now();
        this.farewell = { reason, startedAt: now, lines, step: 0, slotMs: ms / lines.length };
        this.endAt = Math.max(this.endAt, now + ms + FAREWELL_GRACE_MS); // the session limit stays the hard stop, after the goodbye
        this.note('farewell', `${reason} · ${lines.length} lines · ${Math.round(ms / 1000)} s`); this.event('farewell', { reason, lines: lines.length, ms });
        this.event('state', this.status());
    }
    /** 'check' when a live show opens on the standby screen (STANDBY_SECONDS), else null. */
    standbyMode() { return this.c.standbyMs > 0 && this.c.mode === 'live' ? 'check' : null; }
    /** Standby: say the audio-check line once (gated, off air), then hold silently until releaseStandby(). */
    async standbyStep(epoch, signal) {
        if (this.pending || this.standbyChecking) return;
        if (this.standby === 'check' && this.lastAudioOK) {
            this.standby = 'hold'; this.note('standby', 'audio checked · holding for the programme scene'); this.event('state', this.status());
            if (this.standbyRelease) this.releaseStandby();
            return;
        }
        if (this.standby !== 'check' || Date.now() < this.nextTurnAt) return;
        this.standbyChecking = true;
        try {
            const text = STANDBY_CHECK_LINE;
            const verdict = await this.jev.speech(text, signal, [], { kind: 'opening', utterance: 'opening', fixedLine: true, goal: '配信開始前の音声確認', recentSpeech: [] });
            if (!this.alive(epoch) || this.standby !== 'check') return;
            if (!verdict.accept) throw new Error('Output gate rejected speech');
            const voice = await this.voice.synthesize(text, signal);
            if (!this.alive(epoch) || !this.renderer || this.standby !== 'check') return;
            const id = randomUUID();
            if (voice.bytes) this.audio.set(id, voice.bytes);
            this.pending = { id, epoch, text, role: 'host', reaction: 'happy', kind: voice.kind, durationMs: voice.durationMs, started: false, deadline: Date.now() + 8000, sources: [], standbyCheck: true };
            this.event('speech', { ...this.pending, audio: voice.kind === 'wav' ? `/audio/${id}.wav` : null });
        } catch (e) {
            if (!this.alive(epoch)) return;
            this.note('standby', `check failed · ${e.code || e.message}`.slice(0, 120)); this.nextTurnAt = Date.now() + 5000;
        } finally { this.standbyChecking = false; }
    }
    /** The programme scene is on air (or OBS was adopted): the show begins. The standby time does not count against the
     * session or the opening talk. Before the audio check has passed, the release waits for it. -> whether it released. */
    releaseStandby() {
        if (!this.running || !this.standby) return false;
        if (this.standby === 'check') { this.standbyRelease = true; return false; }
        const held = Math.max(0, Date.now() - this.standbyFrom);
        this.standby = null; this.endAt += held;
        if (this.blocks?.phase === 'lobby' && this.blocks.lobbyStartedAt !== null) this.blocks.lobbyStartedAt += held;
        this.nextTurnAt = 0; this.note('standby', `released after ${Math.round(held / 1000)} s`); this.event('state', this.status());
        return true;
    }
    /** How long the goodbye should take: CLOSING_SECONDS, at most a quarter of a short show (0: one closing line). */
    farewellMs() { return this.c.closingMs > 0 ? Math.min(this.c.closingMs, this.c.sessionMs / 4) : 0; }
    /** Comments are answered during the goodbye, until its last line is being prepared. */
    farewellTakesComments() { return !!this.farewell && this.farewell.step < this.farewell.lines.length - 1; }
    /** The goodbye's fixed lines (no model text; each still passes the gate's local check): why we close, tonight's recap
     * from the game's real results, thanks, the next time, and the last line. Two sentences at most each (a turn's limit). */
    farewellLines(reason) {
        // A game show (operator 2026-10-11): the first line ends the game on the game screen, the rest is said on the talk
        // screen as a recap of the night.
        const game = !!this.c.game;
        const lead = reason === 'round_end' ? (game ? 'ちょうど区切りもいいし、そろそろゲームは終わりにしようか。' : 'ちょうど区切りもいいし、今夜はこのあたりで締めに入ろうかな。')
            : reason === 'time' ? (game ? 'あ、そろそろ時間だ。ゲームはこのへんで終わりにしようか。' : 'あ、そろそろ時間になっちゃった。今夜はこのあたりで締めに入るね。')
            : game ? 'それじゃあ、そろそろゲームは終わりにしようか。' : 'それじゃあ、そろそろ今夜の配信を締めていくね。';
        const recap = (() => { try { return this.blocks?.farewell?.() || []; } catch { return []; } })();
        // The night's goal (GAME_GOAL): reached or not, and if not, why, from the finished runs only (operator 2026-10-16).
        const goal = (() => { try { return this.c.gameGoal ? this.blocks?.goalResult?.(this.c.gameGoalReached ?? null) : null; } catch { return null; } })();
        const goalLines = !goal ? [] : [{ text: `今日の目標は「${this.c.gameGoal}」だったね。` },
            goal.reached ? { text: '目標、ちゃんと達成できたよ！応援してくれたみんなのおかげだね。' }
                : goal.rounds ? { text: `今夜は目標まで届かなかったんだ。${goal.rounds}回挑戦して、いちばん長くても${goal.clock}・レベル${goal.bestLevel}で倒れちゃった。` }
                    : { text: '今夜は目標まで届かなかったんだ。' },
            ...(!goal.reached && goal.rounds ? [{ text: '最後まで生き残る力がまだ足りなかったのが原因かな。次は作戦を変えて、もう一回挑戦するね。' }] : [])];
        const commented = (this.metrics?.snapshot?.().counters?.chat_received ?? 0) > 0;
        return [{ text: lead },
            ...(game ? [{ text: 'ここからは、今夜のゲームを振り返りながら締めていくね。' }] : []),
            { text: 'コメントくれたら、最後にちゃんとお返事するね。' },
            ...recap,
            ...goalLines,
            ...(this.c.drinkMode === true ? [{ text: 'NOA BEERも、今夜はこれで飲み納めかな。ぷはー！' }] : []),
            { text: commented ? 'コメントで話しかけてくれて、本当にうれしかったよ。最後まで一緒にいてくれてありがとう。' : '最後まで一緒にいてくれて、本当にありがとう。今夜もすごく楽しかったよ。' },
            { text: this.c.closingNotice || '次の配信でも、また一緒に遊ぼうね。' },
            { text: 'よかったら、チャンネル登録と高評価もしてもらえるとうれしいな。' },
            { text: 'それじゃあ今夜はここまで、おつかれさま。またね、おやすみなさい！' }];
    }
    /** The next goodbye line once its time slot has come (the lines spread over the goodbye; comments are answered between). */
    farewellUtterance() {
        const f = this.farewell, last = f.lines.length - 1;
        // A cloud voice nearly out of budget: skip to the last line so the goodbye still ends with it.
        const spend = this.cloudSpend();
        if (f.step < last && spend && spend.remaining() < CLOSING_RESERVE_USD * 2) { this.note('farewell_budget', 'skip to the last line'); f.step = last; }
        const i = Math.min(f.step, last), line = f.lines[i];
        if (Date.now() < f.startedAt + i * f.slotMs) return { utterance: 'quiet' };
        return { utterance: 'closing', template: line.text, ...(line.observation ? { observation: line.observation } : {}), closingStep: i, closingFinal: i === f.lines.length - 1 };
    }
    nextTopic() { this.director.nextTopic(); this.invalidatePreparation('next_topic'); this.event('state', this.status()); }
    addTopic(title, angles = null, jumpNow = false) {
        const card = this.director.insertTopic(title, angles, jumpNow);
        if (jumpNow) this.invalidatePreparation('next_topic');
        this.event('state', this.status());
        return card;
    }
    invalidatePreparation(reason, retry = true) {
        // A read-aloud comment and its answer form one interaction. Topic changes
        // cannot sever it after publication; stop/error cancellation still can.
        if (['next_topic', 'topic_changed', 'closing'].includes(reason) && this.preparing?.turn === this.currentTurn && this.currentTurn?.published > 0) return;
        this.generationSerial++;
        if (this.preparing) {
            this.requeueOperator(this.preparing);
            if (retry && !this.director.closing) this.blocks?.speechInterrupted?.(this.preparing.eventId);
            this.releaseCandidate(this.preparing, reason, retry);
            this.preparing.controller.abort();
            // Retain the single-flight lock until finally, even if Abort is ignored.
        }
        if (this.prepared) {
            this.requeueOperator(this.prepared);
            if (retry && !this.director.closing) this.blocks?.speechInterrupted?.(this.prepared.eventId);
            this.releaseCandidate(this.prepared, reason, retry);
            this.prepared.controller.abort(); this.prepared = null;
        }
        this.metrics.count(`preparation_cancel_${reason}`);
    }
    /** Live 2026-10-10: an operator line is taken off the queue when its preparation starts; a game event that cancelled
     * that preparation (or the line before it aired) lost the line for good (ジャジャーン twice). Put it back in front. */
    requeueOperator(job) {
        const o = job?.operatorId ? this.operatorTaken.get(job.operatorId) : null;
        if (!o || job.published > 0 || !this.running || this.director.closing) return;
        this.operatorTaken.delete(o.id);
        if (!this.operatorLines.some(x => x.id === o.id)) this.operatorLines.unshift(o);
    }
    cancelSpeech(reason) {
        this.deferredLobbySkip = null;
        if (this.currentTurn) {
            if (this.running && !this.director.closing) this.blocks?.speechInterrupted?.(this.currentTurn.eventId);
            this.releaseCandidate(this.currentTurn, reason); this.requeueOperator(this.currentTurn);
            this.currentTurn.controller.abort(); this.currentTurn = null;
        }
        if (this.metrics) this.invalidatePreparation(reason);
        super.cancelSpeech(reason);
    }
    acknowledge(data) {
        const p = this.pending, t = this.currentTurn;
        if (!p || !t) return super.acknowledge(data);
        if (!this.validLease(data.lease) || p.id !== data.id || p.epoch !== this.epoch) return false;
        if (data.event === 'ended' && !p.started) return false;
        if (data.event === 'started' && !p.started && !t.finished && t.lobbyStory && this.lobbyEnded()) {
            this.cancelSpeech('lobby_ended'); return false;
        }
        if (data.event === 'started' && !p.started && this.staleParticipation(t)) {
            this.reconcileParticipation(); return false;
        }
        if (data.event === 'started' && !p.started && p.role !== 'comment') {
            const stale = this.staleGameSpeech(t, p.text);
            if (stale) { this.retireStaleGameSpeech(t, stale); return false; }
        }
        const wasStarted = p.started;
        const ok = super.acknowledge(data);
        if (!ok) return false;
        if (data.event === 'started' && !wasStarted) {
            const now = performance.now();
            if (Number.isFinite(t.publishedMono)) this.metrics.record('publish_to_start_ms', now - t.publishedMono);
            if (this.lastEnded) this.metrics.record(this.lastEnded.turn === t ? 'mid_turn_gap_ms' : 'dead_air_ms', now - this.lastEnded.at);
        }
        if (data.event === 'ended') this.lastEnded = { turn: t, at: performance.now() };
        if (data.event === 'started' && p.role !== 'comment' && !t.responseMeasured) {
            t.responseMeasured = true;
            if (t.readEndedMono !== undefined) this.metrics.record('read_to_reply_gap_ms', performance.now() - t.readEndedMono);
            if (t.candidate) { t.candidate.replyState = 'playing'; this.metrics.count('comment_started'); }
            if (t.candidate?.receivedMono !== undefined) this.metrics.record('comment_to_answer_ms', performance.now() - t.candidate.receivedMono);
        }
        if (data.event === 'started' && p.role === 'comment' && !t.readMeasured) {
            t.readMeasured = true; this.metrics.count('comment_read_started');
            if (t.candidate?.receivedMono !== undefined) this.metrics.record('comment_to_read_ms', performance.now() - t.candidate.receivedMono);
        }
        if (data.event === 'ended') {
            if (p.role === 'comment') {
                t.readEndedMono = performance.now();
                this.metrics.count('comment_read_completed');
                const elapsedMs = Math.max(0, Date.now() - (this.startedAt || Date.now()));
                this.showLogger?.logCommentRead({
                    author: t.candidate?.author || 'viewer',
                    commentText: t.comment || t.candidate?.text,
                    readText: p.text,
                    audioMs: p.durationMs,
                    elapsedMs
                });
            }
            t.finished++; this.metrics.count('audio_parts_played');
            if (p.role !== 'comment') this.lastHostEndAt = Date.now();
            this.nextTurnAt = Date.now() + (t.finished < t.parts.length ? 60 : this.c.turnGapMs);
            if (t.finished === t.parts.length) {
                const oldRevision = this.director.revision;
                const committed = this.director.commit(t); this.currentTurn = null;
                if (this.deferredLobbySkip) {
                    const skip = this.deferredLobbySkip; this.deferredLobbySkip = null;
                    if (committed && skip.progressKey === this.director.key() && skip.sceneId === this.director.beatSpec().lobbyStory?.sceneId)
                        this.director.skipLobbyScene();
                }
                if (t.eventId) { this.markReacted(t.eventId); this.blocks?.playbackCompleted?.(t.eventId); }
                if (committed) this.recordProgress(t);
                if (t.role !== 'comment' && t.text) {
                    const elapsedMs = Math.max(0, Date.now() - (this.startedAt || Date.now()));
                    this.showLogger?.logSpeech({
                        turn: this.director.committedTurns,
                        kind: t.kind,
                        act: (this.director.round || 0) + 1,
                        actTitle: this.director.card?.title,
                        beatId: t.beatId,
                        beatLabel: t.beatLabel,
                        text: t.text,
                        role: 'host',
                        audioMs: t.totalAudioMs,
                        ttsProvider: this.c.replyTtsProvider || 'voicevox',
                        mood: t.verdict?.mood,
                        effect: t.verdict?.effect,
                        comment: t.comment,
                        verdict: t.verdict,
                        similarity: t.similarity,
                        elapsedMs,
                        affect: this.affect?.snapshot ? (({ frustration, tilt, rageActive }) => ({ frustration, tilt, rageActive }))(this.affect.snapshot()) : null
                    });
                }
                if (this.director.exhausted) this.dropQueued('programme_complete');
                if (t.ownsCandidate) {
                    t.ownsCandidate = false; t.candidate.replyState = 'completed'; this.metrics.count('comment_completed');
                }
                if (t.ownsCandidate || t.comment) {
                    if (this.game && this.game.paused && !this.director.closed) {
                        this.game.resume();
                        this.event('game', { ...this.game.observe(), paused: false });
                    }
                }
                this.metrics.count('turns_played'); this.turnFailures = 0; this.contentStalls = 0;
                if (t.utterance === 'monologue') this.blocksChatMisses = 0; // small talk works again: stop counting misses
                // Playback success must NOT reset next generation's failure count/deadline.
                if (oldRevision !== this.director.revision) this.invalidatePreparation('topic_changed');
                // The step is published: a game show's goodbye leaves the game screen once its first line has aired (src/server.mjs).
                if (t.kind === 'closing' && this.farewell && t.closingStep !== undefined) { this.farewell.step = Math.max(this.farewell.step, t.closingStep + 1); this.event('state', this.status()); }
                if (this.director.closed) this.stop(this.budgetClosingReason || 'show_completed');
            }
        }
        return ok;
    }
    recordProgress(turn) {
        const at = Math.max(0, Date.now() - (this.startedAt || Date.now()));
        const marker = { elapsedMs: at, turn: this.director.committedTurns, kind: turn.kind,
            topicId: turn.topicId || this.director.card.id, beatId: turn.beatId || null,
            label: turn.beatLabel || turn.kind, basis: 'local_playback_end_ack' };
        this.markers.push(marker); if (this.markers.length > 128) this.markers.shift();
        this.metrics.count(`programme_${turn.kind}_completed`);
        this.audit.log('programme_progress', { id: marker.topicId, choice: marker.beatId || turn.kind, count: marker.turn, ms: at });
        this.showLogger?.logProgression({ topicId: marker.topicId, beatId: marker.beatId, label: marker.label, turn: marker.turn, elapsedMs: at });
        if (turn.clipCandidate) this.audit.log('clip_candidate', { id: marker.topicId, choice: marker.beatId, ms: at, reason: 'editorial_round_boundary_not_viewer_engagement' });
    }
    /** At most one quality repair; never loop over paraphrases until one passes. */
    async generateApproved(context, signal, valid, timed, metrics) {
        if (context.kind === 'closing' && this.budgetClosingRequested && this.budgetFarewell && valid()) {
            const {text,verdict} = this.budgetFarewell;
            return {text,verdict,similarity:0,plan:null}; // Exact pre-approved recording; no paid request at exhaustion.
        }
        const recent = [...this.director.recentSpeeches, ...(this.currentTurn?.text ? [this.currentTurn.text] : [])].slice(-8);
        const commentReply = ['comment_reply', 'collab_reply'].includes(context.utterance) && !!context.comment;
        if (commentReply) {
            // A viewer answer is its own goal. The next autonomous beat is not an instruction to change the subject.
            const { angle, returningTo, demo, ...replyContext } = context;
            context = { ...replyContext, goal: context.utterance === 'collab_reply' ? COLLAB_REPLY_GOAL : COMMENT_REPLY_GOAL, allowQuestion: false };
        }
        const mode = effectiveMode(this.c), kinds = () => this.voice.clipKinds?.() ?? [];
        let reason = null, repair = null;
        // Every comment gets an answer (operator, 2026-10-06): when the gate refuses the generated reply (or a fixed comment
        // acknowledgement), a fixed thank-you (katakana hello/thanks for a foreign one) is said instead. It is judged as
        // 'fixed_ack': safety, privacy, injection and honesty as always, but not the editorial novel/progress/acknowledges
        // checks. This is a deliberate workaround for unanswered comments, not a threshold change.
        let foreignAck = context.comment && ['comment_reply', 'comment_ack'].includes(context.utterance) ? fixedAck(context.comment) : null;
        for (;;) {
        // A fixed (template) line is never rewritten by the model: if the gate rejects it, it is dropped, not repaired.
        for (let attempt = 0; attempt < (context.template ? 1 : 2); attempt++) {
            if (!valid()) return null;
            const ctx = { ...context, ...(this.blocks?.promptRule && context.observation && !context.lobby ? { gameRule: this.blocks.promptRule(context.utterance) } : {}), ...(this.affect?.speechStyle ? { affectRule: this.affect.speechStyle() } : {}), ...(attempt ? { repair: repair || { reason, instruction: commentReply ? COMMENT_REPLY_REPAIR : '直前案は繰り返しか課題未達。言い換えではなく、今回のgoalの新しい具体例か比較を一つ述べる。挨拶と完成宣言をやり直さない。' } } : {}) };
            let text;
            try { text = context.template && !attempt ? context.template : await timed('llm_ms', () => this.conversation.generate(ctx, signal)); }
            catch (e) {
                // A draft refused inside generation (e.g. it quoted a comment that may not be read aloud) still gets the
                // fixed answer: live 2026-10-15 「Coba ngomong pakai bahasa Indonesia」 was dropped unanswered this way.
                if (e?.code === 'GATE_REJECTED' && foreignAck) { reason = e.reason; break; }
                throw e;
            }
            if (!valid()) return null;
            reason = this.c.mode === 'demo' || context.roundTransition || context.utterance === 'fixed_ack' || context.utterance === 'drink' ? null : repetitionReason(text, recent, context.kind);
            if (!reason) {
                const ctxObj = { kind: context.kind, utterance: context.utterance || 'monologue', fixedLine: !!context.template && !attempt, goal: context.goal, topic: context.topic, beatId: context.beatId, lobby: context.lobby === true,
                    recentSpeech: recent, ...(context.lobbyStory ? { lobbyStory: context.lobbyStory, preparedContinuation: context.preparedContinuation || null } : {}), roundTransition: context.roundTransition || null, ...(context.utterance === 'fixed_ack' ? { comment: null } : { comment: context.comment || null, ...(context.commentTranslation ? { commentTranslation: context.commentTranslation } : {}) }), ...(context.comment ? { commentReadAllowed: context.commentReadAllowed === true } : {}), ...(context.observation ? { observation: context.observation } : {}) };
                // Delivery questions ride in the same request only in 'jev' direction; otherwise today's 4-argument call.
                const delivery = mode === 'jev' ? { chunks: this.speechDirector.prepare(text).flat.slice(0, 4), clipKinds: kinds() } : null;
                const verdict = await timed('output_judge_ms', () => delivery ? this.jev.speech(text, signal, [], ctxObj, delivery) : this.jev.speech(text, signal, [], ctxObj));
                if (!valid()) return null;
                this.note('jev_speech', `${verdict.accept ? 'PASS' : 'REJECT'} ${verdict.reason || ''} · reaction → ${verdict.reaction || '—'}${verdict.delivery?.intensity ? ` · intensity → ${verdict.delivery.intensity}` : ''}`);
                if (!verdict.accept) this.showLogger?.logRejected({ text, reason: verdict.reason, kind: context.kind, beatId: context.beatId, scores: verdict.scores });
                if (verdict.accept) {
                    const sim = recent.length ? Math.max(...recent.map(r => similarity(text, r))) : 0;
                    // Direction only ever follows approval; it may split and act the approved text, never change it.
                    const plan = mode === 'off' ? null : this.speechDirector.plan(text, verdict, { clipKinds: kinds() });
                    return { text, verdict, similarity: sim, plan };
                }
                // Never treat a safety/unknown refusal as a mere style repair.
                // A safety/uncertain refusal gets no style repair; it is a content outcome, not a provider failure.
                if (verdict.reason !== 'no_progress' && foreignAck) { reason = verdict.reason; break; }
                if (verdict.reason !== 'no_progress') throw Object.assign(new Error('Output gate rejected speech'), { code: 'GATE_REJECTED', reason: verdict.reason || 'unsafe_or_uncertain' });
                reason = 'no_progress';
                if (commentReply) {
                    // Only a safety-approved draft gets quality feedback. Keep it private to this one generation;
                    // unknown/safety refusals above cannot be turned into a style retry.
                    const failedCriteria = ['novel', 'progress'].filter(k => Number.isFinite(verdict.scores?.[k]) && verdict.scores[k] < .7)
                        .map(criterion => ({ criterion, score: verdict.scores[criterion], minimum: .7 }));
                    repair = { reason, previousDraft: text, failedCriteria, instruction: COMMENT_REPLY_REPAIR };
                }
            }
            metrics.count('content_rejected');
            this.audit.log('content_rejected', { reason, id: context.beatId, count: attempt + 1 });
            this.showLogger?.logRepair({ reason, attempt: attempt + 1, beatId: context.beatId, instruction: context.goal });
            if (!attempt) metrics.count('content_repair_attempt');
        }
        if (foreignAck) { context = { ...context, utterance: 'fixed_ack', template: foreignAck, goal: FIXED_ACK_GOAL }; foreignAck = null; repair = null; metrics.count('comment_fixed_ack'); continue; }
        throw new ContentStalledError(reason);
        }
    }
    async prepare(epoch, signal, opts = {}) {
        if ((this.control.voice !== 'ai' && !opts.resume) || this.preparing || this.prepared || this.deferredLobbySkip || !this.alive(epoch) || Date.now() < this.generationRetryAt) return;
        if (this.voice.available?.() === false) {
            // The engine circuit is open: spend nothing on the LLM or Jev, and never switch to another voice.
            this.errorCount = ++this.generationFailures; this.metrics.count('generation_failure'); this.metrics.count('voice_unavailable_skip');
            this.generationRetryAt = Math.max(Date.now() + Math.min(10000, 1000 * 2 ** this.generationFailures), this.voice.retryAt?.() || 0);
            this.event('notice', { message: '音声エンジンが応答しないため発話を保留しています。別の声へは切り替えません。' });
            if (this.generationFailures >= 4) this.providerFailure();
            return;
        }
        const t0 = performance.now();
        const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
        const serial = ++this.generationSerial, revision = this.director.revision;
        let candidate = null;
        // A resume line is the AI's own continuation: comments and the partner are answered after it, as usual.
        if (!opts.resume && (!this.director.closing || this.farewellTakesComments()) && this.director.opened) candidate = this.takeCandidate();
        // The partner leads the conversation (src/control.mjs partnerLeads): Noa's own talk waits while they are in it.
        if (!opts.resume && !candidate && this.director.opened && !this.director.closing && partnerLeads(this.control.listening) && this.collab.activeWithin(PARTNER_ACTIVE_MS)) return;
        const ctx = this.director.context(candidate, this.currentTurn);
        if (ctx.kind === 'closing' && this.cloudSpend()) {
            if (this.closingHeld) { this.releaseClosing(); this.closingHeld = null; } // this request spends the held reserve
            else if (this.closingHeld === false && this.cloudSpend().remaining() < CLOSING_RESERVE_USD) {
                this.note('closing_skipped', 'voice budget: ended without a new closing line'); this.stop('voice_budget'); return;
            }
        }
        const job = { controller, serial, epoch, kind: ctx.kind, candidate, ownsCandidate: !!candidate };
        let intermissionTimer = null, lobbyTimer = null;
        if (candidate) candidate.replyState = 'reserved';
        this.preparing = job;
        const metrics = this.metrics; // A late old-session request must not pollute new-session metrics.
        const valid = () => this.alive(epoch) && !combined.aborted && serial === this.generationSerial &&
            (!job.intermissionDeadline || (Date.now() < job.intermissionDeadline && this.blocks?.intermissionChat)) &&
            (!job.lobbyStory || !this.lobbyEnded()) &&
            (revision === this.director.revision || (job.turn === this.currentTurn && job.turn?.published > 0));
        const timed = async (name, fn) => { const start = performance.now(); try { return await fn(); } finally { const ms = performance.now() - start; metrics.record(name, ms); if (this.metrics === metrics) this.note(name.replace(/_ms$/, ''), `${Math.round(ms)} ms · ${ctx.kind}`); } };
        try {
            const hasGame = this.c.gameEnabled || this.c.programme?.gameMode === true;
            const game = hasGame && this.game ? this.game.observe() : null;
            const context = {
                ...ctx,
                ...(candidate ? { commentReadAllowed: candidate.readAllowed === true } : {}),
                ...(candidate?.translation ? { commentTranslation: candidate.translation } : {}),
                memory: this.memory.context(),
                preparedContinuation: this.currentTurn ? { notYetFullyHeard: this.currentTurn.text } : null,
                ...(game ? { game, gameSummary: this.game.situation() } : {}),
                ...(candidate?.collab ? { collab: { name: this.c.collabName || '通話相手', dialogue: this.collab.dialogue(6) } } : {}),
                ...this.utterance(ctx, candidate, game)
            };
            // The first line after a person spoke as Noa (src/control.mjs): what they said is unknown to the model.
            if (this.handoffResume) { context.humanHandoff = { minutes: Math.max(1, Math.round(this.handoffResume.heldMs / 60000)), ...(this.handoffResume.said ? { said: this.handoffResume.said } : {}) }; this.handoffResume = null; }
            else if (opts.resume) {
                // Made while the person still has the voice: what they said so far, and when (staleness check).
                const said = [...this.humanLines.said];
                context.humanHandoff = { minutes: Math.max(1, Math.round((Date.now() - (this.control.since || Date.now())) / 60000)), ...(said.length ? { said } : {}) };
                job.resume = { at: Date.now(), seq: this.humanLines.seq };
            }
            job.closingStep = context.closingStep; job.closingFinal = context.closingFinal;
            job.utterance = context.utterance; job.eventId = context.observation?.eventId ?? null; job.operatorId = context.operatorId ?? null; job.intermissionDeadline = context.intermissionDeadline ?? null;
            // Capture before the first asynchronous generation/gate/TTS step, alongside its observation.
            job.boardAt = this.blocks ? { ...blockNumbers(this.blocks) } : null;
            job.roundAt = this.blocks ? { phase: this.blocks.phase, roundId: this.blocks.round?.roundId } : null;
            job.lobbyStory = context.lobby && ctx.kind === 'autonomous' ? context.lobbyStory : null;
            if (context.utterance === 'quiet') { this.generationRetryAt = Date.now() + 1000; return; }
            const lobbyEndsAt = job.lobbyStory ? this.blocks?.status?.().lobbyEndsAt : null;
            if (Number.isFinite(lobbyEndsAt)) {
                lobbyTimer = setTimeout(() => controller.abort(Object.assign(new Error('Lobby generation deadline elapsed'), { code: 'LOBBY_EXPIRED' })), Math.max(0, lobbyEndsAt - Date.now()));
                lobbyTimer.unref?.();
            }
            if (job.intermissionDeadline) {
                if (!valid()) return;
                // Abort an optional provider request at the chat deadline so it cannot occupy the single preparation
                // slot until its much longer network timeout and delay the required restart announcement.
                intermissionTimer = setTimeout(() => {
                    metrics.count('intermission_generation_expired');
                    controller.abort(Object.assign(new Error('Optional intermission deadline elapsed'), { code: 'INTERMISSION_EXPIRED' }));
                }, Math.max(0, job.intermissionDeadline - Date.now()));
                intermissionTimer.unref?.();
            }
            if (this.canReadCandidate(candidate)) {
                await this.prepareReadReply(job, context, revision, combined, valid, timed, metrics);
                return;
            }
            const generated = await this.generateApproved(context, combined, valid, timed, metrics);
            if (!generated || !valid()) return;
            const { text, verdict, similarity: sim, plan = null } = generated;
            const parts = sentences(text);
            const counted = this.boundedSentences(text);
            if (counted > (job.lobbyStory || job.candidate ? 3 : 2) || text.length > (job.lobbyStory ? 110 : 220)) throw Object.assign(new Error('Speech exceeds turn bound'), { code: 'TURN_BOUND' });
            if (plan && plan.parts.length !== parts.length) throw planInvariant();
            // A game-event reaction is not a programme beat: its own kind keeps it from advancing the Director.
            const turn = { controller, epoch, revision, serial, text, kind: !candidate && ['game_reaction', 'game_fact', 'operator', 'drink'].includes(job.utterance) ? job.utterance : ctx.kind, utterance: job.utterance, eventId: job.eventId, operatorId: job.operatorId, intermissionDeadline: job.intermissionDeadline, comment: candidate?.text, candidate, boardAt: job.boardAt, roundAt: job.roundAt,
                progressKey: ctx.progressKey, lobbyStory: job.lobbyStory, topicId: ctx.topicId, beatId: ctx.beatId, beatLabel: ctx.beatLabel, focus: ctx.displayFocus, clipCandidate: this.director.beatSpec(ctx.topicBeat).clipCandidate === true,
                ownsCandidate: false, ...(job.closingStep !== undefined ? { closingStep: job.closingStep, closingFinal: job.closingFinal } : {}), verdict, similarity: sim, planSource: plan?.source ?? null, parts: parts.map((text, i) => ({ text, audio: null, error: null, plan: plan?.parts[i] ?? null })), finished: 0, published: 0, totalAudioMs: 0 };
            const synth = (i, sig, used) => this.synthPart(parts, plan, i, sig, used);
            // English subtitles (CAPTION_EN) translate alongside the voice and never delay the line: a part published
            // before they arrive gets them through 'speech_en'.
            if (this.c.captionEn && typeof this.conversation?.translateEn === 'function')
                this.conversation.translateEn(parts, combined).then(en => {
                    if (!en || combined.aborted || !this.alive(epoch)) return;
                    turn.en = en;
                    const p = this.pending;
                    if (p && p.epoch === epoch && p.cue?.turn === turn.serial && p.role === 'host' && !p.en && en[p.partIndex]) { p.en = en[p.partIndex]; this.event('speech_en', { id: p.id, en: p.en }); }
                }).catch(() => {});
            const first = await timed('tts_ms', () => synth(0, combined, 0));
            if (!valid()) return;
            turn.totalAudioMs += first.durationMs;
            if (turn.totalAudioMs > this.c.maxTurnAudioMs) throw new Error('Turn audio too long');
            // Part 0's clip was budgeted against an estimate of part 1; it is exempt from the later checks, so a clip
            // (kept or dropped at publication) never fails the turn mid-air.
            turn.clipMs = reactionAllowance(first, this.c);
            turn.parts[0].audio = first;
            metrics.record('first_audio_ready_ms', performance.now() - t0); voiceStats(metrics, first);
            // Gap smoothing: an all-cache part 0 may wait (≤1.5 s) for a slow part 1 instead of leaving a long mid-turn gap.
            if (plan && first.stats?.tiers?.local === 0 && parts.length > 1) {
                const now = Date.now();
                turn.holdUntil = now + Math.min(1500, Math.max(0, (this.voice.estimateSynthMs?.(parts[1]) || 0) - first.durationMs - 500)); turn.readyAt = now;
            }
            turn.ownsCandidate = job.ownsCandidate; job.ownsCandidate = false;
            if (candidate) candidate.replyState = 'prepared';
            this.prepared = turn; this.generationFailures = 0; this.generationRetryAt = 0;
            if (job.resume) turn.resume = job.resume;
            if (job.operatorId) this.event('operator', { id: job.operatorId, state: 'approved' });
            // Immediately handle failures; cancellation cannot cause an unhandled rejection.
            turn.audioTask = (async () => {
                for (let i = 1; i < parts.length; i++) {
                    if (combined.aborted || !this.alive(epoch)) return;
                    try {
                        const audio = await timed('tts_ms', () => synth(i, combined, turn.totalAudioMs - turn.clipMs));
                        if (combined.aborted || !this.alive(epoch)) return;
                        turn.totalAudioMs += audio.durationMs;
                        if (turn.totalAudioMs - turn.clipMs > this.c.maxTurnAudioMs) throw new Error('Turn audio too long');
                        turn.parts[i].audio = audio; voiceStats(metrics, audio);
                    } catch (e) { turn.parts[i].error = e; return; }
                }
            })();
        } catch (e) {
            console.error('PREPARE FAILURE:', e);
            if (!valid()) return;
            // An operator line over the turn bound fails the same way every time: refused, never put back.
            if (job.operatorId && (e.code === 'CONTENT_STALLED' || e.code === 'GATE_REJECTED' || e.code === 'TURN_BOUND')) {
                // The operator's own line was refused: say so in the Studio; it is not rewritten, retried or counted as a stall.
                this.operatorTaken.delete(job.operatorId);
                this.event('operator', { id: job.operatorId, state: 'rejected', reason: e.reason || e.code });
                this.generationRetryAt = Date.now() + 500; return;
            }
            if ((e.code === 'CONTENT_STALLED' || e.code === 'GATE_REJECTED') && this.blocks?.speechRejected?.(job.eventId, e.reason || e.code)) {
                metrics.count('round_transition_alternative');
                this.audit.log('round_transition_rejected', { id: job.eventId, reason: e.reason || e.code });
                this.generationRetryAt = Date.now() + 500; return;
            }
            if (contentRefusal(e)) {
                if (!e.handled && this.handleStall(e, job.kind, metrics, '同じ話か課題未達が続いたため自動運転を停止しました。番組の指示と会話モデルを確認してください。', job.utterance)) return;
                if (job.candidate) this.releaseCandidate(job, refusalDropReason(e), false);
                else if (job.eventId) this.markReacted(job.eventId); // An event is reacted to once, or let go: never retried.
                else if (job.lobbyStory) {
                    // A rejected speculative continuation belongs to the projected cursor, not the sentence on air.
                    if (ctx.progressKey === this.director.key()) this.director.skipLobbyScene();
                    else if (this.currentTurn && ctx.progressKey === this.director.key(this.director.projected(this.currentTurn)))
                        this.deferredLobbySkip = { progressKey: ctx.progressKey, sceneId: job.lobbyStory.sceneId };
                }
                else this.director.skipBeat();
                this.generationRetryAt = Math.max(Date.now() + 1000, this.stallHoldUntil || 0); return;
            }
            // Any other failure puts an operator line back once (finally); a second failure lets it go, so one line can never
            // hold the show (operator lines come before game lines).
            const op = job.operatorId ? this.operatorTaken.get(job.operatorId) : null;
            if (op && ++op.failures >= 2) { this.operatorTaken.delete(op.id); this.event('operator', { id: op.id, state: 'rejected', reason: 'generation_failure' }); }
            this.blocks?.speechInterrupted?.(job.eventId);
            if (e.code === 'PLAN_INVARIANT') metrics.count('speech_direction_failure');
            this.errorCount = ++this.generationFailures; metrics.count('generation_failure');
            this.generationRetryAt = Date.now() + Math.min(10000, 1000 * 2 ** this.generationFailures);
            // KEEP_LIVE holds instead of stopping; a talk beat that fails the same way again and again must not hold the
            // show for hours (live 2026-10-10: 569 failures in a row, Noa silent). Every sixth failure moves past it.
            if (this.c.keepLive && this.generationFailures % 6 === 0 && !job.candidate && !job.eventId && !job.operatorId && !this.director.closing) {
                metrics.count('stuck_beat_skipped'); this.note('stuck_beat_skipped', `${job.kind} · ${e.message}`); this.director.skipBeat();
            }
            if (!this.pending?.started) this.phase = 'holding';
            this.releaseCandidate(job, 'generation_failure');
            this.event('notice', { message: `発話を保留しました (${e.status ? 'HTTP ' + e.status : '生成・審査・音声を確認'})。未審査の代替回答は流しません。` });
            if (this.generationFailures >= 4) this.providerFailure();
        } finally {
            if (intermissionTimer) clearTimeout(intermissionTimer);
            if (lobbyTimer) clearTimeout(lobbyTimer);
            this.releaseCandidate(job, 'preparation_cancelled');
            // A preparation that ended without being prepared or refused (e.g. the programme moved on: valid() false)
            // still holds its operator line: put it back (live 2026-10-10, the NOA BEER return line was lost this way).
            if (job.operatorId && this.prepared?.operatorId !== job.operatorId && this.currentTurn?.operatorId !== job.operatorId) this.requeueOperator(job);
            if (this.preparing === job) this.preparing = null;
        }
    }
    /** Host part synthesis. With a plan the part plan rides as the third argument with a clip budget:
     * Each part reserves the remaining speech and pauses; the last part gets the exact remainder. */
    synthPart(parts, plan, i, signal, used) {
        if (this.budgetClosingRequested && parts[i] === this.budgetFarewell?.text) return Promise.resolve(this.budgetFarewell.audio);
        if (!plan) return this.voice.synthesize(parts[i], signal);
        const next = parts.slice(i + 1).reduce((ms, text, j) => ms + (this.voice.estimateAudioMs?.(text) || text.length * 170) + plannedSilenceMs(plan.parts[i + 1 + j]), 0);
        return this.voice.synthesize(parts[i], signal, { ...plan.parts[i], budgetMs: this.c.maxTurnAudioMs - used - next });
    }
    canReadCandidate(candidate) {
        // The partner's own voice is already on air: their words are never read out again.
        return !candidate?.collab && !!(this.c.readComments && this.commentVoice && candidate?.readAllowed === true &&
            typeof candidate.text === 'string' && candidate.text.length <= this.c.maxReadChars &&
            !hasPII(candidate.text) && !injection(candidate.text) && !/[<>]|https?:\/\//i.test(candidate.text));
    }
    async prepareReadReply(job, context, revision, signal, valid, timed, metrics) {
        if (this.game && !this.game.paused) {
            this.game.pause();
            this.event('game', { ...this.game.observe(), paused: true });
        }
        const { candidate, controller, epoch, serial } = job;
        const readText = `コメント。${candidate.text}`;
        const turn = { controller, epoch, revision, serial, text: '', kind: context.kind,
            utterance: job.utterance, eventId: job.eventId, boardAt: job.boardAt, roundAt: job.roundAt,
            comment: candidate.text, candidate, ownsCandidate: false, progressKey: context.progressKey, topicId: context.topicId, beatId: context.beatId, beatLabel: context.beatLabel, focus: context.displayFocus,
            verdict: { effect: 'none', mood: 'curious' }, replyReady: false,
            // Placeholder prevents a completed narration from completing the whole turn.
            parts: [{ text: readText, role: 'comment', audio: null, error: null }, { text: '', role: 'host', audio: null, error: null }],
            finished: 0, published: 0, totalAudioMs: 0 };
        job.turn = turn;
        // Both tasks have rejection handlers immediately. Text goes directly to the
        // LLM; the generated VOICEVOX audio is never fed to speech recognition.
        let settledAnswer;
        const answer = (async () => {
            const generated = await this.generateApproved({ ...context, commentReadByNarrator: true }, signal, valid, timed, metrics);
            if (!generated || !valid()) return null;
            const { text, verdict, plan = null } = generated;
            const parts = sentences(text);
            if (parts.length > 3 || text.length > 220) throw new Error('Speech exceeds turn bound');
            if (plan && plan.parts.length !== parts.length) throw planInvariant();
            // The narrator part never gets a plan; the host budget counts host audio only, as before.
            const first = await timed('tts_ms', () => this.synthPart(parts, plan, 0, signal, 0));
            if (!valid()) return null;
            if (first.durationMs > this.c.maxTurnAudioMs) throw new Error('Turn audio too long');
            voiceStats(metrics, first);
            return { text, verdict, parts, first, plan };
        })().then(value => ({ value }), error => ({ error })).then(result => { settledAnswer = result; return result; });
        try {
            const audio = await timed('comment_tts_ms', () => this.commentVoice.synthesize(readText, signal));
            if (!valid()) { await answer; return; }
            if (settledAnswer?.error) throw settledAnswer.error;
            const readParts = audio.durationMs <= this.c.maxReadAudioMs ? [{ ...turn.parts[0], audio }] : [];
            if (!readParts.length) {
                metrics.count('comment_read_skipped_duration');
                this.event('notice', { message: '読み上げが長すぎるため、コメント音声を省略して返答だけを準備します。' });
            }
            turn.parts = [...readParts, { text: '', role: 'host', audio: null, error: null }];
            turn.ownsCandidate = job.ownsCandidate; job.ownsCandidate = false;
            candidate.replyState = 'prepared'; this.prepared = turn;
            const result = await answer;
            if (!valid() || !result.value && !result.error) return;
            if (result.error) throw result.error;
            const { text, verdict, similarity: sim, parts, first, plan } = result.value;
            turn.text = text; turn.verdict = verdict; turn.similarity = sim; turn.replyReady = true; turn.totalAudioMs = first.durationMs; turn.clipMs = reactionAllowance(first, this.c); turn.planSource = plan?.source ?? null;
            turn.parts = [...readParts, ...parts.map((text, i) => ({ text, role: 'host', audio: i === 0 ? first : null, error: null, plan: plan?.parts[i] ?? null }))];
            this.generationFailures = 0; this.generationRetryAt = 0;
            turn.audioTask = (async () => {
                for (let i = 1; i < parts.length; i++) {
                    if (signal.aborted || !this.alive(epoch)) return;
                    try {
                        const next = await timed('tts_ms', () => this.synthPart(parts, plan, i, signal, turn.totalAudioMs - turn.clipMs));
                        if (signal.aborted || !this.alive(epoch)) return;
                        turn.totalAudioMs += next.durationMs;
                        if (turn.totalAudioMs - turn.clipMs > this.c.maxTurnAudioMs) throw new Error('Turn audio too long');
                        turn.parts[i + readParts.length].audio = next; voiceStats(metrics, next);
                    } catch (error) { turn.parts[i + readParts.length].error = error; return; }
                }
            })();
        } catch (error) {
            // Keep the generation single-flight until a provider ignoring Abort settles.
            await answer;
            if (!valid()) return;
            if ((error.code === 'CONTENT_STALLED' || error.code === 'GATE_REJECTED') && this.handleStall(error, 'reply', metrics, '返答の内容が進まないため自動運転を停止しました。', job.utterance)) return;
            if (turn.published > 0) {
                // Let approved narration finish, then the ordinary audio-failure path
                // retires the interaction. Never replay its comment on a retry.
                turn.parts[1].error = error; metrics.count('reply_after_read_failure');
                return;
            }
            if (this.prepared === turn) this.prepared = null;
            this.releaseCandidate(turn, contentRefusal(error) ? refusalDropReason(error) : 'preparation_failure', !contentRefusal(error));
            throw error;
        }
    }
    startPrefetch(epoch, signal, opts = {}) {
        if (this.memoryHold || this.preparing || this.prepared || Date.now() < this.generationRetryAt || this.director.atBoundary(this.currentTurn)) return;
        // A timed handoff must not skip lobby beats underneath a still-playing turn.
        if (this.currentTurn?.lobbyStory && this.lobbyEnded()) return;
        const task = this.prepare(epoch, signal, opts);
        this.preparationTask = task;
        // Never await speculative generation from the audio send loop.
        void task.catch(e => {
            if (this.alive(epoch)) this.audit.log('preparation_error', { reason: e.name });
        }).finally(() => { if (this.preparationTask === task) this.preparationTask = null; });
    }
    lobbyEnded() { return this.blocks?.phase !== 'lobby' || !!this.blocks?.leadIn; }
    async speakStep(epoch, signal) {
        if (this.control.voice !== 'ai') return this.humanStep(epoch, signal); // a person (or nobody) has the voice: only their lines (resynth) air
        if (!this.alive(epoch) || !this.renderer || !this.validLease(this.renderer.lease)) return;
        // Turn taking: no new line starts while the voice-call partner speaks or has just stopped (src/collab.mjs).
        if (!this.pending && !this.currentTurn && hearsPartner(this.control.listening) && this.collab.holdsFloor()) return;
        if (this.memoryHold && !this.pending && !this.currentTurn) return; // memory hold: the line on air finishes, no new one starts
        if (this.standby) return this.standbyStep(epoch, signal);
        if (this.reconcileParticipation()) return;
        if (this.lobbyEnded()) {
            if (this.pending && !this.pending.started && !this.currentTurn?.finished && this.currentTurn?.lobbyStory) {
                this.cancelSpeech('lobby_ended'); return;
            }
            if (this.preparing?.lobbyStory || this.prepared?.lobbyStory) this.invalidatePreparation('lobby_ended', false);
        }
        if (this.pending) {
            if (!this.pending.started && this.pending.role !== 'comment') {
                const stale = this.staleGameSpeech(this.currentTurn, this.pending.text);
                if (stale) { this.retireStaleGameSpeech(this.currentTurn, stale); return; }
            }
            if (this.pending.started && this.pending.role !== 'comment' && this.currentTurn?.replyReady !== false && this.currentTurn?.kind !== 'closing' && !this.director.closing) this.startPrefetch(epoch, signal);
            return;
        }
        if (Date.now() < this.nextTurnAt) return;
        if (!this.currentTurn) {
            // No current audio can be blocked here. If a speculative job is already
            // in flight, prepare() returns without waiting on it.
            if (!this.prepared) {
                if (this.director.opened && this.canReadCandidate(this.candidates[0])) this.startPrefetch(epoch, signal);
                else await this.prepare(epoch, signal);
            }
            if (!this.alive(epoch) || !this.prepared) return;
            const cursorStale = this.prepared.progressKey && this.prepared.progressKey !== this.director.key();
            const staleOpening = this.prepared.kind === 'opening' && this.director.opened;
            const stale = cursorStale || staleOpening || this.prepared.epoch !== epoch || this.prepared.revision !== this.director.revision || this.prepared.controller.signal.aborted;
            if (stale) { this.invalidatePreparation('stale'); return; }
            const reason = this.candidateInvalidReason(this.prepared.candidate);
            if (reason) { this.invalidatePreparation(reason, false); return; }
            this.currentTurn = this.prepared; this.prepared = null;
        }
        const turn = this.currentTurn, part = turn.parts[turn.published];
        if (!part) return;
        if (part.error) {
            if (contentRefusal(part.error)) {
                this.cancelSpeech(refusalDropReason(part.error));
                this.generationRetryAt = Math.max(this.generationRetryAt, Date.now() + 1000);
                return;
            }
            this.cancelSpeech('tts_failure'); this.errorCount = ++this.turnFailures; this.metrics.count('audio_part_failure'); this.phase = 'holding';
            this.generationRetryAt = Math.max(this.generationRetryAt, Date.now() + Math.min(10000, 1000 * 2 ** this.turnFailures));
            this.event('notice', { message: '音声の続きを作れなかったため保留しました。音声接続を確認してください。' });
            if (this.turnFailures >= 4) this.providerFailure();
            return;
        }
        // Narrator publication does not count as the host answering. Recheck each host sentence at its own boundary,
        // including a reply still waiting on a provider, but let audio that has already started finish naturally.
        // Keep total `published` for ownership and TTL; freshness cannot cause a comment to be read a second time.
        if (turn.published === 0 || part.role !== 'comment') {
            const stale = this.staleGameSpeech(turn, part.role === 'comment' ? turn.text : part.text);
            if (stale) { this.retireStaleGameSpeech(turn, stale); return; }
        }
        if (!part.audio) { this.phase = 'preparing_audio'; return; }
        if (turn.published === 0 && turn.holdUntil > Date.now() && turn.parts[1] && !turn.parts[1].audio && !turn.parts[1].error) { this.phase = 'preparing_audio'; return; }
        if (!this.alive(epoch) || turn.controller.signal.aborted || !this.validLease(this.renderer?.lease)) return;
        if (turn.published === 0 && turn.lobbyStory && (this.blocks?.phase !== 'lobby' || this.blocks?.leadIn)) {
            this.cancelSpeech('lobby_ended'); return;
        }
        // A prepared optional break line may expire while waiting for playback. Never interrupt an utterance that
        // already started, a required review/resume line, or a viewer interaction to enforce the break's chat window.
        if (turn.published === 0 && turn.intermissionDeadline && (Date.now() >= turn.intermissionDeadline || !this.blocks?.intermissionChat)) {
            this.metrics.count('intermission_chat_expired'); turn.controller.abort(); this.currentTurn = null; return;
        }
        // A line about a live game event airs only while it is still true (a danger line after recovery is not).
        if (this.staleParticipation(turn)) {
            this.metrics.count('participation_speech_cancelled'); this.cancelSpeech('participation_unavailable'); return;
        }
        if (turn.published === 0 && this.candidateInvalidReason(turn.candidate)) {
            this.releaseCandidate(turn, this.candidateInvalidReason(turn.candidate), false);
            turn.controller.abort(); this.currentTurn = null; return;
        }
        const { text } = part, id = randomUUID();
        const role = part.role || 'host';
        const effect = this.acting(role, role === 'comment' ? { effect: 'none', mood: 'curious' } : this.effects.take(part.plan ? { ...turn.verdict, reaction: part.plan.head, delivery: { intensity: part.plan.intensity } } : turn.verdict));
        // The post-cooldown reaction decides whether the planned wordless clip stays; the narrator is never finalized.
        let voice = part.audio;
        if (role === 'host' && typeof voice.finalize === 'function') {
            try { voice = voice.finalize({ reaction: effect.reaction, intensity: effect.intensity }); }
            catch { this.metrics.count('bus_finalize_error'); voice = { kind: part.audio.kind, bytes: part.audio.bytes, durationMs: part.audio.durationMs }; }
            if (part.audio.stats?.clip) this.metrics.count(voice.clip ? 'reaction_clip_used' : 'reaction_clip_dropped');
        }
        if (turn.published === 0 && turn.holdUntil !== undefined) this.metrics.record('first_part_hold_ms', Date.now() - turn.readyAt);
        if (voice.bytes) this.audio.set(id, voice.bytes);
        if (voice.stream) {
            this.streams.set(id, voice.stream);
            // The part was published on its first chunk with an estimated length; the real length replaces it when known.
            const streamMetrics = this.metrics;
            void voice.stream.finished.then(st => {
                streamMetrics.count('tts_generated_cloud_ms', Math.round(st.durationMs || 0)); // generated even if cancelled or stale
                if (this.pending?.id !== id) return;
                if (st.error && !st.bytes) return;
                this.pending.durationMs = st.durationMs;
                if (this.pending.started) this.pending.deadline = Math.max(this.pending.deadline, Date.now() + st.durationMs + 6000);
                this.metrics.record('tts_stream_total_ms', performance.now() - st.createdAt);
                if (st.error) this.metrics.count('tts_stream_truncated');
            });
        }
        // What this line is (a game reaction, a comment reply…) so the stage can decide whether an effect is warranted.
        const cue = { utterance: turn.utterance || turn.kind, eventId: turn.eventId || null, turn: turn.serial, part: turn.published, epoch };
        this.pending = { id, epoch, text, role, cue, story: { label: turn.beatLabel || turn.kind, focus: turn.focus || '' }, ...effect, partIndex: turn.published++, kind: voice.kind, durationMs: voice.durationMs, started: false,
            deadline: Date.now() + 8000, sources: [], comment: turn.candidate?.readAllowed === true ? turn.candidate.text : null,
            ...(effect.intensity ? { intensity: effect.intensity } : {}), ...(Number.isFinite(voice.leadMs) ? { leadMs: voice.leadMs } : {}),
            ...(voice.beats?.length ? { beats: voice.beats } : {}), ...(voice.mouth?.length ? { mouth: voice.mouth } : {}),
            ...(role === 'host' && voice.lipSync ? { lipSync: voice.lipSync } : {}) };
        if (role === 'host' && turn.en?.[this.pending.partIndex]) this.pending.en = turn.en[this.pending.partIndex];
        turn.publishedMono = performance.now();
        if (turn.candidate) turn.candidate.replyState = 'published';
        if (role === 'host') { this.recent.push(turn.text); this.recent = this.recent.slice(-4); }
        this.phase = 'ready';
        const n = this.pending.partIndex + 1, stats = part.audio.stats;
        this.note('publish', `${role === 'comment' ? 'narrator' : 'host'} part ${n} · ${effect.reaction}`);
        if (stats) {
            // Operator-only: the Studio DELIVERY card and trace. Never part of pending or the 'speech' event.
            this.note('voice_tier', `part ${n} · ${stats.engine} · cache ${stats.tiers?.cache ?? 0}/local ${stats.tiers?.local ?? 0} · clip ${voice.clip || '—'}`);
            this.lastDelivery = { at: Date.now(), part: n, reaction: effect.reaction, intensity: effect.intensity || null, source: part.plan ? turn.planSource ?? null : null,
                chunks: (part.plan?.chunks || []).map(c => ({ chars: c.text.length, reaction: c.reaction, pace: c.pace, ending: c.ending })),
                engine: stats.engine, tiers: stats.tiers, clip: voice.clip || null, leadMs: voice.leadMs ?? null };
        }
        this.event('speech', { ...this.pending, audio: voice.kind === 'wav' ? `/audio/${id}.wav` : voice.kind === 'stream' ? `/audio/${id}.pcm` : null });
    }
    /** Memory hold (KEEP_LIVE): the broadcast stays up; the line on air finishes, nothing new is prepared or started,
     * and the game pauses. Releasing resumes from where the show was (nothing unreviewed airs either way). */
    setMemoryHold(on, reason = 'memory_pressure') {
        if (!!this.memoryHold === !!on) return;
        this.memoryHold = !!on;
        if (on) {
            this.invalidatePreparation(reason, false);
            if (this.game && !this.game.paused) { this.game.pause(); this.memoryPausedGame = true; this.event('game', { ...this.game.observe(), paused: true }); }
        } else if (this.memoryPausedGame) {
            this.memoryPausedGame = false;
            if (this.game?.paused) { this.game.resume(); this.event('game', { ...this.game.observe(), paused: false }); }
        }
        this.note(on ? 'memory_hold' : 'memory_resume', reason);
        this.event('memory_hold', { held: this.memoryHold, reason });
    }
    /** Sentences a turn's bound counts (DRINK_MODE: a standalone ヒック／ぷはー does not count). */
    boundedSentences(text) {
        const parts = sentences(text);
        return this.c.drinkMode === true ? parts.filter(x => !INTERJECTION.test(x.trim())).length : parts.length;
    }
    stop(reason = 'operator') {
        this.memoryHold = false; this.memoryPausedGame = false;
        this.blocks?.setParticipationEnabled?.(false);
        if (this.game) this.game.pause();
        this.gameFeed?.stop(); this.gameFeed = null; clearTimeout(this.gameActionsTimer); this.gameActionsTimer = null;
        this.releaseClosing(); this.closingHeld = null;
        this.recordParticipation(true);
        // Saved per broadcast: the counters (incl. generated/cached audio ms) and this show's estimated cloud voice spend.
        this.showLogger?.stopSession({ reason, stats: { ...this.status()?.stats, metrics: this.metrics?.snapshot?.().counters ?? null, participation: this.participation.snapshot(), cloudSpend: this.voice?.router?.spend?.sessionSnapshot?.() ?? null } });
        this.invalidatePreparation(reason, false); this.dropQueued(reason);
        // Base stop marks the session stopped before cancelSpeech releases current ownership.
        super.stop(reason);
    }
}
