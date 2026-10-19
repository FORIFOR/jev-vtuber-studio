import { OUTFITS, DEFAULT_OUTFIT_ID, isOutfitId } from './avatar-outfits.mjs';
import { AVATAR_MODES, DEFAULT_AVATAR_MODE, isAvatarMode } from './avatar-modes.mjs';

import { participationRows } from './participation-view.mjs';
import { SponsorDraft, SponsorView, SPONSOR_DEFAULTS, SPONSOR_IMAGE_TYPES, SPONSOR_IMAGE_LIMIT, sponsorLabel, isSponsorSnapshot } from './sponsor-view.mjs';
import { initAdsPanel } from './ads-panel.mjs';
import { goLive } from './go-live.mjs';
import { DEFAULT_HOTKEYS, keyName } from './hotkeys.mjs';
const $ = id => document.getElementById(id);
let controlState = { voice: 'ai', listening: 'comments' }; // who speaks as Noa (src/control.mjs); read by F6 / F8
let choosingProgramme = false; // declared first: the session refresh (and its picker render) can run during the top-level await below
const fragment = new URLSearchParams(location.hash.slice(1));
let admin = fragment.get('admin') || sessionStorage.getItem('jvs-admin') || '';
let view = '', es, session;
let wardrobe = { outfitId: DEFAULT_OUTFIT_ID, revision: -1 }, outfitSaving = false, wardrobeConnected = false, wardrobeInitial = true, outfitError = '';
let avatarSelection = { mode: DEFAULT_AVATAR_MODE, revision: -1 }, avatarSaving = false, avatarConnected = false, avatarInitial = true, avatarError = '';
const avatarLabels = { noa: '2D', vrm: '3D', builtin: 'SVG', png: 'PNG', external: '外部' };
// No in-Studio preview: a second copy of the stage cost too much memory while streaming. What airs is checked in OBS
// (or the stage tab); these labels report only what is saved.
function avatarDisplayLabel() { return `${avatarLabels[avatarSelection.mode]}選択済み`; }
for (const mode of AVATAR_MODES) {
    const label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('span');
    input.type = 'radio'; input.name = 'avatar-mode'; input.value = mode.id;
    name.textContent = mode.label; label.append(input, name); $('avatar-mode-options').append(label);
}
function updateAvatarMode(snapshot, authoritative = false) {
    if (!snapshot || !isAvatarMode(snapshot.mode) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return;
    if (!authoritative && snapshot.revision < avatarSelection.revision) return;
    avatarSelection = snapshot;
    renderAvatarMode();
}
function renderAvatarMode() {
    const selected = avatarLabels[avatarSelection.mode];
    for (const input of $('avatar-mode-options').querySelectorAll('input')) input.checked = input.value === avatarSelection.mode;
    $('avatar-mode-group').disabled = !avatarConnected || avatarSaving;
    $('avatar-mode-group').setAttribute('aria-busy', String(avatarSaving));
    $('avatar-mode-status').textContent = avatarError || (avatarSaving ? '保存中' : avatarSelection.warning || (!avatarConnected ? '再接続待ち' :
        `${selected}保存済み（OBSの画面に反映）`));
    if (session?.vtsEnabled) $('avatar-mode-status').textContent += ' / OBSは外部アバター設定';
    renderWardrobe();
}
$('avatar-mode-options').addEventListener('change', async event => {
    const mode = event.target.value;
    if (avatarSaving || !avatarConnected || !isAvatarMode(mode)) return;
    avatarSaving = true; avatarError = ''; renderAvatarMode();
    try { updateAvatarMode(await api('/api/avatar/mode', { mode })); }
    catch (error) {
        try { updateAvatarMode(await api('/api/avatar/mode')); } catch { }
        avatarError = error.message;
    } finally { avatarSaving = false; renderAvatarMode(); }
});
for (const outfit of OUTFITS) {
    const option = document.createElement('option');
    option.value = outfit.id; option.textContent = outfit.label;
    $('outfit-select').append(option);
}
function updateWardrobe(snapshot, authoritative = false) {
    if (!snapshot || !isOutfitId(snapshot.outfitId) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return;
    if (!authoritative && snapshot.revision < wardrobe.revision) return;
    wardrobe = snapshot;
    renderWardrobe();
}
function renderWardrobe() {
    const outfit = OUTFITS.find(item => item.id === wardrobe.outfitId);
    $('outfit-select').value = wardrobe.outfitId;
    $('outfit-select').disabled = !wardrobeConnected || outfitSaving || !avatarConnected || avatarSaving || avatarSelection.mode !== 'vrm';
    $('outfit-select').setAttribute('aria-busy', String(outfitSaving));
    $('outfit-swatches').replaceChildren(...outfit.colors.map(color => {
        const swatch = document.createElement('i'); swatch.style.backgroundColor = color; return swatch;
    }));
    $('outfit-status').textContent = outfitError || (outfitSaving ? '保存中' : wardrobe.warning || (!wardrobeConnected ? '再接続待ち' :
        avatarSelection.mode !== 'vrm' ? '保存済み / 2Dでは未適用' :
        '衣装保存済み（OBSの画面に反映）'));
}
$('outfit-select').addEventListener('change', async () => {
    const outfitId = $('outfit-select').value;
    if (outfitSaving || !wardrobeConnected || !avatarConnected || avatarSaving || avatarSelection.mode !== 'vrm' || !isOutfitId(outfitId)) return;
    outfitSaving = true; outfitError = ''; renderWardrobe();
    try { updateWardrobe(await api('/api/avatar/wardrobe', { outfitId })); }
    catch (error) {
        // A lost response may follow a successful save; read the authoritative selection.
        try { updateWardrobe(await api('/api/avatar/wardrobe')); } catch { }
        outfitError = error.message;
    } finally { outfitSaving = false; renderWardrobe(); }
});

// Sponsor drafts are local until an explicit save; a reconnect cannot overwrite edits.
const sponsorDraft = new SponsorDraft();
// The ad library panel (広告 tab) shares the sponsor slot's master switch; declared before the first renderSponsor().
const adsPanel = initAdsPanel({ $, api, token: () => admin, onMaster: enabled => publishSponsorEnabled(enabled) });
let sponsorConnected = false, sponsorInitial = true, sponsorSaving = false, sponsorUploading = false, sponsorMessage = '', sponsorUploadEpoch = 0, sponsorImageState = 'visible';
const sponsorPreview = new SponsorView($('sponsor-draft-preview'), { token: () => admin, onState: state => {
    sponsorImageState = state;
    $('sponsor-save').disabled = !sponsorDraft.dirty || (!!sponsorDraft.imageBlob && ['loading', 'image-error'].includes(state));
    if (state === 'image-error') $('sponsor-image-name').textContent = '画像を読み込めません。画像を選び直してください。';
} });
function syncSponsorForm() {
    const value = sponsorDraft.value;
    $('sponsor-enabled').checked = value.enabled;
    for (const key of ['mode', 'title', 'message', 'link']) $(`sponsor-${key}`).value = value[key];
}
function receiveSponsor(snapshot, authoritative = false) {
    if (!isSponsorSnapshot(snapshot)) return;
    sponsorConnected = true;
    if (sponsorDraft.receive(snapshot, authoritative)) syncSponsorForm();
    renderSponsor();
}
function renderSponsor() {
    const saved = sponsorDraft.saved, draft = sponsorDraft.value;
    $('sponsor-fields').disabled = !sponsorConnected || sponsorSaving || sponsorUploading;
    $('sponsor-form').setAttribute('aria-busy', String(sponsorSaving || sponsorUploading));
    $('sponsor-save').disabled = !sponsorDraft.dirty;
    $('sponsor-reset').disabled = !sponsorDraft.dirty;
    $('sponsor-hide').disabled = sponsorSaving || !saved?.enabled;
    $('sponsor-paid-note').hidden = draft.mode !== 'sponsor';
    $('sponsor-image-remove').disabled = !draft.image && !sponsorDraft.imageBlob;
    $('sponsor-image-name').textContent = sponsorDraft.imageBlob ? `選択済み：${sponsorDraft.imageBlob.name}` : draft.image ? '保存済みの画像を使用' : '画像なし · PNG / JPEG / WebP、2MBまで';
    $('sponsor-current').textContent = saved ? saved.enabled ? `${sponsorLabel(saved.mode)} · 表示設定ON` : '非表示' : '接続待ち';
    adsPanel?.master(!!saved?.enabled);
    let status = !sponsorConnected ? '再接続待ち' : sponsorSaving ? '保存中…' : sponsorUploading ? '画像を確認中…' :
        !saved ? '設定を確認中' : `${saved.enabled ? '表示' : '非表示'}設定を保存済み（OBSの画面に反映）`;
    if (sponsorDraft.dirty) status += sponsorDraft.baseRevision !== saved?.revision ? ' / 他の画面で更新されました。保存済みに戻してから編集してください。' : ' / 未保存の変更があります。';
    $('sponsor-status').textContent = sponsorMessage || status;
    sponsorPreview.render(draft, { draft: true, imageBlob: sponsorDraft.imageBlob });
}
for (const name of ['enabled', 'mode', 'title', 'message', 'link']) {
    const input = $(`sponsor-${name}`);
    input.addEventListener(name === 'enabled' || name === 'mode' ? 'change' : 'input', () => {
        sponsorDraft.edit({ [name]: name === 'enabled' ? input.checked : input.value });
        sponsorMessage = ''; renderSponsor();
    });
}
$('sponsor-image').addEventListener('change', async () => {
    const file = $('sponsor-image').files[0], epoch = ++sponsorUploadEpoch;
    if (!file) return;
    sponsorMessage = '';
    if (!SPONSOR_IMAGE_TYPES.includes(file.type) || file.size > SPONSOR_IMAGE_LIMIT || !file.size) {
        sponsorMessage = 'PNG・JPEG・WebPの画像を2MB以内で選んでください。'; $('sponsor-image').value = ''; renderSponsor(); return;
    }
    sponsorUploading = true; renderSponsor();
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = ''; for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        if (epoch !== sponsorUploadEpoch) return;
        sponsorDraft.image({ mime: file.type, base64: btoa(binary) }, file);
    } catch { sponsorMessage = '画像を読み込めませんでした。もう一度選んでください。'; }
    finally { if (epoch === sponsorUploadEpoch) { sponsorUploading = false; renderSponsor(); } }
});
$('sponsor-image-remove').onclick = () => { sponsorUploadEpoch++; sponsorDraft.image(null); $('sponsor-image').value = ''; sponsorMessage = ''; renderSponsor(); };
$('sponsor-recruitment').onclick = () => {
    sponsorUploadEpoch++;
    sponsorDraft.edit({ mode: 'recruitment', title: SPONSOR_DEFAULTS.title, message: SPONSOR_DEFAULTS.message });
    sponsorDraft.image(null); $('sponsor-image').value = '';
    sponsorMessage = ''; syncSponsorForm(); renderSponsor();
};
$('sponsor-reset').onclick = () => { sponsorUploadEpoch++; sponsorDraft.reset(); $('sponsor-image').value = ''; sponsorMessage = ''; syncSponsorForm(); renderSponsor(); };
$('sponsor-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (sponsorSaving || sponsorUploading || !sponsorConnected || !sponsorDraft.dirty || (sponsorDraft.imageBlob && ['loading', 'image-error'].includes(sponsorImageState))) return;
    sponsorSaving = true; sponsorMessage = ''; renderSponsor();
    try {
        const snapshot = await api('/api/sponsor', sponsorDraft.payload());
        sponsorDraft.receive(snapshot); sponsorDraft.reset(); $('sponsor-image').value = ''; syncSponsorForm();
    } catch (error) {
        // An uncertain network response may have saved successfully. Read current state, retaining the draft.
        if (error.current) receiveSponsor(error.current);
        else try { receiveSponsor(await api('/api/sponsor')); } catch { }
        sponsorMessage = error.status === 409 ? '別の画面で更新されました。下書きは残しています。「保存済みに戻す」で最新の内容を確認してください。' : error.message;
    } finally { sponsorSaving = false; renderSponsor(); }
});
/** The master switch (広告枠を表示する / 今すぐ非表示): flips `enabled` on the saved content, never on the unsaved draft. */
async function publishSponsorEnabled(enabled) {
    if (sponsorSaving || !sponsorDraft.saved) return;
    sponsorSaving = true; sponsorMessage = ''; renderSponsor();
    const baseRevision = sponsorDraft.baseRevision;
    try {
        let current = sponsorDraft.saved;
        for (let attempt = 0; attempt < 2; attempt++) {
            const { revision, mode, title, message, link } = current;
            try {
                const snapshot = await api('/api/sponsor', { revision, enabled, mode, title, message, link });
                receiveSponsor(snapshot);
                if (baseRevision === current.revision) sponsorDraft.baseRevision = snapshot.revision;
                break;
            } catch (error) {
                if (error.status !== 409 || attempt) throw error;
                current = error.current || await api('/api/sponsor'); receiveSponsor(current);
            }
        }
    } catch (error) {
        try { receiveSponsor(await api('/api/sponsor')); } catch { }
        sponsorMessage = sponsorDraft.saved?.enabled !== enabled ? '表示の切り替えに失敗しました。接続を確認して、もう一度押してください。' : '表示設定が保存されていることを確認しました。';
    } finally { sponsorSaving = false; syncSponsorForm(); renderSponsor(); }
}
$('sponsor-hide').onclick = () => publishSponsorEnabled(false);
addEventListener('pagehide', event => { if (!event.persisted) sponsorPreview.dispose(); });
syncSponsorForm(); renderSponsor();

for (const button of document.querySelectorAll('.workspace-tabs button')) button.onclick = () => {
    const tab = button.dataset.workspaceTab;
    $('workspace').dataset.workspaceTab = tab;
    for (const item of document.querySelectorAll('.workspace-tabs button')) item.setAttribute('aria-pressed', String(item === button));
};
if (fragment.has('admin')) {
    sessionStorage.setItem('jvs-admin', admin);
    history.replaceState(null, '', '/');
}
if ($('performance-link')) $('performance-link').href = `http://127.0.0.1:8792/#admin=${encodeURIComponent(admin)}`;
if ($('analytics-link')) $('analytics-link').href = `http://127.0.0.1:8790/#admin=${encodeURIComponent(admin)}`;
async function api(path, data) { const r = await fetch(path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${admin}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); const result = await r.json(); if (!r.ok)
    throw Object.assign(new Error((result.error || '接続に失敗しました') + (result.detail ? `（原因: ${result.detail}）` : '')), { status: r.status, current: result.current, detail: result.detail, chat: result.chat }); return result; }
function notice(text) { $('notice').textContent = text; }
let gameRunner = null, hostName = 'ノア'; // the character's name from status (config/character.json)
let reporting = false; // a match report in flight (the buttons wait for the answer)
const targetName = target => ({ youtube: 'YouTubeのみ', twitch: 'Twitchのみ', simulcast: 'YouTube＋Twitch（同時配信）' })[target] || '未選択';
let switchingTarget = false;
async function checkDestination() {
    const d = await api('/api/obs/destination');
    $('stream-target-state').textContent = `OBS：${d.service || '未設定'} ／ ${d.profile || '不明'}${d.ready ? '（一致）' : '（要確認）'}`;
    if (!d.ready) throw new Error('配信先を選択して切り替えてください。OBSの送信先との一致を確認できません。');
    return d;
}
$('stream-target-apply').onclick = async () => {
    switchingTarget = true; $('stream-target-apply').disabled = true;
    try {
        const target = $('stream-target').value;
        await api('/api/obs/destination', { target });
        await refreshSession(); await checkDestination();
        notice(`${targetName(target)}に切り替えました。配信はまだ開始していません。`);
    } catch (e) { notice(e.message); }
    finally { switchingTarget = false; liveSteps(); }
};

/** The four steps to go live, each from the real state (nothing here starts anything by itself). */
const refreshSession = () => api('/api/session').then(x => { session = x; renderMemory(x.memory); gameRunner = x.gameRunner; liveSteps(); renderProgrammes(); renderYouTube(); }).catch(() => { });
// ---- Today's programme: tiles in plain words; one tap saves it and builds its OBS scene (server: /api/programme/select).
function programmeLine(p) {
    if (p.style === 'game' && p.game) return `${p.game.title}・${p.game.player === 'operator' ? 'あなたが操作' : 'AIが操作'}・${p.game.capture === 'switch' ? 'Switchの映像' : 'Macのゲーム画面'}`;
    return p.style === 'blocks' ? '内蔵のブロックゲーム' : p.style === 'consult' ? '相談トーク・相談がないときは内蔵ゲーム' : 'トークのみ（ゲームなし）';
}
function stageLink() {
    if (!view) return;
    const chosen = session?.setup?.programmes?.find(p => p.id === session.setup.values?.SHOW_PROGRAMME);
    $('stage-link').href = `/stage#token=${view}${chosen?.style === 'game' ? '&layout=game' : ''}`;
}
function renderProgrammes() {
    stageLink();
    const list = session?.setup?.programmes || [], current = session?.setup?.values?.SHOW_PROGRAMME, box = $('programme-choices');
    if (!box || !list.length) return;
    const locked = !!session.status?.running || !!session.obsOwned;
    const key = JSON.stringify([list.map(p => [p.id, p.title, p.style, p.game?.id]), current, locked, choosingProgramme]);
    if (box.dataset.key === key) return; box.dataset.key = key;
    const tile = p => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'programme-choice'; b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(p.id === current)); b.disabled = locked || choosingProgramme;
        const icon = document.createElement('span'); icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = p.style === 'game' ? '🎮' : p.style === 'blocks' ? '🧱' : p.style === 'consult' ? '🗨️' : '💬';
        const name = document.createElement('strong'); name.textContent = p.title;
        const line = document.createElement('small'); line.textContent = programmeLine(p);
        b.append(icon, name, line); b.onclick = () => chooseProgramme(p); return b;
    };
    // Game programmes first; talk-only ones fold away (open when one of them is the current choice).
    const games = list.filter(p => p.style === 'game' || p.style === 'blocks'), talks = list.filter(p => !games.includes(p));
    const fold = document.createElement('details'); fold.className = 'programme-talks'; fold.open = talks.some(p => p.id === current);
    const sum = document.createElement('summary'); sum.textContent = `トークの番組（${talks.length}）`;
    const inner = document.createElement('div'); inner.className = 'programme-choices'; inner.append(...talks.map(tile));
    fold.append(sum, inner);
    box.replaceChildren(...games.map(tile), ...(talks.length ? [fold] : []));
    if (locked && !choosingProgramme) setPickerState('番組の終了後に切り替えられます。');
}
function setPickerState(text, bad = false, link = null) {
    const el = $('programme-choice-state'); el.className = bad ? 'picker-state bad' : 'picker-state'; el.textContent = text;
    if (link) { const a = document.createElement('a'); a.href = link.href; a.textContent = link.text; el.append(a); }
}
async function chooseProgramme(p) {
    if (choosingProgramme) return;
    choosingProgramme = true; renderProgrammes(); setPickerState(`「${p.title}」に切り替えています…`);
    try {
        const r = await api('/api/programme/select', { id: p.id });
        const parts = [`「${p.title}」にしました（${programmeLine(p)}）。`];
        if (r.obs?.ok) parts.push(`OBSに「${r.obs.scene}」を用意しました。`);
        let bad = false, link = null;
        if (r.obs && !r.obs.ok) { parts.push(`OBS：${r.obs.error}`); bad = true; }
        if (r.switchReady === false) { parts.push('Switchの映像機器が未設定です。'); bad = true; link = { href: '/switch', text: 'Switch接続を開く' }; }
        else if (!r.heard) { parts.push('配信の前に、この設定で声の試聴確認が1回必要です。'); link = { href: '/setup#trial', text: '試聴を開く' }; }
        setPickerState(parts.join(' '), bad, link);
    } catch (e) { setPickerState(e.message, true); }
    finally { choosingProgramme = false; await refreshSession(); }
}
/** Which model the generator and judge use now: the optional remote machine (LLM_REMOTE_URL) or this Mac's own. */
function llmRouteLabel(r) {
    if (!r?.configured) return '';
    return r.active === 'remote' ? `RTX: ${r.model}` : `Mac: ${r.localModel}${r.lastError ? `（RTX不可: ${r.lastError}）` : ''}`;
}
function liveSteps(s = session?.status) {
    if (!session || !s) return;
    const step = (id, done, text, live = false) => { const li = $(id); li.classList.toggle('done', !!done); li.classList.toggle('live', !!live); li.querySelector('em').textContent = text; };
    if (!switchingTarget && document.activeElement !== $('stream-target')) $('stream-target').value = session.streamTarget || '';
    $('stream-target').disabled = s.running || session.obsOwned || switchingTarget;
    $('stream-target-apply').disabled = s.running || session.obsOwned || switchingTarget;
    const heard = s.mode === 'demo' || !!session.rehearsalHeard || !!session.rehearsalApproved;
    step('step-heard', heard, session.rehearsalHeard || s.mode === 'demo' ? '確認済み' : session.rehearsalApproved ? '確認済み（開始時に自動検証）' : '未確認');
    step('step-obs', session.obsConnected, session.obsConnected ? 'OBS接続済み' : 'OBS未接続');
    step('step-show', s.running, s.running ? '話し中' : '停止中');
    step('step-stream', !!session.obsOwned && s.running, !session.allowStream ? 'OBSの画面で開始' : session.obsOwned ? '配信中' : '未開始', !!session.obsOwned);
    $('go-live').textContent = !s.running ? '● 配信を始める' : session.obsOwned ? '■ 配信を終了（挨拶してから）' : '■ 番組を終了（挨拶してから）';
    $('go-live').className = s.running ? 'secondary full' : 'primary full';
    $('live-programme').textContent = s.topic?.title || '';
    const g = gameRunner || session.gameRunner, v = s.gameShow?.external ? s[s.gameShow.statusKey] : null;
    // Opening talk: the operator announces the game when enough people are here (or it starts at the lobby time limit).
    $('start-game').hidden = !(s.running && v?.phase === 'lobby');
    $('start-game-note').textContent = v?.lobbyEndsAt ? `（雑談中・${Math.max(0, Math.ceil((v.lobbyEndsAt - Date.now()) / 60000))}分後に自動で開始）` : '';
    $('game-kpi').hidden = !g?.enabled;
    const operatorGame = v?.player === 'operator';
    $('step-show-note').textContent = g?.enabled ? `ゲーム（${g.game?.title || s.gameShow?.title || '外部ゲーム'}）も自動で起動します。上限 ${g.limits.minutes}分・約$${g.limits.maxCostUsd}${g.gameAudio ? '・ゲーム音あり' : ''}`
        : operatorGame ? `ゲーム（${s.gameShow?.title || g?.game?.title || '外部ゲーム'}）は配信者が操作します。映像は「Switch接続」で選んだ機器から${g?.gameAudio ? '、ゲーム音も' : '（ゲーム音はオフ）'}。` : '';
    // A person plays: the operator reports the match (start, KO, result) and Noa comments on just that.
    const report = $('game-report'); report.hidden = !(s.running && operatorGame && v.phase !== 'lobby');
    if (!report.hidden) {
        const playing = v.phase === 'playing';
        $('game-report-state').textContent = playing ? `試合${v.match}：撃墜 ${v.kos}・被撃墜 ${v.stocksLost}` : v.phase === 'results' ? `試合${v.match} ${v.lastResult?.result === 'won' ? '勝ち' : v.lastResult?.result === 'lost' ? '負け' : '終了'}` : `今日 ${v.wins}勝${v.losses}敗`;
        for (const b of report.querySelectorAll('[data-game-event]')) b.disabled = reporting || (b.dataset.gameEvent === 'match_start' ? false : !playing);
    }
    if (g?.enabled) {
        const isHuman = g.player === 'human';
        const isGameRunning = ['starting', 'playing', 'restarting'].includes(g.state);
        if ($('game-kpi-label')) $('game-kpi-label').textContent = isHuman ? 'ゲーム（ユーザーがプレイ中）' : (g.standalone ? 'ゲーム（AI単体プレイ中・配信外）' : 'ゲーム（AIがプレイ中）');
        // Game control (Phase 5): confirmed by the controller's answer; a missing answer is shown as a warning.
        if ($('game-owner-state')) $('game-owner-state').textContent = `ゲーム操作：${isHuman ? '人間' : 'AI'}${g.switching ? '（切り替え中）' : g.warning ? `（${g.warning}）` : g.ack ? `（確認 ${g.ack.ms} ms${g.ack.phase && g.ack.phase !== 'combat' && !isHuman ? `・${g.ack.phase}の画面の終わり待ち` : ''}）` : ''}`;
        if ($('switch-game-player')) {
            $('switch-game-player').disabled = !!g.switching;
            $('switch-game-player').hidden = !isGameRunning;
            $('switch-game-player').textContent = isHuman ? '🤖 AI（ノア）操作に切替' : '👤 ユーザー操作に切替';
            $('switch-game-player').title = isHuman ? 'ノアにプレイを引き継ぎます' : 'あなたがプレイします（AIのキー入力を停止）';
        }
        if ($('toggle-game-runner')) {
            $('toggle-game-runner').textContent = isGameRunning ? '■ ゲーム停止' : '🎮 ゲーム単体起動';
            $('toggle-game-runner').className = isGameRunning ? 'quiet' : 'secondary';
        }
        $('game-state').textContent = ({ idle: '待機中', starting: '起動中', playing: isHuman ? 'プレイ中（ユーザー操作）' : 'プレイ中', restarting: '次のプレイを準備中', stopping: '停止中', stopped: '停止', finished: '終了', failed: '停止（エラー）' })[g.state] || g.state;
        $('game-detail').textContent = g.detail || '';
    }
    renderProgrammes(); // locked while a show runs or OBS is live
}
const phases = { stopped: '待機中', awaiting_audio: '音声出力の接続待ち', thinking: '次の言葉を考えています', preparing_audio: '次の文の音声を準備中', ready: '音声を準備', speaking: 'お話し中', reading_comment: 'コメントを読み上げ中（返答を準備）', listening: 'コメントを待っています', holding: '発話を保留', emergency: '緊急停止中', human_voice: '人間がノアの声で話しています（AIは待機）', muted: 'ノアは無音です（AIも人間も話していません）' };
function update(s) {
    $('mode').textContent = s.mode === 'demo' ? 'DEMO' : 'LIVE API';
    $('runtime-mode').textContent = s.mode === 'demo' ? 'デモ / 外部APIなし' : 'ローカル判定 + 会話モデル';
    $('phase').textContent = (phases[s.phase] || s.phase) + (s.generationRetryInMs > 0 ? ` · 次の生成は約${Math.ceil(s.generationRetryInMs / 1000)}秒後に再試行` : '');
    $('state-dot').classList.toggle('running', s.running);
    $('remaining').textContent = s.running ? `残り ${Math.ceil(s.remainingMs / 60000)} 分 · ローカル自動運転` : '配信先への送信はOBSで確認';
    $('start').disabled = s.running;
    $('start').textContent = s.panic ? '停止を解除する' : '配信せずに試す';
    $('start').dataset.action = s.panic ? 'reset' : 'start';
    $('stop').disabled = !s.running;
    $('current-topic').textContent = s.topic?.title || '—';
    const latency = s.metrics?.latency?.comment_to_answer_ms;
    $('latency').textContent = latency ? `本回答 p50 ${latency.p50} / p95 ${latency.p95} ms` : '本回答は未測定（読み上げを除く）';
    const read = s.metrics?.latency?.comment_to_read_ms, gap = s.metrics?.latency?.read_to_reply_gap_ms;
    if ($('read-latency')) $('read-latency').textContent = read ? `読上開始 p95 ${read.p95} ms / 読了→返答 ${gap ? gap.p95 + ' ms' : '未測定'}` : 'コメント読み上げは未測定';
    $('finish').disabled = !s.running;
    $('pause-comments').textContent = s.commentsPaused ? 'コメント受付を再開' : 'コメント受付を一時停止';
    // Who speaks as Noa and whether she takes up comments (src/control.mjs).
    controlState = s.control || { voice: 'ai', listening: 'comments' };
    const human = controlState.voice === 'human';
    const how = { resynth: '・コハクで読み直し', rvc: '・RVC' }[controlState.humanVoiceMode] || '';
    const who = human ? `人間が話しています${how}` : controlState.voice === 'none' ? 'ノアは無音です' : 'AIが話しています';
    $('voice-state').textContent = `${who}${controlState.micError ? '（マイクを確認してください）' : ''}${controlState.switching ? '（切り替え中）' : ''}`;
    const busy = !s.running || !!controlState.switching;
    $('voice-ai').disabled = busy || controlState.voice === 'ai'; $('voice-human').disabled = busy || human; $('voice-none').disabled = busy || controlState.voice === 'none';
    const lat = controlState.latency;
    $('handoff-latency').textContent = lat ? `交代時間：AI停止まで ${lat.silentMs ?? '—'} ms（中央値 ${lat.silentP50 ?? '—'}）／AI再開まで ${lat.resumeMs ?? '—'} ms（中央値 ${lat.resumeP50 ?? '—'}）` : '交代時間：—';
    if (document.activeElement !== $('listening-mode')) $('listening-mode').value = controlState.listening;
    $('listening-mode').disabled = !s.running;
    $('queue').textContent = `${s.queue} 件待ち`;
    renderParticipationStats(s.participation);
    $('jev').textContent = s.mode === 'demo' ? 'デモルール（判定なし）' : s.jevMs !== null ? `${s.jevMs} ms / 直近` : '判定待ち';
    $('llm-route').textContent = llmRouteLabel(session?.llmRoute);
    $('spoken').textContent = `${s.stats.spoken} 発話`;
    $('renderer').textContent = [avatarDisplayLabel(), s.renderer ? '音声接続済み' : '音声待ち'].join(' / ');
    renderAvatarMode();
    $('research').textContent = ({ idle: '待機中', searching: '別の処理で調査中', ready: '返答待ち', unavailable: '取得できませんでした' })[s.research] || s.research;
    if ($('twitch')) $('twitch').textContent = ({ not_configured: '未設定', not_connected: '接続待ち', connecting: '接続中', connected: '受信中', reconnecting: '再接続中', auth_error: '再認証が必要', stopped: '停止' })[s.twitch] || s.twitch || '未設定';
    $('youtube').textContent = ({ not_configured: '未設定', not_connected: '接続待ち', connected: '受信中', unavailable: '接続不可', retrying: '再接続中', ended: '終了', waiting_for_broadcast: '配信開始待ち', connecting_stream: 'ストリーム接続中', listening: '接続済み・コメント待ち', reconnecting: '再接続中', polling_degraded: 'ポーリング受信', auth_or_configuration_error: '認証・設定エラー', auth_error: '認証エラー', permission_or_quota_error: '権限・クォータを確認', budget_exhausted: '回数上限', budget_waiting: '回数上限・枠更新後に自動再接続', stopped: '停止'  })[s.youtube] || s.youtube;
    $('host-name').textContent = s.name; if (s.name && s.name !== hostName) { hostName = s.name; for (const el of document.querySelectorAll('.host-name')) el.textContent = hostName; }
    $('host-channel').textContent = s.channel;
    $('obs-start').disabled = !session?.allowStream || s.mode !== 'live' || !s.hasPlayedLiveAudio || !s.running;
    if (session) session.status = s;
    liveSteps(s);
    $('usage').replaceChildren(...['llm', 'tts', 'search', 'youtube'].map(k => { const row = document.createElement('div'); row.className = 'usage-line'; const left = document.createElement('span'), right = document.createElement('span'); left.textContent = k.toUpperCase(); right.textContent = `${s.usage.calls[k] || 0} / ${s.usage.limits[k]}`; row.append(left, right); return row; }));
}
let participationFingerprint = '';
function renderParticipationStats(snapshot) {
    const target = $('participation-stats'); if (!target || !snapshot) return;
    const rows = participationRows(snapshot), fingerprint = JSON.stringify(rows);
    if (fingerprint === participationFingerprint) return;
    participationFingerprint = fingerprint;
    target.replaceChildren();
    for (const row of rows) {
        const card = document.createElement('div'), title = document.createElement('strong'), totals = document.createElement('p'), latency = document.createElement('p');
        card.className = 'participation-card'; title.textContent = row.platform;
        totals.textContent = `受信 ${row.received}件 · 安全承認 ${row.approved}件 · 返答 ${row.replied}件 · 参加者 ${row.participants}人`;
        latency.textContent = `受信→返答開始：${row.latency}`;
        card.append(title, totals, latency); target.append(card);
    }
}
$('participation-history').onclick = async () => {
    const target = $('participation-history-result');
    target.textContent = '記録を確認しています…';
    try {
        const report = await api('/api/programme/report');
        target.replaceChildren();
        for (const session of report.recentParticipation || []) {
            const card = document.createElement('div'), title = document.createElement('strong');
            card.className = 'participation-card';
            title.textContent = `${new Date(session.startedAt).toLocaleString('ja-JP')} · ${session.stoppedAt ? '終了' : '終了記録なし'}`;
            card.append(title);
            if (!session.participation) {
                const p = document.createElement('p'); p.textContent = 'この配信の参加計測は未導入でした。'; card.append(p);
            } else for (const row of participationRows(session.participation)) {
                const p = document.createElement('p');
                p.textContent = `${row.platform}：参加者 ${row.participants}人 / 返答 ${row.replied}件 / ${row.latency}`;
                card.append(p);
            }
            target.append(card);
        }
        if (!target.children.length) target.textContent = '配信記録はまだありません。';
    } catch (e) { target.textContent = e.message; }
};
function activity(label, text) { const container = $('activity'); container.querySelector('.empty')?.remove(); const row = document.createElement('div'); row.className = 'activity-row'; const time = document.createElement('time'), badge = document.createElement('b'), p = document.createElement('p'); time.textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); badge.textContent = label; p.textContent = text; row.append(time, badge, p); container.prepend(row); while (container.childElementCount > 30)
    container.lastElementChild.remove(); }
function renderMemory(m){if(!$('memory-state'))return;const label={normal:'正常',warning:'余裕が低下',critical:'停止が必要',unknown:'確認できません',disabled:'無効'}[m?.level]||'確認中';$('memory-state').textContent='メモリ監視：'+label+(Number.isFinite(m?.freePercent)?'（余裕指標 '+m.freePercent+'%）':'');}
async function connect() { try {
    session = await api('/api/session');
    updateAvatarMode(session.avatarMode, true);
    updateWardrobe(session.wardrobe, true);
    receiveSponsor(session.sponsor, true);
    adsPanel.receive(session.ads, true);
    renderMemory(session.memory);
    renderProgrammes();
    checkDestination().catch(e => { $('stream-target-state').textContent = e.message; });
    view = session.viewToken;
    $('login').hidden = true;
    $('workspace').hidden = false;
    renderAvatarMode(); renderSponsor(); stageLink();
    $('vts-connect').disabled = !session.vtsEnabled;
    $('vts-connect').hidden = !session.vtsEnabled;
    startMonitor();
    update(session.status);
    es?.close();
    es = new EventSource(`/events?token=${encodeURIComponent(view)}`);
    es.onopen = () => { sponsorInitial = true; sponsorConnected = false; renderSponsor(); avatarInitial = true; avatarConnected = false; wardrobeInitial = true; wardrobeConnected = false; renderAvatarMode(); $('connection').textContent = '● ローカルに接続'; };
    es.onerror = () => { sponsorConnected = false; renderSponsor(); avatarConnected = false; wardrobeConnected = false; renderAvatarMode(); $('connection').textContent = '再接続しています'; };
    es.onmessage = event => { let m; try {
        m = JSON.parse(event.data);
    }
    catch {
        return;
    } if (m.type === 'avatar_mode') {
        const initial = avatarInitial;
        avatarInitial = false; avatarConnected = true; avatarError = '';
        updateAvatarMode(m.data, initial);
    }
    if (m.type === 'wardrobe') {
        const initial = wardrobeInitial;
        wardrobeInitial = false; wardrobeConnected = true; outfitError = '';
        updateWardrobe(m.data, initial);
    }
    if (m.type === 'sponsor') { const initial = sponsorInitial; sponsorInitial = false; receiveSponsor(m.data, initial); }
    if (m.type === 'ads') adsPanel.receive(m.data, true);
    if (m.type === 'memory') renderMemory(m.data); if (m.type === 'operator') {
        const said = { queued: '順番待ち（今の発言の次）', approved: '審査を通過。次に話します', rejected: `審査を通らなかったため話しません（${m.data.reason || '理由不明'}）` }[m.data.state];
        if (said) $('say-result').textContent = said; if (m.data.state === 'queued') activity('OPERATOR', m.data.text);
    } if (session?.status?.gameShow?.external && m.type === session.status.gameShow.statusKey) { session.status[m.type] = m.data; liveSteps(); } if (m.type === 'game_runner') { gameRunner = m.data; liveSteps(); } if (m.type === 'state')
        update(m.data); if (m.type === 'notice')
        notice(m.data.message); if (m.type === 'chat')
        activity('COMMENT', (m.data.text ?? '原文を表示せずに返答を準備します。') + (m.data.route === 'research' ? '（調査へ）' : '')); if (m.type === 'speech_started')
        activity(m.data.role === 'comment' ? 'READ' : 'HOST', m.data.text); if (m.type === 'stop') {
        notice(`自動運転を停止しました（${m.data.reason}）。`);
        api('/api/session').then(x => update(x.status)).catch(() => { });
    } if (m.type === 'research' && m.data.state === 'ready')
        activity('RESEARCH', m.data.count ? `${m.data.count} 件の参考資料を取得。発話の切れ目で返答します。` : '調査のデモが完了（外部検索なし）。発話の切れ目で返答します。'); };
}
catch {
    avatarConnected = false; wardrobeConnected = false; renderAvatarMode();
    $('login').hidden = false;
    $('workspace').hidden = true;
} }
$('login-form').addEventListener('submit', e => { e.preventDefault(); admin = $('admin-input').value.trim(); sessionStorage.setItem('jvs-admin', admin); void connect(); });
async function control(action, extra = {}) { try {
    const r = await api('/api/control', { action, ...extra }); update(r);
    // With a long goodbye configured, stop first says goodbye (about 2 minutes); pressing stop again cuts it short.
    if (action === 'stop' && r?.running && r?.farewell) notice('締めの挨拶をしてから終了します（約2分）。すぐに止めたい時は、もう一度「停止」を押してください。');
}
catch (e) {
    // The server checked the YouTube comments and cannot read them: show why, and start only if the operator agrees.
    if (action === 'start' && e.status === 409 && e.chat) {
        showChatCheck(e.chat);
        const log = (e.chat.log || []).map(x => `${x.ok ? '✓' : '×'} ${x.step}：${x.detail}`).join('\n');
        if (confirm(`YouTube のコメントを読み込めません。\n\n${e.chat.message}${e.chat.hint ? `\n${e.chat.hint}` : ''}\n\n確認ログ:\n${log}\n\nコメントを読まないまま開始しますか？`)) {
            try { update(await api('/api/control', { action, allowUnavailableYouTubeChat: true })); } catch (again) { notice(again.message); }
        } else notice('開始しませんでした。YouTube のコメント設定を直してから、もう一度開始してください。');
        return;
    }
    notice(e.message);
} }
$('start').onclick = () => control($('start').dataset.action || 'start');
$('stop').onclick = () => control('stop');
$('finish').onclick = () => control('finish');
$('next-topic').onclick = () => control('next-topic');
if ($('add-topic-btn')) {
    $('add-topic-btn').onclick = async () => {
        const title = prompt('追加したい話題のテーマやタイトルを入力してください（例：最近ハマっていること、夜食のおすすめ）:');
        if (!title || !title.trim()) return;
        const safeTitle = title.trim();
        const jumpNow = confirm(`追加した話題「${safeTitle}」に今すぐ切り替えますか？\n（「キャンセル」を押すと次の話題として予約されます）`);
        try {
            const r = await api('/api/control', { action: 'add-topic', title: safeTitle, jumpNow });
            notice(`話題「${safeTitle}」を${jumpNow ? '開始しました' : '次の話題に追加しました'}。`);
            if (r.status) update(r.status);
        } catch (e) { notice(e.message); }
    };
}
$('pause-comments').onclick = () => control('pause-comments');
$('voice-ai').onclick = () => control('voice', { to: 'ai' });
$('voice-human').onclick = () => control('voice', { to: 'human' });
$('voice-none').onclick = () => control('voice', { to: 'none' });
$('listening-mode').onchange = () => control('listening', { to: $('listening-mode').value });
// The capture page inherits this tab's admin session (sessionStorage is copied to a same-origin window.open).
$('collab-open').onclick = () => { window.open('/collab', 'noa-collab'); };
$('lcp-open').onclick = () => { window.open('/control', 'noa-control'); };
// Hotkeys while this page has focus (not while typing): the operator's map (/api/hotkeys, defaults F6-F10), resolved by
// the server on the current state. Keys from any app: scripts/global-hotkeys.mjs (docs/CONTROL.md).
let hotkeyMap = { ...DEFAULT_HOTKEYS };
api('/api/hotkeys').then(r => { if (r?.map) hotkeyMap = r.map; }).catch(() => { });
document.addEventListener('keydown', e => {
    if (e.repeat || e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const name = hotkeyMap[keyName(e)];
    if (!name) return;
    e.preventDefault();
    void control('hotkey', { name });
});
$('panic').onclick = () => control('panic');
$('chat-form').addEventListener('submit', async (e) => { e.preventDefault(); try {
    const result = await api('/api/chat', { text: $('chat-input').value });
    $('chat-result').textContent = result.accepted ? '受け付けました。採用は判定後に決まります。' : `今回は保留しました：${result.reason}`;
    if (result.accepted)
        $('chat-input').value = '';
}
catch (e) {
    $('chat-result').textContent = e.message;
} });
for (const button of document.querySelectorAll('[data-demo]'))
    button.onclick = () => { $('chat-input').value = button.dataset.demo; $('chat-input').focus(); };
$('obs-prepare').onclick = async () => { try {
    notice('OBSに接続しています。');
    const r = await api('/api/obs/prepare', {});
    notice(`OBSに「${r.scene}」を用意しました。プレビュー音声を無効にし、OBS側で音声を確認してください。`);
    $('obs-state').textContent = 'シーンの準備ができました。'; refreshSession();
}
catch (e) {
    notice(e.message);
} };
for (const b of document.querySelectorAll('[data-screen]')) b.onclick = async () => {
    try { const r = await api('/api/obs/screen', { screen: b.dataset.screen }); notice(`OBSの画面を「${r.scene}」にしました。`); } catch (e) { notice(e.message); }
};
$('obs-start').onclick = async () => { try {
    await checkDestination();
    if (!confirm(`${targetName(session.streamTarget)}へ映像と音声を送信します。開始しますか？`)) return;
    await api('/api/obs/start', { confirm: 'START', target: session.streamTarget });
    notice('OBSの配信開始要求が成功しました。配信先でも受信状態を確認してください。');
    $('obs-state').textContent = 'OBSへ配信開始要求済み'; refreshSession();
}
catch (e) {
    notice(e.message);
} };
$('obs-stop').onclick = async () => { try {
    await api('/api/obs/stop', {});
    notice('このアプリが開始したOBS配信の停止を確認しました。'); refreshSession();
}
catch (e) {
    notice(e.message);
} };
$('vts-connect').onclick = async () => { try {
    await api('/api/vts/connect', {});
    notice('VTube Studioを接続しました。MouthOpenをモデルの口パクに割り当ててください。');
}
catch (e) {
    notice(e.message);
} };
void connect();

$('programme-report').onclick = async () => { try { const data = await api('/api/programme/report'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = `programme-${data.programme}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('ローカル再生完了基準の進行記録です。視聴者維持率やYouTube到達時刻ではありません。'); } catch(e) { notice(e.message); } };

// Operator monitor: everything the viewer screen deliberately no longer shows.
let monitorTimer = null;
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const pairs = (id, rows) => $(id).replaceChildren(...rows.flatMap(([k, v]) => [el('dt', k), el('dd', v ?? '—')]));
const clock = ms => [3600000, 60000, 1000].map((d, i) => String(Math.floor(ms / d) % (i ? 60 : 100)).padStart(2, '0')).join(':');
const ms = x => x ? `${x.last ?? '—'} / ${x.p50} ms` : '—';
const queueLabels = { answering: '★ 返答中', prepared: '★ 準備済み', preparing: '★ 生成中', reserved: '採用', selected: '採用待ち', published: '★ 返答中', playing: '★ 返答中', judging: '判定中', research: '調査待ち', unavailable: '採用待ち' };
const eventLabels = { comment: 'COMMENT', comment_drop: 'COMMENT ✕', jev_chat: '判定 → chat', jev_speech: '判定 → gate', output_judge: '判定 speech', llm: 'LLM', tts: 'TTS', comment_tts: 'TTS narrator', publish: 'publish', voice_tier: 'VOICE tier', voice_circuit: 'VOICE ✕', voice_warmup: 'VOICE warm', speech_start: 'speech ▶', speech_end: 'speech ■', cancel: 'cancel', start: 'START', stop: 'STOP' };
const count = o => o && typeof o === 'object' ? Object.values(o).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
/** Operator-only: the host voice engine, circuit and library. Never shown on the stage. */
function voiceRows(v) {
    if (!v) return [['voice', '—']];
    const e = v.main || {}, lib = v.library;
    return [['engine', `${e.label || e.id || '—'} · ${e.state || '—'}`], ['circuit', e.state === 'open' ? `open · ${Math.ceil((e.openForMs || 0) / 1000)} s` : e.state === 'half_open' ? 'half-open' : 'closed'],
        ['premium', v.premium?.state || 'disabled'], ['direction', v.direction || 'off'], ['pass-through', v.passThrough ? 'yes' : 'no'],
        ['phrases', `hit ${v.phrase?.hits ?? 0} / miss ${v.phrase?.misses ?? 0}`], ['clips', `used ${v.clips?.used ?? 0} / dropped ${v.clips?.dropped ?? 0}`],
        ['last error', typeof e.lastError === 'string' ? e.lastError : e.lastError?.code || '—'], ['library', lib ? `${lib.hash8 || '—'} · clips ${count(lib.clips)} · phrases ${count(lib.phrases)}` : '—'],
        ...(e.cost ? [['cloud cost', `約 $${e.cost.usd} · ${e.cost.audioSec} s · ${e.cost.requests} req（推定）`]] : [])];
}
function deliveryRows(d) {
    if (!d) return [['delivery', '—']];
    const chunks = Array.isArray(d.chunks) && d.chunks.length ? d.chunks.map(c => `${c.chars}:${c.reaction}/${c.pace}/${c.ending}`).join(' | ') : '—';
    return [['acting', `${d.reaction || '—'} · ${d.intensity || '—'} · ${d.source || '—'}`], ['chunks', chunks], ['engine', d.engine],
        ['tiers', `cache ${d.tiers?.cache ?? 0} / local ${d.tiers?.local ?? 0}`], ['clip', d.clip || '—'], ['leadMs', Number.isFinite(d.leadMs) ? `${d.leadMs} ms` : '—']];
}
function renderMonitor(m) {
    // The voice call (operator only): is the partner speaking, the last turns, and the local speech-to-text.
    const call = m.collab;
    $('collab-status').textContent = !call ? '通話：この番組では使えません' : `通話：${call.speaking ? '相手が話しています' : '待機'} · 音声認識 ${call.stt?.error ? `エラー（${call.stt.error}）` : call.stt?.ms ? `${call.stt.ms} ms` : '未使用'}`;
    $('collab-dialogue').replaceChildren(...(call?.dialogue || []).map(t => { const li = document.createElement('li'); li.textContent = `${t.who === 'noa' ? 'ノア' : '相手'}：${t.text}`; return li; }));
    renderAvatarMode();
    renderSponsor();
    $('renderer').textContent = [avatarDisplayLabel(), m.avatar?.renderer ? '音声接続済み' : '音声待ち'].join(' / ');
    const live = m.live;
    $('live-dot').className = `live-dot${live.running ? ' on' : ''}${live.panic ? ' panic' : ''}`;
    $('live-label').textContent = live.panic ? 'EMERGENCY' : live.running ? 'RUNNING' : 'STANDBY';
    $('live-clock').textContent = clock(live.elapsedMs);
    const AFFECT_META = {
        frustration: { label: 'イライラ', color: '#ef4444' },
        tilt: { label: '温まり(Tilt)', color: '#f97316' },
        blush: { label: '赤面', color: '#ec4899' },
        joy: { label: '喜び', color: '#eab308' },
        confidence: { label: '自信', color: '#10b981' },
        embarrassment: { label: '照れ/恥', color: '#d946ef' },
        excitement: { label: 'ワクワク', color: '#06b6d4' },
        arousal: { label: '興奮', color: '#3b82f6' },
        happy: { label: '機嫌', color: '#84cc16' },
        energy: { label: '活力', color: '#f59e0b' },
        focus: { label: '集中', color: '#6366f1' },
    };
    $('affect').replaceChildren(...Object.entries(m.affect).map(([k, v]) => {
        if (typeof v !== 'number') return null;
        const meta = AFFECT_META[k] || { label: k, color: '#94a3b8' };
        const row = el('div', undefined, 'meter'), bar = el('i'), fill = el('b');
        const pct = Math.max(0, Math.min(100, Math.round(v * 100)));
        fill.style.width = `${pct}%`;
        fill.style.background = meta.color;
        bar.append(fill);
        row.append(el('small', meta.label), bar, el('span', v.toFixed(2)));
        return row;
    }).filter(Boolean));
    $('speaking').textContent = m.speaking ? `${m.speaking.role === 'comment' ? '読み上げ' : '発話'}${m.speaking.started ? '中' : '準備'}: ${m.speaking.text}` : '発話なし';
    const r = m.reaction;
    pairs('reaction', r ? [['preset', `${r.name} (${r.label})`], ['role', r.role === 'comment' ? 'narrator → listen' : 'host'], ['camera', r.camera], ['sfx', r.sfx], ['reflex lead', `${r.lead} ms`], ['at', `${Math.max(0, Math.round((Date.now() - r.at) / 1000))} 秒前`]] : [['preset', 'idle']]);
    const q = m.queue.length ? m.queue.map(x => { const li = el('li', undefined, x.picked ? 'picked' : ''); li.append(el('em', queueLabels[x.state] || x.state), el('span', x.text), el('small', `${Math.round(x.ageMs / 1000)}s`)); return li; }) : [el('li', 'コメント待ち', 'empty-line')];
    $('comment-queue').replaceChildren(...q);
    const p = m.performance;
    pairs('performance', [['判定 chat', p.jevChatMs !== null ? `${p.jevChatMs} ms` : '—'], ['判定 gate', ms(p.jevSpeech)], ['LLM', ms(p.llm)], ['TTS', ms(p.tts)], ...(p.ttsFirstChunk ? [['TTS 先頭音声', ms(p.ttsFirstChunk)], ['TTS 生成完了', ms(p.ttsStreamTotal)]] : []), ['TTS narrator', ms(p.commentTts)], ['comment→read', ms(p.commentToRead)], ['comment→answer', ms(p.commentToAnswer)],
        ['TTFA', ms(p.ttfa)], ['publish→start', ms(p.publishToStart)], ['dead air', ms(p.deadAir)], ['mid gap', ms(p.midGap)], ['hold', ms(p.hold)], ['RTF‰', ms(p.rtf)]]);
    pairs('voice', voiceRows(m.voice));
    pairs('delivery', deliveryRows(m.delivery));
    const g = m.game;
    pairs('game-brain', g ? [['controller', g.controller], ['state', g.paused ? 'PAUSE（コメント対応）' : 'PLAY'], ['last → next', `${g.lastMove?.move || '—'} → ${g.paused ? 'wait' : g.nextMove || '(Jev)'}`], ['distance', String(g.distance)], ['score', String(g.score)], ['situation', g.summary]] : [['game', 'なし（雑談のみ）']]);
    const pr = m.programme, a = m.avatar;
    pairs('programme', [...(pr ? [['programme', pr.title], ['progress', pr.progress ? `第${pr.progress.round}/${pr.progress.rounds}幕 · ${pr.progress.step}/${pr.progress.steps} ${pr.progress.label}` : '—'], ['focus', pr.progress?.focus], ['comments', pr.commentsPaused ? '受付停止中' : '受付中']] : []),
        ['renderer', a.renderer ? '音声出力 接続済み' : '未接続'], ['Live2D (VTS)', a.vtsEnabled ? (a.vtsReady ? '接続済み · パラメータ送信中' : '未接続') : '無効']]);
    $('events').replaceChildren(...(m.events.length ? m.events.map(e => { const row = el('div'); row.append(el('time', new Date(e.at).toLocaleTimeString('ja-JP', { hour12: false })), el('b', eventLabels[e.kind] || e.kind), el('span', e.detail)); return row; }) : [el('div', '自動運転を始めると判断の流れがここに出ます。', 'empty-line')]));
}
function startMonitor() {
    clearInterval(monitorTimer);
    const poll = () => { if (document.visibilityState !== 'hidden') api('/api/monitor').then(renderMonitor).catch(() => { }); };
    poll(); monitorTimer = setInterval(poll, 1000);
}
$('say-form').onsubmit = async event => { event.preventDefault(); try {
    const r = await api('/api/operator/say', { text: $('say-input').value });
    if (!r.accepted) { $('say-result').textContent = ({ not_running: '番組の開始後に使えます', closing: '締めの挨拶の準備中です', invalid_text: '1〜120文字・改行なしで入力してください', too_many_sentences: '1回に話せるのは2文までです（「。」「！」「？」で区切った数）', queue_full: '順番待ちが3件あります' })[r.reason] || r.reason; return; }
    $('say-input').value = '';
} catch (e) { $('say-result').textContent = e.message; } };

$('goal-form').onsubmit = async event => { event.preventDefault(); try {
    const r = await api('/api/operator/goal', { text: $('goal-input').value });
    $('goal-result').textContent = `変更しました：${r.goal}`;
} catch (e) { $('goal-result').textContent = e.message; } };
api('/api/session').then(s => { if (!$('goal-input').value) $('goal-input').value = s?.status?.gameShow?.goal || ''; }).catch(() => { });

const DEFAULT_QUICK_PHRASES = [
    '見に来てくれてありがとう！',
    'チャンネル登録・高評価よろしくね！',
    'ちょっとお水飲むね〜',
    'ナイス！いい調子！',
    'みんなは何してる？',
    'ゆっくりしていってね！'
];
function loadQuickPhrases() {
    try {
        const stored = localStorage.getItem('jvs-quick-phrases');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        }
    } catch { }
    return [...DEFAULT_QUICK_PHRASES];
}
function saveQuickPhrases(list) {
    try { localStorage.setItem('jvs-quick-phrases', JSON.stringify(list)); } catch { }
}
function renderQuickPhrases() {
    const container = $('quick-phrase-chips');
    if (!container) return;
    const phrases = loadQuickPhrases();
    container.replaceChildren();
    for (let i = 0; i < phrases.length; i++) {
        const p = phrases[i];
        const chip = document.createElement('div');
        chip.style.cssText = 'display:inline-flex; align-items:center; background:rgba(255,255,255,0.08); border-radius:12px; padding:2px 8px; font-size:11px; margin:2px 0; gap:4px;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = p;
        btn.style.cssText = 'background:none; border:none; color:inherit; font:inherit; cursor:pointer; padding:0;';
        btn.onclick = () => {
            $('say-input').value = p;
            $('say-input').focus();
        };
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.title = '削除';
        del.style.cssText = 'background:none; border:none; color:#94a3b8; font-size:10px; cursor:pointer; padding:0 2px; line-height:1;';
        del.onclick = (e) => {
            e.stopPropagation();
            phrases.splice(i, 1);
            saveQuickPhrases(phrases);
            renderQuickPhrases();
        };
        chip.append(btn, del);
        container.append(chip);
    }
}
if ($('add-phrase-btn')) {
    $('add-phrase-btn').onclick = () => {
        const text = prompt('ノアに言わせるセリフを追加（120文字以内）:');
        if (!text || !text.trim()) return;
        const cleanText = text.trim().slice(0, 120);
        const list = loadQuickPhrases();
        if (!list.includes(cleanText)) {
            list.push(cleanText);
            saveQuickPhrases(list);
            renderQuickPhrases();
        }
    };
}
renderQuickPhrases();

// Go live in one flow: automatic trial → final check (the voice is played only when this configuration was never heard)
// → start the show (the game starts with it) → once the voice reaches OBS and the game plays, start the OBS stream.
let liveTrial = null;
const trialAudioURLs = new Map();
const trialAudioLinks = new Map();
let trialAudioEpoch = 0;
function clearTrialAudio() {
    trialAudioEpoch++;
    for (const [el, next] of trialAudioLinks) el.removeEventListener('ended', next);
    trialAudioLinks.clear();
    for (const [el, url] of trialAudioURLs) {
        el.onended = null;
        el.pause(); el.removeAttribute('src'); el.load();
        URL.revokeObjectURL(url);
    }
    trialAudioURLs.clear();
}
function linkTrialAudio(el, following) {
    const previous = trialAudioLinks.get(el);
    if (previous) el.removeEventListener('ended', previous);
    const next = () => { trialAudioLinks.delete(el); following.play().catch(() => {}); };
    trialAudioLinks.set(el, next);
    el.addEventListener('ended', next, { once: true });
}
const audioBlob = async (path, el) => {
    const epoch = trialAudioEpoch;
    const r = await fetch(path, { headers: { Authorization: `Bearer ${admin}` } });
    if (!r.ok) throw new Error('試聴音声が失効しました');
    const blob = await r.blob();
    if (epoch !== trialAudioEpoch) return false;
    const previous = trialAudioURLs.get(el), url = URL.createObjectURL(blob);
    try { el.src = url; } catch (error) { URL.revokeObjectURL(url); throw error; }
    trialAudioURLs.set(el, url);
    // Keep the current take available through playback/replay, until replacement or dialog close.
    if (previous) URL.revokeObjectURL(previous);
    el.hidden = false;
    return true;
};
$('live-dialog').addEventListener('close', clearTrialAudio);
addEventListener('pagehide', event => { if (!event.persisted) clearTrialAudio(); });
$('go-live').onclick = async () => {
    if (session?.status?.running) { if (confirm('締めの挨拶をしてから終了します。このアプリが開始したOBS配信も止まります。よろしいですか？')) await control('finish'); return; }
    try { await refreshSession(); await checkDestination(); } catch (e) { notice(e.message); return; }
    const d = $('live-dialog'); liveTrial = null; clearTrialAudio();
    const trialEpoch = trialAudioEpoch;
    $('live-go').disabled = true; $('live-heard').checked = false; $('live-heard').disabled = true; $('live-listen').hidden = true; $('live-progress').textContent = '';
    $('live-checks').replaceChildren(Object.assign(document.createElement('li'), { textContent: '自動検証を実行しています（文章生成 → ローカル判定 → 声 → コメント読み上げ）…' }));
    const g = session?.gameRunner;
    $('live-summary').replaceChildren(...[['配信先', targetName(session?.streamTarget)], ['番組', session?.status?.topic?.title || '—'], ['長さ', g?.limits ? `${g.limits.minutes}分（終了時に配信も自動停止）` : '—'],
        ['ゲーム', g?.enabled ? `AIが自動でプレイ・上限 約$${g.limits.maxCostUsd}` : 'なし'], ['マイク', 'ミュート（OBSのシーン作成時）']].flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]));
    d.showModal();
    try {
        const r = await api('/api/setup/rehearse', { confirm: 'RUN_CHECK' });
        if (trialEpoch !== trialAudioEpoch) return;
        liveTrial = r;
        $('live-checks').replaceChildren(...r.checks.map(x => Object.assign(document.createElement('li'), { className: x.ok ? '' : 'ng', textContent: `${x.ok ? '✓' : '×'} ${x.name}${x.ok ? '' : `：${x.error}`}` })));
        if (!r.ok) { $('live-progress').textContent = '自動検証に失敗したため開始できません。'; return; }
        session = { ...session, ...(await api('/api/session')) };
        if (trialEpoch !== trialAudioEpoch) return;
        if (session.rehearsalApproved) { $('live-go').disabled = false; $('live-progress').textContent = 'この設定の声は確認済みです。'; return; }
        $('live-listen').hidden = false;
        const players = [[r.audio, $('live-audio')], [r.commentAudio, $('live-comment-audio')], [r.libraryAudio, $('live-library-audio')]].filter(([p]) => p);
        for (const [p, el] of players) if (!await audioBlob(p, el)) return;
        let left = players.length;
        for (const [, el] of players) el.onended = () => { if (--left <= 0) $('live-heard').disabled = false; };
        players.reduce((prev, [, el]) => { if (prev) linkTrialAudio(prev, el); return el; }, null);
        players[0]?.[1].play().catch(() => { $('live-progress').textContent = '▶ を押して声を再生してください。'; });
    } catch (e) { $('live-progress').textContent = e.message; }
};
$('live-heard').onchange = () => { $('live-go').disabled = !$('live-heard').checked; };
$('live-cancel').onclick = () => { for (const id of ['live-audio', 'live-comment-audio', 'live-library-audio']) $(id).pause(); $('live-dialog').close(); };
// ---- YouTube: reserve a broadcast (予約枠) and check, before going live, that its comments can be read.
function renderYouTube() {
    const b = session?.youtubeBroadcast; if (!b) return;
    $('yt-current').textContent = !b.readComments ? 'コメント読み上げオフ' : b.videoId ? `読む枠：${b.videoId}` : '読む枠が未設定';
    if (!$('yt-schedule-state').dataset.busy) $('yt-schedule-state').textContent = b.scheduleAuthorized ? '' : '予約枠を作るには、一度 npm run youtube:auth -- --schedule で YouTube の管理を許可してください。';
    const running = !!session.status?.running || !!session.obsOwned;
    $('yt-schedule').disabled = running; $('yt-schedule').title = running ? '配信中は予約枠を作れません' : '';
}
function nextHourLocal() {
    const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
if (!$('yt-start').value) $('yt-start').value = nextHourLocal();
$('yt-schedule-form').addEventListener('submit', async event => {
    event.preventDefault();
    const state = $('yt-schedule-state'); state.dataset.busy = '1'; $('yt-schedule').disabled = true;
    const privacy = $('yt-privacy').value, start = new Date($('yt-start').value);
    try {
        if (!Number.isFinite(start.getTime())) throw new Error('開始日時を入力してください。');
        state.textContent = 'YouTube に予約枠を作っています…';
        const r = await api('/api/youtube/schedule', { title: $('yt-title').value, description: $('yt-description').value, start: start.toISOString(), privacy, useForChat: $('yt-use-for-chat').checked });
        state.replaceChildren(document.createTextNode(`予約枠を作りました（${start.toLocaleString('ja-JP')}・${$('yt-privacy').selectedOptions[0].textContent}${r.streamTitle ? `・配信キー ${r.streamTitle}` : ''}）。 `),
            Object.assign(document.createElement('a'), { href: r.url, target: '_blank', rel: 'noopener', textContent: '枠を開く ↗' }));
    } catch (e) { state.textContent = e.message; }
    finally { delete state.dataset.busy; $('yt-schedule').disabled = false; refreshSession(); }
});
/** Show a chat check: the verdict, what to do, and every step it took (the log the operator asked for). */
function showChatCheck(r, list = $('yt-chat-log'), line = $('yt-chat-state')) {
    line.textContent = r.ok ? `✓ ${r.message}` : `× ${r.message}${r.hint ? ` ${r.hint}` : ''}`;
    list.replaceChildren(...(r.log || []).map(x => Object.assign(document.createElement('li'), { className: x.ok ? '' : 'ng', textContent: `${new Date(x.at).toLocaleTimeString('ja-JP')} ${x.ok ? '✓' : '×'} ${x.step}：${x.detail}` })));
}
async function checkYouTubeChat() { return api('/api/youtube/chat-check', {}); }
$('yt-chat-check').onclick = async () => {
    $('yt-chat-check').disabled = true; $('yt-chat-state').textContent = '確認しています…';
    try { showChatCheck(await checkYouTubeChat()); } catch (e) { $('yt-chat-state').textContent = e.message; }
    finally { $('yt-chat-check').disabled = false; }
};
/** Before going live: true = go on (comments readable, or the operator saw the log and chose to stream without them). */
async function confirmYouTubeChat(say) {
    say('YouTube のコメントを読み込めるか確認しています…');
    const r = await checkYouTubeChat();
    if (r.ok) return { ok: true, allow: false };
    const log = (r.log || []).map(x => `${x.ok ? '✓' : '×'} ${x.step}：${x.detail}`).join('\n');
    $('live-checks').replaceChildren(...(r.log || []).map(x => Object.assign(document.createElement('li'), { className: x.ok ? '' : 'ng', textContent: `${x.ok ? '✓' : '×'} ${x.step}：${x.detail}` })));
    showChatCheck(r);
    const go = confirm(`YouTube のコメントを読み込めません。\n\n${r.message}${r.hint ? `\n${r.hint}` : ''}\n\n確認ログ:\n${log}\n\nコメントを読まないまま、このまま配信しますか？`);
    return { ok: go, allow: go };
}
$('live-go').onclick = async () => {
    const say = t => { $('live-progress').textContent = t; };
    $('live-go').disabled = true; $('live-cancel').disabled = true;
    try {
        if (!session.rehearsalApproved) await api('/api/setup/heard', { id: liveTrial.id, heard: true, commentHeard: true, libraryHeard: true });
        const chat = await confirmYouTubeChat(say);
        if (!chat.ok) { say('配信を始めませんでした。YouTube のコメント設定を直してから、もう一度「配信を始める」を押してください。'); return; }
        const r = await goLive({ api, say, allowUnavailableYouTubeChat: chat.allow, hostName, streamTarget: () => session.streamTarget,
            onSession: x => { session = x; gameRunner = x.gameRunner; } });
        if (!r.ok) { refreshSession(); return; }
        say(`${targetName(session.streamTarget)}への配信を開始しました。チャンネルでも映像・音声を確認してください。`); refreshSession();
        setTimeout(() => $('live-dialog').close(), 3000);
    } catch (e) { say(e.message); }
    finally { $('live-cancel').disabled = false; }
};
for (const b of document.querySelectorAll('#game-report [data-game-event]')) b.onclick = async () => {
    reporting = true; liveSteps();
    try { await api('/api/control', { action: 'game-report', event: b.dataset.gameEvent }); } catch (e) { notice(e.message); }
    finally { reporting = false; liveSteps(); }
};
$('start-game').onclick = async () => { if (!confirm(`雑談を終えて、ゲームを始めますか？（${hostName}がゲームを発表し、画面がゲームに切り替わります）`)) return;
    try { await api('/api/control', { action: 'start-game' }); notice(`ゲームを始めます。${hostName}が発表したあと、ゲームが自動で起動します。`); } catch (e) { notice(e.message); } };
$('switch-game-player').onclick = async () => {
    const g = gameRunner || session?.gameRunner;
    const target = g?.player === 'human' ? 'ai' : 'human';
    const label = target === 'human' ? 'ユーザー操作（あなたがプレイ）' : 'AI操作（ノアがプレイ）';
    try {
        notice(`${label}に切り替えています…`);
        $('switch-game-player').disabled = true;
        const res = await api('/api/game/player', { player: target });
        gameRunner = res.gameRunner || gameRunner;
        if (gameRunner) gameRunner.player = res.player;
        notice(res.result?.warning ? `${label}に切り替えました（${res.result.warning}）。` : `${label}に切り替えました。`);
    } catch (e) {
        notice(`切り替えに失敗しました: ${e.message}`);
    } finally {
        if ($('switch-game-player')) $('switch-game-player').disabled = false;
        liveSteps();
    }
};
$('toggle-game-runner').onclick = async () => {
    const g = gameRunner || session?.gameRunner;
    const isGameRunning = ['starting', 'playing', 'restarting'].includes(g?.state);
    try {
        $('toggle-game-runner').disabled = true;
        if (isGameRunning) {
            notice('ゲームを停止しています…');
            const res = await api('/api/game/runner', { action: 'stop' });
            gameRunner = res.gameRunner || gameRunner;
            notice('ゲームを停止しました。');
        } else {
            notice('ゲームを単体起動しています（配信なし）…');
            const res = await api('/api/game/runner', { action: 'start' });
            gameRunner = res.gameRunner || gameRunner;
            notice('ゲームを起動しました。AIによる自立プレイが始まります。');
        }
    } catch (e) {
        notice(`ゲーム操作に失敗しました: ${e.message}`);
    } finally {
        if ($('toggle-game-runner')) $('toggle-game-runner').disabled = false;
        liveSteps();
    }
};
