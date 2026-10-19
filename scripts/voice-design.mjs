// Creates ONE original host voice with Gemini Voice Design (natural-language description, no real person's voice,
// no replication) and stores its id + preview WAV under data/voice-design/. Nothing is sent without --confirm; the
// voice is used only after --apply writes GEMINI_TTS_VOICE (which invalidates the rehearsal, as any voice change does).
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadEnv } from '../src/config.mjs';
import { saveSettings } from '../src/settings.mjs';
import { request } from '../src/util.mjs';

export const DEFAULT_DESCRIPTION = '若い成人女性のオリジナルのアニメキャラクターの声。明るく透明感があるが、甲高すぎない。自然な標準日本語で、普段は親しみやすく落ち着いて話す。ゲームでは少し負けず嫌いで、驚くと一瞬声が上ずり、褒められると照れて柔らかくなる。ナレーション調ではなく、目の前の相手と話す距離感。過剰な鼻声、常時の囁き、叫び続ける演技は避ける。';
const USAGE = 'npm run voice:design -- --confirm [--model=gemini-3.8-flash-tts] [--name=ノアの声] [--description=...] [--apply]';
const flag = (args, name) => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a == null ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };

export async function design(args, { c, fetchFn = fetch, log = console.log } = {}) {
    if (flag(args, 'confirm') !== true) { log('Explicit --confirm is required; no request was made.'); return 1; }
    if (!c.geminiKey) { log('GEMINI_API_KEY is not set.'); return 1; }
    const model = String(flag(args, 'model') || 'gemini-3.8-flash-tts');
    if (!['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'].includes(model)) { log('Invalid --model'); return 1; }
    const input = String(flag(args, 'description') || DEFAULT_DESCRIPTION), name = String(flag(args, 'name') || 'Jev host voice').slice(0, 60);
    if (input.length > 1000 || /[<>]/.test(input)) { log('Invalid --description'); return 1; }
    const r = await request('https://generativelanguage.googleapis.com/v1beta/voices', { headers: { 'x-goog-api-key': c.geminiKey }, timeout: 60000, fetchFn, max: 20000000,
        body: { store: true, voice: { model, type: 'prompted', display_name: name, gender: 'female', language_code: 'ja-JP', prompted: { input } } } });
    const id = r?.id ?? r?.voice?.id;
    if (typeof id !== 'string' || !/^voice_[A-Za-z0-9_-]{4,120}$/.test(id)) { log('Unexpected Voice Design response (no voice id).'); return 1; }
    const dir = join(c.dataDir, 'voice-design'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sample = r.sample_audio?.data ?? r.voice?.sample_audio?.data;
    if (typeof sample === 'string') { const p = join(dir, `${id}.wav`); writeFileSync(p, Buffer.from(sample, 'base64'), { mode: 0o600 }); chmodSync(p, 0o600); log(`preview: ${p}`); }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, model, name, description: input, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    log(`voice id: ${id}`);
    if (flag(args, 'apply') === true) { saveSettings(c, { values: { GEMINI_TTS_VOICE: id } }); log('GEMINI_TTS_VOICE saved. Re-run the rehearsal and listen before going live.'); }
    else log('Listen to the preview, then run again with --apply, or set GEMINI_TTS_VOICE yourself.');
    return 0;
}
export async function main(args = process.argv.slice(2), opts = {}) {
    const log = opts.log || console.log;
    try {
        if (args.includes('--help')) { log(USAGE); return 0; }
        let c = opts.c; if (!c) { loadEnv(); c = config(); }
        return await design(args, { ...opts, c, log });
    } catch (e) { log(`voice-design: ${e?.status ? `HTTP ${e.status}` : e?.message ?? 'failed'}`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
