// Operator-run: create a reserved YouTube broadcast bound to OBS's stream key.
//   npm run youtube:schedule -- --title "..." --start 2026-10-06T19:00:00+09:00 [--description "..."] [--privacy public|unlisted|private]
// Uses data/youtube-schedule-oauth.json (npm run youtube:auth -- --schedule). Never starts the stream; prints only the new URL.
import { existsSync, readFileSync } from 'node:fs';
import { config, loadEnv } from '../src/config.mjs';
import { OBS } from '../src/obs.mjs';
import { accessToken, scheduleBroadcast, scheduleRequest } from '../src/youtube-schedule.mjs';
loadEnv();
const c = config(process.env, ['node', 'x']);
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
try {
    const request = scheduleRequest({ title: arg('title'), description: arg('description') ?? '', start: arg('start'), privacy: arg('privacy') ?? 'public' });
    const file = `${c.dataDir}/youtube-schedule-oauth.json`;
    const refreshToken = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).refresh_token : '';
    const token = await accessToken({ clientId: c.youtubeClient, clientSecret: c.youtubeSecret, refreshToken });
    // OBS's own key picks the stream when the channel has several; OBS being off only matters then.
    let streamKey = '';
    try {
        const obs = new OBS(c); await obs.connect();
        streamKey = (await obs.call('GetStreamServiceSettings'))?.streamServiceSettings?.key || '';
        obs.close?.();
    } catch { streamKey = ''; }
    const made = await scheduleBroadcast(request, { token, streamKey });
    console.log(`予約枠を作成しました: ${made.url}`);
    console.log(`開始予定: ${new Date(request.start).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} / 公開範囲: ${request.privacy}${made.streamTitle ? ` / 配信キー: ${made.streamTitle}` : ''}`);
} catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
process.exit();
