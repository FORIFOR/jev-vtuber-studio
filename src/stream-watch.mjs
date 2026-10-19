// Optional stream watch (STREAM_WATCH=claude|codex, off by default), in two tiers (operator 2026-10-10):
// 1. every minute while a show runs, the Studio collects a small snapshot itself (no AI) and flags what is plainly wrong
//    (the stream stopped, no speech for SILENT_MINUTES, the game clock still for STALL_MINUTES, the runner failed, ...);
// 2. only while something is flagged, a local agent CLI (Claude Code or Codex) reviews the same snapshot: when the flags
//    change, and again every STREAM_WATCH_MINUTES while they last. A quiet night costs no agent call.
// Flagged checks, agent reviews and one heartbeat every STREAM_WATCH_MINUTES go to data/stream-watch/YYYY-MM-DD.jsonl;
// new or changed problems (and their clearing) reach the operator as a notice.
// Bounded: a snapshot of a few KB, no tools for the agent, low CPU priority, a timeout, at most one check at a time, a
// daily cap, no agent under memory pressure, and a size cap per log file. The agent never controls anything.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const WATCH_AGENTS = ['off', 'claude', 'codex'];
const MAX_SNAPSHOT = 6000, MAX_OUTPUT = 20000, MAX_LOG_BYTES = 5 * 1024 * 1024;
// Plain check cadence, and how long a silence or a still game clock lasts before it is flagged (a game-over break, a
// level-up pause and quiet play leave shorter gaps).
export const CHECK_MS = 60000, SILENT_MINUTES = 5, STALL_MINUTES = 3;

const PROMPT = `あなたはライブ配信スタジオの監視係です。下の JSON は、いま配信中のスタジオの状態を自動で集めた要約です
（前回の確認からの差分と、発言やゲーム内時間が止まっている分数を含みます）。自動の点検で flags の異常が見つかったので呼ばれています。これだけを根拠に、次の3点を短く判断してください。
1. 配信が止まっていないか（OBS の送信、番組の進行、発言、ゲームの進行）
2. 不具合や異常がないか（エラー、はじかれた発言の急増、コメントの受信停止、メモリなど）
3. 改善できそうな点（あれば1〜3個、具体的に）
show.youtubeComments / show.twitchComments はコメント受信の状態で、映像の配信状態ではありません（映像は obs を見る）。安全確認や判定の基準を緩める提案はしないでください。推測で断定せず、根拠になった項目名を書いてください。返答は次の JSON だけ（前後に文章を付けない）：
{"status":"ok|warn|alert","summary":"1文","issues":["..."],"improvements":["..."]}`;

/** Plain checks that need no AI; each flag is a short Japanese sentence. s.still = minutes without speech / game clock. */
export function redFlags(s) {
    const f = [];
    if (!s.show?.running) return f;
    if (s.obs && s.obs.active === false) f.push('OBS の配信が止まっています');
    if (s.obs?.reconnecting) f.push('OBS が再接続中です');
    if (Number.isFinite(s.delta?.obsSkippedFrames) && s.delta.obsSkippedFrames > 300) f.push(`OBS の送り損ねたコマが1分で${s.delta.obsSkippedFrames}増えました`);
    if ((s.still?.speechMinutes ?? 0) >= SILENT_MINUTES) f.push(`${s.still.speechMinutes}分間、ノアの発言がありません`);
    // The goodbye stops the game player on purpose (src/server.mjs): not a fault then.
    if (['failed', 'finished'].includes(s.runner?.state) && !s.show?.closing) f.push(`ゲーム担当が「${s.runner.state}」です`);
    if (s.runner?.enabled && s.show.gamePhase === 'playing' && (s.still?.gameMinutes ?? 0) >= STALL_MINUTES) f.push(`${s.still.gameMinutes}分間、ゲーム内の時間が進んでいません`);
    for (const [k, v] of [['YouTube', s.show.youtubeComments], ['Twitch', s.show.twitchComments]])
        if (v && /error|exhausted|ended/.test(v)) f.push(`${k} のコメント受信が「${v}」です`);
    if (s.memory?.level && !['ok', 'normal', 'disabled', 'unknown'].includes(s.memory.level)) f.push(`メモリの状態が「${s.memory.level}」です`);
    if (['low', 'critical'].includes(s.disk?.level)) f.push(`ディスクの空きが${s.disk.freeGb}GBです`);
    if (['failed', 'partial'].includes(s.title?.status)) f.push('配信タイトルを更新できていません');
    return f;
}

/** The agent's JSON answer, checked and trimmed; null when it is not usable. */
export function parseVerdict(text) {
    const m = String(text ?? '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch { return null; }
    if (!['ok', 'warn', 'alert'].includes(j?.status)) return null;
    const list = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string').slice(0, 5).map(x => x.slice(0, 200));
    return { status: j.status, summary: String(j.summary ?? '').slice(0, 300), issues: list(j.issues), improvements: list(j.improvements) };
}

/** Command and arguments for one read-only, tool-less agent call; the prompt goes on stdin. */
export function agentCommand(agent, c, outFile) {
    // --setting-sources "": no user/project settings (plugins, hooks, MCP servers) but the saved login still works
    // (--bare skipped the login: "Not logged in", 2026-10-07).
    if (agent === 'claude') return ['nice', ['-n', '10', 'claude', '-p', '--setting-sources', '', '--tools', '', '--no-session-persistence', '--output-format', 'text',
        '--model', c.streamWatchModel || 'haiku', '--max-budget-usd', String(c.streamWatchMaxUsd ?? .05)]];
    if (agent === 'codex') return ['nice', ['-n', '10', 'codex', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-c', 'model_reasoning_effort=low',
        ...(c.streamWatchModel ? ['-m', c.streamWatchModel] : []), '--output-last-message', outFile, '-']];
    return null;
}

export class StreamWatch {
    /** collect: async () => snapshot (small, no secrets); notify: message => void; memoryHigh: () => boolean. */
    constructor(c, { collect, notify = () => {}, memoryHigh = () => false, spawnFn = spawn, now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
        Object.assign(this, { c, collect, notify, memoryHigh, spawnFn, now, setTimer, clearTimer });
        this.agent = WATCH_AGENTS.includes(c.streamWatch) ? c.streamWatch : 'off';
        this.minutes = Math.min(60, Math.max(5, Number(c.streamWatchMinutes) || 10));
        this.maxPerDay = Math.max(1, Number(c.streamWatchMaxPerDay) || 48);
        this.timeoutMs = 120000; this.busy = false; this.timer = null; this.prev = null; this.day = null; this.count = 0;
        this.since = null; this.flagKey = ''; this.agentAt = -Infinity; this.loggedAt = -Infinity;
        this.dir = join(c.dataDir, 'stream-watch');
    }
    get enabled() { return this.agent !== 'off'; }
    start() { if (this.enabled && !this.timer) this.timer = this.setTimer(() => { void this.check(); }, CHECK_MS); return this; }
    stop() { if (this.timer) this.clearTimer(this.timer); this.timer = null; }
    write(entry) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = join(this.dir, `${new Date(this.now()).toISOString().slice(0, 10)}.jsonl`);
        if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) return false;
        appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
        return true;
    }
    /** One plain check: snapshot -> flags -> (agent review only while flagged) -> log line (+ notice). Returns the entry. */
    async check() {
        if (!this.enabled || this.busy) return null;
        this.busy = true;
        try {
            const raw = await this.collect(), now = this.now();
            if (!raw?.show?.running) { this.prev = null; this.since = null; this.flagKey = ''; return null; }
            // When speech and the game clock last moved (a new run, or a phase other than play, restarts the game clock).
            const turns = raw.counters?.turns_played ?? 0, gameKey = raw.show.gamePhase === 'playing' ? `${raw.game?.run}:${raw.game?.elapsed}` : `idle:${now}`;
            this.since ??= { turns, turnsAt: now, gameKey, gameAt: now };
            if (turns !== this.since.turns) Object.assign(this.since, { turns, turnsAt: now });
            if (gameKey !== this.since.gameKey) Object.assign(this.since, { gameKey, gameAt: now });
            const delta = this.prev ? {
                turns: turns - (this.prev.counters?.turns_played ?? 0),
                rejected: (raw.counters?.content_rejected ?? 0) - (this.prev.counters?.content_rejected ?? 0),
                obsSkippedFrames: Number.isFinite(raw.obs?.skippedFrames) && Number.isFinite(this.prev.obs?.skippedFrames) ? raw.obs.skippedFrames - this.prev.obs.skippedFrames : null,
            } : null;
            this.prev = raw;
            const still = { speechMinutes: Math.floor((now - this.since.turnsAt) / 60000), gameMinutes: Math.floor((now - this.since.gameAt) / 60000) };
            const snapshot = { ...raw, delta, still };
            // The same problem is the same flag as its minutes grow (「5分間…」, then「6分間…」).
            const flags = redFlags(snapshot), key = flags.map(f => f.replace(/\d+/g, '#')).join(' / '), changed = key !== this.flagKey;
            const day = new Date(now).toISOString().slice(0, 10);
            if (day !== this.day) { this.day = day; this.count = 0; }
            let verdict = null, skipped = null;
            if (flags.length && (changed || now - this.agentAt >= this.minutes * 60000)) {
                if (this.count >= this.maxPerDay) skipped = 'daily_cap';
                else if (this.memoryHigh()) skipped = 'memory_pressure';
                else { this.count++; this.agentAt = now; verdict = await this.review({ ...snapshot, flags }).catch(e => { skipped = `agent_error: ${String(e.message || e).slice(0, 120)}`; return null; }); }
            }
            const entry = { at: new Date(now).toISOString(), agent: this.agent, flags, verdict, ...(skipped ? { skipped } : {}), snapshot };
            if (flags.length || changed || now - this.loggedAt >= this.minutes * 60000) { this.write(entry); this.loggedAt = now; }
            if (changed && !flags.length) this.notify('配信の見守り：異常はおさまりました');
            const problems = [...(changed ? flags : []), ...(verdict && verdict.status !== 'ok' ? verdict.issues : [])];
            if (problems.length) this.notify(`配信の見守り：${problems.slice(0, 3).join(' / ')}`);
            this.flagKey = key;
            return entry;
        } finally { this.busy = false; }
    }
    review(snapshot) {
        const out = join(tmpdir(), `stream-watch-${process.pid}-${this.now()}.txt`);
        const [cmd, args] = agentCommand(this.agent, this.c, out);
        const input = `${PROMPT}\n\n${JSON.stringify(snapshot).slice(0, MAX_SNAPSHOT)}\n`;
        return new Promise((resolve, reject) => {
            const child = this.spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NO_COLOR: '1' } });
            let stdout = '';
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, this.timeoutMs);
            child.stdout?.on('data', d => { if (stdout.length < MAX_OUTPUT) stdout += d; });
            child.on('error', e => { clearTimeout(timer); reject(e); });
            child.on('close', code => {
                clearTimeout(timer);
                let text = stdout;
                if (this.agent === 'codex' && existsSync(out)) { try { text = readFileSync(out, 'utf8').slice(0, MAX_OUTPUT); } catch { } rmSync(out, { force: true }); }
                const v = parseVerdict(text);
                v ? resolve(v) : reject(new Error(`unusable answer (exit ${code})`));
            });
            child.stdin?.end(input);
        });
    }
}
