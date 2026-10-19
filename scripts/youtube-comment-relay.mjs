// Temporary, explicitly started receiver for an already-running Studio whose native YouTube worker exhausted its local cap.
// It never changes Studio budgets, restarts Studio/OBS, sends YouTube messages, or synthesizes test comments.
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, loadEnv } from '../src/config.mjs';
import { YouTube } from '../src/youtube.mjs';
import { streamPages } from '../src/youtube-stream.mjs';
import { hash, request, sleep } from '../src/util.mjs';

const MAX_IDS = 5000;
export class SeenIds {
    constructor(file = null) {
        this.file = file;
        const ids = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).ids : [];
        if (!Array.isArray(ids) || ids.length > MAX_IDS || ids.some(x => !/^[a-f0-9]{64}$/.test(x))) throw new Error('Invalid relay dedupe state');
        this.ids = new Set(ids);
    }
    has(id) { return this.ids.has(id); }
    add(id) {
        this.ids.add(id);
        while (this.ids.size > MAX_IDS) this.ids.delete(this.ids.values().next().value);
        if (this.file) {
            writeFileSync(`${this.file}.tmp`, JSON.stringify({ ids: [...this.ids] }), { mode: 0o600 });
            renameSync(`${this.file}.tmp`, this.file);
        }
    }
}

export class YouTubeCommentRelay {
    constructor({ video, maxRpcs = 900, maxMs = 150 * 60000, session, resolveChat, stream, forward,
        seen = new SeenIds(), log = () => {}, now = Date.now, wait = sleep, healthMs = 5000, forwardGapMs = 7100 }) {
        if (!/^[\w-]{11}$/.test(video) || !Number.isInteger(maxRpcs) || maxRpcs < 1 || maxRpcs > 900 ||
            !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 150 * 60000 || forwardGapMs < 7000) throw new Error('Invalid relay bounds');
        Object.assign(this, { video, maxRpcs, maxMs, session, resolveChat, stream, forward, seen, log, now, wait, healthMs, forwardGapMs });
        this.controller = new AbortController(); this.queue = []; this.rpcStarts = 0; this.forwarded = 0; this.lastForwardAt = -Infinity;
    }
    record(event, fields = {}) { this.log({ at: new Date(this.now()).toISOString(), source: 'youtube', event, ...fields }); }
    stop(reason) {
        if (this.controller.signal.aborted) return;
        this.reason = reason; this.controller.abort(new Error(reason));
        this.queue.length = 0;
        this.record('stopped', { reason, rpcStarts: this.rpcStarts, forwarded: this.forwarded });
    }
    checkStatus(s) {
        if (!s?.running) { this.stop('studio_stopped'); return false; }
        if (this.epoch !== undefined && s.epoch !== this.epoch) { this.stop('session_changed'); return false; }
        // Only while the Studio's own receiver is out of the game (no duplicate comments): its local cap was reached, or
        // its stored OAuth grant is no longer valid (2026-10-06 live: invalid_grant left YouTube chat unread).
        if (!['budget_exhausted', 'auth_or_configuration_error'].includes(s.youtube)) { this.stop('native_receiver_state_changed'); return false; }
        if (!Number.isFinite(s.remainingMs) || s.remainingMs <= 0 || (this.endAt !== undefined && this.now() >= this.endAt)) {
            this.stop('session_deadline'); return false;
        }
        return true;
    }
    receive(page) {
        if (page.offlineAt || page.items?.some(x => x.snippet?.type === 'chatEndedEvent')) { this.stop('youtube_ended'); return; }
        this.pageToken = page.nextPageToken || this.pageToken;
        for (const m of page.items || []) {
            const at = Date.parse(m.snippet?.publishedAt), text = m.snippet?.textMessageDetails?.messageText ?? m.snippet?.displayMessage;
            if (!m.id || m.snippet?.type !== 'textMessageEvent' || !Number.isFinite(at) || at < this.startedAt || at > this.now() ||
                this.now() - at > 60000 || typeof text !== 'string' || !text.trim() || text.length > 500) continue;
            const id = hash(`${this.video}:${m.id}`);
            if (this.seen.has(id)) continue;
            this.seen.add(id); // Persist before a possible relay; an uncertain POST must never replay after a restart.
            if (this.queue.length >= 20) { this.record('dropped', { reason: 'relay_queue_full', messageHash: id }); continue; }
            this.queue.push({ id, text, publishedAt: at });
            this.record('queued', { messageHash: id, publishedAt: new Date(at).toISOString() });
        }
    }
    async healthLoop() {
        const signal = this.controller.signal;
        while (!signal.aborted) {
            await this.wait(this.healthMs, signal);
            if (!this.checkStatus(await this.session(signal))) return;
        }
    }
    async forwardLoop() {
        const signal = this.controller.signal;
        while (!signal.aborted) {
            if (!this.queue.length) { await this.wait(250, signal); continue; }
            const gap = this.lastForwardAt + this.forwardGapMs - this.now();
            if (gap > 0) { await this.wait(Math.min(gap, 1000), signal); continue; }
            // Recheck immediately before every POST as well as on the independent five-second monitor.
            if (!this.checkStatus(await this.session(signal))) return;
            const item = this.queue.shift();
            if (this.now() - item.publishedAt > 60000) { this.record('dropped', { reason: 'stale', messageHash: item.id }); continue; }
            this.lastForwardAt = this.now();
            const result = await this.forward(item.text, signal);
            if (result?.accepted) this.forwarded++;
            this.record(result?.accepted ? 'forwarded' : 'rejected', {
                messageHash: item.id, engineSource: 'local', engineId: typeof result?.id === 'string' ? result.id : undefined,
                reason: ['not_running', 'invalid', 'local_gate', 'duplicate', 'author_cooldown', 'queue_full', 'comments_paused'].includes(result?.reason) ? result.reason : undefined,
            });
        }
    }
    async receiverLoop(liveChatId) {
        const signal = this.controller.signal; let failures = 0;
        while (!signal.aborted) {
            if (this.now() >= this.endAt) { this.stop('session_deadline'); return; }
            if (this.rpcStarts >= this.maxRpcs) { this.stop('rpc_limit'); return; }
            this.rpcStarts++;
            this.record('rpc_start', { attempt: this.rpcStarts, maxRpcs: this.maxRpcs });
            try {
                for await (const page of this.stream({ liveChatId, pageToken: this.pageToken, signal })) {
                    if (signal.aborted) return;
                    this.receive(page); failures = 0;
                }
                if (signal.aborted) return;
                this.record('rpc_completed', { attempt: this.rpcStarts });
                await this.wait(2000, signal);
            } catch (e) {
                if (signal.aborted) return;
                const code = Number(e.code), status = Number(e.status);
                this.record('rpc_error', { code: Number.isFinite(code) ? code : undefined, status: Number.isFinite(status) ? status : undefined });
                if ([3, 5, 7, 8, 12, 16].includes(code) || [400, 401, 403, 404, 429].includes(status) || e.code === 'CONFIGURATION' || e.code === 'MISSING_GRPC') {
                    this.stop('youtube_auth_quota_or_configuration'); return;
                }
                if (++failures >= 8) { this.stop('consecutive_errors'); return; }
                await this.wait(Math.min(60000, 2000 * 2 ** (failures - 1)), signal);
            }
        }
    }
    async run() {
        const signal = this.controller.signal; let timer;
        try {
            this.startedAt = this.now();
            const initial = await this.session(signal);
            if (!this.checkStatus(initial)) return this.reason;
            this.epoch = initial.epoch;
            this.endAt = Math.min(this.startedAt + this.maxMs, this.now() + initial.remainingMs);
            timer = setTimeout(() => this.stop('session_deadline'), Math.max(1, this.endAt - this.now()));
            this.record('started', { video: this.video, epoch: this.epoch, maxRpcs: this.maxRpcs,
                endsAt: new Date(this.endAt).toISOString(), engineSource: 'local', forwardingGapMs: this.forwardGapMs });
            // Start the lifecycle monitor before remote discovery, so a stop cancels slow remote work as well.
            const guarded = async (fn, reason) => { try { await fn(); } catch { if (!signal.aborted) this.stop(reason); } };
            const health = guarded(() => this.healthLoop(), 'studio_health_error');
            const receiver = guarded(async () => {
                const chat = await this.resolveChat(this.video, signal);
                if (!chat) { this.stop('no_active_chat'); return; }
                await this.receiverLoop(chat);
            }, 'youtube_discovery_error');
            const sender = guarded(() => this.forwardLoop(), 'relay_forward_error');
            await Promise.all([health, receiver, sender]);
        } catch { if (!signal.aborted) this.stop('startup_error'); }
        finally { clearTimeout(timer); }
        return this.reason;
    }
}

async function main() {
    loadEnv(); const c = config();
    const args = process.argv.slice(2), allowed = new Set(['--video', '--max-rpcs', '--max-minutes']);
    if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !allowed.has(x))) throw new Error('Usage: --video VIDEO_ID --max-rpcs 900 --max-minutes 150');
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
    if (!options['--video']) throw new Error('An explicit live --video ID is required');
    const lock = `${c.dataDir}/youtube-comment-relay.lock`;
    const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
    try {
        const tokenFile = `${c.dataDir}/youtube-oauth.json`;
        if (!c.youtubeRefresh && existsSync(tokenFile)) c.youtubeRefresh = JSON.parse(readFileSync(tokenFile, 'utf8')).refresh_token || '';
        const youtube = new YouTube(c, { reserve() { throw new Error('Studio ledger is never changed by relay'); } });
        const base = `http://127.0.0.1:${c.port}`;
        const local = (path, signal, body) => request(`${base}${path}`, { signal, body, timeout: 4000, headers: { Authorization: `Bearer ${c.adminToken}` } });
        const logFile = `${c.dataDir}/youtube-comment-relay.jsonl`;
        const relay = new YouTubeCommentRelay({
            video: options['--video'], maxRpcs: Number(options['--max-rpcs'] || 900), maxMs: Number(options['--max-minutes'] || 150) * 60000,
            session: async signal => (await local('/api/session', signal)).status,
            resolveChat: async (video, signal) => {
                const access = c.youtubeKey ? '' : await youtube.token(signal);
                const query = new URLSearchParams({ part: 'liveStreamingDetails', id: video, ...(c.youtubeKey ? { key: c.youtubeKey } : {}) });
                const data = await request(`https://www.googleapis.com/youtube/v3/videos?${query}`, {
                    signal, timeout: 10000, headers: access ? { Authorization: `Bearer ${access}` } : {},
                });
                const details = data.items?.[0]?.liveStreamingDetails;
                return details?.actualEndTime ? '' : details?.activeLiveChatId;
            },
            stream: async function* (options) {
                const accessToken = c.youtubeKey ? '' : await youtube.token(options.signal);
                yield* streamPages({ ...options, apiKey: c.youtubeKey, accessToken });
            },
            forward: (text, signal) => local('/api/chat', signal, { text }),
            seen: new SeenIds(`${c.dataDir}/youtube-comment-relay-seen.json`),
            log: entry => { const line = JSON.stringify(entry) + '\n'; appendFileSync(logFile, line, { mode: 0o600 }); process.stdout.write(line); },
        });
        for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => relay.stop('operator_stop'));
        await relay.run();
        if (!['studio_stopped', 'session_changed', 'session_deadline', 'native_receiver_state_changed', 'youtube_ended', 'operator_stop'].includes(relay.reason)) process.exitCode = 1;
    } finally { unlinkSync(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => { console.error('Relay could not start; check its finite bounds, credentials, and single-instance lock. No automatic retry.'); process.exitCode = 1; });
}
