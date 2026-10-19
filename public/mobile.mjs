const $ = id => document.getElementById(id);
let csrf = '', state = null, busy = false, online = false, refreshing = false;
const stages = { checking: '開始前の確認中', starting_obs: 'OBSの送出を開始中', stopping: '停止を確認中',
    failed: '開始できませんでした', cancelled: '開始を取り消しました', stop_unconfirmed: '停止を確認できません', external_stream_active: '別途開始したOBS送出が継続中' };
async function api(path, data) {
    const response = await fetch(`/mobile/api/${path}`, { method: data ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
        headers: data ? { 'Content-Type': 'application/json', 'X-JVS-CSRF': csrf } : {}, body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(15000) });
    const r = await response.json();
    if (!response.ok) { if (response.status === 401) csrf = ''; throw new Error(r.error || '操作を確認できません。'); }
    return r;
}
function message(text) { $('message').textContent = text; }
function draw() {
    $('network').textContent = online ? '接続済み' : '接続を確認';
    $('check').disabled = !online || busy; $('panic').disabled = !online; $('stop').disabled = !online;
    if (!state) return;
    const fresh = Date.now() - state.obs.checkedAt < 15000;
    const streaming = fresh && state.obs.connected && state.obs.active;
    const pending = ['checking', 'starting_obs', 'stopping'].includes(state.job?.state);
    $('start').disabled = !online || busy || pending || state.running || state.obsOwned || !state.armed || state.panic;
    $('title').textContent = state.title; $('topic').textContent = state.topic || '次の番組を待っています。';
    $('remaining').textContent = state.running ? `${Math.ceil(state.remainingMs / 60000)} 分` : `${state.sessionMinutes} 分`;
    $('state-label').textContent = !online ? '状態が古い可能性があります' : state.panic ? '緊急停止中' : pending ? stages[state.job.state]
        : streaming ? (state.obs.reconnecting ? 'OBS 再接続中' : 'OBS 送出中') : state.running ? 'PCで番組を進行中'
        : stages[state.job?.state] || (state.armed ? '開始を待っています' : 'PCでの準備が必要です');
    $('state-dot').classList.toggle('live', !!streaming && !state.obs.reconnecting && online);
    $('obs').textContent = !fresh || !state.obs.connected ? '未確認' : state.obs.reconnecting ? '再接続中' : state.obs.active ? '送出中' : '停止を確認';
    $('audio').textContent = state.obsRenderer ? 'OBSの専用ソース接続済み' : '専用ソース未接続';
    $('armed').textContent = state.armed ? `${new Date(state.armedUntil).toLocaleTimeString('ja-JP', {hour:'2-digit',minute:'2-digit'})} まで` : '未許可・期限切れ';
    $('caption').textContent = state.caption || ''; $('caption').hidden = !state.caption;
    $('watch').hidden = !/^[\w-]{11}$/.test(state.videoID || '');
    if (!$('watch').hidden) $('watch').href = `https://www.youtube.com/watch?v=${encodeURIComponent(state.videoID)}`;
}
async function refresh() {
    if (refreshing || document.hidden) return; refreshing = true;
    try {
        if (!csrf) { const r = await api('session'); csrf = r.csrf; state = r.state; }
        else state = await api('state');
        online = true;
    } catch (e) { online = false; message('PCへ接続できません。TailscaleとPCの電源・ネット接続を確認してください。操作の自動再送はしません。'); }
    finally { refreshing = false; draw(); }
}
async function action(fn) { if (busy) return; busy = true; draw(); try { await fn(); } catch (e) { message(e.message); } finally { busy = false; await refresh(); draw(); } }
$('check').onclick = () => action(async () => { await api('action', { action: 'check' }); message('PCとOBSの開始条件を確認しました。配信開始で送出先を確認してください。'); });
$('start').onclick = () => action(async () => {
    const r = await api('action', { action: 'check' });
    $('confirm-target').textContent = `${r.title} / ${r.minutes}分 / 動画ID: ${r.videoID}`;
    const dialog = $('confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
    const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result !== 'start') return;
    const requestId = crypto.randomUUID();
    const job = await api('action', { action: 'start', confirm: 'START_BROADCAST', videoID: r.videoID, requestId });
    message(`開始を受け付けました。状態欄で結果を確認してください。操作ID: ${job.id.slice(0,8)}`);
});
// Stops remain available even while a check/start request or confirmation dialog is pending.
async function stop(panic) {
    $('confirm-dialog').close('cancel');
    try { await api('action', { action: panic ? 'panic' : 'stop', requestId: crypto.randomUUID() }); message(panic ? '緊急停止を受け付けました。PCで確認するまで再開始できません。' : '停止を受け付けました。OBSの停止確認まで状態表示をご覧ください。'); }
    catch (e) { message('停止できたか確認できません。再接続して状態を確認し、必要ならPCのOBSを停止してください。'); }
    await refresh();
}
$('stop').onclick = () => { void stop(false); };
$('panic').onclick = () => { void stop(true); };
addEventListener('online', () => { void refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { void refresh(); }, 2500); void refresh();
