import { createHash, timingSafeEqual } from 'node:crypto';
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted)
        return reject(signal.reason);
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const t = setTimeout(done, ms);
    const abort = () => { clearTimeout(t); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
});
export const hash = s => createHash('sha256').update(s).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const clean = (s, n = 500) => String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, n);
// Detection only: invisible separators must not split a forbidden token. Never
// use this representation for display or TTS: emoji ZWJ and variation selectors
// are deliberately retained by clean() in the actual viewer comment.
export const safetyText = s => String(s ?? '').normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f-\u009f]/gu, '');
export const hasPII = s => /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?81[- ]?|0)(?:\d[- ]?){9,11}|sk-[a-z0-9_-]{12,}|AIza[a-z0-9_-]{20,}|-----BEGIN.*PRIVATE KEY)/i.test(safetyText(s));
export const injection = s => /(?:ignore.{0,30}(?:instructions|rules)|system\s*prompt|(?:指示|命令|ルール).{0,12}(?:無視|公開)|API.{0,8}キー.{0,8}(?:教|表示)|秘密.{0,8}(?:表示|教)|rm\s+-rf|<script|javascript:)/i.test(safetyText(s));
export function assertText(s, max = 500) { if (typeof s !== 'string' || !s.trim() || s.length > max)
    throw new Error('Invalid text'); return clean(s, max); }
export async function boundedBody(response, max = 2000000) {
    if (Number(response.headers.get('content-length')) > max) {
        await response.body?.cancel();
        throw new Error('Response too large');
    }
    const reader = response.body?.getReader();
    if (!reader)
        return Buffer.alloc(0);
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > max)
                throw new Error('Response too large');
            chunks.push(Buffer.from(value));
        }
    }
    catch (e) {
        await reader.cancel().catch(() => { });
        throw e;
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
export async function request(url, { body, headers = {}, signal, timeout = 15000, method = body === undefined ? 'GET' : 'POST', max = 2000000, json = true, fetchFn = fetch } = {}) {
    const s = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const response = await fetchFn(url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: s, redirect: 'error' });
    if (!response.ok) {
        const error = new Error(`Provider HTTP ${response.status}`); error.status = response.status;
        // Google APIs say why (quotaExceeded, rateLimitExceeded, liveChatDisabled…; live 2026-10-16 the YouTube chat 403s
        // could not be told apart). Only that short code is kept, never the body (a provider may echo the request).
        try {
            const j = JSON.parse((await boundedBody(response, 16000)).toString('utf8')), reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status;
            if (typeof reason === 'string' && /^[A-Za-z_]{1,60}$/.test(reason)) error.reason = reason;
        } catch { await response.body?.cancel().catch(() => { }); }
        throw error;
    }
    const bytes = await boundedBody(response, max);
    return json ? JSON.parse(bytes.toString('utf8')) : bytes;
}
export function safeWebURL(s) { try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password)
        return null;
    return u.href;
}
catch {
    return null;
} }

/** A helper the Studio server spawned exits when that server is gone (live 2026-10-10: helpers orphaned by a kill -9 hot
 * restart kept reconnecting to OBS with a day-old configuration, ~12 failed logins every 3 min, and OBS's WebSocket
 * stopped answering). The server passes its pid as JVS_PARENT_PID; without it (run by hand) nothing changes. */
export function exitWithParent(env = process.env, { every = 5000, exit = () => process.exit(0), ppid = () => process.ppid } = {}) {
    const parent = Number(env.JVS_PARENT_PID);
    if (!Number.isInteger(parent) || parent <= 0) return null;
    const timer = setInterval(() => { if (ppid() !== parent) exit(); }, every); timer.unref?.();
    return timer;
}
