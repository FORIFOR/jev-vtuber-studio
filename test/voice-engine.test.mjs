import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, parseStyleMap } from '../src/config.mjs';
import { Jev, Effects, EXTRA_ANSWERS, noul } from '../src/jev.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { SpeechDirector, demoDelivery } from '../src/speech-director.mjs';
import { DirectedVoice } from '../src/voice-router.mjs';
import { ReactionAudioCache, addClip } from '../src/reaction-audio.mjs';
import { writeWav, readWav } from '../src/wav.mjs';
import { wavDuration } from '../src/providers.mjs';
import { plannedSilenceMs } from '../src/audio-bus.mjs';
import { INTENSITY_GAIN, clipCompatible } from '../public/voice-acting.mjs';
import { setup, ledger, audit, active, defer, response, wav, choiceAnswer, judgeRequest, judgeResponse } from './helpers.mjs';

const tick = () => new Promise(r => setImmediate(r));
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const keysDeep = (x, out = new Set()) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { out.add(k); keysDeep(v, out); } return out; };
const rejectsWith = (env, message, secret = null) => {
    assert.throws(() => config(env, [], false), e => {
        assert.equal(e.message, message);
        if (secret) assert.ok(!e.message.includes(secret), 'the message never echoes the value');
        return true;
    });
};

// ---------------------------------------------------------------- config
test('config: defaults keep direction off, no reaction audio, no phrase cache and the VOICEVOX host', t => {
    const c = setup(t);
    assert.equal(c.speechDirection, 'off'); assert.equal(c.reactionAudio, false); assert.equal(c.phraseCache, false);
    assert.deepEqual(c.hostStyleMap, {}); assert.ok(Object.isFrozen(c.hostStyleMap));
    assert.equal(c.replyTtsProvider, 'voicevox');
    assert.equal(c.aivisURL, 'http://127.0.0.1:10101'); assert.equal(c.aivisStyle, 0); assert.equal(c.aivisSpeed, 1); assert.equal(c.aivisIntonation, 1); assert.equal(c.aivisTempo, 1); assert.equal(c.aivisCredit, '');
    assert.equal(c.sbv2URL, 'http://127.0.0.1:5055'); assert.equal(c.sbv2Model, ''); assert.equal(c.sbv2Speaker, ''); assert.equal(c.sbv2Style, 'Neutral');
    assert.equal(c.sbv2StyleWeight, 1); assert.equal(c.sbv2Speed, 1); assert.equal(c.sbv2Credit, '');
    const x = config({ AIVIS_URL: 'http://127.0.0.1:10101/', SBV2_URL: 'http://localhost:5055/', SPEECH_DIRECTION: 'jev', REACTION_AUDIO: 'true', PHRASE_CACHE: 'true' }, [], false);
    assert.equal(x.aivisURL, 'http://127.0.0.1:10101'); assert.equal(x.sbv2URL, 'http://localhost:5055');
    assert.equal(x.speechDirection, 'jev'); assert.equal(x.reactionAudio, true); assert.equal(x.phraseCache, true);
});

test('config: 31-bit AivisSpeech style ids, the four host providers and the direction switches', () => {
    assert.equal(config({ AIVIS_STYLE: '888753760' }, [], false).aivisStyle, 888753760);
    assert.equal(config({ AIVIS_STYLE: '2147483647' }, [], false).aivisStyle, 2147483647);
    rejectsWith({ AIVIS_STYLE: '2147483648' }, 'Invalid AIVIS_STYLE', '2147483648');
    for (const p of ['voicevox', 'supertonic', 'aivisspeech', 'sbv2']) assert.equal(config({ REPLY_TTS_PROVIDER: p }, [], false).replyTtsProvider, p);
    rejectsWith({ REPLY_TTS_PROVIDER: 'elevenlabs' }, 'Invalid REPLY_TTS_PROVIDER', 'elevenlabs');
    rejectsWith({ SPEECH_DIRECTION: 'x' }, 'Invalid SPEECH_DIRECTION');
    rejectsWith({ REACTION_AUDIO: 'true' }, 'Invalid REACTION_AUDIO (requires SPEECH_DIRECTION)');
    rejectsWith({ REACTION_AUDIO: 'true', SPEECH_DIRECTION: 'off' }, 'Invalid REACTION_AUDIO (requires SPEECH_DIRECTION)');
    rejectsWith({ PHRASE_CACHE: 'true', SPEECH_DIRECTION: 'off' }, 'Invalid PHRASE_CACHE (requires SPEECH_DIRECTION)');
    assert.equal(config({ REACTION_AUDIO: 'true', SPEECH_DIRECTION: 'reaction' }, [], false).reactionAudio, true);
    assert.equal(config({ PHRASE_CACHE: 'true', SPEECH_DIRECTION: 'reaction' }, [], false).phraseCache, true);
});

test('config: every engine knob is range-checked with a message that never echoes the value', () => {
    for (const [key, value] of [['AIVIS_SPEED', '2.5'], ['AIVIS_SPEED', '0.4'], ['AIVIS_INTONATION', '3'], ['AIVIS_INTONATION', '-1'], ['AIVIS_TEMPO', '2.1'], ['AIVIS_TEMPO', 'NaN'],
        ['SBV2_STYLE_WEIGHT', '5.5'], ['SBV2_SPEED', '0.1'], ['SBV2_MODEL', 'evil/../model'], ['SBV2_MODEL', 'x'.repeat(65)], ['SBV2_SPEAKER', '<script>'], ['SBV2_SPEAKER', 'a\u0007b'],
        ['SBV2_STYLE', '<x>'], ['SBV2_STYLE', 'y'.repeat(33)]])
        rejectsWith({ [key]: value }, `Invalid ${key}`, value);
    const ok = config({ AIVIS_SPEED: '2', AIVIS_INTONATION: '0', AIVIS_TEMPO: '0', SBV2_STYLE_WEIGHT: '5', SBV2_SPEED: '.5', SBV2_MODEL: 'jvnv-F1-jp', SBV2_SPEAKER: 'あみたろ', SBV2_STYLE: 'Happy (強)' }, [], false);
    assert.deepEqual([ok.aivisSpeed, ok.aivisIntonation, ok.aivisTempo, ok.sbv2StyleWeight, ok.sbv2Speed, ok.sbv2Model, ok.sbv2Speaker, ok.sbv2Style], [2, 0, 0, 5, .5, 'jvnv-F1-jp', 'あみたろ', 'Happy (強)']);
    for (const key of ['AIVIS_URL', 'SBV2_URL']) rejectsWith({ [key]: 'http://evil.example' }, 'Remote providers require HTTPS');
    assert.equal(config({ SBV2_URL: 'https://tts.example' }, [], false).sbv2URL, 'https://tts.example');
});

test('config: HOST_STYLE_MAP is a frozen, sorted family map and a bad one never echoes its input', () => {
    const m = parseStyleMap('{"surprise":888753761,"joy":"Happy"}');
    assert.deepEqual(Object.keys(m), ['joy', 'surprise']); assert.equal(m.surprise, 888753761); assert.ok(Object.isFrozen(m));
    assert.deepEqual(parseStyleMap(''), {}); assert.deepEqual(parseStyleMap(), {}); assert.deepEqual(parseStyleMap('{}'), {});
    assert.deepEqual(config({ HOST_STYLE_MAP: '{"worry":"Sad","calm":2147483647}' }, [], false).hostStyleMap, { calm: 2147483647, worry: 'Sad' });
    const eight = JSON.stringify({ neutral: 0, calm: 1, joy: 2, surprise: 3, shy: 4, think: 5, worry: 6, extra: 7 });
    for (const text of ['{"joy":', '["joy"]', '{"happy":1}', eight, '{"joy":"<x>"}', '{"joy":2147483648}', '{"joy":-1}', '{"joy":1.5}', '{"joy":null}', '{"joy":{"a":1}}', 'null', '"joy"', `{"joy":"${'a'.repeat(1000)}"}`]) {
        assert.throws(() => parseStyleMap(text), e => e.message === 'Invalid HOST_STYLE_MAP' && !e.message.includes(text));
        rejectsWith({ HOST_STYLE_MAP: text }, 'Invalid HOST_STYLE_MAP', text);
    }
});

// ---------------------------------------------------------------- Jev
const TEXT = 'えっ、ちょっと待って！うわ、今日の星空は思っていたよりずっと明るくて、望遠鏡なしでも天の川が見えるね。';
const FLAT = new SpeechDirector({ speechDirection: 'jev' }).prepare(TEXT).flat;
const CTX = { kind: 'autonomous', goal: '星空の見え方を比べる', topic: '星', beatId: 'b1', recentSpeech: [], comment: null };
const SNAPSHOT = ['safe', 'private', 'injection', 'effect', 'warranted', 'mood', 'reaction', 'honest', 'novel', 'progress'];
const GATE_NOUL = { private: 0, injection: 0, warranted: .9 };
function jevFixture(t, { nouls = {}, picks = {}, mutate = null, env = {} } = {}) {
    // The local judge (src/local-judge.mjs) answers over an OpenAI-compatible chat request; `bodies` are its decoded
    // {state, questions} in the gate's shape and `raw` their JSON (the bytes the context budget is measured on).
    const c = setup(t, { MODE: 'live', LLM_MODEL: 'fixture', LLM_BASE_URL: 'http://127.0.0.1:9/v1', SHOW_PROFILE: 'talk', ...env });
    const bodies = [], raw = [];
    const fetchFn = async (_u, o) => {
        const b = judgeRequest(JSON.parse(o.body)); raw.push(JSON.stringify(b)); bodies.push(b);
        const answers = Object.fromEntries(Object.entries(b.questions).map(([k, q]) => [k, q.type === 'noul'
            ? { type: 'noul', noul: nouls[k] ?? GATE_NOUL[k] ?? 1 }
            : choiceAnswer(q.criteria, picks[k] ?? Object.keys(q.criteria)[0])]));
        mutate?.(answers);
        return response(judgeResponse(answers));
    };
    const l = ledger();
    return { c, jev: new Jev(c, l, audit, fetchFn), bodies, raw, l };
}

test('Jev: without delivery the request, the question set and the result shape are exactly today\'s', async t => {
    const { jev, bodies, l } = jevFixture(t);
    const r = await jev.speech(TEXT, undefined, [], CTX);
    assert.equal(bodies.length, 1); assert.deepEqual(Object.keys(bodies[0].questions), SNAPSHOT);
    assert.deepEqual(Object.keys(bodies[0].state), ['speech', 'programmeContext']); assert.equal(bodies[0].state.delivery, undefined);
    assert.deepEqual(Object.keys(r), ['accept', 'reason', 'effect', 'mood', 'reaction', 'provider']);
    assert.equal(r.accept, true); assert.equal('delivery' in r, false); assert.deepEqual(l.calls, {}, 'the local judge reserves no paid call');
    // Plain ask() carries no extra-answers slot either.
    assert.equal((await jev.ask({ x: 1 }, { ok: noul('Read x') }))[EXTRA_ANSWERS], undefined);
});

test('Jev: jev direction rides in ONE request with lenient, separately validated delivery questions', async t => {
    assert.ok(FLAT.length >= 5, 'fixture text has more chunks than the judged cap');
    const { jev, bodies, l } = jevFixture(t, { picks: { delivery_intensity: 'high', delivery_pace: 'fast', delivery_ending: 'hold', delivery_nonverbal: 'gasp', seg2_reaction: 'thinking', reaction: 'shock' } });
    const r = await jev.speech(TEXT, undefined, [], CTX, { chunks: FLAT.slice(0, 4), clipKinds: ['hmm', 'gasp'] });
    assert.equal(bodies.length, 1); assert.deepEqual(l.calls, {});
    const keys = Object.keys(bodies[0].questions);
    assert.deepEqual(keys.slice(0, SNAPSHOT.length), SNAPSHOT, 'gate questions first and unchanged');
    assert.deepEqual(keys.slice(SNAPSHOT.length), ['delivery_intensity', 'delivery_pace', 'delivery_ending', 'delivery_nonverbal', 'seg1_reaction', 'seg2_reaction', 'seg3_reaction']);
    assert.deepEqual(Object.keys(bodies[0].questions.delivery_nonverbal.criteria), ['none', 'gasp', 'hmm'], 'only the available kinds, in NONVERBAL order');
    assert.deepEqual(bodies[0].state.delivery, { segments: FLAT.slice(0, 4) });
    for (const k of keys.slice(SNAPSHOT.length)) for (const chunk of FLAT) assert.ok(!bodies[0].questions[k].instructions.includes(chunk), 'instructions refer to state, never embed text');
    assert.equal(r.accept, true); assert.equal(r.reaction, 'shock');
    // Segment 0 is the gate reaction; later segments take their own confident answer (the fixture picks neutral unless told otherwise).
    assert.deepEqual(r.delivery, { source: 'jev', intensity: 'high', pace: 'fast', ending: 'hold', nonverbal: 'gasp', reactions: ['shock', 'neutral', 'thinking', 'neutral'], defaulted: false });
    // No clip kinds: no nonverbal question. Two chunks: exactly one segment question.
    await jev.speech(TEXT, undefined, [], CTX, { chunks: ['えっ、', 'ちょっと待って！'], clipKinds: [] });
    assert.deepEqual(Object.keys(bodies[1].questions).slice(SNAPSHOT.length), ['delivery_intensity', 'delivery_pace', 'delivery_ending', 'seg1_reaction']);
    // Segments that are not substrings of the judged speech are never sent.
    await jev.speech(TEXT, undefined, [], CTX, { chunks: ['別の文章です。'], clipKinds: [] });
    assert.deepEqual(bodies[2].state.delivery, { segments: [] }); assert.ok(!bodies[2].questions.seg1_reaction);
    assert.ok(!JSON.stringify(bodies[2]).includes('別の文章'));
});

// Extras (delivery) never fail the gate: local-judge.mjs requires only the gate's own keys.
test('Jev: a malformed extra answer is defaulted without touching accept or the Jev circuit', async t => {
    const { jev } = jevFixture(t, { mutate: a => {
        a.delivery_intensity = { type: 'choice', choice: 'extreme', confidence: .9 }; // outside the candidate set
        a.delivery_pace = { ...a.delivery_pace, confidence: 2 }; // not a probability
        delete a.seg1_reaction;
    } });
    for (let i = 0; i < 4; i++) {
        const r = await jev.speech(TEXT, undefined, [], CTX, { chunks: FLAT.slice(0, 4), clipKinds: [] });
        assert.equal(r.accept, true); assert.equal(r.reason, 'accepted');
        assert.equal(r.delivery.defaulted, true); assert.equal(r.delivery.intensity, null); assert.equal(r.delivery.pace, null);
        assert.equal(r.delivery.ending, 'beat', 'the valid extras are still used');
        assert.equal(jev.failures, 0); assert.equal(jev.openUntil, 0);
    }
});

test('Jev: a malformed gate answer fails closed and counts a circuit failure, with or without extras', async t => {
    const strict = jevFixture(t, { mutate: a => { a.safe = { type: 'noul', noul: 2 }; } });
    await assert.rejects(strict.jev.speech(TEXT, undefined, [], CTX, { chunks: FLAT.slice(0, 4), clipKinds: [] }));
    assert.equal(strict.jev.failures, 1);
});

test('Jev: thresholds are unchanged in jev direction (novel .69 and safe .93 still reject)', async t => {
    const d = { chunks: FLAT.slice(0, 4), clipKinds: ['gasp'] };
    const novel = await jevFixture(t, { nouls: { novel: .69 } }).jev.speech(TEXT, undefined, [], CTX, d);
    assert.equal(novel.accept, false); assert.equal(novel.reason, 'no_progress'); assert.equal(novel.delivery.source, 'jev');
    const progress = await jevFixture(t, { nouls: { progress: .69 } }).jev.speech(TEXT, undefined, [], CTX, d);
    assert.equal(progress.accept, false); assert.equal(progress.reason, 'no_progress');
    const safe = await jevFixture(t, { nouls: { safe: .93 } }).jev.speech(TEXT, undefined, [], CTX, d);
    assert.equal(safe.accept, false); assert.equal(safe.reason, 'unsafe_or_uncertain');
    const edge = await jevFixture(t, { nouls: { novel: .7, progress: .7, safe: .94 } }).jev.speech(TEXT, undefined, [], CTX, d);
    assert.equal(edge.accept, true);
    const local = await jevFixture(t).jev.speech('連絡先 test@example.com です。', undefined, [], CTX, d);
    assert.deepEqual(local, { accept: false, effect: 'none' }, 'the local gate answers before anything else');
});

test('Jev: extras that would exceed the 24000-byte judge context budget are dropped and the gate is still asked', async t => {
    const { jev, bodies, raw } = jevFixture(t);
    await jev.speech(TEXT, undefined, [], CTX);
    const pad = 24000 - Buffer.byteLength(raw[0]) - 40; // the plain body fits with 40 bytes to spare
    const big = { ...CTX, goal: CTX.goal + 'g'.repeat(pad) };
    const r = await jev.speech(TEXT, undefined, [], big, { chunks: FLAT.slice(0, 4), clipKinds: ['gasp'] });
    assert.equal(bodies.length, 2); assert.ok(Buffer.byteLength(raw[1]) <= 24000);
    assert.deepEqual(Object.keys(bodies[1].questions), SNAPSHOT); assert.equal(bodies[1].state.delivery, undefined);
    assert.equal(r.accept, true); assert.equal(r.delivery.defaulted, true); assert.equal(r.delivery.intensity, null); assert.equal(jev.failures, 0);
    // A gate body that is itself too large still fails closed, as today.
    await assert.rejects(jev.speech(TEXT, undefined, [], { ...CTX, goal: 'g'.repeat(24000) }, { chunks: FLAT.slice(0, 4), clipKinds: [] }), /budget/);
    assert.equal(bodies.length, 2);
});

test('Jev: ask() extras are invisible to Object.entries and JSON and can never replace a gate question', async t => {
    const { jev, bodies } = jevFixture(t);
    const a = await jev.ask({ x: 1 }, { ok: noul('Read x') }, undefined, { state: { x: 'overwrite', y: 2 }, questions: { ok: noul('Replace the gate'), extra_ok: noul('Extra') } });
    assert.deepEqual(bodies[0].state, { x: 1, y: 2 }); assert.equal(bodies[0].questions.ok.instructions, 'Read x');
    assert.deepEqual(Object.keys(a), ['ok']); assert.ok(!JSON.stringify(a).includes('extra_ok'));
    assert.deepEqual(a[EXTRA_ANSWERS], { answers: { extra_ok: { type: 'noul', noul: 1 } }, defaulted: false });
});

test('Jev: demo with delivery adds demoDelivery and makes no request', async t => {
    const j = new Jev(setup(t, { SHOW_PROFILE: 'talk' }), ledger(), audit, () => { throw new Error('No network allowed'); });
    const plain = await j.speech(TEXT, undefined, [], CTX);
    assert.equal('delivery' in plain, false);
    const r = await j.speech(TEXT, undefined, [], CTX, { chunks: FLAT.slice(0, 4), clipKinds: ['gasp'] });
    assert.deepEqual(r, { ...plain, delivery: demoDelivery(TEXT, FLAT.slice(0, 4)) });
    assert.equal(r.delivery.source, 'demo-rule'); assert.equal(r.delivery.nonverbal, 'none');
});

test('Effects.take: today\'s shape without delivery; a cooldown downgrade calms a high intensity', () => {
    const f = new Effects();
    assert.deepEqual(f.take({ effect: 'spark', mood: 'happy' }, 10000), { effect: 'spark', mood: 'happy' });
    assert.deepEqual(f.take({ effect: 'none', mood: 'warm', reaction: 'happy' }, 11000), { effect: 'none', mood: 'happy', reaction: 'happy' });
    const g = new Effects();
    assert.deepEqual(g.take({ effect: 'none', mood: 'warm', reaction: 'shock', delivery: { intensity: 'high' } }, 20000), { effect: 'none', mood: 'warm', reaction: 'shock', intensity: 'high' });
    assert.deepEqual(g.take({ effect: 'none', mood: 'warm', reaction: 'shock', delivery: { intensity: 'high' } }, 22000), { effect: 'none', mood: 'warm', reaction: 'surprised', intensity: 'mid' });
    assert.equal(g.take({ reaction: 'shock', delivery: { intensity: 'low' } }, 23000).intensity, 'low', 'only high is calmed');
    assert.equal(g.take({ reaction: 'surprised', delivery: { intensity: 'high' } }, 23500).intensity, 'high', 'a non-big preset keeps its intensity');
    assert.equal(g.take({ reaction: 'happy', delivery: {} }, 24000).intensity, 'mid');
    assert.equal(g.take({ reaction: 'happy', delivery: { intensity: 'extreme' } }, 25000).intensity, 'mid');
    assert.equal(g.take({ reaction: 'happy', delivery: null }, 26000).intensity, 'mid');
});

// ---------------------------------------------------------------- TalkEngine
const TWO = 'えっ、ちょっと待って！今のは本当にすごかったね。';
const shockVerdict = { accept: true, reason: 'accepted', effect: 'none', mood: 'warm', reaction: 'shock' };
/** A finalize-capable mock voice result: the clip is kept only when the post-cooldown reaction still matches it. */
function rendered(text, plan, { cache = 0, local = 1, durationMs = 200, mode = 'reaction' } = {}) {
    const cls = plan?.clip?.cls ?? null, stats = { engine: 'mock', tiers: { cache, local }, calls: local, synthMs: 50 * local, audioMs: local ? durationMs : 0, clip: cls, clipSkipped: null };
    let finalized = 0;
    return { kind: 'wav', bytes: wav(durationMs / 1000), durationMs, stats, get finalized() { return finalized; },
        finalize({ reaction } = {}) {
            finalized++;
            const keep = !!cls && clipCompatible(cls, reaction, mode);
            return { kind: 'wav', bytes: wav(durationMs / 1000), durationMs: keep ? durationMs : durationMs - 50, leadMs: keep && plan.clip.position === 'pre' ? 0 : null, beats: [{ atMs: 20, reaction: 'surprised' }], mouth: [], clip: keep ? cls : null, stats };
        } };
}
function talkRig(t, { env = {}, verdict = shockVerdict, text = TWO, voice = {}, jev = null, commentVoice, events } = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env });
    const calls = { speech: [], synth: [], generate: 0, clipKinds: 0, warmup: 0, narrator: [] };
    const v = {
        synthesize: async (...args) => { calls.synth.push(args); return rendered(args[0], args[2]); },
        clipKinds: () => { calls.clipKinds++; return ['gasp']; }, available: () => true, retryAt: () => 0,
        estimateAudioMs: s => s.length * 100, estimateSynthMs: () => 0, status: () => ({ direction: c.speechDirection, main: { id: 'mock', state: 'ready' } }), ...voice,
    };
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: jev || { chat: async () => ({ accept: true, readAllowed: true, action: 'reply' }), speech: async (...args) => { calls.speech.push(args); return structuredClone(verdict); } },
        conversation: { generate: async () => { calls.generate++; return text; } }, voice: v,
        research: { search: async () => { throw new Error('Talk must not search'); } }, ...(commentVoice ? { commentVoice } : {}) });
    if (events) e.on('event', ev => events.push(ev));
    t.after(() => e.stop('test'));
    return { c, e, calls, v };
}
async function nextPart(e) {
    for (let n = 0; n < 60 && e.running && !e.pending; n++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        if (!e.pending) await tick();
    }
    assert.ok(e.pending, 'next approved part'); return e.pending;
}
const ack = (e, event) => { const p = e.pending; return e.acknowledge({ id: p.id, lease: e.renderer.lease, event }); };
async function play(e) { const p = await nextPart(e); assert.equal(ack(e, 'started'), true); assert.equal(ack(e, 'ended'), true); return p; }

test('TalkEngine publishes the finalized host lip timeline with its pending WAV', async t => {
    const lipSync = { version: 1, source: 'reading-estimate', durationMs: 200, cues: [{ startMs: 15, endMs: 185, vowel: 'i' }] };
    const events = [];
    const { e } = talkRig(t, { text: 'この色が好き。', events,
        voice: { synthesize: async () => ({ kind: 'wav', bytes: tone(.2, 440), durationMs: 200,
            finalize: () => ({ kind: 'wav', bytes: tone(.2, 440), durationMs: 200, lipSync }) }) } });
    active(e); const pending = await nextPart(e);
    assert.deepEqual(pending.lipSync, lipSync);
    assert.deepEqual(events.find(event => event.type === 'speech').data.lipSync, lipSync);
    assert.ok(e.audio.has(pending.id));
});

test('TalkEngine: direction off keeps the 4-argument Jev call and the 2-argument synthesize', async t => {
    const events = [];
    const { e, calls, c } = talkRig(t, { events, verdict: { accept: true, effect: 'none', mood: 'warm', reaction: 'shock' } });
    assert.equal(c.speechDirection, 'off'); active(e);
    const p1 = await play(e), p2 = await play(e);
    assert.equal(calls.speech.length, 1); assert.equal(calls.speech[0].length, 4);
    assert.equal(calls.synth.length, 2); assert.ok(calls.synth.every(a => a.length === 2), 'no third argument without a plan');
    assert.equal(calls.clipKinds, 0);
    for (const p of [p1, p2]) for (const k of ['intensity', 'leadMs', 'mouth']) assert.equal(k in p, false, k);
    assert.equal(e.currentTurn, null); assert.equal(e.metrics.counters.turns_played, 1);
});

test('TalkEngine: reaction direction plans each part, finalizes at publication and keeps operator data off the stage', async t => {
    const events = [];
    const { e, calls, c } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, events });
    active(e);
    const applied = [], apply = e.affect.apply.bind(e.affect);
    e.affect.apply = (...args) => { applied.push(args); return apply(...args); };
    const p1 = await nextPart(e);
    assert.equal(calls.speech[0].length, 4, 'reaction direction asks Jev nothing new');
    const [part0, part1] = new SpeechDirector(c).plan(TWO, shockVerdict, { clipKinds: ['gasp'] }).parts;
    const s0 = calls.synth[0];
    assert.equal(s0.length, 3); assert.equal(s0[2].text, s0[0]); assert.deepEqual(s0[2].clip, { cls: 'gasp', position: 'pre' });
    assert.equal(s0[2].budgetMs, c.maxTurnAudioMs - part1.text.length * 100 - plannedSilenceMs(part1), 'part 0 reserves the estimate for part 1, its pauses and tail');
    assert.deepEqual({ ...s0[2], budgetMs: undefined }, { ...part0, budgetMs: undefined });
    assert.equal(p1.intensity, 'high'); assert.equal(p1.reaction, 'shock'); assert.equal(p1.leadMs, 0, 'a kept pre-clip leads on the same frame');
    assert.deepEqual(p1.beats, [{ atMs: 20, reaction: 'surprised' }]); assert.equal('mouth' in p1, false, 'empty mouth windows are omitted');
    assert.equal(e.currentTurn.parts[0].audio.finalized, 1);
    const speech = events.filter(x => x.type === 'speech');
    assert.equal(speech.at(-1).data.intensity, 'high'); assert.equal(speech.at(-1).data.leadMs, 0);
    for (const x of [e.pending, speech.at(-1).data]) for (const k of ['stats', 'tiers', 'engine', 'calls', 'synthMs']) assert.ok(!keysDeep(x).has(k), k);
    assert.equal(ack(e, 'started'), true);
    assert.equal(events.find(x => x.type === 'speech_started').data.intensity, 'high');
    assert.equal(applied[0][2], INTENSITY_GAIN.high, 'the avatar affect gets the intensity gain');
    assert.equal(ack(e, 'ended'), true);
    // Part 2 inside the 6 s cooldown: shock is calmed to its fallback and the intensity follows.
    const p2 = await nextPart(e);
    assert.equal(calls.synth[1].length, 3); assert.equal(calls.synth[1][2].text, calls.synth[1][0]);
    assert.equal(calls.synth[1][2].budgetMs, c.maxTurnAudioMs - 200, 'the last part gets the exact remainder');
    assert.equal(p2.reaction, 'surprised'); assert.equal(p2.intensity, 'mid'); assert.equal('leadMs' in p2, false);
    assert.equal(e.metrics.counters.reaction_clip_used, 1);
    assert.equal(e.lastDelivery.part, 2); assert.equal(e.lastDelivery.reaction, 'surprised'); assert.equal(e.lastDelivery.source, 'reaction');
    assert.deepEqual(e.lastDelivery.chunks, [{ chars: 13, reaction: 'shock', pace: 'fast', ending: 'beat' }]);
    assert.ok(e.trace.some(x => x.kind === 'voice_tier' && x.detail.includes('mock')));
    const view = e.operatorView();
    assert.equal(view.delivery.engine, 'mock'); assert.deepEqual(view.voice, { direction: 'reaction', main: { id: 'mock', state: 'ready' } });
    assert.ok(!JSON.stringify(view.delivery).includes('今のは'), 'the DELIVERY card carries lengths, not text');
    assert.ok(view.performance.ttfa && view.performance.rtf); assert.equal(view.performance.rtf.last, 250);
});

test('TalkEngine: 300 directed turns keep at most one audio entry', async t => {
    const { e } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' } });
    active(e); e.director.finite = false; e.endAt = Date.now() + 1800000;
    for (let i = 0; i < 600; i++) { await play(e); assert.ok(e.audio.size <= 1); }
    assert.ok(e.metrics.counters.turns_played >= 290); assert.ok(e.audio.size <= 1);
});

test('TalkEngine: a rejection never reaches the SpeechDirector or synthesis', async t => {
    const { e, calls } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, verdict: { accept: false, reason: 'unsafe_or_uncertain', effect: 'none' } });
    active(e);
    let plans = 0; const plan = e.speechDirector.plan.bind(e.speechDirector);
    e.speechDirector.plan = (...a) => { plans++; return plan(...a); };
    e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(calls.speech.length, 1); assert.equal(plans, 0); assert.equal(calls.synth.length, 0); assert.equal(e.pending, null);
    assert.equal(e.metrics.counters.content_stall_skips, 1, 'a refusal skips the beat; it is not a provider failure');
});

test('TalkEngine: PLAN_INVARIANT counts a direction failure through the ordinary generation-failure path', async t => {
    const { e } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { synthesize: async () => { throw Object.assign(new Error('Direction altered text'), { code: 'PLAN_INVARIANT' }); } } });
    active(e); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.metrics.counters.generation_failure, 1); assert.equal(e.metrics.counters.speech_direction_failure, 1);
    assert.equal(e.prepared, null); assert.equal(e.generationFailures, 1); assert.ok(e.generationRetryAt > Date.now());
    // A plan whose parts do not match the approved sentences is refused before any synthesis.
    const { e: e2, calls } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' } });
    active(e2); const plan = e2.speechDirector.plan.bind(e2.speechDirector);
    e2.speechDirector.plan = (...a) => { const p = plan(...a); return { ...p, parts: p.parts.slice(0, 1) }; };
    await e2.prepare(e2.epoch, e2.controller.signal);
    assert.equal(calls.synth.length, 0); assert.equal(e2.metrics.counters.speech_direction_failure, 1); assert.equal(e2.metrics.counters.generation_failure, 1);
});

test('TalkEngine: an unavailable voice engine skips the paid LLM and Jev calls and never switches voice', async t => {
    const retryAt = Date.now() + 30000, notices = [], stopped = [];
    const { e, calls } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { available: () => false, retryAt: () => retryAt } });
    active(e); e.on('event', ev => { if (ev.type === 'notice') notices.push(ev.data.message); }); e.on('stopped', r => stopped.push(r));
    e.candidates.push({ id: 'kept', text: 'コメント', created: Date.now(), epoch: e.epoch, kind: 'reply' });
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(calls.generate, 0); assert.equal(calls.speech.length, 0); assert.equal(calls.synth.length, 0);
    assert.ok(e.generationRetryAt >= retryAt); assert.equal(e.candidates[0].id, 'kept', 'no candidate is consumed');
    assert.equal(e.metrics.counters.voice_unavailable_skip, 1); assert.equal(e.metrics.counters.generation_failure, 1);
    assert.match(notices[0], /別の声へは切り替えません/);
    for (let i = 0; i < 3; i++) { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); }
    assert.equal(e.running, false); assert.deepEqual(stopped, ['provider_failures']); assert.equal(calls.generate, 0);
});

test('TalkEngine: an all-cache first part waits at most 1.5 s for a slow second part', async t => {
    const slow = defer();
    const synthesize = async (text, _signal, part) => part?.index === 1 ? slow.promise : rendered(text, part, { cache: 1, local: 0 });
    const { e } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { synthesize, estimateSynthMs: () => 5000 } });
    active(e); e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    const turn = e.currentTurn;
    assert.ok(turn && turn.parts[0].audio); assert.equal(e.pending, null, 'part 0 is held'); assert.equal(e.phase, 'preparing_audio');
    assert.equal(turn.holdUntil - turn.readyAt, 1500, 'the hold is capped at 1.5 s');
    slow.resolve(rendered('今のは本当にすごかったね。', null));
    for (let i = 0; i < 20 && !turn.parts[1].audio; i++) await tick();
    await e.speakStep(e.epoch, e.controller.signal);
    assert.equal(e.pending?.text, 'えっ、ちょっと待って！', 'the hold ends as soon as part 1 is ready');
    assert.equal(e.metrics.snapshot().latency.first_part_hold_ms.samples, 1);
    // A short estimated gap holds only for that long, even when part 1 is still rendering.
    const never = defer();
    const { e: e2 } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { synthesize: async (text, _s, part) => part?.index === 1 ? never.promise : rendered(text, part, { cache: 1, local: 0 }), estimateSynthMs: () => 900 } });
    active(e2); e2.claimRenderer('test-renderer');
    await e2.speakStep(e2.epoch, e2.controller.signal);
    assert.equal(e2.pending, null); assert.ok(e2.currentTurn.holdUntil - e2.currentTurn.readyAt <= 1500);
    await sleepMs(260);
    await e2.speakStep(e2.epoch, e2.controller.signal);
    assert.equal(e2.pending?.partIndex, 0); assert.equal(e2.currentTurn.parts[1].audio, null);
    const hold = e2.metrics.snapshot().latency.first_part_hold_ms;
    assert.ok(hold.last >= 200 && hold.last <= 1500, String(hold.last));
    // A part rendered by the engine is never held.
    const { e: e3 } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { estimateSynthMs: () => 5000 } });
    active(e3); assert.equal((await nextPart(e3)).partIndex, 0); assert.equal(e3.currentTurn.holdUntil, undefined);
});

test('TalkEngine: time to first audio, publish→start, mid-turn gaps and dead air are measured', async t => {
    const { e } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' } });
    active(e);
    for (let i = 0; i < 4; i++) await play(e);
    const lat = e.metrics.snapshot().latency, counters = e.metrics.counters;
    assert.equal(lat.first_audio_ready_ms.samples, 2); assert.equal(lat.publish_to_start_ms.samples, 4);
    assert.equal(lat.mid_turn_gap_ms.samples, 2); assert.equal(lat.dead_air_ms.samples, 1);
    assert.equal(lat.tts_rtf_permille.samples, 4); assert.equal(counters.tts_tier_local, 4); assert.equal(counters.tts_engine_calls, 4); assert.equal(counters.tts_tier_cache, 0);
    // A duplicate 'started' ACK is not measured twice.
    await nextPart(e); ack(e, 'started'); ack(e, 'started');
    assert.equal(e.metrics.snapshot().latency.publish_to_start_ms.samples, 5); assert.equal(e.metrics.snapshot().latency.dead_air_ms.samples, 2);
});

test('TalkEngine: host credit follows the provider', t => {
    const credit = env => talkRig(t, { env }).e.status().voiceCredit;
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'aivisspeech' }), 'Host: AivisSpeech');
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'aivisspeech', AIVIS_CREDIT: 'AivisSpeech: まお' }), 'AivisSpeech: まお');
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'sbv2' }), 'Host: Style-Bert-VITS2');
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'sbv2', SBV2_CREDIT: 'あみたろの声素材工房' }), 'あみたろの声素材工房');
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'supertonic' }), 'Host: Supertonic 3');
    assert.equal(credit({ VOICEVOX_CREDIT: 'VOICEVOX:ずんだもん' }), 'VOICEVOX:ずんだもん');
    assert.equal(credit({ REPLY_TTS_PROVIDER: 'sbv2', READ_COMMENTS: 'true', COMMENT_VOICEVOX_CREDIT: 'VOICEVOX:四国めたん' }), 'Host: Style-Bert-VITS2 / VOICEVOX:四国めたん');
});

test('TalkEngine: warmup runs once at start and its failure never blocks the show', async t => {
    let warm = 0, signal = null;
    const { e } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: { warmup: async s => { warm++; signal = s; throw new Error('engine still loading'); } } });
    e.start(); e.start();
    assert.equal(warm, 1); assert.ok(signal instanceof AbortSignal); assert.equal(signal, e.controller.signal); assert.equal(e.running, true);
    await tick(); e.stop('test');
    // Voices without warmup are fine.
    const { e: plain } = talkRig(t); plain.start(); assert.equal(plain.running, true); plain.stop('test');
});

test('TalkEngine: jev direction passes { chunks (≤ 4), clipKinds } as the fifth Jev argument', async t => {
    const verdict = { accept: true, reason: 'accepted', effect: 'none', mood: 'happy', reaction: 'happy', provider: 'jev',
        delivery: { source: 'jev', intensity: 'low', pace: 'slow', ending: null, nonverbal: 'none', reactions: ['happy', 'happy', 'thinking', 'thinking'], defaulted: false } };
    const { e, calls } = talkRig(t, { env: { SPEECH_DIRECTION: 'jev' }, verdict, text: TEXT });
    active(e);
    const p = await nextPart(e);
    const args = calls.speech[0];
    assert.equal(args.length, 5); assert.equal(args[0], TEXT);
    assert.deepEqual(args[4], { chunks: FLAT.slice(0, 4), clipKinds: ['gasp'] });
    assert.ok(args[4].chunks.every(x => TEXT.includes(x)));
    assert.equal(p.intensity, 'low'); assert.equal(calls.synth[0][2].intensity, 'low');
    assert.ok(e.trace.some(x => x.kind === 'jev_speech' && x.detail.includes('intensity → low')));
    assert.equal(e.lastDelivery.source, 'jev');
});

test('TalkEngine: a part-0 clip kept against part 1\'s estimate never fails the turn when part 1 renders longer', async t => {
    // 11500 ms speech + 700 ms gasp + 60 ms gap; part 1 renders past its estimate (pauses, tail, slow text).
    const sizes = [{ durationMs: 12260, clipMs: 760 }, { durationMs: 6220, clipMs: 0 }];
    const { e, calls, c } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: {
        synthesize: async (...args) => { const i = calls.synth.push(args) - 1; return { ...rendered(args[0], args[2], { durationMs: sizes[i].durationMs }), clipMs: sizes[i].clipMs }; } } });
    assert.equal(c.maxTurnAudioMs, 18000); active(e);
    const p1 = await play(e), p2 = await play(e);
    assert.equal(p1.partIndex, 0); assert.equal(p2.partIndex, 1, 'part 1 airs: 12260 + 6220 > 18000 only because of the clip');
    assert.equal(calls.synth[1][2].budgetMs, c.maxTurnAudioMs - (12260 - 760), 'part 1 gets the remainder with the clip exempt');
    assert.equal(e.turnFailures, 0); assert.equal(e.metrics.counters.turns_played, 1);
});

test('TalkEngine: without a clip the turn cap is unchanged: part 1 over the remainder still fails', async t => {
    const sizes = [12260, 6220];
    const { e, calls } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction' }, voice: {
        synthesize: async (...args) => { const i = calls.synth.push(args) - 1; return { ...rendered(args[0], args[2], { durationMs: sizes[i] }), clipMs: 0 }; } } });
    active(e);
    await play(e);
    for (let n = 0; n < 40 && !e.currentTurn?.parts[1]?.error; n++) await tick();
    assert.match(String(e.currentTurn?.parts[1]?.error?.message), /Turn audio too long/);
});

test('TalkEngine: the comment narrator never gets a plan and is never finalized; host budgets count host audio only', async t => {
    let narratorFinalized = 0;
    const narrator = [];
    const commentVoice = { synthesize: async (...args) => { narrator.push(args); return { kind: 'wav', durationMs: 900, bytes: wav(.9),
        lipSync: { version: 1, source: 'query', durationMs: 900, cues: [{ startMs: 0, endMs: 900, vowel: 'a' }] }, finalize: () => { narratorFinalized++; return {}; } }; } };
    const { e, calls, c } = talkRig(t, { env: { SPEECH_DIRECTION: 'reaction', READ_COMMENTS: 'true' }, commentVoice, text: '私は机が好き。いろいろ作業できるから。',
        verdict: { accept: true, effect: 'none', mood: 'warm', reaction: 'happy' } });
    active(e); e.director.opened = true;
    assert.equal(e.ingest({ text: 'どの家具が好き?', author: 'viewer' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal);
    await e.prepare(e.epoch, e.controller.signal);
    for (let i = 0; i < 40 && !e.prepared?.parts[2]?.audio; i++) await tick();
    const read = await play(e);
    assert.equal(read.role, 'comment'); assert.equal(read.reaction, 'listen'); assert.equal('intensity' in read, false); assert.equal('leadMs' in read, false); assert.equal('lipSync' in read, false);
    const h1 = await play(e), h2 = await play(e);
    assert.equal(h1.role, 'host'); assert.equal(h2.role, 'host'); assert.equal(h1.intensity, 'mid');
    assert.equal(narrator.length, 1); assert.equal(narrator[0].length, 2); assert.equal(narratorFinalized, 0);
    assert.equal(calls.synth.length, 2); assert.ok(calls.synth.every(a => a.length === 3 && a[2].text === a[0]));
    assert.equal(calls.synth[0][2].budgetMs, c.maxTurnAudioMs - 'いろいろ作業できるから。'.length * 100 - plannedSilenceMs(calls.synth[1][2]));
    assert.equal(calls.synth[1][2].budgetMs, c.maxTurnAudioMs - 200, 'the 900 ms narration is not part of the host budget');
    assert.equal(e.metrics.counters.comment_completed, 1);
});

// ---------------------------------------------------------------- integration
const sine = (sec, hz, rate = 24000, amp = .3) => Float32Array.from({ length: Math.round(sec * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const tone = (sec, hz, rate = 24000) => writeWav(sine(sec, hz, rate), rate);
const crossings = xs => { let n = 0, last = 0; for (const x of xs) { const s = Math.sign(x); if (s && last && s !== last) n++; if (s) last = s; } return n; };

test('integration: a real DirectedVoice in reaction direction publishes the gasp first and the finalized duration', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'jvs-voice-engine-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    addClip(dir, { cls: 'gasp', bytes: tone(.3, 300), attest: 'nonverbal' });
    const library = new ReactionAudioCache(dir); library.reload(); assert.deepEqual(library.status().errors, []);
    const c = setup(t, { MODE: 'live', LLM_MODEL: 'fixture', SHOW_PROFILE: 'talk', SPEECH_DIRECTION: 'reaction', REACTION_AUDIO: 'true' });
    const paths = [];
    const fetchFn = async u => {
        const url = new URL(u); paths.push(url.pathname);
        assert.equal(url.port, '50021', 'only the configured VOICEVOX engine is reached');
        if (url.pathname === '/audio_query') return response({ speedScale: 1, intonationScale: 1, volumeScale: 1 });
        if (url.pathname === '/synthesis') return new Response(tone(.2, 440));
        return new Response('missing', { status: 404 });
    };
    const l = ledger(), voice = new DirectedVoice(c, l, { fetchFn, library });
    assert.equal(voice.passThrough(), false); assert.deepEqual(voice.clipKinds(), ['gasp']);
    const e = new TalkEngine(c, { ledger: l, audit, voice,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ ...shockVerdict, provider: 'jev' }) },
        conversation: { generate: async () => 'えっ、ちょっと待って！' }, research: { search: async () => { throw new Error('no search'); } } });
    t.after(() => e.stop('test')); active(e);
    const p = await nextPart(e);
    assert.deepEqual(paths, ['/audio_query', '/synthesis']); assert.deepEqual(l.calls, { tts: 1 });
    assert.equal(p.kind, 'wav'); assert.equal(p.leadMs, 0); assert.equal(p.reaction, 'shock'); assert.equal(p.intensity, 'high');
    const bytes = e.audio.get(p.id), w = readWav(bytes);
    assert.ok(Math.abs(wavDuration(bytes) * 1000 - p.durationMs) <= 1, `${wavDuration(bytes) * 1000} vs ${p.durationMs}`);
    const clipEnd = Math.round(.3 * w.rate), head = w.samples.slice(Math.round(.02 * w.rate), Math.round(.27 * w.rate));
    assert.ok(head.some(x => Math.abs(x) > .01), 'the published WAV begins with sound');
    const zc = crossings(head), hz = zc / 2 / .25;
    assert.ok(hz > 270 && hz < 330, `the first quarter second is the 300 Hz gasp, not the 440 Hz speech (${hz} Hz)`);
    assert.ok(w.samples.slice(clipEnd + 20, clipEnd + Math.round(.06 * w.rate) - 20).every(x => x === 0), 'then the exact pre-gap');
    assert.equal(e.lastDelivery.clip, 'gasp'); assert.equal(e.lastDelivery.engine, 'voicevox'); assert.equal(e.metrics.counters.reaction_clip_used, 1);
    for (const k of ['stats', 'tiers', 'engine']) assert.ok(!keysDeep(e.pending).has(k), k);
    assert.equal(voice.status().clips.used, 1);
});
