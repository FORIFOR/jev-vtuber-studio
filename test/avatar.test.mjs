import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AvatarController, Affect, PARAMS, REACTIONS, JEV_REACTIONS, toVTS, VTS_CUSTOM, demoReaction, reactionFor } from '../public/avatar-rig.mjs';
import { Effects, Jev } from '../src/jev.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { VTubeStudio } from '../src/vts.mjs';
import { createApp } from '../src/server.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

const ROOT = new URL('../', import.meta.url);
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const run = (a, from, to, step = 16) => { const frames = []; for (let t = from; t <= to; t += step) frames.push(a.update(t)); return frames; };
const inRange = p => Object.entries(p).every(([k, v]) => Number.isFinite(v) && v >= PARAMS[k][0] && v <= PARAMS[k][1]);

test('Jev is offered only named presets; every preset is actable code-side', () => {
    for (const name of Object.keys(JEV_REACTIONS)) {
        const r = REACTIONS[name];
        assert.ok(r && !r.local, name);
        for (const id of [...Object.keys(r.face), ...Object.keys(r.reflex?.params || {}), ...Object.keys(r.motion(300))]) assert.ok(PARAMS[id], `${name}: ${id}`);
    }
    assert.equal(Object.hasOwn(JEV_REACTIONS, 'listen'), false);
    for (const r of Object.values(REACTIONS)) if (r.big) assert.ok(REACTIONS[r.fallback] && !REACTIONS[r.fallback].big);
});

test('idle avatar blinks, breathes and wanders without any event', () => {
    const a = new AvatarController({ random: seq(.1, .5, .9, .3), now: 0 });
    const frames = run(a, 0, 12000);
    assert.ok(frames.every(inRange));
    assert.ok(Math.min(...frames.map(p => p.ParamEyeLOpen)) < .2, 'eyes close in a blink');
    assert.ok(frames.at(-1).ParamEyeLOpen > .8 || frames.at(-2).ParamEyeLOpen > .8, 'eyes reopen');
    const breath = frames.map(p => p.ParamBreath);
    assert.ok(Math.max(...breath) - Math.min(...breath) > .5, 'breathing cycles');
    assert.ok(new Set(frames.map(p => Math.round(p.ParamEyeBallX * 20))).size > 2, 'gaze wanders');
    assert.equal(Math.max(...frames.map(p => p.ParamMouthOpenY)), 0, 'silent mouth stays closed');
});

test('shock plays reflex → sustained face → afterglow → idle, all within parameter ranges', () => {
    const a = new AvatarController({ random: () => .99, now: 0 });
    run(a, 0, 1000);
    const base = a.update(1016);
    assert.equal(a.react('shock', 1016), REACTIONS.shock.lead);
    const reflex = run(a, 1032, 1400);
    assert.ok(reflex.every(inRange));
    const peak = reflex.reduce((m, p) => p.ParamBodyAngleX < m.ParamBodyAngleX ? p : m);
    assert.ok(peak.ParamBodyAngleX < base.ParamBodyAngleX - 2, 'body recoils');
    assert.ok(reflex.at(-1).ParamBrowLY > .6, 'brows shoot up');
    assert.ok(reflex.some(p => p.ParamMouthOpenY > .1), 'mouth drops open before the voice');
    run(a, 1416, 3000);
    assert.equal(a.phase, 'speak');
    a.settle(3000);
    const after = run(a, 3016, 3000 + REACTIONS.shock.afterMs - 100);
    assert.ok(after.at(-1).ParamBrowLY > .5, 'face is held during the afterglow');
    assert.equal(a.phase, 'after');
    const back = run(a, 3000 + REACTIONS.shock.afterMs, 3000 + REACTIONS.shock.afterMs + 2500);
    assert.equal(a.phase, 'idle'); assert.equal(a.reaction, null);
    assert.ok(Math.abs(back.at(-1).ParamBrowLY) < .1, 'returns to idle');
});

test('lip sync follows the voice envelope and embarrassed shows blush and averted gaze', () => {
    const a = new AvatarController({ random: () => .99, now: 0 });
    a.react('embarrassed', 0);
    let p;
    for (let t = 0; t < 900; t += 16) { a.mouth(t % 200 < 100 ? .8 : 0); p = a.update(t); }
    assert.ok(p.ParamCheek > .8 && p.ParamEyeBallX < -.4);
    a.mouth(.9); for (let t = 900; t < 1000; t += 16) p = a.update(t);
    assert.ok(p.ParamMouthOpenY > .6);
    a.mouth(0); for (let t = 1000; t < 1200; t += 16) p = a.update(t);
    assert.ok(p.ParamMouthOpenY < .1);
});

test('reduced motion keeps expressions but shrinks body movement', () => {
    const full = new AvatarController({ random: () => .99 }), calm = new AvatarController({ random: () => .99, reducedMotion: true });
    full.react('shock', 0); calm.react('shock', 0);
    const f = run(full, 0, 400), c = run(calm, 0, 400);
    assert.ok(Math.min(...c.map(p => p.ParamBodyAngleX)) > Math.min(...f.map(p => p.ParamBodyAngleX)) / 2);
    assert.ok(c.at(-1).ParamBrowLY > .6);
});

test('big reactions are rate-limited in code; unknown and local presets are refused', () => {
    const e = new Effects();
    assert.equal(e.take({ effect: 'none', mood: 'warm', reaction: 'laugh' }, 10000).reaction, 'laugh');
    assert.equal(e.take({ effect: 'none', mood: 'warm', reaction: 'shock' }, 12000).reaction, 'surprised');
    assert.equal(e.take({ effect: 'none', mood: 'warm', reaction: 'shock' }, 17000).reaction, 'shock');
    assert.equal(e.reaction('listen'), 'neutral'); assert.equal(e.reaction('<script>'), 'neutral');
    assert.deepEqual(e.take({ effect: 'none', mood: 'warm' }, 30000), { effect: 'none', mood: 'warm' });
    assert.equal(reactionFor({ mood: 'curious' }), 'thinking');
});

test('affect nudges and decays toward baseline', () => {
    const f = new Affect();
    const hot = f.apply('laugh', 1000);
    assert.ok(hot.happy > .7 && hot.energy > .6);
    const later = f.snapshot(200000);
    assert.ok(Math.abs(later.happy - .55) < .02);
});

test('Jev speech asks for a reaction preset and demo mode uses a rule stand-in', async (t) => {
    const j = new Jev(setup(t), ledger(), audit);
    assert.equal((await j.speech('えっ、ちょっと待って！今の危ない！')).reaction, 'shock');
    assert.equal(demoReaction('なるほど、たしかにそうかも。'), 'nod');
    j.c.mode = 'live'; let asked;
    j.ask = async (s, q) => { asked = q; return { safe: { noul: .99 }, private: { noul: 0 }, injection: { noul: 0 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 }, reaction: { choice: 'embarrassed', confidence: .8 } }; };
    const r = await j.speech('そんなに褒められると照れちゃうな。');
    assert.equal(r.reaction, 'embarrassed');
    assert.deepEqual(Object.keys(asked.reaction.criteria), Object.keys(JEV_REACTIONS));
    j.ask = async () => ({ safe: { noul: .99 }, private: { noul: 0 }, injection: { noul: 0 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 }, reaction: { choice: 'laugh', confidence: .3 } });
    assert.equal((await j.speech('こんにちは。')).reaction, 'neutral', 'low confidence falls back to calm acting');
});

test('talk engine publishes narrator as listen and host with its reaction, affect and operator trace', async (t) => {
    const c = setup(t, { SHOW_PROFILE: 'talk', READ_COMMENTS: 'true' }), audio = () => ({ kind: 'wav', durationMs: 200, bytes: wav(.2) });
    const e = active(new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, readAllowed: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm', reaction: 'surprised' }) },
        conversation: { generate: async () => 'えっ、そのボスに勝てそうか聞かれると迷うな。' },
        voice: { synthesize: async () => audio() }, commentVoice: { synthesize: async () => audio() } }));
    e.director.opened = true; t.after(() => e.stop());
    const events = []; e.on('event', x => events.push(x));
    assert.equal(e.ingest({ text: 'そのボス勝てそう？', author: 'viewer' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal);
    assert.equal(e.operatorView().queue[0].state, 'selected');
    const step = async () => { for (let i = 0; i < 50 && !e.pending; i++) { e.nextTurnAt = 0; e.claimRenderer('test-renderer'); await e.speakStep(e.epoch, e.controller.signal); await new Promise(r => setImmediate(r)); } return e.pending; };
    const read = await step();
    assert.equal(read.role, 'comment'); assert.equal(read.reaction, 'listen');
    assert.equal(e.operatorView().queue[0].picked, true);
    e.acknowledge({ id: read.id, lease: e.renderer.lease, event: 'started' });
    const started = events.find(x => x.type === 'speech_started');
    assert.equal(started.data.reaction, 'listen'); assert.equal(started.data.comment, 'そのボス勝てそう?', 'NFKC-cleaned text');
    e.acknowledge({ id: read.id, lease: e.renderer.lease, event: 'ended' });
    const reply = await step();
    assert.equal(reply.role, 'host'); assert.equal(reply.reaction, 'surprised');
    e.acknowledge({ id: reply.id, lease: e.renderer.lease, event: 'started' });
    const view = e.operatorView();
    assert.equal(view.reaction.name, 'surprised'); assert.ok(view.affect.energy > .5);
    const kinds = view.events.map(x => x.kind);
    for (const k of ['comment', 'jev_chat', 'llm', 'jev_speech', 'publish', 'speech_start']) assert.ok(kinds.includes(k), k);
    assert.ok(view.performance.llm.last >= 0);
    // Operator-only details never ride on the viewer stream.
    assert.ok(!events.some(x => x.type === 'state' && JSON.stringify(x.data).includes('jev_chat')));
});

test('VTS frames map Cubism ids to VTS inputs and skip custom inputs VTS did not create', async (t) => {
    const params = new AvatarController({ random: () => .99 }).update(0);
    const mapped = Object.fromEntries(toVTS({ ...params, ParamMouthForm: 1, ParamBrowLY: -1 }).map(x => [x.id, x.value]));
    assert.equal(mapped.MouthSmile, 1); assert.equal(mapped.BrowLeftY, 0); assert.ok(mapped.EyeOpenLeft <= 1);
    const c = setup(t); c.vtsEnabled = true; const sent = [];
    class FakeWS extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(raw) { const m = JSON.parse(raw); sent.push(m); const reply = (messageType, data) => queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ requestID: m.requestID, messageType, data }) })));
            if (m.messageType === 'AuthenticationTokenRequest') reply('AuthenticationTokenResponse', { authenticationToken: 'tok' });
            else if (m.messageType === 'AuthenticationRequest') reply('AuthenticationResponse', { authenticated: true });
            else if (m.messageType === 'ParameterCreationRequest') reply(m.data.parameterName === 'JevCheek' ? 'APIError' : 'ParameterCreationResponse', {});
            else reply('InjectParameterDataResponse', {}); }
        close() { this.dispatchEvent(new Event('close')); }
    }
    const vts = new VTubeStudio(c, FakeWS); t.after(() => vts.close());
    await vts.connect();
    assert.equal(sent.filter(x => x.messageType === 'ParameterCreationRequest').length, VTS_CUSTOM.length);
    assert.equal(vts.frame(params), true);
    assert.equal(vts.frame(params), false, 'throttled');
    const ids = sent.at(-1).data.parameterValues.map(x => x.id);
    assert.ok(ids.includes('FaceAngleX') && ids.includes('MouthOpen') && ids.includes('JevBodyAngleX'));
    assert.ok(!ids.includes('JevCheek'), 'uncreated custom input is not sent');
});

test('avatar frame endpoint needs the renderer lease; monitor is admin-only', async (t) => {
    const c = setup(t); c.port = 0; const frames = [];
    const a = createApp(c, { vts: { ready: true, frame: p => { frames.push(p); return true; }, mouth() { }, close() { } } });
    await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const url = `http://127.0.0.1:${a.server.address().port}`;
    const req = (path, data, token) => fetch(url + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    assert.equal((await req('/api/renderer/avatar', { lease: 'nope', params: { ParamAngleX: 1 } }, c.viewToken)).status, 403);
    const { lease } = await (await req('/api/renderer/claim', { client: 'stage' }, c.viewToken)).json();
    const r = await (await req('/api/renderer/avatar', { lease, params: { ParamAngleX: 99, ParamMouthOpenY: .5, evil: 1, ParamEyeLOpen: 'x' } }, c.viewToken)).json();
    assert.equal(r.forward, true);
    assert.deepEqual(frames.at(-1), { ParamAngleX: 30, ParamMouthOpenY: .5 });
    assert.equal((await req('/api/monitor', null, c.viewToken)).status, 401);
    const m = await (await req('/api/monitor', null, c.adminToken)).json();
    for (const k of ['live', 'affect', 'queue', 'performance', 'events', 'avatar']) assert.ok(k in m, k);
});

test('viewer stage carries no operator information; Studio has the monitor', () => {
    const stage = readFileSync(new URL('public/stage.html', ROOT), 'utf8'), js = readFileSync(new URL('public/stage.mjs', ROOT), 'utf8');
    for (const id of ['programme-board', 'id="status"', 'id="mode"', 'show-title', 'AUTONOMOUS']) assert.ok(!stage.includes(id) && !js.includes(`'${id}'`), id);
    for (const id of ['id="picked"', 'id="caption"', 'id="voice-credit"', 'id="eye-l"', 'id="brow-r"', 'id="cheek-l"']) assert.ok(stage.includes(id), id);
    const studio = readFileSync(new URL('public/index.html', ROOT), 'utf8');
    for (const id of ['id="affect"', 'id="reaction"', 'id="comment-queue"', 'id="performance"', 'id="game-brain"', 'id="events"']) assert.ok(studio.includes(id), id);
});

test('instant wordless reflex: a Jev-accepted comment glances at once, a star cheers; rate-limited; never carries words', async (t) => {
    const { engine: mk, active: act } = await import('./helpers.mjs');
    const e = act(mk(setup(t))); t.after(() => e.stop());
    const events = []; e.on('event', x => events.push(x));
    assert.equal(e.ingest({ text: 'こんばんは、今日は何のゲーム？', author: 'viewer' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal);
    const first = events.find(x => x.type === 'reflex');
    assert.deepEqual(first.data, { reaction: 'happy', source: 'comment' }, 'the face reads the tone (a greeting) at once; no text, no audio');
    assert.ok(events.indexOf(first) < events.findIndex(x => x.type === 'speech') || !events.some(x => x.type === 'speech'), 'before any speech is prepared');
    assert.equal(e.reflex('excited', 'game'), false, 'rate-limited within 1.5 s');
    assert.equal(e.reflex('excited', 'game', Date.now() + 2000), true);
    assert.equal(e.reflex('shock', 'game', Date.now() + 9000), false, 'only calm, wordless presets');
    e.lastReflexAt = 0; e.game.player = { x: 7, y: 3 }; e.game.target = { x: 7, y: 2 };
    e.jev.game = undefined; await e.gameStep(e.epoch, e.controller.signal);
    assert.equal(events.at(-2).type, 'reflex'); assert.deepEqual(events.at(-2).data, { reaction: 'excited', source: 'game' });
});

test('comment reflex reads tone locally: worry, praise, greeting, question, otherwise listen', async () => {
    const { commentReflex } = await import('../public/avatar-rig.mjs');
    assert.equal(commentReflex('最近ちょっと眠れなくて…'), 'troubled');
    assert.equal(commentReflex('ノアちゃんの声かわいい'), 'embarrassed');
    assert.equal(commentReflex('今の動きうまい！'), 'surprised');
    assert.equal(commentReflex('初見です！'), 'happy');
    assert.equal(commentReflex('好きな食べ物ってある？'), 'thinking');
    assert.equal(commentReflex('雨ですね'), 'listen');
});
