import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Director, sentences } from '../src/director.mjs';
import { Memory, Ledger } from '../src/store.mjs';
import { Metrics } from '../src/metrics.mjs';
import { YouTube } from '../src/youtube.mjs';
import { saveSettings, publicSettings, videoID, detect, rehearse } from '../src/settings.mjs';
import { config } from '../src/config.mjs';
import { Conversation, Voice } from '../src/providers.mjs';
import { createApp } from '../src/server.mjs';
import { readFileSync, statSync } from 'node:fs';
import { setup, ledger, audit, active, defer, response, wav } from './helpers.mjs';
function talk(t, overrides = {}, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env });
    return new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, mood: 'warm', effect: 'none' }) },
        conversation: new Conversation(c, ledger()),
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 200, bytes: wav(.2) }) },
        research: { search: async () => { throw new Error('Talk must not search'); } }, ...overrides });
}
async function playPart(e) {
    e.nextTurnAt = 0; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending, 'approved audio should be ready');
    const data = { lease: e.renderer.lease, id: e.pending.id };
    assert.equal(e.acknowledge({ ...data, event: 'started' }), true);
    assert.equal(e.acknowledge({ ...data, event: 'ended' }), true);
    await Promise.resolve();
}
test('default profile is talk, games off and delay is no longer 2.5s', t => {
    const c = config({ DATA_DIR: setup(t).dataDir }, []); assert.equal(c.profile, 'talk'); assert.equal(c.gameEnabled, false); assert.equal(c.turnGapMs, 250);
});
test('memory compaction cannot lose concurrent appended records (A03)', async () => {
    const m = new Memory(), d = defer(); for (let i = 0; i < 12; i++) m.add(`old-${i}`);
    const job = m.compact({ ask: () => d.promise }); m.add('new concurrent utterance');
    d.resolve(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`keep${i}`, { noul: 1 }]))); await job;
    assert.equal(m.items.length, 13); assert.equal(m.items.at(-1).text, 'new concurrent utterance');
});
test('aborted memory compact never changes a new history', async () => {
    const m = new Memory(), d = defer(), ac = new AbortController(); for (let i = 0; i < 12; i++) m.add(`old-${i}`);
    const job = m.compact({ ask: () => d.promise }, ac.signal); ac.abort(); m.items = []; m.add('new session');
    d.resolve(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`keep${i}`, { noul: 0 }]))); await job;
    assert.deepEqual(m.items.map(x => x.text), ['new session']);
});
test('judge backpressure precedes spending; 40 arrivals cannot cause 40 judgements (A02)', async t => {
    let calls = 0; const e = active(talk(t, { jev: { chat: async () => { calls++; return { accept: true, action: 'reply' }; } } }));
    for (let i = 0; i < 40; i++) e.ingest({ text: `話題 ${i}`, author: `p${i}` });
    for (let i = 0; i < 40; i++) await e.classify(e.epoch, e.controller.signal);
    assert.equal(calls, 2); assert.equal(e.candidates.length, 2); assert.equal(e.intake.length, 18); assert.equal(e.stats.dropped, 20); e.stop();
});
test('expired comments are counted and dropped before Jev', async t => {
    let calls = 0; const e = active(talk(t, { jev: { chat: async () => { calls++; } } }));
    e.ingest({ text: '期限切れです' }); e.intake[0].created -= 70000;
    await e.classify(e.epoch, e.controller.signal); assert.equal(calls, 0); assert.equal(e.stats.dropped, 1); e.stop();
});
test('current-fact requests become honest unavailability, never background search', async t => {
    const e = active(talk(t, { jev: { chat: async () => ({ accept: true, action: 'research' }) } }));
    e.ingest({ text: '今日の情報を確認して' }); await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.candidates[0].kind, 'unavailable'); assert.equal(e.researchQueue.length, 0); e.stop();
});
test('topic continuity and reply return are committed only after playback', t => {
    const e = talk(t), d = e.director; d.opened = true;
    const topic = d.card.title; d.commit({ kind: 'autonomous', text: 'one' });
    assert.equal(d.card.title, topic); d.commit({ kind: 'reply', comment: 'comment', text: 'answer' });
    assert.equal(d.card.title, topic); assert.equal(d.beat, 1); assert.deepEqual(d.dialogue[0], { comment: 'comment', reply: 'answer' });
});
test('short approved turn plays in parts, memory contains only heard parts', async t => {
    const e = active(talk(t, { conversation: { generate: async () => '一文目です。二文目です。' } }));
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(e.memory.items.length, 0);
    const id = e.pending.id, lease = e.renderer.lease;
    e.acknowledge({ id, lease, event: 'started' }); e.acknowledge({ id, lease, event: 'ended' });
    assert.deepEqual(e.memory.items.map(x => x.text), ['一文目です。']);
    await playPart(e); assert.deepEqual(e.memory.items.map(x => x.text), ['一文目です。', '二文目です。']); e.stop();
});
test('part two synthesis can be pending while part one is published', async t => {
    const d = defer(); let n = 0; const e = active(talk(t, { conversation: { generate: async () => 'ひとつ。ふたつ。' }, voice: { synthesize: async () => ++n === 1 ? { kind: 'wav', durationMs: 200, bytes: wav(.2) } : d.promise } }));
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(e.pending.text, 'ひとつ。'); assert.equal(e.currentTurn.parts[1].audio, null);
    e.stop(); d.resolve({ kind: 'wav', durationMs: 200, bytes: wav(.2) }); await Promise.resolve(); assert.equal(e.pending, null);
});
test('only one speculative turn is prepared during playback', async t => {
    let calls = 0; const e = active(talk(t, { conversation: { generate: async () => `発話${++calls}です。` } }));
    await e.speakStep(e.epoch, e.controller.signal);
    e.acknowledge({ lease: e.renderer.lease, id: e.pending.id, event: 'started' });
    for (let i = 0; i < 5; i++) await e.speakStep(e.epoch, e.controller.signal);
    await e.preparationTask; // Preparation no longer blocks speakStep.
    assert.equal(calls, 2); assert.ok(e.prepared); assert.equal(e.memory.items.length, 0); e.stop();
});
test('selected comment discards autonomous speculative work but preserves current speech', async t => {
    const e = active(talk(t)); e.director.opened = true;
    await e.speakStep(e.epoch, e.controller.signal); const id = e.pending.id;
    e.acknowledge({ id, lease: e.renderer.lease, event: 'started' });
    await e.speakStep(e.epoch, e.controller.signal); await e.preparationTask; assert.equal(e.prepared.kind, 'autonomous');
    e.ingest({ text: 'わたしも窓が好きです' }); await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.prepared, null); assert.equal(e.pending.id, id); e.stop();
});
test('stop and restart discard late prepared text even when provider ignores abort', async t => {
    const d = defer(); let tts = 0; const e = active(talk(t, { conversation: { generate: () => d.promise }, voice: { synthesize: async () => { tts++; } } }));
    const job = e.speakStep(e.epoch, e.controller.signal); e.stop(); active(e); d.resolve('古い結果。'); await job;
    assert.equal(tts, 0); assert.equal(e.pending, null); e.stop();
});
test('rejected text cannot reach TTS in talk pipeline', async t => {
    let tts = 0; const e = active(talk(t, { jev: { speech: async () => ({ accept: false }) }, voice: { synthesize: async () => { tts++; } } }));
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(tts, 0); assert.equal(e.pending, null); e.stop();
});
test('closing is spoken and acknowledged before self-owned show stops', async t => {
    const e = active(talk(t)); e.director.opened = true; e.requestClose();
    assert.equal(e.ingest({ text: 'new comment' }).reason, 'comments_paused');
    for (let i = 0; i < 4 && e.running; i++) await playPart(e);
    assert.equal(e.running, false); assert.ok(e.director.closed);
});
test('300 deterministic turns keep a bounded memory and advance topics without comments', async t => {
    const e = active(talk(t)); e.director.finite = false; // Explicitly looping stress fixture, not the production programme.
    e.endAt = Date.now() + 1800000;
    for (let i = 0; i < 600; i++) await playPart(e);
    assert.ok(e.metrics.counters.turns_played >= 290); assert.ok(e.director.index > 3);
    assert.ok(e.memory.items.length <= 24); assert.equal(e.candidates.length, 0); assert.ok(e.audio.size <= 1); e.stop();
});
test('sentence segmentation keeps commas inside the same speech part', () => { assert.deepEqual(sentences('もし、そうなら。次もね！'), ['もし、そうなら。', '次もね！']); });
test('voice synthesis serializes requests and caches identical settings', async t => {
    const c = setup(t); c.mode = 'live'; const calls = []; const voice = new Voice(c, ledger(), async (u) => { calls.push(u); return u.includes('audio_query') ? response({}) : new Response(wav(.1)); });
    await Promise.all([voice.synthesize('こんにちは。'), voice.synthesize('こんにちは。')]); assert.equal(calls.length, 2);
    c.speaker++; await voice.synthesize('こんにちは。'); assert.equal(calls.length, 4);
});
test('usage token counters persist and never store request content', t => {
    const c = setup(t), l = new Ledger(c.dataDir, c.limits); l.reserve('jev'); l.recordUsage('jev', 'test-model', { input_tokens: 120, output_tokens: 0 });
    const again = new Ledger(c.dataDir, c.limits); assert.equal(again.snapshot().tokens['jev:test-model'].input, 120); assert.equal(again.snapshot().calls.jev, 1);
});
test('bounded latency distributions distinguish answer and synthesis phases', () => {
    const m = new Metrics(); for (let i = 0; i < 600; i++) m.record('answer', i); const r = m.snapshot().latency.answer;
    assert.equal(r.samples, 512); assert.equal(r.max, 599); assert.ok(r.p95 > r.p50);
});
test('YouTube not-yet-live recovers automatically and suppresses initial history (A01)', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeKey: 'test-key', youtubeRetryMs: 1 });
    const ac = new AbortController(), msgs = [], states = []; let resolves = 0;
    const y = new YouTube(c, ledger(), undefined, async function* () {
        yield { items: [{ id: 'old', snippet: { type: 'textMessageEvent', publishedAt: '2020-01-01T00:00:00Z', displayMessage: 'old' } }, { id: 'new', snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: 'new' } }], nextPageToken: 'resume' };
        yield { offlineAt: new Date().toISOString() };
    });
    y.get = async () => (++resolves === 1 ? { items: [{}] } : { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' } }] });
    await y.watch(m => msgs.push(m), s => states.push(s), ac.signal);
    assert.equal(resolves, 2); assert.ok(states.includes('waiting_for_broadcast')); assert.ok(states.includes('connected')); assert.equal(states.at(-1), 'ended'); assert.deepEqual(msgs.map(x => x.text), ['new']);
});
test('YouTube reconnect resumes token and removes duplicate messages', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeKey: 'k', youtubeRetryMs: 1 });
    let n = 0; const tokens = [], msgs = [];
    const y = new YouTube(c, ledger(), undefined, async function* (args) {
        tokens.push(args.pageToken); n++; yield { nextPageToken: 'next', items: [{ id: 'same', snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: 'one' } }] };
        if (n === 1) throw new Error('Transient'); yield { offlineAt: 'ended' };
    });
    y.get = async () => ({ items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' } }] });
    await y.watch(m => msgs.push(m), () => {}, new AbortController().signal);
    assert.equal(msgs.length, 1); assert.deepEqual(tokens, ['', 'next']);
});
test('YouTube API key path does not require OAuth or expose key to emitted state', async t => {
    const c = setup(t); c.youtubeKey = 'private-key'; let url; const y = new YouTube(c, ledger(), async u => { url = u; return response({ items: [] }); });
    await y.get('videos', { id: 'abcdefghijk' }); assert.match(url, /key=private-key/); assert.equal(y.access, null);
});
test('YouTube waiting loop is promptly abortable', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeKey: 'k' });
    const y = new YouTube(c, ledger()), ac = new AbortController(); y.get = async () => ({ items: [] });
    await y.watch(() => {}, () => ac.abort(), ac.signal); assert.equal(ac.signal.aborted, true);
});
test('YouTube invalid auth is terminal, not a rapid spend loop', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeKey: 'k', youtubeRetryMs: 1 });
    const y = new YouTube(c, ledger()); let n = 0; y.get = async () => { n++; const e = new Error('401'); e.status = 401; throw e; }; const states = [];
    await y.watch(() => {}, s => states.push(s), new AbortController().signal); assert.equal(n, 1); assert.equal(states.at(-1), 'auth_error');
});
test('settings save, masked reads, explicit secret deletion, restrictive permissions', t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' });
    // LLM_API_KEY (the local judge's and conversation endpoint's key): TYPESAFE_API_KEY is no longer read by config.
    const r = saveSettings(c, { values: { LLM_API_KEY: 'top-secret', CHARACTER_NAME: 'テスト', VOICEVOX_SPEAKER: 4 } });
    assert.ok(r.configured.LLM_API_KEY); assert.ok(!JSON.stringify(r).includes('top-secret'));
    saveSettings(c, { values: { LLM_API_KEY: '' } }); assert.equal(c.llmKey, 'top-secret');
    saveSettings(c, { clear: ['LLM_API_KEY'] }); assert.equal(c.llmKey, '');
    assert.equal(config({ DATA_DIR: c.dataDir }, []).character.name, 'テスト');
    if (process.platform !== 'win32') assert.equal(statSync(`${c.dataDir}/settings.json`).mode & 0o777, 0o600);
});
test('settings reject unknown fields, insecure remote URLs and malicious video URLs', t => {
    const c = setup(t); assert.throws(() => saveSettings(c, { values: { ADMIN_TOKEN: 'injected' } }));
    assert.throws(() => saveSettings(c, { values: { LLM_BASE_URL: 'http://evil.example/v1' } }));
    assert.throws(() => videoID('https://youtube.com.evil.example/watch?v=abcdefghijk'));
    assert.equal(videoID('https://www.youtube.com/live/abcdefghijk'), 'abcdefghijk');
    assert.equal(videoID('https://youtu.be/abcdefghijk?t=5'), 'abcdefghijk');
});
test('metadata detection is separate from real generation rehearsal (A04)', async t => {
    const c = setup(t); c.mode = 'live';
    const metadata = await detect(c, async u => u.endsWith('/speakers') ? response([{ name: '声', styles: [{ id: 3, name: 'normal' }] }]) : response({ data: [{ id: 'model' }] }));
    assert.equal(metadata.models.length, 1);
    const result = await rehearse(c, ledger(), audit, { conversation: { generate: async () => { const e = new Error('500'); e.status = 500; throw e; } } });
    assert.equal(result.ok, false); assert.equal(result.checks[0].ok, false); assert.equal(result.audio, undefined);
});
test('rehearsal gates real audio and does not auto-claim human hearing', async t => {
    const c = setup(t); c.mode = 'live'; let tts = 0;
    const deps = { conversation: { generate: async () => 'こんにちは。' }, jev: { speech: async () => ({ accept: false }) }, voice: { synthesize: async () => { tts++; return { kind: 'wav', bytes: wav(.2) }; } } };
    assert.equal((await rehearse(c, ledger(), audit, deps)).ok, false); assert.equal(tts, 0);
    deps.jev.speech = async () => ({ accept: true }); const r = await rehearse(c, ledger(), audit, deps);
    assert.equal(r.ok, true); assert.equal(r.heard, false); assert.equal(r.checks.length, 3);
});
test('Ollama uses native no-thinking API and records usage', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); Object.assign(c, { mode: 'live', llmProvider: 'ollama', llmModel: 'local' }); let body, url;
    const p = new Conversation(c, ledger(), async (u, o) => { url = u; body = JSON.parse(o.body); return response({ message: { content: 'こんにちは。', thinking: 'NEVER READ' }, prompt_eval_count: 25, eval_count: 5 }); });
    assert.equal(await p.generate({}), 'こんにちは。'); assert.equal(body.think, false); assert.equal(body.keep_alive, '30m'); assert.match(url, /\/api\/chat$/);
});
test('settings APIs reject view capability and prohibit edits during a show', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0; const a = createApp(c); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const base = `http://127.0.0.1:${a.server.address().port}`;
    const req = (path, data, key = c.adminToken) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
    assert.equal((await req('/api/settings', null, c.viewToken)).status, 401);
    const get = await (await req('/api/settings')).json(); assert.equal(get.values.MODE, 'demo');
    await req('/api/control', { action: 'start' });
    assert.equal((await req('/api/settings', { values: { MODE: 'demo' } })).status, 409);
    await req('/api/control', { action: 'stop' });
});

test('successful first audio part does not erase repeated later-part failures', async t => {
    let calls = 0;
    const e = active(talk(t, { conversation: { generate: async () => '最初の文です。次の文です。' }, voice: { synthesize: async () => { if (++calls === 2) throw new Error('synthesis unavailable'); return { kind: 'wav', bytes: wav(.2), durationMs: 200 }; } } }));
    e.turnFailures = 3;
    await playPart(e); // Base playback ACK resets errorCount, but not incomplete-turn failures.
    assert.equal(e.turnFailures, 3); e.nextTurnAt = 0;
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.running, false); assert.equal(e.pending, null);
    assert.equal(e.metrics.counters.audio_part_failure, 1);
});

test('missing optional gRPC falls back to visibly degraded polling without dropping new chat', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeKey: 'fixture', youtubeTransport: 'stream' });
    const ac = new AbortController(), states = [], messages = [];
    const y = new YouTube(c, ledger(), undefined, async function* () { const e = new Error('optional module missing'); e.code = 'MISSING_GRPC'; throw e; });
    y.get = async path => path === 'videos' ? { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' } }] } : { pollingIntervalMillis: 30000, items: [{ id: 'new-comment', snippet: { type: 'textMessageEvent', publishedAt: new Date().toISOString(), displayMessage: 'こんにちは' } }] };
    await y.watch(m => { messages.push(m); ac.abort(); }, s => states.push(s), ac.signal);
    assert.equal(messages.length, 1); assert.ok(states.includes('polling_degraded'));
});

test('bad OAuth refresh/configuration stops rather than retrying indefinitely', async t => {
    const c = setup(t); Object.assign(c, { mode: 'live', youtubeVideo: 'abcdefghijk', youtubeClient: 'client', youtubeSecret: 'fixture', youtubeRefresh: 'invalid', youtubeRetryMs: 1 });
    let calls = 0; const states = [];
    const y = new YouTube(c, ledger(), async () => { calls++; return response({ error: 'invalid_grant' }, 400); });
    await y.watch(() => {}, s => states.push(s), new AbortController().signal);
    assert.equal(calls, 1); assert.equal(states.at(-1), 'auth_or_configuration_error');
    c.youtubeClient = ''; await y.watch(() => {}, s => states.push(s), new AbortController().signal);
    assert.equal(calls, 1); assert.equal(states.at(-1), 'auth_or_configuration_error');
});

test('budget exhaustion plays an already approved local farewell then stops without another provider call', async t => {
    let judged=0,synth=0;
    const e=talk(t,{jev:{speech:async()=>{judged++;return {accept:true,mood:'warm',effect:'none'};}},voice:{synthesize:async()=>{synth++;return {kind:'wav',durationMs:200,bytes:wav(.2)};}}});
    e.c.memoryGuard=true; await e.prepareBudgetClosing(); // the Jev session budget is gone; MEMORY_GUARD is the remaining trigger
    assert.equal(judged,1);assert.equal(synth,1);
    active(e); e.director.opened=true; e.requestBudgetClose('credit');
    await playPart(e);
    assert.equal(judged,1);assert.equal(synth,1);assert.equal(e.running,false);
});

test('round review completion requires all audio parts and valid renderer end acknowledgements', async t => {
    const e = active(talk(t, { conversation: { generate: async () => '一文目です。二文目です。' } }));
    const completed = [];
    await e.speakStep(e.epoch, e.controller.signal);
    e.currentTurn.eventId = 'recap-test';
    e.blocks = { playbackCompleted: id => completed.push(id), stillValid: () => true, numbers: () => ({}) };
    const id = e.pending.id, lease = e.renderer.lease;
    assert.equal(e.acknowledge({ id, lease, event: 'ended' }), false);
    e.acknowledge({ id, lease, event: 'started' });
    e.acknowledge({ id, lease: 'wrong', event: 'ended' });
    assert.deepEqual(completed, []);
    e.acknowledge({ id, lease, event: 'ended' });
    assert.deepEqual(completed, []);
    await playPart(e);
    assert.deepEqual(completed, ['recap-test']);
    e.blocks = null; e.stop();
});
