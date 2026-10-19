import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { Control } from '../src/control.mjs';
import { BRIDGE_LINES, ResumeBridge } from '../src/resume-bridge.mjs';
import { config } from '../src/config.mjs';
import { saveSettings } from '../src/settings.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

// NOA Studio Phase 4 (operator 2026-10-19, docs/CONTROL.md): Instant Handoff. Switches run in order, the AI's first line
// after a handoff is prepared while the person speaks (a bridge line otherwise), MUTE NOA / AI RESUME, sentence
// timing, and the handoff latency.
const tick = () => new Promise(r => setImmediate(r));
const until = async (f, n = 200) => { for (let i = 0; i < n && !f(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(f(), 'condition not reached'); };
function fixture(t, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', OBS_HUMAN_MIC_SOURCE: 'Noa Human Mic', ...env }); c.mode = 'live';
    const n = { judged: [], generated: [], delayMs: 0 };
    const obs = { calls: [], async setHumanMic(name, on) { if (n.delayMs) await new Promise(r => setTimeout(r, n.delayMs)); obs.calls.push(on); } };
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, _s, _ev, context) => { n.judged.push({ text, context }); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { n.generated.push(ctx); return `続きの話をするね、その${n.generated.length}。`; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 800, bytes: wav(.2) }) }, commentVoice: { synthesize: async () => ({ kind: 'browser', durationMs: 200, bytes: null }) } }));
    e.director.opened = true; e.standby = null;
    const events = []; e.on('event', ev => events.push(ev));
    const control = new Control(c, { engine: e, obs, audit });
    t.after(() => e.stop());
    return { c, e, n, obs, control, events };
}
const step = async e => { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); return e.pending; };
const ack = (e, event) => e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event });

test('switches run one at a time in order; the last press wins and the mic matches; the same press twice is one', async t => {
    const { e, n, obs, control } = fixture(t);
    n.delayMs = 15;
    const runs = ['human', 'ai', 'human', 'ai', 'human'].map(to => control.setVoice(to));
    await tick();
    assert.equal(e.control.switching, true, 'shown while a switch runs');
    await Promise.allSettled(runs);
    assert.equal(e.control.voice, 'human'); assert.equal(e.control.switching, false);
    assert.deepEqual(obs.calls, [true, false, true, false, true]);
    obs.calls.length = 0;
    await Promise.all([control.setVoice('ai'), control.setVoice('ai')]);
    assert.deepEqual(obs.calls, [false], 'a held key is one press');
});

test('the AI\'s first line is prepared in a pause while the person speaks, and airs at once on resume (gated)', async t => {
    const { e, n, control } = fixture(t);
    await control.setVoice('human');
    e.humanActiveAt = Date.now();
    await step(e);
    assert.equal(e.preparing, null, 'not while the person is speaking');
    e.humanActiveAt = Date.now() - 3000;
    await step(e);
    await until(() => e.prepared?.resume);
    assert.equal(e.pending, null, 'prepared, not aired');
    assert.ok(n.generated.at(-1).humanHandoff, 'made knowing a person has the voice');
    const line = e.prepared.text;
    await control.setVoice('ai');
    const p = await step(e);
    assert.equal(p.text, line, 'the prepared line airs on the next turn');
    assert.ok(n.judged.some(j => j.text === line), 'it passed the gate');
    assert.ok(!e.handoffResume, 'the next line is not told again');
});

test('a stale resume line is dropped; a bridge line airs at once, at most every 5 minutes', async t => {
    const { e, control, events } = fixture(t, { HUMAN_VOICE_MODE: 'resynth' });
    await control.setVoice('human');
    await until(() => e.bridge.ready.length === BRIDGE_LINES.length);
    e.humanActiveAt = 0;
    await step(e); await until(() => e.prepared?.resume);
    e.humanHeard('ちょっと別の話をするね。'); // newer than the prepared line
    await control.setVoice('ai');
    assert.equal(e.prepared, null, 'stale: dropped');
    assert.equal(e.pending?.bridge, true); assert.ok(BRIDGE_LINES.includes(e.pending.text));
    assert.ok(events.some(ev => ev.type === 'speech' && ev.data.bridge));
    ack(e, 'started'); ack(e, 'ended');
    await control.setVoice('human'); await control.setVoice('ai');
    assert.ok(!e.pending?.bridge, 'not again within 5 minutes');
    const b = new ResumeBridge({ now: () => 0 }); assert.equal(b.take(), null, 'nothing before it is prepared');
});

test('HANDOFF_TIMING=sentence: the line on air finishes first (at most 4 s); immediate cuts it at once', async t => {
    const { e, obs, control } = fixture(t, { HANDOFF_TIMING: 'sentence' });
    await e.prepare(e.epoch, e.controller.signal); await step(e); ack(e, 'started');
    const id = e.pending.id, run = control.setVoice('human');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(e.pending?.id, id, 'still speaking'); assert.deepEqual(obs.calls, []);
    ack(e, 'ended');
    await run;
    assert.deepEqual(obs.calls, [true]); assert.equal(e.control.voice, 'human');
    const f = fixture(t, { HANDOFF_TIMING: 'sentence' });
    await f.e.prepare(f.e.epoch, f.e.controller.signal); await step(f.e); ack(f.e, 'started');
    let calls = 0; const base = Date.now(); f.control.now = () => (calls++ > 4 ? base + 5000 : base);
    await f.control.setVoice('human');
    assert.equal(f.e.pending, null, 'cut after 4 s');
});

test('MUTE NOA (none): neither the AI nor the mic; AI RESUME from it needs no mic; from a person the mic is muted first', async t => {
    const { e, obs, control } = fixture(t);
    await e.prepare(e.epoch, e.controller.signal); await step(e);
    await control.setVoice('none');
    assert.equal(e.pending, null); assert.deepEqual(obs.calls, []); assert.equal(e.phase, 'muted');
    assert.equal(e.humanAccepts(), 'muted');
    await control.setVoice('ai');
    assert.deepEqual(obs.calls, [], 'the mic was never opened');
    await control.setVoice('human'); await control.setVoice('none');
    assert.deepEqual(obs.calls, [true, false]);
    assert.ok(config({ HANDOFF_TIMING: 'sentence' }, [], false).handoffTiming === 'sentence');
    assert.equal(config({}, [], false).resumeBridge, true);
    const c = setup(t);
    assert.equal(saveSettings(c, { values: { HANDOFF_TIMING: 'sentence', RESUME_BRIDGE: 'false' } }).values.RESUME_BRIDGE, false);
    assert.throws(() => saveSettings(c, { values: { HANDOFF_TIMING: 'slow' } }), /交代のタイミング/);
});

test('handoff latency: press -> stage silence, press -> first AI line playing', async t => {
    const { e, control, events } = fixture(t);
    let clock = 1000; control.now = () => clock;
    await e.prepare(e.epoch, e.controller.signal); await step(e); ack(e, 'started');
    await control.setVoice('human');
    const h = events.find(ev => ev.type === 'handoff');
    assert.ok(h);
    clock += 130;
    assert.equal(control.reportSilent(h.data.seq + 1), false, 'another handoff');
    assert.equal(control.reportSilent(h.data.seq), true);
    assert.equal(e.control.latency.silentMs, 130);
    await control.setVoice('ai');
    clock += 400;
    await e.prepare(e.epoch, e.controller.signal); await step(e); ack(e, 'started');
    assert.equal(e.control.latency.resumeMs, 400);
    assert.equal(e.status().control.latency.silentP50, 130);
});

test('stage: one gain per utterance, a 120 ms fade on a handoff, and the silence report; Studio F9 / F10', () => {
    const stage = readFileSync(new URL('../public/stage.mjs', import.meta.url), 'utf8'), studio = readFileSync(new URL('../public/studio.mjs', import.meta.url), 'utf8');
    assert.match(stage, /d\?\.reason === 'voice_handoff'\) fadeCancel\(\)/);
    assert.match(stage, /linearRampToValueAtTime\(0, t \+ HANDOFF_FADE_MS \/ 1000\)/);
    assert.equal((stage.match(/outGain = audioContext\.createGain\(\)/g) || []).length, 2, 'the WAV and stream paths');
    assert.match(stage, /api\('\/api\/renderer\/handoff', \{ lease, seq \}\)/);
    assert.match(studio, /control\('hotkey', \{ name \}\)/);
    const hot = readFileSync(new URL('../public/hotkeys.mjs', import.meta.url), 'utf8');
    assert.match(hot, /F9: 'mute', F10: 'resume'/);
});
