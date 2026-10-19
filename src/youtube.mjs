import { request, sleep, hash, boundedBody } from './util.mjs';
import { streamPages } from './youtube-stream.mjs';
/** Local-only start check. Call with a fresh Ledger.snapshot(), which rolls its window at UTC midnight. */
export function youtubeChatStartIssue(c, usage) {
    if (c.mode !== 'live' || c.readComments !== true || c.streamTarget === 'twitch') return null;
    const discover = c.streamTarget === 'simulcast' && !!c.youtubeChannel;
    if (!c.youtubeVideo && !discover) return null;
    const limit = usage?.limits?.youtube, used = usage?.calls?.youtube || 0;
    if (!Number.isFinite(limit)) return null;
    // Discovery (when needed), active-chat lookup, and the first stream/poll all reserve requests.
    const required = discover ? 3 : 2, remaining = Math.max(0, limit - used);
    if (remaining >= required) return null;
    return { code: 'YOUTUBE_CHAT_BUDGET', error: `YouTubeコメント取得の本日の残り枠は${remaining}回です（上限${limit}回）。接続に必要な${required}回分がなく、コメント読み上げ・返答を開始できません。日次枠の更新後に再確認してください（UTC基準）。` };
}
export class YouTube {
    constructor(c, ledger, fetchFn = fetch, streamFn = streamPages) { this.c = c; this.streamFn = streamFn; this.ledger = ledger; this.fetchFn = fetchFn; this.access = null; this.refreshing = null; }
    async token(signal) {
        if (this.access && Date.now() < this.access.until)
            return this.access.value;
        if (this.refreshing)
            return this.refreshing;
        this.refreshing = (async () => {
            if (!this.c.youtubeClient || !this.c.youtubeSecret || !this.c.youtubeRefresh) { const e = new Error('YouTube OAuth credentials missing'); e.code = 'CONFIGURATION'; throw e; }
            const r = await this.fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.c.youtubeClient, client_secret: this.c.youtubeSecret, refresh_token: this.c.youtubeRefresh, grant_type: 'refresh_token' }), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]), redirect: 'error' });
            if (!r.ok) {
                await r.body?.cancel();
                const e = new Error(`YouTube OAuth HTTP ${r.status}`); e.status = r.status; throw e;
            }
            const data = JSON.parse((await boundedBody(r, 64000)).toString('utf8'));
            if (!data.access_token)
                throw new Error('Missing OAuth token');
            this.access = { value: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000 };
            return this.access.value;
        })().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }
    async get(path, params, signal) {
        this.ledger.reserve('youtube');
        const token = this.c.youtubeKey ? null : await this.token(signal);
        return request(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, ...(this.c.youtubeKey ? { key: this.c.youtubeKey } : {}) })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal, fetchFn: this.fetchFn, timeout: 12000 });
    }
    async watch(ingest, onStatus, signal) {
        const discover = this.c.streamTarget === 'simulcast' && !!this.c.youtubeChannel;
        if ((!this.c.youtubeVideo && !discover) || this.c.mode === 'demo') return;
        let videoId = discover ? '' : this.c.youtubeVideo;
        let liveChatId = '', pageToken = '', failures = 0, transport = this.c.youtubeTransport || 'stream', streamBackAt = 0;
        let joinedAt = Date.now(), waitingForBudget = false;
        const seen = new Set();
        const delay = ms => sleep(this.c.youtubeRetryMs ?? ms, signal);
        // The relay may end its broadcast and open a new one while the Studio keeps running (an OBS restart mid-show):
        // with discovery, an ended chat means "look for the channel's active broadcast again", not "stop reading".
        const ended = async () => {
            if (!discover) { onStatus('ended'); return false; }
            videoId = ''; this.videoId = ''; liveChatId = ''; pageToken = ''; joinedAt = Date.now();
            onStatus('waiting_for_broadcast'); await delay(5000); return true;
        };
        const consume = page => {
            if (page.offlineAt || page.items?.some(m => m.snippet?.type === 'chatEndedEvent')) return false;
            pageToken = page.nextPageToken || pageToken;
            for (const m of (page.items || [])) {
                const published = Date.parse(m.snippet?.publishedAt);
                // First request can contain history: never replay before this connection session.
                if (!m.id || seen.has(m.id) || m.snippet?.type !== 'textMessageEvent' || !Number.isFinite(published) || published < joinedAt || Date.now() - published > 60000) continue;
                seen.add(m.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
                ingest({ id: m.id, text: m.snippet.textMessageDetails?.messageText || m.snippet.displayMessage || '', author: hash(m.authorDetails?.channelId || m.snippet.authorChannelId || m.id).slice(0, 16), name: String(m.authorDetails?.displayName || ''), source: 'youtube' });
            }
            return true;
        };
        while (!signal.aborted) {
            try {
                // snapshot rolls the local ledger at UTC midnight. Waiting must not
                // reserve requests or refresh OAuth, even when the cap is zero.
                const usage = this.ledger.snapshot(), limit = usage.limits?.youtube;
                if (Number.isFinite(limit) && (usage.calls?.youtube || 0) >= limit) {
                    if (!waitingForBudget) onStatus('budget_waiting');
                    waitingForBudget = true;
                    const midnight = Date.parse(`${usage.day}T00:00:00Z`) + 86400000;
                    const remaining = Number.isFinite(midnight) ? midnight - Date.now() : 60000;
                    await sleep(Math.max(1000, Math.min(60000, remaining)), signal);
                    continue;
                }
                if (waitingForBudget) {
                    // After a long pause, revalidate the broadcast and discard its
                    // stale cursor/history, while keeping duplicate suppression.
                    videoId = discover ? '' : this.c.youtubeVideo;
                    liveChatId = ''; pageToken = ''; failures = 0;
                    joinedAt = Date.now(); waitingForBudget = false;
                    onStatus('reconnecting');
                }
                if (!videoId && discover) {
                    this.ledger.reserve('youtube'); const token = await this.token(signal);
                    const active = await request('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id,snippet,status&broadcastStatus=active&broadcastType=all', {headers:{Authorization:`Bearer ${token}`},signal,fetchFn:this.fetchFn});
                    const matches = (active.items || []).filter(b => b.snippet?.channelId === this.c.youtubeChannel);
                    if (matches.length !== 1) { onStatus('waiting_for_broadcast'); await delay(5000); continue; }
                    videoId = matches[0].id;
                }
                this.videoId = videoId;
                if (!liveChatId) {
                    const video = await this.get('videos', { part: 'liveStreamingDetails', id: videoId }, signal);
                    const details = video.items?.[0]?.liveStreamingDetails;
                    if (details?.actualEndTime) { if (await ended()) continue; return; }
                    liveChatId = details?.activeLiveChatId || '';
                    if (!liveChatId) { onStatus('waiting_for_broadcast'); await delay(5000); continue; }
                }
                if (transport === 'stream') {
                    this.ledger.reserve('youtube');
                    const token = this.c.youtubeKey ? null : await this.token(signal);
                    // The chat was found (activeLiveChatId above). streamList sends nothing until the first message, so an
                    // empty chat is a healthy, open subscription: say so instead of an endless "connecting" (2026-10-03).
                    onStatus('listening');
                    for await (const page of this.streamFn({ liveChatId, pageToken, apiKey: this.c.youtubeKey, accessToken: token, signal })) {
                        if (signal.aborted) break;
                        if (!consume(page)) { if (await ended()) break; return; }
                        failures = 0; onStatus('connected');
                    }
                    // A server may end a healthy RPC; resume with its last page token.
                    if (!signal.aborted && videoId) { onStatus('reconnecting'); await delay(1000); }
                } else {
                    const page = await this.get('liveChat/messages', { liveChatId, part: 'snippet,authorDetails', maxResults: '200', ...(pageToken ? { pageToken } : {}) }, signal);
                    if (!consume(page)) { if (await ended()) continue; return; }
                    failures = 0; onStatus('polling_degraded');
                    // A stand-in for a refused stream polls gently (>= 10 s) and hands back to the stream when its wait is over.
                    await sleep(Math.max(streamBackAt ? 10000 : 0, this.c.youtubePollMs || 1000, Number(page.pollingIntervalMillis) || 15000), signal);
                    if (streamBackAt && Date.now() >= streamBackAt) { transport = 'stream'; streamBackAt = 0; }
                }
            } catch (e) {
                if (signal.aborted) return;
                if (e.code === 'MISSING_GRPC' || e.code === 12) { transport = 'poll'; onStatus('polling_degraded'); continue; }
                if (e.code === 'CONFIGURATION' || e.status === 400) { onStatus('auth_or_configuration_error'); return; }
                // A concurrent consumer may exhaust the ledger after our snapshot.
                // Only our local cap is recoverable here; provider quota errors are separate.
                if (e.message === 'Daily youtube call limit reached') {
                    if (!waitingForBudget) onStatus('budget_waiting');
                    waitingForBudget = true;
                    continue;
                }
                // Google's daily quota (reset at Pacific midnight) or a permission problem: say so, then look again every
                // 15 minutes (a few units per try) instead of staying off until the Studio restarts (live 2026-10-07:
                // the quota ran out mid-show and comments never came back).
                if (e.status === 403 || e.code === 7 || e.code === 8) {
                    // Live 2026-10-10: the stream was refused (gRPC) while the REST list still read the chat, and comments
                    // stayed off for 15 minutes. Say what was refused (no secrets), and let polling carry the chat meanwhile.
                    console.error(`YouTube chat ${transport} refused: ${e.status ?? ''} ${e.code ?? ''} ${e.reason ?? ''} ${String(e.details || e.message || '').replace(/[\r\n]+/g, ' ').slice(0, 160)}`);
                    if (transport === 'stream' && e.status !== 403) {
                        transport = 'poll'; streamBackAt = Date.now() + (this.c.youtubeQuotaRetryMs ?? 900000);
                        onStatus('polling_degraded');
                        continue;
                    }
                    onStatus('permission_or_quota_error');
                    try { await sleep(this.c.youtubeQuotaRetryMs ?? 900000, signal); } catch { return; }
                    continue;
                }
                if (e.status === 401 || e.code === 16) {
                    this.access = null;
                    if (this.c.youtubeKey || ++failures > 2) { onStatus('auth_error'); return; }
                } else if (e.status === 404 || e.code === 5) { liveChatId = ''; pageToken = ''; }
                failures++;
                onStatus('reconnecting');
                try { await delay(Math.min(60000, 1000 * 2 ** Math.min(failures, 5)) + Math.floor(Math.random() * 500)); } catch { return; }
            }
        }
    }
}
