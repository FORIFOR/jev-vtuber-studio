import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSpeech, readRuns, moments, planDigest, planShorts, chapters, metadata, shortArgs, sectionArgs, uploadVideo } from '../src/post-stream.mjs';

const T0 = Date.parse('2026-10-06T10:00:00Z'), at = s => new Date(T0 + s * 1000).toISOString();
const line = (s, text, kind = 'game_reaction', reaction = 'neutral') => JSON.stringify({ type: 'speech', kind, text, audioMs: 2000, verdict: { reaction }, at: at(s) });

function fixture(t) {
    const runs = mkdtempSync(join(tmpdir(), 'jvs-post-')); t.after(() => rmSync(runs, { recursive: true, force: true }));
    const run = (name, startS, seconds, level, character, outcome = 'death') => {
        mkdirSync(join(runs, name));
        writeFileSync(join(runs, name, 'metadata.json'), JSON.stringify({ started_at: at(startS) }));
        writeFileSync(join(runs, name, 'summary.json'), JSON.stringify({ duration_seconds: seconds, game_elapsed_seconds: seconds, final_player: { level }, actual_character: character, stage: 'TOWER', end_reason: outcome }));
    };
    run('vampire-a', 100, 1800, 70, 'DOMMARIO', 'clear'); run('vampire-b', 2000, 60, 4, 'CROCI'); run('vampire-c', 2200, 1500, 58, 'CROCI'); run('other', 100, 10, 1, 'X');
    const log = [line(5, 'こんばんは、ノアです。', 'opening'), JSON.stringify({ type: 'comment_read', at: at(6) })];
    for (let s = 120; s < 3700; s += 20) log.push(line(s, s % 200 === 0 ? 'うわ、ボスが来た！' : 'よし、進むよ。', 'game_reaction', s % 200 === 0 ? 'shock' : 'neutral'));
    return { runs, log: log.join('\n') };
}

test('post-stream: lines and runs come from the logs with wall-clock times; the digest fills the target in time order', t => {
    const { runs: dir, log } = fixture(t);
    const speech = readSpeech(log, { from: T0, to: T0 + 4000e3 });
    assert.equal(speech[0].start, T0 + 3000, 'a line started audioMs before it was logged');
    const runs = readRuns(dir, { from: T0, to: T0 + 4000e3 });
    assert.deepEqual(runs.map(r => r.name), ['vampire-a', 'vampire-b', 'vampire-c']);
    const ms = moments(speech, runs);
    assert.ok(ms.some(m => m.kind === 'run_end' && m.run === 'vampire-a'));
    assert.ok(!ms.some(m => m.run === 'vampire-b'), 'a 60 s run has no ending highlight');
    const cuts = planDigest(ms, runs, { target: 300, opening: { from: speech[0].start, to: speech[0].start + 50000 } });
    const total = cuts.reduce((n, c) => n + (c.to - c.from) / 1000, 0);
    assert.ok(total >= 300 && total < 400, String(total));
    assert.equal(cuts[0].label, 'オープニング');
    assert.ok(cuts.every((c, i) => !i || c.from >= cuts[i - 1].to), 'in order, no overlap');
    const ch = chapters(cuts);
    assert.match(ch[0], /^0:00 オープニング/); assert.ok(ch.some(c => /ドンマリオ・ガロの塔（最高Lv70）/.test(c)));
});

test('post-stream: Shorts never overlap, take at most two run endings, and their public text is template + said lines', t => {
    const { runs: dir, log } = fixture(t);
    const runs = readRuns(dir, { from: T0, to: T0 + 4000e3 }), ms = moments(readSpeech(log, { from: T0, to: T0 + 4000e3 }), runs);
    const shorts = planShorts(ms, runs, { count: 5 });
    assert.ok(shorts.length >= 3);
    assert.ok(shorts.filter(s => s.kind === 'run_end').length <= 2);
    for (const [i, a] of shorts.entries()) for (const b of shorts.slice(i + 1)) assert.ok(a.to + 60000 <= b.from || b.to + 60000 <= a.from);
    const meta = metadata({ videoId: 'WfgmYjPUdWk', showStart: T0, showEnd: T0 + 3 * 3600e3, runs, cuts: [], shorts });
    assert.ok(meta.digest.title.length <= 100 && /最高Lv70/.test(meta.digest.title));
    assert.ok(meta.shorts.every(s => s.title.length <= 100 && s.title.includes('#Shorts')));
    assert.ok(meta.shorts.some(s => /ドンマリオ、Lv70でクリア/.test(s.title)));
});

test('post-stream: ffmpeg/yt-dlp arguments re-frame to 9:16 and fetch only the needed stretch', () => {
    const a = shortArgs('in.mp4', 'out.mp4', 36);
    assert.match(a[a.indexOf('-filter_complex') + 1], /s=1080x1920/);
    const y = sectionArgs('WfgmYjPUdWk', 120, 156.5, 'o.mp4');
    assert.ok(y.includes('*120.0-156.5')); assert.equal(y.at(-1), 'https://www.youtube.com/watch?v=WfgmYjPUdWk');
});

test('post-stream: uploads are private unless scheduled, and a scheduled one stays private until publishAt', async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push({ url, init });
        if (url.includes('uploadType=resumable')) return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=x' } });
        return new Response(JSON.stringify({ id: 'abcdefghijk' }), { status: 200 });
    };
    const id = await uploadVideo({ token: 't', file: 'f', size: 3, title: 'T', description: 'D', publishAt: '2026-10-08T10:00:00Z', readStream: () => 'xyz' }, fetchFn);
    assert.equal(id, 'abcdefghijk');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.status.privacyStatus, 'private'); assert.equal(body.status.publishAt, '2026-10-08T10:00:00Z');
    await assert.rejects(uploadVideo({ token: 't', file: 'f', size: 1, title: 'T', description: '', readStream: () => '' }, async () => new Response('', { status: 200, headers: { location: 'https://evil.example/' } })), /no upload URL/);
});
