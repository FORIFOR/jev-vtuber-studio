import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDITION_TEXT, BURN_IN, CircuitBreaker, planUnits, VoiceQualityRouter, DirectedVoice } from '../src/voice-router.mjs';
import { PROVIDERS, AIVIS_UUID, TtsError, createAdapter, createAdapters } from '../src/tts-adapters.mjs';
import { SpeechDirector, chunkDeliveryFor } from '../src/speech-director.mjs';
import { ReactionAudioCache, addClip, addPhrase, identity16, CLIP_MS, LIBRARY_LIMITS, NONVERBAL_CLASSES } from '../src/reaction-audio.mjs';
import { ClipGovernor, NONVERBAL, VOICE_FAMILIES } from '../public/voice-acting.mjs';
import { REACTIONS } from '../public/avatar-rig.mjs';
import { writeWav, readWav, levels } from '../src/wav.mjs';
import { conditionClip, INTENSITY_DB } from '../src/audio-bus.mjs';
import { validLipSync, visemeAt } from '../public/speech-visemes.mjs';
import { wavDuration } from '../src/providers.mjs';
import { setup, ledger, response } from './helpers.mjs';

const AIVIS = { aivisURL: 'http://127.0.0.1:10101', aivisStyle: 888753760, aivisSpeed: 1, aivisIntonation: 1, aivisTempo: 1 };
const SBV2 = { sbv2URL: 'http://127.0.0.1:5055', sbv2Model: 'jvnv-F1-jp', sbv2Speaker: '', sbv2Style: 'Neutral', sbv2StyleWeight: 1, sbv2Speed: 1 };
const cfg = (t, patch = {}) => Object.assign(setup(t), { mode: 'live', hostStyleMap: {}, speechDirection: 'reaction', reactionAudio: false, phraseCache: false }, AIVIS, SBV2, patch);
const sine = (sec, hz = 440, rate = 24000, amp = .3) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const tone = (sec, hz = 440, rate = 24000, amp = .3) => writeWav(sine(sec, hz, rate, amp), rate);
const forbidden = () => { throw new Error('Network forbidden'); };
const tick = (ms = 2) => new Promise(r => setTimeout(r, ms));
const code = c => e => { assert.equal(e?.code, c, `expected ${c}, got ${e?.code} ${e?.message}`); return true; };
// Engine fixture: routes by pathname, records every request, 404 for anything else.
function fixture(routes = {}, log = []) {
    const calls = [];
    const fetchFn = async (u, o = {}) => {
        const url = new URL(u); calls.push({ url, o }); log.push(url.pathname);
        const route = routes[url.pathname];
        return route ? route(url, o) : new Response('missing', { status: 404 });
    };
    return { calls, fetchFn, log };
}
const vvRoutes = (patch = {}) => ({ '/audio_query': () => response({ speedScale: 1, intonationScale: 1, volumeScale: 1 }), '/synthesis': () => new Response(tone(.2)), '/version': () => response('0.14.5'), '/initialize_speaker': () => new Response(null, { status: 204 }), ...patch });
const MANIFEST = { name: 'AivisSpeech Engine', brand_name: 'AivisSpeech', uuid: AIVIS_UUID, default_sampling_rate: 44100 };
const aivisRoutes = (patch = {}) => ({ '/version': () => response('1.2.0'), '/engine_manifest': () => response(MANIFEST), '/audio_query': () => response({ speedScale: 1, intonationScale: 1, tempoDynamicsScale: 1, kana: 'X' }), '/synthesis': () => new Response(tone(.2, 440, 44100)), '/initialize_speaker': () => new Response(null, { status: 204 }), ...patch });
const sbv2Model = (dir, styles = ['Neutral', 'Happy', 'Surprise'], speakers = ['jvnv-F1-jp']) => ({ config_path: `model_assets/${dir}/config.json`, model_path: `model_assets/${dir}/${dir}_e100.safetensors`, device: 'cpu', spk2id: Object.fromEntries(speakers.map((s, i) => [s, i])), id2spk: {}, style2id: Object.fromEntries(styles.map((s, i) => [s, i])) });
const sbv2Routes = (patch = {}) => ({ '/models/info': () => response({ 0: sbv2Model('jvnv-F1-jp') }), '/voice': () => new Response(tone(.2, 440, 44100)), ...patch });
const stRoutes = (patch = {}) => ({ '/v1/health': () => response({ status: 'ok', model: 'supertonic-3', version: '3.0.0' }), '/v1/tts': () => new Response(tone(.2)), ...patch });
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-router-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
function library(t, build) { const d = temp(t); build(d); const lib = new ReactionAudioCache(d); lib.reload(); assert.deepEqual(lib.status().errors, []); return lib; }
// A hand-written part plan (chunks must join to text).
const part = (chunks, extra = {}) => {
    let start = 0;
    const cs = chunks.map(([text, family = 'neutral', intensity = 'mid', pace = 'normal', pauseAfterMs = 0]) => { const x = { text, start, reaction: 'neutral', family, intensity, pace, ending: 'beat', interjection: false, pauseAfterMs }; start += text.length; return x; });
    return { index: 1, text: cs.map(x => x.text).join(''), head: 'neutral', intensity: 'mid', chunks: cs, clip: null, beats: [], tailMs: 0, ...extra };
};
const ACTABLE = Object.keys(REACTIONS).filter(k => !REACTIONS[k].local);
const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };

test('Aivis reading timing survives unit speeds, conditioning, finalized clip removal and the WAV LRU', async t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', speechDirection: 'jev', reactionAudio: true });
    const lib = library(t, dir => addClip(dir, { cls: 'gasp', bytes: tone(.3, 300), attest: 'nonverbal' }));
    const fx = fixture(aivisRoutes({
        '/audio_query': url => response({ accent_phrases: [{ moras: [{ vowel: url.searchParams.get('text') === '良い。' ? 'i' : 'o', vowel_length: 0 }] }] }),
        '/synthesis': (url, opts) => {
            const q = JSON.parse(opts.body), size = Math.round(24000 * .4 / q.speedScale), samples = new Float32Array(size);
            for (let i = 2400; i < size - 1200; i++) samples[i] = Math.sin(i * .1) * .2;
            return new Response(writeWav(samples, 24000));
        },
    }));
    const r = new VoiceQualityRouter(c, { ledger: ledger(), library: lib, fetchFn: fx.fetchFn });
    const plan = part([['良い。', 'joy', 'mid', 'slow', 120], ['本当。', 'surprise', 'mid', 'fast']], { clip: { cls: 'gasp', position: 'pre' } });
    const first = await r.renderPart(plan), withClip = first.lipSync;
    assert.equal(validLipSync(withClip), true); assert.equal(withClip.source, 'mixed');
    assert.ok(first.timeline.units[0].endMs - first.timeline.units[0].startMs > first.timeline.units[1].endMs - first.timeline.units[1].startMs, 'independent unit speed retained');
    const out = first.finalize({ reaction: 'neutral' });
    assert.equal(out.clip, null); assert.equal(out.lipSync.source, 'reading-estimate');
    assert.ok(withClip.cues.find(cue => cue.vowel === 'i').startMs - out.lipSync.cues.find(cue => cue.vowel === 'i').startMs > 300);
    const iCue = out.lipSync.cues.find(cue => cue.vowel === 'i'), oCue = out.lipSync.cues.find(cue => cue.vowel === 'o');
    assert.equal(visemeAt(out.lipSync, (iCue.startMs + iCue.endMs) / 2).i, 1);
    assert.equal(visemeAt(out.lipSync, (oCue.startMs + oCue.endMs) / 2).o, 1);
    assert.equal(visemeAt(out.lipSync, (iCue.endMs + oCue.startMs) / 2).n, 1);
    const callCount = fx.calls.length;
    const again = (await r.renderPart(plan)).finalize({ reaction: 'neutral' });
    assert.equal(fx.calls.length, callCount, 'timing does not trigger another audio_query on a cache hit');
    assert.deepEqual(again.lipSync, out.lipSync); assert.deepEqual(again.bytes, out.bytes);
});

test('Aivis direction off retains estimated timing without changing the adapter bytes contract or adding calls', async t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', speechDirection: 'off' });
    const fx = fixture(aivisRoutes({ '/audio_query': () => response({ accent_phrases: [{ moras: [{ vowel: 'e', vowel_length: 0 }] }] }) }));
    const voice = new DirectedVoice(c, ledger(), { fetchFn: fx.fetchFn });
    const result = await voice.synthesize('平仮名以外。');
    const out = result.finalize({ reaction: 'neutral' });
    assert.ok(Buffer.isBuffer(out.bytes)); assert.equal(out.lipSync.source, 'reading-estimate');
    assert.equal(out.lipSync.cues.every(cue => cue.vowel === 'e'), true);
    assert.deepEqual(fx.log, ['/version', '/engine_manifest', '/audio_query', '/synthesis']);
});

test('CircuitBreaker: opens after 2 failures, one half-open attempt, doubling to 60 s', () => {
    let now = 1000;
    const b = new CircuitBreaker({ now: () => now });
    assert.equal(b.state, 'closed'); assert.equal(b.allow(), true); assert.equal(b.openUntil, 0);
    assert.equal(b.failure('TTS_ENGINE_DOWN'), false); assert.equal(b.state, 'closed');
    assert.equal(b.failure('TTS_ENGINE_DOWN'), true); assert.equal(b.state, 'open'); assert.equal(b.openUntil, 16000);
    assert.equal(b.allow(), false);
    now = 16000;
    assert.equal(b.allow(), true); assert.equal(b.state, 'half_open');
    assert.equal(b.allow(), false, 'exactly one half-open attempt');
    b.release(); assert.equal(b.allow(), true, 'an attempt without a verdict frees the slot');
    b.success(); assert.equal(b.state, 'closed'); assert.equal(b.allow(), true);
    // A success reset openMs, so the next opening is 15 s again; each half-open failure doubles it up to 60 s.
    b.failure(); assert.equal(b.failure(), true); assert.equal(b.openUntil - now, 15000);
    const spans = [];
    for (let i = 0; i < 4; i++) { now = b.openUntil; assert.equal(b.allow(), true); assert.equal(b.failure('TTS_ENGINE_MISMATCH'), true); spans.push(b.openUntil - now); }
    assert.deepEqual(spans, [30000, 60000, 60000, 60000]);
    b.success(); b.failure(); b.failure(); assert.equal(b.openUntil - now, 15000);
});

test('planUnits: VOICEVOX merges a same-key interjection into one unit', t => {
    const c = cfg(t), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: forbidden }), a = r.adapters.voicevox;
    const p = new SpeechDirector(c).plan('えっ、ちょっと待って！', { reaction: 'shock' }).parts[0];
    assert.deepEqual(p.chunks.map(x => x.text), ['えっ、', 'ちょっと待って！']);
    const key = r.renderKey(chunkDeliveryFor('えっ、', 'shock'), a);
    assert.equal(key, r.renderKey(chunkDeliveryFor('ちょっと待って！', 'shock'), a));
    assert.deepEqual(planUnits(p, { maxChars: 200, expressive: true, keyOf: d => r.renderKey(d, a), firstPart: true }),
        [{ tier: 'local', text: 'えっ、ちょっと待って！', charStart: 0, charEnd: 11, delivery: { family: 'surprise', intensity: 'high', pace: 'fast' }, key, pauseAfterMs: 0, split: false }]);
});

test('planUnits: AivisSpeech with a surprise style gives 2 units with different keys', t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', speechDirection: 'jev', hostStyleMap: { surprise: 888753761 } }), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: forbidden }), a = r.adapter();
    const p = new SpeechDirector(c).plan('えっ、本当に？', { reaction: 'surprised', delivery: { reactions: ['surprised', 'neutral'] } }).parts[0];
    const u = planUnits(p, { maxChars: a.info.maxChars, expressive: a.info.expressive, keyOf: d => r.renderKey(d, a), firstPart: true });
    assert.deepEqual(u.map(x => [x.tier, x.text, x.pauseAfterMs]), [['local', 'えっ、', 120], ['local', '本当に？', 0]]);
    assert.notEqual(u[0].key, u[1].key);
    assert.equal(a.resolve(u[0].delivery).speaker, 888753761); assert.equal(a.resolve(u[1].delivery).speaker, 888753760);
});

test('planUnits: Supertonic is one local unit except around cache hits; part 0 is capped at 2 local units', t => {
    const c = cfg(t, { replyTtsProvider: 'supertonic' }), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: forbidden }), st = r.adapters.supertonic, vv = r.adapters.voicevox;
    const p = part([['えっ、', 'surprise', 'high', 'fast', 120], ['ちょっと待ってよ、', 'joy', 'mid', 'slow', 30], ['今のは本当にすごかったね。', 'worry', 'low', 'normal']]);
    const opts = (a, extra = {}) => ({ maxChars: a.info.maxChars, expressive: a.info.expressive, keyOf: d => r.renderKey(d, a), ...extra });
    assert.equal(new Set(p.chunks.map(ch => r.renderKey(ch, st))).size, 3, 'keys differ on Supertonic too (speed)');
    assert.deepEqual(planUnits(p, opts(st)).map(x => [x.tier, x.text]), [['local', p.text]]);
    assert.deepEqual(planUnits(p, opts(st, { hasPhrase: (k, text) => text === 'えっ、' })).map(x => [x.tier, x.text]), [['cache', 'えっ、'], ['local', 'ちょっと待ってよ、今のは本当にすごかったね。']]);
    assert.deepEqual(planUnits(p, opts(st, { hasPhrase: (k, text) => text === 'ちょっと待ってよ、' })).map(x => x.tier), ['local', 'cache', 'local']);
    // Expressive VOICEVOX keeps 3 distinct deliveries on later parts but only 2 calls on part 0.
    assert.equal(planUnits(p, opts(vv)).length, 3);
    const first = planUnits(p, opts(vv, { firstPart: true }));
    assert.deepEqual(first.map(x => x.text), ['えっ、', 'ちょっと待ってよ、今のは本当にすごかったね。']);
    assert.equal(first[1].key, r.renderKey(p.chunks[1], vv), 'the merged unit adopts the earlier params');
    assert.equal(first[1].pauseAfterMs, 0); assert.equal(first[0].pauseAfterMs, 120);
    // Locals separated by cache units: the last cache between two locals is given up only when all three can merge.
    const q = part([['あ、', 'joy'], ['えっ、', 'surprise'], ['い、', 'worry'], ['あっ、', 'surprise', 'high'], ['う。', 'calm']]);
    const cached = new Set(['えっ、', 'あっ、']);
    assert.deepEqual(planUnits(q, opts(vv, { firstPart: true, hasPhrase: (k, text) => cached.has(text) })).map(x => [x.tier, x.text]), [['local', 'あ、'], ['cache', 'えっ、'], ['local', 'い、あっ、う。']]);
    assert.deepEqual(planUnits(q, opts(vv, { firstPart: false, hasPhrase: (k, text) => cached.has(text) })).map(x => x.tier), ['local', 'cache', 'local', 'cache', 'local']);
    assert.deepEqual(planUnits(q, opts(vv, { firstPart: true, maxChars: 4, hasPhrase: (k, text) => cached.has(text) })).map(x => x.tier), ['local', 'cache', 'local', 'cache', 'local'], 'the cap is soft only because of maxChars');
});

test('planUnits: a 220-character part on SBV2 splits into exact substrings of ≤ 100 characters', t => {
    const c = cfg(t, { replyTtsProvider: 'sbv2' }), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: forbidden }), a = r.adapter(), d = new SpeechDirector(c);
    for (const text of ['あ'.repeat(60) + '、' + 'い'.repeat(79) + '、' + 'う'.repeat(78) + '。', 'あ'.repeat(219) + '。', 'ほし・'.repeat(73) + '。']) {
        assert.equal(text.length, 220);
        const u = planUnits(d.neutralPart(text), { maxChars: 100, expressive: true, keyOf: x => r.renderKey(x, a), firstPart: true });
        assert.equal(u.map(x => x.text).join(''), text);
        assert.ok(u.every(x => x.text.length <= 100 && x.tier === 'local' && text.slice(x.charStart, x.charEnd) === x.text), JSON.stringify(u.map(x => x.text.length)));
        assert.ok(u.length >= 3, 'three pieces cannot merge under 100 chars');
        assert.deepEqual(u.map(x => x.pauseAfterMs), [...u.slice(1).map(() => 20), 0]);
    }
    const u = planUnits(d.neutralPart('あ'.repeat(60) + '、' + 'い'.repeat(79) + '、' + 'う'.repeat(78) + '。'), { maxChars: 100, keyOf: x => r.renderKey(x, a) });
    assert.deepEqual(u.map(x => x.text.length), [61, 80, 79], 'cuts after the 、 nearest the middle');
});

test('a tampered part throws PLAN_INVARIANT before any adapter call', async t => {
    const c = cfg(t), { calls, fetchFn } = fixture(vvRoutes()), a = createAdapter('voicevox', c, fetchFn), spied = [];
    for (const m of ['synthesize', 'health', 'probe', 'resolve', 'identity', 'identity16', 'fingerprint', 'validateText', 'warmup']) { const f = a[m].bind(a); a[m] = (...args) => { spied.push(m); return f(...args); }; }
    const l = ledger(), r = new VoiceQualityRouter(c, { ledger: l, adapters: { voicevox: a } });
    const good = new SpeechDirector(c).plan('えっ、ちょっと待って！', { reaction: 'shock' }).parts[0];
    for (const mutate of [x => { x.chunks[1].text = 'ちょっと待て！'; }, x => { x.text += '！'; }, x => { x.chunks = []; }, x => { x.chunks.reverse(); }, x => { x.chunks[0].text = ''; }]) {
        const bad = structuredClone(good); mutate(bad);
        await assert.rejects(r.renderPart(bad), code('PLAN_INVARIANT'));
    }
    await assert.rejects(r.renderPart(null), code('PLAN_INVARIANT'));
    assert.deepEqual(spied, []); assert.equal(calls.length, 0); assert.deepEqual(l.calls, {});
    assert.equal(r.breakers.voicevox.state, 'closed');
    const v = new DirectedVoice(c, l, { router: r });
    await assert.rejects(v.synthesize('えっ、ちょっと待って！', undefined, { ...good, text: 'えっ、待って！' }), code('PLAN_INVARIANT'));
    assert.deepEqual(spied, []); assert.equal(calls.length, 0);
});

test('tiers: a whole-part phrase hit makes 0 fetches and 0 reservations; a partial hit keeps cache plus local', async t => {
    const c = cfg(t, { phraseCache: true }), { calls, fetchFn } = fixture(vvRoutes()), l = ledger();
    const probe = new VoiceQualityRouter(c, { ledger: l, fetchFn }), a = probe.adapter();
    const lib = library(t, d => {
        addPhrase(d, { identity16: a.identity16(), engine: 'voicevox', text: 'ありがとう！', renderKey: probe.renderKey(chunkDeliveryFor('ありがとう！', 'happy')), preset: 'happy', bytes: tone(.5, 500) });
        addPhrase(d, { identity16: a.identity16(), engine: 'voicevox', text: 'えっ、', renderKey: probe.renderKey(chunkDeliveryFor('えっ、', 'surprised')), preset: 'surprised', bytes: tone(.3, 600) });
    });
    const r = new VoiceQualityRouter(c, { ledger: l, fetchFn, library: lib }), d = new SpeechDirector(c);
    const whole = await r.renderPart(d.plan('ありがとう！', { reaction: 'happy' }).parts[0]);
    assert.deepEqual(whole.stats.tiers, { cache: 1, local: 0 }); assert.equal(whole.stats.calls, 0);
    assert.equal(calls.length, 0); assert.deepEqual(l.calls, {});
    assert.ok(Math.abs(wavDuration(whole.bytes) * 1000 - whole.durationMs) <= 1);
    assert.ok(whole.durationMs >= 480 && whole.durationMs <= 600, String(whole.durationMs));
    const p = d.plan('えっ、本当なの？', { reaction: 'surprised' }).parts[0];
    assert.deepEqual(p.chunks.map(x => x.text), ['えっ、', '本当なの？']);
    const partial = await r.renderPart(p);
    assert.deepEqual(partial.stats.tiers, { cache: 1, local: 1 }); assert.equal(partial.stats.calls, 1);
    assert.deepEqual(calls.map(x => x.url.pathname), ['/audio_query', '/synthesis']);
    assert.equal(calls[0].url.searchParams.get('text'), '本当なの？', 'only the uncached words reach the engine');
    assert.deepEqual(l.calls, { tts: 1 });
    assert.deepEqual(r.status().phrase, { hits: 2, misses: 1 });
    assert.equal(partial.timeline.units.length, 2);
    // Phrase cache off: the same text is fully local.
    c.phraseCache = false;
    assert.deepEqual((await r.renderPart(d.plan('ありがとう！', { reaction: 'happy' }).parts[0])).stats.tiers, { cache: 0, local: 1 });
});

test('direction off: no phrase take or clip airs, because there is no audition reel to hear them in', async t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', speechDirection: 'off', phraseCache: true, reactionAudio: true }), { calls, fetchFn } = fixture(aivisRoutes()), l = ledger();
    const probe = new VoiceQualityRouter(c, { ledger: l, fetchFn: forbidden }), a = probe.adapter(), neutral = { family: 'neutral', intensity: 'mid', pace: 'normal' };
    assert.equal(probe.renderKey(neutral), probe.renderKey(chunkDeliveryFor('ありがとう！', 'neutral', { intensity: 'low' })), 'a prerendered neutral take matches the off-mode neutral part');
    const lib = library(t, d => {
        addClip(d, { cls: 'gasp', bytes: tone(.3, 300), attest: 'nonverbal' });
        addPhrase(d, { identity16: a.identity16(), engine: 'aivisspeech', text: 'ありがとう！', renderKey: probe.renderKey(neutral), preset: 'neutral', source: 'recorded', attest: 'exact-text', bytes: tone(.5, 500) });
    });
    const v = new DirectedVoice(c, l, { fetchFn, library: lib });
    assert.equal(v.passThrough(), false); assert.equal(await v.audition(), null); assert.equal(calls.length, 0);
    const off = await v.synthesize('ありがとう！');
    assert.deepEqual(off.stats.tiers, { cache: 0, local: 1 }); assert.equal(off.stats.calls, 1); assert.deepEqual(l.calls, { tts: 1 });
    assert.equal(calls.find(x => x.url.pathname === '/audio_query').url.searchParams.get('text'), 'ありがとう！');
    assert.deepEqual(v.status().phrase, { hits: 0, misses: 0 });
    const clipped = await v.router.renderPart({ ...v.director.neutralPart('こんばんは。'), clip: { cls: 'gasp', position: 'pre' } });
    assert.equal(clipped.stats.clip, null); assert.equal(clipped.stats.clipSkipped, 'disabled'); assert.equal(clipped.timeline.clip, null);
    // Directed: the same take airs, and the rehearsal reel carries it (and the clip) for the operator to hear.
    c.speechDirection = 'reaction';
    assert.deepEqual((await v.synthesize('ありがとう！')).stats.tiers, { cache: 1, local: 0 });
    assert.deepEqual((await v.audition()).index.map(x => [x.label, x.kind]), [['gasp', 'clip'], ['ありがとう！', 'phrase']]);
});

test('tiers: exactly one tts reservation per part whatever the unit count; Supertonic health comes first', async t => {
    const c = cfg(t), { calls, fetchFn } = fixture(vvRoutes()), l = ledger();
    const r = new VoiceQualityRouter(c, { ledger: l, fetchFn });
    const three = part([['あいう、', 'neutral', 'low'], ['かきく、', 'neutral', 'mid'], ['さしす。', 'neutral', 'high']]);
    const out = await r.renderPart(three);
    assert.deepEqual(out.stats.tiers, { cache: 0, local: 3 }); assert.equal(out.stats.calls, 3);
    assert.equal(calls.length, 6); assert.deepEqual(l.calls, { tts: 1 });
    assert.deepEqual(calls.filter(x => x.url.pathname === '/audio_query').map(x => x.url.searchParams.get('text')), ['あいう、', 'かきく、', 'さしす。']);
    const log = [], st = fixture(stRoutes(), log), sl = { reserve(k) { log.push('reserve:' + k); } };
    const c2 = cfg(t, { replyTtsProvider: 'supertonic' }), r2 = new VoiceQualityRouter(c2, { ledger: sl, fetchFn: st.fetchFn });
    await r2.renderPart(three);
    await r2.renderPart(part([['もう一度。']]));
    assert.deepEqual(log, ['/v1/health', 'reserve:tts', '/v1/tts', '/v1/health', 'reserve:tts', '/v1/tts'], 'health per part, before the reservation; non-expressive merges into one call');
    assert.equal(st.calls[0].o.method, 'GET');
});

test('abort mid-part: remaining calls are skipped and nothing is cached', async t => {
    const c = cfg(t), controller = new AbortController();
    const { calls, fetchFn } = fixture(vvRoutes({ '/synthesis': () => { controller.abort(new Error('cancelled')); return new Response(tone(.2)); } }));
    const r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn });
    await assert.rejects(r.renderPart(part([['あいう、', 'neutral', 'low'], ['かきく。', 'neutral', 'high']]), controller.signal), /cancelled/);
    assert.deepEqual(calls.map(x => x.url.pathname), ['/audio_query', '/synthesis']);
    assert.equal(r.status().lru.entries, 0); assert.equal(r.breakers.voicevox.state, 'closed'); assert.equal(r.status().main.failures, 0);
    // Already aborted: nothing at all.
    await assert.rejects(r.renderPart(part([['さしす。']]), controller.signal), /cancelled/);
    assert.equal(calls.length, 2);
    // Abort after unit 1 completed: unit 3 is never requested and unit 1's finished bytes stay out of the LRU.
    const late = new AbortController();
    let n = 0;
    const f2 = fixture(vvRoutes({ '/synthesis': () => { if (++n === 2) late.abort(new Error('cancelled late')); return new Response(tone(.2)); } }));
    const r2 = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: f2.fetchFn });
    await assert.rejects(r2.renderPart(part([['あいう、', 'neutral', 'low'], ['かきく、', 'neutral', 'mid'], ['さしす。', 'neutral', 'high']]), late.signal), /cancelled late/);
    assert.deepEqual(f2.calls.map(x => x.url.pathname), ['/audio_query', '/synthesis', '/audio_query', '/synthesis']);
    assert.equal(r2.status().lru.entries, 0); assert.equal(r2.status().lru.bytes, 0); assert.equal(r2.status().main.failures, 0);
});

test('completed Aivis queue releases its PCM result while callers and cache keep identical audio', async t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', speechDirection: 'off' });
    let rejectNext = false;
    const { fetchFn, calls } = fixture(aivisRoutes({ '/synthesis': () => {
        if (rejectNext) { rejectNext = false; throw new Error('fixture synthesis failure'); }
        return new Response(tone(.2, 440, 44100));
    } }));
    const r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn });
    const p = part([['こんばんは。']]);
    const first = (await r.renderPart(p)).finalize({ reaction: 'neutral' });
    assert.ok(first.bytes.length > 44);
    assert.equal(await r.queues.aivisspeech, undefined, 'the ordering promise must not root the decoded Float32Array');
    const before = calls.length;
    const cached = (await r.renderPart(p)).finalize({ reaction: 'neutral' });
    assert.equal(calls.length, before, 'releasing the queue result preserves the WAV cache');
    assert.deepEqual(cached.bytes, first.bytes);
    assert.equal(cached.durationMs, first.durationMs);
    assert.equal(await r.queues.aivisspeech, undefined);
    rejectNext = true;
    await assert.rejects(r.renderPart(part([['次の一言。']])));
    assert.equal(await r.queues.aivisspeech, undefined, 'failure still settles the serialization tail');
    const recovered = (await r.renderPart(part([['またね。']]))).finalize({ reaction: 'neutral' });
    assert.deepEqual(recovered.bytes, first.bytes, 'the next queued request still runs on the same configured voice');
    assert.ok(calls.filter(x => x.url.pathname === '/synthesis').every(x => x.url.searchParams.get('speaker') === String(c.aivisStyle)));
});

test('two concurrent parts on one engine run their fetches strictly grouped per part', async t => {
    const c = cfg(t), order = [];
    const { fetchFn } = fixture(vvRoutes({
        '/audio_query': async url => { order.push(url.searchParams.get('text')); await tick(3); return response({ speedScale: 1 }); },
        '/synthesis': async () => { order.push('syn'); await tick(3); return new Response(tone(.1)); },
    }));
    const l = ledger(), r = new VoiceQualityRouter(c, { ledger: l, fetchFn });
    const A = part([['あ一、', 'neutral', 'low'], ['あ二。', 'neutral', 'high']]), B = part([['い一、', 'neutral', 'low'], ['い二。', 'neutral', 'high']]);
    const [a, b] = await Promise.all([r.renderPart(A), r.renderPart(B)]);
    assert.deepEqual(order, ['あ一、', 'syn', 'あ二。', 'syn', 'い一、', 'syn', 'い二。', 'syn']);
    assert.equal(a.stats.calls, 2); assert.equal(b.stats.calls, 2); assert.deepEqual(l.calls, { tts: 2 });
});

test('circuit: open → TTS_ENGINE_DOWN with no fetch; a 422 never opens it', async t => {
    let now = 5000;
    const c = cfg(t), events = [], { calls, fetchFn } = fixture(vvRoutes({ '/audio_query': () => new Response('down', { status: 503 }) }));
    const r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn, now: () => now });
    r.onEvent = (kind, detail) => events.push([kind, detail]);
    for (let i = 0; i < 2; i++) await assert.rejects(r.renderPart(part([['こんばんは。']])), e => e instanceof TtsError && e.code === 'TTS_ENGINE_DOWN' && e.message === 'Voice engine HTTP 503');
    assert.equal(calls.length, 2); assert.deepEqual(events, [['voice_circuit', 'TTS_ENGINE_DOWN']]);
    assert.equal(r.available(), false); assert.equal(r.retryAt(), 20000);
    const s = r.status().main;
    assert.equal(s.state, 'open'); assert.equal(s.openForMs, 15000); assert.equal(s.lastError, 'TTS_ENGINE_DOWN'); assert.equal(s.failures, 2);
    await assert.rejects(r.renderPart(part([['こんばんは。']])), e => e.code === 'TTS_ENGINE_DOWN' && e.message === 'Voice engine circuit open');
    assert.equal(calls.length, 2, 'fail fast with zero fetches');
    now = 20000; assert.equal(r.available(), true);
    await assert.rejects(r.renderPart(part([['こんばんは。']])), code('TTS_ENGINE_DOWN'));
    assert.equal(r.status().main.state, 'open'); assert.equal(r.retryAt(), 50000, 'half-open failure reopens for twice as long');
    // 422 is a rejection: it never counts.
    const bad = fixture(vvRoutes({ '/audio_query': () => new Response('bad', { status: 422 }) })), r2 = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: bad.fetchFn });
    for (let i = 0; i < 4; i++) await assert.rejects(r2.renderPart(part([['こんばんは。']])), code('TTS_REJECTED'));
    assert.equal(r2.breakers.voicevox.state, 'closed'); assert.equal(r2.available(), true); assert.equal(bad.calls.length, 4);
    // Invalid input is rejected before any fetch.
    await assert.rejects(r2.renderPart(part([['<b>です。']])), code('TTS_REJECTED'));
    assert.equal(bad.calls.length, 4);
    // A throwing observer never replaces the engine error.
    const r3 = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn, now: () => now });
    r3.onEvent = () => { throw new Error('observer broke'); };
    for (let i = 0; i < 2; i++) await assert.rejects(r3.renderPart(part([['こんばんは。']])), e => e instanceof TtsError && e.code === 'TTS_ENGINE_DOWN');
    assert.equal(r3.breakers.voicevox.state, 'open');
});

test('no fallback: AivisSpeech and SBV2 failures reject and never leave their port', async t => {
    for (const [provider, routes, port] of [['aivisspeech', aivisRoutes({ '/synthesis': () => new Response('x', { status: 500 }) }), '10101'], ['sbv2', sbv2Routes({ '/voice': () => new Response('x', { status: 500 }) }), '5055']]) {
        const c = cfg(t, { replyTtsProvider: provider }), { calls, fetchFn } = fixture(routes), l = ledger();
        const v = new DirectedVoice(c, l, { fetchFn });
        await assert.rejects(v.synthesize('こんばんは。'), code('TTS_ENGINE_DOWN'));
        await assert.rejects(v.synthesize('こんばんは。'), code('TTS_ENGINE_DOWN'));
        await assert.rejects(v.synthesize('こんばんは。'), e => e.message === 'Voice engine circuit open');
        assert.ok(calls.length > 0 && calls.every(x => x.url.hostname === '127.0.0.1' && x.url.port === port), `${provider}: ${calls.map(x => x.url.href)}`);
        assert.equal(v.available(), false); assert.equal(v.status().main.state, 'open');
    }
    // An identity mismatch (VOICEVOX answering on the AivisSpeech port) counts as a failure too.
    const c = cfg(t, { replyTtsProvider: 'aivisspeech' }), { calls, fetchFn } = fixture(aivisRoutes({ '/engine_manifest': () => response({ name: 'VOICEVOX Engine' }) })), l = ledger();
    const r = new VoiceQualityRouter(c, { ledger: l, fetchFn });
    await assert.rejects(r.renderPart(part([['こんばんは。']])), code('TTS_ENGINE_MISMATCH'));
    assert.deepEqual(l.calls, {}, 'identity is checked before the reservation');
    assert.ok(!calls.some(x => x.url.pathname === '/synthesis'));
});

const shockText = 'えっ、ちょっと待って！';
async function clipRig(t, { now = () => 100000, clips = ['gasp'], mode = 'reaction' } = {}) {
    const c = cfg(t, { reactionAudio: true, speechDirection: mode }), { calls, fetchFn } = fixture(vvRoutes());
    const lib = library(t, d => { for (const cls of clips) addClip(d, { cls, bytes: tone(cls === 'gasp' ? .3 : .5, 300), attest: 'nonverbal' }); });
    const governor = new ClipGovernor(now), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn, library: lib, governor, now });
    return { c, calls, lib, governor, r, d: new SpeechDirector(c) };
}

test('clips: included when the library has it and the governor allows; skipped for budget, cooldown, missing', async t => {
    const { r, d, governor, c } = await clipRig(t);
    const p = d.plan(shockText, { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0];
    assert.deepEqual(p.clip, { cls: 'gasp', position: 'pre' });
    const withClip = await r.renderPart(p), bare = await r.renderPart({ ...p, clip: null });
    assert.equal(withClip.stats.clip, 'gasp'); assert.equal(withClip.stats.clipSkipped, null);
    assert.equal(withClip.timeline.clip.position, 'pre'); assert.equal(withClip.timeline.clip.startMs, 0);
    assert.ok(withClip.durationMs >= bare.durationMs + 300 + 60 - 2, `${withClip.durationMs} vs ${bare.durationMs}`);
    // clipMs is exactly what the clip adds, so the next part's turn check can exempt it.
    assert.equal(withClip.clipMs, withClip.durationMs - bare.durationMs); assert.equal(bare.clipMs, 0);
    const budget = await r.renderPart({ ...p, budgetMs: withClip.durationMs - 1 });
    assert.equal(budget.stats.clip, null); assert.equal(budget.stats.clipSkipped, 'budget'); assert.equal(budget.durationMs, bare.durationMs);
    assert.equal((await r.renderPart({ ...p, budgetMs: withClip.durationMs })).stats.clip, 'gasp');
    const missing = await r.renderPart({ ...p, clip: { cls: 'hmm', position: 'pre' } });
    assert.equal(missing.stats.clipSkipped, 'missing'); assert.equal(missing.durationMs, bare.durationMs);
    governor.commit('gasp', 99000);
    const cooled = await r.renderPart(p);
    assert.equal(cooled.stats.clipSkipped, 'cooldown'); assert.equal(cooled.stats.clip, null);
    c.reactionAudio = false;
    assert.equal((await r.renderPart(p)).stats.clipSkipped, 'disabled');
});

test('finalize keeps the clip on a compatible reaction and drops it after a downgrade', async t => {
    let now = 100000;
    const { r, d, governor } = await clipRig(t, { now: () => now });
    const p = d.plan(shockText, { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0];
    const a = await r.renderPart(p), before = a.durationMs;
    const kept = a.finalize({ reaction: 'shock', intensity: 'high' });
    assert.equal(kept.clip, 'gasp'); assert.equal(kept.leadMs, 0); assert.equal(kept.durationMs, before); assert.equal(kept.kind, 'wav');
    assert.equal(a.finalize({ reaction: 'surprised' }), kept, 'memoized');
    assert.equal(governor.last.gasp, now, 'committed on publication');
    assert.ok(Math.abs(wavDuration(kept.bytes) * 1000 - kept.durationMs) <= 1);
    const w = readWav(kept.bytes), clipEnd = Math.round(300 * w.rate / 1000);
    assert.ok(w.samples.slice(0, clipEnd).some(x => Math.abs(x) > .01), 'the published WAV begins with the gasp');
    assert.ok(w.samples.slice(clipEnd + 20, clipEnd + Math.round(.06 * w.rate) - 20).every(x => x === 0), 'then the exact pre-gap');
    now += 20000;
    const b = await r.renderPart(p);
    const dropped = b.finalize({ reaction: 'surprised', intensity: 'mid' }, now);
    assert.equal(dropped.clip, null); assert.equal(dropped.leadMs, null); assert.ok(dropped.durationMs < b.durationMs);
    assert.ok(Math.abs(wavDuration(dropped.bytes) * 1000 - dropped.durationMs) <= 1);
    assert.equal(governor.last.gasp, now - 20000, 'a dropped clip is not committed');
    // Governor re-check at publication: a clip rendered earlier is dropped inside the cooldown.
    now += 20000;
    const c1 = await r.renderPart(p), c2 = await r.renderPart(p);
    assert.equal(c1.finalize({ reaction: 'shock' }).clip, 'gasp');
    assert.equal(c2.finalize({ reaction: 'shock' }).clip, null);
    assert.deepEqual(r.status().clips, { used: 2, dropped: 2 });
});

test('finalize: post clips never lead, beats are calm presets inside the part, hmm gives a mouth window', async t => {
    let now = 100000;
    const { r, d } = await clipRig(t, { now: () => now, clips: ['hmm', 'laugh_small'] });
    const think = d.plan('それは面白い質問だね。', { reaction: 'thinking' }, { clipKinds: ['hmm'] }).parts[0];
    assert.deepEqual(think.clip, { cls: 'hmm', position: 'pre' });
    const h = (await r.renderPart(think)).finalize({ reaction: 'thinking' });
    assert.equal(h.clip, 'hmm'); assert.equal(h.leadMs, 0);
    assert.equal(h.mouth.length, 1); assert.equal(h.mouth[0].startMs, 0); assert.equal(h.mouth[0].scale, .2); assert.ok(Math.abs(h.mouth[0].endMs - 500) <= 1);
    now += 60000;
    const shy = d.plan('そんなに褒められると照れちゃうな。', { reaction: 'embarrassed' }, { clipKinds: ['laugh_small'] }).parts[0];
    assert.deepEqual(shy.clip, { cls: 'laugh_small', position: 'post' });
    const s = await r.renderPart(shy), sf = s.finalize({ reaction: 'embarrassed' });
    assert.equal(sf.clip, 'laugh_small'); assert.equal(sf.leadMs, null); assert.deepEqual(sf.mouth, []);
    assert.equal(s.timeline.clip.position, 'post'); assert.ok(s.timeline.clip.endMs <= s.timeline.totalMs);
    // jev mode: segment reactions give mid-part beats; big presets are calmed.
    const jd = new SpeechDirector({ speechDirection: 'jev' });
    const text = 'えっ、ちょっと待ってよ、今のは本当にすごかったよね、びっくりしたなあ。';
    const p = jd.plan(text, { reaction: 'neutral', delivery: { reactions: ['neutral', 'laugh', 'shock'] } }).parts[0];
    assert.equal(p.chunks.length, 3); assert.ok(p.beats.length >= 1);
    const out = await r.renderPart(p), f = out.finalize({ reaction: 'neutral' });
    assert.ok(f.beats.length >= 1 && f.beats.length <= 4);
    for (const b of f.beats) { assert.ok(!REACTIONS[b.reaction].big && !REACTIONS[b.reaction].local, b.reaction); assert.ok(Number.isInteger(b.atMs) && b.atMs > 0 && b.atMs < out.timeline.totalMs); }
    assert.deepEqual(f.beats.map(b => b.reaction), p.beats.map(b => b.reaction));
    const u1 = out.timeline.units[1];
    assert.equal(f.beats[0].atMs, u1.startMs, 'a beat on a unit boundary starts with that unit');
    assert.deepEqual(f.mouth, []); assert.equal(f.leadMs, null);
});

test('gate property: every audible region of a finalized part is one of its own units or one edge clip', async t => {
    const BLOCK = 480, BITS = 11, V = .25, CLIP_ID = 2047, rnd = mulberry(20260926);
    // Per-call marker: sign blocks survive normalisation, fades and the peak ceiling.
    const marker = id => { const x = new Float32Array(BITS * BLOCK); for (let b = 0; b < BITS; b++) x.fill((id >> (BITS - 1 - b)) & 1 ? V : -V, b * BLOCK, (b + 1) * BLOCK); return x; };
    const regions = x => {
        const out = []; let start = -1, last = -Infinity;
        for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-3) { if (start < 0 || i - last > 100) { if (start >= 0) out.push([start, last + 1]); start = i; } last = i; }
        if (start >= 0) out.push([start, last + 1]);
        return out;
    };
    const decode = (x, [s, e]) => { let id = 0; for (let b = 0; b < BITS; b++) id = id << 1 | (x[s + Math.floor((b + .5) * (e - s) / BITS)] > 0 ? 1 : 0); return id; };
    const c = cfg(t, { reactionAudio: true, phraseCache: true }), made = new Map();
    let seq = 0, pseq = 0;
    const adapters = createAdapters(c, forbidden);
    for (const a of Object.values(adapters)) {
        a.health = async () => ({ ok: true });
        a.synthesize = async text => { a.validateText(text); const id = ++seq; made.set(id, { kind: 'local', text }); return writeWav(marker(id), 24000); };
    }
    const PHRASES = new Set(['えっ、', 'あれ？', 'なるほど、', 'ねえ、', 'ありがとう！']);
    const lib = {
        hasPhrase: (id16, text) => PHRASES.has(text),
        phrase: (id16, text) => { const id = 1000 + ++pseq; made.set(id, { kind: 'cache', text }); return { id: 'p', pcm: marker(id), rate: 24000, ms: 220, source: 'tts' }; },
        clip: cls => ({ id: cls, cls, pcm: marker(CLIP_ID), rate: 24000, ms: 220, gainDb: 0 }),
        kinds: () => Object.keys(NONVERBAL),
    };
    let now = 1e6;
    const governor = new ClipGovernor(() => now), r = new VoiceQualityRouter(c, { ledger: ledger(), adapters, library: lib, governor, now: () => now });
    const TOKENS = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっアイウエオカキク星部屋家具考案今日夜話', ...'、、、・。！？〜…ー', 'えっ、', 'あれ？', 'なるほど、', 'ねえ、', 'ありがとう！'];
    const pick = xs => xs[Math.floor(rnd() * xs.length)];
    let clipsKept = 0, cacheUnits = 0, splits = 0, dropped = 0;
    for (let n = 0; n < 200; n++) {
        c.replyTtsProvider = ['voicevox', 'sbv2', 'supertonic', 'aivisspeech'][n % 4];
        c.speechDirection = n % 2 ? 'jev' : 'reaction';
        let text = rnd() < .4 ? pick(['えっ、', 'あれ？', 'なるほど、', 'ねえ、', 'ありがとう！']) : '';
        // Long single sentences (sometimes without 、) force engine-limit splits, mostly on SBV2's 100 characters.
        const long = rnd() < (c.replyTtsProvider === 'sbv2' ? .6 : .2), bare = rnd() < .5;
        const pool = long ? TOKENS.filter(x => !(bare ? /[。！？、]/u : /[。！？]/u).test(x)) : TOKENS, len = long ? 120 + Math.floor(rnd() * 100) : 1 + Math.floor(rnd() * 60);
        while (text.length < len) text += pick(pool);
        text = text.slice(0, 220);
        if (!text.replace(/[、・。！？〜…ー]/gu, '')) text = 'あ' + text;
        const delivery = { source: 'jev', intensity: pick([null, 'low', 'mid', 'high']), pace: pick([null, 'slow', 'normal', 'fast']), ending: null, nonverbal: pick(['none', ...Object.keys(NONVERBAL)]), reactions: Array.from({ length: 4 }, () => pick(ACTABLE)) };
        const plan = new SpeechDirector(c).plan(text, { reaction: pick(ACTABLE), delivery }, { clipKinds: Object.keys(NONVERBAL) });
        for (const planned of plan.parts) {
            now += 60000; seq = 0; pseq = 0; made.clear();
            if (rnd() < .15) governor.commit(pick(Object.keys(NONVERBAL)), now - 1000);
            const p = { ...planned, budgetMs: rnd() < .2 ? 300 : undefined };
            const out = await r.renderPart(p), reaction = rnd() < .6 ? p.head : pick(ACTABLE);
            const fin = out.finalize({ reaction }, now);
            assert.ok(fin.durationMs <= out.durationMs);
            assert.ok(Math.abs(wavDuration(fin.bytes) * 1000 - fin.durationMs) <= 1);
            const x = readWav(fin.bytes).samples, rs = regions(x);
            assert.ok(rs.every(([s, e]) => Math.abs(e - s - BITS * BLOCK) < 60), `each region is exactly one render: ${rs.map(([s, e]) => e - s)}`);
            const ids = rs.map(g => decode(x, g));
            let body = ids;
            if (fin.clip) {
                const pre = NONVERBAL[fin.clip].position === 'pre';
                assert.equal(pre ? ids[0] : ids.at(-1), CLIP_ID, 'the clip sits at the part edge');
                body = pre ? ids.slice(1) : ids.slice(0, -1); clipsKept++;
            } else if (p.clip) dropped++;
            assert.ok(!body.includes(CLIP_ID), 'no clip inside the words');
            assert.ok(body.every(id => made.has(id)), `only this part's renders: ${ids}`);
            assert.equal(new Set(body).size, body.length);
            assert.deepEqual(body.filter(id => id < 1000).sort((a, b) => a - b), [...made.keys()].filter(id => id < 1000), 'every engine call of this part is heard, once');
            assert.equal(body.map(id => made.get(id).text).join(''), p.text, 'the heard units join to exactly the approved part');
            assert.equal(body.length, out.stats.tiers.cache + out.stats.tiers.local);
            cacheUnits += out.stats.tiers.cache;
            if (c.replyTtsProvider === 'sbv2' && p.chunks.some(ch => ch.text.length > 100)) splits++;
        }
    }
    assert.ok(clipsKept > 5 && cacheUnits > 10 && dropped > 3, `exercised clips ${clipsKept}, cache ${cacheUnits}, dropped ${dropped}`);
    assert.ok(splits > 3, `SBV2 splits were exercised (${splits})`);
});

test('render-key parity: the live key for a chunk equals renderKey(chunkDeliveryFor(text, preset)) on all 4 providers', async t => {
    const texts = ['えっ、ちょっと待って！今の攻撃やばくない！？', 'よかったぁ〜！', 'うーん、どっちも捨てがたいな。', 'わあ、この部屋の収納はすごいね、どこに何があるか一目でわかるようになってる。', 'ありがとう！'];
    const maps = { voicevox: { surprise: 8, joy: 3 }, aivisspeech: { surprise: 888753761 }, sbv2: { surprise: 'Surprise', joy: 'Happy' }, supertonic: {} };
    const base = cfg(t, { phraseCache: true });
    for (const provider of PROVIDERS) {
        const c = { ...base, replyTtsProvider: provider, hostStyleMap: maps[provider] }, seen = [];
        const lib = { hasPhrase: (id16, text, key) => { seen.push({ id16, text, key }); return true; }, phrase: () => ({ pcm: sine(.2), rate: 24000 }), kinds: () => [] };
        const r = new VoiceQualityRouter(c, { ledger: { reserve() { throw new Error('no reservation'); } }, fetchFn: forbidden, library: lib }), a = r.adapter(), d = new SpeechDirector(c);
        assert.equal(a.identity16(), identity16(a.identity()), `${provider} identity16 parity`);
        for (const preset of ACTABLE) for (const text of texts) {
            for (const p of d.plan(text, { reaction: preset }).parts) {
                seen.length = 0;
                const out = await r.renderPart(p);
                assert.equal(out.stats.calls, 0);
                assert.ok(seen.length >= 1);
                for (const s of seen) {
                    assert.equal(s.id16, a.identity16());
                    const ch = p.chunks.find(x => x.text === s.text) ?? (s.text === p.text ? p.chunks[0] : null);
                    assert.ok(ch, `${provider}: looked up an exact chunk or the whole part`);
                    assert.equal(s.key, r.renderKey(chunkDeliveryFor(ch.text, preset)), `${provider} ${preset} ${ch.text}`);
                }
            }
        }
    }
    const key = (provider, patch, delivery = chunkDeliveryFor('えっ、', 'surprised')) => new VoiceQualityRouter({ ...base, replyTtsProvider: provider, ...patch }, { ledger: ledger(), fetchFn: forbidden }).renderKey(delivery);
    const same = (p, patch) => assert.equal(key(p, patch), key(p, {}), `${p} ${JSON.stringify(patch)} must not change the key`);
    const differs = (p, patch) => assert.notEqual(key(p, patch), key(p, {}), `${p} ${JSON.stringify(patch)} must change the key`);
    differs('voicevox', { hostStyleMap: { surprise: 8 } }); differs('voicevox', { speaker: 4 }); same('voicevox', { voiceURL: 'http://127.0.0.1:50022' }); same('voicevox', { hostStyleMap: { joy: 8 } });
    differs('aivisspeech', { hostStyleMap: { surprise: 888753761 } }); differs('aivisspeech', { aivisStyle: 888753761 }); same('aivisspeech', { aivisURL: 'http://127.0.0.1:10102' });
    differs('sbv2', { hostStyleMap: { surprise: 'Surprise' } }); differs('sbv2', { sbv2Speaker: 'jvnv-F1-jp' }); differs('sbv2', { sbv2Model: 'amitaro' }); same('sbv2', { sbv2URL: 'http://127.0.0.1:5056' });
    differs('supertonic', { supertonicVoice: 'M1' }); same('supertonic', { supertonicSteps: 16 }); same('supertonic', { supertonicURL: 'http://127.0.0.1:7789' });
    for (const [id, a] of Object.entries(createAdapters(base, forbidden))) assert.equal(a.identity16(), identity16(a.identity()), id);
});

test('DirectedVoice: pass-through, demo, off-mode AivisSpeech, clip kinds, premium and cache.clear', async t => {
    // Pass-through: today's ReplyVoice, exactly the 2 VOICEVOX fetches, exactly 2 arguments.
    const c = cfg(t, { speechDirection: 'off' }), vv = fixture(vvRoutes()), l = ledger();
    const v = new DirectedVoice(c, l, { fetchFn: vv.fetchFn });
    assert.equal(v.passThrough(), true); assert.equal(v.available(), true);
    const out = await v.synthesize('こんばんは。', undefined);
    assert.equal(out.kind, 'wav'); assert.deepEqual(vv.calls.map(x => x.url.pathname), ['/audio_query', '/synthesis']); assert.deepEqual(l.calls, { tts: 1 });
    assert.equal(out.finalize, undefined); assert.equal(await v.warmup(), null); assert.equal(await v.audition(), null);
    assert.equal(vv.calls.length, 2);
    const args = [], spy = new DirectedVoice(c, l, { legacy: { synthesize(...a) { args.push(a.length); return Promise.resolve({ kind: 'browser' }); } }, fetchFn: forbidden });
    await spy.synthesize('こんばんは。', undefined, spy.director.neutralPart('こんばんは。'));
    assert.deepEqual(args, [2]);
    // Demo: no fetch, no reservation, even when directed and on AivisSpeech.
    const dl = ledger(), demo = new DirectedVoice(cfg(t, { mode: 'demo', replyTtsProvider: 'aivisspeech', reactionAudio: true }), dl, { fetchFn: forbidden, library: { kinds: () => ['gasp'] } });
    assert.deepEqual(await demo.synthesize('こんばんは。'), { kind: 'browser', durationMs: 3000, bytes: null });
    assert.equal((await demo.synthesize('あ'.repeat(300))).durationMs, 30000);
    await assert.rejects(demo.synthesize('<b>'), code('TTS_REJECTED'));
    assert.equal(await demo.warmup(), null); assert.equal(await demo.audition(), null); assert.deepEqual(demo.clipKinds(), []);
    assert.equal(demo.available(), true); assert.deepEqual(dl.calls, {});
    // AivisSpeech with direction off still uses the router with a neutral part.
    const ac = cfg(t, { speechDirection: 'off', replyTtsProvider: 'aivisspeech' }), av = fixture(aivisRoutes()), al = ledger();
    const aivis = new DirectedVoice(ac, al, { fetchFn: av.fetchFn });
    assert.equal(aivis.passThrough(), false);
    const r = await aivis.synthesize('こんばんは。');
    assert.equal(r.kind, 'wav'); assert.equal(typeof r.finalize, 'function'); assert.equal(r.stats.engine, 'aivisspeech'); assert.deepEqual(r.stats.tiers, { cache: 0, local: 1 });
    const q = av.calls.find(x => x.url.pathname === '/audio_query');
    assert.equal(q.url.searchParams.get('speaker'), '888753760'); assert.equal(q.url.searchParams.get('text'), 'こんばんは。');
    assert.deepEqual(av.calls.map(x => x.url.pathname), ['/version', '/engine_manifest', '/audio_query', '/synthesis']); assert.deepEqual(al.calls, { tts: 1 });
    assert.equal(readWav(r.bytes).rate, 44100, 'native engine rate, no resampling');
    assert.deepEqual(aivis.lastPart, { engine: 'aivisspeech', tiers: { cache: 0, local: 1 }, calls: 1, synthMs: r.stats.synthMs, audioMs: 200, clip: null });
    assert.equal(r.finalize({ reaction: 'neutral' }).clip, null);
    // Clip kinds only with REACTION_AUDIO, live, directed and a library.
    const lib = { kinds: () => ['gasp', 'hmm'], status: () => ({ clips: { gasp: 1 } }) };
    assert.deepEqual(new DirectedVoice(cfg(t, { reactionAudio: false }), l, { fetchFn: forbidden, library: lib }).clipKinds(), []);
    assert.deepEqual(new DirectedVoice(cfg(t, { reactionAudio: true }), l, { fetchFn: forbidden, library: lib }).clipKinds(), ['gasp', 'hmm']);
    assert.deepEqual(new DirectedVoice(cfg(t, { reactionAudio: true, speechDirection: 'off' }), l, { fetchFn: forbidden, library: lib }).clipKinds(), []);
    assert.deepEqual(new DirectedVoice(cfg(t, { reactionAudio: true }), l, { fetchFn: forbidden }).clipKinds(), []);
    // Status, premium slot, LRU clear, event forwarding.
    const st = aivis.status();
    assert.equal(st.direction, 'off'); assert.equal(st.passThrough, false); assert.deepEqual(st.premium, { state: 'disabled' }); assert.equal(aivis.router.premium, null);
    assert.equal(st.main.id, 'aivisspeech'); assert.equal(st.main.label, 'AivisSpeech'); assert.equal(st.main.state, 'ready'); assert.equal(st.main.calls, 1);
    assert.ok(Number.isInteger(st.main.p50SynthMs)); assert.equal(st.library, null); assert.equal(st.lru.entries, 1); assert.deepEqual(st.lastPart, aivis.lastPart);
    assert.equal(new DirectedVoice(cfg(t), l, { fetchFn: forbidden, library: lib }).status().library.clips.gasp, 1);
    aivis.cache.clear();
    assert.equal(aivis.status().lru.entries, 0); assert.equal(aivis.status().lru.bytes, 0);
    const events = [], fn = (k, d) => events.push([k, d]);
    assert.ok('onEvent' in aivis); aivis.onEvent = fn; assert.equal(aivis.router.onEvent, fn); assert.equal(aivis.onEvent, fn);
    assert.equal(aivis.estimateAudioMs('あいう'), Math.round(200 / 6 * 3)); assert.ok(aivis.estimateSynthMs('あいう') >= 0); assert.equal(aivis.retryAt(), 0);
    assert.equal(new VoiceQualityRouter(cfg(t), { ledger: l, fetchFn: forbidden }).estimateAudioMs('あいう'), 510);
    assert.equal(new VoiceQualityRouter(cfg(t), { ledger: l, fetchFn: forbidden }).estimateSynthMs('あいう'), 0);
    assert.throws(() => new VoiceQualityRouter(cfg(t, { replyTtsProvider: 'cloud' }), { ledger: l, fetchFn: forbidden }).adapter(), code('TTS_REJECTED'));
});

test('the LRU serves repeats without a call or reservation and misses after AIVIS_STYLE changes', async t => {
    const c = cfg(t, { replyTtsProvider: 'aivisspeech' }), { calls, fetchFn } = fixture(aivisRoutes()), l = ledger();
    const v = new DirectedVoice(c, l, { fetchFn }), synths = () => calls.filter(x => x.url.pathname === '/synthesis').length;
    await v.synthesize('こんばんは。');
    assert.equal(synths(), 1); assert.deepEqual(l.calls, { tts: 1 });
    const again = await v.synthesize('こんばんは。');
    assert.equal(synths(), 1); assert.deepEqual(l.calls, { tts: 1 }); assert.equal(again.stats.calls, 0);
    assert.deepEqual({ hits: v.status().lru.hits, misses: v.status().lru.misses }, { hits: 1, misses: 1 });
    c.aivisStyle = 888753761;
    await v.synthesize('こんばんは。');
    assert.equal(synths(), 2); assert.deepEqual(l.calls, { tts: 2 });
    assert.equal(calls.filter(x => x.url.pathname === '/audio_query').at(-1).url.searchParams.get('speaker'), '888753761');
    assert.equal(v.status().lru.entries, 2);
    v.cache.clear(); await v.synthesize('こんばんは。');
    assert.equal(synths(), 3);
});

test('warm-up failure sets state down but never opens the circuit; success marks ready', async t => {
    const c = cfg(t), events = [], down = fixture({}, []);
    const v = new DirectedVoice(c, ledger(), { fetchFn: down.fetchFn });
    v.onEvent = (k, d) => events.push([k, d]);
    for (let i = 0; i < 3; i++) assert.equal(await v.warmup(), null);
    const s = v.status().main;
    assert.equal(s.state, 'down'); assert.equal(v.router.breakers.voicevox.state, 'closed'); assert.equal(v.available(), true);
    assert.equal(s.lastError, 'TTS_REJECTED'); assert.deepEqual(events[0], ['voice_warmup', 'TTS_REJECTED']);
    const five = fixture({ '/initialize_speaker': () => new Response('x', { status: 503 }) }), r5 = new DirectedVoice(c, ledger(), { fetchFn: five.fetchFn });
    await r5.warmup(); await r5.warmup(); await r5.warmup();
    assert.equal(r5.status().main.state, 'down'); assert.equal(r5.router.breakers.voicevox.state, 'closed');
    const ok = fixture(vvRoutes()), l = ledger(), good = new DirectedVoice(cfg(t, { hostStyleMap: { joy: 3 } }), l, { fetchFn: ok.fetchFn });
    good.onEvent = (k, d) => events.push([k, d]);
    const w = await good.warmup();
    assert.ok(Number.isInteger(w.ms)); assert.equal(good.status().main.state, 'ready'); assert.deepEqual(l.calls, {});
    assert.equal(events.at(-1)[0], 'voice_warmup'); assert.equal(typeof events.at(-1)[1], 'number');
    assert.deepEqual(ok.calls.map(x => [x.url.pathname, x.url.searchParams.get('speaker')]), [['/initialize_speaker', '3']]);
    // A throwing observer cannot turn a successful warm-up into 'down'.
    const ok2 = fixture(vvRoutes()), fine = new DirectedVoice(c, ledger(), { fetchFn: ok2.fetchFn });
    fine.onEvent = () => { throw new Error('observer broke'); };
    assert.ok(Number.isInteger((await fine.warmup()).ms)); assert.equal(fine.status().main.state, 'ready'); assert.equal(fine.status().main.lastError, null);
    // Pass-through never warms up.
    const pt = fixture(vvRoutes()); await new DirectedVoice(cfg(t, { speechDirection: 'off' }), ledger(), { fetchFn: pt.fetchFn }).warmup();
    assert.equal(pt.calls.length, 0);
});

test('warm-up runs on the engine queue: it never overlaps a part, and an abort while queued skips it', async t => {
    const order = [], { calls, fetchFn } = fixture(vvRoutes({
        '/initialize_speaker': async () => { order.push('init'); await tick(5); order.push('init done'); return new Response(null, { status: 204 }); },
        '/audio_query': async () => { order.push('query'); await tick(2); return response({ speedScale: 1 }); },
    }));
    const v = new DirectedVoice(cfg(t), ledger(), { fetchFn });
    await Promise.all([v.warmup(), v.synthesize('こんばんは。')]);
    assert.deepEqual(order, ['init', 'init done', 'query'], 'the part waits for the warm-up');
    order.length = 0;
    await Promise.all([v.synthesize('おはよう。'), v.warmup()]);
    assert.deepEqual(order, ['query', 'init', 'init done'], 'the warm-up waits for the part');
    const ac = new AbortController(), before = calls.length, part = v.synthesize('またね。'), w = v.warmup(ac.signal);
    ac.abort();
    assert.equal(await w, null); await part;
    assert.ok(!calls.slice(before).some(x => x.url.pathname === '/initialize_speaker'));
    assert.equal(v.status().main.state, 'ready'); assert.equal(v.router.breakers.voicevox.state, 'closed');
});

test('audition: every mapped style and the base style at mid and high, every clip and phrase take; null when nothing to hear', async t => {
    const c = cfg(t, { reactionAudio: true, phraseCache: true, hostStyleMap: { joy: 3, surprise: 8, calm: 'Calm' } }), { calls, fetchFn } = fixture(vvRoutes()), l = ledger();
    const probe = new VoiceQualityRouter(c, { ledger: l, fetchFn: forbidden }), a = probe.adapter();
    const lib = library(t, d => {
        addClip(d, { cls: 'gasp', bytes: tone(.3, 300), attest: 'nonverbal' });
        addPhrase(d, { identity16: a.identity16(), engine: 'voicevox', text: 'ありがとう！', renderKey: probe.renderKey(chunkDeliveryFor('ありがとう！', 'happy')), preset: 'happy', bytes: tone(.5, 500) });
        addPhrase(d, { identity16: '0123456789abcdef', engine: 'voicevox', text: 'ナイス！', renderKey: 'c'.repeat(64), preset: 'happy', bytes: tone(.5, 500) });
    });
    const v = new DirectedVoice(c, l, { fetchFn, library: lib });
    const reel = await v.audition();
    // neutral is unmapped (calm's string is not a VOICEVOX id), so it stands in for the base speaker unmapped families air on.
    assert.deepEqual(reel.index.map(x => [x.label, x.kind]), [['neutral/mid', 'style'], ['neutral/high', 'style'], ['joy/mid', 'style'], ['joy/high', 'style'], ['surprise/mid', 'style'], ['surprise/high', 'style'], ['gasp', 'clip'], ['ありがとう！', 'phrase']]);
    assert.ok(reel.bytes.length > 44 && reel.durationMs > 0 && reel.truncated === 0);
    assert.deepEqual(l.calls, { tts: 6 }, 'each style render reserves once');
    const q = calls.filter(x => x.url.pathname === '/audio_query'), base = String(c.speaker);
    assert.deepEqual(q.map(x => [x.url.searchParams.get('text'), x.url.searchParams.get('speaker')]), [[AUDITION_TEXT.neutral, base], [AUDITION_TEXT.neutral, base], [AUDITION_TEXT.joy, '3'], [AUDITION_TEXT.joy, '3'], [AUDITION_TEXT.surprise, '8'], [AUDITION_TEXT.surprise, '8']]);
    assert.deepEqual(Object.keys(AUDITION_TEXT), VOICE_FAMILIES);
    // Nothing mapped, nothing in the library: nothing to hear.
    const none = fixture(stRoutes());
    assert.equal(await new DirectedVoice(cfg(t, { replyTtsProvider: 'supertonic', hostStyleMap: { joy: 3 } }), ledger(), { fetchFn: none.fetchFn, library: lib }).audition(), null);
    assert.equal(none.calls.length, 0);
    assert.equal(await new DirectedVoice({ ...c, speechDirection: 'off', replyTtsProvider: 'aivisspeech' }, ledger(), { fetchFn: forbidden, library: lib }).audition(), null);
    // Supertonic has no styles but still auditions the clips and this voice's phrase takes (none here).
    const clipsOnly = await new DirectedVoice(cfg(t, { replyTtsProvider: 'supertonic', reactionAudio: true }), ledger(), { fetchFn: forbidden, library: lib }).audition();
    assert.deepEqual(clipsOnly.index.map(x => x.label), ['gasp']);
});

test('audition: the base style unmapped families fall back to is heard before it can air', async t => {
    // AIVIS_STYLE=1 with only neutral and joy mapped: calm (nod) and think (thinking) air on style 1.
    const c = cfg(t, { replyTtsProvider: 'aivisspeech', aivisStyle: 1, hostStyleMap: { neutral: 5, joy: 6 } }), { calls, fetchFn } = fixture(aivisRoutes());
    const v = new DirectedVoice(c, ledger(), { fetchFn }), a = v.router.adapter();
    const r = await v.audition();
    assert.deepEqual(r.index.map(x => x.label), ['neutral/mid', 'neutral/high', 'calm/mid', 'calm/high', 'joy/mid', 'joy/high']);
    const heard = new Set(calls.filter(x => x.url.pathname === '/synthesis').map(x => Number(x.url.searchParams.get('speaker'))));
    assert.deepEqual([...heard].sort(), [1, 5, 6]);
    for (const family of VOICE_FAMILIES) assert.ok(heard.has(a.resolve({ family }).speaker), `${family} airs on a style the reel played`);
    // SBV2: the base SBV2_STYLE likewise.
    const s = cfg(t, { replyTtsProvider: 'sbv2', hostStyleMap: { joy: 'Happy' } }), f2 = fixture(sbv2Routes());
    const v2 = new DirectedVoice(s, ledger(), { fetchFn: f2.fetchFn }), a2 = v2.router.adapter();
    await v2.audition();
    const styles = new Set(f2.calls.filter(x => x.url.pathname === '/voice').map(x => x.url.searchParams.get('style')));
    for (const family of VOICE_FAMILIES) assert.ok(styles.has(a2.resolve({ family }).style), family);
    // Fully mapped: no base render is added, and the 14-render cap still holds.
    const all = Object.fromEntries(VOICE_FAMILIES.map((f, i) => [f, 10 + i])), f3 = fixture(aivisRoutes());
    const full = await new DirectedVoice(cfg(t, { replyTtsProvider: 'aivisspeech', aivisStyle: 1, hostStyleMap: all }), ledger(), { fetchFn: f3.fetchFn }).audition();
    assert.equal(full.index.length, 14);
    assert.ok(!f3.calls.some(x => x.url.pathname === '/synthesis' && x.url.searchParams.get('speaker') === '1'));
});

test('audition: clips and style intensities are heard at their broadcast levels', async t => {
    const c = cfg(t, { reactionAudio: true, hostStyleMap: { joy: 3 } }), { fetchFn } = fixture(vvRoutes());
    const lib = library(t, d => { addClip(d, { cls: 'breath_in', bytes: tone(.4, 300, 24000, .3), gainDb: -6, attest: 'nonverbal' }); });
    const r = await new DirectedVoice(c, ledger(), { fetchFn, library: lib }).audition();
    const w = readWav(r.bytes, { maxSeconds: 600 }), at = label => r.index.find(x => x.label === label);
    const seg = (label, next) => { const s = at(label).startMs, e = next ? at(next).startMs - 350 : r.durationMs; return levels(w.samples.subarray(Math.round(s * 24), Math.round(e * 24)), 24000); };
    const clip = seg('breath_in'), onAir = conditionClip(lib.pcm(lib.entries('x').clips[0].id).pcm, 24000, { cls: 'breath_in', gainDb: -6 });
    assert.ok(Math.abs(clip.activeDb - levels(onAir, 24000).activeDb) < .6, `reel ${clip.activeDb} vs air ${levels(onAir, 24000).activeDb}`);
    assert.ok(clip.activeDb < -33, 'a -6 dB breath is far below speech, as on air');
    const mid = seg('joy/mid', 'joy/high'), high = seg('joy/high', 'breath_in');
    assert.ok(high.activeDb - mid.activeDb > INTENSITY_DB.high - INTENSITY_DB.mid - .6, `${mid.activeDb} → ${high.activeDb}`);
});

test('audition: a library at its size limits is heard in full, past 120 s of reel', async t => {
    // Every clip class at its duration cap × takesPerClass, then phrase takes up to LIBRARY_LIMITS.totalMs: all of it can air.
    const c = cfg(t, { reactionAudio: true, phraseCache: true, hostStyleMap: { joy: 3 } }), { fetchFn } = fixture(vvRoutes()), a = createAdapter('voicevox', c, forbidden);
    const clips = [], phrases = [], pcm = new Map();
    let total = 0, hz = 200;
    const add = (list, row, ms) => { list.push(row); pcm.set(row.id, { pcm: sine(ms / 1000, hz += 7), rate: 24000 }); total += ms; };
    for (const cls of NONVERBAL_CLASSES) for (let k = 0; k < LIBRARY_LIMITS.takesPerClass; k++) add(clips, { id: `${cls}-${k + 1}`, cls }, CLIP_MS[cls]);
    for (let k = 0; total < LIBRARY_LIMITS.totalMs; k++) add(phrases, { id: `p${k}`, id16: a.identity16(), text: `ちょっと待って！#${k}`, renderKey: 'a'.repeat(64), source: 'tts' }, Math.min(LIBRARY_LIMITS.phraseMaxMs, LIBRARY_LIMITS.totalMs - total));
    phrases.push({ id: 'other', id16: '0123456789abcdef', text: 'other voice', renderKey: 'b'.repeat(64), source: 'tts' });
    assert.equal(total, LIBRARY_LIMITS.totalMs);
    const lib = { kinds: () => NONVERBAL_CLASSES, hasPhrase: () => false, pcm: id => pcm.get(id) ?? null,
        entries: id16 => ({ clips: clips.map(({ id, cls }) => ({ id, cls })), phrases: phrases.filter(x => x.id16 === id16).map(({ id, text, renderKey, source }) => ({ id, text, renderKey, source })) }) };
    const r = await new DirectedVoice(c, ledger(), { fetchFn, library: lib }).audition();
    const mine = phrases.filter(x => x.id16 === a.identity16());
    assert.equal(r.truncated, 0);
    assert.deepEqual(r.index.map(x => [x.label, x.kind]), [['neutral/mid', 'style'], ['neutral/high', 'style'], ['joy/mid', 'style'], ['joy/high', 'style'], ...clips.map(x => [x.cls, 'clip']), ...mine.map(x => [x.text, 'phrase'])]);
    assert.ok(r.durationMs > LIBRARY_LIMITS.totalMs + (r.index.length - 1) * 350, String(r.durationMs));
    assert.ok(Math.abs(readWav(r.bytes, { maxSeconds: 600 }).ms - r.durationMs) <= 1);
});

test('reaction budget: a clip adding more than maxReactionAudioMs is dropped; the allowance never exceeds it', async t => {
    const { r, d, c } = await clipRig(t);
    const p = d.plan(shockText, { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0];
    const kept = await r.renderPart(p);
    assert.equal(kept.stats.clip, 'gasp'); assert.ok(kept.clipMs > 300 && kept.clipMs <= c.maxReactionAudioMs);
    c.maxReactionAudioMs = kept.clipMs - 1;
    const over = await r.renderPart(p);
    assert.equal(over.stats.clip, null); assert.equal(over.stats.clipSkipped, 'reaction_budget'); assert.equal(over.clipMs, 0);
    c.maxReactionAudioMs = kept.clipMs;
    assert.equal((await r.renderPart(p)).stats.clip, 'gasp', 'exactly at the budget is allowed');
});

test('burn-in: show start renders the burn-in sentences on the host voice, uncached, one reservation; failures are swallowed', async t => {
    const c = cfg(t, { replyTtsProvider: 'voicevox', speechDirection: 'off' }), log = [], { fetchFn } = fixture(vvRoutes(), log), l = ledger();
    const v = new DirectedVoice(c, l, { fetchFn, library: null });
    assert.equal(v.passThrough(), true);
    assert.equal(await v.warmup(), null); assert.deepEqual(log, [], 'rehearsal-style warmup stays silent in pass-through');
    await v.warmup(undefined, { burnIn: true });
    assert.equal(log.filter(p => p === '/synthesis').length, BURN_IN.length); assert.equal(l.calls.tts, 1);
    const n = log.length; await v.warmup(undefined, { burnIn: true });
    assert.equal(log.length - n, log.filter(p => p !== '').length - n, 'no cache: a second show start renders again');
    assert.equal(log.filter(p => p === '/synthesis').length, BURN_IN.length * 2);
    const down = new DirectedVoice(c, ledger(), { fetchFn: async () => { throw new TypeError('fetch failed'); }, library: null });
    assert.equal(await down.warmup(undefined, { burnIn: true }), null);
    assert.equal(down.router.status().main.state === 'open', false, 'burn-in never opens the circuit');
});
