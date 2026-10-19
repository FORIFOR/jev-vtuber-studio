import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Conversation } from '../src/providers.mjs';
import { Control, ControlError } from '../src/control.mjs';
import { OBS } from '../src/obs.mjs';
import { config } from '../src/config.mjs';
import { saveSettings } from '../src/settings.mjs';
import { setup, ledger, audit, active, response } from './helpers.mjs';

// NOA Studio Phase 1 (operator 2026-10-19, docs/CONTROL.md): a person can take Noa's voice and hand it back mid-show;
// the AI voice and the person's mic are never on air together; listening can be muted (comments shown, not taken up).
const audio = () => ({ kind: 'browser', durationMs: 200, bytes: null });
const root = new URL('..', import.meta.url);
function fakeObs() {
    const o = { calls: [], failOpen: false, failMute: false };
    o.setHumanMic = async (name, on) => { o.calls.push([name, on]); if (on && o.failOpen) throw new Error('open failed'); if (!on && o.failMute) throw new Error('mute failed'); };
    return o;
}
function fixture(t, env = { OBS_HUMAN_MIC_SOURCE: 'Noa Human Mic' }) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env }); c.mode = 'live';
    const n = { generated: 0, judged: 0, chat: 0 }, log = [], obs = fakeObs(), events = [];
    const e = active(new TalkEngine(c, { ledger: ledger(), audit: { log: (type, d) => log.push([type, d]) },
        jev: { chat: async () => { n.chat++; return { accept: true, readAllowed: false, action: 'reply' }; }, speech: async () => { n.judged++; return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async () => { n.generated++; return `今夜は星の話をしよう、その${n.generated}。`; } },
        voice: { synthesize: async () => audio() }, commentVoice: { synthesize: async () => audio() } }));
    e.director.opened = true; e.standby = null;
    e.on('event', ev => events.push(ev));
    const control = new Control(c, { engine: e, obs, audit: { log: (type, d) => log.push([type, d]) } });
    t.after(() => e.stop());
    return { c, e, n, log, obs, control, events };
}
async function line(e) {
    await e.prepare(e.epoch, e.controller.signal);
    e.nextTurnAt = 0; e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    return e.pending;
}

test('AI -> human: the line on air stops, the mic opens, and nothing is generated, judged or voiced meanwhile', async t => {
    const { e, n, obs, control, log, events } = fixture(t);
    assert.ok(await line(e), 'the AI is speaking');
    const id = e.pending.id;
    await control.setVoice('human');
    assert.equal(e.pending, null);
    assert.ok(events.some(ev => ev.type === 'cancel' && ev.data.id === id && ev.data.reason === 'voice_handoff'));
    assert.deepEqual(obs.calls, [['Noa Human Mic', true]]);
    assert.equal(e.status().control.voice, 'human'); assert.equal(e.phase, 'human_voice');
    const before = { ...n };
    e.ingest({ text: 'こんばんは', author: 'viewer', source: 'youtube' });
    for (let i = 0; i < 3; i++) { await e.classify(e.epoch, e.controller.signal); await e.prepare(e.epoch, e.controller.signal); e.nextTurnAt = 0; await e.speakStep(e.epoch, e.controller.signal); }
    assert.equal(e.pending, null, 'nothing airs while a person speaks');
    assert.equal(n.chat, before.chat, 'no comment judging');
    // Phase 4: the only generation is the AI's resume line, prepared (not aired) in a pause of the person.
    assert.ok(!e.prepared || e.prepared.resume, 'at most a prepared resume line');
    assert.ok(log.some(([type, d]) => type === 'control_handoff' && d.voice === 'human'));
});

test('human -> AI: the mic is muted first, then the next line starts at once and passes the gate', async t => {
    const { e, n, obs, control, log } = fixture(t);
    await control.setVoice('human');
    e.nextTurnAt = Date.now() + 60000;
    await control.setVoice('ai');
    assert.deepEqual(obs.calls.at(-1), ['Noa Human Mic', false]);
    assert.equal(e.nextTurnAt, 0);
    const judged = n.judged;
    assert.ok(await line(e), 'the AI speaks again');
    assert.ok(n.judged > judged, 'the line went through Jev.speech');
    assert.ok(log.some(([type, d]) => type === 'control_handoff' && d.voice === 'ai'));
});

test('a mic that cannot be opened leaves the AI silent; one that cannot be muted keeps the AI from resuming', async t => {
    const { e, n, obs, control } = fixture(t);
    obs.failOpen = true;
    await control.setVoice('human');
    assert.equal(e.control.voice, 'human'); assert.equal(e.control.micError, 'open failed');
    obs.failOpen = false; obs.failMute = true;
    await assert.rejects(control.setVoice('ai'), ControlError);
    assert.equal(e.control.voice, 'human', 'still the person: two voices never air together');
    e.nextTurnAt = 0; await e.prepare(e.epoch, e.controller.signal); await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending, null, 'nothing airs');
    obs.failMute = false;
    await control.setVoice('ai');
    assert.equal(e.control.voice, 'ai'); assert.equal(e.control.micError, null);
});

test('HUMAN needs the mic source and a running show', async t => {
    const { control } = fixture(t, {});
    await assert.rejects(control.setVoice('human'), /OBS_HUMAN_MIC_SOURCE/);
    const f = fixture(t);
    f.e.stop();
    await assert.rejects(f.control.setVoice('human'), /番組の開始後/);
    await assert.rejects(f.control.setVoice('robot'), ControlError);
});

test('listening muted: a comment is shown in the chat box but not taken up; the Studio pause is the same switch', async t => {
    const { e, control, log } = fixture(t);
    const shown = []; e.on('viewer_comment', m => shown.push(m.text));
    control.setListening('muted');
    const r = e.ingest({ text: 'ノアちゃんこんばんは', author: 'viewer', source: 'youtube', id: 'c1' });
    assert.deepEqual(r, { accepted: false, reason: 'comments_paused' });
    assert.deepEqual(shown, ['ノアちゃんこんばんは']);
    assert.equal(e.intake.length, 0);
    assert.equal(e.commentsPaused, true); assert.equal(e.status().commentsPaused, true);
    e.commentsPaused = false;
    assert.equal(e.control.listening, 'comments');
    assert.equal(e.ingest({ text: 'もう一回こんばんは', author: 'viewer2', source: 'youtube', id: 'c2' }).accepted, true);
    assert.ok(log.some(([type, d]) => type === 'control_listening' && d.listening === 'muted'));
    assert.throws(() => control.setListening('discord'), ControlError);
    assert.equal(control.setListening('discord_only').listening, 'discord_only');
    assert.equal(e.ingest({ text: '通話だけの間のコメント', author: 'viewer3', source: 'youtube', id: 'c3' }).reason, 'comments_paused', 'partner only: comments shown, not taken up');
});

test('stop, emergency stop and a new show hand the voice back to the AI and mute the mic', async t => {
    const { e, obs, control } = fixture(t);
    await control.setVoice('human'); control.setListening('muted');
    obs.calls.length = 0;
    e.stop();
    assert.deepEqual(e.control, { voice: 'ai', listening: 'comments', since: null, by: null, micError: null, switching: false, latency: null, avatar: 'auto', face: null });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(obs.calls, [['Noa Human Mic', false]]);
    e.start(); obs.calls.length = 0;
    e.claimRenderer('test-renderer');
    await control.setVoice('human');
    obs.calls.length = 0;
    e.emergency();
    await new Promise(r => setImmediate(r));
    assert.equal(e.control.voice, 'ai');
    assert.ok(obs.calls.length >= 1 && obs.calls.every(([, on]) => on === false));
});

test('ten round trips without stopping the show keep the state consistent', async t => {
    const { e, obs, control } = fixture(t);
    for (let i = 0; i < 10; i++) {
        await control.setVoice('human'); assert.equal(e.control.voice, 'human');
        await control.setVoice('ai'); assert.equal(e.control.voice, 'ai');
    }
    assert.equal(obs.calls.length, 20);
    assert.ok(obs.calls.every(([, on], i) => on === (i % 2 === 0)));
    assert.equal(e.running, true);
    assert.ok(await line(e));
});

test('the goodbye never cuts into a person speaking: the operator is told instead', async t => {
    const { e, control, events } = fixture(t);
    await control.setVoice('human');
    e.endAt = Date.now() + 1000;
    e.monitor();
    assert.equal(e.director.closing, false);
    assert.ok(events.some(ev => ev.type === 'notice' && /お別れの時間/.test(ev.data.message)));
    await control.setVoice('ai');
    e.monitor();
    assert.ok(e.director.closing || e.closingRequested || e.farewell, 'the goodbye starts once the AI has the voice');
});

test('the first line after a handoff is told a person spoke and what they said is unknown', async t => {
    const { e, control } = fixture(t);
    const contexts = []; e.conversation = { generate: async ctx => { contexts.push(ctx); return 'お待たせ、続きを話すね。'; } };
    await control.setVoice('human');
    control.state.since -= 3 * 60000;
    await control.setVoice('ai');
    await e.prepare(e.epoch, e.controller.signal);
    assert.deepEqual(contexts[0].humanHandoff, { minutes: 3 });
    e.prepared = null;
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(contexts.at(-1).humanHandoff, undefined, 'only the first line');
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; c.llmProvider = 'ollama'; let body;
    const conv = new Conversation(c, ledger(), async (_url, options) => { body = JSON.parse(options.body); return response({ message: { content: 'お待たせ、続きを話すね。' } }); });
    await conv.generate({ kind: 'autonomous', utterance: 'monologue', goal: '星の話', humanHandoff: { minutes: 3 } });
    assert.match(body.messages[0].content, /約3分間、ノアの中の人が自分の声で話していた/);
    assert.doesNotMatch(body.messages[1].content, /humanHandoff/);
});

test('OBS: the mic change is read back; events reach onEvent only when subscribed', async () => {
    const o = new OBS({}), calls = [];
    let muted = true;
    o.call = async (type, data) => { calls.push([type, data]); if (type === 'SetInputMute') muted = data.inputMuted; return type === 'GetInputMute' ? { inputMuted: muted } : {}; };
    await o.setHumanMic('Mic', true);
    assert.deepEqual(calls, [['SetInputMute', { inputName: 'Mic', inputMuted: false }], ['GetInputMute', { inputName: 'Mic' }]]);
    o.call = async type => type === 'GetInputMute' ? { inputMuted: true } : {};
    await assert.rejects(o.setHumanMic('Mic', true), /did not open/);
    await assert.rejects(o.setHumanMic('', false), /OBS_HUMAN_MIC_SOURCE/);
    assert.equal(new OBS({}).eventSubscriptions, 0, 'the Studio connection subscribes to no events');
});

test('volume meters move the mouth on a separate connection, only while a person speaks', async t => {
    const { e, control, events } = fixture(t);
    const made = [];
    class Meter { constructor() { made.push(this); this.closed = false; } async connect() { } close() { this.closed = true; } }
    control.MeterOBS = Meter;
    let clock = 1000; control.now = () => clock;
    await control.setVoice('human');
    const m = made[0];
    assert.equal(m.eventSubscriptions, 1 << 16);
    m.onEvent({ eventType: 'InputVolumeMeters', eventData: { inputs: [{ inputName: 'Other', inputLevelsMul: [[.9, .9, .9]] }, { inputName: 'Noa Human Mic', inputLevelsMul: [[.05, .2, .2], [.1, .3, .3]] }] } });
    clock += 10; m.onEvent({ eventType: 'InputVolumeMeters', eventData: { inputs: [{ inputName: 'Noa Human Mic', inputLevelsMul: [[.5, .5, .5]] }] } });
    const levels = events.filter(ev => ev.type === 'human_level').map(ev => ev.data.level);
    assert.equal(levels.length, 1, 'throttled');
    assert.ok(Math.abs(levels[0] - .7) < 1e-9, 'the louder channel, scaled like the stage scales Noa\'s own voice');
    await control.setVoice('ai');
    // Phase 4: the meter stays connected for the show (the mouth follows from the first syllable) but is silent for the AI.
    assert.equal(m.closed, false);
    clock += 100; m.onEvent({ eventType: 'InputVolumeMeters', eventData: { inputs: [{ inputName: 'Noa Human Mic', inputLevelsMul: [[.5, .5, .5]] }] } });
    assert.equal(events.filter(ev => ev.type === 'human_level').length, 1, 'no level while the AI speaks');
    e.stop();
    assert.equal(m.closed, true, 'closed when the show stops');
});

test('setting, API wiring, Studio controls and the stage mouth', t => {
    assert.equal(config({ OBS_HUMAN_MIC_SOURCE: 'Noa Mic' }, [], false).obsHumanMicSource, 'Noa Mic');
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { OBS_HUMAN_MIC_SOURCE: 'ノア 人間マイク' } }).values.OBS_HUMAN_MIC_SOURCE, 'ノア 人間マイク');
    assert.equal(c.obsHumanMicSource, 'ノア 人間マイク');
    const server = readFileSync(new URL('src/server.mjs', root), 'utf8'), html = readFileSync(new URL('public/index.html', root), 'utf8');
    const studio = readFileSync(new URL('public/studio.mjs', root), 'utf8'), stage = readFileSync(new URL('public/stage.mjs', root), 'utf8');
    assert.match(server, /\['voice', 'listening', 'avatar', 'hotkey'\]\.includes\(data\.action\)/);
    for (const id of ['voice-ai', 'voice-human', 'listening-mode', 'voice-state', 'collab-open']) assert.match(html, new RegExp(`id="${id}"`), id);
    // Phase 6: the keys come from the operator's map (/api/hotkeys) and the server resolves them.
    assert.match(studio, /const name = hotkeyMap\[keyName\(e\)\]/); assert.match(studio, /control\('hotkey', \{ name \}\)/);
    assert.match(stage, /m\.type === 'human_level'/);
});

test('HTTP: admin switches voice and listening mid-show; errors are explicit; the view token cannot', async t => {
    const { createApp } = await import('../src/server.mjs');
    const obs = { ...fakeObs(), close() { }, async stopOwned() { } };
    obs.setHumanMic = async (name, on) => { (obs.mic ||= []).push(on); };
    const c = setup(t, { SHOW_PROFILE: 'talk', OBS_HUMAN_MIC_SOURCE: 'Noa Human Mic' }); c.port = 0;
    // Closed in the test body: the temp data dir (setup's t.after) is removed before later t.after hooks run.
    const a = createApp(c, { obs, MeterOBS: null }); await new Promise(r => a.server.listen(0, '127.0.0.1', r));
    try {
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const req = (data, token = c.adminToken) => fetch(url + '/api/control', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await req({ action: 'voice', to: 'human' })).status, 409, 'not before the show starts');
    active(a.engine);
    assert.ok([401, 403].includes((await req({ action: 'voice', to: 'human' }, c.viewToken)).status));
    let r = await req({ action: 'voice', to: 'human' });
    assert.equal(r.status, 200); assert.equal((await r.json()).control.voice, 'human');
    r = await req({ action: 'listening', to: 'muted' });
    assert.equal((await r.json()).control.listening, 'muted');
    r = await req({ action: 'voice', to: 'ai' });
    assert.equal((await r.json()).control.voice, 'ai');
    assert.deepEqual(obs.mic, [true, false]);
    assert.equal((await req({ action: 'voice', to: 'robot' })).status, 400);
    r = await req({ action: 'pause-comments' });
    assert.equal((await r.json()).control.listening, 'comments', 'the Studio pause toggles the same switch');
    } finally { await a.close(); }
});
