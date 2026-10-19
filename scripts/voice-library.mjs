// Operator voice library: prerender allowlisted phrases with the ONE configured local engine, import wordless
// clips and exact-text recorded phrases, verify, list and remove. Never calls Jev or the LLM; prints counts,
// reason codes and paths only, never settings or secrets.
import { readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, loadEnv } from '../src/config.mjs';
import { Ledger } from '../src/store.mjs';
import { VoiceQualityRouter } from '../src/voice-router.mjs';
import { chunkDeliveryFor } from '../src/speech-director.mjs';
import { INTENSITIES, PACES } from '../public/voice-acting.mjs';
import { JEV_REACTIONS } from '../public/avatar-rig.mjs';
import { ReactionAudioCache, loadPhraseAllowlist, normalizePhrase, addClip, addPhrase, removeEntry, NONVERBAL_CLASSES, LIBRARY_LIMITS } from '../src/reaction-audio.mjs';
import { readWav, writeWav, resample, trimSilence, levels, gain } from '../src/wav.mjs';
import { providerURL, isLoopback } from '../src/voice-bench.mjs';
import { CLOUD } from '../src/tts-adapters.mjs';

const CONFIRM = 'Explicit --confirm-local is required; no request was made.';
const NEXT = 'Studioで設定→実試聴し、表現リールを最後まで聴いてください';
const QC = { minActiveDb: -45, maxClipped: .001, minMs: LIBRARY_LIMITS.phraseMinMs, maxMs: LIBRARY_LIMITS.phraseMaxMs, msPerCharMin: LIBRARY_LIMITS.msPerCharMin, msPerCharMax: LIBRARY_LIMITS.msPerCharMax };
const USAGE = `Usage: npm run voice:library -- <command>
  prerender --confirm-local [--allow-cloud] [--takes=1..5] [--presets=a,b] [--intensities=low,mid,high] [--paces=slow,normal,fast] [--only=<text>] [--force] [--dry-run]
  import-clip --class=<${NONVERBAL_CLASSES.join('|')}> --file=<wav> --attest-nonverbal [--gain-db=N]
  import-phrase --text=<allowlisted> --preset=<preset> --file=<wav> --attest-exact-text [--intensity=low|mid|high] [--pace=slow|normal|fast]
  verify | list | remove --id=<id>`;
const fail = (m, code) => { throw Object.assign(new Error(m), code ? { code } : {}); };
const reasonOf = e => e?.reason || e?.code || e?.message || 'failed';

export function parseArgs(argv) {
    const flags = {}, rest = [];
    for (const a of argv) {
        const m = /^--([a-z0-9-]+)(?:=(.*))?$/s.exec(a);
        if (m) flags[m[1]] = m[2] ?? true; else rest.push(a);
    }
    return { cmd: rest[0] ?? null, flags };
}
const list = (v, allowed, name) => {
    if (v == null || v === true) return null;
    const xs = String(v).split(',').map(s => s.trim()).filter(Boolean);
    if (!xs.length || xs.some(x => !allowed.includes(x))) fail(`Invalid --${name}`);
    return [...new Set(xs)];
};
/** Adapters only: a live clone of the saved config, so the router can resolve the configured engine. */
export function loadConfig(env = null) {
    if (!env) loadEnv();
    const c = env ? config(env, []) : config();
    return { ...c, mode: 'live' };
}
export const libraryDir = c => join(c.dataDir, 'voice');

/** The same exported functions live rendering uses: chunkDeliveryFor → router.renderKey (render-key parity). */
export function phraseKeys(c, text, presets, { intensities = null, paces = null, router = null } = {}) {
    const r = router || new VoiceQualityRouter(c, { ledger: { reserve() { fail('No reservation for keys'); } }, fetchFn: () => fail('No network for keys') });
    const out = [], seen = new Set();
    for (const preset of presets) for (const intensity of intensities || [null]) for (const pace of paces || [null]) {
        const delivery = chunkDeliveryFor(text, preset, { intensity, pace }), renderKey = r.renderKey(delivery);
        if (seen.has(renderKey)) continue;
        seen.add(renderKey); out.push({ preset, delivery, renderKey });
    }
    return out;
}
function localOnly(c, allowCloud = false) {
    // Paid cloud voices (Gemini TTS) only with an explicit --allow-cloud; takes are then billed like any render.
    if (CLOUD.includes(c.replyTtsProvider)) { if (!allowCloud) fail('The active voice is a paid cloud engine; add --allow-cloud to prerender with it.', 'CLOUD_NOT_ALLOWED'); return; }
    const url = providerURL(c, c.replyTtsProvider);
    if (!url || !isLoopback(url)) fail('The active voice engine URL must be loopback (127.0.0.1, localhost or ::1).', 'NOT_LOOPBACK');
}
/** Trim and quality-check one engine take. Returns { bytes } or { reason }. */
export function conditionTake(raw, norm) {
    let w;
    try { w = readWav(raw); } catch { return { reason: 'decode_failed' }; }
    const pcm = trimSilence(w.samples, w.rate, { keepMs: 30 }), ms = pcm.length * 1000 / w.rate, l = levels(pcm, w.rate), per = ms / Math.max(1, norm.length);
    if (!(l.activeDb > QC.minActiveDb)) return { reason: 'silent' };
    if (!(l.clipped < QC.maxClipped)) return { reason: 'clipped' };
    if (!(ms >= QC.minMs && ms <= QC.maxMs)) return { reason: 'bad_duration' };
    if (!(per >= QC.msPerCharMin && per <= QC.msPerCharMax)) return { reason: 'bad_rate_per_char' };
    return { bytes: writeWav(pcm, w.rate), ms: Math.round(ms) };
}

export async function prerender(c, { takes = null, presets = null, intensities = null, paces = null, only = null, force = false, dryRun = false, allowCloud = false, fetchFn = fetch, log = console.log, signal } = {}) {
    localOnly(c, allowCloud);
    const dir = libraryDir(c), router = new VoiceQualityRouter(c, { ledger: { reserve() { fail('Unexpected reservation'); } }, fetchFn }), a = router.adapter();
    const { map, errors } = loadPhraseAllowlist(dir);
    for (const e of errors) log(`allowlist: ${e.file} ${e.reason}`);
    const lib = new ReactionAudioCache(dir); lib.reload();
    const id16 = a.identity16(), plan = [], seen = new Set();
    const onlyNorm = only == null ? null : normalizePhrase(only);
    if (onlyNorm != null && !map.has(onlyNorm)) fail('--only text is not allowlisted', 'NOT_ALLOWLISTED');
    let skipped = 0;
    for (const [norm, entry] of map) {
        if (onlyNorm != null && norm !== onlyNorm) continue;
        const allowed = presets ? entry.presets.filter(p => presets.includes(p)) : entry.presets;
        for (const k of phraseKeys(c, entry.text, allowed, { intensities, paces, router })) {
            const id = `${k.renderKey}|${norm}`;
            if (seen.has(id)) continue;
            seen.add(id);
            if (!force && lib.hasPhrase(id16, entry.text, k.renderKey)) { skipped++; continue; }
            plan.push({ text: entry.text, norm, ...k });
        }
    }
    const n = a.id === 'voicevox' ? 1 : Math.max(1, Math.min(5, takes ?? 3)), calls = plan.length * n;
    log(`engine: ${a.id}; phrases planned: ${plan.length}; already present: ${skipped}; takes each: ${n}; planned synthesis calls: ${calls}`);
    if (dryRun || !plan.length) return { planned: plan.length, calls, skipped, written: 0, failed: 0, dryRun };
    await a.health(signal);
    const ledger = new Ledger(c.dataDir, c.limits), quality = a.id === 'supertonic' ? { steps: 32 } : null;
    let written = 0, failed = 0;
    for (const p of plan) for (let t = 1; t <= n; t++) {
        if (signal?.aborted) throw signal.reason;
        const tag = `${p.preset}/${p.delivery.intensity}/${p.delivery.pace} take ${t}`;
        try {
            ledger.reserve('tts');
            const raw = await a.synthesize(p.text, a.resolve(p.delivery), signal, { quality });
            const x = conditionTake(raw, p.norm);
            if (!x.bytes) { failed++; log(`QC failed (${x.reason}): ${tag}`); continue; } // Reported, never retried in a loop.
            addPhrase(dir, { identity16: id16, engine: a.id, text: p.text, renderKey: p.renderKey, preset: p.preset, source: 'tts', bytes: x.bytes });
            written++;
        } catch (e) {
            if (signal?.aborted) throw signal.reason;
            failed++; log(`failed (${reasonOf(e)}): ${tag}`);
            if (/limit reached/.test(e?.message)) break;
        }
    }
    log(`written: ${written}; failed: ${failed}; library: ${dir}`);
    log(`next: ${NEXT}`);
    return { planned: plan.length, calls, skipped, written, failed, dryRun: false };
}

function readInput(file) {
    if (typeof file !== 'string' || !file) fail('--file is required');
    const p = resolve(file), st = lstatSync(p);
    if (!st.isFile()) fail('--file must be a regular file');
    if (st.size > 20000000) fail('--file is too large');
    return readFileSync(p);
}
const peakNormalize = (pcm, db = -3) => { let peak = 0; for (const x of pcm) peak = Math.max(peak, Math.abs(x)); return peak > 0 ? gain(pcm, db - 20 * Math.log10(peak)) : pcm; };
const nativeRate = w => w.rate >= 16000 && w.rate <= 48000 ? { pcm: w.samples, rate: w.rate } : { pcm: resample(w.samples, w.rate, 44100), rate: 44100 };

export function importClip(dir, { cls, file, attest = false, gainDb = 0 } = {}) {
    if (attest !== true) fail('Explicit --attest-nonverbal is required: clips must contain no words.', 'NOT_ATTESTED');
    if (!NONVERBAL_CLASSES.includes(cls)) fail('Unknown clip class', 'unknown_class');
    let w;
    try { w = readWav(readInput(file), { extensible: true }); } catch (e) { fail(e?.message?.startsWith('--file') ? e.message : 'Unreadable WAV', 'decode_failed'); }
    const { pcm, rate } = nativeRate(w), bytes = writeWav(peakNormalize(trimSilence(pcm, rate)), rate);
    return addClip(dir, { cls, bytes, gainDb, attest: 'nonverbal' });
}
export function importPhrase(c, dir, { text, preset, file, attest = false, intensity = null, pace = null } = {}) {
    if (attest !== true) fail('Explicit --attest-exact-text is required: the recording must say exactly the allowlisted text.', 'NOT_ATTESTED');
    const { map } = loadPhraseAllowlist(dir), entry = map.get(normalizePhrase(String(text ?? '')));
    if (!entry) fail('Text is not allowlisted', 'not_allowlisted');
    if (!entry.presets.includes(preset)) fail('Preset is not allowed for this phrase', 'bad_preset');
    const router = new VoiceQualityRouter(c, { ledger: { reserve() { fail('No reservation'); } }, fetchFn: () => fail('No network') }), a = router.adapter();
    const [k] = phraseKeys(c, entry.text, [preset], { intensities: intensity ? [intensity] : null, paces: pace ? [pace] : null, router });
    let w;
    try { w = readWav(readInput(file), { extensible: true }); } catch (e) { fail(e?.message?.startsWith('--file') ? e.message : 'Unreadable WAV', 'decode_failed'); }
    const { pcm, rate } = nativeRate(w), bytes = writeWav(trimSilence(pcm, rate, { keepMs: 30 }), rate);
    return addPhrase(dir, { identity16: a.identity16(), engine: a.id, text: entry.text, renderKey: k.renderKey, preset, source: 'recorded', attest: 'exact-text', bytes });
}

const printStatus = (s, log) => {
    const clips = Object.entries(s.clips), ids = Object.entries(s.phrases);
    log(`clips: ${clips.length ? clips.map(([k, n]) => `${k}=${n}`).join(' ') : 'none'}`);
    log(`phrases: ${ids.length ? ids.map(([k, n]) => `${k}=${n}`).join(' ') : 'none'}`);
    log(`errors: ${s.errors.length}${s.hash8 ? `; hash8: ${s.hash8}` : ''}`);
    for (const e of s.errors) log(`  ${e.file}: ${e.reason}`);
};
/** Exit code. `env` is for tests; the CLI loads .env and saved settings exactly like the server. */
export async function main(argv = process.argv.slice(2), { env = null, fetchFn = fetch, log = console.log, signal } = {}) {
    const { cmd, flags } = parseArgs(argv);
    try {
        if (!cmd || flags.help) { log(USAGE); return cmd ? 0 : 1; }
        if (cmd === 'prerender' && flags['confirm-local'] !== true) { log(CONFIRM); return 1; }
        const c = loadConfig(env), dir = libraryDir(c);
        if (cmd === 'prerender') {
            const takes = flags.takes == null ? null : Number(flags.takes);
            if (takes != null && !(Number.isInteger(takes) && takes >= 1 && takes <= 5)) fail('Invalid --takes (1..5)');
            const r = await prerender(c, { takes, presets: list(flags.presets, Object.keys(JEV_REACTIONS), 'presets'), intensities: list(flags.intensities, INTENSITIES, 'intensities'), paces: list(flags.paces, PACES, 'paces'),
                only: typeof flags.only === 'string' ? flags.only : null, force: flags.force === true, dryRun: flags['dry-run'] === true, allowCloud: flags['allow-cloud'] === true, fetchFn, log, signal });
            return r.dryRun || !r.failed ? 0 : 1;
        }
        if (cmd === 'import-clip') {
            const gainDb = flags['gain-db'] == null ? 0 : Number(flags['gain-db']);
            const e = importClip(dir, { cls: flags.class, file: flags.file, attest: flags['attest-nonverbal'] === true, gainDb });
            log(`clip added: ${e.id} (${e.cls}); library: ${dir}`); log(`next: ${NEXT}`);
            return 0;
        }
        if (cmd === 'import-phrase') {
            const e = importPhrase(c, dir, { text: flags.text, preset: flags.preset, file: flags.file, attest: flags['attest-exact-text'] === true,
                intensity: list(flags.intensity, INTENSITIES, 'intensity')?.[0] ?? null, pace: list(flags.pace, PACES, 'pace')?.[0] ?? null });
            log(`phrase added: ${e.id} (${e.preset}, recorded); library: ${dir}`); log(`next: ${NEXT}`);
            return 0;
        }
        if (cmd === 'verify' || cmd === 'list') {
            const s = new ReactionAudioCache(dir).reload();
            printStatus(s, log);
            return cmd === 'verify' && s.errors.length ? 1 : 0;
        }
        if (cmd === 'remove') {
            const ok = removeEntry(dir, typeof flags.id === 'string' ? flags.id : '');
            log(ok ? `removed: ${flags.id}` : 'not found');
            return ok ? 0 : 1;
        }
        log(USAGE);
        return 1;
    } catch (e) {
        log(`voice-library: ${e?.reason ? `rejected (${e.reason})` : `${e?.message ?? 'failed'}${e?.code ? ` [${e.code}]` : ''}`}`);
        return 1;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort(new Error('Interrupted')));
    process.exitCode = await main(process.argv.slice(2), { signal: ac.signal });
}
