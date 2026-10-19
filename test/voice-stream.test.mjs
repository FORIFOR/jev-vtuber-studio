import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcmStream } from '../src/pcm-stream.mjs';
import { PcmPlayer } from '../public/pcm-player.mjs';
import { CloudSpend } from '../src/cloud-spend.mjs';
import { createAdapter } from '../src/tts-adapters.mjs';
import { VoiceQualityRouter, DirectedVoice } from '../src/voice-router.mjs';
import { SpeechDirector } from '../src/speech-director.mjs';
import { createApp } from '../src/server.mjs';
import { setup, ledger } from './helpers.mjs';

const KEY = 'test-key-not-real';
const cfg = (t, patch = {}) => Object.assign(setup(t), { mode: 'live', hostStyleMap: {}, replyTtsProvider: 'gemini-lite-tts', geminiKey: KEY, geminiTtsVoice: 'Kore', geminiTtsStyle: '', geminiTtsMaxUsd: 3, geminiTtsMaxUsdMonth: 10, geminiTtsStream: true, speechDirection: 'reaction', reactionAudio: true, phraseCache: false }, patch);
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-stream-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const pcm = (samples, v = 1000) => { const b = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) b.writeInt16LE(v, i * 2); return b; };
const sse = events => events.map(e => `event: ${e.event_type || 'x'}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const audioEvents = (chunks) => [{ event_type: 'interaction.created' }, { event_type: 'step.start' }, ...chunks.map(c => ({ event_type: 'step.delta', delta: { type: 'audio', data: c.toString('base64') } })), { event_type: 'step.stop' }, { event_type: 'interaction.completed' }];
function geminiStream({ body = () => sse(audioEvents([pcm(2400), pcm(2400)])), status = 200, meta = true } = {}) {
    const calls = [];
    const fetchFn = async (u, o = {}) => {
        const url = new URL(u); calls.push({ url, body: typeof o.body === 'string' ? JSON.parse(o.body) : null, o });
        if (url.pathname === '/v1beta/interactions') {
            if (status !== 200) return new Response(typeof body === 'function' ? body() : body, { status });
            const text = body(), enc = new TextEncoder();
            // Split mid-event to prove the SSE framing is reassembled.
            const stream = new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += 37) c.enqueue(enc.encode(text.slice(i, i + 37))); c.close(); } });
            return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (meta && /\/v1beta\/models\/[^/:]+$/.test(url.pathname)) return new Response(JSON.stringify({ name: `models/${url.pathname.split('/').pop()}` }));
        return new Response('missing', { status: 404 });
    };
    return { calls, fetchFn };
}

test('PcmStream keeps PCM16 frames aligned, replays to late subscribers, and rejects `first` when no audio came', async () => {
    const s = new PcmStream(), got = [];
    s.push(Buffer.from([1, 2, 3])); s.push(Buffer.from([4]));
    s.subscribe(c => got.push(c ? [...c] : null));
    s.push(Buffer.from([5, 6])); s.end();
    assert.deepEqual(got, [[1, 2], [3, 4], [5, 6], null]);
    assert.equal(s.durationMs, Math.round(3 / 24000 * 1000)); assert.equal(await s.first, s);
    const late = []; s.subscribe(c => late.push(c ? c.length : null)); assert.deepEqual(late, [2, 2, 2, null]);
    const empty = new PcmStream(); empty.end(); await assert.rejects(empty.first, /without audio/);
});

class FakeCtx {
    constructor() { this.currentTime = 0; this.started = []; }
    createBuffer(ch, n, rate) { const d = new Float32Array(n); return { duration: n / rate, getChannelData: () => d }; }
    createBufferSource() { const ctx = this; const src = { connect() { }, start(at) { ctx.started.push({ at, dur: src.buffer.duration, src }); }, stop() { src.stopped = true; }, onended: null }; return src; }
}
test('PcmPlayer: prebuffers, plays chunks back to back in order, counts underruns, fires start/end once, cancels cleanly', async () => {
    const ctx = new FakeCtx(), log = [];
    const p = new PcmPlayer({ ctx, destination: {}, rate: 1000, prebufferMs: 100, beforeStart: async () => { log.push('ack'); return true; }, onStart: () => log.push('start'), onEnd: () => log.push('end') });
    p.push(new Uint8Array(100)); assert.equal(ctx.started.length, 0, 'still buffering (50 ms of 100 ms)');
    p.push(new Uint8Array(100)); await new Promise(r => setImmediate(r));
    assert.deepEqual(log, ['ack', 'start']); assert.equal(ctx.started.length, 2);
    assert.ok(Math.abs(ctx.started[1].at - (ctx.started[0].at + ctx.started[0].dur)) < 1e-9, 'back to back');
    ctx.currentTime = 5; p.push(new Uint8Array(20)); assert.equal(p.gaps, 1, 'a late chunk is an underrun, played asap');
    p.end(); for (const s of ctx.started) s.src.onended?.();
    assert.deepEqual(log, ['ack', 'start', 'end']);
    const c2 = new FakeCtx(), log2 = [];
    const q = new PcmPlayer({ ctx: c2, destination: {}, rate: 1000, prebufferMs: 10, beforeStart: async () => false, onEnd: () => log2.push('end') });
    q.push(new Uint8Array(40)); await new Promise(r => setImmediate(r));
    assert.equal(c2.started.length, 0, 'an expired utterance never plays'); assert.equal(q.state, 'cancelled'); assert.deepEqual(log2, []);
    const c3 = new FakeCtx(), r = new PcmPlayer({ ctx: c3, destination: {}, rate: 1000, prebufferMs: 1 });
    r.push(new Uint8Array(10)); await new Promise(res => setImmediate(res)); r.cancel(); r.push(new Uint8Array(10));
    assert.ok(c3.started.every(s => s.src.stopped)); assert.equal(c3.started.length, 1, 'nothing scheduled after cancel');
});

test('Gemini stream(): Interactions API, same voice/style/tag, raw PCM chunks reassembled from split SSE; errors and quota', async t => {
    const g = geminiStream(), a = createAdapter('gemini-lite-tts', cfg(t), g.fetchFn);
    const st = a.stream('えっ、ちょっと待って！', a.resolve({ family: 'surprise', intensity: 'high', pace: 'fast' }), undefined, { tag: { cls: 'gasp', position: 'pre' } });
    await st.first; await st.finished;
    assert.equal(st.bytes, 9600); assert.equal(st.error, null);
    const req = g.calls[0];
    assert.equal(req.url.pathname, '/v1beta/interactions'); assert.equal(req.o.headers['x-goog-api-key'], KEY); assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'gemini-3.8-flash-lite-tts'); assert.deepEqual(req.body.response_format, { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 });
    assert.equal(req.body.input[0].content[0].text, '<gasp> えっ、ちょっと待って！'); assert.match(req.body.input[0].content[0].annotations[0].style, /briefly startled/);
    assert.deepEqual(req.body.generation_config, { speech_config: [{ voice: 'Kore' }] });
    assert.ok(a.usage.audioSec > 0 && a.usage.requests === 1, 'generated audio is counted');
    const bad = createAdapter('gemini-lite-tts', cfg(t), geminiStream({ body: () => sse([...audioEvents([pcm(100)]).slice(0, 3), { event_type: 'error', error: { code: 500 } }]) }).fetchFn).stream('あ。');
    await bad.finished; assert.equal(bad.error?.code, 'TTS_ENGINE_DOWN'); assert.equal(bad.bytes, 200, 'audio before the error is kept (truncated, not replayed)');
    const daily = JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
    const q = createAdapter('gemini-lite-tts', cfg(t), geminiStream({ status: 429, body: daily }).fetchFn).stream('あ。');
    await assert.rejects(q.first, e => e.code === 'TTS_BUDGET');
    assert.throws(() => a.stream('<b>x</b>'), e => e.code === 'TTS_REJECTED');
});

test('CloudSpend persists across restarts, reserves before sending, and caps day and month', t => {
    const dir = temp(t), at = { v: new Date('2026-09-27T10:00:00Z') }, now = () => at.v;
    const s = new CloudSpend(dir, { dayUsd: .01, monthUsd: .015 }, now);
    const r1 = s.reserve(.004), r2 = s.reserve(.004);
    assert.throws(() => s.reserve(.004), e => e.code === 'TTS_BUDGET', 'concurrent reservations count before settling');
    s.settle(r1, { usd: .003, audioSec: 13 }); s.settle(r2, { usd: .003, audioSec: 13 });
    const again = new CloudSpend(dir, { dayUsd: .01, monthUsd: .015 }, now);
    assert.equal(again.totals().dayUsd, .006, 'survives a restart');
    again.settle(again.reserve(.003), { usd: .003 });
    at.v = new Date('2026-09-28T10:00:00Z');
    assert.equal(again.totals().dayUsd, 0); assert.throws(() => again.reserve(.007), e => e.code === 'TTS_BUDGET', 'the month cap still applies');
});

test('router streams a cloud part: returns on the first chunk, settles spend with the generated audio, budget blocks before any request', async t => {
    const c = cfg(t), g = geminiStream(), r = new VoiceQualityRouter(c, { ledger: ledger(), fetchFn: g.fetchFn, library: null });
    const part = new SpeechDirector(c).plan('えっ、ちょっと待って！', { reaction: 'shock' }, { clipKinds: ['gasp'] }).parts[0];
    const out = await r.streamPart(part, undefined);
    assert.equal(out.kind, 'stream'); assert.ok(out.durationMs >= part.text.length * 200, 'a generous estimate until the stream ends');
    assert.equal(out.stats.vocalTag, 'gasp'); const f = out.finalize({ reaction: 'surprised' }); assert.equal(f.leadMs, 0); assert.equal(f.kind, 'stream');
    await out.stream.finished;
    assert.ok(r.spend.totals().dayUsd > 0); assert.equal(r.spend.snapshot().pendingUsd, 0);
    const blocked = geminiStream(), r2 = new VoiceQualityRouter(cfg(t, { geminiTtsMaxUsd: 0 }), { ledger: ledger(), fetchFn: blocked.fetchFn, library: null });
    await assert.rejects(r2.streamPart(part), e => e.code === 'TTS_BUDGET');
    assert.equal(blocked.calls.filter(x => x.url.pathname === '/v1beta/interactions').length, 0);
    assert.notEqual(r2.status().main.state, 'open');
    const v = new DirectedVoice(c, ledger(), { fetchFn: g.fetchFn, library: null });
    assert.equal(v.streaming(), true); v.streamingAllowed = false; assert.equal(v.streaming(), false, 'rehearsal hears whole WAVs');
});

test('/audio/<id>.pcm: view token required, replays then follows the stream, 404 once gone; a cancelled part stops generating', async t => {
    const c = setup(t); c.port = 0;
    const a = createApp(c, { remoteOptions: false }); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const url = `http://127.0.0.1:${a.server.address().port}`, id = '11111111-2222-3333-4444-555555555555';
    const st = new PcmStream(); let cancelled = false; st.cancel = () => { cancelled = true; };
    a.engine.streams.set(id, st); st.push(pcm(10));
    assert.equal((await fetch(`${url}/audio/${id}.pcm`)).status, 401);
    const res = await fetch(`${url}/audio/${id}.pcm?token=${c.viewToken}`);
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /audio\/L16; rate=24000/);
    st.push(pcm(5)); st.end();
    assert.equal(Buffer.from(await res.arrayBuffer()).length, 30);
    a.engine.dropStream(id);
    assert.equal((await fetch(`${url}/audio/${id}.pcm?token=${c.viewToken}`)).status, 404);
    const live = new PcmStream(); let stopped = false; live.cancel = () => { stopped = true; };
    a.engine.streams.set('x', live); a.engine.clearStreams();
    assert.equal(stopped, true, 'a stream nobody will play stops generating (and billing)'); assert.equal(cancelled, false, 'a finished stream is not cancelled');
});

test('voice:design sends nothing without --confirm; stores the id and preview privately; rejects a malformed answer', async t => {
    const { main } = await import('../scripts/voice-design.mjs'), { existsSync, readFileSync } = await import('node:fs');
    const c = cfg(t), calls = [], out = [];
    const ok = async (u, o) => { calls.push({ u: String(u), body: JSON.parse(o.body), key: o.headers['x-goog-api-key'] }); return new Response(JSON.stringify({ id: 'voice_abc123XYZ', sample_audio: { mime_type: 'audio/wav', data: Buffer.from('RIFFxxxx').toString('base64') } })); };
    assert.equal(await main([], { c, fetchFn: ok, log: x => out.push(x) }), 1); assert.equal(calls.length, 0);
    assert.equal(await main(['--confirm'], { c, fetchFn: ok, log: x => out.push(x) }), 0);
    assert.equal(calls[0].u, 'https://generativelanguage.googleapis.com/v1beta/voices'); assert.equal(calls[0].key, KEY);
    assert.equal(calls[0].body.voice.type, 'prompted'); assert.equal(calls[0].body.voice.language_code, 'ja-JP'); assert.match(calls[0].body.voice.prompted.input, /オリジナル/);
    assert.ok(existsSync(join(c.dataDir, 'voice-design', 'voice_abc123XYZ.wav')));
    assert.equal(JSON.parse(readFileSync(join(c.dataDir, 'voice-design', 'voice_abc123XYZ.json'), 'utf8')).id, 'voice_abc123XYZ');
    assert.ok(!out.join('\n').includes(KEY), 'the key is never printed');
    assert.equal(await main(['--confirm'], { c, fetchFn: async () => new Response(JSON.stringify({ id: '../../x' })), log: () => { } }), 1);
});

test('a quota refusal inside a 200 stream: per-day holds as TTS_BUDGET (no retry loop); per-minute stays transient', async t => {
    const refuse = message => () => sse([{ event_type: 'interaction.created' }, { event_type: 'error', error: { message, code: 'rate_limit_exceeded' } }]);
    const perDay = geminiStream({ body: refuse('Rate limit exceeded for model gemini-3.8-flash-lite-tts (limit: 10 requests per day on Free Tier). Please retry in 55s or upgrade your tier at https://ai.dev/rate-limit.') });
    const a = createAdapter('gemini-lite-tts', cfg(t, { geminiTtsVoice: 'voice_pyd5mr6u5wzj' }), perDay.fetchFn);
    await assert.rejects(a.synthesize('こんばんは。'), e => e.code === 'TTS_BUDGET');
    const perMinute = geminiStream({ body: refuse('Rate limit exceeded: requests per minute. Please retry in 5s.') });
    const b = createAdapter('gemini-lite-tts', cfg(t, { geminiTtsVoice: 'voice_pyd5mr6u5wzj' }), perMinute.fetchFn);
    await assert.rejects(b.synthesize('こんばんは。'), e => e.code === 'TTS_ENGINE_DOWN' && e.status === 429);
});
