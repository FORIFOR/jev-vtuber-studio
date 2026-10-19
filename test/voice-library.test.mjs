import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../src/wav.mjs';
import { hash } from '../src/util.mjs';
import { JEV_REACTIONS } from '../public/avatar-rig.mjs';
import { NONVERBAL_CLASSES, CLIP_MS, LIBRARY_LIMITS, PHRASES_FILE, normalizePhrase, validatePhraseText, identity16, loadPhraseAllowlist, ReactionAudioCache, writeManifestAtomic, addClip, addPhrase, removeEntry } from '../src/reaction-audio.mjs';

const sine = (sec, hz, rate, amp) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const tone = (sec, hz = 440, rate = 24000, amp = .3) => writeWav(sine(sec, hz, rate, amp), rate);
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-voice-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const ID16 = 'a1b2c3d4e5f60718', KEY = 'a'.repeat(64), KEY2 = 'b'.repeat(64);
// Windows CI cannot create file symlinks without privileges and has no POSIX modes.
const WIN = process.platform === 'win32', LINKED = ['symlink', 'outside_dir'];
const clipEntry = (id, cls, bytes, extra = {}) => ({ id, cls, file: id + '.wav', sha256: hash(bytes), attest: 'nonverbal', gainDb: 0, ...extra });
function writeClips(dir, entries, files = {}) {
    mkdirSync(join(dir, 'clips'), { recursive: true });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, 'clips', name), bytes);
    writeFileSync(join(dir, 'clips', 'manifest.json'), typeof entries === 'string' ? entries : JSON.stringify({ version: 1, clips: entries }));
}
let seq = 0;
const phraseEntry = (text, bytes, extra = {}) => { const id = (++seq).toString(16).padStart(16, '0'); return { id, text, norm: normalizePhrase(text), renderKey: KEY, preset: 'happy', source: 'tts', file: id + '.wav', sha256: hash(bytes), ms: 0, createdAt: '2026-09-25T00:00:00.000Z', ...extra }; };
function writePhrases(dir, id16, entries, bytes, manifest = {}) {
    const md = join(dir, 'phrases', id16); mkdirSync(md, { recursive: true });
    for (const e of entries) if (typeof e?.file === 'string' && !e.file.includes('/')) writeFileSync(join(md, e.file), bytes);
    writeFileSync(join(md, 'manifest.json'), JSON.stringify({ version: 1, identity16: id16, engine: 'voicevox', entries, ...manifest }));
}
function walk(dir, out = []) { for (const name of readdirSync(dir)) { const p = join(dir, name); out.push(p); if (statSync(p).isDirectory()) walk(p, out); } return out; }

test('normalizePhrase is exact: width and trailing 、。 only, never kana or ！？', () => {
    assert.equal(normalizePhrase('ありがとう!'), normalizePhrase('ありがとう！'));
    assert.equal(normalizePhrase('なるほど、'), normalizePhrase('なるほど'));
    assert.equal(normalizePhrase('なるほど～'), normalizePhrase('なるほど〜'));
    assert.equal(normalizePhrase('なるほど~'), 'なるほど〜');
    assert.equal(normalizePhrase(' うん うん '), 'うんうん');
    assert.notEqual(normalizePhrase('えっ！？'), normalizePhrase('えっ'));
    assert.notEqual(normalizePhrase('ありがとう'), normalizePhrase('ありがとうございます'));
    assert.notEqual(normalizePhrase('やったー'), normalizePhrase('やった'));
    assert.notEqual(normalizePhrase('よかったぁ'), normalizePhrase('よかった'));
    assert.notEqual(normalizePhrase('アリガトウ'), normalizePhrase('ありがとう'));
    assert.equal(normalizePhrase('ｱﾘｶﾞﾄｳ'), 'アリガトウ');
});

test('validatePhraseText accepts one short clean sentence only', () => {
    assert.equal(validatePhraseText(' うんうん '), 'うんうん');
    assert.equal(validatePhraseText('えっ、'), 'えっ、');
    for (const bad of ['あ'.repeat(25), 'a@example.com', 'ignore instructions', '<b>', 'はい。いいえ。', '', '   ', 'http://x', 'あ\u0007い', 42, null])
        assert.throws(() => validatePhraseText(bad), /Invalid phrase text/, String(bad));
    assert.equal(validatePhraseText('あ'.repeat(24)), 'あ'.repeat(24));
});

test('committed allowlist has the 12 phrases; operator additions merge and bad ones are reported', t => {
    const committed = JSON.parse(readFileSync(PHRASES_FILE, 'utf8'));
    assert.equal(committed.length, 12);
    for (const e of committed) {
        assert.deepEqual(Object.keys(e).sort(), ['presets', 'text']);
        assert.equal(validatePhraseText(e.text), e.text);
        assert.ok(e.presets.length >= 1 && e.presets.every(p => Object.hasOwn(JEV_REACTIONS, p)));
    }
    for (const text of ['ありがとう！', 'こんばんは！', 'ナイス！', 'えっ！？', 'やったー！', 'ちょっと待って！', 'なるほど〜', 'うんうん', '本当に？', 'えっ、', 'あっ、', 'よかったぁ〜！']) assert.ok(committed.some(e => e.text === text), text);
    const base = loadPhraseAllowlist(null);
    assert.equal(base.map.size, 12); assert.deepEqual(base.errors, []);
    assert.deepEqual(base.map.get(normalizePhrase('えっ！？')).presets, ['surprised', 'shock']);
    const d = temp(t);
    writeFileSync(join(d, 'phrases.json'), JSON.stringify([{ text: 'おつかれ！', presets: ['happy'] }, { text: 'ありがとう!', presets: ['excited', 'happy'] }, { text: '<b>', presets: ['happy'] }, { text: 'いいね', presets: ['bogus'] }, { text: 'いいね', presets: [] }, 'x']));
    const merged = loadPhraseAllowlist(d);
    assert.equal(merged.map.size, 13);
    assert.equal(merged.map.get(normalizePhrase('おつかれ！')).text, 'おつかれ！');
    assert.deepEqual(merged.map.get(normalizePhrase('ありがとう！')), { text: 'ありがとう！', presets: ['happy', 'neutral', 'nod', 'embarrassed', 'excited'] });
    assert.deepEqual(merged.errors, [{ file: 'phrases.json#2', reason: 'bad_text' }, { file: 'phrases.json#3', reason: 'bad_preset' }, { file: 'phrases.json#4', reason: 'bad_preset' }, { file: 'phrases.json#5', reason: 'bad_manifest' }]);
    writeFileSync(join(d, 'phrases.json'), '{nope');
    const broken = loadPhraseAllowlist(d);
    assert.equal(broken.map.size, 12); assert.deepEqual(broken.errors, [{ file: 'phrases.json', reason: 'bad_manifest' }]);
    const bad = join(d, 'bad.json');
    for (const body of ['nope', '[]', '[{"text":"<b>","presets":["happy"]}]', '[{"text":"うん","presets":["happy"]},{"text":"うん。","presets":["nod"]}]']) {
        writeFileSync(bad, body);
        assert.throws(() => loadPhraseAllowlist(d, bad), /Invalid phrases allowlist/);
    }
});

test('identity16 is the first 16 hex of sha256(JSON(identity))', () => {
    const id = ['aivisspeech', 'model-uuid', 888753760];
    assert.equal(identity16(id), hash(JSON.stringify(id)).slice(0, 16));
    assert.match(identity16({ engine: 'voicevox', speaker: 3 }), /^[a-f0-9]{16}$/);
});

test('addClip + reload accepts an attested wordless tone; addClip validates like reload', t => {
    const d = join(temp(t), 'voice');
    assert.throws(() => addClip(d, { cls: 'gasp', bytes: tone(.3) }), /Clip requires nonverbal attestation/);
    assert.throws(() => addClip(d, { cls: 'gasp', bytes: tone(.3), attest: 'yes' }), /Clip requires nonverbal attestation/);
    const e = addClip(d, { cls: 'gasp', bytes: tone(.3), attest: 'nonverbal' });
    assert.deepEqual(e, { id: 'gasp-1', cls: 'gasp', file: 'gasp-1.wav', sha256: hash(tone(.3)), attest: 'nonverbal', gainDb: 0 });
    assert.equal(addClip(d, { cls: 'gasp', bytes: tone(.3, 520), attest: 'nonverbal', gainDb: -3 }).id, 'gasp-2');
    assert.equal(addClip(d, { cls: 'laugh_small', bytes: tone(.8, 300), attest: 'nonverbal' }).id, 'laugh_small-1');
    for (const [spec, reason] of [[{ cls: 'eh', bytes: tone(.3) }, 'unknown_class'], [{ cls: 'gasp', bytes: tone(1.2) }, 'bad_duration'], [{ cls: 'gasp', bytes: tone(.05) }, 'bad_duration'], [{ cls: 'gasp', bytes: writeWav(new Float32Array(7200), 24000) }, 'silent'],
        [{ cls: 'gasp', bytes: tone(.3, 440, 24000, 1) }, 'clipped'], [{ cls: 'gasp', bytes: tone(.3), gainDb: 9 }, 'bad_gain'], [{ cls: 'gasp', bytes: Buffer.from('not a wav, not a wav, not a wav, not a wav!!') }, 'decode_failed'], [{ cls: 'gasp', bytes: 'text' }, 'decode_failed']])
        assert.throws(() => addClip(d, { ...spec, attest: 'nonverbal' }), new RegExp(`^Error: ${reason}$`), reason);
    const lib = new ReactionAudioCache(d), st = lib.reload();
    assert.deepEqual(st.clips, { gasp: 2, laugh_small: 1 }); assert.deepEqual(st.errors, []); assert.match(st.loadedAt, /^\d{4}-/);
    assert.match(st.hash8, /^[a-f0-9]{8}$/); assert.equal(st.hash8, lib.fingerprint().slice(0, 8));
    assert.deepEqual(lib.entries(ID16), { clips: [{ id: 'gasp-1', cls: 'gasp', gainDb: 0 }, { id: 'gasp-2', cls: 'gasp', gainDb: -3 }, { id: 'laugh_small-1', cls: 'laugh_small', gainDb: 0 }], phrases: [] });
    const c = lib.clip('laugh_small');
    assert.equal(c.id, 'laugh_small-1'); assert.equal(c.rate, 24000); assert.ok(Math.abs(c.ms - 800) < 1e-9); assert.equal(c.gainDb, 0);
    assert.equal(lib.pcm('laugh_small-1').pcm, c.pcm); assert.equal(lib.pcm('nope'), null);
    for (let i = 0; i < 2; i++) addClip(d, { cls: 'gasp', bytes: tone(.3, 600 + i * 50), attest: 'nonverbal' });
    assert.throws(() => addClip(d, { cls: 'gasp', bytes: tone(.3, 900), attest: 'nonverbal' }), /^Error: too_many_takes$/);
});

test('every rejection reason is produced by a hand-written manifest, and nothing invalid is accepted', t => {
    const root = temp(t), outside = temp(t), seen = new Set();
    const good = tone(.3), silent = writeWav(new Float32Array(7200), 24000), garbage = Buffer.from('RIFF\0\0\0\0WAVEjunkjunkjunkjunkjunkjunkjunkjunkjunk');
    const phrase = tone(.5, 500), ok = 'ありがとう！';
    writeFileSync(join(outside, 'x.wav'), good);
    const cases = [
        ['bad_manifest', d => writeClips(d, '{not json'), {}],
        ['bad_manifest', d => writeClips(d, [42]), {}],
        ['bad_manifest', d => writePhrases(d, ID16, [phraseEntry(ok, phrase)], phrase, { entries: 'x' }), {}],
        ['bad_id', d => writeClips(d, [clipEntry('Gasp 1', 'gasp', good)], { 'Gasp 1.wav': good }), {}],
        ['bad_file', d => { writeFileSync(join(d, 'x.wav'), good); writeClips(d, [clipEntry('x', 'gasp', good, { file: '../x.wav' })]); }, {}],
        ['bad_file', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good)]), {}],
        ['unknown_class', d => writeClips(d, [clipEntry('eh-1', 'eh', good)], { 'eh-1.wav': good }), {}],
        ['not_attested', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { attest: undefined })], { 'gasp-1.wav': good }), {}],
        ['has_text', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { text: 'えっ' })], { 'gasp-1.wav': good }), {}],
        ['symlink', d => { writeClips(d, [clipEntry('gasp-1', 'gasp', good)]); symlinkSync(join(outside, 'x.wav'), join(d, 'clips', 'gasp-1.wav')); }, {}],
        ['outside_dir', d => { const o = mkdtempSync(join(outside, 'clips-')); writeClips(o, [clipEntry('gasp-1', 'gasp', good)], { 'gasp-1.wav': good }); symlinkSync(join(o, 'clips'), join(d, 'clips')); }, {}],
        ['too_large', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good)], { 'gasp-1.wav': good }), { limits: { fileBytes: 1000 } }],
        ['sha_mismatch', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { sha256: '0'.repeat(64) })], { 'gasp-1.wav': good }), {}],
        ['sha_mismatch', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { sha256: 'nope' })], { 'gasp-1.wav': good }), {}],
        ['decode_failed', d => writeClips(d, [clipEntry('gasp-1', 'gasp', garbage)], { 'gasp-1.wav': garbage }), {}],
        ['bad_duration', d => { const b = tone(1.2); writeClips(d, [clipEntry('gasp-1', 'gasp', b)], { 'gasp-1.wav': b }); }, {}],
        ['silent', d => writeClips(d, [clipEntry('gasp-1', 'gasp', silent)], { 'gasp-1.wav': silent }), {}],
        ['clipped', d => { const b = tone(.3, 440, 24000, 1); writeClips(d, [clipEntry('gasp-1', 'gasp', b)], { 'gasp-1.wav': b }); }, {}],
        ['bad_gain', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { gainDb: 9 })], { 'gasp-1.wav': good }), {}],
        ['bad_gain', d => writeClips(d, [clipEntry('gasp-1', 'gasp', good, { gainDb: '0' })], { 'gasp-1.wav': good }), {}],
        ['too_many_takes', d => { const files = {}, list = []; for (let i = 1; i <= 5; i++) { const b = tone(.3, 400 + i * 20); files[`gasp-${i}.wav`] = b; list.push(clipEntry(`gasp-${i}`, 'gasp', b)); } writeClips(d, list, files); }, {}, { clips: { gasp: 4 } }],
        ['too_many_clips', d => writeClips(d, ['gasp', 'hmm', 'sigh'].map(c => clipEntry(`${c}-1`, c, good)), { 'gasp-1.wav': good, 'hmm-1.wav': good, 'sigh-1.wav': good }), { limits: { clips: 2 } }, { clips: { gasp: 1, hmm: 1 } }],
        ['total_duration', d => writeClips(d, ['gasp', 'hmm'].map(c => clipEntry(`${c}-1`, c, good)), { 'gasp-1.wav': good, 'hmm-1.wav': good }), { limits: { totalMs: 500 } }, { clips: { gasp: 1 } }],
        ['bad_identity_dir', d => writePhrases(d, 'not-an-identity', [phraseEntry(ok, phrase)], phrase, { identity16: 'not-an-identity' }), {}],
        ['bad_identity_dir', d => writePhrases(d, ID16, [phraseEntry(ok, phrase)], phrase, { identity16: 'f'.repeat(16) }), {}],
        ['bad_text', d => writePhrases(d, ID16, [phraseEntry('<b>', phrase)], phrase), {}],
        ['norm_mismatch', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { norm: ok })], phrase), {}],
        ['not_allowlisted', d => writePhrases(d, ID16, [phraseEntry('こんにちは', phrase)], phrase), {}],
        ['bad_preset', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { preset: 'shock' })], phrase), {}],
        ['bad_render_key', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { renderKey: 'xyz' })], phrase), {}],
        ['bad_source', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { source: 'human' })], phrase), {}],
        ['not_attested', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { source: 'recorded' })], phrase), {}],
        ['bad_file', d => writePhrases(d, ID16, [phraseEntry(ok, phrase, { file: 'take.wav' })], phrase), {}],
        ['bad_id', d => { const e = phraseEntry(ok, phrase); writePhrases(d, ID16, [e, { ...e }], phrase); }, {}, { phrases: { [ID16]: 1 } }],
        ['bad_duration', d => { const b = tone(.1, 500); writePhrases(d, ID16, [phraseEntry(ok, b)], b); }, {}],
        ['bad_rate_per_char', d => { const b = tone(2.5, 500); writePhrases(d, ID16, [phraseEntry('うんうん', b, { preset: 'nod' })], b); }, {}],
        ['too_many_phrases', d => writePhrases(d, ID16, [phraseEntry(ok, phrase), phraseEntry(ok, phrase)], phrase), { limits: { phrases: 1 } }, { phrases: { [ID16]: 1 } }],
        ['too_many_takes', d => writePhrases(d, ID16, [1, 2, 3, 4, 5, 6].map(() => phraseEntry(ok, phrase)), phrase), {}, { phrases: { [ID16]: 5 } }],
        ['symlink', d => { writePhrases(d, ID16, [phraseEntry(ok, phrase)], phrase); const m = join(d, 'phrases', ID16, 'manifest.json'), o = join(outside, `m-${seq}.json`); writeFileSync(o, readFileSync(m)); rmSync(m); symlinkSync(o, m); }, {}],
        ['outside_dir', d => { const o = mkdtempSync(join(outside, 'id-')); writePhrases(o, ID16, [phraseEntry(ok, phrase)], phrase); mkdirSync(join(d, 'phrases')); symlinkSync(join(o, 'phrases', ID16), join(d, 'phrases', ID16)); }, {}],
    ];
    cases.filter(([reason]) => !WIN || !LINKED.includes(reason)).forEach(([reason, build, opts, accepted = {}], i) => {
        const d = join(root, `case-${i}`); mkdirSync(d); build(d);
        const lib = new ReactionAudioCache(d, opts);
        let st;
        assert.doesNotThrow(() => { st = lib.reload(); });
        const got = st.errors.map(e => e.reason);
        assert.ok(got.includes(reason), `case ${i}: expected ${reason}, got ${JSON.stringify(st.errors)}`);
        assert.deepEqual({ clips: st.clips, phrases: st.phrases }, { clips: {}, phrases: {}, ...accepted }, `case ${i} (${reason})`);
        st.errors.forEach(e => { assert.equal(typeof e.file, 'string'); seen.add(e.reason); });
        if (!accepted.clips && !accepted.phrases) { assert.equal(lib.fingerprint(), ''); assert.deepEqual(lib.kinds(), []); }
    });
    const spec = ['bad_manifest', 'bad_id', 'bad_file', 'unknown_class', 'not_attested', 'has_text', 'symlink', 'outside_dir', 'too_large', 'sha_mismatch', 'decode_failed', 'bad_duration', 'silent', 'clipped', 'bad_gain', 'too_many_takes', 'too_many_clips',
        'bad_identity_dir', 'bad_text', 'norm_mismatch', 'not_allowlisted', 'bad_preset', 'bad_render_key', 'bad_source', 'bad_rate_per_char', 'too_many_phrases', 'total_duration'];
    assert.deepEqual(spec.filter(r => !seen.has(r) && !(WIN && LINKED.includes(r))), []);
    // Malformed JSON: empty library, a single error, never a throw.
    const d = join(root, 'malformed'); mkdirSync(d); writeClips(d, '{');
    const lib = new ReactionAudioCache(d);
    assert.deepEqual(lib.reload(), { clips: {}, phrases: {}, errors: [{ file: 'clips/manifest.json', reason: 'bad_manifest' }], loadedAt: lib.loadedAt, hash8: '' });
    assert.equal(lib.clip('gasp'), null);
});

test('reload swaps all-or-nothing and never throws on a missing dir or a broken committed allowlist', t => {
    const d = temp(t);
    addClip(d, { cls: 'gasp', bytes: tone(.3), attest: 'nonverbal' });
    const lib = new ReactionAudioCache(d);
    assert.deepEqual(lib.status(), { clips: {}, phrases: {}, errors: [], loadedAt: null, hash8: '' });
    assert.deepEqual(lib.reload().clips, { gasp: 1 });
    writeFileSync(join(d, 'clips', 'manifest.json'), '[');
    assert.deepEqual(lib.reload().clips, {}); assert.equal(lib.clip('gasp'), null);
    const missing = new ReactionAudioCache(join(d, 'missing')), none = missing.reload();
    assert.deepEqual(none, { clips: {}, phrases: {}, errors: [], loadedAt: missing.loadedAt, hash8: '' });
    assert.equal(missing.fingerprint(), ''); assert.deepEqual(missing.kinds(), []);
    const d2 = temp(t), bad = join(d2, 'phrases-bad.json');
    writeFileSync(bad, 'nope');
    addClip(d2, { cls: 'hmm', bytes: tone(.5), attest: 'nonverbal' });
    writePhrases(d2, ID16, [phraseEntry('ありがとう！', tone(.5, 500))], tone(.5, 500));
    const st = new ReactionAudioCache(d2, { phrasesFile: bad }).reload();
    assert.deepEqual(st.clips, { hmm: 1 }); assert.deepEqual(st.phrases, {});
    assert.ok(st.errors.some(e => e.file === 'config/phrases.json' && e.reason === 'bad_manifest'));
    assert.ok(st.errors.some(e => e.reason === 'not_allowlisted'));
});

test('fingerprint is empty for an empty library and changes when an accepted file changes by one byte', t => {
    const d = temp(t), lib = new ReactionAudioCache(d);
    lib.reload(); assert.equal(lib.fingerprint(), '');
    addClip(d, { cls: 'gasp', bytes: tone(.3, 400), attest: 'nonverbal' });
    addClip(d, { cls: 'sigh', bytes: tone(.9, 300), attest: 'nonverbal' });
    addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'ナイス！', renderKey: KEY, preset: 'excited', bytes: tone(.4, 500) });
    lib.reload();
    const before = lib.fingerprint();
    assert.match(before, /^[a-f0-9]{64}$/);
    lib.reload(); assert.equal(lib.fingerprint(), before);
    const p = join(d, 'clips', 'sigh-1.wav'), b = readFileSync(p); b[b.length - 1] ^= 1; writeFileSync(p, b);
    const st = lib.reload();
    assert.notEqual(lib.fingerprint(), before); assert.notEqual(lib.fingerprint(), '');
    assert.deepEqual(st.clips, { gasp: 1 }); assert.deepEqual(st.errors, [{ file: 'clips/manifest.json#1', reason: 'sha_mismatch' }]);
    assert.deepEqual(lib.kinds(), ['gasp']);
});

test('clip() rotates takes without an immediate repeat and memoizes resampled PCM', t => {
    const d = temp(t);
    addClip(d, { cls: 'gasp', bytes: tone(.3, 400), attest: 'nonverbal' });
    addClip(d, { cls: 'gasp', bytes: tone(.3, 700), attest: 'nonverbal' });
    addClip(d, { cls: 'breath_out', bytes: tone(.6, 200, 44100), attest: 'nonverbal' });
    const lib = new ReactionAudioCache(d); lib.reload();
    const ids = [1, 2, 3, 4, 5].map(() => lib.clip('gasp').id);
    ids.forEach((id, i) => { if (i) assert.notEqual(id, ids[i - 1]); });
    assert.deepEqual(new Set(ids), new Set(['gasp-1', 'gasp-2']));
    const a = lib.clip('gasp', 48000), b = lib.clip('gasp', 48000), c = lib.clip('gasp', 48000);
    assert.notEqual(a.id, b.id); assert.equal(c.id, a.id);
    assert.equal(c.pcm, a.pcm); assert.equal(a.rate, 48000); assert.equal(a.pcm.length, 14400);
    assert.equal(lib.pcm(a.id, 48000).pcm, a.pcm);
    assert.notEqual(lib.pcm(a.id).pcm, a.pcm); assert.equal(lib.pcm(a.id).rate, 24000);
    const single = [lib.clip('breath_out'), lib.clip('breath_out')];
    assert.equal(single[0].id, single[1].id); assert.equal(single[0].rate, 44100);
    assert.equal(lib.clip('breath_out', 44100).pcm, single[0].pcm);
    assert.equal(lib.clip('laugh_big'), null);
    assert.throws(() => lib.clip('gasp', 1.5), /Invalid sample rate/);
});

test('phrase() matches the exact identity, render key and normalized text only', t => {
    const d = temp(t), bytes = tone(.5, 500);
    const e = addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'ありがとう！', renderKey: KEY, preset: 'happy', bytes });
    assert.equal(e.id, hash(`${KEY}|${normalizePhrase('ありがとう！')}|${hash(bytes)}`).slice(0, 16));
    assert.equal(e.file, e.id + '.wav'); assert.equal(e.source, 'tts'); assert.equal(e.ms, 500); assert.equal(e.norm, 'ありがとう!'); assert.ok(!('attest' in e));
    const e2 = addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'ありがとう！', renderKey: KEY, preset: 'nod', bytes: tone(.5, 520) });
    const lib = new ReactionAudioCache(d); lib.reload();
    assert.ok(lib.hasPhrase(ID16, 'ありがとう!', KEY)); assert.ok(lib.hasPhrase(ID16, 'ありがとう！', KEY));
    assert.ok(!lib.hasPhrase(ID16, 'ありがとう！', KEY2)); assert.equal(lib.phrase(ID16, 'ありがとう！', KEY2), null);
    assert.equal(lib.phrase(ID16, 'ありがとう', KEY), null); assert.equal(lib.phrase(ID16, 'ありがとうございます', KEY), null);
    assert.equal(lib.phrase('f'.repeat(16), 'ありがとう！', KEY), null);
    const p = [lib.phrase(ID16, 'ありがとう！', KEY), lib.phrase(ID16, 'ありがとう！', KEY), lib.phrase(ID16, 'ありがとう！', KEY, 44100)];
    assert.notEqual(p[0].id, p[1].id); assert.equal(p[2].id, p[0].id); assert.equal(p[2].rate, 44100); assert.equal(p[0].source, 'tts');
    assert.deepEqual(new Set(p.map(x => x.id)), new Set([e.id, e2.id]));
    assert.deepEqual(lib.entries(ID16).phrases.map(x => x.id).sort(), [e.id, e2.id].sort());
    assert.deepEqual(lib.entries('f'.repeat(16)).phrases, []);
    assert.deepEqual(lib.status().phrases, { [ID16]: 2 });
    // Recorded takes need exact-text attestation; adding the same take twice is idempotent.
    assert.throws(() => addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'うんうん', renderKey: KEY, preset: 'nod', source: 'recorded', bytes: tone(.6, 480) }), /^Error: not_attested$/);
    const r = addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'うんうん', renderKey: KEY, preset: 'nod', source: 'recorded', attest: 'exact-text', bytes: tone(.6, 480) });
    assert.equal(r.attest, 'exact-text');
    assert.deepEqual(addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'うんうん', renderKey: KEY, preset: 'nod', source: 'recorded', attest: 'exact-text', bytes: tone(.6, 480) }), r);
    for (const [spec, reason] of [[{ text: 'こんにちは' }, 'not_allowlisted'], [{ preset: 'shock' }, 'bad_preset'], [{ renderKey: 'xyz' }, 'bad_render_key'], [{ text: '<b>' }, 'bad_text'], [{ source: 'human' }, 'bad_source'],
        [{ identity16: 'nope' }, 'bad_identity_dir'], [{ bytes: tone(.1, 500) }, 'bad_duration'], [{ bytes: tone(2.9, 500), text: 'うんうん', preset: 'nod' }, 'bad_rate_per_char']])
        assert.throws(() => addPhrase(d, { identity16: ID16, engine: 'voicevox', text: 'ナイス！', renderKey: KEY, preset: 'happy', bytes: tone(.4, 610), ...spec }), new RegExp(`^Error: ${reason}$`), reason);
    lib.reload();
    assert.equal(lib.phrase(ID16, 'うんうん', KEY).source, 'recorded');
});

test('kinds() lists only classes that have accepted clips, in canonical order', t => {
    const d = temp(t), lib = new ReactionAudioCache(d);
    lib.reload(); assert.deepEqual(lib.kinds(), []);
    addClip(d, { cls: 'sigh', bytes: tone(1), attest: 'nonverbal' });
    addClip(d, { cls: 'gasp', bytes: tone(.3), attest: 'nonverbal' });
    addClip(d, { cls: 'laugh_big', bytes: tone(2), attest: 'nonverbal' });
    lib.reload();
    assert.deepEqual(lib.kinds(), ['gasp', 'laugh_big', 'sigh']);
    assert.deepEqual(Object.keys(lib.status().clips), ['gasp', 'laugh_big', 'sigh']);
    assert.deepEqual(NONVERBAL_CLASSES, ['gasp', 'laugh_small', 'laugh_big', 'breath_in', 'breath_out', 'sigh', 'hmm']);
    assert.ok(NONVERBAL_CLASSES.every(c => CLIP_MS[c] > CLIP_MS.min));
});

test('writers use 0600 files and 0700 dirs, leave no .tmp files, and removeEntry unlinks', t => {
    const d = join(temp(t), 'voice');
    const clip = addClip(d, { cls: 'hmm', bytes: tone(.5), attest: 'nonverbal' });
    const phrase = addPhrase(d, { identity16: ID16, engine: 'sbv2', text: 'やったー！', renderKey: KEY, preset: 'excited', bytes: tone(.5, 500) });
    writeManifestAtomic(join(d, 'extra', 'deep', 'manifest.json'), { version: 1 });
    const all = [d, ...walk(d)];
    assert.ok(all.every(p => !p.endsWith('.tmp')));
    if (!WIN) for (const p of all) assert.equal(statSync(p).mode & 0o777, statSync(p).isDirectory() ? 0o700 : 0o600, p);
    assert.deepEqual(JSON.parse(readFileSync(join(d, 'extra', 'deep', 'manifest.json'), 'utf8')), { version: 1 });
    const m = JSON.parse(readFileSync(join(d, 'phrases', ID16, 'manifest.json'), 'utf8'));
    assert.equal(m.identity16, ID16); assert.equal(m.engine, 'sbv2'); assert.deepEqual(m.entries, [phrase]);
    assert.equal(removeEntry(d, 'nope'), false); assert.equal(removeEntry(d, '../clips/hmm-1'), false); assert.equal(removeEntry(d, 42), false);
    assert.equal(removeEntry(d, clip.id), true);
    assert.ok(!existsSync(join(d, 'clips', 'hmm-1.wav')));
    assert.equal(removeEntry(d, phrase.id), true);
    assert.ok(!existsSync(join(d, 'phrases', ID16, phrase.file)));
    assert.equal(removeEntry(d, clip.id), false);
    const st = new ReactionAudioCache(d).reload();
    assert.deepEqual([st.clips, st.phrases, st.errors, st.hash8], [{}, {}, [], '']);
    assert.ok(walk(d).every(p => !p.endsWith('.tmp')));
    // A symlinked clips/ directory that leaves the library is never written through.
    if (WIN) return;
    const d2 = temp(t), o = temp(t);
    symlinkSync(o, join(d2, 'clips'));
    assert.throws(() => addClip(d2, { cls: 'gasp', bytes: tone(.3), attest: 'nonverbal' }), /^Error: outside_dir$/);
    assert.deepEqual(readdirSync(o), []);
});

test('the 120 s total decoded-duration cap is enforced across the library', t => {
    assert.equal(LIBRARY_LIMITS.totalMs, 120000);
    const d = temp(t), bytes = tone(3, 500, 8000), text = 'ちょっと待って！';
    const entries = Array.from({ length: 41 }, (_, i) => phraseEntry(text, bytes, { preset: 'surprised', renderKey: (i % 9).toString(16).repeat(64) }));
    writePhrases(d, ID16, entries, bytes);
    const lib = new ReactionAudioCache(d), st = lib.reload();
    assert.deepEqual(st.phrases, { [ID16]: 40 });
    assert.deepEqual(st.errors, [{ file: `phrases/${ID16}/manifest.json#40`, reason: 'total_duration' }]);
    assert.throws(() => addPhrase(d, { identity16: ID16, engine: 'voicevox', text, renderKey: 'c'.repeat(64), preset: 'shock', bytes: tone(1, 520, 8000) }), /^Error: total_duration$/);
    assert.throws(() => addClip(d, { cls: 'gasp', bytes: tone(.3), attest: 'nonverbal' }), /^Error: total_duration$/);
});
