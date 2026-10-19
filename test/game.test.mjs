import test from 'node:test';
import assert from 'node:assert/strict';
import { StarGarden } from '../src/game.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit, active, wav } from './helpers.mjs';

test('StarGarden puzzle engine: step, distance, pause, resume and situation summary', () => {
    const g = new StarGarden();
    assert.equal(g.score, 0);
    assert.equal(g.paused, false);
    const initialDist = g.distance();
    assert.ok(initialDist > 0);

    const stepResult = g.step();
    assert.equal(stepResult.acted, true);
    assert.ok(stepResult.observation.legal.length > 0);
    assert.ok(stepResult.observation.summary.includes('星まで'));

    g.pause();
    assert.equal(g.paused, true);
    const pausedStep = g.step();
    assert.equal(pausedStep.acted, false);

    g.resume();
    assert.equal(g.paused, false);
});

test('TalkEngine consultation programme: game integration, context injection, and pause on comment', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'consultation', READ_COMMENTS: 'true' });
    const contexts = [];
    const e = new TalkEngine(c, {
        ledger: ledger(),
        audit,
        jev: {
            chat: async () => ({ accept: true, action: 'reply', readAllowed: true }),
            speech: async () => ({ accept: true, effect: 'none', mood: 'warm' })
        },
        conversation: {
            generate: async ctx => {
                contexts.push(structuredClone(ctx));
                return '今夜は星を集めながら、小さな相談にお答えします。';
            }
        },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        commentVoice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        research: { search: async () => { throw new Error('no search'); } }
    });
    t.after(() => e.stop('test'));
    active(e);

    const st = e.status();
    assert.ok(st.game, 'consultation programme provides game status');
    assert.equal(st.game.score, 0);

    // Opening preparation
    await e.prepare(e.epoch, e.controller.signal);
    assert.ok(e.prepared);
    assert.equal(e.prepared.kind, 'opening');

    // Commit opening
    e.claimRenderer('test-renderer');
    await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending);
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'started' });
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'ended' });

    // Now in autonomous mode: prepare next turn
    e.nextTurnAt = 0;
    await e.prepare(e.epoch, e.controller.signal);
    const lastCtx = contexts[contexts.length - 1];
    assert.ok(lastCtx.game, 'autonomous context receives game observation');
    assert.ok(lastCtx.gameSummary, 'autonomous context receives gameSummary string');

    // Ingest a comment
    const comment = { id: 'c1', text: '夜に考え事をして眠れません', author: 'viewer', readAllowed: true };
    e.ingest(comment);
    await e.classify(e.epoch, e.controller.signal);

    // Prepare read reply -> game must pause
    e.prepared = null;
    e.nextTurnAt = 0;
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.game.paused, true, 'game pauses when comment reply is prepared');

    // Deliver comment read and answer
    e.pending = null;
    await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending);
    assert.equal(e.pending.role, 'comment');
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'started' });
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'ended' });

    // Avatar speaks answer
    e.nextTurnAt = 0;
    await e.speakStep(e.epoch, e.controller.signal);
    assert.ok(e.pending);
    assert.equal(e.pending.role, 'host');
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'started' });
    e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'ended' });

    // After comment answer completes, game resumes
    assert.equal(e.game.paused, false, 'game resumes after comment reply finishes');
});

test('idle puzzle: rule-played by default even in live mode (zero Jev calls); GAME_CONTROLLER=jev opts into Jev moves', async t => {
    const { engine: mk, active } = await import('./helpers.mjs');
    for (const [controller, expectCalls] of [['rule', 0], ['jev', 1]]) {
        const c = setup(t, { SHOW_PROFILE: 'playground', GAME_CONTROLLER: controller }); c.mode = 'live';
        let calls = 0; const e = active(mk(c)); t.after(() => e.stop());
        e.jev.game = async obs => { calls++; return obs.legal[0]; };
        await e.gameStep(e.epoch, e.controller.signal);
        assert.equal(calls, expectCalls, controller); assert.equal(e.lastMove?.controller, controller);
    }
    assert.throws(() => setup(t, { GAME_CONTROLLER: 'llm' }), /GAME_CONTROLLER/);
});

test('an opening is exempt from novel/progress but never from the safety questions', async t => {
    const { Jev } = await import('../src/jev.mjs'), { ledger, audit } = await import('./helpers.mjs');
    const j = new Jev(setup(t), ledger(), audit); j.c.mode = 'live';
    const ans = (over = {}) => async () => ({ safe: { noul: .99 }, private: { noul: 0 }, injection: { noul: 0 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 }, novel: { noul: .1 }, progress: { noul: .1 }, ...over });
    j.ask = ans(); assert.equal((await j.speech('ノアです。夜ふかし相談室、開店です。', undefined, [], { kind: 'opening' })).accept, true);
    j.ask = ans(); assert.equal((await j.speech('星を集めます。', undefined, [], { kind: 'autonomous' })).reason, 'no_progress');
    j.ask = ans({ safe: { noul: .5 } }); assert.equal((await j.speech('ノアです。', undefined, [], { kind: 'opening' })).accept, false);
});

test('an operator line is judged for safety only, like an opening: novelty/progress do not apply, safety and privacy always do', async t => {
    const { Jev } = await import('../src/jev.mjs'), { ledger, audit } = await import('./helpers.mjs');
    const j = new Jev(setup(t), ledger(), audit); j.c.mode = 'live';
    const ans = (over = {}) => async () => ({ safe: { noul: .99 }, private: { noul: 0 }, injection: { noul: 0 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 }, novel: { noul: .1 }, progress: { noul: .1 }, honest: { noul: .99 }, ...over });
    const ctx = { kind: 'autonomous', utterance: 'operator' };
    j.ask = ans(); assert.equal((await j.speech('見に来てくれてありがとう！', undefined, [], ctx)).accept, true);
    j.ask = ans({ safe: { noul: .9 } }); assert.equal((await j.speech('見に来てくれてありがとう！', undefined, [], ctx)).reason, 'unsafe_or_uncertain');
    j.ask = ans({ private: { noul: .5 } }); assert.equal((await j.speech('見に来てくれてありがとう！', undefined, [], ctx)).accept, false);
    assert.equal((await j.speech('連絡先は090-1234-5678です', undefined, [], ctx)).accept, false, 'the local PII check comes first');
});

test('a fixed answer to a social comment is judged on responding to it (no novelty/progress); safety always applies', async t => {
    const { Jev } = await import('../src/jev.mjs'), { ledger, audit } = await import('./helpers.mjs');
    const j = new Jev(setup(t), ledger(), audit); j.c.mode = 'live';
    let asked = null;
    const ans = (over = {}) => async (state, q) => { asked = q; return { safe: { noul: .99 }, private: { noul: 0 }, injection: { noul: 0 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 }, honest: { noul: .99 }, acknowledges: { noul: .9 }, novel: { noul: .1 }, progress: { noul: .1 }, ...over }; };
    const ctx = { kind: 'reply', utterance: 'comment_ack', comment: 'こんばんは' };
    j.ask = ans(); assert.equal((await j.speech('こんばんは！来てくれてありがとう、ゆっくりしていってね。', undefined, [], ctx)).accept, true);
    assert.ok(asked.acknowledges && !asked.novel && !asked.progress, 'the right question, not the editorial ones');
    j.ask = ans({ acknowledges: { noul: .5 } }); assert.equal((await j.speech('こんばんは！', undefined, [], ctx)).reason, 'no_progress');
    j.ask = ans({ safe: { noul: .9 } }); assert.equal((await j.speech('こんばんは！', undefined, [], ctx)).reason, 'unsafe_or_uncertain');
    j.ask = ans(); assert.equal((await j.speech('こんばんは！', undefined, [], { kind: 'reply', utterance: 'comment_ack' })).reason, 'no_progress', 'without a comment it is not an acknowledgement');
});

test('speech injection threshold is < 0.2 (calibrated on live Jev: benign invitations score 0.05-0.16); comment gate unchanged', async t => {
    const { Jev } = await import('../src/jev.mjs'), { ledger, audit } = await import('./helpers.mjs');
    const j = new Jev(setup(t), ledger(), audit); j.c.mode = 'live';
    const ans = inj => async () => ({ safe: { noul: .97 }, private: { noul: .02 }, injection: { noul: inj }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 } });
    j.ask = ans(.16); assert.equal((await j.speech('些細な愚痴でも大歓迎です。')).accept, true);
    j.ask = ans(.2); assert.equal((await j.speech('些細な愚痴でも大歓迎です。')).accept, false);
});

function gameRig(t, { speech } = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'consultation', READ_COMMENTS: 'false' });
    const judged = [], generated = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, s, ev, ctx) => { judged.push({ text, ctx }); return speech ? speech(text, ctx) : { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { generated.push(ctx); return 'あ、上ふさがってる。'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        research: { search: async () => { throw new Error('no search'); } } });
    t.after(() => e.stop('test')); active(e); e.director.opened = true;
    return { e, judged, generated };
}

test('"what game is this?" is answered from the game adapter (no model guess), and the answer is still gated', async t => {
    const { e, judged, generated } = gameRig(t);
    assert.equal(e.ingest({ text: '初見です！何のゲームしてるの？', author: 'viewer' }).accepted, true);
    await e.classify(e.epoch, e.controller.signal); await e.prepare(e.epoch, e.controller.signal);
    assert.equal(generated.length, 0, 'no LLM call for a known fact');
    assert.equal(judged.length, 1); assert.equal(judged[0].text, '今は「星集めパズル」をやってるよ。ブロックを避けて星を集める一人用のパズルなんだ。');
    assert.equal(judged[0].ctx.utterance, 'game_fact', 'a factual game answer is judged on fit, not novelty'); assert.equal(judged[0].ctx.observation.game, '星集めパズル');
    assert.ok(e.prepared);
});

test('a star is reacted to once as a game_reaction (not a beat); game commentary is judged on fit, not novelty', async t => {
    const { e, judged } = gameRig(t);
    const beat0 = e.director.beat;
    e.game.score = 1; e.game.justGotStar = true;
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judged.at(-1).ctx.utterance, 'game_reaction'); assert.equal(judged.at(-1).ctx.observation.eventId, 'star-1');
    assert.equal(judged.at(-1).text, 'やった、星ゲット！', 'a fixed short reaction, still gated');
    const turn = e.prepared; assert.equal(turn.kind, 'game_reaction');
    e.prepared = null; e.currentTurn = turn; e.claimRenderer('r');
    for (const p of turn.parts) { e.pending = null; turn.published = turn.parts.indexOf(p); await e.speakStep(e.epoch, e.controller.signal); e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'started' }); e.acknowledge({ id: e.pending.id, lease: e.renderer.lease, event: 'ended' }); }
    assert.equal(e.director.beat, beat0, 'a reaction does not consume a programme beat');
    e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal);
    assert.notEqual(judged.at(-1).ctx.utterance, 'game_reaction', 'the same star is never reacted to twice');
});

test('Jev asks fits/apt (not novel/progress) for game lines; safety still applies', async t => {
    const { Jev } = await import('../src/jev.mjs');
    const j = new Jev(setup(t), ledger(), audit); j.c.mode = 'live'; let asked;
    const base = { safe: { noul: .97 }, private: { noul: .02 }, injection: { noul: .05 }, effect: { choice: 'none', confidence: 1 }, warranted: { noul: 0 }, mood: { choice: 'warm', confidence: 1 } };
    const ctx = { kind: 'autonomous', utterance: 'game_reaction', observation: { game: '星集めパズル', event: '星をひとつ取った' }, recentSpeech: [] };
    j.ask = async (s, q) => { asked = q; return { ...base, fits: { noul: .9 }, apt: { noul: .9 } }; };
    assert.equal((await j.speech('やった、星取れた！', undefined, [], ctx)).accept, true);
    assert.ok(asked.fits && asked.apt && !asked.novel && !asked.progress);
    j.ask = async () => ({ ...base, fits: { noul: .4 }, apt: { noul: .9 } });
    assert.equal((await j.speech('ボスを倒した！', undefined, [], ctx)).reason, 'no_progress', 'a line that does not fit the observation is refused');
    j.ask = async () => ({ ...base, safe: { noul: .5 }, fits: { noul: .9 }, apt: { noul: .9 } });
    assert.equal((await j.speech('やった！', undefined, [], ctx)).accept, false);
    j.ask = async (s, q) => { asked = q; return { ...base, novel: { noul: .9 }, progress: { noul: .9 } }; };
    await j.speech('話そう。', undefined, [], { kind: 'autonomous', utterance: 'monologue', recentSpeech: [] });
    assert.ok(asked.novel && asked.progress && !asked.fits, 'monologue keeps the editorial questions');
    j.ask = async (st, q) => { asked = q; return { ...base, fits: { noul: .85 }, answers: { noul: .9 } }; };
    const fact = { kind: 'reply', utterance: 'game_fact', observation: { game: '星集めパズル' }, comment: '何のゲーム?', recentSpeech: [] };
    assert.equal((await j.speech('今は「星集めパズル」をやってるよ。', undefined, [], fact)).accept, true);
    assert.ok(asked.fits && asked.answers && !asked.apt, 'a factual answer is judged on answering, not on being a reaction');
    j.ask = async () => ({ ...base, fits: { noul: .03 }, answers: { noul: .03 } });
    assert.equal((await j.speech('今は「スーパーマリオ」をやってるよ。', undefined, [], fact)).accept, false, 'a wrong game name is refused');
    // A round announcement is a game_fact with no comment: there is nothing to "answer", so it is judged fits + apt.
    j.ask = async (st, q) => { asked = q; return { ...base, fits: { noul: .83 }, apt: { noul: .8 } }; };
    const announce = { kind: 'autonomous', utterance: 'game_fact', observation: { game: 'NOA BLOCKS', phase: 'intro', round: 1 }, comment: null, recentSpeech: [] };
    assert.equal((await j.speech('1回戦、標準でいくよ。まずは記録を作ろう！', undefined, [], announce)).accept, true);
    assert.ok(asked.fits && asked.apt && !asked.answers, 'no comment, no "answers the comment" question');
    j.ask = async () => ({ ...base, fits: { noul: .3 }, apt: { noul: .9 } });
    assert.equal((await j.speech('1回戦、速めでいくよ。', undefined, [], announce)).accept, false, 'an announcement that does not fit the observation is still refused');
});

test('opening small talk is judged as casual conversation while safety and honesty remain mandatory', async t => {
    const { Jev } = await import('../src/jev.mjs');
    const j = new Jev(setup(t, {SHOW_PROFILE:'talk'}), ledger(), audit); j.c.mode='live'; let questions;
    const base={safe:{noul:.99},private:{noul:0},injection:{noul:0},honest:{noul:.99},novel:{noul:.9},progress:{noul:.9},effect:{choice:'none',confidence:1},warranted:{noul:0},mood:{choice:'warm',confidence:1}};
    j.ask=async(s,q)=>{questions=q;return base;};
    const ctx={kind:'autonomous',utterance:'monologue',lobby:true,goal:'好きな色',recentSpeech:[]};
    assert.equal((await j.speech('藍色のカップが好き。',undefined,[],ctx)).accept,true);
    assert.match(questions.progress.instructions,/casual conversation/);
    for(const field of ['safe','honest']) {j.ask=async()=>({...base,[field]:{noul:.1}});assert.equal((await j.speech('テスト',undefined,[],ctx)).accept,false);}
});

test('the local judge has no paid session ceiling: a stale budget setting never blocks or closes, and a judge failure throws',async t=>{
    // The Jev session budget (JEV_BUDGET + onCreditEnd graceful close) was removed with the remote API (2026-10-09).
    const {Jev}=await import('../src/jev.mjs');const c=setup(t,{LLM_MODEL:'fixture',LLM_BASE_URL:'http://127.0.0.1:9/v1'});c.mode='live';c.jevSessionMaxUsd=.001;
    let calls=0,closed=0;const j=new Jev(c,ledger(),audit,async()=>{calls++;throw Error('judge offline');});j.onCreditEnd=()=>closed++;
    await assert.rejects(j.ask({},{ok:{type:'noul',instructions:'ok?'}}),/judge offline/);assert.equal(calls,1);assert.equal(closed,0);
});
