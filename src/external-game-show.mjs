import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// The show flow every game played outside the studio shares (docs/GAMES.md): opening talk (lobby) → lead-in line →
// game start announcement → runs (one run of the controller's log = one round) → results → next run. A game's own
// show module extends this and supplies only what is particular to it: how an observed state becomes events
// (ingest), the spoken lines for those events, commentary, answers to viewers and the closing.
// Same duck-typed surface as BlocksShow, so TalkEngine's gate, stale-line checks and faces apply unchanged. Every number
// spoken about the game comes from the controller's observations, as templates, never from the model.

export const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
/** Spoken duration of game seconds: 「2分5秒」, 「45秒」. */
export const clock = sec => { const s = Math.max(0, Math.floor(sec)); return s >= 60 ? `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ''}` : `${s}秒`; };

export class ExternalGameShow {
    /**
     * game: { title, what, statusKey, startLine, waitLine, leadInLines, policy, lines, recordsFile, repeatMs }
     *   policy[type]() → { priority, ttlMs, face, speak }; lines[type] → templates filled from the event's facts.
     *   startLine / waitLine / leadInLines: two sentences at most each (a turn's limit), checked with the real gate.
     */
    constructor(game, show = {}, { dataDir = null, now = Date.now, emit = () => { }, name = 'ノア', viewerVotes = false } = {}) {
        this.game = { repeatMs: 8000, leadInLines: ['ではそろそろ、ゲームを始めようかな。'], ...game };
        // lobbyMinutes: talk first (Noa centre stage, no game) until the operator starts the game, or this long at most (0: no lobby).
        // leadInMs: after the lead-in line is taken for speech, wait this long (it is being said) before the game screen opens;
        // leadInMaxMs: open it anyway if the line never aired (e.g. refused by the gate).
        this.cfg = { resultsMs: 12000, maxRounds: 99, quietMs: 3500, lobbyMinutes: 15, leadInMs: 6000, leadInMaxMs: 20000, ...show };
        Object.assign(this, { dataDir, now, emit, host: name }); // host: the character's name (config/character.json), for prompt rules
        this.viewerVotes = viewerVotes === true; // viewers can vote in the game itself (its Twitch integration): say how
        this.path = dataDir && this.game.recordsFile ? join(dataDir, this.game.recordsFile) : null;
        this.records = this.path && existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
        this.reset();
    }
    get title() { return this.game.title; }
    get what() { return this.game.what; }
    get statusKey() { return this.game.statusKey; }
    /** Commentary is spoken as written (each line checked with the real gate); model rewrites repeated filler. */
    get fixedCommentary() { return true; }
    reset() {
        this.phase = this.cfg.lobbyMinutes > 0 ? 'lobby' : 'idle'; this.lobbyStartedAt = null; this.leadIn = null; this.roundNo = 0; this.round = null; this.snapshot = null; this.events = []; this.spoken = new Set(); this.recent = [];
        this.announcements = []; this.lastResult = null; this.saidAt = {}; this.closedReason = null; this.said = new Set(); this.recentLines = [];
        this.lastCommentary = null; this.eventSerial = 0; this.seen = new Set();
        this.resetGame();
    }
    /** Per-game state for a new show (override). */
    resetGame() { }
    report() { this.emit(this.statusKey, this.status()); }
    start() { this.reset(); this.lobbyStartedAt = this.now(); this.report(); }
    /** End the opening talk (the operator's button, or the lobby time limit): first a lead-in line on the talk screen;
     * the game screen opens and the game is announced once that line has been said (tick). */
    startGame(reason = 'operator') {
        if (this.phase !== 'lobby' || this.leadIn) return false;
        this.leadIn = { at: this.now(), takenAt: null, reason };
        const lines = this.game.leadInLines;
        this.announce('intro-game-lead', lines[Math.floor((this.lobbyStartedAt ?? 0) / 1000) % lines.length], 0,
            `雑談の時間を終えて、これから${this.game.title}を始める`, { startsGame: true, startedBy: reason });
        this.report();
        return true;
    }
    /** The game screen opens: the game is announced (the server starts the controller on this phase change). */
    beginGame() {
        const reason = this.leadIn?.reason ?? 'operator', { title, what } = this.game;
        this.phase = 'idle'; this.gameStartedBy = reason; this.leadIn = null;
        this.announce('intro-game-start', this.game.startLine, 0, `雑談を終えて、これから「${title}」のプレイを始める。${what}`, { game: title, startedBy: reason });
        // A game takes a while to launch and reach play: say so instead of going quiet.
        if (this.game.waitLine) this.announce('intro-game-wait', this.game.waitLine, 6000, `${title}のプレイを始めるため、いまゲームを起動している`, { game: title, starting: true });
        this.report();
    }
    announce(id, text, delayMs = 0, event = null, facts = null) { this.announcements.push({ id, text, at: this.now(), notBefore: this.now() + delayMs, event, facts }); }
    /** A new run: the round's own fields come from newRound (override). */
    begin(runId) {
        this.roundNo++;
        this.round = { no: this.roundNo, roundId: runId, endsAt: null, best: null, ...this.newRound(runId) };
        this.phase = 'playing'; this.snapshot = null; this.events = []; this.recent = []; this.lastCommentary = null;
        this.beginRound(runId);
        this.report();
    }
    newRound() { return {}; }
    beginRound() { }
    /** Checks shared by every game before its own ingest: returns a refusal, or null to go on (a new run begins here). */
    admit(runId, state) {
        if (typeof runId !== 'string' || !runId || !state || typeof state !== 'object') return { accepted: false, reason: 'invalid' };
        if (this.phase === 'done') return { accepted: false, reason: 'done' };
        if (this.phase === 'lobby') return { accepted: false, reason: 'lobby' }; // no game yet: the opening talk
        if (this.round?.roundId !== runId) {
            if (this.seen.has(runId)) return { accepted: false, reason: 'stale_round' };
            this.seen.add(runId);
            if (this.phase === 'playing') this.finish('stopped');
            this.begin(runId);
        } else if (this.phase !== 'playing' && !this.reopen(runId, state)) return { accepted: false, reason: 'round_over' };
        return null;
    }
    /** Queue an event of the game's policy; returns its face for the instant reflex. */
    push(type, facts, gameSeconds = null) {
        const id = `${this.round?.roundId}:${type}:${++this.eventSerial}`, p = this.game.policy[type]();
        this.events.push({ id, type, facts, ...p, at: this.now() });
        this.recent.push({ type, gameSeconds, facts }); if (this.recent.length > 3) this.recent.shift();
        return p.face;
    }
    /** Is a line about this event still true right now? (override stillTrue for a game's own conditions). */
    stillValid(eventId) {
        if (/^(intro|result|recap)-/.test(String(eventId))) return true;
        const e = this.events.find(x => x.id === eventId);
        if (!e || this.now() - e.at > e.ttlMs) return false;
        return this.stillTrue(e);
    }
    stillTrue() { return true; }
    /** The templates for an event (override for lines that depend on the facts). */
    linesFor(e) { return this.game.lines[e.type]; }
    /** What the gate is told happened, when the line alone does not say it (override). */
    eventText() { return undefined; }
    /** Kinds that are new information every time (never dropped as an echo of the same kind). */
    alwaysNew() { return false; }
    takeLine() {
        if (this.announcements[0] && this.announcements[0].notBefore <= this.now()) { const a = this.announcements.shift(); if (a.id === 'intro-game-lead' && this.leadIn) this.leadIn.takenAt = this.now(); return { eventId: a.id, text: a.text, kind: 'game_fact', eventText: a.event, facts: a.facts }; }
        if (this.announcements.length) return null;
        // A second reaction of a kind within repeatMs reads as an echo.
        for (const e of this.events) if (e.speak && !this.alwaysNew(e) && !this.spoken.has(e.id) && this.now() - (this.saidAt[e.type] ?? -Infinity) < this.game.repeatMs) this.spoken.add(e.id);
        const e = this.events.filter(e => e.speak && !this.spoken.has(e.id) && this.stillValid(e.id)).sort((x, y) => y.priority - x.priority || y.at - x.at)[0];
        if (!e) return null;
        this.spoken.add(e.id); this.saidAt[e.type] = this.now();
        for (const x of this.events) if (x !== e && x.priority <= e.priority) this.spoken.add(x.id); // older, lesser events are superseded
        const pool = this.linesFor(e), start = this.spoken.size % pool.length;
        const text = [...pool.slice(start), ...pool.slice(0, start)].map(t => fill(t, e.facts)).find(t => !this.recentLines.includes(t));
        if (!text) return null;
        this.recentLines.push(text); if (this.recentLines.length > 6) this.recentLines.shift();
        const eventText = this.eventText(e);
        return { eventId: e.id, text, kind: 'game_reaction', event: e, ...(eventText ? { eventText } : {}) };
    }
    markSpoken(id) { this.spoken.add(id); }
    /** Something new and true about the run right now, or null (override; then Noa plays quietly). */
    commentary() { return null; }
    markCommentary(c) { this.said.add(c.id); this.saidAt[`c:${c.kind}`] = this.now(); this.lastCommentary = { at: this.now() }; }
    /** End the current run: results hold for resultsMs (the game's own finish sets lastResult and announces it). */
    finish(reason) {
        if (this.phase !== 'playing') return;
        this.phase = 'results';
        this.finishRound(reason);
        this.round.resultsUntil = this.now() + this.cfg.resultsMs;
        this.events = [];
        this.report();
    }
    finishRound() { }
    /** A game where the same run can go on after its game over (see VampireShow) reopens the round here. */
    reopen() { return false; }
    save() { if (!this.path) return; mkdirSync(this.dataDir, { recursive: true }); writeFileSync(`${this.path}.tmp`, JSON.stringify(this.records)); renameSync(`${this.path}.tmp`, this.path); }
    chooseSpeed() { return null; }
    answer() { return null; }
    closing() { return null; }
    /** Results hold for resultsMs, then the show waits for the next run (the controller restarts the game). */
    tick() {
        if (this.phase === 'lobby' && !this.leadIn && this.cfg.lobbyMinutes > 0 && this.lobbyStartedAt !== null && this.now() - this.lobbyStartedAt >= this.cfg.lobbyMinutes * 60000) this.startGame('timer');
        if (this.phase === 'lobby' && this.leadIn && ((this.leadIn.takenAt !== null && this.now() - this.leadIn.takenAt >= this.cfg.leadInMs) || this.now() - this.leadIn.at >= this.cfg.leadInMaxMs)) this.beginGame();
        if (this.phase === 'results' && this.now() >= this.round.resultsUntil) { this.phase = 'between'; this.report(); }
    }
    /** Numbers a spoken line may quote; a line is stale once one of them has changed (override). */
    numbers() { return {}; }
    observation() { return { game: this.title, what: this.what, phase: this.phase, run: this.roundNo }; }
    /** Who has the game's controls at runtime (src/game-runner.mjs player, Phase 5): 'ai' or 'human'. */
    setRuntimePlayer(player) { this.runtimePlayer = player === 'human' ? 'human' : 'ai'; }
    /** How the host speaks about the play: as the player when the AI plays, as a commentator while a person plays. */
    playerVoice() {
        return this.runtimePlayer === 'human'
            ? `今は中の人（人間）がゲームを操作していて、${this.host}は画面を見ながら実況している。自分が操作しているとは言わない。`
            : `${this.host}が操作しているプレイヤーとして一人称で話す。`;
    }
    /** What the model is told about this game when it writes a line (providers adds it to the system prompt). */
    promptRule(utterance) {
        return `遊んでいるゲーム：「${this.title}」（${this.what}）。${this.playerVoice()}項目名や英語の内部名をそのまま読まない。${utterance === 'game_commentary'
            ? 'observation.point の事実を、配信者のつぶやきとして自然に言い直す（10〜30字）。数字は多くても1つ。observation に無いことは言わない。'
            : utterance === 'comment_reply' ? 'コメントへの返事では、相手の言葉に一言で応える。攻略の助言・ゲームの数字や状況の説明は入れない。'
            : '今回はゲーム実況ではなく goal の話題を話す番。ゲームの数字や状況には触れない。'}`;
    }
    /** Viewer-safe status for the stage and Studio: { title, phase, run, personalBest, ... } (extend with statusExtra). */
    status() {
        const r = this.round;
        return { title: this.title, phase: this.phase, run: this.roundNo, gameStarting: this.phase === 'lobby' && !!this.leadIn, lobbyEndsAt: this.phase === 'lobby' && !this.leadIn && this.lobbyStartedAt !== null && this.cfg.lobbyMinutes > 0 ? this.lobbyStartedAt + this.cfg.lobbyMinutes * 60000 : null, roundId: r?.roundId ?? null,
            personalBest: r?.best ?? null, recent: [...this.recent], lastResult: this.lastResult, ...this.statusExtra(),
            // A person at the controls is never shown as the AI playing (the stage says AIが実況中).
            ...(this.runtimePlayer === 'human' ? { player: 'operator', playedBy: 'person' } : {}) };
    }
    statusExtra() { return {}; }
}
