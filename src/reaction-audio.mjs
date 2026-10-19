import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, lstatSync, statSync, realpathSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { hash, hasPII, injection } from './util.mjs';
import { sentences } from './director.mjs';
import { ROOT } from './config.mjs';
import { JEV_REACTIONS } from '../public/avatar-rig.mjs';
import { readWav, resample, levels } from './wav.mjs';
/** Operator voice library under DATA_DIR/voice: wordless clips and exact-text phrase takes.
 * Loaded at startup and rehearsal only; never mid-show. Nothing here can create words. */
export const NONVERBAL_CLASSES = ['gasp', 'laugh_small', 'laugh_big', 'breath_in', 'breath_out', 'sigh', 'hmm'];
export const CLIP_MS = { min: 80, gasp: 800, breath_in: 1000, breath_out: 1200, sigh: 1500, hmm: 1500, laugh_small: 1500, laugh_big: 2500 };
export const LIBRARY_LIMITS = { manifestBytes: 262144, fileBytes: 2000000, clips: 32, takesPerClass: 4, phrases: 128, takesPerPhrase: 5, phraseChars: 24, phraseMinMs: 120, phraseMaxMs: 3000, msPerCharMin: 40, msPerCharMax: 400, totalMs: 120000 };
export const PHRASES_FILE = ROOT + '/config/phrases.json';
const ID = /^[a-z0-9_-]{1,40}$/, HEX16 = /^[a-f0-9]{16}$/, HEX64 = /^[a-f0-9]{64}$/, PHRASE_WAV = /^[a-f0-9]{16}\.wav$/;
const reject = reason => { throw Object.assign(new Error(reason), { reason }); };
const isObject = x => !!x && typeof x === 'object' && !Array.isArray(x);
const safeName = s => /^[\w.-]{1,64}$/.test(s) ? s : '?';
/** Exact match only: never folds kana, ー, small kana or ！？ (NFKC makes ！/？ ASCII on both sides). */
export function normalizePhrase(text) {
    return String(text).normalize('NFKC').replace(/[~～]/g, '〜').replace(/\s+/g, '').replace(/[、。,.]+$/u, '');
}
export function validatePhraseText(text) {
    if (typeof text !== 'string') throw new Error('Invalid phrase text');
    const t = text.trim();
    let one = false;
    try { one = sentences(t).length === 1; } catch { }
    if (!t || t.length > LIBRARY_LIMITS.phraseChars || /[\u0000-\u001f\u007f-\u009f]/.test(t) || hasPII(t) || injection(t) || /[<>]|https?:/i.test(t) || !one) throw new Error('Invalid phrase text');
    return t;
}
export const identity16 = identity => hash(JSON.stringify(identity)).slice(0, 16);
function allowEntry(e) {
    if (!isObject(e)) reject('bad_manifest');
    let text;
    try { text = validatePhraseText(e.text); } catch { reject('bad_text'); }
    const p = e.presets;
    if (!Array.isArray(p) || !p.length || p.length > 10 || new Set(p).size !== p.length || !p.every(x => typeof x === 'string' && Object.hasOwn(JEV_REACTIONS, x))) reject('bad_preset');
    return { text, presets: [...p] };
}
/** The committed allowlist is required and strict; operator additions (dir/phrases.json) are merged, bad ones reported. */
export function loadPhraseAllowlist(dir, phrasesFile = PHRASES_FILE) {
    const map = new Map(), errors = [];
    try {
        const list = JSON.parse(readFileSync(phrasesFile, 'utf8'));
        if (!Array.isArray(list) || !list.length) throw new Error();
        for (const e of list) { const x = allowEntry(e), k = normalizePhrase(x.text); if (map.has(k)) throw new Error(); map.set(k, x); }
    } catch { throw new Error('Invalid phrases allowlist'); }
    const file = dir ? join(dir, 'phrases.json') : null;
    let st = null;
    try { st = file && lstatSync(file); } catch { }
    if (!st) return { map, errors };
    let list = null;
    if (st.isSymbolicLink()) errors.push({ file: 'phrases.json', reason: 'symlink' });
    else if (st.size > LIBRARY_LIMITS.manifestBytes) errors.push({ file: 'phrases.json', reason: 'too_large' });
    else {
        try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { }
        if (!Array.isArray(list)) errors.push({ file: 'phrases.json', reason: 'bad_manifest' });
    }
    (list || []).forEach((e, i) => {
        try {
            if (i >= LIBRARY_LIMITS.phrases) reject('too_many_phrases');
            const x = allowEntry(e), k = normalizePhrase(x.text), prev = map.get(k);
            map.set(k, prev ? { text: prev.text, presets: [...new Set([...prev.presets, ...x.presets])] } : x);
        } catch (err) { errors.push({ file: `phrases.json#${i}`, reason: err.reason || 'bad_manifest' }); }
    });
    return { map, errors };
}
const empty = () => ({ clips: new Map(), phrases: new Map(), byId: new Map(), clipList: [], phraseList: [], errors: [], totalMs: 0, fp: '', rot: new Map(), memo: new Map() });
const inside = (real, base) => real.startsWith(base + sep);
/** Returns the parsed manifest, null when absent; throws Error(reason) when unusable. */
function readManifest(root, md) {
    const mf = join(md, 'manifest.json');
    let st;
    try { st = lstatSync(mf); } catch { return null; }
    if (!inside(realpathSync(md), root)) reject('outside_dir');
    if (st.isSymbolicLink()) reject('symlink');
    if (!st.isFile()) reject('bad_manifest');
    if (st.size > LIBRARY_LIMITS.manifestBytes) reject('too_large');
    let m;
    try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch { reject('bad_manifest'); }
    if (!isObject(m) || m.version !== 1) reject('bad_manifest');
    return m;
}
function readEntryFile(md, file, limits) {
    const p = join(md, file);
    let st, real;
    try { st = lstatSync(p); } catch { reject('bad_file'); }
    if (st.isSymbolicLink()) reject('symlink');
    if (!st.isFile()) reject('bad_file');
    try { real = realpathSync(p); } catch { reject('bad_file'); }
    if (!inside(real, realpathSync(md))) reject('outside_dir');
    if (st.size > limits.fileBytes) reject('too_large');
    return readFileSync(p);
}
function checkBytes(bytes, sha256, limits) {
    if (!Buffer.isBuffer(bytes)) reject('decode_failed');
    if (bytes.length > limits.fileBytes) reject('too_large');
    if (typeof sha256 !== 'string' || !HEX64.test(sha256) || hash(bytes) !== sha256) reject('sha_mismatch');
    try { return readWav(bytes, { extensible: true }); } catch { reject('decode_failed'); }
}
function checkLevels(w) {
    const l = levels(w.samples, w.rate);
    if (!(l.activeDb > -45)) reject('silent');
    if (l.clipped >= .01) reject('clipped');
}
function checkClip(e, s, limits) {
    if (!isObject(e)) reject('bad_manifest');
    if (typeof e.id !== 'string' || !ID.test(e.id) || s.byId.has(e.id)) reject('bad_id');
    if (!NONVERBAL_CLASSES.includes(e.cls)) reject('unknown_class');
    if (Object.hasOwn(e, 'text')) reject('has_text');
    if (e.attest !== 'nonverbal') reject('not_attested');
    if (e.file !== e.id + '.wav') reject('bad_file');
    const gainDb = e.gainDb ?? 0;
    if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < -12 || gainDb > 6) reject('bad_gain');
    if (s.clipList.length >= limits.clips) reject('too_many_clips');
    if ((s.clips.get(e.cls)?.length || 0) >= limits.takesPerClass) reject('too_many_takes');
    return gainDb;
}
function checkClipAudio(w, cls, s, limits) {
    if (!(w.ms >= CLIP_MS.min && w.ms <= CLIP_MS[cls])) reject('bad_duration');
    checkLevels(w);
    if (s.totalMs + w.ms > limits.totalMs) reject('total_duration');
}
function checkPhrase(e, id16, allow, s, limits) {
    if (!isObject(e)) reject('bad_manifest');
    if (typeof e.id !== 'string' || !ID.test(e.id) || s.byId.has(e.id)) reject('bad_id');
    let text;
    try { text = validatePhraseText(e.text); } catch { reject('bad_text'); }
    const norm = normalizePhrase(text), allowed = allow?.get(norm);
    if (e.norm !== norm) reject('norm_mismatch');
    if (!allowed) reject('not_allowlisted');
    if (!allowed.presets.includes(e.preset)) reject('bad_preset');
    if (typeof e.renderKey !== 'string' || !HEX64.test(e.renderKey)) reject('bad_render_key');
    if (!['tts', 'recorded'].includes(e.source)) reject('bad_source');
    if (e.source === 'recorded' && e.attest !== 'exact-text') reject('not_attested');
    if (typeof e.file !== 'string' || !PHRASE_WAV.test(e.file) || e.file !== e.id + '.wav') reject('bad_file');
    if (s.phraseList.length >= limits.phrases) reject('too_many_phrases');
    const key = `${id16}|${e.renderKey}|${norm}`;
    if ((s.phrases.get(key)?.length || 0) >= limits.takesPerPhrase) reject('too_many_takes');
    return { text, norm, key };
}
function checkPhraseAudio(w, norm, s, limits) {
    if (!(w.ms >= limits.phraseMinMs && w.ms <= limits.phraseMaxMs)) reject('bad_duration');
    const perChar = w.ms / norm.length;
    if (!(perChar >= limits.msPerCharMin && perChar <= limits.msPerCharMax)) reject('bad_rate_per_char');
    checkLevels(w);
    if (s.totalMs + w.ms > limits.totalMs) reject('total_duration');
}
const push = (map, key, x) => { const list = map.get(key); if (list) list.push(x); else map.set(key, [x]); };
function acceptClip(s, e, gainDb, w) {
    const x = { id: e.id, cls: e.cls, sha256: e.sha256, gainDb, pcm: w.samples, rate: w.rate, ms: w.ms };
    s.totalMs += w.ms; s.clipList.push(x); s.byId.set(x.id, x); push(s.clips, x.cls, x);
}
function acceptPhrase(s, id16, e, meta, w) {
    const x = { id: e.id, identity16: id16, text: meta.text, norm: meta.norm, renderKey: e.renderKey, preset: e.preset, source: e.source, sha256: e.sha256, pcm: w.samples, rate: w.rate, ms: w.ms };
    s.totalMs += w.ms; s.phraseList.push(x); s.byId.set(x.id, x); push(s.phrases, meta.key, x);
}
function fingerprintOf(s) {
    if (!s.clipList.length && !s.phraseList.length) return '';
    const by = k => (a, b) => a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0;
    return hash(JSON.stringify([
        s.clipList.map(({ id, cls, sha256, gainDb }) => ({ id, cls, sha256, gainDb })).sort(by('id')),
        s.phraseList.map(({ identity16, id, renderKey, norm, sha256 }) => ({ identity16, id, renderKey, norm, sha256, k: identity16 + '|' + id })).sort(by('k')).map(({ k, ...x }) => x),
    ]));
}
function scan(dir, phrasesFile, limits) {
    const s = empty(), err = (file, reason) => s.errors.push({ file, reason });
    let root;
    try { root = realpathSync(dir); } catch { return s; }
    const clipsDir = join(dir, 'clips');
    let cm = null;
    try { cm = readManifest(root, clipsDir); if (cm && !Array.isArray(cm.clips)) reject('bad_manifest'); } catch (e) { cm = null; err('clips/manifest.json', e.reason || 'bad_manifest'); }
    (cm?.clips || []).forEach((e, i) => {
        try {
            const gainDb = checkClip(e, s, limits), w = checkBytes(readEntryFile(clipsDir, e.file, limits), e.sha256, limits);
            checkClipAudio(w, e.cls, s, limits); acceptClip(s, e, gainDb, w);
        } catch (x) { err(`clips/manifest.json#${i}`, x.reason || 'bad_manifest'); }
    });
    let allow = null;
    try { const a = loadPhraseAllowlist(dir, phrasesFile); allow = a.map; s.errors.push(...a.errors); } catch { err('config/phrases.json', 'bad_manifest'); }
    const phrasesDir = join(dir, 'phrases');
    let names = [];
    try { names = readdirSync(phrasesDir).sort(); } catch { }
    for (const name of names) {
        const md = join(phrasesDir, name), rel = `phrases/${safeName(name)}`;
        try { if (name.startsWith('.') || !statSync(md).isDirectory()) continue; } catch { continue; }
        let m;
        try {
            if (!HEX16.test(name)) reject('bad_identity_dir');
            m = readManifest(root, md);
            if (!m) continue;
            if (m.identity16 !== name) reject('bad_identity_dir');
            if (typeof m.engine !== 'string' || !Array.isArray(m.entries)) reject('bad_manifest');
        } catch (e) { err(`${rel}/manifest.json`, e.reason || 'bad_manifest'); continue; }
        m.entries.forEach((e, i) => {
            try {
                const meta = checkPhrase(e, name, allow, s, limits), w = checkBytes(readEntryFile(md, e.file, limits), e.sha256, limits);
                checkPhraseAudio(w, meta.norm, s, limits); acceptPhrase(s, name, e, meta, w);
            } catch (x) { err(`${rel}/manifest.json#${i}`, x.reason || 'bad_manifest'); }
        });
    }
    s.fp = fingerprintOf(s);
    return s;
}
export class ReactionAudioCache {
    constructor(dir, { phrasesFile = PHRASES_FILE, limits = LIBRARY_LIMITS } = {}) {
        this.dir = dir; this.phrasesFile = phrasesFile; this.limits = { ...LIBRARY_LIMITS, ...limits }; this.state = empty(); this.loadedAt = null;
    }
    /** Synchronous, never throws, swaps all-or-nothing. */
    reload() {
        let next;
        try { next = scan(this.dir, this.phrasesFile, this.limits); }
        catch { next = empty(); next.errors.push({ file: '.', reason: 'bad_manifest' }); }
        this.state = next; this.loadedAt = new Date().toISOString();
        return this.status();
    }
    fingerprint() { return this.state.fp; }
    status() {
        const s = this.state, clips = {}, phrases = {};
        for (const cls of NONVERBAL_CLASSES) if (s.clips.get(cls)?.length) clips[cls] = s.clips.get(cls).length;
        for (const x of s.phraseList) phrases[x.identity16] = (phrases[x.identity16] || 0) + 1;
        return { clips, phrases, errors: s.errors.map(e => ({ ...e })), loadedAt: this.loadedAt, hash8: s.fp.slice(0, 8) };
    }
    kinds() { return NONVERBAL_CLASSES.filter(cls => this.state.clips.get(cls)?.length); }
    // Round-robin: with two or more takes the previous take is never repeated.
    rotate(key, list) { const rot = this.state.rot, i = ((rot.get(key) ?? -1) + 1) % list.length; rot.set(key, i); return list[i]; }
    at(x, rate) {
        if (rate == null || rate === x.rate) return { pcm: x.pcm, rate: x.rate };
        if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) throw new Error('Invalid sample rate');
        const memo = this.state.memo, k = `${x.id}@${rate}`;
        if (!memo.has(k)) { if (memo.size >= 256) memo.clear(); memo.set(k, resample(x.pcm, x.rate, rate)); }
        return { pcm: memo.get(k), rate };
    }
    clip(cls, rate = null) {
        const list = this.state.clips.get(cls);
        if (!list?.length) return null;
        const x = this.rotate('clip|' + cls, list), a = this.at(x, rate);
        return { id: x.id, cls: x.cls, pcm: a.pcm, rate: a.rate, ms: x.ms, gainDb: x.gainDb };
    }
    hasPhrase(id16, text, renderKey) { return !!this.state.phrases.get(`${id16}|${renderKey}|${normalizePhrase(text)}`)?.length; }
    phrase(id16, text, renderKey, rate = null) {
        const key = `${id16}|${renderKey}|${normalizePhrase(text)}`, list = this.state.phrases.get(key);
        if (!list?.length) return null;
        const x = this.rotate('phrase|' + key, list), a = this.at(x, rate);
        return { id: x.id, pcm: a.pcm, rate: a.rate, ms: x.ms, source: x.source };
    }
    entries(id16) {
        const s = this.state;
        return { clips: s.clipList.map(({ id, cls, gainDb }) => ({ id, cls, gainDb })), phrases: s.phraseList.filter(x => x.identity16 === id16).map(({ id, text, renderKey, source }) => ({ id, text, renderKey, source })) };
    }
    pcm(id, rate = null) { const x = this.state.byId.get(id); return x ? this.at(x, rate) : null; }
}
function ensureDir(p) { mkdirSync(p, { recursive: true, mode: 0o700 }); chmodSync(p, 0o700); }
function writeAtomic(path, data) {
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(tmp, data, { mode: 0o600 }); renameSync(tmp, path); }
    catch (e) { try { unlinkSync(tmp); } catch { } throw e; }
    chmodSync(path, 0o600);
}
export function writeManifestAtomic(path, obj) { writeAtomic(path, JSON.stringify(obj, null, 2) + '\n'); }
function writeManifestChecked(path, obj) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (Buffer.byteLength(text) > LIBRARY_LIMITS.manifestBytes) reject('too_large');
    writeAtomic(path, text);
}
function openLibrary(dir, opts, ...dirs) {
    ensureDir(dir);
    const lib = new ReactionAudioCache(dir, opts), root = realpathSync(dir);
    // Never write through a symlinked clips/ or phrases/ directory that leaves the library.
    for (const p of dirs) if (existsSync(p) && !inside(realpathSync(p), root)) reject('outside_dir');
    lib.reload();
    return { lib, root };
}
/** Validates exactly as reload() does (throws Error(reason)), then writes the WAV before the manifest. */
export function addClip(dir, { cls, bytes, gainDb = 0, attest } = {}, opts = {}) {
    if (attest !== 'nonverbal') throw new Error('Clip requires nonverbal attestation');
    const md = join(dir, 'clips'), { lib, root } = openLibrary(dir, opts, md), s = lib.state;
    const m = readManifest(root, md) || { version: 1, clips: [] };
    if (!Array.isArray(m.clips)) reject('bad_manifest');
    if (!NONVERBAL_CLASSES.includes(cls)) reject('unknown_class');
    const used = m.clips.map(e => typeof e?.id === 'string' && e.id.startsWith(cls + '-') ? Number(e.id.slice(cls.length + 1)) : 0).filter(Number.isSafeInteger);
    const id = `${cls}-${Math.max(0, ...used) + 1}`;
    const e = { id, cls, file: id + '.wav', sha256: Buffer.isBuffer(bytes) ? hash(bytes) : '', attest: 'nonverbal', gainDb };
    const g = checkClip(e, s, lib.limits), w = checkBytes(bytes, e.sha256, lib.limits);
    checkClipAudio(w, cls, s, lib.limits);
    e.gainDb = g;
    writeAtomic(join(md, e.file), bytes);
    writeManifestChecked(join(md, 'manifest.json'), { ...m, clips: [...m.clips, e] });
    return e;
}
export function addPhrase(dir, { identity16: id16, engine, text, renderKey, preset, source = 'tts', attest = null, bytes } = {}, opts = {}) {
    if (typeof id16 !== 'string' || !HEX16.test(id16)) reject('bad_identity_dir');
    if (typeof engine !== 'string' || !ID.test(engine)) reject('bad_manifest');
    const md = join(dir, 'phrases', id16), { lib, root } = openLibrary(dir, opts, dirname(md), md), s = lib.state;
    const allow = loadPhraseAllowlist(dir, lib.phrasesFile).map;
    const m = readManifest(root, md) || { version: 1, identity16: id16, engine, entries: [] };
    if (m.identity16 !== id16) reject('bad_identity_dir');
    if (!Array.isArray(m.entries)) reject('bad_manifest');
    let t;
    try { t = validatePhraseText(text); } catch { reject('bad_text'); }
    const norm = normalizePhrase(t), sha256 = Buffer.isBuffer(bytes) ? hash(bytes) : '';
    const id = hash(`${renderKey}|${norm}|${sha256}`).slice(0, 16), existing = m.entries.findIndex(x => x?.id === id);
    // Same key, text and bytes: idempotent when already accepted; a rejected stale entry is replaced.
    if (existing >= 0 && s.byId.has(id)) return m.entries[existing];
    const entries = m.entries.filter((_, i) => i !== existing);
    const e = { id, text: t, norm, renderKey, preset, source, ...(attest != null ? { attest } : {}), file: id + '.wav', sha256, ms: 0, createdAt: new Date().toISOString() };
    const meta = checkPhrase(e, id16, allow, s, lib.limits), w = checkBytes(bytes, sha256, lib.limits);
    checkPhraseAudio(w, meta.norm, s, lib.limits);
    e.ms = Math.round(w.ms);
    ensureDir(dirname(md));
    writeAtomic(join(md, e.file), bytes);
    writeManifestChecked(join(md, 'manifest.json'), { ...m, entries: [...entries, e] });
    return e;
}
/** Removes the entry from whichever manifest holds it and unlinks its file. */
export function removeEntry(dir, id) {
    if (typeof id !== 'string' || !ID.test(id)) return false;
    let root;
    try { root = realpathSync(dir); } catch { return false; }
    const targets = [[join(dir, 'clips'), 'clips']];
    try { for (const name of readdirSync(join(dir, 'phrases')).sort()) if (HEX16.test(name)) targets.push([join(dir, 'phrases', name), 'entries']); } catch { }
    for (const [md, key] of targets) {
        let m;
        try { m = readManifest(root, md); } catch { continue; }
        const i = Array.isArray(m?.[key]) ? m[key].findIndex(e => e?.id === id) : -1;
        if (i < 0) continue;
        const [e] = m[key].splice(i, 1);
        writeManifestAtomic(join(md, 'manifest.json'), m);
        if (e.file === id + '.wav') try { unlinkSync(join(md, e.file)); } catch { }
        return true;
    }
    return false;
}
