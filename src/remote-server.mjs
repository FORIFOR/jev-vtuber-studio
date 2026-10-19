// Tailscale Serve-only boundary. NEVER bind this listener to 0.0.0.0.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { equal } from './util.mjs';
import { RemoteError } from './remote-control.mjs';
const COOKIE = '__Host-jvs-mobile';
export function validateRemoteOptions(x) {
    if (!x || x.enabled !== true) return null;
    let url; try { url = new URL(x.origin); } catch { throw new Error('Invalid remote HTTPS origin'); }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
        || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Remote requires an exact HTTPS Tailscale Serve origin');
    if (!Array.isArray(x.users) || !x.users.length || x.users.length > 5
        || x.users.some(u => typeof u !== 'string' || !/^[A-Za-z0-9._+@-]{3,160}$/.test(u))) throw new Error('Explicit Tailscale login allowlist required');
    const port = x.port ?? 8788;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid remote port');
    return { enabled: true, origin: url.origin, users: [...new Set(x.users.map(x => x.toLowerCase()))], port };
}
export function loadRemoteOptions(dataDir) {
    const f = join(dataDir, 'remote-control.json');
    return existsSync(f) ? validateRemoteOptions(JSON.parse(readFileSync(f, 'utf8'))) : null;
}
async function readBody(req) {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RemoteError('JSON_REQUIRED', 'JSON required', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new RemoteError('BODY_LIMIT', 'Request too large', 413);
        chunks.push(chunk);
    }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
    catch { throw new RemoteError('INVALID_JSON', 'Invalid JSON', 400); }
}
export function createRemoteServer(options, control, { publicDir, now = Date.now } = {}) {
    options = validateRemoteOptions(options);
    if (!options) throw new Error('Remote access is disabled');
    const sessions = new Map(), host = new URL(options.origin).host, users = new Set(options.users);
    let poll = null, refreshing = null;
    const assets = new Map([
        ['/mobile', ['mobile.html', 'text/html; charset=utf-8']],
        ['/mobile/', ['mobile.html', 'text/html; charset=utf-8']],
        ['/mobile/style.css', ['mobile.css', 'text/css; charset=utf-8']],
        ['/mobile/app.mjs', ['mobile.mjs', 'text/javascript; charset=utf-8']],
        ['/mobile/manifest.webmanifest', ['mobile.webmanifest', 'application/manifest+json']],
        ['/mobile/icon.svg', ['mobile-icon.svg', 'image/svg+xml']],
    ]);
    const cookie = req => String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const refresh = () => { if (!refreshing) refreshing = control.sampleOBS().catch(() => {}).finally(() => { refreshing = null; }); };
    const server = http.createServer(async (req, res) => {
        const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
        try {
            // Trust identity ONLY through a loopback-bound Serve reverse proxy.
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== host)
                return json(403, { code: 'PROXY_REQUIRED', error: 'Tailscale Serveの専用HTTPS URLから開いてください。' });
            const login = req.headers['tailscale-user-login'];
            if (typeof login !== 'string' || !users.has(login.toLowerCase())) return json(403, { code: 'USER_DENIED', error: '許可したTailscale利用者ではありません。' });
            const user = login.toLowerCase();
            if (req.headers.origin && req.headers.origin !== options.origin) return json(403, { code: 'ORIGIN', error: 'Cross-origin blocked' });
            if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(403, { code: 'SITE', error: 'Cross-site blocked' });
            const url = new URL(req.url, options.origin);
            if (url.search) return json(400, { code: 'QUERY', error: 'URLにキーや操作を指定しないでください。' });
            const token = cookie(req); let session = sessions.get(token);
            for (const [k, v] of sessions) if (v.until <= now()) sessions.delete(k);
            if (session?.until <= now() || session?.user !== user) session = null;
            if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { Location: '/mobile' }); return res.end(); }
            if (req.method === 'GET' && assets.has(url.pathname)) {
                const [file, type] = assets.get(url.pathname);
                res.writeHead(200, { 'Content-Type': type }); return res.end(readFileSync(join(publicDir, file)));
            }
            if (req.method === 'GET' && url.pathname === '/mobile/api/session') {
                if (!session) {
                    if (sessions.size >= 32) return json(429, { code: 'SESSIONS', error: '同時接続の上限です。' });
                    const token = randomBytes(32).toString('hex');
                    session = { user, csrf: randomBytes(32).toString('hex'), until: now() + 12 * 3600000, attempts: [] };
                    sessions.set(token, session);
                    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200`);
                }
                refresh(); return json(200, { csrf: session.csrf, state: control.summary() });
            }
            if (!session) return json(401, { code: 'SESSION', error: '操作画面を開き直してください。' });
            if (req.method === 'GET' && url.pathname === '/mobile/api/state') { refresh(); return json(200, control.summary()); }
            if (req.method === 'POST' && url.pathname === '/mobile/api/action') {
                if (req.headers.origin !== options.origin || !equal(req.headers['x-jvs-csrf'], session.csrf)) return json(403, { code: 'CSRF', error: '操作元を確認できません。' });
                const data = await readBody(req);
                if (!['check', 'start', 'stop', 'panic'].includes(data.action)) return json(400, { code: 'ACTION', error: '許可されていない操作です。' });
                // Never delay an emergency stop because the user checked status too often.
                if (!['stop', 'panic'].includes(data.action)) {
                    session.attempts = session.attempts.filter(t => now() - t < 60000);
                    if (session.attempts.length >= 20) return json(429, { code: 'RATE', error: '操作が多すぎます。状態表示を確認してください。' });
                    session.attempts.push(now());
                }
                if (data.action === 'check') return json(200, await control.preflight());
                if (data.action === 'start') return json(202, control.start(data));
                return json(202, control.stop({ requestId: data.requestId, panic: data.action === 'panic' }));
            }
            return json(404, { code: 'NOT_FOUND', error: 'Not found' });
        } catch (e) {
            if (res.headersSent) return res.end();
            return json(e instanceof RemoteError ? e.status : 500, { code: e instanceof RemoteError ? e.code : 'REMOTE_ERROR',
                error: e instanceof RemoteError ? e.message : '操作を確認できません。状態を更新し、PC側を確認してください。' });
        }
    });
    server.requestTimeout = 12000; server.headersTimeout = 8000; server.maxHeadersCount = 32;
    return { server, options,
        listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); poll = setInterval(refresh, 3000); poll.unref(); resolve(); }); }); },
        async close() { clearInterval(poll); sessions.clear(); control.disarm(); if (server.listening) { server.closeAllConnections(); await new Promise(r => server.close(r)); } },
    };
}
