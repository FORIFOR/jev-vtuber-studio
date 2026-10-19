import { mkdirSync, existsSync, appendFileSync, readFileSync, statSync, createReadStream, writeFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export class ShowLogger {
    /** retentionDays (COMMENT_RETENTION_DAYS, default 7): viewer comment text and authors in this log are erased once
     * they are older than that; the rest of the line (what Noa said, when) stays. */
    constructor(dataDir, { retentionDays = 7, now = Date.now } = {}) {
        this.dir = dataDir;
        this.logFile = join(dataDir, 'show-log.jsonl');
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.currentSessionId = null;
        this.retentionDays = retentionDays; this.now = now; this.prunedAt = 0;
        this.pruneComments();
    }

    /** Erase viewer comment data older than retentionDays: a speech line's quoted comment, a read comment's text, the
     * read-aloud text and its author. Runs at start and at most once an hour while logging. -> lines changed. */
    pruneComments() {
        this.prunedAt = this.now();
        if (!(this.retentionDays > 0) || !existsSync(this.logFile)) return 0;
        const cutoff = this.now() - this.retentionDays * 86400000;
        let changed = 0;
        const lines = readFileSync(this.logFile, 'utf8').split('\n').map(line => {
            if (!line || !(line.includes('"comment":"') || line.includes('"commentText"') || line.includes('"readText"'))) return line;
            let e; try { e = JSON.parse(line); } catch { return line; }
            const at = Date.parse(e.at);
            if (!Number.isFinite(at) || at >= cutoff) return line;
            if (typeof e.comment === 'string') e.comment = null;
            for (const k of ['commentText', 'readText', 'author']) if (k in e && e.type === 'comment_read') delete e[k];
            changed++;
            return JSON.stringify(e);
        });
        if (!changed) return 0;
        const tmp = `${this.logFile}.tmp`;
        writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
        renameSync(tmp, this.logFile);
        return changed;
    }

    startSession({ programmeId, programmeTitle, mode, characterName }) {
        this.currentSessionId = `show_${Date.now()}`;
        this.log({
            type: 'show_start',
            sessionId: this.currentSessionId,
            programmeId: programmeId || 'default',
            programmeTitle: programmeTitle || '雑談',
            mode: mode || 'live',
            characterName: characterName || 'host',
            at: new Date().toISOString(),
            epoch: Date.now()
        });
        return this.currentSessionId;
    }

    logSpeech({ turn, kind, act, actTitle, beatId, beatLabel, text, role, audioMs, ttsProvider, mood, effect, comment, verdict, similarity, elapsedMs, affect }) {
        this.log({
            type: 'speech',
            sessionId: this.currentSessionId,
            turn: Number(turn) || 0,
            kind: kind || 'autonomous',
            act: Number(act) || 1,
            actTitle: actTitle || '',
            beatId: beatId || '',
            beatLabel: beatLabel || '',
            text: String(text || '').slice(0, 500),
            role: role || 'host',
            audioMs: Number(audioMs) || 0,
            ttsProvider: ttsProvider || 'voicevox',
            mood: mood || 'neutral',
            effect: effect || 'none',
            comment: comment ? String(comment).slice(0, 300) : null,
            verdict: verdict || null,
            similarity: similarity !== undefined ? Number(similarity) : null,
            elapsedMs: Number(elapsedMs) || 0,
            ...(affect ? { affect } : {}),
            at: new Date().toISOString()
        });
    }

    logCommentRead({ author, commentText, readText, audioMs, elapsedMs }) {
        this.log({
            type: 'comment_read',
            sessionId: this.currentSessionId,
            author: author ? String(author).slice(0, 80) : 'viewer',
            commentText: String(commentText || '').slice(0, 300),
            readText: String(readText || '').slice(0, 300),
            audioMs: Number(audioMs) || 0,
            elapsedMs: Number(elapsedMs) || 0,
            at: new Date().toISOString()
        });
    }

    logParticipation(participation) {
        if (!this.currentSessionId) return;
        this.log({ type: 'participation', sessionId: this.currentSessionId, participation, at: new Date().toISOString() });
    }

    logProgression({ topicId, beatId, label, turn, elapsedMs }) {
        this.log({
            type: 'progress',
            sessionId: this.currentSessionId,
            topicId: topicId || '',
            beatId: beatId || '',
            label: label || '',
            turn: Number(turn) || 0,
            elapsedMs: Number(elapsedMs) || 0,
            at: new Date().toISOString()
        });
    }

    logRepair({ reason, attempt, beatId, instruction }) {
        this.log({
            type: 'content_repair',
            sessionId: this.currentSessionId,
            reason: String(reason || 'repetition'),
            attempt: Number(attempt) || 1,
            beatId: beatId || '',
            instruction: instruction ? String(instruction).slice(0, 200) : '',
            at: new Date().toISOString()
        });
    }

    /** Local-only: a line the gate refused (never aired), with the gate scores, so operators can tune prompts. */
    logRejected({ text, reason, kind, beatId, scores }) {
        this.log({ type: 'content_rejected', sessionId: this.currentSessionId, reason: String(reason || ''), kind: kind || '', beatId: beatId || '',
            text: String(text || '').slice(0, 220), scores: scores && typeof scores === 'object' ? scores : null });
    }
    logStalled({ reason }) {
        this.log({
            type: 'content_stalled',
            sessionId: this.currentSessionId,
            reason: String(reason || 'unknown'),
            at: new Date().toISOString()
        });
    }

    stopSession({ reason, stats }) {
        if (!this.currentSessionId) return;
        this.log({
            type: 'show_stop',
            sessionId: this.currentSessionId,
            reason: reason || 'operator',
            stats: stats || {},
            at: new Date().toISOString()
        });
        this.currentSessionId = null;
    }

    log(entry) {
        try {
            if (this.now() - this.prunedAt >= 3600000) this.pruneComments();
            appendFileSync(this.logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
        } catch { /* suppress write errors */ }
    }

    readEvents(sessionId = null) {
        if (!existsSync(this.logFile)) return [];
        try {
            const raw = readFileSync(this.logFile, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            const list = [];
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (!sessionId || obj.sessionId === sessionId) {
                        list.push(obj);
                    }
                } catch {}
            }
            return list;
        } catch {
            return [];
        }
    }

    /** Bounded, aggregate-only comparison. Do not load the whole transcript into memory. */
    async participationSessions(limit = 6) {
        if (!existsSync(this.logFile)) return [];
        limit = Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 6));
        const sessions = new Map();
        const input = createReadStream(this.logFile, { encoding: 'utf8' });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                let e; try { e = JSON.parse(line); } catch { continue; }
                if (e.type === 'show_start' && e.mode === 'live' && e.sessionId) {
                    sessions.set(e.sessionId, { sessionId: e.sessionId, startedAt: e.at, programmeTitle: e.programmeTitle, stoppedAt: null, participation: null });
                    while (sessions.size > limit) sessions.delete(sessions.keys().next().value);
                }
                const session = sessions.get(e.sessionId);
                if (!session) continue;
                if (e.type === 'participation') session.participation = e.participation;
                if (e.type === 'show_stop') {
                    session.stoppedAt = e.at;
                    if (e.stats?.participation) session.participation = e.stats.participation;
                }
            }
        } finally { lines.close(); input.destroy(); }
        return [...sessions.values()].reverse();
    }

    getSessions() {
        const events = this.readEvents();
        const map = new Map();
        for (const ev of events) {
            const sid = ev.sessionId || 'legacy';
            if (!map.has(sid)) {
                map.set(sid, {
                    sessionId: sid,
                    programmeId: ev.programmeId || '',
                    programmeTitle: ev.programmeTitle || '',
                    startedAt: ev.type === 'show_start' ? ev.at : null,
                    stoppedAt: null,
                    speechCount: 0,
                    commentCount: 0,
                    progressCount: 0,
                    repairCount: 0,
                    stalled: false,
                    lastAt: ev.at
                });
            }
            const s = map.get(sid);
            s.lastAt = ev.at;
            if (ev.type === 'show_start') {
                s.programmeId = ev.programmeId;
                s.programmeTitle = ev.programmeTitle;
                s.startedAt = ev.at;
            } else if (ev.type === 'speech') {
                s.speechCount++;
            } else if (ev.type === 'comment_read') {
                s.commentCount++;
            } else if (ev.type === 'progress') {
                s.progressCount++;
            } else if (ev.type === 'content_repair') {
                s.repairCount++;
            } else if (ev.type === 'content_stalled') {
                s.stalled = true;
            } else if (ev.type === 'show_stop') {
                s.stoppedAt = ev.at;
                s.stopReason = ev.reason;
            }
        }
        return Array.from(map.values()).reverse(); // latest first
    }

    analyzeSession(sessionId = null) {
        const allSessions = this.getSessions();
        const targetId = sessionId || allSessions[0]?.sessionId;
        if (!targetId) return null;

        const events = this.readEvents(targetId);
        if (!events.length) return null;

        const startEv = events.find(e => e.type === 'show_start') || {};
        const stopEv = events.find(e => e.type === 'show_stop') || {};
        const speeches = events.filter(e => e.type === 'speech');
        const comments = events.filter(e => e.type === 'comment_read');
        const progresses = events.filter(e => e.type === 'progress');
        const repairs = events.filter(e => e.type === 'content_repair');
        const stalls = events.filter(e => e.type === 'content_stalled');
        const participation = stopEv.stats?.participation || events.findLast(e => e.type === 'participation')?.participation || null;

        const startTime = new Date(startEv.at || events[0].at).getTime();
        const endTime = new Date(stopEv.at || events.at(-1).at).getTime();
        const durationSec = Math.max(0, Math.round((endTime - startTime) / 1000));

        let totalChars = 0;
        let totalSpeechAudioMs = 0;
        let maxSimilarity = 0;
        let sumSimilarity = 0;
        let simCount = 0;

        for (const s of speeches) {
            totalChars += s.text?.length || 0;
            totalSpeechAudioMs += s.audioMs || 0;
            if (typeof s.similarity === 'number' && Number.isFinite(s.similarity)) {
                sumSimilarity += s.similarity;
                simCount++;
                if (s.similarity > maxSimilarity) maxSimilarity = s.similarity;
            }
        }

        const avgSimilarity = simCount ? Math.round((sumSimilarity / simCount) * 1000) / 1000 : 0;
        const avgCharsPerSec = totalSpeechAudioMs > 0 ? Math.round((totalChars / (totalSpeechAudioMs / 1000)) * 10) / 10 : 0;

        // Distinct beats achieved
        const distinctBeats = new Set(progresses.map(p => `${p.topicId}/${p.beatId}`).filter(Boolean));

        const timeline = [];
        for (const e of events) {
            if (e.type === 'speech' || e.type === 'comment_read' || e.type === 'content_repair' || e.type === 'content_stalled') {
                const atTime = new Date(e.at).getTime();
                const offsetSec = Math.max(0, Math.round((atTime - startTime) / 1000));
                const mm = String(Math.floor(offsetSec / 60)).padStart(2, '0');
                const ss = String(offsetSec % 60).padStart(2, '0');
                timeline.push({
                    time: `${mm}:${ss}`,
                    offsetSec,
                    type: e.type,
                    role: e.role || (e.type === 'comment_read' ? 'comment' : 'system'),
                    label: e.beatLabel || e.kind || (e.type === 'comment_read' ? 'コメント読上' : e.type),
                    text: e.type === 'comment_read' ? e.readText : e.text || e.reason,
                    commentOriginal: e.comment || e.commentText || null,
                    author: e.author || null,
                    audioMs: e.audioMs || 0,
                    similarity: e.similarity ?? null,
                    mood: e.mood || null
                });
            }
        }

        return {
            sessionId: targetId,
            programmeId: startEv.programmeId || '',
            programmeTitle: startEv.programmeTitle || '企画雑談',
            startedAt: startEv.at || events[0].at,
            stoppedAt: stopEv.at || events.at(-1).at,
            stopReason: stopEv.reason || (stalls.length ? 'stalled' : 'running_or_abrupt'),
            durationSec,
            durationFormatted: `${Math.floor(durationSec / 60)}分${durationSec % 60}秒`,
            participation,
            summary: {
                speechCount: speeches.length,
                totalChars,
                avgCharsPerTurn: speeches.length ? Math.round(totalChars / speeches.length) : 0,
                totalAudioSec: Math.round(totalSpeechAudioMs / 1000),
                avgCharsPerSec,
                commentsRead: comments.length,
                progressions: progresses.length,
                distinctBeatsCount: distinctBeats.size,
                repairAttempts: repairs.length,
                stalled: stalls.length > 0,
                avgSimilarity,
                maxSimilarity: Math.round(maxSimilarity * 1000) / 1000
            },
            timeline
        };
    }
}
