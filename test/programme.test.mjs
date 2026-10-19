import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Director, sentences } from '../src/director.mjs';
import { Conversation } from '../src/providers.mjs';
import { Jev } from '../src/jev.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { repetitionReason, similarity } from '../src/content-quality.mjs';
import { saveSettings, publicSettings } from '../src/settings.mjs';
import { setup, ledger, audit, active, response, wav, defer } from './helpers.mjs';
const programmes = JSON.parse(readFileSync(new URL('../config/programmes.json', import.meta.url)));
const fixtureCards = [{ id: 'a', title: '検討', angles: ['first', 'second', 'third'], demo: ['fixture'] }];
const approved = { accept: true, effect: 'none', mood: 'warm' };
function fixture(t, overrides = {}, env = {}) {
    const c = setup(t, { SHOW_PROFILE: 'talk', ...env });
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async () => approved },
        conversation: new Conversation(c, ledger()), voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) },
        research: { search: async () => { throw new Error('no search'); } }, ...overrides });
    t.after(() => e.stop('test')); return active(e);
}
async function nextPart(e) {
    for (let n = 0; n < 30 && e.running && !e.pending; n++) {
        e.nextTurnAt = 0; e.claimRenderer('test-renderer');
        await e.speakStep(e.epoch, e.controller.signal);
        if (!e.pending && e.preparationTask) await e.preparationTask;
        await new Promise(r => setImmediate(r));
    }
    assert.ok(e.pending, 'next approved part');
    return e.pending;
}
function ack(e, event = 'ended') {
    const p = e.pending; assert.ok(p);
    if (!p.started) assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event: 'started' }), true);
    if (event === 'ended') assert.equal(e.acknowledge({ id: p.id, lease: e.renderer.lease, event }), true);
}
test('projected beat and angle advance together across the third beat (rc4 regression)', () => {
    const d = new Director(fixtureCards); d.opened = true; d.beat = 2;
    const ctx = d.context(null, { kind: 'autonomous', revision: 0, serial: 1 });
    assert.equal(ctx.topicBeat, 3); assert.equal(ctx.angle, 'second');
    assert.equal(d.beat, 2); assert.equal(d.recentSpeeches.length, 0);
});
test('projected opening never mutates heard history and is committed only once', () => {
    const d = new Director(fixtureCards), turn = { kind: 'opening', revision: 0, serial: 7, text: 'お題に入ります。' };
    assert.equal(d.context(null, turn).kind, 'autonomous'); assert.equal(d.opened, false);
    assert.equal(d.commit(turn), true); assert.equal(d.commit(turn), false);
    assert.equal(d.opened, true); assert.equal(d.committedTurns, 1); assert.equal(d.recentSpeeches.length, 1);
});
test('committed or prior-topic speculative parents are not projected twice', () => {
    const d = new Director(fixtureCards); d.opened = true;
    const turn = { kind: 'autonomous', revision: 0, serial: 1, text: '具体例。' }; d.commit(turn);
    assert.equal(d.context(null, turn).topicBeat, 1);
    assert.equal(d.context(null, { kind: 'autonomous', revision: -1 }).topicBeat, 1);
});
test('all editorial beats have distinct tasks, original bounded demo text and finite structure', () => {
    assert.deepEqual(programmes.map(p => p.id), ['room', 'holiday', 'robot', 'consultation', 'noa-blocks', 'noa-vampire', 'noa-smash']);
    for (const p of programmes.filter(p => p.gameMode !== 'blocks' && !p.game)) {
        assert.equal(p.cards.length, 3);
        const beats = p.cards.flatMap(c => c.beats);
        assert.equal(beats.length, 27); assert.equal(new Set(beats.map(b => b.task)).size, 27);
        for (const b of beats) { assert.ok(sentences(b.demo).length <= 2); assert.ok(b.demo.length <= 180); assert.ok(b.id && b.label && b.task); }
    }
});
test('NOA BLOCKS programme: one card of distinct bounded beats; the round director, not the beat list, sets the length', () => {
    const p = programmes.find(x => x.id === 'noa-blocks'), beats = p.cards.flatMap(c => c.beats);
    assert.equal(p.gameMode, 'blocks'); assert.equal(p.show.roundSeconds, 180); assert.ok(p.show.maxRounds === 'auto' || p.show.maxRounds >= 1);
    assert.ok(beats.length >= 4); assert.equal(new Set(beats.map(b => b.task)).size, beats.length);
    for (const b of beats) { assert.ok(sentences(b.demo).length <= 2); assert.ok(b.demo.length <= 180); assert.ok(b.id && b.label && b.task); }
});
test('Vampire Survivors programme: one card of distinct bounded beats; the runs, not the beat list, carry the show', () => {
    const p = programmes.find(x => x.id === 'noa-vampire'), beats = p.cards.flatMap(c => c.beats);
    assert.equal(p.game, 'vampire-survivors'); assert.ok(p.openingLine && p.closingLine);
    assert.ok(beats.length >= 4); assert.equal(new Set(beats.map(b => b.task)).size, beats.length); assert.ok(beats.some(b => b.game === true));
    for (const b of beats) { assert.ok(sentences(b.demo).length <= 2); assert.ok(b.demo.length <= 180); assert.ok(b.id && b.label && b.task); assert.ok(!b.invite); }
});
for (const id of ['room', 'holiday', 'robot', 'consultation']) test(`finite ${id} programme: one intro, 27 committed distinct steps, one close under prefetch`, async t => {
    const contexts = [], c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: id }), conv = new Conversation(c, ledger());
    const e = fixture(t, { conversation: { generate: async ctx => { contexts.push(structuredClone(ctx)); return conv.generate(ctx); } } }, { SHOW_PROGRAMME: id });
    e.startedAt = Date.now(); let parts = 0;
    while (e.running && parts < 100) {
        await nextPart(e); ack(e, 'started');
        await e.speakStep(e.epoch, e.controller.signal); // real speculative branch
        await Promise.resolve(); ack(e); parts++;
        if (e.preparationTask) await e.preparationTask;
    }
    assert.equal(e.running, false); assert.equal(e.director.closed, true); assert.equal(e.director.exhausted, true);
    assert.equal(e.markers.filter(m => m.kind === 'opening').length, 1);
    assert.equal(e.markers.filter(m => m.kind === 'closing').length, 1);
    const steps = e.markers.filter(m => m.kind === 'autonomous'); assert.equal(steps.length, 27);
    assert.equal(new Set(steps.map(m => `${m.topicId}/${m.beatId}`)).size, 27);
    assert.equal(contexts.filter(x => x.kind === 'opening').length, 1);
    assert.equal(e.director.committedTurns, 29);
});
test('eight active prefetched turns do not repeat opening; progression is visible only on ACK', async t => {
    const e = fixture(t), kinds = [];
    while (e.director.committedTurns < 8) {
        await nextPart(e); const before = e.director.committedTurns;
        if (e.currentTurn.published === 1) kinds.push(e.currentTurn.kind);
        ack(e, 'started'); await e.speakStep(e.epoch, e.controller.signal);
        assert.equal(e.director.committedTurns, before);
        ack(e); if (e.preparationTask) await e.preparationTask;
    }
    assert.deepEqual(kinds, ['opening', ...Array(7).fill('autonomous')]); assert.equal(e.director.beat, 7);
});
test('stale projected opening is never sent after another opening committed', async t => {
    const e = fixture(t); await e.prepare(e.epoch, e.controller.signal); assert.equal(e.prepared.kind, 'opening');
    e.director.commit({ kind: 'opening', text: 'すでに導入済み。', serial: -99 });
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(e.pending, null); assert.equal(e.prepared, null);
});
test('stale same-topic projected beat is rejected before publication', async t => {
    const e = fixture(t); e.director.opened = true; await e.prepare(e.epoch, e.controller.signal);
    e.director.commit({ kind: 'autonomous', revision: 0, text: '別の完了。', serial: -3 });
    await e.speakStep(e.epoch, e.controller.signal); assert.equal(e.pending, null); assert.equal(e.prepared, null);
});
test('boundary does not speculate the completed round or next round before ACK', t => {
    const e = fixture(t); e.director.opened = true; e.director.beat = 8;
    e.currentTurn = { kind: 'autonomous', revision: 0 };
    e.startPrefetch(e.epoch, e.controller.signal); assert.equal(e.preparing, null); assert.equal(e.preparationTask, null);
    e.currentTurn = null;
});
test('viewer reply keeps programme beat and marks actual reply completion', () => {
    const d = new Director(programmes[0].cards, { finite: true }); d.opened = true; d.beat = 3;
    const ctx = d.context({ text: '収納がいい', kind: 'reply' }); assert.equal(ctx.kind, 'reply');
    d.commit({ ...ctx, serial: 1, text: '収納の使い方を考えてみよう。' });
    assert.equal(d.beat, 3); assert.equal(d.dialogue.length, 1); assert.equal(d.committedTurns, 1);
});
for (const provider of ['ollama', 'compatible', 'gemini']) test(`live ${provider} request excludes demo examples but retains current task`, async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); Object.assign(c, { mode: 'live', llmProvider: provider, llmModel: 'fixture', geminiModel: 'fixture', geminiKey: 'fixture' });
    let sent; const conv = new Conversation(c, ledger(), async (_u, options) => {
        sent = options.body;
        return response(provider === 'gemini' ? { candidates: [{ content: { parts: [{ text: '服の置き場所を考えよう。' }] } }] } : provider === 'ollama' ? { message: { content: '服の置き場所を考えよう。' } } : { choices: [{ message: { content: '服の置き場所を考えよう。' } }] });
    });
    await conv.generate({ kind: 'autonomous', goal: '収納を比較する', demo: ['SECRET_DEMO_SENTINEL'] });
    assert.ok(!sent.includes('SECRET_DEMO_SENTINEL')); assert.match(sent, /収納を比較する/);
});
test('normalization detects punctuation/full-width restatements without labelling a new insight duplicate', () => {
    const old = '机・椅子・ベッドで完璧な部屋が完成しました！';
    assert.equal(similarity(old, '机、椅子、ベッドで完璧な部屋が完成しました。'), 1);
    assert.equal(repetitionReason(old, [old]), 'near_duplicate');
    assert.equal(repetitionReason('でも服を床に置くと歩けなくなりそう。椅子を収納箱に変えたらどうかな。', [old]), null);
    assert.equal(repetitionReason('今日のお題は家具３つ！', [], 'autonomous'), 'intro_repeated');
    assert.equal(repetitionReason(old, [old], 'closing'), null);
});
test('local repetition causes only one repair and no rejected example is fed back to the model', async t => {
    const contexts = [], prior = '机と椅子とベッドで、完璧な部屋が完成しました。';
    const e = fixture(t, { conversation: { generate: async ctx => { contexts.push(ctx); return contexts.length === 1 ? prior : '服の置き場所がないね。収納付きベッドなら歩く場所も残せそう。'; } } });
    e.c.mode = 'live'; e.director.opened = true; e.director.recentSpeeches = [prior];
    await e.prepare(e.epoch, e.controller.signal);
    assert.ok(e.prepared); assert.equal(contexts.length, 2); assert.equal(contexts[1].repair.reason, 'near_duplicate');
    assert.ok(!JSON.stringify(contexts[1].repair).includes(prior)); assert.equal(e.metrics.counters.content_repair_attempt, 1);
});
test('two repeated generations stop the show instead of publishing a loop', async t => {
    let generations = 0, syntheses = 0;
    const e = fixture(t, { conversation: { generate: async () => { generations++; return '今日のお題は家具三つです！'; } }, voice: { synthesize: async () => { syntheses++; return {}; } } });
    e.c.mode = 'live'; e.director.opened = true;
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(generations, 2); assert.equal(syntheses, 0); assert.equal(e.running, false); assert.equal(e.pending, null); assert.equal(e.metrics.counters.content_stall_stops, 1);
});
test('semantic no_progress can reject a lexically different paraphrase and perform one repair', async t => {
    let judgments = 0, generations = 0;
    const e = fixture(t, { conversation: { generate: async () => ++generations === 1 ? '三種の神器があれば最高の空間になるね。' : '眠る場所の下に服をしまえば、部屋の通り道が残せるね。' },
        jev: { speech: async (_text, _signal, _evidence, ctx) => { assert.ok(ctx.goal && ctx.beatId); judgments++; return judgments === 1 ? { accept: false, reason: 'no_progress' } : approved; } } });
    e.c.mode = 'live'; e.director.opened = true; await e.prepare(e.epoch, e.controller.signal);
    assert.equal(judgments, 2); assert.equal(generations, 2); assert.ok(e.prepared);
});
test('safety refusal does not receive a content-style repair', async t => {
    let n = 0; const e = fixture(t, { conversation: { generate: async () => { n++; return 'これは検査対象の文です。'; } }, jev: { speech: async () => ({ accept: false, reason: 'unsafe_or_uncertain' }) } });
    e.c.mode = 'live'; e.director.opened = true; await e.prepare(e.epoch, e.controller.signal);
    assert.equal(n, 1); assert.equal(e.prepared, null); assert.equal(e.metrics.counters.content_repair_attempt, undefined);
    // A refusal is a content outcome: the beat is skipped (nothing airs), it is not a provider failure.
    assert.equal(e.generationFailures, 0); assert.equal(e.metrics.counters.content_stall_skips, 1); assert.equal(e.running, true);
});
test('Jev checks goal and novelty in the same output request', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; const jev = new Jev(c, ledger()); let calls = 0;
    jev.ask = async (state, q) => {
        calls++; assert.equal(state.programmeContext.goal, '収納を検討'); assert.ok(q.novel && q.progress); assert.equal(q.read_safe, undefined);
        return { safe: { noul: .99 }, private: { noul: .01 }, injection: { noul: .01 }, honest: { noul: .99 }, novel: { noul: .9 }, progress: { noul: .1 },
            effect: { choice: 'none', confidence: .9 }, warranted: { noul: .1 }, mood: { choice: 'warm', confidence: .9 } };
    };
    const r = await jev.speech('完成したね。', undefined, [], { goal: '収納を検討' });
    assert.equal(calls, 1); assert.equal(r.accept, false); assert.equal(r.reason, 'no_progress');
});
test('stop during content repair cannot publish or commit a delayed response', async t => {
    const d = defer(); let n = 0;
    const e = fixture(t, { conversation: { generate: async () => ++n === 1 ? '今日のお題は家具三つ！' : d.promise } });
    e.c.mode = 'live'; e.director.opened = true; const task = e.prepare(e.epoch, e.controller.signal);
    while (n < 2) await new Promise(r => setImmediate(r));
    e.stop('operator'); d.resolve('収納付きの椅子なら服も置けそう。'); await task;
    assert.equal(e.pending, null); assert.equal(e.prepared, null); assert.equal(e.director.committedTurns, 0);
});
test('programme changes load new cards at next session; custom persona remains intact', t => {
    const e = fixture(t); e.stop('test');
    saveSettings(e.c, { values: { SHOW_PROGRAMME: 'robot', CHARACTER_PERSONA: '私の設定\n保持する' } });
    const s = publicSettings(e.c); assert.equal(s.programmes.length, 7); assert.equal(s.values.SHOW_PROGRAMME, 'robot');
    e.start(); assert.equal(e.director.programme.id, 'robot'); assert.equal(e.c.character.persona, '私の設定\n保持する'); e.stop('test');
    assert.throws(() => saveSettings(e.c, { values: { SHOW_PROGRAMME: 'unknown' } }));
});
test('programme marker contains only completion metadata, not comment text or transcript', async t => {
    const e = fixture(t); e.startedAt = Date.now();
    await nextPart(e); const first = e.pending.text; assert.equal(e.markers.length, 0); ack(e, 'started'); assert.equal(e.markers.length, 0); ack(e);
    if (!e.markers.length) { await nextPart(e); ack(e); }
    assert.equal(e.markers.length, 1); assert.equal(e.markers[0].basis, 'local_playback_end_ack');
    assert.ok(!JSON.stringify(e.markers).includes(first)); assert.equal(e.markers[0].turn, 1);
});
test('brief command produces three distinct local programme plans without credentials', () => {
    for (const id of ['room', 'holiday', 'robot', 'consultation']) {
        const r = spawnSync(process.execPath, ['scripts/episode-brief.mjs', id], { encoding: 'utf8' });
        assert.equal(r.status, 0); const brief = JSON.parse(r.stdout);
        assert.equal(brief.programmeId, id); assert.equal(brief.rounds.length, 3); assert.ok(brief.thumbnailText);
    }
    assert.equal(spawnSync(process.execPath, ['scripts/episode-brief.mjs', 'wrong']).status, 1);
});
test('appropriate direct reply is not rejected by an autonomous intro-only heuristic', () => {
    assert.equal(repetitionReason('今日のお題は、家具三つで暮らせるかです。', [], 'reply'), null);
});
test('private programme report exposes completion metadata only, never the transcript or secrets', async t => {
    const { createApp } = await import('../src/server.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.port = 0;
    const a = createApp(c); await new Promise(r => a.server.listen(0, '127.0.0.1', r)); t.after(() => a.close());
    const base = `http://127.0.0.1:${a.server.address().port}`;
    assert.equal((await fetch(base + '/api/programme/report')).status, 401);
    assert.equal((await fetch(base + '/api/programme/report', { headers: { Authorization: `Bearer ${c.viewToken}` } })).status, 401);
    const r = await fetch(base + '/api/programme/report', { headers: { Authorization: `Bearer ${c.adminToken}` } });
    assert.equal(r.status, 200); const x = await r.json(); assert.equal(x.transcriptIncluded, false); assert.equal(x.mode, 'demo');
    assert.ok(!JSON.stringify(x).includes(c.adminToken)); assert.ok(!JSON.stringify(x).includes(c.dataDir));
});
test('a gate no_progress stall skips the beat and keeps the show running; three in a row stop it; nothing airs', async t => {
    let n = 0, syntheses = 0;
    const e = fixture(t, { conversation: { generate: async () => `別の具体例その${++n}です。` }, jev: { speech: async () => ({ accept: false, reason: 'no_progress' }) },
        voice: { synthesize: async () => { syntheses++; return { kind: 'wav', durationMs: 40, bytes: wav(.04) }; } } });
    e.c.mode = 'live'; e.director.opened = true;
    const beat0 = e.director.beat;
    await e.prepare(e.epoch, e.controller.signal);
    assert.equal(e.running, true, 'skipped, not stopped'); assert.equal(e.director.beat, beat0 + 1); assert.equal(e.metrics.counters.content_stall_skips, 1);
    assert.equal(e.prepared, null); assert.equal(syntheses, 0, 'a rejected line is never synthesized');
    for (let i = 0; i < 2; i++) { e.generationRetryAt = 0; await e.prepare(e.epoch, e.controller.signal); }
    assert.equal(e.running, false); assert.equal(e.metrics.counters.content_stall_stops, 1); assert.equal(syntheses, 0);
});
