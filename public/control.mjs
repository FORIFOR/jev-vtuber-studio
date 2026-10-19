// Live Control Panel (/control; docs/CONTROL.md, NOA Studio Phase 6): every live switch on one screen for the operator
// (never the stream): who speaks, what Noa listens to, who plays, her face, the input status, the big buttons and the
// hotkeys. It reads /api/session and /api/monitor and acts through the same APIs as the Studio. Admin only.
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, keyName } from './hotkeys.mjs';

const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const admin = fragment.get('admin') || sessionStorage.getItem('jvs-admin') || '';
if (fragment.get('admin')) { sessionStorage.setItem('jvs-admin', admin); history.replaceState(null, '', location.pathname); }
const FACES = { neutral: 'ふつう', happy: 'うれしい', laugh: '笑う', excited: 'わくわく', surprised: 'びっくり', troubled: '困った', thinking: '考え中', embarrassed: '照れ' };
let session = null, monitor = null, hotkeyMap = { ...DEFAULT_HOTKEYS }, draft = null, armed = {};

async function api(path, data) {
    const r = await fetch(path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${admin}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
}
function notice(text) { $('lcp-notice').textContent = text; $('lcp-notice').hidden = !text; }
async function act(fn) { try { notice(''); await fn(); } catch (e) { notice(e.message); } finally { void refresh(); } }
const control = (action, extra = {}) => act(() => api('/api/control', { action, ...extra }));
/** A dangerous button acts on its second press within 3 s. */
function twice(id, fn) {
    if (armed[id] && Date.now() - armed[id] < 3000) { armed[id] = 0; $(id)?.classList.remove('armed'); return fn(); }
    armed[id] = Date.now(); $(id)?.classList.add('armed'); notice('もう一度押すと実行します（3秒以内）。');
    setTimeout(() => { if (armed[id] && Date.now() - armed[id] >= 3000) { armed[id] = 0; $(id)?.classList.remove('armed'); } }, 3100);
}

function render() {
    const s = session?.status || {}, c = s.control || {}, g = session?.gameRunner || {}, running = !!s.running, busy = !running || !!c.switching;
    $('lcp-live').textContent = s.panic ? '● 緊急停止中' : running ? '● LIVE' : '● 停止中'; $('lcp-live').classList.toggle('on', running);
    $('lcp-remaining').textContent = running ? `残り ${Math.ceil((s.remainingMs || 0) / 60000)} 分` : '';
    for (const b of document.querySelectorAll('[data-voice]')) { b.classList.toggle('on', c.voice === b.dataset.voice); b.disabled = busy; }
    const how = { resynth: 'コハクで読み直し', rvc: 'RVC', passthrough: 'OBSの人間マイク' }[c.humanVoiceMode] || '';
    const lat = c.latency;
    $('lcp-voice-note').textContent = [c.switching ? '切り替え中…' : '', c.micError ? `マイクを確認してください（${c.micError}）` : '', `人間の声：${how}`,
        lat ? `交代時間 停止 ${lat.silentMs ?? '—'} ms／再開 ${lat.resumeMs ?? '—'} ms` : ''].filter(Boolean).join(' ・ ');
    for (const b of document.querySelectorAll('[data-listen]')) { b.classList.toggle('on', c.listening === b.dataset.listen); b.disabled = !running; }
    const gameOn = !!g.enabled && ['starting', 'playing', 'restarting'].includes(g.state);
    for (const b of document.querySelectorAll('[data-game]')) {
        b.classList.toggle('on', b.dataset.game === 'off' ? !gameOn : gameOn && g.player === b.dataset.game);
        b.disabled = !g.enabled || !!g.switching || (b.dataset.game !== 'off' && !gameOn);
    }
    $('lcp-game-note').textContent = !g.enabled ? 'この番組にはAIが操作するゲームがありません' : [g.detail, g.switching ? '切り替え中…' : '', g.warning || '', g.ack ? `確認 ${g.ack.ms} ms` : ''].filter(Boolean).join(' ・ ');
    for (const b of document.querySelectorAll('[data-avatar]')) b.classList.toggle('on', (c.avatar || 'auto') === b.dataset.avatar);
    for (const b of document.querySelectorAll('[data-face]')) { b.classList.toggle('on', c.avatar === 'manual' && c.face === b.dataset.face); }
    $('lcp-takeover').disabled = busy || c.voice === 'human'; $('lcp-resume').disabled = busy || c.voice === 'ai'; $('lcp-mute').disabled = busy || c.voice === 'none';
    $('lcp-stop').disabled = !running && !s.pending;
    const call = monitor?.collab, rows = [
        ['通話（Discord）', !call ? '—' : `${call.speaking ? '相手が話しています' : '待機'} ・ 音声認識 ${call.stt?.error ? `エラー（${call.stt.error}）` : call.stt?.ms ? `${call.stt.ms} ms` : '未使用'}`],
        ['人間マイク', c.micError ? `エラー（${c.micError}）` : c.voice === 'human' ? '使用中' : '待機'],
        ['コメント', [s.streamTarget !== 'twitch' ? `YouTube ${s.youtube || '—'}` : '', s.streamTarget !== 'youtube' ? `Twitch ${s.twitch || '—'}` : ''].filter(Boolean).join(' ・ ')],
        ['ノアの声', s.voiceCredit || '—'],
        ['状態', s.phase || '—'],
    ];
    $('lcp-status').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
}
function renderKeys() {
    const map = draft || hotkeyMap, byAction = Object.fromEntries(Object.entries(map).map(([k, a]) => [a, k]));
    $('lcp-keys').replaceChildren(...Object.entries(HOTKEY_ACTIONS).map(([action, label]) => {
        const tr = document.createElement('tr'), name = document.createElement('td'), cell = document.createElement('td'), input = document.createElement('input');
        name.textContent = label; input.readOnly = true; input.value = byAction[action] || ''; input.placeholder = '（なし）';
        input.onkeydown = e => {
            e.preventDefault(); e.stopPropagation();
            const next = { ...(draft || hotkeyMap) };
            for (const [k, a] of Object.entries(next)) if (a === action || (['Backspace', 'Delete'].includes(e.key) ? false : k === keyName(e))) delete next[k];
            if (!['Backspace', 'Delete'].includes(e.key)) { const key = keyName(e); if (!key) { notice('F1〜F19、または Ctrl/Alt/Shift/Cmd と英数字の組み合わせにしてください。'); return; } next[key] = action; }
            draft = next; renderKeys();
        };
        cell.append(input); tr.append(name, cell); return tr;
    }));
}
async function refresh() {
    try { session = await api('/api/session'); } catch (e) { notice(e.message); return; }
    try { monitor = await api('/api/monitor'); } catch { }
    render();
}

for (const b of document.querySelectorAll('[data-voice]')) b.onclick = () => control('voice', { to: b.dataset.voice });
for (const b of document.querySelectorAll('[data-listen]')) b.onclick = () => control('listening', { to: b.dataset.listen });
for (const b of document.querySelectorAll('[data-avatar]')) b.onclick = () => control('avatar', { to: b.dataset.avatar });
for (const b of document.querySelectorAll('[data-game]')) {
    b.id ||= `lcp-game-${b.dataset.game}`;
    b.onclick = () => b.dataset.game === 'off'
        ? twice(b.id, () => act(() => api('/api/game/runner', { action: 'stop' })))
        : act(() => api('/api/game/player', { player: b.dataset.game }));
}
$('lcp-faces').replaceChildren(...Object.entries(FACES).map(([face, label]) => { const b = document.createElement('button'); b.dataset.face = face; b.textContent = label; b.onclick = () => control('avatar', { to: 'manual', face }); return b; }));
$('lcp-takeover').onclick = () => control('voice', { to: 'human' });
$('lcp-resume').onclick = () => control('voice', { to: 'ai' });
$('lcp-mute').onclick = () => control('voice', { to: 'none' });
$('lcp-stop').onclick = () => twice('lcp-stop', () => control('panic'));
$('lcp-keys-save').onclick = () => act(async () => { const r = await api('/api/hotkeys', { map: draft || hotkeyMap }); hotkeyMap = r.map; draft = null; renderKeys(); notice('ショートカットを保存しました。'); });
$('lcp-keys-reset').onclick = () => act(async () => { const r = await api('/api/hotkeys', { reset: true }); hotkeyMap = r.map; draft = null; renderKeys(); });
document.addEventListener('keydown', e => {
    if (e.repeat || e.target?.closest?.('input, textarea, select')) return;
    const name = hotkeyMap[keyName(e)];
    if (!name) return;
    e.preventDefault();
    void control('hotkey', { name });
});

if (!admin) notice('Studio から開いてください（管理者の情報がありません）。');
api('/api/hotkeys').then(r => { hotkeyMap = r.map; renderKeys(); }).catch(() => renderKeys());
void refresh();
setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 1000);
