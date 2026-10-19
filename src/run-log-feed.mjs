import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeGameDecision, gameAction, DECISION_TTL_MS } from './game-decision.mjs';
// Follows a game controller's per-run log (<logDir>/<run>/<logFile>, one JSON record per line) and hands every observed
// game state to the show. Read-only: a game connection usually takes one client (the controller), so the studio never
// connects to the game. Only runs whose log changes after the feed started count; older runs in the folder are ignored.
// Record contract (docs/GAMES.md): { state: {...} } for an observation; a menu choice is { event: 'choice_planned' |
// 'decision', phase, attempt, choice, candidates, applied } in one of the manifest's choicePhases.

export class RunLogFeed {
    constructor(runsDir, onState, { now = Date.now, intervalMs = 250, logFile = 'decisions.jsonl', choicePhases = ['levelup', 'chest'] } = {}) {
        Object.assign(this, { runsDir, onState, now, intervalMs, logFile, choicePhases });
        this.startedAt = now(); this.run = null; this.offset = 0; this.rest = ''; this.timer = null; this.done = new Set(); this.planned = new Set();
        this.decisionSequence = -1; this.decisionAttempt = 0; this.restEligible = false; this.restAt = 0;
    }
    start() { if (!this.timer) { this.startedAt = this.now(); this.timer = setInterval(() => { try { this.poll(); } catch { } }, this.intervalMs); } return this; }
    stop() { clearInterval(this.timer); this.timer = null; }
    /** Newest run directory whose log was written after the feed started, or null. */
    latest() {
        if (!this.runsDir || !existsSync(this.runsDir)) return null;
        let best = null;
        for (const name of readdirSync(this.runsDir)) {
            const log = join(this.runsDir, name, this.logFile);
            let m; try { m = statSync(log).mtimeMs; } catch { continue; }
            if (m >= this.startedAt - 1000 && !this.done.has(name) && (!best || m > best.m)) best = { name, log, m };
        }
        return best;
    }
    poll() {
        const next = this.latest();
        let bootstrap = false;
        if (next && next.name !== this.run?.name) {
            if (this.run) this.done.add(this.run.name);
            this.run = next; this.offset = 0; this.rest = ''; this.planned.clear(); bootstrap = true;
            this.decisionSequence = -1; this.decisionAttempt = 0; this.restEligible = false;
        }
        if (!this.run) return 0;
        const stat = statSync(this.run.log), now = this.now();
        // A rotated/truncated file is an observation bootstrap, never a reason to replay the HUD.
        if (stat.size < this.offset) { this.offset = 0; this.rest = ''; this.restEligible = false; bootstrap = true; }
        const fd = openSync(this.run.log, 'r'), chunks = [];
        try {
            const buf = Buffer.alloc(1 << 16); let n;
            while ((n = readSync(fd, buf, 0, buf.length, this.offset)) > 0) { chunks.push(Buffer.from(buf.subarray(0, n))); this.offset += n; }
        } finally { closeSync(fd); }
        const carried = !!this.rest, carriedEligible = this.restEligible, carriedAt = this.restAt;
        const text = this.rest + Buffer.concat(chunks).toString('utf8'), lines = text.split('\n');
        this.rest = lines.pop(); // an unfinished last line waits for the rest
        this.restEligible = !bootstrap && (lines.length > 0 || !carried || carriedEligible);
        this.restAt = lines.length > 0 || !carried ? now : carriedAt;
        // Two passes over strings, never an array of parsed game states (initial logs can be large).
        // Hold at most two tiny DTOs while determining the latest record's elapsed clock.
        let lastElapsed = null; const recent = { combat: null, levelup: null };
        for (let i = 0; i < lines.length; i++) {
            let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
            if (typeof rec?.elapsed_ms === 'number' && Number.isFinite(rec.elapsed_ms) && rec.elapsed_ms >= 0) lastElapsed = Math.max(lastElapsed ?? 0, rec.elapsed_ms);
            const seq = rec?.state?.seq, attempt = rec?.attempt;
            if (rec?.event !== 'decision' || rec.applied !== true || !Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(attempt) || attempt < 1) continue;
            const newer = seq > this.decisionSequence && attempt > this.decisionAttempt;
            this.decisionSequence = Math.max(seq, this.decisionSequence); this.decisionAttempt = Math.max(attempt, this.decisionAttempt);
            const eligible = !bootstrap && (i > 0 || !carried || carriedEligible), partialAt = i === 0 && carried ? carriedAt : now;
            if (!newer || !eligible || stat.mtimeMs > now + 100 || now - stat.mtimeMs >= DECISION_TTL_MS) continue;
            const recordedAt = Math.min(now, stat.mtimeMs, partialAt);
            const decision = sanitizeGameDecision(rec, { runId: this.run.name, recordedAt, now });
            if (decision) recent[decision.phase] = { index: i, decision, partialAt };
        }
        let selected = null;
        for (const candidate of [recent.levelup, recent.combat]) {
            if (!candidate || lastElapsed === null) continue;
            const d = candidate.decision;
            d.recordedAt = Math.min(now, stat.mtimeMs - (lastElapsed - d.timing.recordElapsedMs), candidate.partialAt);
            d.expiresAt = d.recordedAt + DECISION_TTL_MS;
            if (d.expiresAt > now) { selected = candidate; break; }
        }
        let sent = 0;
        for (let i = 0; i < lines.length; i++) {
            let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
            if (!rec || typeof rec.state !== 'object' || !rec.state) continue;
            // A menu choice (Vampire Survivors: level-up/chest), with the facts the controller's code computed for it: announced when it is planned (the
            // runner waits before pressing it), or when it is applied if no plan was logged for that attempt.
            const menu = this.choicePhases.includes(rec.phase), planned = rec.event === 'choice_planned' && menu;
            if (planned) this.planned.add(rec.attempt);
            const applied = rec.event === 'decision' && rec.applied === true && menu && !this.planned.has(rec.attempt);
            const option = planned || applied ? rec.candidates?.[rec.choice] : null;
            // Each newly applied command (not the log replayed when the feed joins a run) for the stage's action log.
            const action = !bootstrap && (i > 0 || !carried || carriedEligible) ? gameAction(rec) : null;
            this.onState({ runId: this.run.name, state: rec.state, ...(option ? { pick: { choice: rec.choice, option } } : {}),
                ...(selected?.index === i ? { decision: selected.decision } : {}), ...(action ? { action } : {}),
                ...(rec.event === 'revive' && rec.applied === true ? { revive: true } : {}) }); sent++;
        }
        return sent;
    }
}

/** The name this feed had when Vampire Survivors was the only external game. */
export { RunLogFeed as VampireFeed };
