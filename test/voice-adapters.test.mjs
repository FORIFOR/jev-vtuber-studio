import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, ENGINE_INFO, PACE_MULT, AIVIS_UUID, TtsError, wrapError, createAdapter, createAdapters } from '../src/tts-adapters.mjs';
import { hash } from '../src/util.mjs';
import { setup, response, wav } from './helpers.mjs';

const AIVIS = { aivisURL: 'http://127.0.0.1:10101', aivisStyle: 888753760, aivisSpeed: 1, aivisIntonation: 1, aivisTempo: 1 };
const SBV2 = { sbv2URL: 'http://127.0.0.1:5055', sbv2Model: 'jvnv-F1-jp', sbv2Speaker: '', sbv2Style: 'Neutral', sbv2StyleWeight: 1, sbv2Speed: 1 };
const cfg = (t, patch = {}) => Object.assign(setup(t), { hostStyleMap: {} }, AIVIS, SBV2, patch);
// Loopback-free engine fixture: routes by pathname, records every request, 404 for anything else.
function fixture(routes = {}) {
    const calls = [];
    const fetchFn = async (u, o = {}) => {
        const url = new URL(u); calls.push({ url, o, body: typeof o.body === 'string' ? JSON.parse(o.body) : o.body });
        const route = routes[url.pathname];
        return route ? route(url, o) : new Response('missing', { status: 404 });
    };
    return { calls, fetchFn };
}
const aivisQuery = () => ({ accent_phrases: [], speedScale: 1, intonationScale: 1, tempoDynamicsScale: 1, pitchScale: 0, volumeScale: 1, prePhonemeLength: .1, postPhonemeLength: .1, pauseLength: null, pauseLengthScale: 1, outputSamplingRate: 44100, outputStereo: false, kana: 'X' });
const MANIFEST = { name: 'AivisSpeech Engine', brand_name: 'AivisSpeech', uuid: AIVIS_UUID, default_sampling_rate: 44100 };
const aivisRoutes = (patch = {}) => ({ '/version': () => response('1.2.0'), '/engine_manifest': () => response(MANIFEST), '/audio_query': () => response(aivisQuery()), '/synthesis': () => new Response(wav(.2)), '/initialize_speaker': () => new Response(null, { status: 204 }), ...patch });
const sbv2Model = (dir, styles = ['Neutral', 'Happy', 'Surprise'], speakers = ['jvnv-F1-jp']) => ({ config_path: `model_assets/${dir}/config.json`, model_path: `model_assets/${dir}/${dir}_e100.safetensors`, device: 'cpu', spk2id: Object.fromEntries(speakers.map((s, i) => [s, i])), id2spk: Object.fromEntries(speakers.map((s, i) => [String(i), s])), style2id: Object.fromEntries(styles.map((s, i) => [s, i])) });
const sbv2Routes = (info = { 0: sbv2Model('jvnv-F1-jp'), 1: sbv2Model('amitaro', ['Neutral', '01'], ['あみたろ']) }, patch = {}) => ({ '/models/info': () => response(info), '/voice': () => new Response(wav(.2)), ...patch });
const code = c => e => { assert.ok(e instanceof TtsError, `expected TtsError, got ${e?.name}`); assert.equal(e.code, c); return true; };

test('exports list the four local engines and two opt-in cloud engines, their limits and style kinds', t => {
    assert.deepEqual(PROVIDERS, ['voicevox', 'supertonic', 'aivisspeech', 'sbv2', 'gemini-tts', 'gemini-lite-tts']);
    assert.equal(ENGINE_INFO['gemini-tts'].model, 'gemini-3.8-flash-tts'); assert.equal(ENGINE_INFO['gemini-lite-tts'].model, 'gemini-3.8-flash-lite-tts');
    assert.ok(ENGINE_INFO['gemini-tts'].cloud && ENGINE_INFO['gemini-tts'].vocalTags);
    assert.deepEqual(ENGINE_INFO.voicevox, { label: 'VOICEVOX', maxChars: 200, expressive: true, styles: 'id' });
    assert.deepEqual(ENGINE_INFO.aivisspeech, { label: 'AivisSpeech', maxChars: 200, expressive: true, styles: 'id' });
    assert.deepEqual(ENGINE_INFO.sbv2, { label: 'Style-Bert-VITS2', maxChars: 100, expressive: true, styles: 'name' });
    assert.deepEqual(ENGINE_INFO.supertonic, { label: 'Supertonic 3', maxChars: 300, expressive: false, styles: null });
    assert.deepEqual(PACE_MULT, { slow: .92, normal: 1, fast: 1.08 });
    const all = createAdapters(cfg(t), () => { throw new Error('Network forbidden'); });
    assert.deepEqual(Object.keys(all), PROVIDERS);
    for (const id of PROVIDERS) { assert.equal(all[id].id, id); assert.equal(all[id].info, ENGINE_INFO[id]); }
    assert.throws(() => createAdapter('cloud', cfg(t)), code('TTS_REJECTED'));
    assert.throws(() => createAdapter('__proto__', cfg(t)), code('TTS_REJECTED'));
    const bare = createAdapters(setup(t));
    assert.equal(bare.aivisspeech.url(), 'http://127.0.0.1:10101'); assert.equal(bare.sbv2.url(), 'http://127.0.0.1:5055');
});

test('VOICEVOX calls audio_query then synthesis with the resolved delivery', async t => {
    const c = cfg(t, { hostStyleMap: { surprise: 8, joy: 'Happy' } });
    const { calls, fetchFn } = fixture({ '/audio_query': () => response({ speedScale: 1, intonationScale: 1, volumeScale: 1 }), '/synthesis': () => new Response(wav(.25)) });
    const a = createAdapter('voicevox', c, fetchFn);
    assert.deepEqual(a.resolve(null), { speaker: c.speaker, speedScale: c.voiceSpeed, intonationScale: 1 });
    assert.equal(a.resolve({ family: 'neutral', intensity: 'mid', pace: 'normal' }).speedScale, c.voiceSpeed);
    assert.equal(a.resolve({ family: 'neutral', intensity: 'high', pace: 'normal' }).intonationScale, 1.15);
    assert.equal(a.resolve({ intensity: 'low' }).intonationScale, .9);
    assert.equal(a.resolve({ pace: 'fast' }).speedScale, 1.145, 'rounded to 3 decimals');
    assert.equal(a.resolve({ family: 'surprise' }).speaker, 8);
    assert.equal(a.resolve({ family: 'joy' }).speaker, c.speaker, 'a style name is ignored by an id engine');
    assert.equal(a.resolve({ family: 'constructor' }).speaker, c.speaker);
    const bytes = await a.synthesize('えっ、本当に？', a.resolve({ family: 'surprise', intensity: 'high', pace: 'normal' }));
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(calls.map(x => x.url.pathname), ['/audio_query', '/synthesis']);
    assert.equal(calls[0].o.method, 'POST'); assert.equal(calls[0].o.body, undefined);
    assert.equal(calls[0].url.searchParams.get('text'), 'えっ、本当に？');
    assert.deepEqual(calls.map(x => x.url.searchParams.get('speaker')), ['8', '8']);
    assert.equal(calls[1].o.method, 'POST');
    assert.deepEqual(calls[1].body, { speedScale: c.voiceSpeed, intonationScale: 1.15, volumeScale: .9 });
    assert.ok(calls.every(x => x.url.origin === c.voiceURL));
});

test('VOICEVOX probe, warm-up and voice list never reserve budget', async t => {
    const c = cfg(t, { hostStyleMap: { surprise: 8, joy: 3, calm: 'Calm' } }), ledger = { reserve() { throw new Error('warm-up must not reserve'); } };
    const { calls, fetchFn } = fixture({ '/version': () => response('0.14.5'), '/initialize_speaker': () => new Response(null, { status: 204 }), '/speakers': () => response([{ name: '四国めたん', speaker_uuid: 'u1', styles: [{ name: 'ノーマル', id: 2 }, { name: 'bad', id: 'x' }] }]) });
    const a = createAdapter('voicevox', c, fetchFn);
    assert.deepEqual(await a.probe(), { ok: true, version: '0.14.5', detail: {} });
    const w = await a.warmup(undefined, ledger);
    assert.ok(Number.isInteger(w.ms) && w.ms >= 0);
    const init = calls.filter(x => x.url.pathname === '/initialize_speaker');
    assert.deepEqual(init.map(x => x.url.searchParams.get('speaker')), ['3', '8']);
    assert.ok(init.every(x => x.o.method === 'POST' && x.url.searchParams.get('skip_reinit') === 'true'));
    assert.deepEqual(await a.voices(), [{ id: 2, name: '四国めたん / ノーマル', credit: 'VOICEVOX:四国めたん' }]);
});

test('AivisSpeech keeps kana and pitch, sends only its three scales, and stays on its style id', async t => {
    const c = cfg(t, { aivisIntonation: 2 }), { calls, fetchFn } = fixture(aivisRoutes());
    const a = createAdapter('aivisspeech', c, fetchFn);
    const p = a.resolve({ family: 'joy', intensity: 'high', pace: 'fast' });
    assert.deepEqual(p, { speaker: 888753760, speedScale: 1.08, intonationScale: 2, tempoDynamicsScale: 1.15 });
    assert.equal(a.resolve({ intensity: 'low', pace: 'slow' }).tempoDynamicsScale, .9);
    await a.synthesize('やったあ、うれしい！', p);
    assert.deepEqual(calls.map(x => x.url.pathname), ['/audio_query', '/synthesis']);
    assert.deepEqual(calls.map(x => x.url.searchParams.get('speaker')), ['888753760', '888753760']);
    assert.deepEqual(calls[1].body, { ...aivisQuery(), speedScale: 1.08, intonationScale: 2, tempoDynamicsScale: 1.15 });
    assert.equal(calls[1].body.kana, 'X'); assert.equal(calls[1].body.pitchScale, 0); assert.equal(calls[1].body.volumeScale, 1);
    assert.ok(calls.every(x => x.url.port === '10101'), 'no other engine is ever contacted');
    c.hostStyleMap = { surprise: 1234567890, worry: 'Sad' };
    assert.equal(a.resolve({ family: 'surprise' }).speaker, 1234567890);
    assert.equal(a.resolve({ family: 'worry' }).speaker, 888753760);
});

test('AivisSpeech identity needs manifest name AND uuid; unset style is rejected before any fetch', async t => {
    const c = cfg(t), ok = fixture(aivisRoutes());
    assert.deepEqual(await createAdapter('aivisspeech', c, ok.fetchFn).health(), { ok: true, version: '1.2.0', detail: { name: 'AivisSpeech Engine' } });
    assert.deepEqual(ok.calls.map(x => x.url.pathname), ['/version', '/engine_manifest']);
    const voicevoxLike = fixture(aivisRoutes({ '/engine_manifest': () => response({ name: 'DUMMY Engine', uuid: '088f2d8a-5b9c-4c2a-9c5e-1f0c4e2b8a11', default_sampling_rate: 24000 }) }));
    await assert.rejects(createAdapter('aivisspeech', c, voicevoxLike.fetchFn).health(), code('TTS_ENGINE_MISMATCH'));
    const wrongUuid = fixture(aivisRoutes({ '/engine_manifest': () => response({ ...MANIFEST, uuid: 'x' }) }));
    await assert.rejects(createAdapter('aivisspeech', c, wrongUuid.fetchFn).health(), code('TTS_ENGINE_MISMATCH'));
    const wrongName = fixture(aivisRoutes({ '/engine_manifest': () => response({ ...MANIFEST, name: 'VOICEVOX Engine' }) }));
    await assert.rejects(createAdapter('aivisspeech', c, wrongName.fetchFn).probe(), code('TTS_ENGINE_MISMATCH'), 'the right uuid alone is not enough');
    const airplay = fixture(aivisRoutes({ '/version': () => new Response('', { status: 403 }) }));
    await assert.rejects(createAdapter('aivisspeech', c, airplay.fetchFn).health(), code('TTS_ENGINE_MISMATCH'));
    const html = fixture(aivisRoutes({ '/engine_manifest': () => new Response('<html>') }));
    await assert.rejects(createAdapter('aivisspeech', c, html.fetchFn).health(), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(createAdapter('aivisspeech', c, async () => { throw new TypeError('fetch failed'); }).health(), code('TTS_ENGINE_DOWN'));
    const unset = fixture(aivisRoutes());
    await assert.rejects(createAdapter('aivisspeech', cfg(t, { aivisStyle: 0 }), unset.fetchFn).health(), e => code('TTS_REJECTED')(e) && /AIVIS_STYLE/.test(e.message));
    assert.equal(unset.calls.length, 0);
});

test('AivisSpeech health cache honours maxAgeMs, identity changes and invalidate()', async t => {
    const c = cfg(t), { calls, fetchFn } = fixture(aivisRoutes()), a = createAdapter('aivisspeech', c, fetchFn);
    let now = 1000; a.now = () => now;
    const probes = () => calls.filter(x => x.url.pathname === '/engine_manifest').length;
    await a.health(undefined, { maxAgeMs: 60000 }); await a.health(undefined, { maxAgeMs: 60000 });
    assert.equal(probes(), 1);
    await a.health(undefined, { maxAgeMs: 0 }); assert.equal(probes(), 2, 'maxAgeMs 0 always probes');
    now += 59999; await a.health(undefined, { maxAgeMs: 60000 }); assert.equal(probes(), 2);
    now += 1; await a.health(undefined, { maxAgeMs: 60000 }); assert.equal(probes(), 3, 'expired entry probes again');
    a.invalidate(); await a.health(undefined, { maxAgeMs: 60000 }); assert.equal(probes(), 4);
    c.aivisStyle = 5; await a.health(undefined, { maxAgeMs: 60000 }); assert.equal(probes(), 5, 'a new identity is a cache miss');
    c.aivisURL = 'http://127.0.0.1:10102'; await a.health(undefined, { maxAgeMs: 60000 }); assert.equal(probes(), 6, 'a new URL is a cache miss');
    const failing = fixture(aivisRoutes({ '/engine_manifest': () => response({ name: 'VOICEVOX Engine' }) })), b = createAdapter('aivisspeech', c, failing.fetchFn);
    await assert.rejects(b.health(undefined, { maxAgeMs: 60000 }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(b.health(undefined, { maxAgeMs: 60000 }), code('TTS_ENGINE_MISMATCH'));
    assert.equal(failing.calls.filter(x => x.url.pathname === '/engine_manifest').length, 2, 'failures are never cached');
});

test('AivisSpeech warm-up, style list and model license hint', async t => {
    const c = cfg(t, { hostStyleMap: { joy: 888753761, calm: 'Calm' } }), policy = '# ACML-NC 1.0\nこのモデルは非営利目的に限り利用できます。';
    const { calls, fetchFn } = fixture(aivisRoutes({
        '/speakers': () => response([{ name: 'まい', speaker_uuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2317', styles: [{ name: 'ノーマル', id: 888753760, type: 'talk' }, { name: 'ふつう', id: 888753761, type: 'talk' }] }]),
        '/speaker_info': () => response({ policy, portrait: '', style_infos: [] }) }));
    const a = createAdapter('aivisspeech', c, fetchFn);
    await a.warmup(undefined, { reserve() { throw new Error('warm-up must not reserve'); } });
    assert.deepEqual(calls.map(x => x.url.pathname), ['/version', '/engine_manifest', '/initialize_speaker', '/initialize_speaker']);
    assert.deepEqual(calls.slice(2).map(x => x.url.searchParams.get('speaker')), ['888753760', '888753761']);
    const voices = await a.voices();
    assert.deepEqual(voices[0], { id: 888753760, name: 'まい / ノーマル', credit: 'AivisSpeech:まい', speakerUuid: 'e756b8e4-b606-4e15-99b1-3f9c6a1b2317' });
    const lic = await a.license(voices[0].speakerUuid);
    assert.equal(lic.present, true); assert.equal(lic.nonCommercialHint, true); assert.ok(lic.excerpt.length <= 400 && !lic.excerpt.includes('\n'));
    const q = calls.at(-1).url.searchParams;
    assert.equal(q.get('speaker_uuid'), 'e756b8e4-b606-4e15-99b1-3f9c6a1b2317'); assert.equal(q.get('resource_format'), 'url');
    const none = createAdapter('aivisspeech', c, fixture({ '/speaker_info': () => response({ policy: '' }) }).fetchFn);
    assert.deepEqual(await none.license('u'), { present: false, nonCommercialHint: false, excerpt: '' });
});

test('SBV2 synthesis is a query-only POST with an exact parameter whitelist', async t => {
    const c = cfg(t, { sbv2StyleWeight: 4, sbv2Speed: 1.1, hostStyleMap: { surprise: 'Surprise', joy: 7 } }), { calls, fetchFn } = fixture(sbv2Routes());
    const a = createAdapter('sbv2', c, fetchFn);
    const p = a.resolve({ family: 'surprise', intensity: 'high', pace: 'fast' });
    assert.deepEqual(p, { model_name: 'jvnv-F1-jp', style: 'Surprise', style_weight: 5, length: Math.round(1 / (1.1 * 1.08) * 1000) / 1000, sdp_ratio: .3 });
    assert.equal(a.resolve({ family: 'joy' }).style, 'Neutral', 'a numeric map value is ignored by a name engine');
    assert.equal(a.resolve({ intensity: 'low', pace: 'slow' }).style_weight, 2.8);
    assert.equal(a.resolve({ pace: 'slow' }).sdp_ratio, .15);
    await a.synthesize('えっ、ちょっと待って！', p);
    assert.equal(calls.length, 1);
    const [{ url, o }] = calls;
    assert.equal(url.pathname, '/voice'); assert.equal(url.port, '5055');
    assert.equal(o.method, 'POST'); assert.equal(o.body, undefined); assert.equal(o.headers['Content-Type'], undefined);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['auto_split', 'language', 'length', 'model_name', 'noise', 'noisew', 'sdp_ratio', 'style', 'style_weight', 'text']);
    assert.equal(url.searchParams.get('text'), 'えっ、ちょっと待って！');
    assert.equal(url.searchParams.get('style_weight'), '5'); assert.equal(url.searchParams.get('auto_split'), 'false'); assert.equal(url.searchParams.get('language'), 'JP');
    assert.equal(Number(url.searchParams.get('length')), p.length);
    c.sbv2Speaker = 'jvnv-F1-jp';
    await a.synthesize('うん。', { ...a.resolve(null), encoding: 'utf-8', assist_text: 'x', reference_audio_path: '/etc/x.wav', model_id: 3, speaker_id: 1 });
    assert.deepEqual([...calls[1].url.searchParams.keys()].sort(), ['auto_split', 'language', 'length', 'model_name', 'noise', 'noisew', 'sdp_ratio', 'speaker_name', 'style', 'style_weight', 'text']);
    assert.equal(calls[1].url.searchParams.get('speaker_name'), 'jvnv-F1-jp');
    assert.ok(calls.every(x => x.url.pathname === '/voice'), 'never /status, /g2p or /tools/get_audio');
    c.sbv2Model = '';
    await assert.rejects(a.synthesize('うん。', a.resolve(null)), code('TTS_REJECTED'));
    assert.equal(calls.length, 2, 'an empty model never lets the server pick model 0');
});

test('SBV2 input guard rejects before any fetch', async t => {
    const { calls, fetchFn } = fixture(sbv2Routes()), a = createAdapter('sbv2', cfg(t), fetchFn);
    for (const text of ['あ'.repeat(101), 'こんにちは\nまたね', 'こんにちは\rまたね', 'a<b', 'a>b', 'a\u0000b', '', '   ', null, 42])
        await assert.rejects(a.synthesize(text, a.resolve(null)), e => /Invalid TTS input/.test(e.message) && e.code === 'TTS_REJECTED');
    assert.equal(calls.length, 0);
    await a.synthesize('あ'.repeat(100), a.resolve(null));
    assert.equal(calls.length, 1);
    const v = createAdapter('voicevox', cfg(t), fetchFn);
    assert.throws(() => v.validateText('あ'.repeat(201)), /Invalid TTS input/); v.validateText('あ'.repeat(200));
    assert.throws(() => v.validateText('<laugh>'), /Invalid TTS input/);
});

test('SBV2 probe checks identity, model folder, mapped styles and speaker', async t => {
    const probe = (patch, routes = sbv2Routes()) => createAdapter('sbv2', cfg(t, patch), fixture(routes).fetchFn).health();
    const ok = await probe({ hostStyleMap: { surprise: 'Surprise', joy: 'Happy' } });
    assert.deepEqual(ok, { ok: true, version: null, detail: { model: 'jvnv-F1-jp', styles: ['Neutral', 'Happy', 'Surprise'], speakers: ['jvnv-F1-jp'] } });
    await assert.rejects(probe({}, { '/models/info': () => new Response('', { status: 403, headers: { Server: 'AirTunes/980.77.5' } }) }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(probe({}, { '/models/info': () => new Response('', { status: 500 }) }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(probe({}, { '/models/info': () => response([sbv2Model('jvnv-F1-jp')]) }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(probe({}, { '/models/info': () => response({ 0: { config_path: 'a/b/config.json' } }) }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(probe({}, { '/models/info': () => response({}) }), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(createAdapter('sbv2', cfg(t), async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }).health(), code('TTS_ENGINE_DOWN'));
    await assert.rejects(probe({ sbv2Model: 'koharune-ami' }), e => code('TTS_REJECTED')(e) && /model/.test(e.message));
    await assert.rejects(probe({ sbv2Model: '' }), code('TTS_REJECTED'));
    await assert.rejects(probe({ hostStyleMap: { shy: 'Shy' } }), e => code('TTS_REJECTED')(e) && /style/.test(e.message));
    await assert.rejects(probe({ sbv2Style: 'Calm' }), code('TTS_REJECTED'));
    await assert.rejects(probe({ sbv2Speaker: 'nobody' }), e => code('TTS_REJECTED')(e) && /speaker/.test(e.message));
    assert.equal((await probe({ sbv2Model: 'amitaro', sbv2Style: '01', sbv2Speaker: 'あみたろ' })).detail.model, 'amitaro');
    const windows = { 3: { ...sbv2Model('x'), config_path: 'C:\\sbv2\\model_assets\\koharune-ami\\config.json' } };
    assert.equal((await probe({ sbv2Model: 'koharune-ami' }, sbv2Routes(windows))).detail.model, 'koharune-ami');
    const weightsOnly = { 0: { ...sbv2Model('x'), config_path: '', model_path: 'D:\\m\\my-voice\\my-voice.safetensors' } };
    assert.equal((await probe({ sbv2Model: 'my-voice' }, sbv2Routes(weightsOnly))).detail.model, 'my-voice');
});

test('SBV2 warm-up probes, reserves once, then renders one budgeted syllable', async t => {
    const order = [], { calls, fetchFn } = fixture(sbv2Routes()), c = cfg(t);
    const a = createAdapter('sbv2', c, async (u, o) => { order.push(new URL(u).pathname); return fetchFn(u, o); });
    await a.warmup(undefined, { reserve(k) { order.push(`reserve:${k}`); } });
    assert.deepEqual(order, ['/models/info', 'reserve:tts', '/voice']);
    assert.equal(calls[1].url.searchParams.get('text'), 'あ');
    const ledger = { n: 0, reserve() { this.n++; } };
    await assert.rejects(createAdapter('sbv2', cfg(t, { sbv2Model: 'missing' }), fetchFn).warmup(undefined, ledger), code('TTS_REJECTED'));
    assert.equal(ledger.n, 0, 'a failed probe never reserves');
    assert.deepEqual(await a.voices(), [{ name: 'jvnv-F1-jp', speakers: ['jvnv-F1-jp'], styles: ['Neutral', 'Happy', 'Surprise'] }, { name: 'amitaro', speakers: ['あみたろ'], styles: ['Neutral', '01'] }]);
});

test('Supertonic clamps speed to .7, sends Japanese and requires Supertonic 3', async t => {
    const c = cfg(t, { supertonicSpeed: .5 }), { calls, fetchFn } = fixture({ '/v1/tts': () => new Response(wav(.2)), '/v1/health': () => response({ model: 'supertonic-3', status: 'ok' }) });
    const a = createAdapter('supertonic', c, fetchFn);
    assert.deepEqual(a.resolve({ family: 'joy', intensity: 'high', pace: 'slow' }), { voice: 'F1', speed: .7 });
    c.supertonicSpeed = 1.9; assert.equal(a.resolve({ pace: 'fast' }).speed, 2);
    c.supertonicSpeed = 1.05; assert.equal(a.resolve({ pace: 'fast' }).speed, 1.134);
    c.supertonicSpeed = .5;
    await a.synthesize('こんばんは。', a.resolve(null));
    assert.deepEqual(calls[0].body, { text: 'こんばんは。', voice: 'F1', lang: 'ja', steps: 8, speed: .7, response_format: 'wav' });
    await a.synthesize('こんばんは。', a.resolve(null), undefined, { quality: { steps: 32 } });
    assert.equal(calls[1].body.steps, 32);
    assert.deepEqual(await a.health(), { ok: true, version: null, detail: { model: 'supertonic-3' } });
    assert.equal((await a.voices()).length, 10);
    const v2 = createAdapter('supertonic', c, fixture({ '/v1/health': () => response({ model: 'supertonic-2', status: 'ok' }) }).fetchFn);
    await assert.rejects(v2.health(), e => code('SUPERTONIC_NOT_READY')(e) && /Supertonic 3/.test(e.message));
    const loading = createAdapter('supertonic', c, fixture({ '/v1/health': () => response({ model: 'supertonic-3', status: 'loading' }) }).fetchFn);
    await assert.rejects(loading.warmup(), code('SUPERTONIC_NOT_READY'));
    // Another service or an older server on the port is not ready, never a settings rejection; transient failures stay DOWN.
    const health = route => createAdapter('supertonic', c, fixture({ '/v1/health': route }).fetchFn);
    for (const s of [404, 403, 405])
        await assert.rejects(health(() => new Response('x', { status: s })).health(), e => code('SUPERTONIC_NOT_READY')(e) && e.status === s);
    await assert.rejects(createAdapter('supertonic', c, fixture().fetchFn).probe(), e => code('SUPERTONIC_NOT_READY')(e) && e.status === 404);
    await assert.rejects(health(() => new Response('<html>')).probe(), e => code('SUPERTONIC_NOT_READY')(e) && e.status === undefined);
    for (const s of [500, 503, 429, 408])
        await assert.rejects(health(() => new Response('x', { status: s })).probe(), e => code('TTS_ENGINE_DOWN')(e) && e.status === s);
});

test('wrapError classifies engine failures and never wraps an abort', async t => {
    const http = s => Object.assign(new Error(`Provider HTTP ${s}`), { status: s });
    assert.equal(wrapError(http(500)).code, 'TTS_ENGINE_DOWN'); assert.equal(wrapError(http(500)).status, 500);
    assert.equal(wrapError(http(503)).code, 'TTS_ENGINE_DOWN');
    assert.equal(wrapError(http(408)).code, 'TTS_ENGINE_DOWN'); assert.equal(wrapError(http(429)).code, 'TTS_ENGINE_DOWN');
    assert.equal(wrapError(http(422)).code, 'TTS_REJECTED'); assert.equal(wrapError(http(404)).code, 'TTS_REJECTED');
    assert.equal(wrapError(new TypeError('fetch failed')).code, 'TTS_ENGINE_DOWN');
    assert.equal(wrapError(new DOMException('timed out', 'TimeoutError')).code, 'TTS_ENGINE_DOWN');
    assert.equal(wrapError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).code, 'TTS_ENGINE_DOWN');
    for (const m of ['TTS must return WAV', 'Truncated WAV', 'Unsupported WAV encoding', 'Invalid WAV duration']) assert.equal(wrapError(new Error(m)).code, 'TTS_ENGINE_DOWN');
    assert.equal(wrapError(new Error('surprise')).code, 'TTS_ENGINE_DOWN');
    const own = new TtsError('TTS_ENGINE_MISMATCH', 'x'); assert.equal(wrapError(own), own);
    assert.ok(wrapError(http(500)) instanceof Error); assert.equal(wrapError(http(500)).name, 'TtsError');
    const c = cfg(t);
    const badWav = createAdapter('voicevox', c, fixture({ '/audio_query': () => response({}), '/synthesis': () => new Response('not a wav at all') }).fetchFn);
    await assert.rejects(badWav.synthesize('こんにちは', null), code('TTS_ENGINE_DOWN'));
    const tooLong = createAdapter('supertonic', c, fixture({ '/v1/tts': () => new Response(wav(46)) }).fetchFn);
    await assert.rejects(tooLong.synthesize('こんにちは', null), code('TTS_ENGINE_DOWN'));
    const rejected = createAdapter('aivisspeech', c, fixture(aivisRoutes({ '/synthesis': () => new Response('{}', { status: 422 }) })).fetchFn);
    await assert.rejects(rejected.synthesize('こんにちは', null), e => code('TTS_REJECTED')(e) && e.status === 422);
    const controller = new AbortController(), reason = new Error('turn aborted');
    assert.equal(wrapError(new TypeError('fetch failed'), (controller.abort(reason), controller.signal)), reason);
    const mid = new AbortController(), midReason = new Error('skip');
    const aborting = createAdapter('voicevox', c, async () => { mid.abort(midReason); throw new DOMException('aborted', 'AbortError'); });
    await assert.rejects(aborting.synthesize('こんにちは', null, mid.signal), e => e === midReason && !(e instanceof TtsError));
    let fetched = 0;
    const early = createAdapter('sbv2', c, async () => { fetched++; return new Response(wav()); });
    await assert.rejects(early.synthesize('こんにちは', null, controller.signal), e => e === reason);
    await assert.rejects(early.health(controller.signal), e => e === reason);
    assert.equal(fetched, 0);
});

test('probe() is the public error boundary: network failures are DOWN and aborts rethrow their reason', async t => {
    const c = cfg(t, { hostStyleMap: {}, geminiKey: 'test-key-not-real' });
    const netFail = async () => { throw new TypeError('fetch failed'); }, refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const timeout = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    for (const id of PROVIDERS) for (const f of [netFail, refused, timeout]) {
        await assert.rejects(createAdapter(id, c, f).probe(), e => code('TTS_ENGINE_DOWN')(e) && e.status === undefined, `${id} ${f === timeout ? 'timeout' : 'network'}`);
        await assert.rejects(createAdapter(id, c, f).health(), code('TTS_ENGINE_DOWN'));
    }
    const v = createAdapter('voicevox', c, fixture({ '/version': () => new Response('', { status: 503 }) }).fetchFn);
    await assert.rejects(v.probe(), e => code('TTS_ENGINE_DOWN')(e) && e.status === 503);
    const mismatch = createAdapter('sbv2', c, fixture({ '/models/info': () => new Response('', { status: 403 }) }).fetchFn);
    await assert.rejects(mismatch.probe(), e => code('TTS_ENGINE_MISMATCH')(e) && e.status === 403);
    const early = new AbortController(), reason = new Error('turn aborted'); early.abort(reason);
    let fetched = 0;
    for (const id of PROVIDERS)
        await assert.rejects(createAdapter(id, c, async () => { fetched++; return response({}); }).probe(early.signal), e => e === reason && !(e instanceof TtsError), id);
    assert.equal(fetched, 0, 'an aborted probe never fetches');
    for (const id of PROVIDERS) {
        const mid = new AbortController(), midReason = new Error('skip');
        const a = createAdapter(id, c, async () => { mid.abort(midReason); throw new DOMException('aborted', 'AbortError'); });
        await assert.rejects(a.probe(mid.signal), e => e === midReason && !(e instanceof TtsError), id);
    }
});

test('identity excludes URL and quality knobs; fingerprint covers them; resolve never carries steps', t => {
    const c = cfg(t), all = createAdapters(c);
    assert.deepEqual(all.voicevox.identity(), ['voicevox', c.speaker]);
    assert.deepEqual(all.aivisspeech.identity(), ['aivisspeech', 888753760]);
    assert.deepEqual(all.sbv2.identity(), ['sbv2', 'jvnv-F1-jp', '']);
    assert.deepEqual(all.supertonic.identity(), ['supertonic', 'F1']);
    for (const a of Object.values(all)) {
        assert.match(a.identity16(), /^[a-f0-9]{16}$/);
        assert.equal(a.identity16(), hash(JSON.stringify(a.identity())).slice(0, 16));
        assert.equal(a.fingerprint(), hash(JSON.stringify([a.identity(), a.url(), a.quality()])));
    }
    const s = all.supertonic, id = s.identity16(), fp = s.fingerprint();
    assert.deepEqual(s.quality(), { steps: 8 });
    assert.ok(!('steps' in s.resolve(null)));
    c.supertonicSteps = 32; assert.equal(s.identity16(), id); assert.notEqual(s.fingerprint(), fp);
    c.supertonicSteps = 8; c.supertonicURL = 'http://127.0.0.1:7789'; assert.equal(s.identity16(), id); assert.notEqual(s.fingerprint(), fp);
    const a = all.aivisspeech, aid = a.identity16(), afp = a.fingerprint();
    c.aivisURL = 'http://127.0.0.1:10102'; assert.equal(a.identity16(), aid); assert.notEqual(a.fingerprint(), afp);
    assert.ok(Object.values(all).every(x => !JSON.stringify(x.identity()).includes('127.0.0.1')));
    assert.deepEqual(all.voicevox.quality(), {});
    const r = all.voicevox.resolve(null), before = all.voicevox.resolve(null);
    c.voiceURL = 'http://127.0.0.1:50022'; assert.deepEqual(r, before);
});

test('config is read lazily: mutating aivisStyle changes the very next request', async t => {
    const c = cfg(t), { calls, fetchFn } = fixture(aivisRoutes()), a = createAdapter('aivisspeech', c, fetchFn);
    const id = a.identity16();
    await a.synthesize('こんにちは', a.resolve(null));
    c.aivisStyle = 1234567890; c.aivisSpeed = 1.2;
    await a.synthesize('こんにちは', a.resolve(null));
    assert.deepEqual(calls.map(x => x.url.searchParams.get('speaker')), ['888753760', '888753760', '1234567890', '1234567890']);
    assert.equal(calls[3].body.speedScale, 1.2);
    assert.notEqual(a.identity16(), id);
    c.aivisURL = 'http://127.0.0.1:10199';
    await a.synthesize('こんにちは', null);
    assert.equal(calls.at(-1).url.port, '10199');
});

test('AivisSpeech 1.0.0 licence lookup: a speaker_info that inlines ~6 MB of voice samples still yields the policy', async t => {
    const c = setup(t); const big = 'A'.repeat(520000);
    const body = JSON.stringify({ policy: '# Aivis Common Model License (ACML) 1.0\n…', portrait: 'P'.repeat(130000),
        style_infos: Array.from({ length: 4 }, (_, i) => ({ id: i, icon: 'I'.repeat(130000), voice_samples: [big, big, big], voice_sample_transcripts: ['a', 'b', 'c'] })) });
    assert.ok(body.length > 6000000);
    const a = createAdapter('aivisspeech', c, async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    const l = await a.license('5680ac39-43c9-487a-bc3e-018c0d29cc38');
    assert.equal(l.present, true); assert.match(l.excerpt, /ACML/); assert.equal(l.nonCommercialHint, false);
});

test('licence hint: ACML 1.0 (which lists 非営利利用・営利利用 as allowed) is not flagged; ACML-NC is', async t => {
    const c = setup(t), l = async policy => createAdapter('aivisspeech', c, async () => response({ policy })).license('x');
    assert.equal((await l('# Aivis Common Model License (ACML) 1.0\n\n- ✅ 個人利用・法人利用・非営利利用・営利利用')).nonCommercialHint, false);
    assert.equal((await l('# Aivis Common Model License - Non Commercial (ACML-NC) 1.0\n\n非営利目的に限り')).nonCommercialHint, true);
});
