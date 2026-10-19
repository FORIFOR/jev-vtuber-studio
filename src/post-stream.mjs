// After a live show: a ~20-minute digest and a few Shorts cut from the YouTube archive (scripts/post-stream.mjs).
// No video analysis: the moments come from what the Studio already logged with wall-clock times — Noa's spoken lines
// (data/show-log.jsonl; logged when a line finished playing, so it started audioMs earlier) and the game runs
// (runs/vampire-*/metadata.json started_at + summary.json). The archive already shows the captions, HUD and chat, so
// nothing is drawn on top: the digest joins cuts, a Short re-frames one cut to 9:16. Text that goes public (titles,
// descriptions) is built from templates and lines that already passed Jev.speech().
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CHARACTER_JA = Object.freeze({ LAMA: 'ラマ', CROCI: 'クロチ', DOMMARIO: 'ドンマリオ', PORTA: 'ポルタ', IMELDA: 'イメルダ', ANTONIO: 'アントニオ', CAMILLO: 'ポー', MORTACCIO: 'モルタッチョ', PASQUALINA: 'パスカリーナ', GENNARO: 'ジェンナーロ', ARCA: 'アルカ' });
export const STAGE_JA = Object.freeze({ FOREST: '狂気の森', LIBRARY: '象牙の図書館', WAREHOUSE: '酪農場', TOWER: 'ガロの塔' });
const KIND_SCORE = { reply: 3, opening: 2.5, game_reaction: 2, game_fact: 1, autonomous: .5 };
const REACTION_SCORE = { shock: 2, surprised: 2, excited: 1.2, happy: 1, troubled: 1, thinking: .3 };
const HOOK = /ボス|囲ま|抜け|レベル|宝箱|復活|自己ベスト|クリア|やった|危な|ピンチ|すご|強い|進化|最高|ありがとう|コメント/;

/** Noa's spoken lines between from and to (ms): { start, end, text, kind, reaction, comment }. */
export function readSpeech(jsonl, { from, to }) {
    const out = [];
    for (const line of String(jsonl).split('\n')) {
        if (!line.includes('"type":"speech"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const end = Date.parse(j.at);
        if (!Number.isFinite(end) || end < from || end > to || !j.text) continue;
        out.push({ start: end - Math.max(0, Number(j.audioMs) || 0), end, text: String(j.text), kind: j.kind || 'autonomous', reaction: j.verdict?.reaction || 'neutral', comment: j.comment || null });
    }
    return out.sort((a, b) => a.start - b.start);
}

/** Game runs that started between from and to: { name, start, end, character, stage, level, outcome, seconds }. */
export function readRuns(runsDir, { from, to }) {
    const runs = [];
    let names = []; try { names = readdirSync(runsDir); } catch { return runs; }
    for (const name of names) {
        if (!name.startsWith('vampire-')) continue;
        let m, s; try { m = JSON.parse(readFileSync(join(runsDir, name, 'metadata.json'), 'utf8')); s = JSON.parse(readFileSync(join(runsDir, name, 'summary.json'), 'utf8')); } catch { continue; }
        const start = Date.parse(m.started_at);
        if (!Number.isFinite(start) || start < from || start > to) continue;
        runs.push({ name, start, end: start + (Number(s.duration_seconds) || 0) * 1000, character: s.actual_character || s.requested_character || '', stage: s.stage || '',
            level: Number(s.final_player?.level) || 0, outcome: s.end_reason || s.outcome || '', seconds: Number(s.game_elapsed_seconds) || 0 });
    }
    return runs.sort((a, b) => a.start - b.start);
}

/** How strong one spoken line is as a highlight (0..~10); density = lines within ±30 s. */
export function scoreLine(s, density = 0) {
    return (KIND_SCORE[s.kind] ?? .5) + (REACTION_SCORE[s.reaction] ?? 0) + (HOOK.test(s.text) ? 1 : 0) + Math.min(2, density * .25);
}

/** Candidate moments: scored lines plus every finished run's last stretch (a long run's ending is the drama). A line
 * during a run counts more the further that run went (a Lv4 run rarely makes a highlight). */
export function moments(speech, runs) {
    const best = runs.reduce((b, r) => (r.level > (b?.level ?? -1) ? r : b), null);
    const out = speech.map((s, i) => {
        let density = 0;
        for (let j = i - 1; j >= 0 && speech[j].start > s.start - 30000; j--) density++;
        for (let j = i + 1; j < speech.length && speech[j].start < s.start + 30000; j++) density++;
        const r = runAt(runs, s.start), weight = r ? .4 + Math.min(1, r.level / 40) * .8 : .7;
        return { at: s.start, from: s.start - 8000, to: s.end + 12000, score: scoreLine(s, density) * weight, kind: s.kind, text: s.text, reaction: s.reaction };
    });
    for (const r of runs) {
        if (r.seconds < 300 || !r.end) continue;
        out.push({ at: r.end - 20000, from: r.end - 45000, to: r.end + 6000, score: 6 + r.level / 20 + (r === best ? 4 : 0) + (r.outcome === 'clear' ? 2 : 0), kind: 'run_end', text: '', run: r.name });
    }
    return out;
}

const runAt = (runs, t) => runs.find(r => t >= r.start && t <= r.end + 10000) || null;
const overlaps = (a, b, pad = 0) => a.from < b.to + pad && b.from < a.to + pad;

/** Greedy pick of moments until target seconds, spread over the show (neighbours within 5 min lose weight), then in
 * time order with overlapping cuts merged. Clips stay ≤ maxClip s. -> [{ from, to, runName, label }] in wall-clock ms. */
export function planDigest(ms, runs, { target = 1200, maxClip = 75, opening = null } = {}) {
    const pool = ms.map(m => ({ ...m, w: m.score }));
    const picked = opening ? [{ from: opening.from, to: Math.min(opening.to, opening.from + 50000), kind: 'opening' }] : [];
    const total = () => picked.reduce((n, c) => n + (c.to - c.from) / 1000, 0);
    while (total() < target && pool.length) {
        pool.sort((a, b) => b.w - a.w);
        const m = pool.shift();
        if (picked.some(c => overlaps(c, m))) {
            const c = picked.find(c => overlaps(c, m));
            const from = Math.min(c.from, m.from), to = Math.max(c.to, m.to);
            if ((to - from) / 1000 <= maxClip) Object.assign(c, { from, to });
            continue;
        }
        picked.push({ from: m.from, to: m.to, kind: m.kind });
        for (const o of pool) if (Math.abs(o.at - m.at) < 300000) o.w *= .6;
    }
    picked.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const c of picked) {
        const last = merged.at(-1);
        if (last && c.from - last.to < 4000) last.to = Math.max(last.to, c.to);
        else merged.push({ ...c });
    }
    return merged.map((c, i) => { const r = runAt(runs, (c.from + c.to) / 2); return { from: c.from, to: c.to, runName: r?.name || null, level: r?.level ?? 0, label: opening && i === 0 ? 'オープニング' : runLabel(r) }; });
}

/** Up to count Shorts (30–40 s), strongest first, never overlapping, at most two run endings. */
export function planShorts(ms, runs, { count = 5, length = 36 } = {}) {
    const chosen = [];
    let endings = 0;
    for (const m of [...ms].sort((a, b) => b.score - a.score)) {
        if (chosen.length >= count) break;
        if (m.kind === 'run_end' && endings >= 2) continue;
        if (m.kind !== 'run_end' && !HOOK.test(m.text)) continue;
        const from = m.kind === 'run_end' ? m.to - length * 1000 : m.at - 10000, c = { from, to: from + length * 1000 };
        if (chosen.some(o => overlaps(o, c, 60000))) continue;
        if (m.kind === 'run_end') endings++;
        const r = runAt(runs, m.at);
        chosen.push({ ...c, kind: m.kind, text: m.text, score: m.score, run: r ? { character: r.character, stage: r.stage, level: r.level, outcome: r.outcome } : null });
    }
    return chosen;
}

/** Chapter name of a run: who and where (the level goes on the chapter, the best one reached in it). */
export function runLabel(r) {
    if (!r) return 'ゲームの合間';
    const who = CHARACTER_JA[r.character] || r.character, where = STAGE_JA[r.stage] || r.stage;
    return `${who}${where ? `・${where}` : ''}`;
}

export const clock = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

/** YouTube chapters for the digest: consecutive cuts of one run share a chapter; YouTube needs 0:00 and ≥3 chapters. */
export function chapters(cuts) {
    const out = []; let t = 0;
    for (const c of cuts) {
        if (!out.length || out.at(-1).label !== c.label) out.push({ at: t, label: c.label, level: 0 });
        out.at(-1).level = Math.max(out.at(-1).level, c.level || 0);
        t += (c.to - c.from) / 1000;
    }
    if (out.length) out[0].at = 0;
    const kept = out.filter((c, i) => i === out.length - 1 || out[i + 1].at - c.at >= 10);
    return kept.length >= 3 ? kept.map(c => `${clock(c.at)} ${c.label}${c.level ? `（最高Lv${c.level}）` : ''}`) : [];
}

/** Public text for the digest and each Short: templates plus lines Noa already said (Jev-gated). */
export function metadata({ videoId, showStart, showEnd, runs, cuts, shorts, channelName = '星藍ノア' }) {
    const hours = Math.max(1, Math.round((showEnd - showStart) / 3600000));
    const best = runs.reduce((b, r) => (r.level > (b?.level ?? -1) ? r : b), null);
    const chars = [...new Set(runs.filter(r => r.seconds >= 300).map(r => CHARACTER_JA[r.character] || r.character))];
    const fit = t => (t.length <= 100 ? t : t.slice(0, 99) + '…');
    const digest = {
        title: fit(`【AI完全自立】${channelName}がVampire Survivorsを${hours}時間実況プレイ！${best ? `最高Lv${best.level}` : ''}までの20分ダイジェスト`),
        description: [`AI VTuber ${channelName}が、ゲーム操作も実況もすべて自分で行った${hours}時間のライブ配信を20分にまとめました。`, 'AI VTuber plays Vampire Survivors fully autonomously — a 20-minute digest of the live stream.',
            '', chapters(cuts).join('\n'), '', chars.length ? `使用キャラ: ${chars.join('、')}` : '', `ライブ配信のアーカイブ: https://www.youtube.com/watch?v=${videoId}`, '', '#VampireSurvivors #AIVTuber #ヴァンサバ'].filter((l, i, a) => l || a[i - 1]).join('\n').trim(),
        tags: ['Vampire Survivors', 'ヴァンパイアサバイバーズ', 'AI VTuber', channelName, 'AI実況'],
    };
    const shortTitles = shorts.map(s => {
        const who = s.run ? CHARACTER_JA[s.run.character] || s.run.character : '';
        if (s.kind === 'run_end' && s.run) return fit(`AIが完全自立でプレイした${who}、Lv${s.run.level}${s.run.outcome === 'clear' ? 'でクリア！' : 'の最期…'} #Shorts #VampireSurvivors`);
        const line = s.text.replace(/\s+/g, ' ').slice(0, 40);
        return fit(`「${line}」AIが自分でゲーム実況 #Shorts #VampireSurvivors`);
    });
    return { digest, shorts: shorts.map((s, i) => ({ title: shortTitles[i], description: `AI VTuber ${channelName}が完全自立でVampire Survivorsを実況プレイ。\nAI VTuber plays fully autonomously.\nライブ全編: https://www.youtube.com/watch?v=${videoId}\n#Shorts #VampireSurvivors #AIVTuber`, tags: digest.tags })) };
}

/** ffmpeg arguments: one cut, normalised for joining (1080p30, AAC 48 kHz, short fades so joins don't click). */
export function cutArgs(input, out, seconds) {
    const d = seconds.toFixed(2), f = Math.max(0, seconds - .4).toFixed(2);
    return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', d,
        '-vf', `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,fade=t=in:st=0:d=0.3,fade=t=out:st=${f}:d=0.4`,
        '-af', `aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${f}:d=0.4`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', out];
}

/** ffmpeg arguments: one cut re-framed to 9:16 — the game frame with its HUD, captions and chat on top, Noa below. */
export function shortArgs(input, out, seconds) {
    const d = seconds.toFixed(2), f = Math.max(0, seconds - .5).toFixed(2);
    const graph = `[0:v]scale=1920:1080,fps=30,split=2[a][b];[a]crop=1140:1050:40:0,scale=1080:994[top];[b]crop=620:780:1290:300,scale=-2:926[noa];`
        + `color=c=0x0b1120:s=1080x1920:r=30:d=${d}[bg];[bg][top]overlay=0:0[t];[t][noa]overlay=(W-w)/2:994:shortest=1,fade=t=in:st=0:d=0.3,fade=t=out:st=${f}:d=0.5[v]`;
    return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', d, '-filter_complex', graph, '-map', '[v]', '-map', '0:a',
        '-af', `aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${f}:d=0.5`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', out];
}

/** yt-dlp arguments: only the needed stretch of the archive (seconds from the archive start). */
export function sectionArgs(videoId, from, to, out) {
    return ['--no-progress', '--quiet', '-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4', '--download-sections', `*${from.toFixed(1)}-${to.toFixed(1)}`,
        '--force-keyframes-at-cuts', '-o', out, `https://www.youtube.com/watch?v=${videoId}`];
}

/** Resumable upload (videos.insert). Private unless asked; publishAt (ISO) schedules a private video. -> video id. */
export async function uploadVideo({ token, file, size, title, description, tags = [], privacy = 'private', publishAt = null, categoryId = '20', readStream }, fetchFn = fetch) {
    const body = { snippet: { title, description, tags, categoryId, defaultLanguage: 'ja' }, status: { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, ...(publishAt ? { publishAt } : {}) } };
    const init = await fetchFn('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(body) });
    if (!init.ok) throw new Error(`YouTube upload init HTTP ${init.status}`);
    const url = init.headers.get('location');
    if (!url?.startsWith('https://www.googleapis.com/')) throw new Error('YouTube upload: no upload URL');
    const r = await fetchFn(url, { method: 'PUT', redirect: 'error', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: readStream(file), duplex: 'half' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) throw new Error(`YouTube upload HTTP ${r.status}${j?.error?.errors?.[0]?.reason ? ` (${j.error.errors[0].reason})` : ''}`);
    return j.id;
}

