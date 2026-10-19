const $ = id => document.getElementById(id), form = $('config-form');
let suggestedPersona = '';
const hash = new URLSearchParams(location.hash.slice(1));
let admin = hash.get('admin') || sessionStorage.getItem('jvs-admin') || '', trial = null, audioURL = null, commentAudioURL = null, libraryAudioURL = null, heardReply = false, heardComment = false, heardLibrary = false;
if (hash.has('admin')) { sessionStorage.setItem('jvs-admin', admin); history.replaceState(null, '', location.pathname); }
async function api(path, data) {
    const r = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${admin}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const x = await r.json(); if (!r.ok) throw Object.assign(new Error((x.error || '操作を確認してください') + (x.detail ? `（原因: ${x.detail}）` : '')), { field: x.field, detail: x.detail, problems: x.problems }); return x;
}
function notice(text, bad = false) { $('save-status').textContent = text; $('save-status').classList.toggle('failed', bad); }
function values() { return Object.fromEntries([...form.elements].filter(x => x.name).map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])); }
function resetTrialAudio() {
    trial = null; heardReply = false; heardComment = false; heardLibrary = false; $('heard').disabled = true;
    for (const id of ['trial-audio', 'comment-trial-audio', 'library-trial-audio']) { const el = $(id); el.pause(); el.removeAttribute('src'); el.load(); el.hidden = true; }
    if (audioURL) URL.revokeObjectURL(audioURL);
    if (commentAudioURL) URL.revokeObjectURL(commentAudioURL);
    if (libraryAudioURL) URL.revokeObjectURL(libraryAudioURL);
    audioURL = null; commentAudioURL = null; libraryAudioURL = null; $('library-index').replaceChildren();
}
function viewVoice() { const v = $('reply-tts').value; $('supertonic-fields').hidden = v !== 'supertonic'; $('aivis-fields').hidden = v !== 'aivisspeech'; $('sbv2-fields').hidden = v !== 'sbv2'; $('gemini-fields').hidden = !v.startsWith('gemini'); }
function viewLibrary(status) {
    if (!status) { $('library-summary').textContent = ''; return; }
    const clips = Object.entries(status.clips || {}).map(([cls, n]) => `${cls} ×${n}`).join('、') || 'なし';
    const phrases = Object.values(status.phrases || {}).reduce((a, b) => a + b, 0);
    const errors = (status.errors || []).map(e => `${e.file}: ${e.reason}`);
    $('library-summary').textContent = `反応音: ${clips} / 定型フレーズ: ${phrases} 件` + (errors.length ? `\n読み込めなかったファイル:\n${errors.join('\n')}` : '');
}
$('reply-tts').onchange = viewVoice;
function viewProvider() { $('gemini-fields').hidden = $('llm-provider').value !== 'gemini'; $('generic-fields').hidden = ! $('gemini-fields').hidden; }
let programmes = [], characterName = 'ノア';
/** The game card follows the chosen programme: what is played, who plays, how OBS gets the picture (docs/GAMES.md). */
function viewGame() {
    const g = programmes.find(x => x.id === $('show-programme').value)?.game || null;
    $('game-fields').hidden = !g;
    if (!g) { $('game-summary').textContent = 'ゲームのない企画です。ゲーム企画を選ぶと、ここにそのゲームの取り込み方と設定が出ます。'; return; }
    const who = g.player === 'operator' ? `配信者が操作し、${characterName}が実況` : `AI（Jev）が操作し、${characterName}が実況`;
    const how = g.capture === 'switch' ? 'Switchのキャプチャー機器（Switch接続で設定）' : 'このMacのゲームウィンドウ';
    $('game-summary').textContent = `この企画のゲーム：${g.title}。${who}。映像の取り込み：${how}。`;
    $('game-switch-fields').hidden = g.capture !== 'switch';
    $('game-controller-fields').hidden = g.player !== 'jev';
}
$('show-programme').onchange = viewGame;
function fill(data) {
    suggestedPersona = data.suggestedPersona || ""; characterName = data.values?.CHARACTER_NAME || characterName; $('character-name-now').textContent = characterName;
    if (data.programmes) { programmes = data.programmes; $('show-programme').replaceChildren(...data.programmes.map(x => new Option(`${x.title}（${x.game ? x.game.title : x.style === 'blocks' ? 'ブロックゲーム' : x.style === 'consult' ? '相談＋内蔵ゲーム' : 'トークのみ'}）`, x.id))); }
    for (const [k, v] of Object.entries(data.values)) { const e = form.elements.namedItem(k); if (!e) continue; if (e.type === 'checkbox') e.checked = v === true || v === 'true'; else e.value = v ?? ''; }
    for (const [k, present] of Object.entries(data.configured)) { const e = form.elements.namedItem(k); if (e) { e.value = ''; e.placeholder = present ? '保存済み（空欄で維持）' : '未設定'; } }
    viewProvider(); viewVoice(); viewGame();
    if (data.library) viewLibrary(data.library);
}
// ---- Readiness: one request, one list; the links lead to the card that fixes a step.
$('readiness-check').onclick = async () => {
    const b = $('readiness-check'); b.disabled = true; $('readiness-summary').textContent = '確認しています…'; $('readiness-steps').replaceChildren();
    try {
        const r = await api('/api/readiness');
        $('readiness-steps').replaceChildren(...r.steps.map(s => { const li = document.createElement('li'); li.className = s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'na';
            const mark = document.createElement('i'); mark.textContent = s.ok === true ? '✓' : s.ok === false ? '✗' : '－'; const body = document.createElement('div'); const name = document.createElement('b'); name.textContent = s.label;
            const link = document.createElement('a'); link.href = s.link; link.textContent = '開く'; const note = document.createElement('small'); note.textContent = s.note || ''; body.append(name, link, note); li.append(mark, body); return li; }));
        $('jev-hold-clear').hidden = !r.steps.some(s => s.id === 'jevBilling' && s.ok === false);
        const bad = r.steps.filter(s => s.ok === false).length;
        $('readiness-summary').textContent = r.ready ? `自動で確認できる項目はすべて通りました（${r.mode === 'demo' ? 'DEMO' : '実API'}）。残りは録画を人が確認してください。` : `未完了 ${bad} 件。✗ の項目から直してください。`;
    } catch (e) { $('readiness-summary').textContent = e.message; }
    finally { b.disabled = false; }
};
$('jev-hold-clear').onclick = async () => {
    if (!confirm('TypeSafe（Jev）の残高・支払いを確認しましたか？解除すると Jev への送信を再開します。')) return;
    try { await api('/api/setup/jev-hold', { action: 'clear' }); $('jev-hold-clear').hidden = true; $('readiness-summary').textContent = '課金停止を解除しました。もう一度「いま確認する」を押してください。'; }
    catch (e) { $('readiness-summary').textContent = e.message; }
};
// ---- Programme editor: the words of a programme, validated like the built-ins, saved under data/programmes/.
let editorProgrammes = [];
function renderEditor() {
    const p = editorProgrammes.find(x => x.id === $('edit-programme').value); $('editor-fields').hidden = !p; if (!p) return;
    $('ep-title').value = p.title; $('ep-question').value = p.question; $('ep-hook').value = p.hook; $('ep-opening').value = p.openingLine; $('ep-closing').value = p.closingLine;
    $('ep-problems').replaceChildren(); $('ep-status').textContent = p.custom ? 'この企画は編集済みの内容が使われています。' : '組み込みの内容です。';
    $('ep-cards').replaceChildren(...p.cards.map(c => { const card = document.createElement('div'); card.className = 'ep-card'; card.dataset.cardId = c.id; const h = document.createElement('h3'); h.textContent = c.title; card.append(h);
        for (const b of c.beats) { const row = document.createElement('div'); row.className = 'ep-beat'; row.dataset.beatId = b.id;
            const field = (key, label, value, wide = false, rows = 0) => { const l = document.createElement('label'); if (wide) l.className = 'wide'; l.textContent = label; const el = document.createElement(rows ? 'textarea' : 'input'); if (rows) el.rows = rows; el.value = value; el.dataset.key = key; l.append(el); return l; };
            row.append(field('label', 'ラベル', b.label), field('display', '画面表示', b.display), field('task', '課題（モデルへの指示）', b.task, true, 2), field('demo', '見本の台詞（2文まで）', b.demo, true, 2));
            if (b.lobby || b.game) { const f = document.createElement('div'); f.className = 'flags'; f.textContent = b.lobby ? '雑談（ゲーム前）の段階' : 'ゲーム実況の段階'; row.append(f); }
            card.append(row); }
        return card; }));
}
function editorPayload() {
    return { id: $('edit-programme').value, title: $('ep-title').value, question: $('ep-question').value, hook: $('ep-hook').value, openingLine: $('ep-opening').value, closingLine: $('ep-closing').value,
        cards: [...$('ep-cards').querySelectorAll('.ep-card')].map(card => ({ id: card.dataset.cardId, beats: [...card.querySelectorAll('.ep-beat')].map(row => ({ id: row.dataset.beatId, ...Object.fromEntries([...row.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.value])) })) })) };
}
async function loadEditor() {
    try { const r = await api('/api/programmes'); editorProgrammes = r.programmes; const sel = $('edit-programme'), keep = sel.value || r.current;
        sel.replaceChildren(...r.programmes.map(p => new Option(`${p.title}${p.custom ? '（編集済み）' : ''}`, p.id))); sel.value = r.programmes.some(p => p.id === keep) ? keep : r.programmes[0]?.id; renderEditor();
        if (r.warnings?.length) $('ep-status').textContent = `読み込めなかった編集: ${r.warnings.join(' / ')}`; }
    catch (e) { $('ep-status').textContent = e.message; }
}
$('edit-programme').onchange = renderEditor;
$('ep-save').onclick = async () => {
    $('ep-problems').replaceChildren(); $('ep-status').textContent = '検証しています…';
    try { const r = await api('/api/programmes', { action: 'save', programme: editorPayload() }); $('ep-status').textContent = '検証を通り、保存しました。次の番組開始から使われます。'; await loadEditor(); fill(await api('/api/settings')); void r; }
    catch (e) { $('ep-status').textContent = e.message; $('ep-problems').replaceChildren(...(e.problems || []).map(t => { const li = document.createElement('li'); li.textContent = t; return li; })); }
};
$('ep-reset').onclick = async () => {
    if (!confirm('この企画の編集を捨てて、組み込みの内容に戻しますか？')) return;
    try { await api('/api/programmes', { action: 'reset', id: $('edit-programme').value }); $('ep-status').textContent = '組み込みの内容に戻しました。'; await loadEditor(); fill(await api('/api/settings')); }
    catch (e) { $('ep-status').textContent = e.message; }
};
async function connect() {
    try { const data = await api('/api/settings'); fill(data); $('settings').hidden = false; $('locked').hidden = true; void loadEditor(); }
    catch { $('settings').hidden = true; $('locked').hidden = false; }
}
$('unlock').onsubmit = e => { e.preventDefault(); admin = $('admin-key').value.trim(); sessionStorage.setItem('jvs-admin', admin); void connect(); };
function clearFieldErrors() {
    for (const el of form.querySelectorAll('[aria-invalid="true"]')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
    form.querySelectorAll('.field-error').forEach(el => el.remove());
}
form.addEventListener('input', clearFieldErrors);
function showFieldError(e) {
    const el = e.field && form.elements.namedItem(e.field);
    if (!el) return;
    clearFieldErrors();
    const text = document.createElement('span'); text.className = 'field-error'; text.id = `error-${e.field}`; text.textContent = e.message;
    el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', text.id); el.insertAdjacentElement('afterend', text); el.focus();
}
async function save(overrides = {}) {
    clearFieldErrors();
    const r = await api('/api/settings', { values: { ...values(), ...overrides } }); fill(r);
    if (r.checksInvalidated) resetTrialAudio(); notice(r.checksInvalidated ? '保存しました。音声とAI設定が変わったため、実試聴をやり直してください。' : '設定を保存しました。'); return r;
}
async function action(button, fn) {
    button.disabled = true; try { await fn(); } catch (e) { notice(e.message, true); showFieldError(e); } finally { button.disabled = false; }
}
form.onsubmit = e => { e.preventDefault(); void action(form.querySelector('.savebar button'), () => save()); };
$('demo').onclick = () => action($('demo'), async () => { await save({ MODE: 'demo' }); location.href = '/'; });
$('llm-provider').onchange = viewProvider;
$('preset').onchange = () => {
    const v = $('preset').value;
    if (v === 'ollama') { form.elements.LLM_PROVIDER.value = 'ollama'; form.elements.LLM_BASE_URL.value = 'http://127.0.0.1:11434/v1'; }
    if (v === 'lmstudio') { form.elements.LLM_PROVIDER.value = 'compatible'; form.elements.LLM_BASE_URL.value = 'http://127.0.0.1:1234/v1'; }
    if (v === 'gemini') form.elements.LLM_PROVIDER.value = 'gemini'; viewProvider();
};
for (const button of document.querySelectorAll('[data-clear]')) button.onclick = () => action(button, async () => {
    if (!confirm('保存したキーを削除して、DEMOモードに戻しますか？')) return;
    fill(await api('/api/settings', { values: { MODE: 'demo' }, clear: [button.dataset.clear] })); resetTrialAudio(); notice('削除しました。');
});
$('detect').onclick = () => action($('detect'), async () => {
    await save(); const r = await api('/api/setup/detect', {});
    $('models').replaceChildren(...r.models.map(x => { const o = document.createElement('option'); o.value = x; return o; }));
    $('speakers').replaceChildren(new Option('声を選んでください', ''), ...r.speakers.map(x => { const o = new Option(x.name, String(x.id)); o.dataset.credit = x.credit; return o; }));
    $('comment-speakers').replaceChildren(new Option('読み上げの声を選択', ''), ...r.speakers.map(x => { const o = new Option(x.name, String(x.id)); o.dataset.credit = x.credit; return o; }));
    const styles = r.aivis?.styles || [];
    $('aivis-styles').replaceChildren(new Option(styles.length ? 'スタイルを選んでください' : '「モデルと声を検出」を実行してください', ''), ...styles.map(x => { const o = new Option(x.name, String(x.id)); o.dataset.credit = x.credit; return o; }));
    const license = r.aivis?.license;
    $('aivis-license').textContent = !license ? '' : `${license.nonCommercialHint ? 'このモデルは非営利ライセンス（ACML-NCなど）の可能性があります。営利目的の配信には使えません。' : 'モデルの利用規約を確認してください。'}${license.excerpt ? `\n規約の抜粋：${license.excerpt}` : ''}`;
    $('sbv2-models').replaceChildren(...(r.sbv2?.models || []).map(x => { const o = document.createElement('option'); o.value = x.name; return o; }));
    $('detect-result').textContent = `${r.models.length} モデル / ${r.speakers.length} 音声スタイルを検出。${r.supertonic ? ' Supertonic 3 接続確認済み（合成は試聴で確認）。' : ''}${r.aivis ? ` AivisSpeech ${r.aivis.styles.length} スタイル。` : ''}${r.sbv2 ? ` Style-Bert-VITS2 ${r.sbv2.models.length} モデル。` : ''}\n` + r.errors.map(x => `${x.provider}: ${x.error}`).concat(r.warnings || []).join('\n');
});
$('comment-speakers').onchange = () => { const o = $('comment-speakers').selectedOptions[0]; if (o.value) { form.elements.COMMENT_VOICEVOX_SPEAKER.value = o.value; form.elements.COMMENT_VOICEVOX_CREDIT.value = o.dataset.credit; } };
$('aivis-styles').onchange = () => { const o = $('aivis-styles').selectedOptions[0]; if (o.value) { form.elements.AIVIS_STYLE.value = o.value; form.elements.AIVIS_CREDIT.value = o.dataset.credit; } };
$('library-reload').onclick = () => action($('library-reload'), async () => {
    const r = await api('/api/setup/library', { action: 'reload' }); viewLibrary(r.status);
    if (r.checksInvalidated) resetTrialAudio();
    notice(r.checksInvalidated ? '反応音ライブラリが変わりました。実試聴をやり直してください。' : '反応音ライブラリを再読み込みしました（変更なし）。');
});
$('speakers').onchange = () => { const o = $('speakers').selectedOptions[0]; if (o.value) { form.elements.VOICEVOX_SPEAKER.value = o.value; form.elements.VOICEVOX_CREDIT.value = o.dataset.credit; } };
$('rehearse').onclick = () => action($('rehearse'), async () => {
    if (!$('metered-consent').checked) throw new Error('APIへの送信と利用料について確認してください。');
    await save({ MODE: 'live' }); resetTrialAudio(); notice('文章生成・ローカル判定・音声合成を確認しています。');
    const r = await api('/api/setup/rehearse', { confirm: 'RUN_CHECK' }); trial = r; heardReply = false; heardComment = !r.commentAudio; heardLibrary = !r.libraryAudio; $('heard').disabled = true;
    if (r.library) viewLibrary(r.library);
    $('checks').replaceChildren(...r.checks.map(x => { const p = document.createElement('p'); p.textContent = `${x.ok ? '✓' : '×'} ${x.name} ${x.ok ? x.ms + ' ms' : x.error}`; if (!x.ok) p.className = 'failed'; return p; }));
    $('trial-comment-text').textContent = r.trialComment ? `コメント用の声：${r.trialComment}` : '';
    $('comment-trial-audio').hidden = !r.commentAudio;
    if (r.ok && r.commentAudio) {
        const response = await fetch(r.commentAudio, { headers: { Authorization: `Bearer ${admin}` } });
        if (!response.ok) throw new Error('コメント試聴音声が失効しました。');
        if (commentAudioURL) URL.revokeObjectURL(commentAudioURL);
        commentAudioURL = URL.createObjectURL(await response.blob()); $('comment-trial-audio').src = commentAudioURL;
    }
    $('library-trial-audio').hidden = !(r.ok && r.libraryAudio);
    $('library-index').replaceChildren(...(r.ok ? r.libraryIndex || [] : []).map(x => { const li = document.createElement('li'); li.textContent = `${(x.startMs / 1000).toFixed(1)}s ${({ style: '声', clip: '反応音', phrase: 'フレーズ' })[x.kind] || x.kind}: ${x.label}`; return li; }));
    if (r.ok && r.libraryAudio) {
        const response = await fetch(r.libraryAudio, { headers: { Authorization: `Bearer ${admin}` } });
        if (!response.ok) throw new Error('反応音の試聴音声が失効しました。');
        if (libraryAudioURL) URL.revokeObjectURL(libraryAudioURL);
        libraryAudioURL = URL.createObjectURL(await response.blob()); $('library-trial-audio').src = libraryAudioURL;
    }
    $('trial-text').textContent = r.text || ''; $('trial-audio').hidden = !r.ok;
    if (r.ok && r.audio) {
        const response = await fetch(r.audio, { headers: { Authorization: `Bearer ${admin}` } });
        if (!response.ok) throw new Error('試聴音声が失効しました。');
        if (audioURL) URL.revokeObjectURL(audioURL); audioURL = URL.createObjectURL(await response.blob());
        $('trial-audio').src = audioURL; $('heard').disabled = true;
        notice(trial.libraryAudio ? '返答・コメント用の声に加えて、声のスタイル見本・反応音・定型フレーズも最後まで再生して確認してください。' : trial.commentAudio ? 'コメント用VOICEVOXと返答用の両方を再生し、声を確認してください。' : '生成と合成が成功しました。音声を最後まで確認してください。');
    } else notice('試聴は完了していません。失敗した段階を確認してください。', true);
});
function updateHeard() { $('heard').disabled = !(trial?.ok && heardReply && heardComment && heardLibrary); }
$('trial-audio').onended = () => { heardReply = true; updateHeard(); };
$('comment-trial-audio').onended = () => { heardComment = true; updateHeard(); };
$('library-trial-audio').onended = () => { heardLibrary = true; updateHeard(); };
const trialPlayers = ['trial-audio', 'comment-trial-audio', 'library-trial-audio'];
for (const id of trialPlayers) $(id).onplay = () => { for (const other of trialPlayers) if (other !== id) $(other).pause(); };
$('heard').onclick = () => action($('heard'), async () => { await api('/api/setup/heard', { id: trial?.id, heard: true, commentHeard: heardComment, libraryHeard: heardLibrary }); notice('試聴を確認しました。スタジオでローカル自動運転を開始できます。'); });
$('youtube-check').onclick = () => action($('youtube-check'), async () => { await save(); const r = await api('/api/setup/youtube', {}); notice(({ live: '配信枠のチャットIDを取得しました。コメントの受信は番組開始後に確認します。', waiting_for_broadcast: '配信開始待ちです。番組開始後も再確認を続けます。', ended: 'この配信枠は終了しています。' })[r.state]); });
$('obs-check').onclick = () => action($('obs-check'), async () => { await save(); const r = await api('/api/setup/obs', {}); notice(r.connected ? 'OBSに接続しました。音声取り込みと配信先はOBS側でも確認してください。' : '接続できませんでした。'); });
void connect();

async function remoteState() {
    const r = await api('/api/remote/access');
    $('remote-state').textContent = !r.enabled ? '未設定：PCで npm run remote:setup を実行してください。'
        : `${r.origin}/mobile — ${r.armed ? '開始許可済み（' + new Date(r.armedUntil).toLocaleString('ja-JP') + 'まで）' : '開始は未許可'}。${r.obsRenderer ? 'OBS音声ソース接続済み。' : 'OBS音声ソース未接続。'}`;
}
$('remote-refresh').onclick = () => action($('remote-refresh'), remoteState);
$('remote-arm').onclick = () => action($('remote-arm'), async () => {
    if (!$('remote-consent').checked) throw new Error('録画と配信先・公開範囲・自動スタートを確認してください。');
    await api('/api/remote/arm', { confirm: 'ARM_VERIFIED_OUTPUT' }); await remoteState();
    notice('遠隔開始を8時間許可しました。PCを起動したまま、スマホから専用URLを開いてください。');
});
$('remote-disarm').onclick = () => action($('remote-disarm'), async () => { await api('/api/remote/disarm', {}); await remoteState(); notice('遠隔開始の許可を取り消しました。'); });

$('recommended-persona').onclick = () => { if (suggestedPersona && confirm('現在入力している話し方を初期案で置き換えます。保存するまで反映しません。')) { form.elements.CHARACTER_PERSONA.value = suggestedPersona; clearFieldErrors(); notice('話し方の初期案を入力しました。内容を確認して保存してください。'); } };

let lastReportMarkdown = '';
$('load-analysis').onclick = () => action($('load-analysis'), async () => {
    notice('配信ログを読み込んで分析しています...');
    const r = await api('/api/programme/report?transcript=true');
    const summaryEl = $('analytics-summary');
    const timelineEl = $('analytics-timeline');
    if (!r.transcriptIncluded || !r.analysis) {
        summaryEl.innerHTML = '<p class="failed">直近の配信記録が見つかりませんでした。配信（ローカル会話）を実行すると記録されます。</p>';
        timelineEl.style.display = 'none';
        $('copy-markdown-report').disabled = true;
        notice('配信ログがまだありません。');
        return;
    }
    const a = r.analysis, s = r.session || {};
    summaryEl.innerHTML = `
        <div style="background:#edf0e3;padding:14px;border-radius:10px;margin-bottom:12px;">
            <strong>【${s.programmeTitle || '企画雑談'}】</strong> (${s.durationFormatted || '0秒'}, 終了: ${s.stopReason || '完了'})<br>
            ・発言回数: <strong>${a.speechCount}</strong> 回 (コメント読上: <strong>${a.commentsRead}</strong> 件)<br>
            ・総文字数: <strong>${a.totalChars}</strong> 字 (平均 <strong>${a.avgCharsPerSec}</strong> 字/秒)<br>
            ・企画進捗: <strong>${a.distinctBeatsCount} / 27 課題</strong>達成 (${Math.round(a.distinctBeatsCount / 27 * 100)}%)<br>
            ・重複検査: 最大類似度 <strong>${a.maxSimilarity}</strong> (0.82以上で警戒), 自動修復 <strong>${a.repairAttempts}</strong> 回<br>
            ・健全性: ${a.stalled ? '<span class="failed">停滞検知による自動安全停止あり</span>' : '<span style="color:#214e40;">正常に進行</span>'}
        </div>
    `;
    const lines = (r.timeline || []).map(item => {
        const sim = item.similarity !== null ? ` [類似度:${item.similarity}]` : '';
        const role = item.role === 'comment' ? '💬 コメント' : `🎤 ${characterName}`;
        return `<div style="padding:6px 0;border-bottom:1px solid #edf0e3;">
            <span style="color:#6c7f71;">[${item.time}]</span> <strong>${role}</strong> <small style="color:#8ea27e;">【${item.label}】</small>${sim}<br>
            <div style="margin-left:14px;margin-top:2px;">${item.text}</div>
        </div>`;
    }).join('');
    timelineEl.innerHTML = lines || '<div>発言記録なし</div>';
    timelineEl.style.display = 'block';

    // Generate markdown
    lastReportMarkdown = `# 配信分析レポート: ${s.programmeTitle || '企画雑談'}\n\n` +
        `- 配信時間: ${s.durationFormatted}\n` +
        `- 発言回数: ${a.speechCount} 回 (コメント読上: ${a.commentsRead} 件)\n` +
        `- 総文字数: ${a.totalChars} 文字 (話速: ${a.avgCharsPerSec} 字/秒)\n` +
        `- 課題進捗: ${a.distinctBeatsCount} / 27 課題 (${Math.round(a.distinctBeatsCount / 27 * 100)}%)\n` +
        `- 最大類似度: ${a.maxSimilarity} / 自動修復: ${a.repairAttempts} 回\n\n` +
        `## 発言タイムライン\n\n` +
        (r.timeline || []).map(t => `- \`[${t.time}]\` **${t.label}**: ${t.text}`).join('\n');
    $('copy-markdown-report').disabled = false;
    notice('最新の配信分析レポートを読み込みました。');
});

$('copy-markdown-report').onclick = () => {
    if (!lastReportMarkdown) return;
    navigator.clipboard.writeText(lastReportMarkdown).then(() => {
        notice('Markdownレポートをクリップボードにコピーしました！');
    }).catch(() => {
        notice('コピーに失敗しました。', true);
    });
};
