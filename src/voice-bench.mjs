// Same-sentence A/B voice benchmark helpers. Pure where possible: process sampling takes an injectable execFn,
// rendering takes an injectable fetchFn, and nothing here decides the engine: the operator does.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sentences as splitSentences } from './director.mjs';
import { readWav, levels } from './wav.mjs';
import { joinParts } from './audio-bus.mjs';
import { DirectedVoice } from './voice-router.mjs';
import { SpeechDirector } from './speech-director.mjs';
import { JEV_REACTIONS } from '../public/avatar-rig.mjs';

export const CATEGORIES = ['normal', 'happy', 'surprise', 'embarrassed', 'serious', 'short_reaction', 'question', 'fast_game', 'long'];
/** Blind 1..5 scales; `two_hours` (Y/N: "would I listen to this voice for a two-hour stream?") ranks first. */
export const SCALES = ['naturalness', 'character', 'emotion', 'pronunciation', 'listenability'];
export const PICK_RULE = Object.freeze({ shortChars: 40, maxTtfaP95Ms: 1500, maxRtfP95: .5, maxErrors: 0, maxColdStartMs: 20000, maxIdentityBreaks: 0 });
export const LABELS = 'ABCDEFGH'.split('');
export const PROVIDER_URL_KEY = Object.freeze({ voicevox: 'voiceURL', supertonic: 'supertonicURL', aivisspeech: 'aivisURL', sbv2: 'sbv2URL' });
/** Licence and credit duties are the operator's, never scored. */
export const LICENCE_NOTES = Object.freeze({
    voicevox: 'VOICEVOX: each character has its own terms; credit "VOICEVOX:<name>" (VOICEVOX_CREDIT).',
    aivisspeech: 'AivisSpeech: check each model licence (ACML / ACML-NC etc.); credit AIVIS_CREDIT.',
    sbv2: 'Style-Bert-VITS2: check the model licence; amitaro/koharune models require SBV2_CREDIT.',
    supertonic: 'Supertonic 3: check the model and voice licence before streaming.',
});
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const providerURL = (c, id) => Object.hasOwn(PROVIDER_URL_KEY, id) ? c[PROVIDER_URL_KEY[id]] ?? null : null;
export function isLoopback(url) { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } }
const fail = m => { throw new Error(m); };
const r1 = x => Math.round(x * 10) / 10, r3 = x => Math.round(x * 1000) / 1000;

export function validateSentences(json) {
    const list = Array.isArray(json) ? json : json?.sentences;
    if (!Array.isArray(list) || list.length < 20 || list.length > 50) fail('Benchmark needs 20..50 sentences');
    const ids = new Set(), seen = new Set();
    const out = list.map((s, i) => {
        const bad = () => fail(`Invalid benchmark sentence #${i}`);
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^s\d{2}$/.test(s.id) || ids.has(s.id)) bad();
        if (!CATEGORIES.includes(s.category) || typeof s.reaction !== 'string' || !Object.hasOwn(JEV_REACTIONS, s.reaction)) bad();
        const t = s.text;
        if (typeof t !== 'string' || !t.trim() || t.length > 220 || /[<>\u0000-\u001f\u007f-\u009f]/.test(t)) bad();
        let n = 0;
        try { n = splitSentences(t).length; } catch { bad(); }
        if (n < 1 || n > 2) bad();
        ids.add(s.id); seen.add(s.category);
        return { id: s.id, category: s.category, text: t, reaction: s.reaction };
    });
    const missing = CATEGORIES.filter(c => !seen.has(c));
    if (missing.length) fail(`Benchmark category missing: ${missing.join(',')}`);
    return out;
}
export const loadSentences = path => validateSentences(JSON.parse(readFileSync(path, 'utf8')));
/** Voice Consistency scenario: one continuous take through normal → clip → surprise → phrase → laugh → normal. */
export function validateScenario(json) {
    const list = json?.consistency;
    if (!Array.isArray(list) || list.length < 3 || list.length > 12) fail('Consistency scenario needs 3..12 lines');
    return list.map((s, i) => {
        const t = s?.text;
        if (typeof s?.reaction !== 'string' || !Object.hasOwn(JEV_REACTIONS, s.reaction) || typeof t !== 'string' || !t.trim() || t.length > 220 || /[<>\u0000-\u001f\u007f-\u009f]/.test(t)) fail(`Invalid consistency line #${i}`);
        return { reaction: s.reaction, text: t };
    });
}
export const loadScenario = path => validateScenario(JSON.parse(readFileSync(path, 'utf8')));
/** Renders the scenario as ONE wav through the directed pipeline with the operator's library (clips + phrase takes of
 * this voice). The clock advances 30 s per line so clip cooldowns never hide a clip. Returns what actually aired. */
export async function renderConsistency({ c, provider, library, lines, fetchFn = fetch, gapMs = 450, signal } = {}) {
    const over = { mode: 'live', replyTtsProvider: provider, speechDirection: 'reaction', phraseCache: true, reactionAudio: true };
    const cfg = new Proxy(c, { get: (t, k) => Object.hasOwn(over, k) ? over[k] : t[k] });
    let clock = 1e6;
    const voice = new DirectedVoice(cfg, { reserve() { } }, { fetchFn, library, now: () => clock }), director = new SpeechDirector(cfg), audios = [], used = { clips: [], phraseParts: 0, localParts: 0 };
    for (const line of lines) {
        clock += 30000;
        for (const part of director.plan(line.text, { reaction: line.reaction }, { clipKinds: voice.clipKinds() }).parts) {
            const r = await voice.synthesize(part.text, signal, part), f = r.finalize ? r.finalize({ reaction: part.head, intensity: part.intensity }, clock) : r;
            if (f.clip) used.clips.push(f.clip);
            if (r.stats?.tiers?.cache) used.phraseParts++;
            if (r.stats?.tiers?.local) used.localParts++;
            audios.push(f);
        }
    }
    return { wav: joinParts(audios, gapMs).bytes, used };
}

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = a + 0x6D2B79F5 >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/** { [sid]: { A: variant, B: variant, ... } }, an independent Fisher-Yates shuffle per sentence. */
export function blindKey(sentenceIds, variants, seed = 1) {
    if (!Array.isArray(variants) || !variants.length || variants.length > LABELS.length || new Set(variants).size !== variants.length) fail('Benchmark needs 1..8 distinct variants');
    const rnd = mulberry32(seed), key = {};
    for (const sid of sentenceIds) {
        const v = [...variants];
        for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [v[i], v[j]] = [v[j], v[i]]; }
        key[sid] = Object.fromEntries(v.map((x, i) => [LABELS[i], x]));
    }
    return key;
}
/** Nearest-rank percentiles over finite values. */
export function stats(values) {
    const xs = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b), n = xs.length;
    if (!n) return { n: 0, mean: null, p50: null, p95: null, max: null };
    const at = p => xs[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
    return { n, mean: xs.reduce((a, b) => a + b, 0) / n, p50: at(.5), p95: at(.95), max: xs[n - 1] };
}
export function audioStats(buf, { thresholdDb = -50 } = {}) {
    const w = readWav(buf, { extensible: true }), l = levels(w.samples, w.rate), th = 10 ** (thresholdDb / 20), n = w.samples.length;
    let first = n, last = -1;
    for (let i = 0; i < n; i++) if (Math.abs(w.samples[i]) > th) { first = i; break; }
    for (let i = n - 1; i >= 0; i--) if (Math.abs(w.samples[i]) > th) { last = i; break; }
    const ms = s => Math.round(s * 1000 / w.rate);
    return { ms: Math.round(w.ms), rate: w.rate, peakDb: r1(l.peakDb), rmsDb: r1(l.rmsDb), clipped: r3(l.clipped), leadSilenceMs: ms(Math.min(first, n)), tailSilenceMs: last < 0 ? ms(n) : ms(n - 1 - last) };
}
const run = (execFn, cmd, args) => String(execFn(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '');
/** No shell: argv only. */
export function findPid(port, execFn = execFileSync) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    try { const pid = Number(run(execFn, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim().split(/\s+/)[0]); return Number.isInteger(pid) && pid > 0 ? pid : null; }
    catch { return null; }
}
export function sampleProcess(pid, execFn = execFileSync) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        const [cpu, rss] = run(execFn, 'ps', ['-o', '%cpu=,rss=', '-p', String(pid)]).trim().split(/\s+/).map(Number);
        return Number.isFinite(cpu) && Number.isFinite(rss) ? { cpu, rssMb: r1(rss / 1024) } : null;
    } catch { return null; }
}
export function sampleGpu(execFn = execFileSync) {
    try {
        const [util, memMb] = run(execFn, 'nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits']).trim().split('\n')[0].split(',').map(x => Number(x.trim()));
        return Number.isFinite(util) && Number.isFinite(memMb) ? { util, memMb } : null;
    } catch { return null; }
}

export const variantOf = (provider, directed) => directed ? `${provider}+directed` : provider;
/** A DirectedVoice over a Proxy of c: live, one provider, no phrase cache, no clips, a no-op counting ledger. */
export async function openEngine({ c, provider, directed = false, fetchFn = fetch, now = () => performance.now(), signal } = {}) {
    const over = { mode: 'live', replyTtsProvider: provider, speechDirection: directed ? 'reaction' : 'off', phraseCache: false, reactionAudio: false };
    const cfg = new Proxy(c, { get: (t, k) => Object.hasOwn(over, k) ? over[k] : t[k] });
    const counter = { n: 0 }, counted = (...a) => { counter.n++; return fetchFn(...a); };
    const ledger = { calls: 0, reserve() { this.calls++; } };
    const voice = new DirectedVoice(cfg, ledger, { fetchFn: counted, library: null });
    const base = { provider, directed, variant: variantOf(provider, directed) };
    let version = null;
    try { version = (await voice.router.adapter().probe(signal))?.version ?? null; }
    catch (e) { return { ...base, skipped: e?.code === 'TTS_ENGINE_MISMATCH' ? 'identity' : 'offline', code: typeof e?.code === 'string' ? e.code : 'TTS_ENGINE_DOWN' }; }
    const t0 = now();
    try { await voice.synthesize('あ。', signal); }
    catch (e) { return { ...base, skipped: 'offline', code: typeof e?.code === 'string' ? e.code : 'TTS_ENGINE_DOWN' }; }
    const coldStartMs = Math.round(now() - t0);
    await voice.router.burnIn(signal); // Same burn-in as a live show start, so rows measure the warm engine the show uses.
    return { ...base, coldStartMs, burnInMs: Math.round(now() - t0) - coldStartMs, cfg, voice, ledger, counter, version, director: new SpeechDirector(cfg) };
}
/** One sentence, one run. Errors are recorded as codes, never thrown. */
export async function runSentence(engine, s, runNo, { sampler = null, pid = null, now = () => performance.now(), signal } = {}) {
    const { voice, counter, director } = engine, samples = [], take = () => { try { const x = sampler?.(pid); if (x) samples.push(x); } catch { } };
    const row = { variant: engine.variant, provider: engine.provider, directed: engine.directed, sid: s.id, category: s.category, chars: s.text.length, run: runNo, coldStartMs: engine.coldStartMs,
        ttfaMs: null, totalMs: null, audioMs: 0, rtf: null, calls: 0, error: null, cpu: null, rssMb: null, gpu: null, wav: null };
    voice.cache?.clear(); // Every run is a real render: repeated runs must not measure the LRU.
    let timer = null;
    if (sampler) { take(); timer = setInterval(take, 250); timer.unref?.(); }
    const calls0 = counter.n, t0 = now(), audios = [];
    try {
        if (engine.directed) {
            const plan = director.plan(s.text, { reaction: s.reaction });
            for (const part of plan.parts) {
                const r = await voice.synthesize(part.text, signal, part);
                const f = r.finalize ? r.finalize({ reaction: part.head, intensity: part.intensity }) : r;
                row.ttfaMs ??= Math.round(now() - t0); audios.push(f);
            }
        } else for (const part of splitSentences(s.text)) {
            const r = await voice.synthesize(part, signal);
            row.ttfaMs ??= Math.round(now() - t0); audios.push(r);
        }
        row.totalMs = Math.round(now() - t0);
        row.audioMs = Math.round(audios.reduce((n, a) => n + (Number.isFinite(a.durationMs) ? a.durationMs : 0), 0));
        row.rtf = row.audioMs > 0 ? r3(row.totalMs / row.audioMs) : null;
        if (audios.every(a => a.kind === 'wav' && a.bytes)) row.wav = joinParts(audios).bytes;
    } catch (e) { row.error = typeof e?.code === 'string' ? e.code : 'TTS_ENGINE_DOWN'; }
    finally { if (timer) clearInterval(timer); take(); }
    row.calls = counter.n - calls0;
    const cpu = stats(samples.map(x => x.cpu)), rss = stats(samples.map(x => x.rssMb)), gpu = stats(samples.map(x => x.gpu?.util));
    if (cpu.n) row.cpu = { avg: r1(cpu.mean), max: cpu.max };
    if (rss.n) row.rssMb = rss.max;
    if (gpu.n) row.gpu = { avg: r1(gpu.mean), max: gpu.max, memMb: stats(samples.map(x => x.gpu?.memMb)).max };
    return row;
}
export async function runEngine({ c, provider, sentences, runs = 1, directed = false, fetchFn = fetch, sampler = null, pid = null, now = () => performance.now(), signal } = {}) {
    const engine = await openEngine({ c, provider, directed, fetchFn, now, signal });
    if (engine.skipped) return [{ variant: engine.variant, provider, directed, skipped: engine.skipped, code: engine.code }];
    const rows = [];
    for (const s of sentences) for (let r = 1; r <= runs; r++) rows.push(await runSentence(engine, s, r, { sampler, pid, now, signal }));
    return rows;
}

export const SHEET_COLUMNS = ['sentence_id', 'category', 'text', 'label', 'run', ...SCALES, 'two_hours', 'accent_errors', 'reading_errors', 'notes'];
/** One row per blinded consistency take: count every moment it sounded like a different person. */
export const CONSISTENCY_COLUMNS = ['label', 'identity_breaks', 'break_times', 'notes'];
const csvCell = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function sheetCSV(key, sentences, runs = 1) {
    const lines = [SHEET_COLUMNS.join(',')];
    for (const s of sentences) for (const label of Object.keys(key[s.id] || {}).sort()) for (let r = 1; r <= runs; r++)
        lines.push([s.id, s.category, s.text, label, r, ...SHEET_COLUMNS.slice(5).map(() => '')].map(csvCell).join(','));
    return lines.join('\r\n') + '\r\n';
}
/** RFC 4180: quoted cells, doubled quotes, CRLF or LF. Returns header-keyed rows. */
export function consistencyCSV(labels) { return [CONSISTENCY_COLUMNS.join(','), ...labels.map(l => [l, '', '', ''].map(csvCell).join(','))].join('\r\n') + '\r\n'; }
export function parseCSV(text) {
    const src = String(text ?? '').replace(/^﻿/, ''), rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
        if (ch === '"') q = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [head, ...body] = rows.filter(r => r.some(x => x !== ''));
    if (!head) return [];
    return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
/** Static, script-free, provider-free listening page. */
export function listeningHTML(sentences, key, consistencyLabels = []) {
    const rows = sentences.map(s => {
        const labels = Object.keys(key[s.id] || {}).sort().map(l => `<li><b>${esc(l)}</b> <audio controls preload="none" src="audio/${esc(s.id)}/${esc(l)}-r1.wav"></audio></li>`).join('');
        return `<section><h2>${esc(s.id)} <small>${esc(s.category)}</small></h2><p>${esc(s.text)}</p><ul>${labels}</ul></section>`;
    }).join('\n');
    const consistency = consistencyLabels.length ? `<section><h2>Voice Consistency Test</h2><p>Each take is one continuous scenario (normal → reaction sound → surprise → phrase → laugh → normal). In consistency.csv, count every moment it sounded like a different person.</p><ul>${consistencyLabels.map(l => `<li><b>${esc(l)}</b> <audio controls preload="none" src="consistency/${esc(l)}.wav"></audio></li>`).join('')}</ul></section>` : '';
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self'; style-src 'unsafe-inline'">
<title>Voice blind test</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0 auto;padding:16px;max-width:880px}section{border-top:1px solid #8884;padding:8px 0}ul{list-style:none;padding:0}li{display:flex;gap:8px;align-items:center;margin:4px 0}audio{max-width:100%}small{color:#888}</style>
</head><body><h1>Voice blind test</h1><p>Rate every label in sheet.csv: naturalness, character, emotion, pronunciation, listenability 1..5; two_hours Y/N (would you listen to this voice for a two-hour stream?); error counts per sentence. Labels are shuffled per sentence.</p>
${consistency}
${rows}
</body></html>
`;
}

const num = v => { const n = v === '' || v == null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const round2 = x => x == null ? null : Math.round(x * 100) / 100;
/** Un-blinds the filled sheet and applies PICK_RULE. results: runEngine rows (each with .variant). */
export function score({ ratings = [], key = {}, results = [], rule = PICK_RULE, consistency = null, consistencyKey = {} } = {}) {
    const rows = Array.isArray(results) ? results : Object.values(results).flat(), variants = {};
    const names = new Set([...Object.values(key).flatMap(m => Object.values(m)), ...rows.map(r => r.variant).filter(Boolean)]);
    for (const v of names) {
        const rated = ratings.filter(r => key[r.sentence_id]?.[r.label] === v), mine = rows.filter(r => r.variant === v);
        const overallOf = r => mean(SCALES.map(k => num(r[k]))), yes = v => /^(y|yes|1|はい)$/i.test(String(v ?? '').trim()) ? 1 : /^(n|no|0|いいえ)$/i.test(String(v ?? '').trim()) ? 0 : null;
        const overall = rated.map(overallOf).filter(Number.isFinite), twoHours = rated.map(r => yes(r.two_hours)).filter(x => x != null);
        const takes = consistency ? consistency.filter(r => consistencyKey[r.label] === v.split('+')[0]) : [], breaks = takes.map(r => num(r.identity_breaks));
        const st = stats(overall), sd = st.n > 1 ? Math.sqrt(overall.reduce((a, x) => a + (x - st.mean) ** 2, 0) / (st.n - 1)) : null;
        const byCategory = {};
        for (const cat of CATEGORIES) { const m = mean(rated.filter(r => r.category === cat).map(overallOf)); if (m != null) byCategory[cat] = round2(m); }
        const chars = rated.reduce((n, r) => n + String(r.text ?? '').length, 0), per100 = f => chars ? round2(rated.reduce((n, r) => n + (num(r[f]) ?? 0), 0) * 100 / chars) : null;
        const ok = mine.filter(r => !r.skipped && !r.error), short = ok.filter(r => r.chars <= rule.shortChars);
        const ttfa = stats(short.map(r => r.ttfaMs)), rtf = stats(ok.map(r => r.rtf)), cpu = mine.filter(r => r.cpu);
        const cold = mine.map(r => r.coldStartMs).filter(Number.isFinite);
        variants[v] = {
            mos: Object.fromEntries(SCALES.map(k => [k, round2(mean(rated.map(r => num(r[k]))))])),
            twoHoursYes: twoHours.length ? round2(mean(twoHours)) : null,
            identityBreaks: !consistency ? null : breaks.length && breaks.every(Number.isFinite) ? breaks.reduce((a, b) => a + b, 0) : 'unrated',
            overall: round2(st.mean), ci95: sd == null ? null : round2(1.96 * sd / Math.sqrt(st.n)), n: st.n, byCategory,
            accentErrorsPer100Chars: per100('accent_errors'), readingErrorsPer100Chars: per100('reading_errors'),
            ttfa: { p50: ttfa.p50, p95: ttfa.p95 }, rtf: { p50: rtf.p50, p95: rtf.p95 },
            cpu: cpu.length ? { avg: round2(mean(cpu.map(r => r.cpu.avg))), max: Math.max(...cpu.map(r => r.cpu.max)) } : null,
            rssMb: stats(mine.map(r => r.rssMb)).max, gpu: stats(mine.map(r => r.gpu?.max)).max,
            errors: mine.filter(r => r.error || r.skipped).length, skipped: mine.find(r => r.skipped)?.skipped ?? null, coldStartMs: cold.length ? Math.max(...cold) : null,
        };
    }
    const why = x => x.skipped ? 'skipped' : x.errors > rule.maxErrors ? 'errors' : x.identityBreaks === 'unrated' ? 'consistency_unrated' : x.identityBreaks > rule.maxIdentityBreaks ? 'identity_break' : !(x.ttfa.p95 <= rule.maxTtfaP95Ms) ? 'ttfa' : !(x.rtf.p95 <= rule.maxRtfP95) ? 'rtf' : !(x.coldStartMs <= rule.maxColdStartMs) ? 'cold_start' : x.overall == null ? 'unrated' : null;
    for (const x of Object.values(variants)) x.excluded = why(x);
    const pass = Object.entries(variants).filter(([, x]) => !x.excluded)
        .sort(([, a], [, b]) => (b.twoHoursYes ?? -1) - (a.twoHoursYes ?? -1) || b.overall - a.overall || (a.accentErrorsPer100Chars ?? Infinity) - (b.accentErrorsPer100Chars ?? Infinity));
    const pick = pass.length ? { variant: pass[0][0], reason: `most "two hours: yes" (${pass[0][1].twoHoursYes ?? '-'}), then highest mean of ${SCALES.join('/')} (${pass[0][1].overall}), among ${pass.length} variant(s) passing PICK_RULE (incl. 0 identity breaks)` } : null;
    return { variants, pick };
}
