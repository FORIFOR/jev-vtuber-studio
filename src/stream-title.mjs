// A new title for every broadcast (operator 2026-10-11: viewers noticed the title never changed; the Twitch title had
// been the same since setup and the YouTube one was only ever changed by hand). Once OBS is transmitting, the Studio
// numbers the broadcast and writes one title to YouTube and Twitch. A failure never stops the stream: it is reported.
// YouTube: the relay (Restream) creates its own broadcast a little after OBS starts, so the channel's active broadcast is
// looked up for a while, then retitled with the youtube.force-ssl token (npm run youtube:auth -- --schedule).
// Twitch: a token of its own with only channel:manage:broadcast (node scripts/twitch-auth.mjs start --title); the chat
// token stays read-only.
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, accessToken } from './youtube-schedule.mjs';

export const TWITCH_TITLE_SCOPE = 'channel:manage:broadcast';
const YT_MAX = 100, TWITCH_MAX = 140;

/** 【game】goal｜programme #n【name / AI VTuber】; the number alone makes each title differ from the last. A label
 * (STREAM_TITLE_LABEL, e.g. 最終回) takes the number's place and leads the title: 【game】最終回！goal｜programme【…】. */
export function streamTitle(c, n) {
    const clean = v => String(v ?? '').replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    const game = clean(c.game?.title), goal = clean(c.gameGoal), show = clean(c.programme?.title || c.character?.channel), name = clean(c.character?.name), label = clean(c.streamTitleLabel);
    const tail = `${show}${label ? '' : `${show ? ' ' : ''}#${n}`}${name ? `【${name} / AI VTuber】` : ''}`;
    let head = `${game ? `【${game}】` : ''}${label ? `${label}！` : ''}${goal}`;
    // The goal gives way first: the number and the names always fit.
    const room = YT_MAX - tail.length - (head ? 1 : 0);
    if (head.length > room) head = room > 1 ? `${head.slice(0, room - 1)}…` : '';
    return head ? `${head}｜${tail}` : tail;
}

export class StreamTitler {
    constructor(c, { fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), findMs = 180000, pollMs = 10000, now = Date.now, holdMs = [30000, 60000, 120000, 300000] } = {}) {
        Object.assign(this, { c, fetchFn, sleep, findMs, pollMs, now, holdMs });
        this.enabled = !!c.streamTitle && c.mode === 'live';
        this.file = join(c.dataDir, 'stream-title.json');
        this.state = { status: this.enabled ? 'idle' : 'disabled' };
    }
    /** The next broadcast number, kept in data/stream-title.json (editable to continue an existing count). */
    next() {
        let last = 0;
        try { last = Number(JSON.parse(readFileSync(this.file, 'utf8')).number) || 0; } catch { }
        return last + 1;
    }
    save(record) {
        const temp = `${this.file}.tmp`;
        writeFileSync(temp, JSON.stringify(record, null, 2)); renameSync(temp, this.file);
    }
    targets() {
        const t = this.c.streamTarget;
        return { youtube: !t || t === 'youtube' || t === 'simulcast', twitch: t === 'twitch' || t === 'simulcast' };
    }
    /** -> { status: 'done'|'partial'|'failed'|'disabled', title, number, youtube, twitch } (never throws). */
    async apply() {
        if (!this.enabled) return this.state;
        if (this.running) return this.running;
        this.running = (async () => {
            const number = this.next(), title = streamTitle(this.c, number), want = this.targets();
            this.state = { status: 'running', title, number, at: this.now() };
            // Counted before the calls: a retry or a restart takes the next number, so the title still changes.
            this.save({ number, title, at: new Date(this.now()).toISOString() });
            const run = async (on, fn) => { if (!on) return 'skipped'; try { return await fn(); } catch (e) { return `failed: ${String(e.message || e).slice(0, 160)}`; } };
            const [youtube, twitch] = await Promise.all([run(want.youtube, () => this.youtube(title)), run(want.twitch, () => this.twitch(title))]);
            const results = [youtube, twitch].filter(r => r !== 'skipped'), failed = results.filter(r => r.startsWith('failed')).length;
            const status = !failed ? 'done' : failed === results.length ? 'failed' : 'partial';
            this.state = { status, title, number, youtube, twitch, at: this.now() };
            // Live 2026-10-11: the Twitch title was back to the relay's own a few seconds after it was set (the relay writes
            // its title when the stream goes live). Look again for a few minutes and put ours back if it was replaced.
            if (twitch === 'done') this.hold = this.holdTwitch(title).catch(() => {});
            // The broadcast's id ("done <id>") stays with the number: the clip studio links its clips to the archive.
            if (/^done \S+/.test(youtube)) this.save({ number, title, at: new Date(this.now()).toISOString(), youtube });
            return this.state;
        })();
        try { return await this.running; } finally { this.running = null; }
    }
    async youtube(title) {
        const file = join(this.c.dataDir, 'youtube-schedule-oauth.json');
        if (!existsSync(file)) throw new Error('YouTube の書き込み用認証がありません（npm run youtube:auth -- --schedule）');
        const token = await accessToken({ clientId: this.c.youtubeClient, clientSecret: this.c.youtubeSecret, refreshToken: JSON.parse(readFileSync(file, 'utf8')).refresh_token }, this.fetchFn);
        // The relay's broadcast appears after OBS starts: look for the channel's one active broadcast for a while.
        const until = this.now() + this.findMs;
        let id = '';
        while (!id) {
            const active = await api(this.fetchFn, token, 'liveBroadcasts?part=id,snippet&broadcastStatus=active&broadcastType=all&maxResults=5');
            const mine = (active.items || []).filter(b => !this.c.youtubeChannel || b.snippet?.channelId === this.c.youtubeChannel);
            if (mine.length > 1) throw new Error(`配信中の枠が${mine.length}つあり、どれか決められません`);
            if (mine.length) { id = mine[0].id; break; }
            if (this.now() >= until) throw new Error('配信中の YouTube の枠が見つかりません');
            await this.sleep(this.pollMs);
        }
        const sn = (await api(this.fetchFn, token, `videos?part=snippet&id=${encodeURIComponent(id)}`)).items?.[0]?.snippet;
        if (!sn) throw new Error('YouTube の枠を読めません');
        if (sn.title === title) return `done ${id}`;
        // videos.update replaces the whole snippet: keep the description, category, tags and language as they are.
        const snippet = { title, description: sn.description || '', categoryId: sn.categoryId, ...(sn.tags ? { tags: sn.tags } : {}), ...(sn.defaultLanguage ? { defaultLanguage: sn.defaultLanguage } : {}) };
        await api(this.fetchFn, token, 'videos?part=snippet', { method: 'PUT', body: { id, snippet } });
        return `done ${id}`;
    }
    async twitch(title) {
        const { a, v, call } = await this.twitchAuth();
        await call(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(v.user_id)}`, { method: 'PATCH',
            headers: { Authorization: `Bearer ${a.access_token}`, 'Client-Id': a.client_id, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.slice(0, TWITCH_MAX) }) });
        return 'done';
    }
    /** Re-checks the Twitch title a few times after it was set and restores it when something else replaced it. */
    async holdTwitch(title) {
        const want = title.slice(0, TWITCH_MAX);
        for (const ms of this.holdMs) {
            await this.sleep(ms);
            const { a, v, call } = await this.twitchAuth();
            const now = (await call(`https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(v.user_id)}`, { headers: { Authorization: `Bearer ${a.access_token}`, 'Client-Id': a.client_id } })).data?.[0]?.title;
            if (typeof now === 'string' && now !== want) {
                await this.twitch(title);
                this.state = { ...this.state, twitchRestored: (this.state.twitchRestored || 0) + 1 };
            }
        }
    }
    async twitchAuth() {
        const file = this.c.twitchTitleAuthFile;
        if (!file || !existsSync(file)) throw new Error('Twitch のタイトル変更用の許可がありません（node scripts/twitch-auth.mjs start --title）');
        const call = async (url, options = {}) => {
            const r = await this.fetchFn(url, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' });
            const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
            if (!r.ok) { const e = new Error(`Twitch HTTP ${r.status}`); e.status = r.status; throw e; }
            return data;
        };
        let a = JSON.parse(readFileSync(file, 'utf8'));
        const validate = () => call('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${a.access_token}` } });
        let v;
        try { v = await validate(); } catch (e) { if (e.status !== 401) throw e; }
        if (!v || v.expires_in < 120) {
            const fresh = await call('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: a.client_id, grant_type: 'refresh_token', refresh_token: a.refresh_token }) });
            if (!fresh.access_token || !fresh.refresh_token) throw new Error('Twitch の許可を更新できません');
            a = { ...a, ...fresh, expires_at: this.now() + fresh.expires_in * 1000 };
            // Public-client refresh tokens rotate: persist before any further call.
            const temp = `${file}.tmp`;
            writeFileSync(temp, JSON.stringify(a), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, file);
            v = await validate();
        }
        if (v.client_id !== a.client_id || v.login !== this.c.twitchChannel || !v.scopes?.includes(TWITCH_TITLE_SCOPE) || v.scopes.some(s => s !== TWITCH_TITLE_SCOPE))
            throw new Error('Twitch の許可のアカウントか権限が想定と違います');
        return { a, v, call };
    }
}
