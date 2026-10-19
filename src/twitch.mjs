import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { hash, sleep, boundedBody } from './util.mjs';
const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
export function reconnectURL(value) {
    const u = new URL(value);
    if (u.protocol !== 'wss:' || u.hostname !== 'eventsub.wss.twitch.tv' || u.port || u.username || u.password) throw new Error('Invalid reconnect URL');
    return u.href;
}
export function chatMessage(m, channel, joinedAt, seen, now = Date.now()) {
    const e = m.payload?.event, meta = m.metadata, time = Date.parse(meta?.message_timestamp);
    if (meta?.message_type !== 'notification' || m.payload?.subscription?.type !== 'channel.chat.message' || e?.broadcaster_user_id !== channel || !e?.message_id || !e.chatter_user_id || !Number.isFinite(time) || time < joinedAt || now - time > 60000 || time > now + 10000 || seen.has(e.message_id)) return null;
    if (typeof e.message?.text !== 'string' || !e.message.text.trim() || e.message.text.length > 500) return null;
    seen.add(e.message_id); if (seen.size > 5000) seen.delete(seen.values().next().value);
    return { id: `twitch:${e.message_id}`, text: e.message.text, source: 'twitch', author: `twitch:${hash(e.chatter_user_id).slice(0, 16)}`, name: String(e.chatter_user_name || '') };
}
export class Twitch {
    constructor(c, { fetchFn = fetch, WebSocketImpl = WebSocket } = {}) { this.c = c; this.fetchFn = fetchFn; this.WS = WebSocketImpl; }
    async json(url, options, signal) {
        const r = await this.fetchFn(url, { ...options, signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]), redirect: 'error' });
        if (!r.ok) { await r.body?.cancel(); const e = new Error(`Twitch HTTP ${r.status}`); e.status = r.status; throw e; }
        return JSON.parse((await boundedBody(r, 64000)).toString('utf8'));
    }
    async credentials(signal) {
        let a = JSON.parse(readFileSync(this.c.twitchAuthFile, 'utf8'));
        const validate = () => this.json('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${a.access_token}` } }, signal);
        let v;
        try { v = await validate(); } catch (e) { if (e.status !== 401) throw e; }
        if (!v || v.expires_in < 120) {
            const fresh = await this.json('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: a.client_id, grant_type: 'refresh_token', refresh_token: a.refresh_token }) }, signal);
            if (!fresh.access_token || !fresh.refresh_token) throw new Error('Missing refreshed credentials');
            a = { ...a, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 };
            // Public-client refresh tokens rotate: persist before any further network call.
            const temp = `${this.c.twitchAuthFile}.tmp`;
            writeFileSync(temp, JSON.stringify(a), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, this.c.twitchAuthFile);
            v = await validate();
        }
        if (v.client_id !== a.client_id || v.login !== this.c.twitchChannel || !v.scopes?.includes('user:read:chat') || v.scopes.some(s => s !== 'user:read:chat')) throw new Error('Unexpected Twitch identity or scopes');
        return { ...a, user_id: v.user_id, expires_in: v.expires_in };
    }
    session(auth, ingest, onStatus, signal, seen, joinedAt) {
        return new Promise((resolve, reject) => {
            const sockets = new Set(); let done = false, active, refreshTimer;
            const finish = error => {
                if (done) return; done = true;
                clearTimeout(refreshTimer); signal.removeEventListener('abort', abort);
                for (const s of sockets) { clearTimeout(s.timer); s.ws.close(); }
                error ? reject(error) : resolve();
            };
            const abort = () => finish();
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) return finish();
            // Revalidate within an hour, and reconnect before the access token expires.
            refreshTimer = setTimeout(() => finish(), Math.min(45 * 60000, Math.max(1000, (auth.expires_in - 60) * 1000)));
            const connect = (url, previous) => {
                const s = { ws: new this.WS(url), timer: null, keepalive: 15000, migrating: false }; sockets.add(s);
                const reset = () => { clearTimeout(s.timer); s.timer = setTimeout(() => finish(new Error('Twitch keepalive timeout')), s.keepalive); };
                reset();
                s.ws.addEventListener('error', () => finish(new Error('Twitch socket error')));
                s.ws.addEventListener('close', () => { clearTimeout(s.timer); sockets.delete(s); if (!done && !s.migrating && (!active || active === s)) finish(new Error('Twitch disconnected')); });
                s.ws.addEventListener('message', async event => {
                    if (done || signal.aborted) return;
                    try {
                        if (String(event.data).length > 100000) throw new Error('Oversized Twitch event');
                        const m = JSON.parse(String(event.data)); reset();
                        switch (m.metadata?.message_type) {
                            case 'session_welcome': {
                                const session = m.payload.session;
                                s.keepalive = (session.keepalive_timeout_seconds || 10) * 1000 + 2000; reset();
                                if (!previous) await this.json('https://api.twitch.tv/helix/eventsub/subscriptions', {
                                    method: 'POST', headers: { Authorization: `Bearer ${auth.access_token}`, 'Client-Id': auth.client_id, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: auth.user_id, user_id: auth.user_id }, transport: { method: 'websocket', session_id: session.id } })
                                }, signal);
                                if (done || signal.aborted) return;
                                active = s;
                                if (previous) { clearTimeout(previous.timer); previous.ws.close(); }
                                onStatus('connected'); break;
                            }
                            case 'session_reconnect':
                                if (!s.migrating) { s.migrating = true; connect(reconnectURL(m.payload.session.reconnect_url), s); } break;
                            case 'revocation': { const e = new Error('Twitch permission revoked'); e.status = 403; finish(e); break; }
                            case 'notification': { const chat = chatMessage(m, auth.user_id, joinedAt, seen); if (chat) ingest(chat); break; }
                        }
                    } catch (e) { finish(e); }
                });
            };
            try { connect(ENDPOINT); } catch (e) { finish(e); }
        });
    }
    async watch(ingest, onStatus, signal) {
        if (!this.c.twitchEnabled || this.c.mode === 'demo') return;
        const seen = new Set(), joinedAt = Date.now(); let failures = 0;
        while (!signal.aborted) {
            try {
                onStatus('connecting'); const auth = await this.credentials(signal);
                await this.session(auth, ingest, state => { failures = 0; onStatus(state); }, signal, seen, joinedAt);
            } catch (e) {
                if (signal.aborted) break;
                if ([400, 401, 403].includes(e.status) || e.code === 'ENOENT' || /identity|credentials|scopes/.test(e.message)) { onStatus('auth_error'); return; }
                failures++; onStatus('reconnecting');
            }
            if (!signal.aborted) { try { await sleep(Math.min(60000, 1000 * 2 ** Math.min(failures, 5)), signal); } catch { break; } }
        }
        onStatus('stopped');
    }
}
