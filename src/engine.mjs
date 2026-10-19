import { effectiveGameLayout } from '../public/stage-theme.mjs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { clean, hash, hasPII, injection, safetyText, sleep } from './util.mjs';
import { Memory } from './store.mjs';
import { Effects, noul } from './jev.mjs';
import { StarGarden } from './game.mjs';
import { AffectEngine } from './affect-engine.mjs';
import { describeReaction, reactionFor, commentReflex } from '../public/avatar-rig.mjs';
import { INTENSITY_GAIN } from '../public/voice-acting.mjs';
import { ParticipationMetrics } from './participation-metrics.mjs';
import { initialControl, takesComments } from './control.mjs';
export class Engine extends EventEmitter {
    constructor(c, { jev, conversation, voice, research, ledger, audit, youtube, twitch }) {
        super();
        Object.assign(this, { c, jev, conversation, voice, research, ledger, audit, youtube, twitch });
        this.running = false;
        this.panic = false;
        this.epoch = 0;
        this.phase = 'stopped';
        this.renderer = null;
        this.pending = null;
        this.audio = new Map();
        this.streams = new Map(); // Streaming parts (PcmStream) by pending id, served at /audio/<id>.pcm
        this.intake = [];
        this.candidates = [];
        this.researchQueue = [];
        this.researchStatus = 'idle';
        this.seen = new Map();
        this.authors = new Map();
        this.commentArrivals = [];
        this.memory = new Memory(c.character.memoryPins);
        this.effects = new Effects();
        this.game = new StarGarden();
        this.nextTurnAt = 0;
        this.turn = 0;
        this.errorCount = 0;
        this.lastAudioOK = false;
        this.twitchStatus = c.twitchEnabled ? 'not_connected' : 'not_configured';
        this.youtubeStatus = c.youtubeVideo ? 'not_connected' : 'not_configured';
        this.stats = { accepted: 0, dropped: 0, spoken: 0, research: 0 };
        this.recent = [];
        this.recentComments = [];
        this.controller = null;
        this.workers = [];
        this.affect = new AffectEngine();
        this.lastReaction = null;
        this.trace = [];
        this.lastMove = null;
        this.participation = new ParticipationMetrics({ mode: c.mode });
        this.pendingParticipation = null;
        this.lastParticipationLogAt = 0;
        this.control = initialControl(); // who speaks as Noa, whether she reacts to comments (src/control.mjs)
        this.humanActiveAt = 0; // when the person speaking as Noa was last heard (resume preparation waits for a pause)
    }
    event(type, data = {}) { this.emit('event', { type, data, at: Date.now() }); }
    /** A stream nobody will play stops generating (and billing) at once. */
    dropStream(id) { const st = this.streams.get(id); if (st) { this.streams.delete(id); if (!st.done) st.cancel?.(); } }
    clearStreams() { for (const id of [...this.streams.keys()]) this.dropStream(id); }
    /** The idle puzzle is played by a shortest-path rule unless the operator opts into Jev moves (one paid call per move). */
    jevPlaysGame() { return this.c.mode !== 'demo' && this.c.gameController === 'jev' && typeof this.jev.game === 'function'; }
    /** Operator-only timeline for the Studio monitor. Never sent to the stage stream. */
    note(kind, detail = '') {
        this.trace.push({ at: Date.now(), kind, detail: String(detail).slice(0, 140) });
        if (this.trace.length > 120) this.trace.shift();
    }
    /** Instant wordless avatar reflex (no audio, no words, so outside the speech gate). The stage plays it only while
     * nobody is speaking, so it bridges the LLM/Jev/TTS wait instead of overriding approved acting. */
    reflex(reaction, source, now = Date.now()) {
        if (!['listen', 'excited', 'happy', 'surprised', 'troubled', 'thinking', 'embarrassed'].includes(reaction) || now - (this.lastReflexAt || 0) < 1500) return false;
        this.lastReflexAt = now; this.note('reflex', `${source} → ${reaction}`);
        this.event('reflex', { reaction, source });
        return true;
    }
    /** Local acting choice for a published part; Jev chose only the preset name. */
    acting(role, verdictEffect) {
        const reaction = role === 'comment' ? 'listen' : (verdictEffect.reaction || reactionFor({ mood: verdictEffect.mood }));
        return { ...verdictEffect, reaction };
    }
    /** The room game layout this show airs in: the game's own (games/<id>/game.json stage.layout), else the setting. */
    gameLayout() { return effectiveGameLayout(this.c.roomGameLayout, this.c.game); }
    status() { return { mode: this.c.mode, control: { ...this.control, humanVoiceMode: this.c.humanVoiceMode || 'passthrough' }, streamTarget: this.c.streamTarget || '', running: this.running, panic: this.panic, phase: this.phase, epoch: this.epoch, turn: this.turn, name: this.c.character.name, channel: this.c.character.channel, tagline: this.c.character.tagline, game: (this.c.gameEnabled || this.c.programme?.gameMode === true) ? this.game.observe() : null, renderer: !!this.renderer && this.renderer.until > Date.now(), pending: this.pending ? { id: this.pending.id, text: this.pending.text, started: this.pending.started, effect: this.pending.effect, mood: this.pending.mood, reaction: this.pending.reaction || 'neutral', sources: this.pending.sources, role: this.pending.role || 'host', story: this.pending.story || null, ...(this.pending.en ? { en: this.pending.en } : {}) } : null, queue: this.intake.length + this.candidates.length, research: this.researchStatus, youtube: this.youtubeStatus, twitch: this.twitchStatus, stats: { ...this.stats }, participation: this.participation.snapshot(), jevMs: this.jev.lastMs, usage: this.ledger.snapshot(), remainingMs: this.running ? Math.max(0, this.endAt - Date.now()) : 0, hasPlayedLiveAudio: this.lastAudioOK, ...(this.c.stageTheme === 'room' ? { stageTheme: 'room', ...(this.gameLayout() !== 'side' ? { roomGameLayout: this.gameLayout() } : {}), ...(this.gameLayout() === 'frame' ? { banner: { hashtag: this.c.stageHashtag || '', social: this.c.stageSocial || '', tagline: this.c.stageTagline || '' } } : {}) } : {}), ...(this.c.drinkMode === true ? { drinkMode: true } : {}) }; }
    recordParticipation(force = false) {
        const now = Date.now();
        if (!this.showLogger?.currentSessionId || (!force && now - this.lastParticipationLogAt < 30000)) return;
        this.showLogger.logParticipation(this.participation.snapshot());
        this.lastParticipationLogAt = now;
    }
    queueView() {
        const now = Date.now(), view = (m, state) => ({ id: m.id, text: m.text, state, source: m.source, ageMs: Math.max(0, now - m.created), readAllowed: m.readAllowed === true });
        return [...this.candidates.map(m => view(m, m.replyState || 'selected')), ...this.researchQueue.map(m => view(m, 'research')), ...this.intake.map(m => view(m, 'judging'))];
    }
    /** Admin-only snapshot for the Studio monitor (comment texts, timings, acting state). */
    operatorView() {
        const now = Date.now(), gameOn = !!(this.c.gameEnabled || this.c.programme?.gameMode === true);
        const latency = this.metrics?.snapshot().latency || {};
        const pick = k => latency[k] ? { last: latency[k].last, p50: latency[k].p50, p95: latency[k].p95 } : null;
        let nextMove = null;
        if (gameOn && !this.game.paused && !this.jevPlaysGame()) nextMove = this.game.demoMove();
        return {
            live: { running: this.running, panic: this.panic, phase: this.phase, mode: this.c.mode, elapsedMs: this.running ? now - this.startedAt : 0, remainingMs: this.running ? Math.max(0, this.endAt - now) : 0 },
            affect: this.affect.snapshot(now),
            reaction: this.lastReaction,
            speaking: this.pending ? { role: this.pending.role || 'host', started: this.pending.started, reaction: this.pending.reaction || 'neutral', text: this.pending.text } : null,
            queue: this.queueView().slice(0, 12),
            game: gameOn ? { ...this.game.observe(), controller: this.jevPlaysGame() ? 'jev' : 'rule', lastMove: this.lastMove, nextMove } : null,
            performance: { jevChatMs: this.jev.lastMs ?? null, jevSpeech: pick('output_judge_ms'), llm: pick('llm_ms'), tts: pick('tts_ms'), commentTts: pick('comment_tts_ms'), commentToRead: pick('comment_to_read_ms'), commentToAnswer: pick('comment_to_answer_ms'),
                // Latency breakdown: model → gate → first TTS chunk → whole TTS → publish → playback start.
                ttsFirstChunk: pick('tts_first_chunk_ms'), ttsStreamTotal: pick('tts_stream_total_ms'),
                ttfa: pick('first_audio_ready_ms'), publishToStart: pick('publish_to_start_ms'), deadAir: pick('dead_air_ms'), midGap: pick('mid_turn_gap_ms'), hold: pick('first_part_hold_ms'), rtf: pick('tts_rtf_permille') },
            voice: this.voice?.status?.() ?? null,
            delivery: this.lastDelivery ?? null,
            events: this.trace.slice(-60).reverse(),
        };
    }
    claimRenderer(client) {
        if (typeof client !== 'string' || client.length > 80)
            throw new Error('Invalid renderer id');
        if (this.renderer && this.renderer.until > Date.now() && this.renderer.client !== client)
            return { acquired: false };
        if (!this.renderer || this.renderer.client !== client)
            this.renderer = { client, lease: randomUUID(), until: 0 };
        this.renderer.until = Date.now() + 6000;
        return { acquired: true, lease: this.renderer.lease };
    }
    releaseRenderer(lease) { if (this.renderer?.lease !== lease)
        return false; this.renderer = null; this.cancelSpeech('renderer_released'); return true; }
    validLease(lease) { return this.renderer?.lease === lease && this.renderer.until > Date.now(); }
    acknowledge({ lease, id, event }) {
        if (!this.validLease(lease) || !this.pending || this.pending.id !== id || this.pending.epoch !== this.epoch)
            return false;
        if (event === 'started') {
            if (this.pending.started)
                return true;
            this.pending.started = true;
            this.participation.playbackStarted(this.currentTurn?.candidate?.participationReceipt || this.pendingParticipation, this.pending.role || 'host');
            this.pending.deadline = Date.now() + this.pending.durationMs + 6000;
            this.phase = this.pending.role === 'comment' ? 'reading_comment' : 'speaking';
            const intensity = this.pending.intensity, gain = Object.hasOwn(INTENSITY_GAIN, String(intensity)) ? INTENSITY_GAIN[intensity] : 1;
            const reaction = this.pending.reaction || 'neutral', affect = this.affect.apply(reaction, Date.now(), gain);
            this.lastReaction = { ...describeReaction(reaction), role: this.pending.role || 'host', at: Date.now() };
            this.note('speech_start', `${this.pending.role === 'comment' ? 'narrator' : 'host'} · reaction → ${reaction}`);
            this.event('speech_started', { id, text: this.pending.text, effect: this.pending.effect, mood: this.pending.mood, reaction, affect, comment: this.pending.comment || null, sources: this.pending.sources, role: this.pending.role || 'host', ...(intensity ? { intensity } : {}), ...(this.pending.cue ? { cue: this.pending.cue } : {}), ...(this.pending.en ? { en: this.pending.en } : {}) });
        }
        else if (event === 'ended') {
            if (!this.pending.started)
                return false;
            const p = this.pending;
            this.pending = null;
            this.pendingParticipation = null;
            this.audio.delete(id); this.streams.delete(id);
            this.lastAudioOK = p.kind === 'wav' || p.kind === 'stream' || this.lastAudioOK;
            if (p.role === 'comment') this.stats.commentsRead = (this.stats.commentsRead || 0) + 1;
            else {
                this.stats.spoken++; this.turn++; this.errorCount = 0;
                this.memory.add(p.text);
            }
            this.nextTurnAt = Date.now() + this.c.turnGapMs;
            this.phase = 'listening';
            this.note('speech_end', p.role === 'comment' ? 'narrator' : 'host');
            this.event('speech_ended', { id });
        }
        else if (event === 'error') {
            this.cancelSpeech('audio_error');
            this.renderer = null;
            this.phase = 'awaiting_audio';
        }
        else
            return false;
        return true;
    }
    /** A person takes Noa's voice (src/control.mjs): the line on air and any prepared one stop; none starts until aiResume. */
    humanTakeover(to = 'human') { this.cancelSpeech('voice_handoff'); this.phase = to === 'none' ? 'muted' : 'human_voice'; this.note('handoff', to); }
    /** The AI has the voice again: the next turn starts at once; its first line knows a person spoke meanwhile. */
    aiResume(heldMs) { this.nextTurnAt = 0; this.handoffResume = { heldMs }; this.phase = 'thinking'; this.note('handoff', `ai after ${Math.round(heldMs / 1000)} s`); }
    /** Stop, emergency stop or a new show ends a handoff: the AI owns the voice, comments are on, the mic is muted. */
    endHandoff(reason) { this.control = initialControl(); this.handoffResume = null; this.onControlReset?.(reason); }
    cancelSpeech(reason) { if (this.pending) {
        const id = this.pending.id;
        this.pending = null;
        this.pendingParticipation = null;
        this.audio.delete(id); this.dropStream(id);
        this.note('cancel', reason);
        this.event('cancel', { id, reason });
    } this.nextTurnAt = Date.now() + this.c.turnGapMs; }
    ingest({ text, author = 'local', id, source = 'local', name = '' }) {
        if (!this.running)
            return { accepted: false, reason: 'not_running' };
        if (typeof text !== 'string' || text.length > 500 || !text.trim())
            return { accepted: false, reason: 'invalid' };
        // Inspect the original too: display normalization can replace hidden controls with spaces.
        const rawUnsafe = hasPII(text) || injection(text);
        text = clean(text);
        if (!safetyText(text).trim()) return { accepted: false, reason: 'invalid' };
        const now = Date.now();
        const participationReceipt = this.participation.receive({ source, author });
        for (const [k, t] of this.seen)
            if (now - t > 120000)
                this.seen.delete(k);
        for (const [k, t] of this.authors)
            if (now - t > 15000)
                this.authors.delete(k);
        const platform = ['youtube', 'twitch'].includes(source) ? source : 'local';
        const signature = hash(safetyText(text).toLowerCase()), authorKey = hash(`${platform}:${String(author).slice(0, 100)}`);
        const contentKey = hash(`${authorKey}:${signature}`), key = id ? hash(`${platform}:${String(id)}`) : contentKey;
        let reason = null;
        if (rawUnsafe || hasPII(text) || injection(text))
            reason = 'local_gate';
        else if (this.seen.has(key) || this.seen.has(contentKey))
            reason = 'duplicate';
        else {
            // Keep only four timestamps: enough to distinguish <=3 arrivals/minute from busy chat.
            // Count cooldown/queue rejects too, so a barrage cannot stay in the quiet-chat policy.
            this.commentArrivals = [...this.commentArrivals.filter(at => now - at < 60000), now].slice(-4);
            const quiet = this.c.readComments && this.commentArrivals.length <= 3 &&
                this.intake.length + this.candidateSlotsUsed() + this.researchQueue.length <= 2;
            if (this.authors.has(authorKey) && now - this.authors.get(authorKey) < (quiet ? 1500 : 7000))
                reason = 'author_cooldown';
            else if (this.intake.length >= (this.c.maxIntake || 20))
                reason = 'queue_full';
        }
        // The on-stream chat box (server /overlay/chat-events) shows every viewer comment that passed the local
        // PII/injection check, replied to or not; its display name too, unless the name itself fails that check.
        if (platform !== 'local' && reason !== 'local_gate' && reason !== 'duplicate') {
            const shown = clean(String(name || '')).slice(0, 40);
            this.emit('viewer_comment', { id: key.slice(0, 16), source: platform, name: shown && !hasPII(shown) && !injection(shown) ? shown : '', text });
        }
        // Listening muted / partner only (src/control.mjs): the comment is shown in the chat box above, not taken up.
        if (!reason && !takesComments(this.control.listening)) reason = 'comments_paused';
        if (reason) {
            this.stats.dropped++;
            this.note('comment_drop', reason);
            this.audit.log('chat_drop', { hash: signature, reason });
            this.recordComment({ text, author: String(author || 'anonymous').slice(0, 50), source: platform, at: now, status: 'dropped', reason });
            return { accepted: false, reason };
        }
        this.seen.set(key, now);
        this.seen.set(contentKey, now);
        this.authors.set(authorKey, now);
        while (this.seen.size > 2000)
            this.seen.delete(this.seen.keys().next().value);
        const message = { id: randomUUID(), text, source: ['youtube', 'twitch'].includes(source) ? source : 'local', created: now, epoch: this.epoch, participationReceipt };
        this.intake.push(message);
        this.recordComment({ id: message.id, text, author: String(author || 'anonymous').slice(0, 50), source: message.source, at: now, status: 'accepted' });
        this.note('comment', text.slice(0, 60));
        return { accepted: true, id: message.id };
    }
    recordComment(entry) {
        this.recentComments ??= [];
        this.recentComments.push(entry);
        if (this.recentComments.length > 100) this.recentComments.shift();
    }
    start() {
        if (this.panic)
            throw new Error('Emergency stop is latched; reset first');
        if (this.running)
            return;
        this.running = true;
        this.epoch++;
        this.participation = new ParticipationMetrics({ mode: this.c.mode });
        this.pendingParticipation = null;
        this.lastParticipationLogAt = 0;
        this.memory = new Memory(this.c.character.memoryPins);
        this.controller = new AbortController();
        const signal = this.controller.signal, epoch = this.epoch;
        this.phase = 'awaiting_audio';
        this.startedAt = Date.now();
        this.endAt = this.startedAt + this.c.sessionMs;
        this.nextTurnAt = 0;
        this.lastAudioOK = false;
        this.errorCount = 0;
        this.intake = [];
        this.candidates = [];
        this.researchQueue = [];
        this.researchStatus = 'idle';
        this.recent = [];
        this.affect = new AffectEngine();
        this.lastReaction = null;
        this.trace = [];
        this.endHandoff('start');
        this.note('start', this.c.mode);
        const loop = (fn, interval) => this.worker(fn, interval, epoch, signal);
        this.workers = [loop(() => this.monitor(), 250), loop(() => this.classify(epoch, signal), 180), loop(() => this.researchStep(epoch, signal), 300), loop(() => this.speakStep(epoch, signal), 200)];
        if (this.c.gameEnabled || this.c.programme?.gameMode === true)
            this.workers.push(loop(() => this.gameStep(epoch, signal), this.c.mode === 'demo' ? 650 : 1400));
        if (this.youtube && this.c.streamTarget !== 'twitch')
            this.workers.push(this.youtube.watch(m => { if (this.alive(epoch))
                this.ingest(m); }, state => { if (this.alive(epoch)) {
                this.youtubeStatus = state;
                this.event('youtube', { state });
            } }, signal));
        if (this.twitch && this.c.streamTarget !== 'youtube') this.workers.push(this.twitch.watch(m => { if (this.alive(epoch)) this.ingest(m); }, state => { if (this.alive(epoch)) { this.twitchStatus = state; this.event('twitch', { state }); } }, signal));
        this.event('state', this.status());
        this.audit.log('runtime_start', { state: this.c.mode });
    }
    alive(epoch) { return this.running && this.epoch === epoch && !this.controller.signal.aborted; }
    async worker(fn, interval, epoch, signal) { while (this.alive(epoch)) {
        try {
            await fn();
        }
        catch (e) {
            if (!signal.aborted) {
                this.audit.log('worker_error', { reason: e.name });
                this.event('notice', { message: '一部の処理を保留しました。接続状態を確認してください。' });
            }
        }
        try {
            await sleep(interval, signal);
        }
        catch {
            break;
        }
    } }
    monitor() {
        const now = Date.now();
        this.recordParticipation();
        if (now >= this.endAt) {
            this.stop('session_limit');
            return;
        }
        if (this.renderer && this.renderer.until <= now) {
            this.renderer = null;
            this.cancelSpeech('renderer_timeout');
        }
        if (this.pending && now > this.pending.deadline) {
            this.cancelSpeech('playback_timeout');
            this.renderer = null;
        }
        if (!this.renderer)
            this.phase = 'awaiting_audio';
        this.event('state', this.status());
    }
    candidateSlotsUsed() { return this.candidates.length; }
    async classify(epoch, signal) {
        if (this.control.voice !== 'ai') return; // no paid comment judging while the AI does not speak; comments wait (TTL)
        // Backpressure before the paid judge, never discard a paid result to make room.
        const fresh = this.intake.filter(x => Date.now() - x.created < (this.c.commentTTL || 60000));
        this.stats.dropped += this.intake.length - fresh.length; this.intake = fresh;
        if (this.candidateSlotsUsed() >= (this.c.maxCandidates || 2)) return;
        const m = this.intake.shift();
        if (!m)
            return;
        try {
            const judgedAt = performance.now();
            // A foreign comment is judged and answered with its Japanese translation (providers.foreignComment).
            if (m.translation === undefined && typeof this.conversation?.translate === 'function') {
                try { m.translation = (await this.conversation.translate(m.text, signal))?.ja ?? null; } catch { m.translation = null; }
                if (!this.alive(epoch)) return;
            }
            const result = await this.jev.chat(m.text, signal, m.translation ? { translation: m.translation } : {});
            if (!this.alive(epoch))
                return;
            const accepted = result?.accept === true && ['reply', 'research'].includes(result.action);
            const ackOnly = !accepted && result?.ackOnly === true;
            this.note('jev_chat', `${accepted ? 'ACCEPT' : ackOnly ? 'ACK' : 'DROP'} ${result?.action || result?.reason || ''} · ${Math.round(performance.now() - judgedAt)} ms`);
            if (!accepted && !ackOnly) {
                this.stats.dropped++;
                this.audit.log('chat_drop', { id: m.id, reason: result?.reason || 'unsafe_or_uncertain' });
                return;
            }
            if (Date.now() - m.created >= (this.c.commentTTL || 60000)) {
                this.stats.dropped++;
                this.audit.log('chat_drop', { id: m.id, reason: 'expired' });
                return;
            }
            this.stats.accepted++;
            this.participation.approve(m.participationReceipt);
            this.reflex(commentReflex(m.text), 'comment');
            this.affect.appraiseComment(m.text);
            m.readAllowed = result.readAllowed === true;
            // /events is shared with view-token clients. Quote-denied raw text stays in the admin queue.
            this.event('chat', { id: m.id, ...(m.readAllowed ? { text: m.text } : {}), readAllowed: m.readAllowed,
                source: m.source, route: result.action, confidence: result.confidence });
            if (ackOnly) {
                // Safe but not worth a generated reply: a fixed thank-you (talk-engine 'fixed_ack').
                this.candidates.push({ ...m, kind: 'reply', ackOnly: true });
            } else if (result.action === 'research' && this.c.profile === 'talk') {
                this.candidates.push({ ...m, kind: 'unavailable' });
            } else if (result.action === 'research') {
                if (this.researchQueue.length < 3 && (this.c.mode === 'demo' || this.c.searchURL)) {
                    this.researchQueue.push(m);
                    this.event('notice', { message: '資料の確認を別の処理に回しました。会話は続けます。' });
                }
                else
                    this.event('notice', { message: '検索が未接続、または調査待ちが上限のため、この質問は保留しました。' });
            }
            else {
                this.candidates.push({ ...m, kind: 'reply' });

            }
        }
        catch {
            if (this.alive(epoch)) {
                this.stats.dropped++;
                this.audit.log('chat_drop', { id: m.id, reason: 'judge_unavailable' });
            }
        }
    }
    async researchStep(epoch, signal) {
        const m = this.researchQueue.shift();
        if (!m)
            return;
        if (Date.now() - m.created > 60000)
            return;
        this.researchStatus = 'searching';
        this.event('research', { state: 'searching' });
        try {
            const result = await this.research.search(m.text, signal);
            if (!this.alive(epoch))
                return;
            this.stats.research++;
            this.candidates.push({ ...m, kind: 'research', research: result, created: Date.now() });
            if (this.candidates.length > 12)
                this.candidates.shift();
            this.researchStatus = 'ready';
            this.event('research', { state: 'ready', count: result.sources.length });
        }
        catch {
            if (this.alive(epoch)) {
                this.researchStatus = 'unavailable';
                this.event('notice', { message: '調査結果を確認できませんでした。推測を事実として読み上げず、通常の会話を続けます。' });
            }
        }
    }
    async speakStep(epoch, signal) {
        if (this.control.voice !== 'ai') return; // a person (or nobody) has Noa's voice: nothing is generated meanwhile
        if (!this.renderer || !this.validLease(this.renderer.lease) || this.pending || Date.now() < this.nextTurnAt)
            return;
        this.candidates = this.candidates.filter(x => Date.now() - x.created < 120000);
        let candidate = this.candidates.shift();
        // A completed investigation only returns at a speech boundary and with an explicit relevance check.
        if (candidate?.kind === 'research' && this.c.mode === 'live') {
            try {
                const a = await this.jev.ask({ question: candidate.text, evidence: candidate.research.sources, recentSpeech: this.memory.context().recentSpeech.slice(-3) }, { relevant: noul('Does the evidence actually help answer the question rather than only mention its topic?'), timely: noul('Would a short answer to the pending viewer question fit now, at this speech boundary?') }, signal);
                if (!this.alive(epoch))
                    return;
                if (a.relevant.noul < 0.75)
                    candidate = null;
                else if (a.timely.noul < 0.65) {
                    this.candidates.push(candidate);
                    candidate = null;
                }
            }
            catch {
                candidate = null;
            }
        }
        if (!this.alive(epoch))
            return;
        this.phase = 'thinking';
        const context = { kind: candidate?.kind || 'autonomous', comment: candidate?.text || null, research: candidate?.research || null, topic: this.c.character.topics[this.turn % this.c.character.topics.length], game: this.c.gameEnabled ? this.game.observe() : null, memory: this.memory.context(), now: new Date().toISOString() };
        try {
            const text = await this.conversation.generate(context, signal);
            if (!this.alive(epoch))
                return;
            const verdict = await this.jev.speech(text, signal, candidate?.research?.sources || []);
            if (!this.alive(epoch))
                return;
            if (!verdict.accept)
                throw new Error('Output gate rejected speech');
            if (this.recent.includes(text))
                throw new Error('Repeated speech');
            const voice = await this.voice.synthesize(text, signal);
            if (!this.alive(epoch) || !this.renderer)
                return;
            const id = randomUUID();
            this.audio.clear();
            if (voice.bytes)
                this.audio.set(id, voice.bytes);
            const effect = this.acting('host', this.effects.take({ ...verdict, reaction: verdict.reaction ?? reactionFor(verdict) }));
            this.pendingParticipation = candidate?.participationReceipt || null;
            this.pending = { id, epoch, text, ...effect, kind: voice.kind, durationMs: voice.durationMs, ...(voice.lipSync ? { lipSync: voice.lipSync } : {}), started: false, deadline: Date.now() + 8000, sources: (candidate?.research?.sources || []).map(x => ({ url: x.url, title: '参考資料' })) };
            this.recent.push(text);
            this.recent = this.recent.slice(-4);
            this.phase = 'ready';
            this.event('speech', { ...this.pending, audio: voice.kind === 'wav' ? `/audio/${id}.wav` : null });
            if (candidate?.kind === 'research')
                this.researchStatus = 'idle';
            if (this.turn > 0 && this.turn % 12 === 0 && this.c.mode === 'live')
                await this.memory.compact(this.jev, signal);
        }
        catch (e) {
            if (!this.alive(epoch))
                return;
            this.errorCount++;
            this.phase = 'holding';
            this.nextTurnAt = Date.now() + Math.min(30000, 3000 * 2 ** this.errorCount);
            this.audit.log('speech_hold', { reason: e.name });
            this.event('notice', { message: '発話を保留しました。文章の審査・音声・接続状態を確認してください。' });
            if (this.errorCount >= 4)
                this.providerFailure();
        }
    }
    async gameStep(epoch, signal) {
        if (this.game.paused) return;
        const observation = this.game.observe();
        const move = this.jevPlaysGame() ? await this.jev.game(observation, signal) : this.game.demoMove();
        if (!this.alive(epoch)) return;
        if (this.game.act(move, observation.revision)) {
            this.lastMove = { move, controller: this.jevPlaysGame() ? 'jev' : 'rule', at: Date.now() };
            if (this.game.justGotStar) this.reflex('excited', 'game');
        }
        this.event('game', { ...this.game.observe(), controller: this.jevPlaysGame() ? 'jev' : 'rule' });
    }
    /** Four failures in a row: stop the show, or with KEEP_LIVE stay on air and keep retrying at the capped backoff.
     *  Nothing unreviewed airs either way; the hold is silent until a line passes again. */
    providerFailure() {
        if (!this.c.keepLive) return this.stop('provider_failures');
        this.audit.log('provider_failure_hold', { count: this.errorCount });
    }
    stop(reason = 'operator') { if (!this.running && !this.pending)
        return; this.endHandoff(reason); this.participation.close(); this.running = false; this.twitchStatus = this.c.twitchEnabled ? 'stopped' : 'not_configured'; if (this.youtubeStatus !== 'not_configured') this.youtubeStatus = 'stopped'; this.epoch++; this.controller?.abort(new Error('Runtime stopped')); this.cancelSpeech(reason); this.audio.clear(); this.clearStreams(); this.intake = []; this.candidates = []; this.researchQueue = []; this.researchStatus = 'idle'; this.phase = 'stopped'; this.note('stop', reason); this.event('stop', { reason }); this.audit.log('runtime_stop', { reason }); this.emit('stopped', reason); }
    emergency() { this.panic = true; this.stop('emergency'); this.endHandoff('emergency'); this.phase = 'emergency'; this.event('state', this.status()); }
    reset() { if (this.running)
        throw new Error('Stop before resetting'); this.panic = false; this.phase = 'stopped'; this.event('state', this.status()); }
}
