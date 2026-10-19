import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, TtsError, VOCAL_TAGS, ENGINE_INFO } from '../src/tts-adapters.mjs';
import { VoiceQualityRouter, DirectedVoice } from '../src/voice-router.mjs';
import { SpeechDirector } from '../src/speech-director.mjs';
import { ClipGovernor } from '../public/voice-acting.mjs';
import { config } from '../src/config.mjs';
import { readWav } from '../src/wav.mjs';
import { setup, ledger, wav } from './helpers.mjs';

const KEY = 'test-key-not-real';
const cfg = (t, patch = {}) => Object.assign(setup(t), { mode: 'live', hostStyleMap: {}, replyTtsProvider: 'gemini-tts', geminiKey: KEY, geminiTtsVoice: 'Kore', geminiTtsStyle: 'a warm, playful young VTuber', geminiTtsMaxUsd: 3, speechDirection: 'reaction', reactionAudio: true, phraseCache: false }, patch);
const code = c => e => { assert.ok(e instanceof TtsError, `expected TtsError, got ${e?.name} ${e?.message}`); assert.equal(e.code, c); return true; };
const audio = (bytes = wav(.4)) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(bytes).toString('base64') } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
function gemini({ tts = () => audio(), meta = model => new Response(JSON.stringify({ name: `models/${model}` })) } = {}) {
    const calls = [];
    const fetchFn = async (u, o = {}) => {
        const url = new URL(u), body = typeof o.body === 'string' ? JSON.parse(o.body) : null; calls.push({ url, o, body });
        assert.equal(url.origin, 'https://generativelanguage.googleapis.com', 'only the fixed Google endpoint');
        const m = /\/v1beta\/models\/([^/:]+)(:generateContent)?$/.exec(url.pathname);
        return !m ? new Response('missing', { status: 404 }) : m[2] ? tts(body, o) : meta(m[1]);
    };
    return { calls, fetchFn };
}

test('Gemini TTS request: fixed endpoint, key in a header, one voice, style in speech_metadata, WAV back', async t => {
    const g = gemini(), a = createAdapter('gemini-tts', cfg(t), g.fetchFn);
    const bytes = await a.synthesize('えっ、ちょっと待って！', a.resolve({ family: 'surprise', intensity: 'high', pace: 'fast' }));
    assert.equal(readWav(bytes).rate, 24000);
    const [c] = g.calls;
    assert.equal(c.url.pathname, '/v1beta/models/gemini-3.8-flash-tts:generateContent');
    assert.equal(c.o.headers['x-goog-api-key'], KEY); assert.ok(!c.url.search.includes(KEY), 'key never in the URL');
    const p = c.body.contents[0].parts[0];
    assert.equal(p.text, 'えっ、ちょっと待って！', 'the transcript is exactly the approved text');
    assert.match(p.speech_metadata.style, /^a warm, playful young VTuber; briefly startled, then relieved; strongly expressive; speaking quickly$/);
    assert.deepEqual(c.body.generationConfig, { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } });
    const lite = gemini(); await createAdapter('gemini-lite-tts', cfg(t), lite.fetchFn).synthesize('こんばんは。');
    assert.equal(lite.calls[0].url.pathname, '/v1beta/models/gemini-3.8-flash-lite-tts:generateContent');
    const cost = a.cost(); assert.equal(cost.requests, 1); assert.ok(cost.audioSec >= 0 && cost.usd >= 0);
});

test('Gemini TTS: only whitelisted vocal tags from code; markup in text is rejected before any fetch', async t => {
    const g = gemini(), a = createAdapter('gemini-tts', cfg(t), g.fetchFn);
    await a.synthesize('えっ！', null, undefined, { tag: { cls: 'gasp', position: 'pre' } });
    await a.synthesize('よかった。', null, undefined, { tag: { cls: 'breath_out', position: 'post' } });
    await a.synthesize('ふつう。', null, undefined, { tag: { cls: '<script>', position: 'pre' } });
    assert.deepEqual(g.calls.map(c => c.body.contents[0].parts[0].text), ['<gasp> えっ！', 'よかった。 <exhales>', 'ふつう。']);
    for (const bad of ['<laugh> 仕込み', '<b>x</b>', '']) await assert.rejects(a.synthesize(bad), code('TTS_REJECTED'));
    assert.equal(g.calls.length, 3);
    assert.deepEqual(Object.keys(VOCAL_TAGS).sort(), ['breath_in', 'breath_out', 'gasp', 'laugh_big', 'laugh_small', 'sigh']);
});

test('Gemini TTS errors: no audio or 4xx is a rejection, 429/5xx is down, missing key never fetches; raw PCM is wrapped', async t => {
    const blocked = gemini({ tts: () => new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] })) });
    await assert.rejects(createAdapter('gemini-tts', cfg(t), blocked.fetchFn).synthesize('こんにちは。'), code('TTS_REJECTED'));
    await assert.rejects(createAdapter('gemini-tts', cfg(t), gemini({ tts: () => new Response('', { status: 403 }) }).fetchFn).synthesize('あ。'), code('TTS_REJECTED'));
    await assert.rejects(createAdapter('gemini-tts', cfg(t), gemini({ tts: () => new Response('', { status: 429 }) }).fetchFn).synthesize('あ。'), code('TTS_ENGINE_DOWN'));
    const none = gemini();
    await assert.rejects(createAdapter('gemini-tts', cfg(t, { geminiKey: '' }), none.fetchFn).synthesize('あ。'), code('TTS_REJECTED'));
    assert.equal(none.calls.length, 0);
    const pcm = Buffer.alloc(4800 * 2);
    const raw = gemini({ tts: () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] })) });
    const w = readWav(await createAdapter('gemini-tts', cfg(t), raw.fetchFn).synthesize('あ。'));
    assert.equal(w.rate, 24000); assert.equal(w.samples.length, 4800);
});

test('Gemini TTS probe is a free metadata GET that checks the model and voice', async t => {
    const g = gemini(), a = createAdapter('gemini-tts', cfg(t), g.fetchFn);
    assert.equal((await a.probe()).version, 'gemini-3.8-flash-tts');
    assert.equal(g.calls[0].o.method, 'GET'); assert.ok(!g.calls.some(c => c.url.pathname.endsWith(':generateContent')));
    await assert.rejects(createAdapter('gemini-tts', cfg(t), gemini({ meta: () => new Response(JSON.stringify({ name: 'models/other' })) }).fetchFn).probe(), code('TTS_ENGINE_MISMATCH'));
    await assert.rejects(createAdapter('gemini-tts', cfg(t, { geminiTtsVoice: 'Nobody' }), g.fetchFn).probe(), code('TTS_REJECTED'));
});

test('router + Gemini: a planned gasp becomes an inline tag in the same request; it airs, leads, and is budgeted', async t => {
    const c = cfg(t), g = gemini(), gov = new ClipGovernor(() => 100000);
    const r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: g.fetchFn, library: null, governor: gov, now: () => 100000 });
    const p = new SpeechDirector(c).plan('えっ、ちょっと待って！', { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0];
    assert.equal(p.clip?.cls, 'gasp');
    const out = await r.renderPart(p);
    const texts = g.calls.filter(x => x.body).map(x => x.body.contents[0].parts[0].text);
    assert.ok(texts[0].startsWith('<gasp> '), texts[0]); assert.equal(texts.join('').replace(/<gasp> /, ''), 'えっ、ちょっと待って！', 'words are exactly the approved text');
    assert.equal(out.stats.vocalTag, 'gasp'); assert.equal(out.clipMs, 0, 'inside the speech: counted against the speech budget');
    const f = out.finalize({ reaction: 'surprised' }, 100000);
    assert.equal(f.clip, 'gasp'); assert.equal(f.leadMs, 0);
    assert.equal(gov.allow('gasp', 101000), false, 'the cooldown is committed at publication');
    // Direction off: no tag, ever.
    const off = gemini(); await new VoiceQualityRouter(cfg(t, { speechDirection: 'off', reactionAudio: false }), { ledger: ledger(), fetchFn: off.fetchFn, library: null }).renderPart({ ...p, clip: null });
    assert.ok(off.calls.filter(x => x.body).every(x => !/[<>]/.test(x.body.contents[0].parts[0].text)));
});

test('router + Gemini: spend cap holds speech with TTS_BUDGET before any render; no burn-in for a cloud voice', async t => {
    const c = cfg(t, { geminiTtsMaxUsd: 0 }), g = gemini(), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: g.fetchFn, library: null });
    const p = new SpeechDirector(c).plan('こんばんは。', { reaction: 'neutral' }, {}).parts[0];
    await assert.rejects(r.renderPart(p), code('TTS_BUDGET'));
    assert.equal(g.calls.filter(x => x.body).length, 0);
    assert.notEqual(r.status().main.state, 'open', 'the cap never opens the circuit');
    assert.equal(await r.burnIn(), null); assert.equal(g.calls.filter(x => x.body).length, 0);
    const v = new DirectedVoice(cfg(t), ledger(), { fetchFn: g.fetchFn, library: null });
    assert.deepEqual(v.clipKinds(), ['gasp', 'laugh_small', 'laugh_big', 'breath_in', 'breath_out', 'sigh'], 'tag-backed kinds without a recorded library');
    assert.equal(v.passThrough(), false);
});

test('config: Gemini voice/style/cap are validated; live mode needs the key; credit and pricing are declared', t => {
    const base = { DATA_DIR: setup(t).dataDir, ADMIN_TOKEN: 'a'.repeat(48), VIEW_TOKEN: 'v'.repeat(48), REPLY_TTS_PROVIDER: 'gemini-tts' };
    assert.equal(config(base, []).geminiTtsVoice, 'Kore');
    for (const [k, v, m] of [['GEMINI_TTS_VOICE', 'Nobody', /GEMINI_TTS_VOICE/], ['GEMINI_TTS_STYLE', '<speak>', /GEMINI_TTS_STYLE/], ['GEMINI_TTS_MAX_USD', '1000', /GEMINI_TTS_MAX_USD/]])
        assert.throws(() => config({ ...base, [k]: v }, []), m);
    assert.throws(() => config({ ...base, MODE: 'live', LLM_MODEL: 'm' }, []), /GEMINI_API_KEY/);
    assert.equal(ENGINE_INFO['gemini-tts'].usdPerMAudio, 9); assert.equal(ENGINE_INFO['gemini-lite-tts'].usdPerMAudio, 6);
});

test('voice:bench and voice:library refuse a paid cloud engine without --allow-cloud (0 requests)', async t => {
    const { main } = await import('../scripts/voice-benchmark.mjs'), out = [], g = gemini(), c = cfg(t);
    assert.equal(await main(['--confirm-local', '--providers=gemini-tts', '--runs=1'], { c, fetchFn: g.fetchFn, log: x => out.push(x) }), 1);
    assert.match(out.join('\n'), /paid cloud engine; add --allow-cloud/); assert.equal(g.calls.length, 0);
    const { prerender } = await import('../scripts/voice-library.mjs');
    await assert.rejects(prerender(c, { fetchFn: g.fetchFn, log: () => { } }), /--allow-cloud/); assert.equal(g.calls.length, 0);
});

test('Gemini daily quota (free tier) is TTS_BUDGET, not an outage; a per-minute 429 stays transient', async t => {
    const daily = JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
    await assert.rejects(createAdapter('gemini-tts', cfg(t), gemini({ tts: () => new Response(daily, { status: 429 }) }).fetchFn).synthesize('あ。'), e => code('TTS_BUDGET')(e) && e.status === 429);
    const minute = JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }] } });
    await assert.rejects(createAdapter('gemini-tts', cfg(t), gemini({ tts: () => new Response(minute, { status: 429 }) }).fetchFn).synthesize('あ。'), code('TTS_ENGINE_DOWN'));
    const r = new VoiceQualityRouter(cfg(t), { ledger: ledger(), fetchFn: gemini({ tts: () => new Response(daily, { status: 429 }) }).fetchFn, library: null });
    const p = new SpeechDirector(cfg(t)).plan('こんばんは。', { reaction: 'neutral' }, {}).parts[0];
    for (let i = 0; i < 3; i++) await assert.rejects(r.renderPart(p), code('TTS_BUDGET'));
    assert.notEqual(r.status().main.state, 'open', 'quota exhaustion never opens the circuit');
});

test('a designed voice carries its own character: only the short acting cue is sent, never the persona', t => {
    const a = createAdapter('gemini-lite-tts', cfg(t, { geminiTtsVoice: 'voice_pyd5mr6u5wzj' }), gemini().fetchFn);
    assert.equal(a.resolve({ family: 'shy', intensity: 'mid', pace: 'normal' }).style, 'slightly shy, with a small smile');
    assert.equal(a.resolve({ family: 'think', intensity: 'low', pace: 'slow' }).style, 'quietly focused; subtle; speaking slowly');
    assert.ok(!JSON.stringify(a.identity()).includes('VTuber'), 'the persona is not part of the designed voice identity either');
    const prebuilt = createAdapter('gemini-lite-tts', cfg(t), gemini().fetchFn);
    assert.match(prebuilt.resolve({ family: 'neutral', intensity: 'mid', pace: 'normal' }).style, /^a warm, playful young VTuber; casual, friendly$/);
});
