import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readBillingHold } from './jev.mjs';
// Starts and stops the game's controller with the show, so a live show is one operation in the Studio. The controller is
// whatever games/<id>/game.json names (for Vampire Survivors: jev-vampire-survivors' tools/auto_session.py, which launches
// the game, walks the menus, plays with Jev and restarts after a game over), run within a time and cost limit. It writes
// one JSON observation per line under its log folder; that log feeds the show (run-log-feed). See docs/GAMES.md.

// Game control handoff (docs/GAMES.md, NOA Studio Phase 5, operator 2026-10-19): the mode file carries an epoch; the
// controller answers each epoch in <GAME_DIR>/.local/noa-player-ack.json once it has released its inputs (human) or read a
// fresh game state (ai). The Studio waits for that answer (ACK_WAIT_MS); without it the switch stands, with a warning.
export const ACK_WAIT_MS = 1500;
const SAME_PRESS_MS = 250;

// Defaults when a manifest gives none: Jev decisions for play ran at about $0.0001 each, ~4 per second: ~$1.3 per hour.
export const COST_PER_MINUTE_USD = .035, COST_PER_CALL_USD = .000105;

export class GameRunner {
    constructor(c, { spawnFn = spawn, emit = () => { }, now = Date.now } = {}) {
        Object.assign(this, { c, spawnFn, emit, now });
        this.child = null; this.state = 'idle'; this.detail = ''; this.runs = 0; this.startedAt = null; this.exitCode = null;
        this.player = 'ai'; // 'ai' | 'human'
        this.switching = false;
        this.epoch = 0; this.ack = null; this.warning = ''; this.chain = Promise.resolve(); this.lastPress = null;
        this.standalone = false;
        this.isStreaming = false;
    }
    /** Write the mode file whole (temp file + rename: the controller never reads half a file). strict: a failure throws. */
    syncModeFile({ strict = false } = {}) {
        if (!this.repo) return null;
        const flagFile = join(this.repo, '.local', 'noa-player-mode.json');
        const isStreaming = Boolean(this.isStreaming && !this.standalone);
        const timeScale = Number(this.c.gameTimeScale) || (isStreaming ? 1.0 : 2.0);
        try {
            mkdirSync(join(this.repo, '.local'), { recursive: true });
            const tmp = `${flagFile}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ mode: this.player, epoch: this.epoch, streaming: isStreaming, timeScale, updatedAt: this.now() }));
            renameSync(tmp, flagFile);
        } catch (e) { if (strict) throw e; }
        return flagFile;
    }
    /** The controller's answer for an epoch, or null. */
    readAck(epoch) {
        if (!this.repo) return null;
        try { const a = JSON.parse(readFileSync(join(this.repo, '.local', 'noa-player-ack.json'), 'utf8')); return a && a.epoch === epoch ? a : null; } catch { return null; }
    }
    setStreaming(streaming) {
        this.isStreaming = Boolean(streaming);
        this.syncModeFile();
        this.emit('game_runner', this.status());
    }
    get controller() { return this.c.game?.controller || null; }
    get repo() { return this.c.gameDir || ''; }
    get enabled() { return !!this.controller && !!this.repo; }
    /** Limits for one show or standalone play: cost by the minute. */
    limits(remainingMs) {
        const k = this.controller || {}, perMinute = k.costPerMinuteUsd ?? COST_PER_MINUTE_USD, perCall = k.costPerCallUsd ?? COST_PER_CALL_USD;
        const totalMs = this.standalone ? 24 * 3600 * 1000 : (remainingMs ?? this.c.sessionMs);
        const seconds = this.standalone ? 24 * 3600 : Math.max(60, Math.round(totalMs / 1000) - 30);
        const cost = Number.isFinite(this.c.gameMaxCostUsd) && this.c.gameMaxCostUsd > 0 ? this.c.gameMaxCostUsd : Math.max(.1, +(seconds / 60 * perMinute).toFixed(2));
        return { seconds, cost, calls: Math.ceil(cost / perCall) };
    }
    /** The controller's command line from its manifest: [executable, ...args]; only the limits the manifest names are passed. */
    command(session = `live-${new Date(this.now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}`, remainingMs, { player = this.player, resume = false } = {}) {
        const k = this.controller, l = this.limits(remainingMs), flags = k.args || {};
        const values = {
            session,
            seconds: l.seconds,
            maxCalls: l.calls,
            maxCost: l.cost,
            character: this.c.gameCharacter || null,
            stage: this.c.gameStage || null
        };
        const limitArgs = Object.entries(values).flatMap(([key, v]) => flags[key] && v !== null && v !== '' ? [flags[key], String(v)] : []);
        const [exe, ...base] = k.command;
        const extra = [...(k.extraArgs || [])];
        if (player === 'human') {
            extra.push('--observe');
        } else if (resume) {
            extra.push('--resume');
        }
        return [this.c.gameExecutable || exe, [...base, ...limitArgs, ...extra, ...(this.c.gameAudio && k.audioArg ? [k.audioArg] : [])]];
    }
    args(session, remainingMs, opts) { return this.command(session, remainingMs, opts)[1]; }
    set(state, detail = this.detail) { this.state = state; this.detail = detail; this.emit('game_runner', this.status()); }
    /** remainingMs: the show time left (a game started after the opening talk gets only what remains). */
    start(remainingMs, { player = this.player, resume = false, standalone = false } = {}) {
        if (!this.enabled || this.child) return false;
        // A held 402 (Studio's or the controller's own) means the controller would only spend or fail: do not launch it.
        if (this.c.mode === 'live' && readBillingHold(this.c) && player === 'ai') {
            this.set('failed', 'Jevの支払い・クレジット確認が必要です（HTTP 402）。残高を確認してから準備状況で解除してください。');
            return false;
        }
        this.player = player;
        this.standalone = standalone || (!remainingMs && !this.standalone ? false : this.standalone);
        this.isStreaming = Boolean(!this.standalone && remainingMs);
        this.runs = 0; this.exitCode = null; this.startedAt = this.now();
        // A minimal environment: the Studio's own settings and secrets (loaded into its process env, some as empty values)
        // are not passed on. The player reads its own key from its own .env; an inherited empty key would win over it.
        const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
        // Fixed, non-secret switches the manifest names for its controller (e.g. NOA_LOCAL_CHOOSER); never a key.
        for (const [key, value] of Object.entries(this.controller.env || {}))
            if (/^[A-Z][A-Z0-9_]*$/.test(key) && !/(KEY|TOKEN|SECRET|PASSWORD)/.test(key) && typeof value === 'string') env[key] = value;
        this.session = `live-${randomUUID()}`;
        this.reviewDir = null;
        if (this.c.game?.id === 'vampire-survivors' && this.c.dataDir) {
            this.reviewDir = resolve(this.c.dataDir, 'round-reviews', this.session);
            mkdirSync(this.reviewDir, { recursive: true, mode: 0o700 });
            env.NOA_ROUND_REVIEW_DIR = this.reviewDir;
        }
        const flagFile = this.syncModeFile();
        if (flagFile) {
            env.NOA_PLAYER_MODE_FILE = flagFile;
            env.NOA_TIME_SCALE = this.isStreaming ? '1' : '2';
        }
        const [exe, args] = this.command(this.session, remainingMs, { player, resume });
        const child = this.spawnFn(exe, args, { cwd: this.repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
        this.child = child;
        const startMsg = player === 'human'
            ? 'ユーザー操作モード（ノアが実況）を開始しています'
            : (resume ? 'ノア（AI）へ操作を引き継いでいます' : 'ゲームを起動しています');
        this.set('starting', startMsg);
        let rest = '';
        const onData = chunk => {
            const lines = (rest + chunk.toString()).split('\n'); rest = lines.pop();
            for (const line of lines) this.line(line.trim());
        };
        child.stdout?.on('data', onData); child.stderr?.on('data', onData);
        child.on('error', e => { this.child = null; if (!this.switching) this.set('failed', `起動できません: ${e.code || e.message}`); });
        child.on('exit', code => {
            this.child = null; this.exitCode = code;
            if (!this.switching) {
                this.set(code === 0 ? 'finished' : this.state === 'stopping' ? 'stopped' : 'failed',
                    code === 0 ? '終了しました' : this.state === 'stopping' ? '停止しました' : this.failure ? `エラー: ${this.failure}` : `終了コード ${code}`);
            }
        });
        return true;
    }
    /** skipped: the spoken review could not air (KEEP_LIVE); the next round still starts, and the file says so. */
    completeReview({ runId, tactic, skipped = false } = {}) {
        if (!this.child || this.state === 'stopping' || !this.reviewDir || !['health_priority', 'escape_space'].includes(tactic)) return false;
        // A retried start is named …-r<n>-a<attempt> by the runner (auto_session.py), and it waits for that exact name.
        if (typeof runId !== 'string' || !runId.startsWith(`vampire-${this.session}-r`) || !/^\d+(-a\d+)?$/.test(runId.slice(`vampire-${this.session}-r`.length))) return false;
        const file = join(this.reviewDir, `${runId}.json`);
        try {
            writeFileSync(`${file}.tmp`, JSON.stringify({ runId, tactic, playbackCompleted: true, ...(skipped ? { reviewSkipped: true } : {}) }), { mode: 0o600 });
            renameSync(`${file}.tmp`, file); return true;
        } catch { this.set(this.state, '振り返り完了の保存に失敗しました'); return false; }
    }
    /** The player's own progress lines, reduced to a short status (no paths, keys or raw output reach the Studio). */
    line(text) {
        if (!text) return;
        // The full output stays in a local log for diagnosis (data/ is private); the Studio only gets the short status.
        if (this.c.dataDir) try { appendFileSync(join(this.c.dataDir, 'game-runner.log'), `${new Date(this.now()).toISOString()} ${text}\n`); } catch { }
        // Progress patterns come from the manifest (controller.progress); anything else stays in the local log only.
        const p = this.controller?.progress || {}, match = key => { try { return p[key] ? new RegExp(p[key]).exec(text) : null; } catch { return null; } };
        let m;
        if ((m = match('failed'))) {
            this.failure = (m[1] ?? text).slice(0, 120);
            // The controller keeps its own 402 hold (<GAME_DIR>/.local/jev-payment-hold.json); the Studio reads it, never writes one.
            this.set('failed', /HTTP 402/.test(this.failure) ? 'ゲーム操作側の支払い・クレジット確認が必要です（HTTP 402）' : 'ゲームの操作を続けられませんでした');
        }
        else if (match('playing')) {
            this.runs++;
            const playDetail = this.player === 'human' ? `あなたがプレイ中（${this.runs}回目）` : `プレイ中（${this.runs}回目）`;
            this.set('playing', playDetail);
        }
        else if (match('restarting')) this.set('restarting', 'ゲームオーバー。次のプレイを準備中');
        else if (match('starting')) this.set('starting', 'メニューを進めています');
        else if (match('slow')) this.set(this.state, 'ゲーム画面の確認に時間がかかっています');
    }
    async stopChild() {
        const child = this.child;
        if (child) {
            return new Promise(resolve => {
                let resolved = false;
                const done = () => { if (!resolved) { resolved = true; resolve(); } };
                child.once('exit', done);
                const signal = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { } } };
                signal('SIGINT');
                setTimeout(() => { if (this.child === child) signal('SIGTERM'); }, 2000).unref?.();
                setTimeout(() => { done(); }, 3500).unref?.();
            });
        }
        return Promise.resolve();
    }
    /** Interrupt like Ctrl+C: the player pauses the game and exits; a stubborn process is terminated. */
    stop() {
        const child = this.child;
        this.standalone = false;
        if (!child) return false;
        this.set('stopping', '停止しています');
        const signal = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { } } };
        signal('SIGINT');
        setTimeout(() => { if (this.child === child) signal('SIGTERM'); }, 20000).unref?.();
        return true;
    }
    /** Hand game control to the AI or a person without stopping the game (Phase 5). One switch at a time; the same press
     * within 250 ms is one. The owner is the mode file's; it is confirmed by the controller's answer for its epoch. */
    switchPlayer(targetPlayer) {
        if (!targetPlayer) targetPlayer = this.player === 'human' ? 'ai' : 'human';
        if (!['ai', 'human'].includes(targetPlayer)) return Promise.reject(new Error('player must be ai or human'));
        const t = this.now();
        if (this.lastPress?.to === targetPlayer && t - this.lastPress.at < SAME_PRESS_MS) return this.lastPress.run;
        const run = this.chain.then(() => this.applyPlayer(targetPlayer));
        this.chain = run.catch(() => { });
        this.lastPress = { to: targetPlayer, at: t, run };
        run.catch(() => { if (this.lastPress?.run === run) this.lastPress = null; });
        return run;
    }
    async applyPlayer(target) {
        const before = this.player;
        if (target === before && !this.warning) return { ok: true, player: this.player, state: this.state, confirmed: !!this.ack };
        this.switching = true; this.warning = '';
        this.player = target; this.epoch++; this.ack = null;
        try { this.syncModeFile({ strict: true }); }
        catch (e) { this.player = before; this.switching = false; this.emit('game_runner', this.status()); throw new Error('操作モードのファイルを書けませんでした。ゲームのフォルダを確認してください。'); }
        this.emit('game_runner', this.status());
        const running = !!this.child && ['starting', 'playing', 'restarting'].includes(this.state);
        let ack = null;
        if (running) {
            const started = this.now(), until = started + ACK_WAIT_MS;
            while (!(ack = this.readAck(this.epoch)) && this.now() < until) await new Promise(r => setTimeout(r, 50));
            if (ack) this.ack = { ...ack, ms: this.now() - started };
            // The switch stands either way: the controller releases (or resumes) on its next loop even when late.
            else this.warning = target === 'human' ? 'AIの入力を放したことを確認できません（コントローラーの応答待ち）' : 'AIが操作を再開したことを確認できません（コントローラーの応答待ち）';
        }
        if (running) this.set('playing', target === 'human' ? 'あなたがプレイ中（AI操作停止中）' : `AI（ノア）がプレイ中（${this.runs || 1}回目）${ack?.phase && ack.phase !== 'combat' ? `・${ack.phase}の画面の終わり待ち` : ''}`);
        this.switching = false;
        this.emit('game_runner', this.status());
        return { ok: true, player: this.player, state: this.state, confirmed: !!ack, ...(this.warning ? { warning: this.warning } : {}) };
    }
    status() {
        const l = this.enabled ? this.limits() : null;
        const isStreaming = Boolean(this.isStreaming && !this.standalone);
        return {
            enabled: this.enabled, state: this.state, detail: this.detail, runs: this.runs, startedAt: this.startedAt,
            player: this.player, switching: this.switching, epoch: this.epoch, warning: this.warning || null,
            ack: this.ack ? { mode: this.ack.mode, phase: this.ack.phase ?? null, ms: this.ack.ms } : null,
            standalone: this.standalone,
            streaming: isStreaming,
            speed: Number(this.c.gameTimeScale) || (isStreaming ? 1.0 : 2.0),
            limits: l ? { minutes: Math.round(l.seconds / 60), maxCostUsd: l.cost } : null,
            gameAudio: !!this.c.gameAudio, game: this.c.game ? { id: this.c.game.id, title: this.c.game.title } : null
        };
    }
}
