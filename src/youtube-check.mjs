import { youtubeChatStartIssue } from './youtube.mjs';

// Pre-stream check that the Studio can actually read the YouTube chat (operator request 2026-10-09): every step calls
// the same API the receiver uses and is logged, so a failure says where and why (API disabled, quota, auth, chat off…).
const API = 'https://www.googleapis.com/youtube/v3';

/** Google's error reasons -> what the operator should do. */
const HINTS = {
    accessNotConfigured: 'Google Cloud で「YouTube Data API v3」が無効です。Cloud Console の API ライブラリで有効にしてください。',
    SERVICE_DISABLED: 'Google Cloud で「YouTube Data API v3」が無効です。Cloud Console の API ライブラリで有効にしてください。',
    quotaExceeded: 'YouTube Data API の 1 日の割り当てを使い切りました（太平洋時間 0 時 ≒ 日本時間 16〜17 時に回復）。',
    rateLimitExceeded: '短時間に呼びすぎました。少し待ってから再確認してください。',
    liveChatDisabled: 'この配信枠はチャットがオフです。YouTube Studio で配信枠のチャットを有効にしてください。',
    liveChatEnded: 'この配信枠のチャットは終了しています。新しい配信枠を作ってください。',
    liveChatNotFound: 'チャットが見つかりません。配信枠の URL（YOUTUBE_VIDEO_ID）を確認してください。',
    insufficientPermissions: '認証の権限が足りません。npm run youtube:auth でやり直してください。',
    forbidden: 'この配信枠のチャットを読む権限がありません。配信しているチャンネルで認証してください。',
    authError: 'YouTube の認証が無効です。npm run youtube:auth でやり直してください。',
};

class CheckError extends Error {
    constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** -> { ok, skipped?, code, message, hint, videoId, liveChatId, log: [{ at, step, ok, detail }] }. Never throws. */
export async function probeYouTubeChat(c, { youtube, ledger, fetchFn = fetch, now = () => Date.now() } = {}) {
    const log = [], step = (name, ok, detail) => log.push({ at: new Date(now()).toISOString(), step: name, ok, detail: String(detail).slice(0, 300) });
    const done = (ok, code, message, extra = {}) => ({ ok, code, message, hint: extra.hint || HINTS[extra.reason] || null, videoId: extra.videoId || null, liveChatId: extra.liveChatId || null, log, ...(extra.skipped ? { skipped: true } : {}) });
    if (c.mode !== 'live' || !c.readComments || !c.streamTarget || c.streamTarget === 'twitch')
        return done(true, 'NOT_NEEDED', c.mode !== 'live' ? 'DEMO では YouTube に接続しません。' : c.streamTarget === 'twitch' ? 'Twitch のみの配信です（YouTube コメントは使いません）。' : !c.streamTarget ? '配信先が未選択です（このMacの中だけで試します）。' : 'コメント読み上げはオフです。', { skipped: true });
    const discover = c.streamTarget === 'simulcast' && !!c.youtubeChannel;
    if (!c.youtubeVideo && !discover) {
        step('配信枠', false, 'YOUTUBE_VIDEO_ID が未設定です');
        return done(false, 'NO_BROADCAST', 'YouTube の配信枠が設定されていません。', { hint: 'Studio の「YouTube 配信枠」で予約枠を作るか、設定で配信枠の URL を入力してください。' });
    }
    const call = async (path, label) => {
        ledger?.reserve?.('youtube');
        const token = c.youtubeKey ? null : await youtube.token();
        const r = await fetchFn(`${API}/${path}${c.youtubeKey ? `&key=${encodeURIComponent(c.youtubeKey)}` : ''}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            const reason = data?.error?.errors?.[0]?.reason || data?.error?.details?.find?.(d => d.reason)?.reason || data?.error?.status || '';
            const text = String(data?.error?.message || '').replace(/<[^>]*>/g, '').slice(0, 200);
            throw new CheckError(r.status === 403 && /quota/i.test(reason) ? 'QUOTA' : r.status === 401 ? 'AUTH' : r.status === 403 ? 'FORBIDDEN' : 'HTTP',
                `${label}: HTTP ${r.status}${reason ? ` ${reason}` : ''}${text ? ` — ${text}` : ''}`, { status: r.status, reason: r.status === 401 ? 'authError' : reason });
        }
        return data;
    };
    let videoId = discover ? '' : c.youtubeVideo, liveChatId = '';
    try {
        const budget = youtubeChatStartIssue(c, ledger?.snapshot?.());
        if (budget) { step('取得枠', false, budget.error); return done(false, budget.code, budget.error); }
        step('取得枠', true, 'Studio の 1 日の取得上限内です');
        if (!c.youtubeKey) {
            try { await youtube.token(); step('認証', true, 'OAuth トークンを取得しました'); }
            catch (e) {
                step('認証', false, e.code === 'CONFIGURATION' ? 'YouTube の OAuth 設定がありません' : e.message);
                return done(false, 'AUTH', 'YouTube の認証に失敗しました。', { hint: e.code === 'CONFIGURATION' ? 'npm run youtube:auth で YouTube の読み取りを許可してください。' : HINTS.authError });
            }
        }
        if (discover) {
            // Simulcast: the receiver finds the channel's live broadcast at start; before going live, an upcoming one counts.
            for (const status of ['active', 'upcoming']) {
                const list = await call(`liveBroadcasts?part=id,snippet&broadcastStatus=${status}&broadcastType=all&maxResults=5`, `配信枠の検索（${status}）`);
                const mine = (list.items || []).filter(b => b.snippet?.channelId === c.youtubeChannel);
                if (mine.length) { videoId = mine[0].id; liveChatId = mine[0].snippet?.liveChatId || ''; break; }
            }
            step('配信枠', !!videoId, videoId ? `チャンネルの配信枠 ${videoId}` : 'チャンネルに配信中・予約中の枠が見つかりません');
            if (!videoId) return done(false, 'NO_BROADCAST', 'チャンネルに配信中・予約中の配信枠がありません。', { hint: 'Studio の「YouTube 配信枠」で予約枠を作ってください。' });
        }
        const video = await call(`videos?part=liveStreamingDetails,snippet&id=${encodeURIComponent(videoId)}`, '配信枠の確認');
        const item = video.items?.[0], details = item?.liveStreamingDetails;
        if (!item) { step('配信枠', false, `動画 ${videoId} が見つかりません`); return done(false, 'NOT_FOUND', '配信枠が見つかりません。', { hint: '配信枠の URL（YOUTUBE_VIDEO_ID）を確認してください。', videoId }); }
        if (!details) { step('配信枠', false, '通常の動画です（ライブ配信枠ではありません）'); return done(false, 'NOT_LIVE', 'この URL はライブ配信枠ではありません。', { videoId }); }
        if (details.actualEndTime) { step('配信枠', false, `終了済み（${details.actualEndTime}）`); return done(false, 'ENDED', 'この配信枠は終了しています。', { hint: '新しい予約枠を作ってください。', videoId }); }
        step('配信枠', true, `${item.snippet?.title || videoId}（${details.actualStartTime ? '配信中' : '配信開始前'}）`);
        liveChatId ||= details.activeLiveChatId || '';
        if (!liveChatId && !c.youtubeKey) {
            // Before going live, the reservation's own chat id (owner's view) stands in for activeLiveChatId.
            const b = await call(`liveBroadcasts?part=snippet&id=${encodeURIComponent(videoId)}`, 'チャットの確認');
            liveChatId = b.items?.[0]?.snippet?.liveChatId || '';
        }
        if (!liveChatId) { step('チャット', false, 'liveChatId がありません'); return done(false, 'CHAT_DISABLED', 'この配信枠のチャットを読めません（チャットがオフか、まだ用意されていません）。', { reason: 'liveChatDisabled', videoId }); }
        step('チャット', true, `liveChatId を取得しました`);
        const page = await call(`liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=id&maxResults=200`, 'コメントの読み込み');
        step('コメントの読み込み', true, `読み込めました（現在 ${(page.items || []).length} 件）`);
        return done(true, 'OK', 'YouTube のコメントを読み込めます。', { videoId, liveChatId });
    } catch (e) {
        if (e instanceof CheckError) { step(e.message.split(':')[0], false, e.message); return done(false, e.code, e.message, { reason: e.reason, videoId, liveChatId }); }
        if (e.message === 'Daily youtube call limit reached') { step('取得枠', false, e.message); return done(false, 'YOUTUBE_CHAT_BUDGET', 'Studio の YouTube 取得上限に達しました。'); }
        step('接続', false, e.name === 'TimeoutError' ? 'YouTube API が応答しません（タイムアウト）' : e.message);
        return done(false, 'NETWORK', 'YouTube API に接続できません。', { hint: 'ネットワーク接続を確認してください。', videoId });
    }
}
