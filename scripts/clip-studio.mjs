// Clip studio (src/clip-studio.mjs): edited clips, Shorts and thumbnails from OBS's recording of the last show, then
// published within the day's YouTube budget. The Studio starts it when a live show completes; it can also be run by hand:
//   npm run clips                      the last finished show: plan, render, queue, upload
//   npm run clips -- --session ID      a given show (show-log sessionId) instead of the last one
//   npm run clips -- --plan-only       only the plan (data/post-stream/<session>/plan.json)
//   npm run clips -- --no-upload       render and queue, upload later
//   npm run clips -- --upload-queue    only upload what is queued (the Studio runs this hourly while items wait)
// Only the night's best is made (selectBest: what one day's upload budget takes). Without CLIP_UPLOAD=1 nothing is
// uploaded: the operator posts by hand from data/post-stream/<session>/投稿メモ.txt.
// Writes data/post-stream/<session>/ and data/post-stream/status.json. Once every clip and Short of the show is rendered,
// the show's OBS recordings are removed (CLIP_KEEP_RECORDINGS=1 or --keep-recordings keeps them); a rendered file is
// removed once uploaded. Never deletes or edits other videos.
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadEnv } from '../src/config.mjs';
import { accessToken, api } from '../src/youtube-schedule.mjs';
import { readSpeech, readRuns, moments, uploadVideo } from '../src/post-stream.mjs';
import { lastShow, rescore, recordingStart, recordingFor, planClips, planShortsByShow, telopEvents, subtitleEvents, assDocument, CLIP_STYLES, SHORT_STYLES,
    punches, segmentArgs, shortEditArgs, thumbnailArgs, clipMetadata, clipLabel, shortMetadata, safeText, UploadQueue, setThumbnail, channelTitles, clock,
    removeRecordings, removeUploaded, selectBest, uploadNote } from '../src/clip-studio.mjs';

loadEnv();
const c = config(process.env, ['node', 'x']), cs = c.clipStudio;
const flag = n => process.argv.includes(`--${n}`), arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const root = join(c.dataDir, 'post-stream'); mkdirSync(root, { recursive: true, mode: 0o700 });
const status = s => { const prev = existsSync(join(root, 'status.json')) ? JSON.parse(readFileSync(join(root, 'status.json'), 'utf8')) : {}; writeFileSync(join(root, 'status.json'), JSON.stringify({ ...prev, ...s, at: new Date().toISOString() }, null, 2)); };
const run = (cmd, args) => new Promise((resolve, reject) => {
    const p = spawn('nice', ['-n', '15', cmd, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { if (err.length < 4000) err += d; });
    p.on('error', reject); p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} exit ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`))));
});
const ffprobe = cs.ffmpeg.replace(/ffmpeg$/, 'ffprobe');
const duration = f => { try { return Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) || 0; } catch { return 0; } };
const token = async () => {
    const file = join(c.dataDir, 'youtube-schedule-oauth.json');
    return accessToken({ clientId: c.youtubeClient, clientSecret: c.youtubeSecret, refreshToken: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).refresh_token : '' });
};

async function uploadQueue(queue) {
    if (!queue.pending().length) return [];
    const t = await token();
    const existing = await channelTitles(api, fetch, t).catch(e => (console.log(`チャンネルの既存動画を確認できませんでした: ${e.message}`), new Map()));
    const done = await queue.run({ existing,
        upload: item => uploadVideo({ token: t, file: item.file, size: statSync(item.file).size, ...item.meta, privacy: cs.privacy, readStream: p => createReadStream(p) }),
        thumbnail: (item, videoId) => setThumbnail({ token: t, videoId, bytes: readFileSync(item.thumb) }),
    });
    const freed = removeUploaded(queue.data.items, root);
    if (freed.length) console.log(`投稿済みの動画ファイルを${freed.length}件消しました。`);
    for (const d of done) console.log(d.skipped ? `投稿済み（チャンネルに同じタイトルあり）: https://www.youtube.com/watch?v=${d.videoId}` : d.videoId ? `投稿: https://www.youtube.com/watch?v=${d.videoId}` : `投稿できませんでした（${d.id}）: ${d.error}`);
    const left = queue.pending().length;
    if (left) console.log(`今日の投稿枠を使い切りました。残り${left}本は明日以降に投稿します。`);
    return done;
}

try {
    const queue = new UploadQueue(join(root, 'queue.json'), { budget: cs.dailyUnits });
    if (flag('upload-queue') && !cs.upload) process.exit(); // posted by hand
    if (flag('upload-queue')) {
        status({ state: 'uploading' });
        const done = await uploadQueue(queue);
        status({ state: 'idle', uploaded: done.filter(d => d.videoId).length, pending: queue.pending().length });
        process.exit();
    }
    const show = lastShow(readFileSync(join(c.dataDir, 'show-log.jsonl'), 'utf8'), { sessionId: arg('session') || null });
    if (!show || !Number.isFinite(show.end)) throw new Error('終わった番組が見つかりません。');
    const dir = join(root, show.sessionId); mkdirSync(join(dir, 'work'), { recursive: true, mode: 0o700 });
    status({ state: 'planning', sessionId: show.sessionId, error: null });
    const speech = readSpeech(readFileSync(join(c.dataDir, 'show-log.jsonl'), 'utf8'), { from: show.start, to: show.end });
    const runs = readRuns(c.gameLogDir || `${process.env.HOME}/Projects/jev-vampire-survivors/runs`, { from: show.start, to: show.end });
    const ms = rescore(moments(speech, runs), speech);
    // The recordings of this show (a restart mid-show makes a second file): OBS's own names give their start times.
    const recDir = arg('recordings') || cs.recordingsDir || `${process.env.HOME}/Movies`;
    const recordings = readdirSync(recDir).filter(n => recordingStart(n) !== null).map(n => ({ path: join(recDir, n), start: recordingStart(n) }))
        .filter(r => r.start <= show.end && r.start >= show.start - 6 * 3600000).map(r => ({ ...r, durationSec: duration(r.path) }));
    const candidates = { clips: planClips(ms, runs, { showStart: show.start, showEnd: show.end }).map(cl => ({ ...cl, segments: cl.segments.filter(s => recordingFor(recordings, s.from, s.to)) })).filter(cl => cl.segments.length),
        shorts: planShortsByShow(ms, runs, { showStart: show.start, showEnd: show.end }).filter(s => recordingFor(recordings, s.from, s.to)) };
    const { clips, shorts } = selectBest({ ...candidates, speech, budget: cs.dailyUnits });
    let archiveId = '';
    try { archiveId = (/done (\S+)/.exec(JSON.parse(readFileSync(join(c.dataDir, 'stream-title.json'), 'utf8')).youtube || '') || [])[1] || ''; } catch { }
    const plan = { sessionId: show.sessionId, start: new Date(show.start).toISOString(), end: new Date(show.end).toISOString(), recordings: recordings.map(r => ({ file: r.path.split('/').pop(), seconds: Math.round(r.durationSec) })),
        clips: clips.map(cl => ({ run: cl.run.name, level: cl.run.level, seconds: Math.round(cl.segments.reduce((n, s) => n + (s.to - s.from) / 1000, 0)), segments: cl.segments.length, ...clipMetadata(cl, { archiveId, speech }) })),
        shorts: shorts.map(s => ({ kind: s.kind, text: s.text, ...shortMetadata(s, { archiveId }) })) };
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    console.log(`計画: 切り抜き${clips.length}本・ショート${shorts.length}本（候補 ${candidates.clips.length}本・${candidates.shorts.length}本から選別、録画${recordings.length}本） → ${join(dir, 'plan.json')}`);
    if (flag('plan-only')) { status({ state: 'idle', planned: { clips: clips.length, shorts: shorts.length } }); process.exit(); }

    const ff = cs.ffmpeg, at = (rec, t) => (t - rec.start) / 1000;
    for (const [i, cl] of clips.entries()) {
        const out = join(dir, `clip-${i + 1}.mp4`), thumb = join(dir, `clip-${i + 1}.jpg`), meta = clipMetadata(cl, { archiveId, speech });
        if (![meta.title, meta.description, meta.thumb.line1, meta.thumb.line2].every(safeText)) { console.log(`切り抜き${i + 1}: 公開文が確認を通らないため作りません`); continue; }
        status({ state: 'rendering', step: `切り抜き ${i + 1}/${clips.length}` });
        if (!existsSync(out)) {
            const parts = [];
            for (const [k, s] of cl.segments.entries()) {
                const rec = recordingFor(recordings, s.from, s.to), events = telopEvents(speech, s), ass = join(dir, 'work', `clip-${i + 1}-${k}.ass`), part = join(dir, 'work', `clip-${i + 1}-${k}.mp4`);
                writeFileSync(ass, assDocument({ width: 1920, height: 1080, styles: CLIP_STYLES, events }));
                await run(ff, segmentArgs({ input: rec.path, at: at(rec, s.from), seconds: (s.to - s.from) / 1000, out: part, ass, zooms: punches(events),
                    titleCard: k === 0 ? meta.card : null, label: k === 0 ? clipLabel(cl.run) : '', endCard: k === cl.segments.length - 1 }));
                parts.push(part);
            }
            writeFileSync(join(dir, 'work', `clip-${i + 1}.txt`), parts.map(p => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'));
            await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'work', `clip-${i + 1}.txt`), '-c', 'copy', '-movflags', '+faststart', out]);
        }
        // The thumbnail's frame: the climax, 25 s before the run ended (the screen is fullest there).
        const peak = cl.run.end - 25000, prec = recordingFor(recordings, peak, peak);
        if (prec) await run(ff, thumbnailArgs({ input: prec.path, at: at(prec, peak), out: thumb, ...meta.thumb }));
        queue.add({ id: `${show.sessionId}-clip-${i + 1}`, ...(cs.upload ? {} : { status: 'manual' }), kind: 'clip', file: out, thumb: prec ? thumb : null, meta: { title: meta.title, description: meta.description, tags: meta.tags }, priority: 100 + cl.score });
        console.log(`切り抜き${i + 1}: ${out}（${clock(duration(out))}）`);
    }
    for (const [i, s] of shorts.entries()) {
        const out = join(dir, `short-${i + 1}.mp4`), meta = shortMetadata(s, { archiveId }), rec = recordingFor(recordings, s.from, s.to);
        if (![meta.title, meta.description, meta.headline].every(safeText)) { console.log(`ショート${i + 1}: 公開文が確認を通らないため作りません`); continue; }
        status({ state: 'rendering', step: `ショート ${i + 1}/${shorts.length}` });
        if (!existsSync(out)) {
            const ass = join(dir, 'work', `short-${i + 1}.ass`);
            writeFileSync(ass, assDocument({ width: 1080, height: 1920, styles: SHORT_STYLES, events: subtitleEvents(speech, s) }));
            await run(ff, shortEditArgs({ input: rec.path, at: at(rec, s.from), seconds: (s.to - s.from) / 1000, out, ass, headline: meta.headline }));
        }
        queue.add({ id: `${show.sessionId}-short-${i + 1}`, ...(cs.upload ? {} : { status: 'manual' }), kind: 'short', file: out, thumb: null, meta: { title: meta.title, description: meta.description, tags: meta.tags }, priority: 50 + s.score });
        console.log(`ショート${i + 1}: ${out}`);
    }
    // Everything is rendered (a failed render threw above and kept the recording): the show's recordings are no longer needed.
    if (!cs.keepRecordings && !flag('keep-recordings')) {
        const made = queue.data.items.filter(x => x.id.startsWith(`${show.sessionId}-`));
        if (made.length && made.every(x => existsSync(x.file))) for (const p of removeRecordings(recordings.filter(r => r.start + r.durationSec * 1000 >= show.start))) console.log(`録画を消しました（切り抜き・ショートは作成済み）: ${p.split('/').pop()}`);
    }
    const mine = queue.data.items.filter(x => x.id.startsWith(`${show.sessionId}-`) && existsSync(x.file));
    if (!cs.upload) { writeFileSync(join(dir, '投稿メモ.txt'), uploadNote(mine)); console.log(`投稿用: ${dir}（${mine.length}本、タイトルと説明は 投稿メモ.txt）`); }
    const upload = cs.upload && !flag('no-upload');
    status({ state: upload ? 'uploading' : 'idle', step: null });
    const done = upload ? await uploadQueue(queue) : [];
    status({ state: 'idle', sessionId: show.sessionId, made: { clips: clips.length, shorts: shorts.length }, uploaded: done.filter(d => d.videoId).length, pending: queue.pending().length });
} catch (e) {
    console.error(e.message);
    status({ state: 'failed', error: String(e.message).slice(0, 300) });
    process.exitCode = 1;
}
process.exit();
