import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main as libraryMain, loadConfig, phraseKeys } from '../scripts/voice-library.mjs';
import { CATEGORIES, PICK_RULE, validateSentences, validateScenario, loadSentences, blindKey, mulberry32, stats, audioStats, sheetCSV, parseCSV, listeningHTML, score, runEngine, renderConsistency, loadScenario, findPid, sampleProcess, sampleGpu, isLoopback } from '../src/voice-bench.mjs';
import { ReactionAudioCache, normalizePhrase, loadPhraseAllowlist, addClip } from '../src/reaction-audio.mjs';
import { VoiceQualityRouter } from '../src/voice-router.mjs';
import { SpeechDirector } from '../src/speech-director.mjs';
import { AIVIS_UUID, PROVIDERS } from '../src/tts-adapters.mjs';
import { ROOT } from '../src/config.mjs';
import { writeWav } from '../src/wav.mjs';
import { response } from './helpers.mjs';

const WIN = process.platform === 'win32';
const sine = (sec, hz = 440, rate = 24000, amp = .3) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const tone = (sec, hz = 440, rate = 24000, amp = .3) => writeWav(sine(sec, hz, rate, amp), rate);
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-scripts-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const env = (dir, patch = {}) => ({ DATA_DIR: dir, SHOW_PROFILE: 'playground', READ_COMMENTS: 'false', ADMIN_TOKEN: 'a'.repeat(48), VIEW_TOKEN: 'v'.repeat(48), VOICEVOX_URL: 'http://127.0.0.1:50021', ...patch });
function fixture(routes = {}) {
    const calls = [];
    const fetchFn = async (u, o = {}) => { const url = new URL(u); calls.push(url.pathname); const r = routes[url.pathname]; return r ? r(url, o) : new Response('missing', { status: 404 }); };
    return { calls, fetchFn };
}
const vvRoutes = (sec = .5) => ({ '/version': () => response('0.14.5'), '/audio_query': () => response({ speedScale: 1, intonationScale: 1, volumeScale: 1 }), '/synthesis': () => new Response(tone(sec)), '/initialize_speaker': () => new Response(null, { status: 204 }) });
const MANIFEST = { name: 'AivisSpeech Engine', uuid: AIVIS_UUID };
const aivisRoutes = (patch = {}) => ({ '/version': () => response('1.2.0'), '/engine_manifest': () => response(MANIFEST), '/audio_query': () => response({ speedScale: 1 }), '/synthesis': () => new Response(tone(.4, 440, 44100)), ...patch });
const forbidden = () => { throw new Error('Network forbidden'); };
const logger = () => { const lines = []; return { lines, log: s => lines.push(String(s)), text: () => lines.join('\n') }; };
function walk(dir, out = []) { for (const n of readdirSync(dir)) { const p = join(dir, n); out.push(p); if (statSync(p).isDirectory()) walk(p, out); } return out; }

test('prerender: VOICEVOX takes land as phrase entries the live router serves with 0 fetches (render-key parity)', async t => {
    const dir = temp(t), f = fixture(vvRoutes()), out = logger();
    assert.equal(await libraryMain(['prerender', '--confirm-local'], { env: env(dir), fetchFn: f.fetchFn, log: out.log }), 0, out.text());
    const vdir = join(dir, 'voice'), lib = new ReactionAudioCache(vdir), s = lib.reload();
    assert.deepEqual(s.errors, []);
    const total = Object.values(s.phrases).reduce((a, b) => a + b, 0), c = loadConfig(env(dir));
    const synth = f.calls.filter(p => p === '/synthesis').length;
    assert.ok(total > 0 && total === synth, `${total} entries from ${synth} syntheses`);
    assert.match(out.text(), /Studioで設定→実試聴し、表現リールを最後まで聴いてください/);
    assert.doesNotMatch(out.text(), /a{48}|v{48}/, 'never prints tokens');
    for (const p of walk(vdir)) {
        assert.ok(!p.endsWith('.tmp'), 'no temp file left');
        if (!WIN) assert.equal(statSync(p).mode & 0o777, statSync(p).isDirectory() ? 0o700 : 0o600, p);
    }
    // Parity: the key the live router computes for the SpeechDirector chunk equals the prerendered key.
    const live = { ...c, speechDirection: 'reaction', phraseCache: true }, router = new VoiceQualityRouter(live, { ledger: { reserve() { throw new Error('no reservation'); } }, fetchFn: forbidden, library: lib });
    const d = new SpeechDirector(live), a = router.adapter();
    const cases = [['ありがとう！', 'happy'], ['本当に？', 'surprised'], ['やったー！', 'excited']];
    for (const [text, reaction] of cases) {
        const part = d.plan(text, { reaction }).parts[0], ch = part.chunks[0];
        const [k] = phraseKeys(c, text, [reaction]);
        assert.equal(router.renderKey({ family: ch.family, intensity: ch.intensity, pace: ch.pace }), k.renderKey, text);
        assert.equal(lib.hasPhrase(a.identity16(), text, k.renderKey), true, text);
        const r = await router.renderPart(part);
        assert.deepEqual(r.stats.tiers, { cache: 1, local: 0 }, text);
    }
    // An interjection chunk of a longer approved sentence hits too; the rest stays local.
    const p = d.plan('えっ、本当なの？', { reaction: 'surprised' }).parts[0];
    assert.deepEqual(p.chunks.map(x => x.text), ['えっ、', '本当なの？']);
    assert.equal(lib.hasPhrase(a.identity16(), 'えっ、', router.renderKey(p.chunks[0])), true);
    // A second run skips everything already present: no synthesis.
    const f2 = fixture(vvRoutes()), out2 = logger();
    assert.equal(await libraryMain(['prerender', '--confirm-local'], { env: env(dir), fetchFn: f2.fetchFn, log: out2.log }), 0);
    assert.deepEqual(f2.calls, []); assert.match(out2.text(), /phrases planned: 0/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).calls.tts, synth, 'one real ledger reservation per take');
});

test('prerender: --dry-run, missing --confirm-local and a non-loopback URL make 0 fetches', async t => {
    const dir = temp(t);
    for (const [argv, e, code, re] of [
        [['prerender', '--confirm-local', '--dry-run'], env(dir), 0, /planned synthesis calls: \d+/],
        [['prerender'], env(dir), 1, /Explicit --confirm-local is required; no request was made\./],
        [['prerender', '--confirm-local'], env(dir, { VOICEVOX_URL: 'https://voice.example.com' }), 1, /must be loopback/],
        [['prerender', '--confirm-local'], env(dir, { VOICEVOX_URL: 'http://host.docker.internal:50021' }), 1, /must be loopback/],
        [['prerender', '--confirm-local', '--presets=nope'], env(dir), 1, /Invalid --presets/],
        [['prerender', '--confirm-local', '--only=こんにちは'], env(dir), 1, /not allowlisted/],
    ]) {
        const f = fixture(vvRoutes()), out = logger();
        assert.equal(await libraryMain(argv, { env: e, fetchFn: f.fetchFn, log: out.log }), code, argv.join(' '));
        assert.match(out.text(), re);
        assert.deepEqual(f.calls, [], argv.join(' '));
    }
    assert.equal(existsSync(join(dir, 'voice', 'phrases')), false);
    // Dry-run counts: two presets sharing a voice collapse to one key; ！？ bumps intensity, so mid and high collapse too.
    const out = logger();
    await libraryMain(['prerender', '--confirm-local', '--dry-run', '--only=えっ！？', '--intensities=low,mid,high'], { env: env(dir), fetchFn: forbidden, log: out.log });
    assert.match(out.text(), /phrases planned: 2; .*planned synthesis calls: 2/);
});

test('prerender: a QC failure is reported and skipped, never retried', async t => {
    const dir = temp(t), f = fixture({ ...vvRoutes(), '/synthesis': () => new Response(writeWav(new Float32Array(12000), 24000)) }), out = logger();
    assert.equal(await libraryMain(['prerender', '--confirm-local', '--only=ありがとう！', '--presets=happy'], { env: env(dir), fetchFn: f.fetchFn, log: out.log }), 1);
    assert.match(out.text(), /QC failed \(silent\)/);
    assert.equal(f.calls.filter(p => p === '/synthesis').length, 1);
});

test('import-clip: attestation required, a 1.2 s gasp is rejected, a valid tone is accepted', async t => {
    const dir = temp(t), files = temp(t), run = async argv => { const out = logger(); return [await libraryMain(argv, { env: env(dir), fetchFn: forbidden, log: out.log }), out.text()]; };
    writeFileSync(join(files, 'long.wav'), tone(1.2, 300)); writeFileSync(join(files, 'ok.wav'), tone(.4, 300, 48000, .05)); writeFileSync(join(files, 'hi.wav'), tone(.4, 300, 96000));
    let [code, text] = await run(['import-clip', '--class=gasp', `--file=${join(files, 'ok.wav')}`]);
    assert.equal(code, 1); assert.match(text, /attest-nonverbal/); assert.equal(existsSync(join(dir, 'voice', 'clips')), false);
    [code, text] = await run(['import-clip', '--class=gasp', `--file=${join(files, 'long.wav')}`, '--attest-nonverbal']);
    assert.equal(code, 1); assert.match(text, /bad_duration/);
    [code, text] = await run(['import-clip', '--class=word', `--file=${join(files, 'ok.wav')}`, '--attest-nonverbal']);
    assert.equal(code, 1);
    [code, text] = await run(['import-clip', '--class=gasp', `--file=${join(files, 'ok.wav')}`, '--attest-nonverbal', '--gain-db=-2']);
    assert.equal(code, 0, text); assert.match(text, /clip added: gasp-1/);
    [code, text] = await run(['import-clip', '--class=hmm', `--file=${join(files, 'hi.wav')}`, '--attest-nonverbal']);
    assert.equal(code, 0, text);
    const lib = new ReactionAudioCache(join(dir, 'voice')), s = lib.reload();
    assert.deepEqual(s.errors, []); assert.deepEqual(s.clips, { gasp: 1, hmm: 1 });
    assert.equal(lib.clip('hmm').rate, 44100, 'out-of-range rates are resampled to 44100');
    assert.ok(Math.abs(lib.clip('gasp').pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0) - 10 ** (-3 / 20)) < .01, 'peak-normalized to -3 dBFS');
});

test('import-phrase: allowlisted exact text only, keyed to the current voice; verify/list/remove', async t => {
    const dir = temp(t), files = temp(t), run = async argv => { const out = logger(); return [await libraryMain(argv, { env: env(dir), fetchFn: forbidden, log: out.log }), out.text()]; };
    writeFileSync(join(files, 'p.wav'), tone(.6, 500));
    assert.equal((await run(['import-phrase', '--text=ありがとう！', '--preset=happy', `--file=${join(files, 'p.wav')}`]))[0], 1);
    assert.equal((await run(['import-phrase', '--text=ありがとうございます', '--preset=happy', `--file=${join(files, 'p.wav')}`, '--attest-exact-text']))[0], 1);
    assert.equal((await run(['import-phrase', '--text=ありがとう！', '--preset=shock', `--file=${join(files, 'p.wav')}`, '--attest-exact-text']))[0], 1);
    const [code, text] = await run(['import-phrase', '--text=ありがとう!', '--preset=happy', `--file=${join(files, 'p.wav')}`, '--attest-exact-text']);
    assert.equal(code, 0, text);
    const c = loadConfig(env(dir)), router = new VoiceQualityRouter(c, { ledger: {}, fetchFn: forbidden }), [k] = phraseKeys(c, 'ありがとう！', ['happy']);
    const lib = new ReactionAudioCache(join(dir, 'voice')); lib.reload();
    assert.equal(lib.hasPhrase(router.adapter().identity16(), 'ありがとう！', k.renderKey), true);
    const id = lib.entries(router.adapter().identity16()).phrases[0].id;
    assert.equal(lib.entries(router.adapter().identity16()).phrases[0].source, 'recorded');
    let [vc, vt] = await run(['verify']); assert.equal(vc, 0, vt); assert.match(vt, /errors: 0/);
    const [lc, lt] = await run(['list']); assert.equal(lc, 0); assert.match(lt, /phrases: [a-f0-9]{16}=1/);
    // A rejected entry makes verify fail with its reason.
    mkdirSync(join(dir, 'voice', 'clips'), { recursive: true });
    writeFileSync(join(dir, 'voice', 'clips', 'manifest.json'), JSON.stringify({ version: 1, clips: [{ id: 'gasp-1', cls: 'gasp', file: 'gasp-1.wav', sha256: 'a'.repeat(64), attest: 'nonverbal', text: 'えっ' }] }));
    [vc, vt] = await run(['verify']); assert.equal(vc, 1); assert.match(vt, /has_text/);
    assert.equal((await run(['remove', `--id=${id}`]))[0], 0);
    assert.equal((await run(['remove', `--id=${id}`]))[0], 1);
    lib.reload(); assert.deepEqual(lib.entries(router.adapter().identity16()).phrases, []);
});

test('benchmark sentences: the shipped file validates; a missing category or bad item is rejected', () => {
    const list = loadSentences(join(ROOT, 'config', 'voice-benchmark.json'));
    assert.equal(list.length, 40);
    assert.deepEqual([...new Set(list.map(s => s.category))].sort(), [...CATEGORIES].sort());
    const count = cat => list.filter(s => s.category === cat).length;
    assert.deepEqual(CATEGORIES.map(count), [8, 4, 4, 4, 4, 4, 4, 4, 4]);
    for (const s of list.filter(x => x.category === 'long')) assert.ok(s.text.length >= 120 && s.text.length <= 220, s.id);
    const raw = JSON.parse(readFileSync(join(ROOT, 'config', 'voice-benchmark.json'), 'utf8'));
    assert.throws(() => validateSentences(raw.sentences.filter(s => s.category !== 'serious')), /category missing: serious/);
    assert.throws(() => validateSentences(raw.sentences.slice(0, 19)), /20\.\.50/);
    assert.equal(validateScenario(raw).length, raw.consistency.length);
    assert.throws(() => validateScenario({ consistency: raw.consistency.map((x, i) => i ? x : { ...x, reaction: 'listen' }) }), /Invalid consistency line #0/);
    for (const patch of [{ id: 's01' }, { text: '<b>' }, { text: 'あ。い。う。' }, { reaction: 'listen' }, { category: 'other' }, { text: 'あ'.repeat(221) }])
        assert.throws(() => validateSentences(raw.sentences.map((s, i) => i === 1 ? { ...s, ...patch } : s)), /Invalid benchmark sentence/, JSON.stringify(patch));
});

test('blindKey is deterministic per seed and shuffles each sentence independently', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`), v = ['voicevox', 'aivisspeech', 'sbv2', 'supertonic'];
    const a = blindKey(ids, v, 7), b = blindKey(ids, v, 7), c = blindKey(ids, v, 8);
    assert.deepEqual(a, b); assert.notDeepEqual(a, c);
    for (const id of ids) { assert.deepEqual(Object.keys(a[id]), ['A', 'B', 'C', 'D']); assert.deepEqual(Object.values(a[id]).sort(), [...v].sort()); }
    assert.ok(new Set(ids.map(id => JSON.stringify(a[id]))).size > 1, 'differs between sentences');
    const r = mulberry32(1), xs = Array.from({ length: 100 }, r);
    assert.ok(xs.every(x => x >= 0 && x < 1)); assert.deepEqual(xs, Array.from({ length: 100 }, mulberry32(1)));
    assert.throws(() => blindKey(ids, [...v, ...v]));
});

test('stats percentiles and audioStats of a padded tone', () => {
    assert.deepEqual(stats([]), { n: 0, mean: null, p50: null, p95: null, max: null });
    const s = stats([...Array.from({ length: 100 }, (_, i) => i + 1), NaN, null]);
    assert.equal(s.n, 100); assert.equal(s.mean, 50.5); assert.equal(s.p50, 50); assert.equal(s.p95, 95); assert.equal(s.max, 100);
    assert.equal(stats([3]).p95, 3);
    const rate = 24000, pcm = new Float32Array(Math.round(.6 * rate)); pcm.set(sine(.4, 440, rate, .5), Math.round(.1 * rate));
    const a = audioStats(writeWav(pcm, rate));
    assert.equal(a.rate, 24000); assert.equal(a.ms, 600);
    assert.ok(Math.abs(a.leadSilenceMs - 100) <= 2 && Math.abs(a.tailSilenceMs - 100) <= 2, JSON.stringify(a));
    assert.ok(Math.abs(a.peakDb - 20 * Math.log10(.5)) < .2); assert.ok(a.rmsDb < a.peakDb); assert.equal(a.clipped, 0);
});

test('sheet CSV round-trips; the listening page is static, escaped and provider-free', () => {
    const sentences = [{ id: 's01', category: 'surprise', text: 'えっ、"待って", <script>alert(1)</script>\n次', reaction: 'shock' }, { id: 's02', category: 'long', text: '普通の文。', reaction: 'neutral' }];
    const key = blindKey(['s01', 's02'], [...PROVIDERS], 3), csv = sheetCSV(key, sentences, 2), rows = parseCSV(csv);
    assert.equal(rows.length, 2 * PROVIDERS.length * 2);
    assert.deepEqual(Object.keys(rows[0]), ['sentence_id', 'category', 'text', 'label', 'run', 'naturalness', 'character', 'emotion', 'pronunciation', 'listenability', 'two_hours', 'accent_errors', 'reading_errors', 'notes']);
    assert.equal(rows[0].text, sentences[0].text); assert.equal(rows[0].label, 'A'); assert.equal(rows[1].run, '2');
    assert.deepEqual(parseCSV('﻿a,b\r\n1,"x,""y"""\n'), [{ a: '1', b: 'x,"y"' }]);
    for (const p of PROVIDERS) assert.doesNotMatch(csv.toLowerCase(), new RegExp(p));
    const html = listeningHTML(sentences, key), low = html.toLowerCase();
    assert.doesNotMatch(low, /<script/); assert.match(html, /&lt;script&gt;/);
    for (const p of PROVIDERS) assert.equal(low.includes(p), false, p);
    assert.match(html, /<audio controls preload="none" src="audio\/s01\/A-r1\.wav"><\/audio>/);
    assert.match(html, /Content-Security-Policy/);
    const shipped = listeningHTML(loadSentences(join(ROOT, 'config', 'voice-benchmark.json')), blindKey(['s01'], ['voicevox'], 1)).toLowerCase();
    for (const p of PROVIDERS) assert.equal(shipped.includes(p), false, `shipped sentences mention ${p}`);
});

test('score un-blinds the sheet and PICK_RULE excludes an erroring variant', () => {
    const key = { s01: { A: 'x', B: 'y' }, s02: { A: 'y', B: 'x' } }, sent = { s01: 'みじかい文です。', s02: 'これも短い文です。' };
    const rate = (sid, label, n, acc = 0) => ({ sentence_id: sid, category: sid === 's01' ? 'surprise' : 'question', text: sent[sid], label, run: '1', naturalness: String(n), character: String(n), emotion: String(n), accent_errors: String(acc), reading_errors: '0', two_hours: '', notes: '' });
    const ratings = parseCSV(sheetCSV(key, [{ id: 's01', category: 'surprise', text: sent.s01 }, { id: 's02', category: 'question', text: sent.s02 }], 1)).map(r => rate(r.sentence_id, r.label, key[r.sentence_id][r.label] === 'x' ? 5 : 3, key[r.sentence_id][r.label] === 'x' ? 1 : 0));
    const row = (variant, sid, extra = {}) => ({ variant, sid, chars: sent[sid].length, ttfaMs: 400, totalMs: 500, audioMs: 2000, rtf: .25, error: null, coldStartMs: 3000, cpu: { avg: 40, max: 80 }, rssMb: 900, ...extra });
    const results = ['x', 'y'].flatMap(v => ['s01', 's02'].map(s => row(v, s)));
    const s = score({ ratings, key, results });
    assert.equal(s.variants.x.mos.naturalness, 5); assert.equal(s.variants.y.mos.naturalness, 3);
    assert.equal(s.variants.x.byCategory.surprise, 5); assert.equal(s.variants.x.ttfa.p95, 400); assert.equal(s.variants.x.rtf.p95, .25);
    assert.equal(s.variants.x.accentErrorsPer100Chars, Math.round(2 * 100 / (sent.s01.length + sent.s02.length) * 100) / 100);
    assert.deepEqual(s.variants.x.cpu, { avg: 40, max: 80 });
    assert.equal(s.pick.variant, 'x');
    const erroring = score({ ratings, key, results: [...results, row('x', 's01', { error: 'TTS_ENGINE_DOWN' })] });
    assert.equal(erroring.variants.x.excluded, 'errors'); assert.equal(erroring.pick.variant, 'y');
    const slow = score({ ratings, key, results: results.map(r => r.variant === 'y' ? { ...r, ttfaMs: PICK_RULE.maxTtfaP95Ms + 1 } : r).concat(row('x', 's02', { error: 'TTS_REJECTED' })) });
    assert.equal(slow.variants.y.excluded, 'ttfa'); assert.equal(slow.pick, null);
    // Ties break on the lower accent-error rate.
    const tied = score({ ratings: ratings.map(r => ({ ...r, naturalness: '4', character: '4', emotion: '4' })), key, results });
    assert.equal(tied.pick.variant, 'y');
    // "Two hours: yes" outranks a higher mean score.
    const twoH = score({ ratings: ratings.map(r => ({ ...r, two_hours: key[r.sentence_id][r.label] === 'y' ? 'Y' : 'N' })), key, results });
    assert.equal(twoH.variants.y.twoHoursYes, 1); assert.equal(twoH.variants.x.twoHoursYes, 0); assert.equal(twoH.pick.variant, 'y');
    // Voice Consistency: any identity break, or an unrated take, excludes the voice.
    const cons = (bx, by) => score({ ratings, key, results, consistencyKey: { P: 'x', Q: 'y' }, consistency: [{ label: 'P', identity_breaks: bx }, { label: 'Q', identity_breaks: by }] });
    const broke = cons('1', '0');
    assert.equal(broke.variants.x.excluded, 'identity_break'); assert.equal(broke.variants.y.identityBreaks, 0); assert.equal(broke.pick.variant, 'y');
    assert.equal(cons('', '0').variants.x.excluded, 'consistency_unrated');
    assert.equal(cons('0', '0').pick.variant, 'x');
    assert.equal(score({ ratings, key, results }).variants.x.identityBreaks, null, 'older runs without a consistency take are not penalised');
});

test('runEngine: fixture engines record ttfa, rtf and cpu; offline and wrong engines are skipped, not thrown', async t => {
    const dir = temp(t), c = loadConfig(env(dir, { AIVIS_STYLE: '888753760' })), sentences = loadSentences(join(ROOT, 'config', 'voice-benchmark.json')).filter(s => ['s14', 's30'].includes(s.id));
    const sampled = [], sampler = pid => { sampled.push(pid); return { cpu: 50, rssMb: 300 }; };
    const vv = fixture(vvRoutes(.4));
    const rows = await runEngine({ c, provider: 'voicevox', sentences, runs: 2, fetchFn: vv.fetchFn, sampler, pid: 4242 });
    assert.equal(rows.length, 4);
    for (const r of rows) {
        assert.equal(r.error, null); assert.equal(r.variant, 'voicevox');
        assert.ok(Number.isFinite(r.ttfaMs) && r.ttfaMs <= r.totalMs); assert.ok(r.audioMs >= 800, String(r.audioMs));
        assert.ok(r.rtf > 0); assert.deepEqual(r.cpu, { avg: 50, max: 50 }); assert.equal(r.rssMb, 300);
        assert.ok(r.calls >= 4, 'each run renders again (cache cleared)'); assert.ok(Buffer.isBuffer(r.wav));
        assert.ok(Number.isFinite(r.coldStartMs));
    }
    assert.ok(sampled.length >= 4 && sampled.every(p => p === 4242));
    const av = fixture(aivisRoutes()), directed = await runEngine({ c, provider: 'aivisspeech', sentences: sentences.slice(0, 1), runs: 1, directed: true, fetchFn: av.fetchFn });
    assert.equal(directed[0].variant, 'aivisspeech+directed'); assert.equal(directed[0].error, null, directed[0].error); assert.equal(directed[0].cpu, null);
    assert.ok(av.calls.includes('/engine_manifest'));
    const off = await runEngine({ c, provider: 'sbv2', sentences, fetchFn: async () => { throw new TypeError('fetch failed'); } });
    assert.deepEqual(off, [{ variant: 'sbv2', provider: 'sbv2', directed: false, skipped: 'offline', code: 'TTS_ENGINE_DOWN' }]);
    const wrong = await runEngine({ c, provider: 'aivisspeech', sentences, fetchFn: fixture(aivisRoutes({ '/engine_manifest': () => response({ name: 'VOICEVOX Engine' }) })).fetchFn });
    assert.equal(wrong[0].skipped, 'identity'); assert.equal(wrong[0].code, 'TTS_ENGINE_MISMATCH');
    const broken = fixture({ ...vvRoutes(), '/synthesis': () => new Response('down', { status: 503 }) });
    let n = 0; const flaky = async (u, o) => (new URL(u).pathname === '/synthesis' && ++n > 1 ? broken : vv).fetchFn(u, o);
    const errs = await runEngine({ c, provider: 'voicevox', sentences: sentences.slice(0, 1), fetchFn: flaky });
    assert.equal(errs.length, 1); assert.ok(typeof errs[0].error === 'string' && errs[0].error.length);
});

test('process sampling uses argv only and returns null on failure', () => {
    const seen = [], exec = (cmd, args) => { seen.push([cmd, ...args]); return { lsof: '4242\n', ps: ' 12.5 204800\n', 'nvidia-smi': '37, 2048\n' }[cmd]; };
    assert.equal(findPid(10101, exec), 4242); assert.deepEqual(sampleProcess(4242, exec), { cpu: 12.5, rssMb: 200 }); assert.deepEqual(sampleGpu(exec), { util: 37, memMb: 2048 });
    assert.deepEqual(seen[0], ['lsof', '-nP', '-iTCP:10101', '-sTCP:LISTEN', '-t']);
    assert.deepEqual(seen[1], ['ps', '-o', '%cpu=,rss=', '-p', '4242']);
    const boom = () => { throw new Error('ENOENT'); };
    assert.equal(findPid(10101, boom), null); assert.equal(sampleProcess(4242, boom), null); assert.equal(sampleGpu(boom), null);
    assert.equal(findPid(0, exec), null); assert.equal(sampleProcess('1; rm', exec), null);
    for (const [u, ok] of [['http://127.0.0.1:5055', true], ['http://localhost:1', true], ['http://[::1]:10101', true], ['https://voice.example.com', false], ['http://host.docker.internal:50021', false], ['nope', false]]) assert.equal(isLoopback(u), ok, u);
});

test('voice-benchmark CLI without --confirm-local exits 1 before any request', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'voice-benchmark.mjs')], { encoding: 'utf8', env: { ...process.env, DATA_DIR: join(tmpdir(), 'jvs-never-created') } });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /no request was made/);
});

test('allowlist sanity: every committed phrase yields at least one prerender key', t => {
    const c = loadConfig(env(temp(t)));
    for (const [norm, e] of loadPhraseAllowlist(null).map) { assert.equal(norm, normalizePhrase(e.text)); assert.ok(phraseKeys(c, e.text, e.presets).length >= 1, e.text); }
});

test('voice-benchmark: fixture run writes private blind outputs; summarize un-blinds; remote engines are refused', async t => {
    const { main: benchMain } = await import('../scripts/voice-benchmark.mjs');
    const dir = temp(t), c = loadConfig(env(dir, { AIVIS_STYLE: '888753760' })), vv = fixture(vvRoutes(.3)), out = logger();
    const fetchFn = async (u, o) => new URL(u).port === '50021' ? vv.fetchFn(u, o) : Promise.reject(new TypeError('fetch failed'));
    const exec = () => { throw new Error('no lsof'); };
    assert.equal(await benchMain(['--confirm-local', '--providers=voicevox,supertonic', '--runs=1', '--seed=5'], { c, fetchFn, log: out.log, execFn: exec }), 0, out.text());
    assert.match(out.text(), /supertonic: skipped \(offline/);
    const [stamp] = readdirSync(join(dir, 'voice-bench')), run = join(dir, 'voice-bench', stamp);
    for (const p of [run, ...walk(run)]) if (!WIN) assert.equal(statSync(p).mode & 0o777, statSync(p).isDirectory() ? 0o700 : 0o600, p);
    const { key, seed } = JSON.parse(readFileSync(join(run, 'key.json'), 'utf8')), results = JSON.parse(readFileSync(join(run, 'results.json'), 'utf8'));
    assert.equal(seed, 5); assert.deepEqual(key.s01, { A: 'voicevox' }); assert.equal(results.rows.length, 40); assert.equal(results.skipped[0].skipped, 'offline');
    assert.equal(results.environment.providers.voicevox, '0.14.5'); assert.ok(results.environment.cores >= 1);
    assert.ok(existsSync(join(run, 'audio', 's01', 'A-r1.wav')));
    const { consistency } = JSON.parse(readFileSync(join(run, 'key.json'), 'utf8'));
    assert.deepEqual(Object.values(consistency), ['voicevox']); assert.ok(existsSync(join(run, 'consistency', `${Object.keys(consistency)[0]}.wav`)));
    assert.deepEqual(parseCSV(readFileSync(join(run, 'consistency.csv'), 'utf8')).map(r => r.label), Object.keys(consistency));
    const html = readFileSync(join(run, 'listening.html'), 'utf8').toLowerCase();
    for (const p of PROVIDERS) assert.equal(html.includes(p), false);
    // Operator fills the sheet, then summarizes.
    const sheet = parseCSV(readFileSync(join(run, 'sheet.csv'), 'utf8')).map(r => ({ ...r, naturalness: '4', character: '4', emotion: '4', accent_errors: '0' }));
    writeFileSync(join(run, 'sheet.csv'), [Object.keys(sheet[0]).join(','), ...sheet.map(r => Object.values(r).map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','))].join('\n'));
    const sum = logger();
    assert.equal(await benchMain(['summarize', `--dir=${run}`], { log: sum.log }), 0, sum.text());
    const summary = JSON.parse(readFileSync(join(run, 'summary.json'), 'utf8'));
    assert.equal(summary.variants.voicevox.mos.naturalness, 4); assert.equal(summary.variants.voicevox.excluded, 'consistency_unrated', 'an unrated consistency take blocks the pick'); assert.equal(summary.variants.supertonic.excluded, 'skipped');
    assert.match(sum.text(), /Licence \/ credit duties/); assert.match(sum.text(), /VOICEVOX:/);
    const remote = logger(), f = fixture(vvRoutes());
    assert.equal(await benchMain(['--confirm-local', '--providers=sbv2'], { c: { ...c, sbv2URL: 'https://tts.example.com' }, fetchFn: f.fetchFn, log: remote.log }), 1);
    assert.match(remote.text(), /not loopback for sbv2/); assert.deepEqual(f.calls, []);
});

test('consistency take: one continuous wav through the directed path, with the operator gasp actually played', async t => {
    const dir = temp(t), c = loadConfig(env(dir)), vv = fixture(vvRoutes(.3)), lines = loadScenario(join(ROOT, 'config', 'voice-benchmark.json'));
    const libDir = join(dir, 'voice');
    addClip(libDir, { cls: 'gasp', bytes: tone(.3, 300), attest: 'nonverbal' });
    const library = new ReactionAudioCache(libDir); library.reload(); assert.deepEqual(library.status().errors, []);
    const r = await renderConsistency({ c, provider: 'voicevox', library, lines, fetchFn: vv.fetchFn });
    assert.equal(r.wav.subarray(0, 4).toString(), 'RIFF');
    assert.ok(r.used.clips.includes('gasp'), JSON.stringify(r.used)); assert.ok(r.used.localParts >= lines.length);
    const bare = await renderConsistency({ c, provider: 'voicevox', library: null, lines, fetchFn: vv.fetchFn });
    assert.deepEqual(bare.used.clips, []); assert.ok(r.wav.length > bare.wav.length, 'the clip is in the same take');
});
