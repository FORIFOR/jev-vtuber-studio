// Operator-run, after a live show: a ~20-minute digest and Shorts from the YouTube archive (src/post-stream.mjs).
//   npm run post-stream -- --video VIDEO_ID [--plan-only] [--target 1200] [--shorts 5] [--offset 9]
//                          [--upload] [--schedule-shorts]
// Downloads only the needed stretches (yt-dlp), cuts and joins them (ffmpeg), writes data/post-stream/VIDEO_ID/.
// --upload sends the digest and Shorts as PRIVATE videos (--schedule-shorts: private with publish times, first Short
// 3 h after the digest, then one a day). Uses the youtube:schedule OAuth token. Never deletes or edits other videos.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadEnv } from '../src/config.mjs';
import { accessToken } from '../src/youtube-schedule.mjs';
import { readSpeech, readRuns, moments, planDigest, planShorts, metadata, cutArgs, shortArgs, sectionArgs, uploadVideo, clock } from '../src/post-stream.mjs';

loadEnv();
const c = config(process.env, ['node', 'x']);
const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = n => process.argv.includes(`--${n}`);
// googlevideo now and then refuses a section (HTTP 403 inside yt-dlp's ffmpeg); a fresh try usually works.
const fetchSection = async (...args) => {
    for (let i = 1; ; i++) {
        try { return await run('yt-dlp', sectionArgs(...args)); }
        catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 15000 * i)); }
    }
};
const run = (cmd, args) => new Promise((resolve, reject) => {
    const p = spawn('nice', ['-n', '10', cmd, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { if (err.length < 4000) err += d; });
    p.on('error', reject); p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`))));
});

try {
    const videoId = arg('video');
    if (!/^[\w-]{11}$/.test(videoId || '')) throw new Error('--video にライブ配信の動画 ID（11文字）を指定してください。');
    const file = `${c.dataDir}/youtube-schedule-oauth.json`;
    const token = await accessToken({ clientId: c.youtubeClient, clientSecret: c.youtubeSecret, refreshToken: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).refresh_token : '' });
    const auth = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) };
    // Right after a stream ends the API sometimes answers with no item; a few tries cover it.
    let v = null;
    for (let i = 0; i < 4 && !v; i++) {
        if (i) await new Promise(r => setTimeout(r, 3000));
        v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=${videoId}`, { ...auth, signal: AbortSignal.timeout(15000) })).json()).items?.[0] ?? null;
    }
    const showStart = Date.parse(v?.liveStreamingDetails?.actualStartTime), ended = Date.parse(v?.liveStreamingDetails?.actualEndTime);
    if (!Number.isFinite(showStart)) throw new Error('この動画にはライブ配信の開始時刻がありません。');
    if (!Number.isFinite(ended) && !flag('plan-only')) throw new Error('配信がまだ終わっていません（--plan-only なら途中までの計画だけ作れます）。');
    const showEnd = Number.isFinite(ended) ? ended : Date.now();
    // The archive runs behind the Studio's clock by the stream's latency (measured 9 s on 2026-10-06: a logged game over
    // at 7511 s of the archive is on screen at 7520 s).
    const offset = Number(arg('offset') ?? 9);
    const at = t => (t - showStart) / 1000 + offset;            // wall-clock ms -> seconds into the archive

    const speech = readSpeech(readFileSync(join(c.dataDir, 'show-log.jsonl'), 'utf8'), { from: showStart, to: showEnd });
    const runs = readRuns(arg('runs') || `${process.env.HOME}/Projects/jev-vampire-survivors/runs`, { from: showStart, to: showEnd });
    const ms = moments(speech, runs);
    const first = speech[0];                                    // the show's first line (later openings follow restarts)
    const cuts = planDigest(ms, runs, { target: Number(arg('target')) || 1200, opening: first ? { from: first.start - 3000, to: first.start + 50000 } : null })
        .map(x => ({ ...x, from: Math.max(x.from, showStart), to: Math.min(x.to, showEnd) })).filter(x => x.to - x.from >= 5000);
    const shorts = planShorts(ms, runs, { count: Number(arg('shorts')) || 5 }).filter(x => x.from >= showStart && x.to <= showEnd);
    const meta = metadata({ videoId, showStart, showEnd, runs, cuts, shorts });
    const dir = join(c.dataDir, 'post-stream', videoId);
    mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 });
    const plan = { videoId, showStart: new Date(showStart).toISOString(), showEnd: new Date(showEnd).toISOString(), offset, speechLines: speech.length, runs: runs.length,
        digest: cuts.map(x => ({ archive: `${clock(at(x.from))}-${clock(at(x.to))}`, seconds: Math.round((x.to - x.from) / 1000), label: x.label })),
        shorts: shorts.map((x, i) => ({ archive: `${clock(at(x.from))}-${clock(at(x.to))}`, kind: x.kind, text: x.text, title: meta.shorts[i].title })), meta };
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    const total = cuts.reduce((n, x) => n + (x.to - x.from) / 1000, 0);
    console.log(`計画: ダイジェスト ${cuts.length} カット / ${clock(total)}、Shorts ${shorts.length} 本 → ${join(dir, 'plan.json')}`);
    if (flag('plan-only')) process.exit();

    // Digest: each cut downloaded on its own, normalised, then joined without re-encoding.
    const parts = [];
    for (const [i, x] of cuts.entries()) {
        const raw = join(dir, 'raw', `cut-${i}.mp4`), norm = join(dir, 'raw', `cut-${i}-n.mp4`);
        if (!existsSync(norm)) {
            if (!existsSync(raw)) await fetchSection(videoId, at(x.from), at(x.to), raw);
            await run('ffmpeg', cutArgs(raw, norm, (x.to - x.from) / 1000));
        }
        parts.push(norm); console.log(`  カット ${i + 1}/${cuts.length} ${x.label}`);
    }
    writeFileSync(join(dir, 'raw', 'list.txt'), parts.map(p => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n'));
    const digest = join(dir, 'digest.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'raw', 'list.txt'), '-c', 'copy', '-movflags', '+faststart', digest]);
    console.log(`ダイジェスト: ${digest}`);
    const shortFiles = [];
    for (const [i, x] of shorts.entries()) {
        const raw = join(dir, 'raw', `short-${i}.mp4`), out = join(dir, `short-${i + 1}.mp4`);
        if (!existsSync(raw)) await fetchSection(videoId, at(x.from), at(x.to), raw);
        await run('ffmpeg', shortArgs(raw, out, (x.to - x.from) / 1000));
        shortFiles.push(out); console.log(`Short ${i + 1}: ${out}`);
    }
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));

    if (flag('upload')) {
        const send = (f, m, publishAt) => uploadVideo({ token, file: f, size: statSync(f).size, ...m, publishAt, readStream: p => createReadStream(p) });
        const id = await send(digest, meta.digest, null);
        console.log(`アップロード（非公開）: https://www.youtube.com/watch?v=${id}`);
        for (const [i, f] of shortFiles.entries()) {
            const publishAt = flag('schedule-shorts') ? new Date(Date.now() + 3 * 3600000 + i * 86400000).toISOString() : null;
            const sid = await send(f, meta.shorts[i], publishAt);
            console.log(`Short ${i + 1}（${publishAt ? `予約 ${new Date(publishAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` : '非公開'}）: https://www.youtube.com/shorts/${sid}`);
        }
    }
} catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
process.exit();
