// Same-sentence blind A/B of the local host-voice engines. Loopback engines only, a no-op counting ledger,
// never Jev or the LLM. Writes audio, a blind key, a rating sheet and a script-free listening page; the
// `summarize` step un-blinds the filled sheet and applies PICK_RULE. The operator makes the final choice.
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { ROOT, config, loadEnv } from '../src/config.mjs';
import { PROVIDERS, CLOUD, ENGINE_INFO } from '../src/tts-adapters.mjs';
import { ReactionAudioCache } from '../src/reaction-audio.mjs';
import { loadSentences, loadScenario, renderConsistency, consistencyCSV, mulberry32, blindKey, openEngine, runSentence, sheetCSV, parseCSV, listeningHTML, score, findPid, sampleProcess, sampleGpu, providerURL, isLoopback, PICK_RULE, LICENCE_NOTES, LABELS } from '../src/voice-bench.mjs';

const CONFIRM = 'Explicit --confirm-local is required; no request was made.';
const SENTENCES = join(ROOT, 'config', 'voice-benchmark.json');
const USAGE = `npm run voice:bench -- --confirm-local [--providers=voicevox,aivisspeech,sbv2,supertonic,gemini-tts,gemini-lite-tts] [--allow-cloud] [--runs=1..5] [--directed] [--pid=aivisspeech:1234,...] [--gpu=nvidia] [--seed=N]
npm run voice:bench -- summarize --dir=<run dir>`;
const flag = (args, name) => { const a = args.find(x => x === `--${name}` || x.startsWith(`--${name}=`)); return a == null ? null : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const fail = m => { throw new Error(m); };
function writePrivate(path, data) { writeFileSync(path, data, { mode: 0o600 }); chmodSync(path, 0o600); }
function mkdirPrivate(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
const portOf = url => { try { const u = new URL(url); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch { return null; } };

export async function bench(args, { c, fetchFn = fetch, log = console.log, execFn, now = () => performance.now(), outRoot = join(c.dataDir, 'voice-bench') } = {}) {
    // Paid cloud engines only when named explicitly AND --allow-cloud is given; the default run is local only.
    const providers = flag(args, 'providers') ? String(flag(args, 'providers')).split(',').map(s => s.trim()).filter(Boolean) : PROVIDERS.filter(p => !CLOUD.includes(p));
    if (!providers.length || providers.some(p => !PROVIDERS.includes(p)) || new Set(providers).size !== providers.length) fail('Invalid --providers');
    const runs = Number(flag(args, 'runs') ?? 2), seed = Number(flag(args, 'seed') ?? Date.now() % 2147483647), directed = flag(args, 'directed') === true;
    if (!Number.isInteger(runs) || runs < 1 || runs > 5) fail('runs must be 1..5');
    if (!Number.isSafeInteger(seed)) fail('Invalid --seed');
    const cloud = providers.filter(p => CLOUD.includes(p)), remote = providers.filter(p => !CLOUD.includes(p) && !isLoopback(providerURL(c, p)));
    if (remote.length) fail(`Refused: engine URL is not loopback for ${remote.join(',')}`);
    if (cloud.length && flag(args, 'allow-cloud') !== true) fail(`Refused: ${cloud.join(',')} is a paid cloud engine; add --allow-cloud (see the cost estimate in docs/VOICE.md)`);
    const pids = Object.fromEntries(String(flag(args, 'pid') || '').split(',').filter(Boolean).map(x => { const [p, n] = x.split(':'); if (!PROVIDERS.includes(p) || !/^\d{1,9}$/.test(n ?? '')) fail('Invalid --pid'); return [p, Number(n)]; }));
    const gpu = flag(args, 'gpu');
    if (gpu != null && gpu !== 'nvidia') fail('Only --gpu=nvidia is supported');
    const sentences = loadSentences(SENTENCES), exec = execFn ? [execFn] : [];
    if (cloud.length) {
        // Rough upper estimate before any request: ~0.2 s of speech per character, 25 audio tokens per second.
        const sec = sentences.reduce((n, s) => n + s.text.length * .2, 0) * runs * (directed ? 2 : 1) + 60;
        for (const p of cloud) log(`${p}: estimated at most $${(sec * 25 * ENGINE_INFO[p].usdPerMAudio / 1e6 * 1.2).toFixed(3)} for this run (list price through 2026-12-31)`);
    }
    const sampler = pid => { const p = pid ? sampleProcess(pid, ...exec) : null, g = gpu ? sampleGpu(...exec) : null; return p || g ? { ...(p || {}), ...(g ? { gpu: g } : {}) } : null; };
    // Warm-up and identity per variant first, sequentially; offline engines are skipped, never thrown.
    const engines = [], skipped = [];
    for (const provider of providers) for (const d of directed ? [false, true] : [false]) {
        const e = await openEngine({ c, provider, directed: d, fetchFn, now });
        if (e.skipped) { skipped.push({ variant: e.variant, provider, directed: d, skipped: e.skipped, code: e.code }); log(`${e.variant}: skipped (${e.skipped}, ${e.code})`); }
        else { e.pid = CLOUD.includes(provider) ? null : pids[provider] ?? findPid(portOf(providerURL(c, provider)), ...exec); engines.push(e); log(`${e.variant}: ready, cold start ${e.coldStartMs} ms`); }
    }
    if (!engines.length) fail('No engine answered; nothing was measured.');
    const variants = engines.map(e => e.variant), key = blindKey(sentences.map(s => s.id), variants, seed);
    const labelOf = (sid, v) => Object.entries(key[sid]).find(([, x]) => x === v)[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'), dir = join(outRoot, stamp);
    mkdirPrivate(dir);
    const rows = [];
    for (const [i, s] of sentences.entries()) {
        // Sequential engines; the order rotates per sentence so no engine always runs first (thermal / cache bias).
        const order = engines.map((_, k) => engines[(k + i) % engines.length]);
        for (const e of order) for (let r = 1; r <= runs; r++) {
            const row = await runSentence(e, s, r, { sampler: e.pid || gpu ? sampler : null, pid: e.pid, now });
            if (row.wav) { const ad = join(dir, 'audio', s.id); mkdirPrivate(join(dir, 'audio')); mkdirPrivate(ad); writePrivate(join(ad, `${labelOf(s.id, e.variant)}-r${r}.wav`), row.wav); }
            const { wav, ...rest } = row; rows.push(rest);
            if (row.error) log(`${s.id} ${e.variant} r${r}: ${row.error}`);
        }
        log(`${s.id} done (${i + 1}/${sentences.length})`);
    }
    // Voice Consistency Test: one continuous take per engine with the operator's clips and phrase takes of that voice.
    const library = new ReactionAudioCache(join(c.dataDir, 'voice')); library.reload();
    const lines = loadScenario(SENTENCES), rand = mulberry32(seed ^ 0x5eed), providersRun = [...new Set(engines.map(e => e.provider))];
    const labels = LABELS.slice(0, providersRun.length);
    for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; }
    const consistencyKey = {}, coverage = {};
    mkdirPrivate(join(dir, 'consistency'));
    for (const [i, provider] of providersRun.entries()) {
        try {
            const r = await renderConsistency({ c, provider, library, lines, fetchFn });
            writePrivate(join(dir, 'consistency', `${labels[i]}.wav`), r.wav); consistencyKey[labels[i]] = provider; coverage[provider] = r.used;
            if (!r.used.clips.length || !r.used.phraseParts) log(`${provider}: consistency take has ${r.used.clips.length} reaction sound(s) and ${r.used.phraseParts} cached phrase part(s); fill data/voice (npm run voice:library) for a complete test`);
        } catch (e) { coverage[provider] = { error: typeof e?.code === 'string' ? e.code : 'TTS_ENGINE_DOWN' }; log(`${provider}: consistency take failed (${coverage[provider].error})`); }
    }
    writePrivate(join(dir, 'consistency.csv'), consistencyCSV(Object.keys(consistencyKey).sort()));
    for (const e of engines) { const cost = e.voice.router.adapter().cost?.(); if (cost) log(`${e.variant}: ${cost.requests} requests, ${cost.audioSec} s audio, about $${cost.usd} (${cost.basis})`); }
    const cpus = os.cpus();
    const environment = { node: process.version, os: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: cpus[0]?.model ?? null, cores: cpus.length, memoryGb: Math.round(os.totalmem() / 1073741824),
        providers: Object.fromEntries(engines.map(e => [e.provider, e.version ?? null])) };
    writePrivate(join(dir, 'key.json'), JSON.stringify({ seed, key, consistency: consistencyKey }, null, 2) + '\n');
    writePrivate(join(dir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), environment, runs, directed, pickRule: PICK_RULE, variants, skipped, rows, consistencyCoverage: coverage }, null, 2) + '\n');
    writePrivate(join(dir, 'sheet.csv'), sheetCSV(key, sentences, runs));
    writePrivate(join(dir, 'listening.html'), listeningHTML(sentences, key, Object.keys(consistencyKey).sort()));
    log(`written: ${dir}`);
    log('next: open listening.html, fill sheet.csv and consistency.csv without looking at key.json, then run: npm run voice:bench -- summarize --dir=<run dir>');
    return { dir, rows, skipped, key };
}
export function summarize(dir, { log = console.log } = {}) {
    const d = resolve(dir), read = f => readFileSync(join(d, f), 'utf8');
    const { key, consistency: consistencyKey = null } = JSON.parse(read('key.json')), results = JSON.parse(read('results.json')), ratings = parseCSV(read('sheet.csv'));
    let consistency = null;
    if (consistencyKey) try { consistency = parseCSV(read('consistency.csv')); } catch { consistency = []; }
    const s = score({ ratings, key, results: [...(results.rows || []), ...(results.skipped || [])], consistency, consistencyKey: consistencyKey || {} });
    writePrivate(join(d, 'summary.json'), JSON.stringify(s, null, 2) + '\n');
    const f = x => x == null ? '-' : String(x);
    log(['variant', '2h yes', 'breaks', 'mos', 'ci95', 'accent/100', 'ttfa p95', 'rtf p95', 'cpu max', 'rss MB', 'errors', 'cold ms', 'excluded'].join('\t'));
    for (const [v, x] of Object.entries(s.variants)) log([v, f(x.twoHoursYes), f(x.identityBreaks), f(x.overall), f(x.ci95), f(x.accentErrorsPer100Chars), f(x.ttfa.p95), f(x.rtf.p95), f(x.cpu?.max), f(x.rssMb), x.errors, f(x.coldStartMs), f(x.excluded)].join('\t'));
    log(s.pick ? `pick: ${s.pick.variant} (${s.pick.reason})` : 'pick: none passes PICK_RULE');
    log('The pick is a recommendation. Set REPLY_TTS_PROVIDER yourself and re-rehearse. Licence / credit duties (not scored):');
    for (const p of new Set(Object.keys(s.variants).map(v => v.split('+')[0]))) if (LICENCE_NOTES[p]) log(`  ${LICENCE_NOTES[p]}`);
    return s;
}
export async function main(args = process.argv.slice(2), opts = {}) {
    const log = opts.log || console.log;
    try {
        if (args.includes('--help')) { log(USAGE); return 0; }
        if (args[0] === 'summarize') { const dir = flag(args, 'dir'); if (typeof dir !== 'string' || !dir) fail('--dir=<run dir> is required'); summarize(dir, { log }); return 0; }
        if (flag(args, 'confirm-local') !== true) { log(CONFIRM); return 1; }
        let c = opts.c;
        if (!c) { loadEnv(); c = config(); }
        await bench(args, { ...opts, c, log });
        return 0;
    } catch (e) { log(`voice-bench: ${e?.message ?? 'failed'}`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
