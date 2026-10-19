// Create a reserved YouTube broadcast (予約枠) and bind it to the channel's stream that OBS sends to.
// Needs a youtube.force-ssl refresh token (npm run youtube:auth -- --schedule). Never starts or ends a broadcast.
export const PRIVACY = Object.freeze(['public', 'unlisted', 'private']);
const API = 'https://www.googleapis.com/youtube/v3';

/** Checked input or a thrown Error with a Japanese message. */
export function scheduleRequest({ title, description = '', start, privacy = 'public' } = {}, now = Date.now()) {
    const t = String(title ?? '').trim(), d = String(description ?? '');
    if (!t || t.length > 100 || /[<>]/.test(t)) throw new Error('タイトルは1〜100文字で、< と > は使えません。');
    if (d.length > 5000 || /[<>]/.test(d)) throw new Error('説明は5000文字までで、< と > は使えません。');
    const at = new Date(start);
    if (!Number.isFinite(at.getTime())) throw new Error('開始日時が読めません（例: 2026-10-06T19:00:00+09:00）。');
    if (at.getTime() < now - 60000) throw new Error('開始日時が過去です。');
    if (!PRIVACY.includes(privacy)) throw new Error('公開範囲は public / unlisted / private のどれかです。');
    return { title: t, description: d, start: at.toISOString(), privacy };
}

export async function api(fetchFn, token, path, { method = 'GET', body } = {}) {
    const r = await fetchFn(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || '';
        const e = new Error(`YouTube API ${method} ${path.split('?')[0]} HTTP ${r.status}${reason ? ` (${reason})` : ''}`); e.status = r.status; e.reason = reason; throw e;
    }
    return data;
}

export async function accessToken({ clientId, clientSecret, refreshToken }, fetchFn = fetch) {
    if (!clientId || !clientSecret || !refreshToken) throw new Error('YouTube の予約用認証がありません。npm run youtube:auth -- --schedule を実行してください。');
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(10000), redirect: 'error' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`YouTube の認証を更新できませんでした（${j.error || `HTTP ${r.status}`}）。npm run youtube:auth -- --schedule でやり直してください。`);
    return j.access_token;
}

/** The channel's stream to bind: the one whose stream name is OBS's key. Only without a known OBS key does a channel's
 * single stream stand in. When OBS sends elsewhere (a relay such as Restream creates its own YouTube broadcast) a
 * reservation would never go live, so that is an error (2026-10-07: a reservation bound to the channel's only stream
 * stayed unused while Restream aired its own broadcasts). */
export function pickStream(streams, streamKey = '') {
    const items = streams?.items || [];
    if (streamKey) {
        const match = items.find(s => s?.cdn?.ingestionInfo?.streamName === streamKey);
        if (match) return match;
        throw new Error('OBS の配信キーがこのチャンネルのどの配信キーとも一致しません。OBS は YouTube に直接送っていない（Restream などの中継サービス経由）ため、この予約枠では配信されません。中継サービス側で配信のタイトルや予約を設定してください。');
    }
    if (items.length === 1) return items[0];
    throw new Error(items.length ? `配信キーが ${items.length} 個あり、OBS のキーと一致するものが見つかりません。` : 'このチャンネルに配信キー（ライブストリーム）がありません。');
}

/** Insert the broadcast, then bind it to OBS's stream. Returns { id, url, streamTitle }. */
export async function scheduleBroadcast(request, { token, streamKey = '', fetchFn = fetch } = {}) {
    const streams = await api(fetchFn, token, 'liveStreams?part=id,snippet,cdn&mine=true&maxResults=50');
    const stream = pickStream(streams, streamKey);
    const broadcast = await api(fetchFn, token, 'liveBroadcasts?part=snippet,status,contentDetails', { method: 'POST', body: {
        snippet: { title: request.title, description: request.description, scheduledStartTime: request.start },
        status: { privacyStatus: request.privacy, selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true } } });
    if (!broadcast?.id) throw new Error('YouTube が予約枠の ID を返しませんでした。');
    await api(fetchFn, token, `liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&part=id,contentDetails&streamId=${encodeURIComponent(stream.id)}`, { method: 'POST' });
    return { id: broadcast.id, url: `https://www.youtube.com/watch?v=${broadcast.id}`, streamTitle: stream?.snippet?.title || '' };
}
