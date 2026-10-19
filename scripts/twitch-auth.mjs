// Device authorization lets the operator approve on a separate phone/browser.
// Read-only chat scope; never starts a stream or sends chat messages.
// --title asks instead for channel:manage:broadcast alone, saved apart (title-oauth.json), so the Studio can set the
// stream title (src/stream-title.mjs); the chat token stays read-only.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.env.TWITCH_AUTH_DIR || new URL('../data/twitch', import.meta.url).pathname);
const title = process.argv.includes('--title');
const pending = `${dir}/${title ? 'title-pending' : 'pending'}.json`;
const scope = title ? 'channel:manage:broadcast' : 'user:read:chat';
// The expected account: TWITCH_CHANNEL, else the character's channel in config/character.json.
const channel = process.env.TWITCH_CHANNEL || JSON.parse(readFileSync(new URL('../config/character.json', import.meta.url), 'utf8')).twitch?.channel || '';
function save(path, data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
}
async function post(endpoint, params) {
    const response = await fetch(`https://id.twitch.tv/oauth2/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params), signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
}
try {
    if (process.argv[2] === 'start') {
        // The public client ID of the chat login, when TWITCH_CLIENT_ID is not set (it is not a secret).
        let client = process.env.TWITCH_CLIENT_ID;
        if (!client) try { client = JSON.parse(readFileSync(`${dir}/oauth.json`, 'utf8')).client_id; } catch { }
        if (!client || !/^[a-z0-9]{20,64}$/.test(client)) throw new Error('Set TWITCH_CLIENT_ID.');
        const r = await post('device', { client_id: client, scopes: scope });
        if (!r.ok) throw new Error(`Device authorization HTTP ${r.status}; verify the public client ID.`);
        const url = new URL(r.data.verification_uri);
        if (url.origin !== 'https://www.twitch.tv' || url.pathname !== '/activate' || !r.data.device_code || !Number.isFinite(r.data.expires_in)) throw new Error('Unexpected device authorization response.');
        save(pending, { client_id: client, device_code: r.data.device_code, expires_at: Date.now() + r.data.expires_in * 1000 });
        console.log(JSON.stringify({ authorization_url: url.href, user_code: r.data.user_code, expires_in: r.data.expires_in, scope }));
    } else if (process.argv[2] === 'complete') {
        const p = JSON.parse(readFileSync(pending, 'utf8'));
        if (p.expires_at <= Date.now()) throw new Error('Authorization expired. Run start again.');
        const r = await post('token', { client_id: p.client_id, device_code: p.device_code, scopes: scope, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (!r.ok) {
            if (r.data.message === 'authorization_pending') throw new Error('Waiting for operator authorization.');
            throw new Error(`Token exchange HTTP ${r.status}. Run start again if the code expired.`);
        }
        const validation = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${r.data.access_token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!validation.ok) throw new Error('Token validation failed.');
        const v = await validation.json();
        if (v.client_id !== p.client_id || v.login !== channel || !v.scopes?.includes(scope) || v.scopes.some(s => s !== scope)) throw new Error('Unexpected Twitch account or scopes; credentials not saved.');
        if (!r.data.refresh_token) throw new Error('Refresh token missing.');
        save(`${dir}/${title ? 'title-oauth' : 'oauth'}.json`, { ...r.data, client_id: p.client_id, user_id: v.user_id, login: v.login, expires_at: Date.now() + v.expires_in * 1000 });
        rmSync(pending);
        console.log(title ? `Twitch title credentials (channel:manage:broadcast only) saved locally for ${channel}.` : `Read-only Twitch chat credentials saved locally for ${channel}. Chat ingestion is not yet enabled.`);
    } else throw new Error('Usage: node scripts/twitch-auth.mjs start|complete [--title]');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
