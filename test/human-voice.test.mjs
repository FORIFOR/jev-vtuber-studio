import test from 'node:test';
import assert from 'node:assert/strict';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Conversation } from '../src/providers.mjs';
import { Control } from '../src/control.mjs';
import { HumanLines, opensMic } from '../src/human-voice.mjs';
import { BRIDGE_LINES } from '../src/resume-bridge.mjs';
import { config } from '../src/config.mjs';
import { saveSettings } from '../src/settings.mjs';
import { encodeWav, RATE } from '../public/collab-vad.mjs';
import { setup, ledger, audit, active, response, wav } from './helpers.mjs';

// NOA Studio Phase 3 (operator 2026-10-19, docs/HUMAN_VOICE.md): HUMAN_VOICE_MODE=resynth speaks the person's
// transcribed words in Noa's own TTS voice (no gate, the local PII/injection check), the raw mic never airs, the
// AI's first line after the handoff knows what was said; passthrough / rvc stay as Phase 1.
const tick = () => new Promise(r => setImmediate(r));
const own = xs => xs.filter(x => !BRIDGE_LINES.includes(x)); // the bridge lines are voiced at the first handoff (Phase 4)
function fixture(t, env = { HUMAN_VOICE_MODE: 'resynth' }) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env }); c.mode = 'live';
    const n = { judged: 0, judgedTexts: [], synth: [] }, obs = { calls: [], async setHumanMic(name, on) { obs.calls.push([name, on]); } };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async text => { n.judged++; n.judgedTexts.push(text); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async () => '星の話をしよう。' },
        voice: { synthesize: async text => { n.synth.push(text); return { kind: 'wav', durationMs: 900, bytes: wav(.2) }; } }, commentVoice: { synthesize: async () => ({ kind: 'browser', durationMs: 200, bytes: null }) } }));
    e.director.opened = true; e.standby = null;
    const events = []; e.on('event', ev => events.push(ev));
    const control = new Control(c, { engine: e, obs, audit });
    t.after(() => e.stop());
    return { c, e, n, obs, control, events };
}
async function step(e) { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); return e.pending; }
const ack = (e, event) => e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event });

test('resynth: the raw mic stays muted; the person\'s words air in Noa\'s TTS voice, in order, without the gate', async t => {
    const { e, n, obs, control, events } = fixture(t);
    await control.setVoice('human');
    assert.deepEqual(obs.calls, [], 'no OBS mic is opened (none is even configured)');
    assert.deepEqual(e.humanHeard('こんばんは、ノアだよ。'), { accepted: true });
    assert.deepEqual(e.humanHeard('今日はスマブラをやるね。'), { accepted: true });
    await tick(); await tick();
    assert.deepEqual(own(n.synth), ['こんばんは、ノアだよ。', '今日はスマブラをやるね。'], 'the next line is synthesized while the first plays');
    const p = await step(e);
    assert.equal(p.text, 'こんばんは、ノアだよ。'); assert.equal(p.human, true); assert.equal(p.role, 'host');
    assert.ok(events.some(ev => ev.type === 'speech' && ev.data.text === 'こんばんは、ノアだよ。' && /\/audio\/.+\.wav$/.test(ev.data.audio)), 'captioned and voiced like any line');
    assert.equal((await step(e)).text, 'こんばんは、ノアだよ。', 'one at a time');
    ack(e, 'started'); ack(e, 'ended');
    assert.equal((await step(e)).text, '今日はスマブラをやるね。');
    assert.ok(!n.judgedTexts.some(x => ['こんばんは、ノアだよ。', '今日はスマブラをやるね。'].includes(x)), 'a person\'s own words are not gated');
    assert.ok(n.judgedTexts.every(x => BRIDGE_LINES.includes(x)), 'only the fixed bridge lines were judged');
    assert.equal(e.status().control.humanVoiceMode, 'resynth');
});

test('resynth: nothing is taken while the AI has the voice; the local check drops a line and tells the operator', async t => {
    const { e, n, control, events } = fixture(t);
    assert.equal(e.humanAccepts(), 'ai_voice');
    assert.equal(e.humanHeard('聞こえてる？').reason, 'ai_voice');
    await control.setVoice('human');
    assert.equal(e.humanHeard('私のメールは test@example.com です').reason, 'local_gate');
    assert.ok(events.some(ev => ev.type === 'notice' && /読み上げませんでした/.test(ev.data.message) && !/example/.test(ev.data.message)));
    await tick();
    assert.deepEqual(own(n.synth), []);
    const p = fixture(t, { HUMAN_VOICE_MODE: 'passthrough', OBS_HUMAN_MIC_SOURCE: 'Mic' });
    await p.control.setVoice('human');
    assert.equal(p.e.humanAccepts(), 'not_resynth');
    assert.deepEqual(p.obs.calls, [['Mic', true]], 'passthrough opens the mic as in Phase 1');
});

test('back to the AI: queued lines are dropped, one playing stops, and the first AI line knows what was said', async t => {
    const { e, control, events } = fixture(t);
    await control.setVoice('human');
    e.humanHeard('さっきの試合、惜しかったね。'); await tick(); await tick();
    await step(e); ack(e, 'started'); ack(e, 'ended');
    e.humanHeard('次はがんばるよ。'); await tick(); await tick();
    await step(e); ack(e, 'started');
    e.humanHeard('まだ話してる途中'); await tick();
    const playing = e.pending.id;
    await control.setVoice('ai');
    assert.ok(events.some(ev => ev.type === 'cancel' && ev.data.id === playing));
    assert.equal(e.humanLines.items.length, 0);
    const contexts = []; e.conversation = { generate: async ctx => { contexts.push(ctx); return 'うん、次の試合いこう！'; } };
    await e.prepare(e.epoch, e.controller.signal);
    assert.deepEqual(contexts[0].humanHandoff.said, ['さっきの試合、惜しかったね。', '次はがんばるよ。']);
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; c.llmProvider = 'ollama'; let body;
    const conv = new Conversation(c, ledger(), async (_url, options) => { body = JSON.parse(options.body); return response({ message: { content: 'うん、次の試合いこう！' } }); });
    await conv.generate({ kind: 'autonomous', utterance: 'monologue', goal: '雑談', humanHandoff: { minutes: 2, said: ['さっきの試合、惜しかったね。'] } });
    assert.match(body.messages[0].content, /話した内容は humanSaid/);
    assert.match(body.messages[1].content, /さっきの試合、惜しかったね。/);
    assert.doesNotMatch(body.messages[0].content, /何を話したかは分からない/);
});

test('a line whose voice failed is skipped with a notice; the queue keeps order', async () => {
    const q = new HumanLines(); let fail = true;
    q.add('一つ目', async () => { if (fail) throw new Error('tts'); });
    q.add('二つ目', async () => ({ kind: 'wav', bytes: Buffer.alloc(4), durationMs: 1 }));
    await tick(); await tick();
    assert.equal(q.ready().text, '一つ目'); assert.equal(q.ready().text, '二つ目'); assert.equal(q.ready(), null);
    assert.equal(opensMic('resynth'), false); assert.equal(opensMic('rvc'), true); assert.equal(opensMic('passthrough'), true);
});

test('setting: HUMAN_VOICE_MODE is validated; passthrough by default', t => {
    assert.equal(config({}, [], false).humanVoiceMode, 'passthrough');
    assert.equal(config({ HUMAN_VOICE_MODE: 'resynth' }, [], false).humanVoiceMode, 'resynth');
    assert.equal(config({ HUMAN_VOICE_MODE: 'robot' }, [], false).humanVoiceMode, 'passthrough');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { HUMAN_VOICE_MODE: 'rvc' } }).values.HUMAN_VOICE_MODE, 'rvc');
    assert.throws(() => saveSettings(c, { values: { HUMAN_VOICE_MODE: 'robot' } }), /人間の声の出し方/);
});

test('HTTP: the person\'s mic is transcribed only while they have the voice; whisper down is a 503 and a notice', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', HUMAN_VOICE_MODE: 'resynth' }); c.port = 0;
    let sttCalls = 0, offline = false;
    const sttFetch = async () => { sttCalls++; if (offline) throw new TypeError('fetch failed'); return response({ text: 'こんにちは、ノアです。' }); };
    const a = createApp(c, { obs: { close() { }, async stopOwned() { }, async setHumanMic() { } }, MeterOBS: null, sttFetch });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    try {
        const url = `http://127.0.0.1:${a.server.address().port}`, notices = [];
        a.engine.on('event', ev => { if (ev.type === 'notice') notices.push(ev.data.message); });
        a.engine.voice = { synthesize: async () => ({ kind: 'wav', durationMs: 500, bytes: wav(.1) }) };
        const segment = encodeWav(Float32Array.from({ length: RATE }, (_, i) => .2 * Math.sin(i / 7)));
        const post = (path, body, type) => fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': type }, body });
        active(a.engine);
        let r = await post('/api/human/segment', segment, 'audio/wav');
        assert.deepEqual(await r.json(), { accepted: false, reason: 'ai_voice' });
        assert.equal(sttCalls, 0, 'not transcribed while the AI has the voice');
        r = await post('/api/control', JSON.stringify({ action: 'voice', to: 'human' }), 'application/json');
        assert.equal(r.status, 200);
        r = await post('/api/human/segment', segment, 'audio/wav');
        const body = await r.json();
        assert.equal(body.accepted, true); assert.equal(body.text, 'こんにちは、ノアです。');
        assert.equal(a.engine.humanLines.items.length, 1);
        offline = true;
        r = await post('/api/human/segment', segment, 'audio/wav');
        assert.equal(r.status, 503);
        assert.ok(notices.some(m => /中の人の発言を声にできませんでした/.test(m)));
    } finally { a.engine.stop(); await a.close(); }
});
