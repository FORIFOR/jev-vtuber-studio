#!/usr/bin/env node
/**
 * Live audio renderer & player for local rehearsal and live shows.
 * Connects as an official stage renderer, fetches WAV, plays via afplay (Mac) or speaker,
 * and sends started/ended acknowledgments to drive the talk engine progression.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from '../src/config.mjs';

// Tokens come from the environment or .env (never hard-coded; never printed).
loadEnv();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '', VIEW_TOKEN = process.env.VIEW_TOKEN || '';
if (ADMIN_TOKEN.length < 24 || VIEW_TOKEN.length < 24) { console.error('Set ADMIN_TOKEN and VIEW_TOKEN in .env or the environment.'); process.exit(1); }
const BASE = `http://127.0.0.1:${process.env.PORT || 8787}`;

const client = 'local-live-player-' + Date.now();
let lease = null;
let running = true;

async function api(path, body = {}, token = ADMIN_TOKEN) {
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
}

async function claim() {
    try {
        const r = await api('/api/renderer/claim', { client, rendererKey: '' }, VIEW_TOKEN);
        if (r.acquired) {
            lease = r.lease;
        }
    } catch (e) {
        // Retry silently
    }
}

async function ack(id, event) {
    if (!lease) return false;
    try {
        const r = await api('/api/renderer/ack', { lease, id, event }, VIEW_TOKEN);
        return r.ok === true;
    } catch {
        return false;
    }
}

function playWav(buffer) {
    return new Promise(resolve => {
        const tmpPath = join(tmpdir(), `live_speech_${Date.now()}.wav`);
        writeFileSync(tmpPath, buffer);
        const proc = spawn('afplay', [tmpPath]);
        proc.on('close', () => {
            try { unlinkSync(tmpPath); } catch {}
            resolve();
        });
        proc.on('error', () => {
            try { unlinkSync(tmpPath); } catch {}
            resolve();
        });
    });
}

(async () => {
    console.log('=== Jev VTuber Studio: ローカル・ライブプレイヤー ===');
    console.log('1. レンダラー権限（Lease）を取得中...');
    await claim();
    const claimTimer = setInterval(claim, 2000);

    // Start show if not running
    const sessionRes = await fetch(`${BASE}/api/session`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    const sessionData = await sessionRes.json();
    if (!sessionData.status?.running) {
        console.log('2. 配信を開始します（/api/control start）...');
        await api('/api/control', { action: 'start' });
        console.log('   -> 配信が開始されました！');
    } else {
        console.log('2. 配信は既に稼働中です。');
    }

    // Connect to SSE
    console.log('3. イベントストリーム（SSE）に接続中...');
    const sseRes = await fetch(`${BASE}/events?token=${encodeURIComponent(VIEW_TOKEN)}`);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let commentInjected = false;

    process.on('SIGINT', async () => {
        console.log('\n停止中...');
        running = false;
        clearInterval(claimTimer);
        if (lease) await api('/api/renderer/release', { lease }, VIEW_TOKEN).catch(() => {});
        process.exit(0);
    });

    while (running) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
                const event = JSON.parse(line.slice(6));
                const d = event.data;

                if (event.type === 'game') {
                    const statusStr = d.paused ? '【一時停止中 (相談対応)】' : '【通常進行】';
                    console.log(`[GAME] 星集めパズル: スコア ${d.score}点 | 残り ${d.distance}手 | ${statusStr}`);
                }

                if (event.type === 'speech') {
                    const role = d.role === 'comment' ? '🎙️ [VOICEVOX 読上げ]' : '👧 [ホスト]';
                    console.log(`\n--------------------------------------------------`);
                    console.log(`${role}: 「${d.text}」`);
                    console.log(`--------------------------------------------------`);

                    await ack(d.id, 'started');

                    if (d.audio) {
                        try {
                            const audioRes = await fetch(`${BASE}${d.audio}?token=${encodeURIComponent(VIEW_TOKEN)}`);
                            const audioBytes = Buffer.from(await audioRes.arrayBuffer());
                            await playWav(audioBytes);
                        } catch (e) {
                            console.error('再生エラー:', e.message);
                        }
                    } else {
                        // Demo timer wait
                        await new Promise(r => setTimeout(r, Math.min(4000, d.durationMs || 3000)));
                    }

                    await ack(d.id, 'ended');
                    console.log(`   -> 再生完了 (Ack: ended)`);

                    // After first speech, inject a demo viewer consultation comment if not yet done
                    if (!commentInjected && d.role !== 'comment') {
                        commentInjected = true;
                        setTimeout(async () => {
                            console.log('\n💬 [リスナーからの相談コメントを投入します]');
                            try {
                                await api('/api/chat', {
                                    text: '転職したいけど新しい環境が不安です。どう考えたらいいですか？'
                                });
                                console.log('   -> コメントを投入しました！ゲームが一時停止し、読上げと返答が始まります。');
                            } catch (err) {
                                console.error('コメント投入失敗:', err.message);
                            }
                        }, 3000);
                    }
                }
            } catch (err) {
                // Ignore parse errors
            }
        }
    }
})();
