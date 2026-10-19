import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Conversation } from '../src/providers.mjs';
import { Jev } from '../src/jev.mjs';
import { SpeechToText, usableTranscript, wavInfo } from '../src/stt.mjs';
import { Segmenter, downsample, encodeWav, RATE } from '../public/collab-vad.mjs';
import { setup, ledger, audit, active, response } from './helpers.mjs';

// NOA Studio Phase 2 (operator 2026-10-19, docs/COLLAB.md): the voice-call partner is heard (capture page -> local
// whisper) and Noa answers through the full gate; turn taking, barge-in, echo/hallucination drops, listening priority.
const audio = () => ({ kind: 'browser', durationMs: 200, bytes: null });
function fixture(t, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', COLLAB_NAME: 'ゆう', ...env }); c.mode = 'live';
    const n = { generated: [], judged: [] };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, readAllowed: false, action: 'reply' }), speech: async (text, _s, _ev, context) => { n.judged.push({ text, context }); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { n.generated.push(ctx); return ctx.utterance === 'collab_reply' ? 'うん、今日はスマブラをやるよ。' : `星の話をしよう、その${n.generated.length}。`; } },
        voice: { synthesize: async () => audio() }, commentVoice: { synthesize: async () => audio() } }));
    e.director.opened = true; e.standby = null;
    let clock = 1_000_000; e.collab.now = () => clock;
    const tick = ms => { clock += ms; };
    t.after(() => e.stop());
    return { c, e, n, tick };
}
async function turn(e) {
    await e.prepare(e.epoch, e.controller.signal);
    e.nextTurnAt = 0; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    return e.pending;
}

test('partner first: the partner is answered before a queued comment, as collab_reply through the gate', async t => {
    const { e, n } = fixture(t);
    e.control.listening = 'discord_first';
    e.ingest({ text: 'ノアちゃんこんばんは', author: 'viewer', source: 'youtube', id: 'c1' });
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.candidates.length, 1);
    assert.deepEqual(e.collabHeard('今日は何のゲームをするの？'), { accepted: true });
    assert.ok(e.candidates[0].collab, 'at the head');
    const p = await turn(e);
    assert.equal(p.text, 'うん、今日はスマブラをやるよ。');
    const ctx = n.generated.at(-1);
    assert.equal(ctx.utterance, 'collab_reply'); assert.equal(ctx.comment, '今日は何のゲームをするの？');
    assert.equal(ctx.collab.name, 'ゆう'); assert.deepEqual(ctx.collab.dialogue.at(-1), { who: 'partner', text: '今日は何のゲームをするの？' });
    assert.equal(n.judged.at(-1).context.utterance, 'collab_reply', 'the reply was gated');
    assert.equal(e.candidates.length, 1, 'the comment waits');
});

test('partner first holds comments while the partner is in the call; comments first answers the comment first', async t => {
    const { e, n, tick } = fixture(t);
    e.control.listening = 'discord_first';
    e.ingest({ text: '今夜はどんな話？', author: 'viewer', source: 'youtube', id: 'c1' });
    await e.classify(e.epoch, e.controller.signal);
    e.collab.speaking(true); tick(500); e.collab.speaking(false);
    tick(1000);
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.prepared, null, 'no comment and no talk of her own while the partner was just speaking');
    tick(8000);
    await e.prepare(e.epoch, e.controller.signal);
    assert.match(e.prepared?.candidate?.text || '', /^今夜はどんな話/, 'after the partner has been quiet for 8 s');
    const f = fixture(t);
    f.e.control.listening = 'comments_first';
    f.e.ingest({ text: 'こんばんは！', author: 'viewer', source: 'youtube', id: 'c2' });
    await f.e.classify(f.e.epoch, f.e.controller.signal);
    f.e.collabHeard('そっちはどう？');
    assert.equal(f.e.candidates[0].collab, undefined); assert.equal(f.e.candidates[1].collab, true);
    assert.equal(n.generated.length, 1, 'only the comment, once the partner was quiet');
});

test('turn taking: no new line while the partner speaks or for 0.6 s after', async t => {
    const { e, tick } = fixture(t);
    e.control.listening = 'discord_first';
    await e.prepare(e.epoch, e.controller.signal);
    e.collab.speaking(true);
    e.nextTurnAt = 0; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null);
    tick(2000); e.collab.speaking(false); tick(300);
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null, 'just stopped');
    tick(400);
    e.control.listening = 'comments'; // without a call the floor never waits
    await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending);
});

test('barge-in: longer than COLLAB_BARGE_IN_MS stops Noa; a backchannel does not; 0 never stops her', async t => {
    const { e, tick } = fixture(t);
    e.control.listening = 'discord_first';
    assert.ok(await turn(e));
    e.collab.speaking(true); tick(300); e.monitor();
    assert.ok(e.pending, 'a short うん does not stop her');
    tick(500); e.monitor();
    assert.equal(e.pending, null, 'talking over her for 0.8 s does');
    const f = fixture(t, { COLLAB_BARGE_IN_MS: '0' });
    f.e.control.listening = 'discord_first';
    assert.ok(await turn(f.e));
    f.e.collab.speaking(true); f.tick(5000); f.e.monitor();
    assert.ok(f.e.pending);
});

test('her own voice heard back, unsafe words and other modes are not answered; a person speaking keeps the call as history', async t => {
    const { e } = fixture(t);
    e.control.listening = 'discord_first';
    const p = await turn(e);
    assert.equal(e.collabHeard(p.text.replace('。', '')).reason, 'echo');
    assert.equal(e.collabHeard('連絡先は test@example.com だよ').reason, 'local_gate');
    e.control.listening = 'comments';
    assert.equal(e.collabHeard('聞こえる？').reason, 'not_listening');
    e.control.listening = 'discord_first'; e.control.voice = 'human';
    assert.equal(e.collabHeard('人間のノアに話しかけるね').reason, 'human_voice');
    assert.deepEqual(e.collab.dialogue().at(-1), { who: 'partner', text: '人間のノアに話しかけるね' });
    assert.ok(!e.candidates.some(x => x.collab));
});

test('pieces of one turn not yet answered are merged; a partner turn expires after 20 s', async t => {
    const { e } = fixture(t);
    e.control.listening = 'discord_first';
    e.collabHeard('あのさ'); e.collabHeard('今日のゲームなんだけど');
    assert.equal(e.candidates.filter(x => x.collab).length, 1);
    assert.equal(e.candidates[0].text, 'あのさ 今日のゲームなんだけど');
    e.candidates[0].created -= 21000;
    assert.equal(e.candidateInvalidReason(e.candidates[0]), 'expired');
});

test('speech to text: local whisper, silence and stock hallucinations never reach Noa, an offline server throws', async () => {
    const tone = (ms, amp = .2) => Float32Array.from({ length: RATE * ms / 1000 }, (_, i) => amp * Math.sin(i / 8));
    const calls = [];
    const stt = new SpeechToText({ sttURL: 'http://127.0.0.1:8178/', sttLanguage: 'ja' }, async (url, init) => { calls.push([url, init.body.get('language'), init.body.get('response_format')]); return response({ text: 'こんにちは、ノアちゃん。\n' }); });
    assert.deepEqual(await stt.transcribe(encodeWav(tone(1000))), { text: 'こんにちは、ノアちゃん。' });
    assert.deepEqual(calls, [['http://127.0.0.1:8178/inference', 'ja', 'json']]);
    assert.equal((await stt.transcribe(encodeWav(new Float32Array(RATE)))).skipped, 'silence', 'never sent');
    assert.equal((await stt.transcribe(encodeWav(tone(100)))).skipped, 'too_short');
    assert.equal(calls.length, 1);
    const ghost = new SpeechToText({ sttURL: 'http://x' }, async () => response({ text: 'ご視聴ありがとうございました' }));
    assert.equal((await ghost.transcribe(encodeWav(tone(1000)))).skipped, 'hallucination');
    const down = new SpeechToText({ sttURL: 'http://x' }, async () => { throw new TypeError('fetch failed'); });
    await assert.rejects(down.transcribe(encodeWav(tone(1000))), e => e.code === 'STT_OFFLINE');
    for (const [t, ok] of [['うん。', false], ['（音楽）', false], ['はい、今日はスマブラやろう', true], ['ご視聴ありがとうございました', false]]) assert.equal(!!usableTranscript(t), ok, t);
    assert.throws(() => wavInfo(Buffer.from('nope')), e => e.code === 'NOT_WAV');
});

test('capture page voice activity: start, end with the utterance (pre-roll kept), discard a blip; WAV and resampling', () => {
    const seg = new Segmenter({ threshold: .02 });
    const loud = ms => Float32Array.from({ length: RATE * ms / 1000 }, (_, i) => .3 * Math.sin(i / 5)), quiet = ms => new Float32Array(RATE * ms / 1000);
    assert.deepEqual(seg.push(quiet(400)), []);
    assert.deepEqual(seg.push(loud(1000)).map(x => x.type), ['start']);
    const ev = seg.push(quiet(700));
    assert.equal(ev.length, 1); assert.equal(ev[0].type, 'end');
    assert.ok(ev[0].pcm.length / RATE * 1000 >= 1000 + 280, 'speech plus its pre-roll');
    assert.deepEqual([...seg.push(loud(80)), ...seg.push(quiet(700))].map(x => x.type), ['start', 'discard']);
    const info = wavInfo(Buffer.from(encodeWav(loud(500))));
    assert.equal(info.sampleRate, RATE); assert.equal(info.channels, 1); assert.ok(Math.abs(info.durationMs - 500) < 1); assert.ok(info.rms > .1);
    assert.equal(downsample(new Float32Array(48000), 48000).length, RATE);
});

test('the reply prompt and the gate know it is the voice-call partner (thresholds unchanged)', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; c.llmProvider = 'ollama'; let body;
    const conv = new Conversation(c, ledger(), async (_url, options) => { body = JSON.parse(options.body); return response({ message: { content: 'うん、やろう。' } }); });
    await conv.generate({ kind: 'reply', utterance: 'collab_reply', comment: 'スマブラやろうよ', collab: { name: 'ゆう', dialogue: [{ who: 'partner', text: 'スマブラやろうよ' }] } });
    assert.match(body.messages[0].content, /ボイス通話の相手（ゆう）への返事/);
    assert.doesNotMatch(body.messages[0].content, /今は視聴者コメントへの返事/);
    const jc = setup(t, { SHOW_PROFILE: 'talk' }); jc.mode = 'live';
    const j = new Jev(jc, ledger(), audit, async () => response({}));
    let questions; j.ask = async (_state, q) => { questions = q; throw new Error('captured'); };
    await assert.rejects(j.speech('うん、やろう。', undefined, [], { utterance: 'collab_reply', comment: 'スマブラやろうよ', collab: { dialogue: [] }, recentSpeech: [] }), /captured/);
    assert.ok(questions.novel && questions.progress, 'the comment-reply questions');
    assert.match(questions.progress.instructions, /voice-call partner/);
});

test('HTTP: a segment is transcribed and answered; whisper down is a 503 and a notice, never an answer', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0;
    let offline = false;
    const sttFetch = async () => { if (offline) throw new TypeError('fetch failed'); return response({ text: '今日は何するの？' }); };
    // Closed in the test body: setup's temp dir is removed before later t.after hooks run.
    const a = createApp(c, { obs: { close() { }, async stopOwned() { }, async setHumanMic() { } }, MeterOBS: null, sttFetch });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    try {
        const url = `http://127.0.0.1:${a.server.address().port}`, notices = [];
        a.engine.on('event', ev => { if (ev.type === 'notice') notices.push(ev.data.message); });
        const wav = encodeWav(Float32Array.from({ length: RATE }, (_, i) => .2 * Math.sin(i / 7)));
        const post = (path, body, type, token = c.adminToken) => fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body });
        assert.equal((await post('/api/collab/segment', wav, 'audio/wav', c.viewToken)).status, 401);
        active(a.engine); a.engine.director.opened = true; a.engine.control.listening = 'discord_first';
        let r = await post('/api/collab/segment', wav, 'audio/wav');
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.accepted, true); assert.equal(body.text, '今日は何するの？');
        assert.equal(a.engine.candidates.filter(x => x.collab).length, 1);
        r = await post('/api/collab/speaking', JSON.stringify({ on: true }), 'application/json');
        assert.equal(r.status, 200); assert.ok(a.engine.collab.speakingFor() >= 0 && a.engine.collab.speakingSince !== null);
        a.engine.candidates.length = 0; offline = true;
        r = await post('/api/collab/segment', wav, 'audio/wav');
        assert.equal(r.status, 503); assert.equal((await r.json()).code, 'STT_OFFLINE');
        assert.equal(a.engine.candidates.length, 0);
        assert.ok(notices.some(m => /音声認識/.test(m)));
        assert.equal((await post('/api/collab/segment', Buffer.from('not a wav'), 'audio/wav')).status, 400);
        const monitor = await (await fetch(url + '/api/monitor', { headers: { Authorization: `Bearer ${c.adminToken}` } })).json();
        assert.equal(monitor.collab.speaking, true); assert.equal(monitor.collab.stt.error, 'offline');
        assert.deepEqual(monitor.collab.dialogue.at(-1), { who: 'partner', text: '今日は何するの？' });
    } finally { a.engine.stop(); await a.close(); }
});
