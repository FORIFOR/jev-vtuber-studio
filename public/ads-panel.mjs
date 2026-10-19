/** The ad library panel in the Studio's 広告 tab: a list of creatives with on/off, order, seconds and sound, an add form
 * that uploads one file (image / video / PDF) and saves the list, and a master switch shared with the sponsor slot.
 * Every change is validated by the server and shown only after it is saved; the stage follows over SSE. */
const KINDS = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/webm': 'video', 'application/pdf': 'pdf' };
const LIMITS = { image: 2 * 1024 * 1024, video: 64 * 1024 * 1024, pdf: 20 * 1024 * 1024 };
const uuid = () => (crypto.randomUUID?.() || `ad-${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`);

export function initAdsPanel({ $, api, token, onMaster, fetchFn = (...a) => fetch(...a) }) {
    let saved = null, busy = false, message = '', thumbs = new Map();
    const list = $('ads-list'), status = $('ads-status');
    const setStatus = text => { status.textContent = text; };
    function render() {
        $('ads-master').disabled = busy || !saved;
        $('ads-current').textContent = !saved ? '接続待ち' : `${saved.ads.filter(a => a.enabled).length} 件表示中 / 全 ${saved.ads.length} 件`;
        $('ad-upload').disabled = busy || !saved;
        if (!saved) return;
        if (!saved.ads.length) { list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty-line', textContent: '広告はまだありません。下から追加できます。' })); }
        else list.replaceChildren(...saved.ads.map((ad, i) => item(ad, i)));
        setStatus(message || (busy ? '保存中…' : ''));
    }
    function thumb(ad) {
        const box = document.createElement('div'); box.className = 'ad-thumb';
        if (!ad.media) { box.textContent = ad.title || '文字のみ'; return box; }
        const el = document.createElement(ad.media.kind === 'video' ? 'video' : 'img');
        if (ad.media.kind === 'video') { el.muted = true; el.loop = true; el.playsInline = true; el.autoplay = true; }
        box.append(el);
        const cached = thumbs.get(ad.media.id);
        if (cached) el.src = cached;
        else fetchFn(ad.media.url, { headers: { Authorization: `Bearer ${token()}` } }).then(r => r.ok ? r.blob() : Promise.reject()).then(b => { const url = URL.createObjectURL(b); thumbs.set(ad.media.id, url); el.src = url; }).catch(() => { box.textContent = '読み込み不可'; });
        return box;
    }
    function item(ad, i) {
        const li = document.createElement('li'); li.className = `ad-item${ad.enabled ? '' : ' off'}`;
        const meta = document.createElement('div'); meta.className = 'ad-meta';
        const name = document.createElement('b'); name.textContent = ad.title || ad.name || (ad.media ? `${ad.media.kind === 'video' ? '動画' : '画像'}広告` : '広告'); meta.append(name);
        const info = document.createElement('small'); info.textContent = `${ad.media ? (ad.media.kind === 'video' ? `動画${ad.sound ? '・音あり' : '・音なし'}` : `画像 ${ad.media.width}×${ad.media.height}`) : '文字のみ'}${ad.link ? ` · ${ad.link}` : ''}`; meta.append(info);
        const row = document.createElement('small');
        const on = document.createElement('label'); const onBox = document.createElement('input'); onBox.type = 'checkbox'; onBox.checked = ad.enabled; onBox.onchange = () => save(ads => { ads[i].enabled = onBox.checked; }); on.append(onBox, ' 表示する　');
        const sec = document.createElement('input'); sec.type = 'number'; sec.min = 10; sec.max = 600; sec.value = ad.seconds; sec.onchange = () => save(ads => { ads[i].seconds = Number(sec.value); });
        row.append(on, '表示秒数', sec, '秒');
        if (ad.media?.kind === 'video') { const snd = document.createElement('label'); const sBox = document.createElement('input'); sBox.type = 'checkbox'; sBox.checked = ad.sound; sBox.onchange = () => save(ads => { ads[i].sound = sBox.checked; }); snd.append('　', sBox, ' 音を出す'); row.append(snd); }
        meta.append(row);
        const actions = document.createElement('div'); actions.className = 'ad-actions';
        for (const [label, fn, disabled] of [['↑ 上へ', () => save(ads => { [ads[i - 1], ads[i]] = [ads[i], ads[i - 1]]; }), i === 0], ['↓ 下へ', () => save(ads => { [ads[i + 1], ads[i]] = [ads[i], ads[i + 1]]; }), i === saved.ads.length - 1], ['削除', () => { if (confirm('この広告を一覧から削除しますか？')) save(ads => { ads.splice(i, 1); }); }, false]]) {
            const b = document.createElement('button'); b.type = 'button'; b.className = label === '削除' ? 'quiet' : 'secondary'; b.textContent = label; b.disabled = disabled || busy; b.onclick = fn; actions.append(b);
        }
        li.append(thumb(ad), meta, actions); return li;
    }
    const payloadOf = ads => ads.map(({ id, enabled, title, message, link, seconds, sound, media, name }) => ({ id, enabled, title, message, link, seconds, sound, media: media ? { id: media.id } : null, name }));
    async function save(mutate) {
        if (busy || !saved) return;
        busy = true; message = ''; render();
        try {
            const ads = structuredClone(saved.ads); mutate(ads);
            saved = await api('/api/ads', { revision: saved.revision, ads: payloadOf(ads) });
            message = '保存して反映しました。';
        } catch (e) {
            if (e.current) saved = e.current; else try { saved = await api('/api/ads'); } catch { }
            message = e.status === 409 ? '別の画面で更新されたため、最新の一覧を読み直しました。もう一度操作してください。' : e.message;
        } finally { busy = false; render(); }
    }
    $('ad-upload').onclick = async () => {
        const file = $('ad-file').files[0], title = $('ad-title').value.trim();
        if (!file && !title) { $('ad-upload-status').textContent = 'ファイルを選ぶか、見出しを入れてください。'; return; }
        const kind = file ? KINDS[file.type] : null;
        if (file && !kind) { $('ad-upload-status').textContent = '画像（PNG / JPEG / WebP）、動画（MP4 / WebM）、PDF を選んでください。'; return; }
        if (file && file.size > LIMITS[kind]) { $('ad-upload-status').textContent = `ファイルが大きすぎます（${kind === 'image' ? '画像 2MB' : kind === 'video' ? '動画 64MB' : 'PDF 20MB'} まで）。`; return; }
        busy = true; render(); $('ad-upload-status').textContent = file ? (kind === 'pdf' ? 'PDF を画像に変換しています…' : 'アップロードしています…') : '保存しています…';
        try {
            let media = null;
            if (file) {
                const r = await fetchFn('/api/ads/media', { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file });
                const body = await r.json(); if (!r.ok) throw new Error(body.error || 'アップロードに失敗しました。');
                media = body.media;
            }
            const ad = { id: uuid(), enabled: true, title, message: $('ad-message').value.trim(), link: $('ad-link').value.trim(), seconds: Number($('ad-seconds').value) || 60, sound: $('ad-sound').checked, media: media ? { id: media.id } : null, name: file?.name?.slice(0, 80) || '' };
            busy = false;
            await save(ads => { ads.push(ad); });
            if (!message.includes('もう一度')) { $('ad-file').value = ''; $('ad-title').value = ''; $('ad-message').value = ''; $('ad-link').value = ''; $('ad-sound').checked = false; $('ad-upload-status').textContent = '追加しました。「広告枠を表示する」がオンなら配信画面に出ます。'; }
            else $('ad-upload-status').textContent = message;
        } catch (e) { $('ad-upload-status').textContent = e.message; }
        finally { busy = false; render(); }
    };
    $('ads-master').onchange = () => onMaster($('ads-master').checked);
    return {
        receive(snapshot, authoritative = false) {
            if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.ads)) return;
            if (!authoritative && saved && snapshot.revision < saved.revision) return;
            saved = snapshot; render();
        },
        master(enabled) { $('ads-master').checked = !!enabled; $('ads-master').disabled = busy || !saved; },
        dispose() { for (const url of thumbs.values()) URL.revokeObjectURL(url); thumbs.clear(); },
    };
}
