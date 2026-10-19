// One chat box for YouTube and Twitch on stream (an OBS browser source): node scripts/chat-overlay.mjs --video VIDEO_ID
// Read-only: Twitch IRC as an anonymous justinfan user; YouTube liveChat/messages with the youtube:schedule OAuth token.
// Serves http://127.0.0.1:8795/ ; never posts to either chat, never changes the Studio.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { config, loadEnv } from '../src/config.mjs';
import { accessToken } from '../src/youtube-schedule.mjs';
import { gameAction, publicGameAction } from '../src/game-decision.mjs';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 30, PORT = Number(process.env.CHAT_OVERLAY_PORT) || 8795;
export function twitchMessage(line) {
    // @badge-info=;display-name=Foo;... :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello
    const m = /^(?:@(\S+) )?:(\w+)!\S+ PRIVMSG #\w+ :(.*)$/.exec(line);
    if (!m) return null;
    const tags = Object.fromEntries((m[1] || '').split(';').map(kv => kv.split('=')));
    return { source: 'twitch', name: (tags['display-name'] || m[2]).replace(/\\s/g, ' '), text: m[3].trim() };
}
export function youtubeMessages(page) {
    return (page?.items || []).filter(x => x?.snippet?.type === 'textMessageEvent' || x?.snippet?.displayMessage)
        .map(x => ({ id: x.id, source: 'youtube', name: x.authorDetails?.displayName || '', text: x.snippet.displayMessage || '' }));
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0b1120;color:#fffaf0;font:16px/1.3 "Hiragino Sans",sans-serif;overflow:hidden;border-radius:12px}
#list{position:absolute;left:0;right:0;bottom:0;padding:4px 0}
.m{display:flex;gap:8px;align-items:baseline;padding:3px 12px;border-bottom:1px solid #ffffff0d}
.s{flex:none;font:700 11px sans-serif;padding:1px 6px;border-radius:4px;color:#fff}.youtube .s{background:#e02424}.twitch .s{background:#9146ff}
.n{flex:none;font-weight:700;font-size:14px}.youtube .n{color:#9fe0c8}.twitch .n{color:#c9a7ff}
.t{overflow-wrap:anywhere}
</style><div id="list"></div><script>
const list=document.getElementById('list');
const add=m=>{const d=document.createElement('div');d.className='m '+m.source;
for(const [c,v] of [['s',m.source==='youtube'?'YouTube':'Twitch'],['n',m.name],['t',m.text]]){const s=document.createElement('span');s.className=c;s.textContent=v;d.append(s);}
list.append(d);while(list.children.length>${MAX})list.firstChild.remove();};
const es=new EventSource('/events');es.onmessage=e=>add(JSON.parse(e.data));
</script>`;

// Noa's commands (the same box size, beside the chat): the last five applied actions of the newest run, tailed from
// runs/*/decisions.jsonl (only appended bytes are read; a run log grows past 50 MB).
const ACTIONS_PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#0b1120;color:#fffaf0;font:16px/1.3 "Hiragino Sans",sans-serif;overflow:hidden;border-radius:12px}
#h{padding:4px 12px 2px;font:700 12px sans-serif;letter-spacing:2px;color:#9fe0c8}
.m{display:grid;grid-template-columns:52px 26px 1fr;gap:6px;padding:3px 12px;border-bottom:1px solid #ffffff0d;opacity:.6;white-space:nowrap}
.m:last-child{opacity:1;font-weight:700}.levelup{color:#ffd77a}.c{font:500 13px ui-monospace,Menlo,monospace;color:#9fb0d8}
</style><div id="h">ノアの操作</div><div id="list"></div><script>
const list=document.getElementById('list');
const es=new EventSource('/action-events');es.onmessage=e=>{const items=JSON.parse(e.data);list.replaceChildren(...items.map(a=>{const d=document.createElement('div');d.className='m '+a.kind;
for(const [c,v] of [['c',Math.floor(a.t/60)+':'+String(a.t%60).padStart(2,'0')],['a',a.arrow],['x',a.text]]){const s=document.createElement('span');s.className=c;s.textContent=v;d.append(s);}return d;}));};
</script>`;
export function tailActions(runsDir, state = { path: null, offset: 0, rest: '', items: [] }) {
    let newest = null;
    try {
        for (const name of readdirSync(runsDir)) {
            if (!name.startsWith('vampire-')) continue;
            const p = join(runsDir, name, 'decisions.jsonl');
            let m; try { m = statSync(p).mtimeMs; } catch { continue; }
            if (!newest || m > newest.m) newest = { p, m };
        }
    } catch { return state; }
    if (!newest) return state;
    if (newest.p !== state.path) Object.assign(state, { path: newest.p, offset: Math.max(0, statSync(newest.p).size - 400000), rest: '', items: [], skipFirst: true });
    const size = statSync(state.path).size;
    if (size < state.offset) Object.assign(state, { offset: 0, rest: '' });
    if (size === state.offset) return state;
    const fd = openSync(state.path, 'r'), buf = Buffer.alloc(Math.min(size - state.offset, 4 << 20));
    try { readSync(fd, buf, 0, buf.length, state.offset); } finally { closeSync(fd); }
    state.offset += buf.length;
    const lines = (state.rest + buf.toString('utf8')).split('\n'); state.rest = lines.pop();
    if (state.skipFirst) { lines.shift(); state.skipFirst = false; }
    for (const line of lines) {
        if (!line.startsWith('{"event": "decision"')) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        const a = publicGameAction(gameAction(rec));
        if (a && (!state.items.length || a.seq > state.items.at(-1).seq)) { state.items.push(a); if (state.items.length > 5) state.items.shift(); }
    }
    return state;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    loadEnv();
    const c = config(process.env, ['node', 'x']);
    const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
    const video = arg('video'), channel = (arg('twitch') || process.env.TWITCH_CHANNEL || '').toLowerCase();
    const recent = [], clients = new Set();
    const emit = m => { if (!m.text) return; recent.push(m); if (recent.length > MAX) recent.shift(); for (const r of clients) r.write(`data: ${JSON.stringify(m)}\n\n`); };
    const runsDir = arg('runs') || `${process.env.HOME}/Projects/jev-vampire-survivors/runs`;
    const actionClients = new Set(); let tail = { path: null, offset: 0, rest: '', items: [] }, lastSent = '';
    setInterval(() => {
        try { tail = tailActions(runsDir, tail); } catch { return; }
        const json = JSON.stringify(tail.items);
        if (json !== lastSent) { lastSent = json; for (const r of actionClients) r.write(`data: ${json}\n\n`); }
    }, 500);
    http.createServer((req, res) => {
        if (req.url === '/actions') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(ACTIONS_PAGE); return; }
        if (req.url === '/action-events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            res.write(`data: ${lastSent || '[]'}\n\n`); actionClients.add(res); req.on('close', () => actionClients.delete(res)); return;
        }
        if (req.url === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
            for (const m of recent) res.write(`data: ${JSON.stringify(m)}\n\n`);
            clients.add(res); req.on('close', () => clients.delete(res)); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PAGE);
    }).listen(PORT, '127.0.0.1', () => console.log(`chat overlay on http://127.0.0.1:${PORT}/`));
    // Twitch: anonymous read-only IRC, reconnecting.
    const twitch = () => {
        if (!channel) return;
        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        ws.onopen = () => { for (const l of ['CAP REQ :twitch.tv/tags', 'PASS SCHMOOPIIE', `NICK justinfan${Math.floor(Math.random() * 80000) + 10000}`, `JOIN #${channel}`]) ws.send(l); };
        ws.onmessage = e => { for (const line of String(e.data).split('\r\n')) { if (line.startsWith('PING')) ws.send('PONG :tmi.twitch.tv'); const m = twitchMessage(line); if (m) emit(m); } };
        ws.onclose = () => setTimeout(twitch, 5000);
        ws.onerror = () => {};
    };
    twitch();
    // YouTube: poll the live chat at the interval the API asks for.
    if (video) (async () => {
        const file = `${c.dataDir}/youtube-schedule-oauth.json`;
        const refreshToken = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).refresh_token : '';
        let token = '', tokenAt = 0, chat = '', pageToken = '', first = true;
        const seen = new Set();
        for (;;) {
            try {
                if (!token || Date.now() - tokenAt > 45 * 60000) { token = await accessToken({ clientId: c.youtubeClient, clientSecret: c.youtubeSecret, refreshToken }); tokenAt = Date.now(); }
                const auth = { headers: { Authorization: `Bearer ${token}` } };
                if (!chat) chat = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${video}`, auth)).json()).items?.[0]?.liveStreamingDetails?.activeLiveChatId || '';
                if (!chat) { await new Promise(r => setTimeout(r, 15000)); continue; }
                const page = await (await fetch(`https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&maxResults=200&liveChatId=${chat}${pageToken ? `&pageToken=${pageToken}` : ''}`, auth)).json();
                if (page.error) throw new Error(page.error.message);
                const msgs = youtubeMessages(page).filter(m => !seen.has(m.id));
                for (const m of (first ? msgs.slice(-8) : msgs)) { seen.add(m.id); emit(m); }
                for (const m of msgs) seen.add(m.id);
                first = false; pageToken = page.nextPageToken || pageToken;
                await new Promise(r => setTimeout(r, Math.max(5000, Number(page.pollingIntervalMillis) || 8000)));
            } catch (e) { console.error('youtube', e.message); await new Promise(r => setTimeout(r, 15000)); }
        }
    })();
}
