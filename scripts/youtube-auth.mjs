// Operator-run Google OAuth installed-desktop flow. Grants read-only access by default; never starts a broadcast.
// --schedule asks for youtube.force-ssl instead, saved apart (youtube-schedule-oauth.json), for creating reserved broadcasts
// (scripts/youtube-schedule.mjs); the chat reader keeps its own read-only token.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config, loadEnv } from '../src/config.mjs';
import { equal, boundedBody } from '../src/util.mjs';
loadEnv();
const c = config(process.env, ['--demo']);
const analytics = process.argv.includes('--analytics'), schedule = process.argv.includes('--schedule');
const tokenFile = analytics ? 'youtube-analytics-oauth.json' : schedule ? 'youtube-schedule-oauth.json' : 'youtube-oauth.json';
if (!c.youtubeClient || !c.youtubeSecret) {
    console.error('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET for a Desktop app in .env first.');
    process.exitCode = 1;
}
else {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    let redirect = '', busy = false;
    const server = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const url = new URL(req.url, redirect);
        if (url.pathname !== '/oauth/callback' || req.headers.host !== new URL(redirect).host || !equal(url.searchParams.get('state'), state)) {
            res.writeHead(400);
            res.end('Invalid OAuth callback.');
            return;
        }
        if (busy) {
            res.writeHead(409);
            res.end('Callback already processing.');
            return;
        }
        busy = true;
        try {
            const code = url.searchParams.get('code');
            if (!code || url.searchParams.has('error'))
                throw new Error('Authorization was declined or no code was returned.');
            const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.youtubeClient, client_secret: c.youtubeSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }), signal: AbortSignal.timeout(15000), redirect: 'error' });
            if (!r.ok) {
                await r.body?.cancel();
                throw new Error(`OAuth token exchange HTTP ${r.status}`);
            }
            const data = JSON.parse((await boundedBody(r, 64000)).toString('utf8'));
            if (!data.refresh_token)
                throw new Error('No refresh token. Revoke the previous grant and repeat the consent flow.');
            mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
            writeFileSync(`${c.dataDir}/${tokenFile}`, JSON.stringify({ refresh_token: data.refresh_token, scope: data.scope, savedAt: new Date().toISOString() }), { mode: 0o600 });
            // A token kept in settings.json wins over youtube-oauth.json at Studio start (live 2026-10-13: an expired one there
            // hid any re-authorisation), so the chat reader's re-authorisation replaces it.
            const settingsFile = `${c.dataDir}/settings.json`;
            if (!analytics && !schedule && existsSync(settingsFile)) {
                const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
                if (settings.YOUTUBE_REFRESH_TOKEN) {
                    settings.YOUTUBE_REFRESH_TOKEN = data.refresh_token;
                    writeFileSync(`${settingsFile}.tmp`, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
                    renameSync(`${settingsFile}.tmp`, settingsFile);
                }
            }
            res.end(analytics ? 'YouTube Analyticsの読み取り専用認証を保存しました。配信は止めず、分析画面の「動画データを更新」を押してください。' : schedule ? 'YouTubeの予約枠作成用の認証を保存しました。このタブを閉じて、npm run youtube:schedule を実行してください。' : 'YouTubeの読み取り専用連携を保存しました。このタブを閉じて、Studioを起動し直してください。');
            console.log(schedule ? 'Scheduling refresh token saved locally (youtube-schedule-oauth.json). Do not commit OAuth files.' : 'Read-only refresh token saved locally. Do not commit OAuth files.');
        }
        catch (e) {
            res.writeHead(400);
            res.end('認証を完了できませんでした。ターミナルを確認してください。');
            console.error(e.message);
            process.exitCode = 1;
        }
        finally {
            clearTimeout(timer);
            server.close();
        }
    });
    const timer = setTimeout(() => { console.error('OAuth consent timed out. Run this command again when ready.'); server.closeAllConnections(); server.close(); process.exitCode = 1; }, 300000);
    server.on('error', e => { clearTimeout(timer); console.error(e.code || e.name); process.exitCode = 1; });
    server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
        const params = new URLSearchParams({ client_id: c.youtubeClient, redirect_uri: redirect, response_type: 'code', scope: analytics ? 'https://www.googleapis.com/auth/yt-analytics.readonly' : schedule ? 'https://www.googleapis.com/auth/youtube.force-ssl' : 'https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
        console.log(`Open this URL in your own browser and approve only the intended channel:\nhttps://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });
}
