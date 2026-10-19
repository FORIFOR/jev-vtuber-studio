// Clip studio (operator 2026-10-11): right after a live show, edited clips, Shorts and thumbnails are made from OBS's own
// recording and published to YouTube, with no operator step. Builds on src/post-stream.mjs (moments, runs, upload).
// - Source: OBS's local recording (OBS_RECORD=true). OBS names it by its start time ("2026-10-11 02-16-59.mov"), which
//   maps the Studio's wall-clock logs onto the file (checked 2026-10-11: a line logged at 02:46:59 is on screen at 30:00).
// - How many: decided by the show — one clip per run that made a story (long, high level or the night's best), up to one
//   per hour; Shorts for moments that stand alone, about one per half hour of strong moments.
// - Editing, not plain cuts: a title card, chapter label, big telops on Noa's strongest lines (the stage's own captions
//   stay), punch zooms on the game with a pop sound, an end card. Shorts: 9:16 with the game above, Noa enlarged below,
//   burned-in subtitles of every line, a headline and a progress bar. Thumbnails: the peak frame, Noa enlarged, two
//   lines of big text.
// - Text that goes public is built from templates, game facts and lines Noa already said (each passed Jev.speech()),
//   and passes the local PII/injection check again. Descriptions say what was edited (docs/JEV_DECISION_HUD.md).
// - YouTube API quota: an upload costs 1600 units, a thumbnail 50. Uploads wait in a queue and go out within a daily
//   budget (the comment reader shares the project's 10,000), the strongest first.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { CHARACTER_JA, STAGE_JA, scoreLine, planDigest, clock } from './post-stream.mjs';
import { hasPII, injection } from './util.mjs';
import { RECORDING_NAME } from './disk-guard.mjs';

export const FONT = '/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc';
export const FONT_FAMILY = 'Hiragino Sans';
// Where the stage puts things in the 1280x720 recording (public/stage.css game layout, room theme).
export const LAYOUT = Object.freeze({ game: { x: 20, y: 90, w: 920, h: 520 }, noa: { x: 950, y: 0, w: 330, h: 360 } });
const NAMES_CHAR = { ...CHARACTER_JA, CONCETTA: 'コンチェッタ', EX_ZIAPPUNTA: 'ジ・アプンタ', PUGNALA: 'プニャーラ' }, NAMES_STAGE = { ...STAGE_JA, CHAPEL: 'マグナ礼拝堂', SINKING: 'ムーンゴロウ' };
const charName = id => NAMES_CHAR[id] || id || '', stageName = id => NAMES_STAGE[id] || id || '';
const STRONG = new Set(['shock', 'surprised', 'excited', 'happy', 'troubled']);
// What happened in a line, from Noa's own words (the log keeps the line, not the game event): the reaction alone is
// mostly neutral (2026-10-10: 1,200 of 1,860 lines), so a pinch, an escape, a boss or a reply makes the moment.
const DRAMA = [[/ピンチ|危な|体力が|やば|囲ま|すき間|寄ってきた|速いのが来た|ボス|もう！|なんで/, 3], [/抜け|通れた|助かった|進化|宝箱|自己ベスト|クリア|生き延び|分突破|超え/, 2.5], [/ヒック|ぷはー|NOA BEER/, 1.5]];
const ROUTINE = /^(やった|よし)、レベルアップ！/;
/** How much a line makes a clip moment: its log score, what happened in it, a reply to a viewer; a routine level-up pick less. */
export function dramaScore(s) {
    const text = s.text || '';
    return scoreLine(s) + DRAMA.reduce((n, [re, w]) => n + (re.test(text) ? w : 0), 0) + (s.kind === 'reply' ? 3 : 0) - (ROUTINE.test(text) && !/進化/.test(text) ? 2.5 : 0);
}
/** post-stream moments, rescored by dramaScore (run endings keep theirs). */
export function rescore(ms, speech) {
    const by = new Map(speech.map(s => [s.start, s])), seen = new Map();
    for (const s of speech) seen.set(s.text, (seen.get(s.text) || 0) + 1);
    // A line said many times that night is a template (「よし、すき間を通れた！」 aired 40 times): it weighs less each time.
    return ms.map(m => {
        if (m.kind === 'run_end') return m;
        const s = by.get(m.at) || { text: m.text, kind: m.kind, reaction: m.reaction };
        return { ...m, score: m.score - scoreLine(s) + dramaScore(s) - Math.min(4, Math.log2(seen.get(m.text) || 1)) };
    });
}
const TELOP_COLOR = { shock: '&H0000D7FF', surprised: '&H0000D7FF', excited: '&H006BD4FF', happy: '&H00B469FF', troubled: '&H00FFB45A' }; // ASS &HBBGGRR

/** OBS's default recording name -> its start (local time, ms), or null. */
export function recordingStart(name) {
    const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})\.\w+$/.exec(name || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}
/** The recording that covers [from, to]: [{ path, start, durationSec }] -> one of them or null. */
export function recordingFor(recordings, from, to) {
    return recordings.find(r => Number.isFinite(r.start) && r.start <= from + 5000 && r.start + r.durationSec * 1000 >= to - 5000) || null;
}

/** The last finished show in show-log.jsonl of at least minMs (a rehearsal or a test start is no show), or the one
 * named: { sessionId, start, end, reason } (start/end ms), or null. */
export function lastShow(jsonl, { sessionId = null, minMs = 20 * 60000 } = {}) {
    let start = null, show = null;
    for (const line of String(jsonl).split('\n')) {
        if (!line.includes('"type":"show_st')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'show_start') start = { sessionId: j.sessionId, start: Date.parse(j.at) };
        else if (j.type === 'show_stop' && start && j.sessionId === start.sessionId) {
            const s = { ...start, end: Date.parse(j.at), reason: j.reason };
            if (sessionId ? s.sessionId === sessionId : s.end - s.start >= minMs) show = s;
        }
    }
    return show;
}

const hours = (from, to) => Math.max(0, (to - from) / 3600000);

/** Clips: one per run that made a story, the strongest first; at most one per hour of show (at least one when any run
 * qualifies). Each clip is the run's best moments (~4 min) and its ending, in time order. */
export function planClips(ms, runs, { showStart, showEnd, target = 240, perHour = 1, max = 6 } = {}) {
    const best = runs.reduce((b, r) => (r.level > (b?.level ?? -1) ? r : b), null);
    const story = runs.filter(r => r.seconds >= 480 || r.level >= 30 || r === best && r.seconds >= 180)
        .map(r => ({ r, score: r.level + r.seconds / 60 + (r === best ? 20 : 0) + (r.outcome === 'clear' ? 15 : 0)
            + ms.filter(m => m.at >= r.start && m.at <= r.end).sort((a, b) => b.score - a.score).slice(0, 5).reduce((n, m) => n + m.score, 0) }))
        .sort((a, b) => b.score - a.score);
    const count = Math.min(max, story.length, Math.max(1, Math.round(hours(showStart, showEnd) * perHour)));
    return story.slice(0, count).map(({ r, score }) => {
        const own = ms.filter(m => m.at >= r.start && m.at <= r.end + 10000);
        const segments = planDigest(own, [r], { target, maxClip: 60 }).map(s => ({ from: s.from, to: s.to }));
        const ending = { from: Math.max(r.start, r.end - 45000), to: r.end + 6000 };
        if (!segments.some(s => s.to >= ending.from)) segments.push(ending);
        segments.sort((a, b) => a.from - b.from);
        const merged = [];
        for (const s of segments) { const l = merged.at(-1); if (l && s.from - l.to < 4000) l.to = Math.max(l.to, s.to); else merged.push({ ...s }); }
        return { run: r, score, best: r === best, segments: merged.filter(s => s.to - s.from >= 5000) };
    }).filter(c => c.segments.length);
}

/** Shorts: moments that stand alone (a hook line or a run ending), strongest first, ~one per half hour, never two
 * within two minutes. */
export function planShortsByShow(ms, runs, { showStart, showEnd, perHour = 2, max = 10, minScore = 4, length = 40 } = {}) {
    const count = Math.min(max, Math.max(1, Math.round(hours(showStart, showEnd) * perHour)));
    const out = [];
    for (const m of [...ms].sort((a, b) => b.score - a.score)) {
        if (out.length >= count || m.score < minScore) break;
        if (m.kind !== 'run_end' && (ROUTINE.test(m.text || '') || out.some(o => o.text && o.text === m.text))) continue;
        const from = m.kind === 'run_end' ? m.to - length * 1000 : m.at - 12000, c = { from, to: from + length * 1000 };
        if (c.from < showStart || c.to > showEnd || out.some(o => o.from < c.to + 120000 && c.from < o.to + 120000)) continue;
        const r = runs.find(x => m.at >= x.start && m.at <= x.end + 10000) || null;
        out.push({ ...c, kind: m.kind, text: m.text, reaction: m.reaction, score: m.score, run: r });
    }
    return out.sort((a, b) => b.score - a.score);
}

// ---- ASS subtitles / telops ----
const assTime = s => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
const assText = t => String(t).replace(/[{}\\]/g, '').replace(/\r?\n/g, '\\N');
/** Wrap Japanese text for subtitles: at most `per` characters a row, breaking after punctuation when it can. */
export function wrapJa(text, per = 16) {
    const out = []; let rest = String(text).trim();
    while (rest.length > per) {
        const cut = Math.max(...['、', '。', '！', '？', '…', ' '].map(p => rest.lastIndexOf(p, per)).filter(i => i >= per / 2), -1);
        const i = cut >= 0 ? cut + 1 : per; out.push(rest.slice(0, i)); rest = rest.slice(i);
    }
    if (rest) out.push(rest);
    return out.join('\n');
}
export function assDocument({ width, height, styles, events }) {
    return ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
        '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        ...styles.map(s => `Style: ${s.name},${FONT_FAMILY},${s.size},${s.color || '&H00FFFFFF'},&H000000FF,${s.outline || '&H00000000'},&H80000000,-1,0,0,0,100,100,0,0,1,${s.border ?? 6},${s.shadow ?? 2},${s.align ?? 2},40,40,${s.marginV ?? 60},1`),
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...events.map(e => `Dialogue: ${e.layer ?? 0},${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`), ''].join('\n');
}
/** Big telops for a clip segment: Noa's strongest lines inside it, popping in at the top of the game (seconds from the
 * segment start). The stage's own caption box stays: the telop is the emphasis, not a second subtitle track. */
export function telopEvents(speech, seg, { max = 6 } = {}) {
    const inside = speech.filter(s => s.start >= seg.from && s.start < seg.to - 800);
    const strong = inside.filter(s => dramaScore(s) >= 3.5 && !ROUTINE.test(s.text)).sort((a, b) => dramaScore(b) - dramaScore(a)).slice(0, max).sort((a, b) => a.start - b.start);
    return strong.map(s => {
        const start = (s.start - seg.from) / 1000, end = Math.min((seg.to - seg.from) / 1000, start + Math.max(2.2, (s.end - s.start) / 1000 + .8));
        const color = TELOP_COLOR[s.reaction] || '&H0000D7FF';
        return { start, end, style: 'Telop', text: `{\\c${color}\\fscx130\\fscy130\\t(0,160,\\fscx100\\fscy100)}${assText(wrapJa(s.text, 18))}` };
    });
}
/** Every line of a Short as a subtitle (seconds from the Short's start), two rows at most. */
export function subtitleEvents(speech, seg) {
    return speech.filter(s => s.end > seg.from && s.start < seg.to).map(s => ({
        start: Math.max(0, (s.start - seg.from) / 1000), end: Math.min((seg.to - seg.from) / 1000, (s.end - seg.from) / 1000 + .3), style: STRONG.has(s.reaction) ? 'SubStrong' : 'Sub',
        text: assText(wrapJa(s.text, 13).split('\n').slice(0, 3).join('\n')) }));
}
export const CLIP_STYLES = [{ name: 'Telop', size: 88, color: '&H0000D7FF', border: 9, shadow: 3, align: 8, marginV: 230 }];
export const SHORT_STYLES = [{ name: 'Sub', size: 66, border: 7, align: 2, marginV: 250 }, { name: 'SubStrong', size: 74, color: '&H0000D7FF', border: 8, align: 2, marginV: 250 }];

// ---- ffmpeg ----
const esc = t => String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%');
const filterPath = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const between = (spans) => spans.length ? spans.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+') : '0';
/** Punch zooms: the moments of a segment's telops (seconds), each 1.4 s, at most one every 4 s. */
export function punches(events) {
    const out = [];
    for (const e of events) if (!out.length || e.start - out.at(-1) >= 4) out.push(e.start);
    return out;
}
/** One edited clip segment from the recording: 1080p, punch zooms on the game with a pop, telops, an optional title card
 * (first segment), chapter label and end card (last segment), short fades. */
export function segmentArgs({ input, at, seconds, out, ass, zooms = [], titleCard = null, label = '', endCard = false }) {
    const d = seconds.toFixed(2), f = Math.max(0, seconds - .4).toFixed(2);
    const z = `1+0.16*min(1,${between(zooms.map(t => [t, t + 1.4]))})`;
    const cx = (LAYOUT.game.x + LAYOUT.game.w / 2) / 1280, cy = (LAYOUT.game.y + LAYOUT.game.h / 2) / 720;
    let v = `[0:v]scale=1920:1080:flags=lanczos,fps=30,scale=w='trunc(1920*(${z})/2)*2':h='trunc(1080*(${z})/2)*2':eval=frame,crop=1920:1080:x='max(0,min(iw-1920,${cx.toFixed(3)}*iw-960))':y='max(0,min(ih-1080,${cy.toFixed(3)}*ih-540))'`;
    if (ass) v += `,ass='${filterPath(ass)}'`;
    if (label) v += `,drawbox=x=60:y=930:w=${Math.min(1100, 80 + label.length * 46)}:h=86:color=0x0b1120@0.82:t=fill:enable='between(t,0.3,5)',drawtext=fontfile='${filterPath(FONT)}':text='${esc(label)}':fontsize=44:fontcolor=white:x=90:y=950:enable='between(t,0.3,5)'`;
    if (titleCard) {
        const [l1, l2 = ''] = Array.isArray(titleCard) ? titleCard : wrapJa(titleCard, 16).split('\n');
        v += `,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill:enable='lt(t,2.8)'`
            + `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(l1)}':fontsize=96:fontcolor=0xFFD700:borderw=8:bordercolor=black:x=(w-tw)/2:y=(h/2)-${l2 ? 120 : 50}:enable='lt(t,2.8)'`
            + (l2 ? `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(l2)}':fontsize=96:fontcolor=white:borderw=8:bordercolor=black:x=(w-tw)/2:y=(h/2)+10:enable='lt(t,2.8)'` : '');
    }
    if (endCard) {
        const e0 = Math.max(0, seconds - 4).toFixed(2);
        v += `,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.6:t=fill:enable='gte(t,${e0})'`
            + `,drawtext=fontfile='${filterPath(FONT)}':text='見てくれてありがとう！':fontsize=92:fontcolor=white:borderw=8:bordercolor=black:x=(w-tw)/2:y=(h/2)-110:enable='gte(t,${e0})'`
            + `,drawtext=fontfile='${filterPath(FONT)}':text='チャンネル登録で次の配信もいっしょに！':fontsize=64:fontcolor=0xFFD700:borderw=6:bordercolor=black:x=(w-tw)/2:y=(h/2)+30:enable='gte(t,${e0})'`;
    }
    v += `,fade=t=in:st=0:d=0.3,fade=t=out:st=${f}:d=0.4[v]`;
    // A short "pop" for each zoom (generated, no audio asset), mixed over the recording's sound.
    const pops = zooms.map((t, i) => `aevalsrc='0.35*sin(2*PI*(1400-2600*t)*t)*exp(-14*t)':d=0.3:s=48000,adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)},aformat=channel_layouts=stereo[p${i}]`);
    const a = `[0:a]aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${f}:d=0.4[a0]` + (pops.length ? `;${pops.join(';')};[a0]${zooms.map((_, i) => `[p${i}]`).join('')}amix=inputs=${zooms.length + 1}:normalize=0:duration=first[a]` : '');
    const graph = `${v};${a}`;
    return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', input, '-t', d, '-filter_complex', graph, '-map', '[v]', '-map', pops.length ? '[a]' : '[a0]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out];
}
/** One Short from the recording: 1080x1920, a headline band, the game, Noa enlarged, subtitles, a progress bar. */
export function shortEditArgs({ input, at, seconds, out, ass, headline }) {
    const d = seconds.toFixed(2), f = Math.max(0, seconds - .5).toFixed(2), g = LAYOUT.game, n = LAYOUT.noa;
    const [h1, h2 = ''] = wrapJa(headline, 12).split('\n');
    const graph = `[0:v]fps=30,split=2[a][b];[a]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=1080:-2:flags=lanczos[top];[b]crop=${n.w}:${n.h}:${n.x}:${n.y},scale=820:-2:flags=lanczos[noa];`
        + `color=c=0x0b1120:s=1080x1920:r=30:d=${d}[bg];[bg][top]overlay=0:300[t];[t][noa]overlay=(W-w)/2:930:shortest=1`
        + `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(h1)}':fontsize=84:fontcolor=0xFFD700:borderw=7:bordercolor=black:x=(w-tw)/2:y=${h2 ? 60 : 110}`
        + (h2 ? `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(h2)}':fontsize=84:fontcolor=white:borderw=7:bordercolor=black:x=(w-tw)/2:y=170` : '')
        + (ass ? `,ass='${filterPath(ass)}'` : '')
        + `,drawbox=x=0:y=1900:w='iw*t/${d}':h=20:color=0xFFD700:t=fill,fade=t=in:st=0:d=0.3,fade=t=out:st=${f}:d=0.5[v]`;
    return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', input, '-t', d, '-filter_complex', graph, '-map', '[v]', '-map', '0:a',
        '-af', `aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${f}:d=0.5`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out];
}
/** A 1280x720 thumbnail: the game at the peak moment, darkened on the left, Noa enlarged on the right, two lines of text. */
export function thumbnailArgs({ input, at, out, line1, line2 = '', badge = 'AI完全自立' }) {
    const g = LAYOUT.game, n = LAYOUT.noa;
    const graph = `[0:v]split=2[a][b];[a]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=saturation=1.25:contrast=1.08[bg];`
        + `[b]crop=${n.w}:${n.h}:${n.x}:${n.y},scale=-2:700:flags=lanczos[noa];[bg]drawbox=x=0:y=0:w=760:h=720:color=black@0.45:t=fill[d];[d][noa]overlay=W-w+40:H-h+10`
        + `,drawbox=x=40:y=40:w=${80 + badge.length * 44}:h=76:color=0xE0245E:t=fill,drawtext=fontfile='${filterPath(FONT)}':text='${esc(badge)}':fontsize=46:fontcolor=white:x=70:y=56`
        + `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(line1)}':fontsize=${line1.length > 6 ? 118 : 150}:fontcolor=0xFFD700:borderw=12:bordercolor=black:x=50:y=${line2 ? 230 : 300}`
        + (line2 ? `,drawtext=fontfile='${filterPath(FONT)}':text='${esc(line2)}':fontsize=${line2.length > 8 ? 84 : 104}:fontcolor=white:borderw=10:bordercolor=black:x=50:y=420` : '');
    return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-filter_complex', graph, '-q:v', '3', out];
}

// ---- public text ----
const fit = (t, n = 100) => (t.length <= n ? t : t.slice(0, n - 1) + '…');
/** Public text must pass the local PII/injection check (Noa's lines already passed Jev.speech()). */
export const safeText = t => typeof t === 'string' && !!t.trim() && !hasPII(t) && !injection(t);
const outcomeJa = r => r.outcome === 'clear' ? 'クリア！' : r.seconds >= 1790 ? '30分生き残った！' : `${Math.floor(r.seconds / 60)}分の激闘`;
export const EDIT_NOTE = '※ライブ配信の録画から、テロップ・ズーム・効果音・字幕を加えて編集しています。セリフとゲーム操作はAIがライブで行ったものです。';
/** The chapter label on a clip: who, where, how far. */
export const clipLabel = r => `${charName(r.character)}${r.stage ? `・${stageName(r.stage)}` : ''}　Lv${r.level}`;
export function clipMetadata(clip, { channelName = '星藍ノア', archiveId = '', game = 'Vampire Survivors', speech = [] } = {}) {
    const r = clip.run, who = charName(r.character), where = stageName(r.stage);
    const said = new Map(); for (const s of speech) said.set(s.text, (said.get(s.text) || 0) + 1);
    // The quote in the title is a line of this run said at most three times that night (not a repeated template).
    const top = speech.filter(s => s.start >= r.start && s.start <= r.end && !ROUTINE.test(s.text) && said.get(s.text) <= 3).sort((a, b) => dramaScore(b) - dramaScore(a))[0];
    const quote = top && dramaScore(top) >= 4 && top.text.replace(/\s+/g, '').length <= 22 ? top.text.replace(/\s+/g, '') : '';
    const title = fit(`【${game}】${who}${where ? `で${where}` : ''}、Lv${r.level}${clip.best ? 'の今夜ベスト' : ''}…${outcomeJa(r)}${quote ? `「${quote}」` : ''}【AI VTuber ${channelName}】`);
    const description = [`AI VTuber ${channelName}が、ゲーム操作も実況もすべて自分で行ったライブ配信の切り抜きです。`,
        `${who}${where ? `・${where}` : ''}で最高Lv${r.level}、${Math.floor(r.seconds / 60)}分${r.seconds % 60 ? `${Math.round(r.seconds % 60)}秒` : ''}のプレイ。`, '', EDIT_NOTE,
        archiveId ? `\nライブ配信のアーカイブ: https://www.youtube.com/watch?v=${archiveId}` : '', '', '#VampireSurvivors #ヴァンサバ #AIVTuber'].join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const [line1, line2] = r.outcome === 'clear' ? ['クリア!!', `${who}でLv${r.level}`] : r.seconds >= 1790 ? [`Lv${r.level}`, '30分生き残った!?'] : [`Lv${r.level}`, `${who}の激闘`];
    const card = [`${who}${where ? `・${where}` : ''}`, r.outcome === 'clear' ? `Lv${r.level}でクリア！` : r.seconds >= 1790 ? `Lv${r.level}で30分生き残った！` : `Lv${r.level}、${Math.floor(r.seconds / 60)}分の激闘`];
    return { title, description, tags: [game, 'ヴァンパイアサバイバーズ', 'AI VTuber', channelName, 'AI実況', '切り抜き'], thumb: { line1, line2 }, card };
}
export function shortMetadata(s, { channelName = '星藍ノア', archiveId = '' } = {}) {
    const r = s.run, who = r ? charName(r.character) : '';
    // The headline: a run's ending, a reply (the viewer's words are not repeated), else the line's first sentence.
    const first = ((s.text || '').replace(/\s+/g, '').match(/^.+?[。！？!?]/) || [(s.text || '').replace(/\s+/g, '')])[0];
    const headline = s.kind === 'run_end' && r ? (r.outcome === 'clear' ? 'まさかのクリア!?' : `Lv${r.level}の最期…`)
        : s.kind === 'reply' ? 'コメントにお返事！' : first.length <= 24 ? first : `${first.slice(0, 23)}…`;
    const title = s.kind === 'run_end' && r ? fit(`AIが完全自立でプレイした${who}、Lv${r.level}${r.outcome === 'clear' ? 'でクリア！' : 'の最期…'} #Shorts #VampireSurvivors`)
        : fit(`「${(s.text || '').replace(/\s+/g, ' ').slice(0, 40)}」AIが自分でゲーム実況 #Shorts #VampireSurvivors`);
    return { title, headline, description: [`AI VTuber ${channelName}が完全自立でVampire Survivorsを実況プレイ。`, EDIT_NOTE, archiveId ? `ライブ全編: https://www.youtube.com/watch?v=${archiveId}` : '', '#Shorts #VampireSurvivors #AIVTuber'].filter(Boolean).join('\n'),
        tags: ['Vampire Survivors', 'AI VTuber', channelName, 'Shorts'] };
}

// ---- upload queue ----
export const UNITS = Object.freeze({ upload: 1600, thumbnail: 50 });
const pacificDay = (now = Date.now()) => new Date(now - 7 * 3600000).toISOString().slice(0, 10); // quota resets at midnight Pacific
/** data/post-stream/queue.json: items { id, kind, file, thumb, meta, priority, status: 'pending'|'uploaded'|'failed', videoId }
 * and the units spent today. Uploads go out strongest first while the daily budget lasts. */
export class UploadQueue {
    constructor(file, { budget = 6500, now = Date.now } = {}) { Object.assign(this, { file, budget, now }); this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { items: [], spent: {} }; }
    save() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2)); renameSync(`${this.file}.tmp`, this.file); }
    add(item) { if (!this.data.items.some(x => x.id === item.id)) this.data.items.push({ status: 'pending', attempts: 0, ...item }); this.save(); }
    pending() { return this.data.items.filter(x => x.status === 'pending').sort((a, b) => b.priority - a.priority); }
    left() { return this.budget - (this.data.spent[pacificDay(this.now())] || 0); }
    spend(units) { const d = pacificDay(this.now()); this.data.spent = { [d]: (this.data.spent[d] || 0) + units }; this.save(); }
    /** Upload what today's budget allows. upload(item) -> videoId; thumbnail(item, videoId) -> void. -> [results].
     * existing: Map title -> videoId of videos already on the channel. A queued item with the same title was posted by
     * hand (2026-10-13/14: the Lv102 / Lv118 clips and Shorts went up twice): it is recorded as uploaded, not sent again. */
    async run({ upload, thumbnail, existing = new Map() }) {
        const done = [];
        for (const item of this.pending()) {
            const posted = existing.get(item.meta?.title);
            if (posted) {
                Object.assign(item, { status: 'uploaded', videoId: posted, uploadedAt: new Date(this.now()).toISOString(), postedElsewhere: true }); this.save();
                done.push({ id: item.id, videoId: posted, skipped: 'already_on_channel' }); continue;
            }
            const cost = UNITS.upload + (item.thumb ? UNITS.thumbnail : 0);
            if (this.left() < cost) break;
            try {
                this.spend(UNITS.upload); item.attempts++;
                item.videoId = await upload(item); item.status = 'uploaded'; item.uploadedAt = new Date(this.now()).toISOString(); this.save();
                if (item.thumb) { this.spend(UNITS.thumbnail); try { await thumbnail(item, item.videoId); item.thumbSet = true; } catch (e) { item.thumbError = String(e.message).slice(0, 160); } this.save(); }
                done.push({ id: item.id, videoId: item.videoId });
            } catch (e) {
                item.error = String(e.message).slice(0, 200);
                if (/quota/i.test(item.error)) { item.attempts--; this.data.spent = { [pacificDay(this.now())]: this.budget }; this.save(); break; } // out for today (not this item's fault): try tomorrow
                if (item.attempts >= 3) item.status = 'failed';
                this.save(); done.push({ id: item.id, error: item.error });
            }
        }
        return done;
    }
}

/** The channel's latest uploads (2 quota units): Map title -> videoId. */
export async function channelTitles(api, fetchFn, token, max = 50) {
    const ch = await api(fetchFn, token, 'channels?part=contentDetails&mine=true');
    const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return new Map();
    const list = await api(fetchFn, token, `playlistItems?part=snippet&maxResults=${max}&playlistId=${encodeURIComponent(uploads)}`);
    return new Map((list?.items || []).map(i => [i.snippet?.title, i.snippet?.resourceId?.videoId]).filter(([t, v]) => t && v));
}

/** thumbnails.set for an uploaded video (JPEG). */
export async function setThumbnail({ token, videoId, bytes }, fetchFn = fetch) {
    const r = await fetchFn(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: bytes });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`YouTube thumbnail HTTP ${r.status}${j?.error?.errors?.[0]?.reason ? ` (${j.error.errors[0].reason})` : ''}`); }
}
// ---- selection (operator 2026-10-13: a show every day outgrows the upload budget, so only the night's best is made) ----
const LEVEL_UP = /レベル\d+になった|レベルアップ/;
/** A run worth publishing: a clear, 30 minutes survived, or the night's best when it went far (15 min or Lv60). */
export const worthRun = (r, best = false) => !!r && (r.outcome === 'clear' || r.seconds >= 1790 || best && (r.seconds >= 900 || r.level >= 60));
/** The night's best within one day's upload budget: clips of runs worth it (at most maxClips), then Shorts — a worthy
 * run's ending, or a line said at most twice that night that is no level-up — strongest first. A weak night makes none. */
export function selectBest({ clips, shorts, speech = [], budget = 6500, maxClips = 2 }) {
    const said = new Map(); for (const s of speech) said.set(s.text, (said.get(s.text) || 0) + 1);
    const bestRun = clips.find(c => c.best)?.run;
    let left = budget;
    const fits = units => (left >= units ? (left -= units, true) : false);
    const keepClips = clips.filter(c => worthRun(c.run, c.best)).sort((a, b) => b.score - a.score).slice(0, maxClips).filter(() => fits(UNITS.upload + UNITS.thumbnail));
    const keepShorts = shorts.filter(s => (s.kind === 'run_end' ? worthRun(s.run, s.run === bestRun) : (said.get(s.text) || 0) <= 2 && !LEVEL_UP.test(s.text || '') && !ROUTINE.test(s.text || '')))
        .sort((a, b) => b.score - a.score).filter(() => fits(UNITS.upload));
    return { clips: keepClips, shorts: keepShorts };
}
/** 投稿メモ.txt for posting by hand: each file with its title, description and tags. */
export function uploadNote(items) {
    return items.map((x, i) => [`■ ${i + 1}. ${x.file.split('/').pop()}${x.thumb ? `（サムネイル: ${x.thumb.split('/').pop()}）` : ''}`, `タイトル: ${x.meta.title}`, '説明:', x.meta.description, `タグ: ${x.meta.tags.join(', ')}`].join('\n')).join('\n\n') + '\n';
}

// ---- cleanup (operator 2026-10-13: the recording may go once its clips and Shorts are made; a rendered file once posted) ----
/** The show's recordings, once every clip and Short is rendered (uploads go from the rendered files). Only OBS's own
 * recording names, none written in the last 10 minutes (it may still be recording). -> [removed paths] */
export function removeRecordings(recordings, { now = Date.now(), rm = p => rmSync(p, { force: true }) } = {}) {
    const removed = [];
    for (const r of recordings) {
        if (!RECORDING_NAME.test(basename(r.path))) continue;
        try { if (now - statSync(r.path).mtimeMs < 600000) continue; rm(r.path); removed.push(r.path); } catch { }
    }
    return removed;
}
/** Rendered files (video, thumbnail) of uploaded queue items, only inside root. -> [removed paths] */
export function removeUploaded(items, root, { rm = p => rmSync(p, { force: true }) } = {}) {
    const base = resolve(root) + sep, removed = [];
    for (const item of items) {
        if (item.status !== 'uploaded') continue;
        for (const p of [item.file, item.thumb]) {
            if (!p || !resolve(p).startsWith(base) || !existsSync(p)) continue;
            try { rm(p); removed.push(p); } catch { }
        }
    }
    return removed;
}
export { clock };
