import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VampireShow, VAMPIRE_TITLE, snapshotOf, clock, offerName, LINES, MINUTE, GAME_START_LINE, GAME_WAIT_LINE, ENDER_CHEERS, RELIC_CHEER, FRUSTRATED_LINES, CLEAR_CHEERS, CREDITS_LINES } from '../src/vampire-show.mjs';
import { commentAck } from '../src/comment-ack.mjs';
import { VampireFeed } from '../src/run-log-feed.mjs';
import { TalkEngine, staleNumber, resultFace, intermissionGoal } from '../src/talk-engine.mjs';
import { Conversation } from '../src/providers.mjs';
import { setup, ledger, audit, active, wav, response } from './helpers.mjs';
import { sentences } from '../src/director.mjs';

const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-vampire-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
// A bridge observation as the jev-vampire-survivors runner logs it (only the fields the show reads).
const obs = ({ player, ...o } = {}) => ({ phase: 'combat', elapsed: 10, enemy_count_total: 12, menu: { options: [] }, inventory: [{ name: 'WHIP' }],
    ...o, player: { hp: 120, max_hp: 120, level: 1, character: 'ANTONIO', ...player } });
const show = (t, now = () => 0) => new VampireShow({ lobbyMinutes: 0 }, { dataDir: temp(t), now });
const drain = s => { const out = []; for (let l; (l = s.takeLine());) out.push(l); return out; };

test('vampire lobby: the show opens with talk; the game is announced by the operator or at the time limit, never before', t => {
    let now = 0; const events = [];
    const s = new VampireShow({ lobbyMinutes: 10 }, { dataDir: temp(t), now: () => now, emit: (type, d) => events.push(d.phase) });
    s.start();
    assert.equal(s.phase, 'lobby'); assert.equal(s.status().lobbyEndsAt, 600000);
    assert.equal(s.ingest({ runId: 'r1', state: obs({ elapsed: 5 }) }).reason, 'lobby', 'no game observations during the talk');
    assert.equal(s.takeLine(), null, 'nothing about the game yet');
    assert.equal(s.startGame('operator'), true); assert.equal(s.startGame(), false, 'once');
    assert.equal(s.phase, 'lobby', 'still the talk screen: a lead-in first'); assert.equal(s.status().gameStarting, true);
    now = 1000; const lead = s.takeLine();
    assert.match(lead.text, /^そろそろヴァンパイアサバイバーしよっか。/);
    now = 6999; s.tick(); assert.equal(s.phase, 'lobby', 'the lead-in is still being said');
    now = 7000; s.tick(); assert.equal(s.phase, 'idle', 'the game screen opens after it');
    const line = s.takeLine();
    assert.equal(line.kind, 'game_fact'); assert.match(line.text, /^お待たせ、今日はVampire Survivorsをやるよー！/); assert.equal(line.facts.startedBy, 'operator');
    assert.deepEqual(events, ['lobby', 'lobby', 'idle']);
    assert.equal(s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) }).accepted, true, 'the game is observed after the announcement');
    const timed = new VampireShow({ lobbyMinutes: 10 }, { dataDir: temp(t), now: () => now }); now = 0; timed.start();
    now = 599999; timed.tick(); assert.equal(timed.phase, 'lobby');
    now = 600000; timed.tick(); assert.equal(timed.phase, 'lobby'); assert.equal(timed.leadIn.reason, 'timer');
    now = 620000; timed.tick(); assert.equal(timed.phase, 'idle', 'a lead-in that never aired does not hold the game back'); assert.equal(timed.gameStartedBy, 'timer');
    const none = new VampireShow({ lobbyMinutes: 0 }, {}); none.start(); assert.equal(none.phase, 'idle', 'no lobby: straight to the game');
});

test('vampire lobby in TalkEngine: only lobby talk beats, with no game in the model context; game beats wait', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit, jev: { chat: async () => ({ accept: true }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) },
        conversation: { generate: async () => 'x' }, voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e); e.blocks.start();
    const seen = [];
    for (let i = 0; i < 12; i++) { const u = e.blocksUtterance({ kind: 'autonomous', topicBeat: e.director.beat }, null); if (u.utterance !== 'quiet') seen.push([u.utterance, e.director.beatSpec(e.director.beat).lobby, u.observation]); }
    assert.ok(seen.length > 0 && seen.every(([u, lobby, o]) => u === 'monologue' && lobby === true && o === undefined), 'lobby beats only, no game observation');
    e.blocks.startGame();
    const lead = e.blocksUtterance({ kind: 'autonomous', topicBeat: e.director.beat }, null);
    assert.equal(lead.utterance, 'game_fact'); assert.match(lead.template, /そろそろヴァンパイアサバイバーしよっか/);
    assert.equal(e.blocksUtterance({ kind: 'autonomous', topicBeat: e.director.beat }, null).utterance, 'quiet', 'no small talk between the lead-in and the game');
    e.blocks.leadIn.takenAt -= 10000; e.blocks.tick();
    const next = e.blocksUtterance({ kind: 'autonomous', topicBeat: e.director.beat }, null);
    assert.equal(next.utterance, 'game_fact'); assert.match(next.template, /Vampire Survivorsをやるよー/);
});

test('every fixed Vampire Survivors line fits a turn (two sentences at most)', () => {
    const fixed = [...Object.values(LINES).flat(), ...MINUTE, GAME_START_LINE, GAME_WAIT_LINE,
        ...['こんばんは', '初見です', 'がんばれ', 'かわいい', 'すごい'].map(t => commentAck(t)?.template).filter(Boolean)];
    for (const line of fixed) assert.ok(sentences(line.replace(/\{\w+\}/g, '2')).length <= 2, line);
});

test('vampire snapshot: only observed values; spoken clock and the game\'s own weapon name', () => {
    const s = snapshotOf(obs({ player: { hp: 30, max_hp: 120 } }));
    assert.equal(s.hpRatio, .25); assert.equal(s.level, 1); assert.deepEqual(s.weapons, ['WHIP']); assert.equal(s.enemies, 12);
    assert.equal(snapshotOf({ phase: 'combat', player: {} }).hpRatio, null, 'unknown HP stays unknown');
    const v = new VampireShow({ lobbyMinutes: 0 }, {}); v.start(); v.ingest({ runId: 'r', state: obs() });
    assert.deepEqual(v.observation().weapons, ['鞭'], 'the starting weapon by the game\'s own name, though it was never offered');
    assert.equal(clock(125), '2分5秒'); assert.equal(clock(120), '2分'); assert.equal(clock(45.9), '45秒');
    assert.equal(offerName({ label: 'Choose AXE', description: '斧 | NEW!  | 高ダメージ。' }), '斧');
});

test('vampire run: intro from the real record, level-up and new weapon lines carry observed facts, danger clears on recovery', t => {
    let now = 0; const s = show(t, () => now);
    s.start(); s.ingest({ runId: 'run-r1', state: obs({ elapsed: 0 }) });
    const [intro] = drain(s);
    assert.equal(intro.kind, 'game_fact'); assert.match(intro.text, /1回目、スタート！まずは記録を作ろう/); assert.equal(intro.facts.personalBestSeconds, null);
    now = 1000; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 20, phase: 'levelup', player: { level: 2 },
        menu: { options: [{ id: 'select:0', label: 'Choose AXE', description: '斧 | NEW!  | 高ダメージ。' }] } }) });
    now = 1500; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 21, player: { level: 2 }, inventory: [{ name: 'WHIP' }, { name: 'AXE' }] }) });
    const line = s.takeLine();
    assert.equal(line.kind, 'game_reaction'); assert.equal(line.event.type, 'weapon_new', 'the new weapon outranks the level-up');
    assert.match(line.text, /斧/); assert.equal(line.event.facts.weaponId, 'AXE');
    assert.equal(s.takeLine(), null, 'the lesser level-up event was superseded');
    now = 20000; const r = s.ingest({ runId: 'run-r1', state: obs({ elapsed: 40, player: { level: 2, hp: 30 } }) });
    assert.deepEqual(r.faces, ['troubled']);
    const low = s.events.find(e => e.type === 'hp_low');
    assert.equal(s.stillValid(low.id), true);
    now = 21000; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 41, player: { level: 2, hp: 100 } }) });
    assert.equal(s.stillValid(low.id), false, 'no "danger" line after the recovery');
    assert.equal(s.events.at(-1).type, 'hp_recovered');
});

test('vampire game over: result from the real clock and level, record kept per character; next run aims at it', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'run-r1', state: obs({ elapsed: 0 }) }); drain(s);
    s.ingest({ runId: 'run-r1', state: obs({ elapsed: 95, player: { level: 4 } }) });
    now = 5000; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 128, phase: 'gameover', player: { level: 4, hp: 0 } }) });
    assert.equal(s.phase, 'results'); assert.equal(s.lastResult.seconds, 128); assert.equal(s.lastResult.newBest, true);
    assert.equal(resultFace(s.lastResult), 'excited');
    now = 7000; const [result] = drain(s);
    assert.equal(result.text, '2分8秒生き延びて、レベル4！これが最初の記録だね。'); assert.deepEqual(result.facts, { seconds: 128, level: 4, previousBestSeconds: null, newBest: true, deltaSeconds: null });
    assert.equal(s.ingest({ runId: 'run-r1', state: obs({ elapsed: 129 }) }).reason, 'round_over');
    now = 20000; s.tick(); assert.equal(s.phase, 'between');
    const again = new VampireShow({ lobbyMinutes: 0 }, { dataDir: s.dataDir, now: () => now }); again.start();
    again.ingest({ runId: 'run-r2', state: obs({ elapsed: 0 }) });
    assert.match(again.takeLine().text, /目標は自己ベストの2分8秒超え/);
    assert.equal(again.ingest({ runId: 'run-r1', state: obs() }).accepted, true, 'another show object has its own runs');
});

test('vampire: a run that stops without a game over closes quietly; an old run id is refused; closing uses tonight\'s facts', t => {
    let now = 0; const s = show(t, () => now); s.start();
    assert.equal(s.closing(), null, 'no run yet: the programme\'s fixed goodbye');
    s.ingest({ runId: 'a-r1', state: obs({ elapsed: 0 }) }); s.ingest({ runId: 'a-r1', state: obs({ elapsed: 70, player: { level: 3 } }) });
    s.ingest({ runId: 'a-r2', state: obs({ elapsed: 0 }) });
    assert.equal(s.roundNo, 2); assert.equal(s.lastResult.reason, 'stopped'); assert.equal(s.lastResult.newBest, false, 'a stopped run is no record');
    assert.equal(s.ingest({ runId: 'a-r1', state: obs() }).reason, 'stale_round');
    const c = s.closing();
    assert.equal(c, null, 'one weapon: no insight to draw, so the programme\'s fixed goodbye is used');
});

test('vampire closing: the best run\'s weapons, by the names the game offered, ground the next step', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 50, phase: 'levelup', player: { level: 2 }, menu: { options: [
        { id: 'select:0', label: 'Choose HOLYBOOK', description: '王の聖書 | NEW!  | 聖書がキャラクターの周りを旋回' }, { id: 'select:1', label: 'Choose WHIP', description: '鞭 | 弾数が1増加 | レベル：2' }] } }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 51, player: { level: 2 }, inventory: [{ name: 'WHIP' }, { name: 'HOLYBOOK' }] }) });
    assert.deepEqual(s.observation().weapons, ['鞭', '王の聖書']);
    assert.equal(s.observation().maxHp, 120); assert.ok(!('personalBest' in s.observation()), 'unknown values are left out, not sent as null');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 224, phase: 'gameover', player: { level: 3, hp: 0 }, inventory: [{ name: 'WHIP' }, { name: 'HOLYBOOK' }] }) });
    const c = s.closing();
    assert.equal(c.text, '今夜いちばん長く続いた回では、武器が2つそろっていたね。次は早めにそろえる方針も試してみるね、ありがとう、またね！');
    assert.equal(c.observation.game, VAMPIRE_TITLE); assert.deepEqual(c.observation.facts, { runs: 1, bestSeconds: 224, bestLevel: 3, weaponsInBestRun: ['鞭', '王の聖書'] });
    assert.deepEqual(c.observation.facts.weaponsInBestRun, ['鞭', '王の聖書']); assert.match(c.observation.event, /鞭・王の聖書の2つ/);
    assert.ok(sentences(c.text).length <= 2, 'a turn is at most two sentences');
});

test('vampire closing: a run still in play when the show closes counts toward tonight (not as a record)', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 271, player: { level: 3 }, inventory: [{ name: 'WHIP' }, { name: 'AXE' }, { name: 'MAGIC_MISSILE' }] }) });
    const c = s.closing();
    assert.equal(c.text, '今夜いちばん長く続いた回では、武器が3つそろっていたね。次は早めにそろえる方針も試してみるね、ありがとう、またね！');
    assert.deepEqual(c.observation.facts, { runs: 1, bestSeconds: 271, bestLevel: 3, weaponsInBestRun: ['鞭', '斧', '魔法の杖'] });
    assert.deepEqual(s.records, {}, 'no personal record from a run that did not end');
});

test('vampire commentary: minute marks and best pace from the observed clock, each said once with a cooldown', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 61 }) });
    const c = s.commentary(); assert.equal(c.text, '1分経過。まだまだいくよ。'); s.markCommentary(c);
    const next = s.commentary(); assert.equal(next.kind, 'hp', 'another kind follows; the minute line is not repeated'); assert.equal(next.text, '体力はまだほぼ満タン。'); s.markCommentary(next);
    assert.equal(s.commentary(), null, 'each kind waits for its cooldown');
    now = 50000; s.ingest({ runId: 'r1', state: obs({ elapsed: 125 }) });
    assert.equal(s.commentary().text, '2分突破！この調子でいこう。', 'the wording alternates by minute');
    assert.deepEqual(s.numbers(), { level: 1, weapons: 1 });
    assert.equal(staleNumber('レベル2！', { level: 2, weapons: 1 }, { level: 3, weapons: 1 }), true, 'a level line goes stale when the level moves on');
    assert.equal(staleNumber('レベル3！', { level: 3, weapons: 1 }, { level: 3, weapons: 2 }), false);
});

test('vampire level-up pick: Noa names what was chosen and why (the runner code\'s tag), and the new weapon is not announced twice', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) }); drain(s);
    const offers = { menu: { options: [{ id: 'select:0', label: 'Choose GARLIC', description: 'ニンニク | NEW!  | 近くの敵にダメージ。' }] } };
    now = 1000; s.ingest({ runId: 'r1', state: obs({ elapsed: 30, phase: 'levelup', player: { level: 2 }, ...offers }),
        pick: { choice: 'select:0', option: { name: 'ニンニク', new: true, next_level: 1, tags: ['early_garlic'] } } });
    now = 1500; s.ingest({ runId: 'r1', state: obs({ elapsed: 31, player: { level: 2 }, inventory: [{ name: 'WHIP' }, { name: 'GARLIC' }] }) });
    const line = s.takeLine();
    assert.equal(line.event.type, 'pick'); assert.match(line.text, /レベルアップ！序盤を安定させたいから、ニンニク/);
    assert.match(line.eventText, /ニンニクを新しく取った。選んだ理由.*序盤の安定用/);
    assert.ok(!s.events.some(e => e.type === 'weapon_new'), 'the pick already announced the new weapon');
    now = 5000; s.ingest({ runId: 'r1', state: obs({ elapsed: 60, phase: 'levelup', player: { level: 3 } }),
        pick: { choice: 'select:1', option: { name: 'ニンニク', new: false, next_level: 2, tags: [] } } });
    const up = s.takeLine(); assert.match(up.text, /ニンニク(をレベル2にする|を強化しよう)/); assert.ok(!/から、/.test(up.text), 'no reason is invented when the code gave none');
});

test('vampire fast enemies: several at the swarm\'s speed get one surprised line, re-armed only after they are gone for a while', t => {
    let now = 0; const s = show(t, () => now); s.start();
    const fast = n => Array.from({ length: n }, (_, i) => ({ id: i, type: 'BATSWARM', x: 3, y: i, velocity_x: -1.78, velocity_y: 0 }));
    s.ingest({ runId: 'r1', state: obs({ elapsed: 120, enemies: [{ id: 99, velocity_x: 1.27, velocity_y: 0 }, { id: 98, velocity_x: .36 }] }) }); drain(s);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 121, enemies: [...fast(2), { id: 99, velocity_x: 1.27 }] }) });
    assert.ok(!s.events.some(e => e.type === 'fast_enemy'), 'a pushed enemy or two fast ones are not a swarm');
    const r = s.ingest({ runId: 'r1', state: obs({ elapsed: 125, enemies: fast(8) }) });
    assert.deepEqual(r.faces, ['surprised']);
    const line = s.takeLine(); assert.equal(line.event.type, 'fast_enemy'); assert.match(line.text, /速/); assert.match(line.eventText, /同時に8体/);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 130, enemies: fast(9) }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 140, enemies: [] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 145, enemies: fast(5) }) });
    assert.equal(s.events.filter(e => e.type === 'fast_enemy').length, 1, 'no second line: they were gone for only 10 s');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 150, enemies: [] }) }); s.ingest({ runId: 'r1', state: obs({ elapsed: 171, enemies: [] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 172, enemies: fast(4) }) });
    assert.equal(s.events.filter(e => e.type === 'fast_enemy').length, 2, 'a new wave after 20 s without');
});

test('vampire feed: follows only logs written after it started, keeps partial lines, switches to the next run', t => {
    const dir = temp(t), got = [], old = join(dir, 'vampire-old'), r1 = join(dir, 'vampire-s-r1'), r2 = join(dir, 'vampire-s-r2');
    mkdirSync(old); writeFileSync(join(old, 'decisions.jsonl'), JSON.stringify({ state: obs() }) + '\n');
    const past = new Date(Date.now() - 60000); utimesSync(join(old, 'decisions.jsonl'), past, past);
    const f = new VampireFeed(dir, d => got.push(d)); f.startedAt = Date.now();
    assert.equal(f.poll(), 0, 'an earlier session is ignored');
    mkdirSync(r1); writeFileSync(join(r1, 'decisions.jsonl'), JSON.stringify({ event: 'phase', state: obs({ elapsed: 1 }) }) + '\n{"event":"deci');
    assert.equal(f.poll(), 1);
    appendFileSync(join(r1, 'decisions.jsonl'), `sion","state":${JSON.stringify(obs({ elapsed: 2 }))}}\n{"event":"no state"}\n`);
    assert.equal(f.poll(), 1, 'the split line is joined; a record without state is skipped');
    assert.deepEqual(got.map(g => [g.runId, g.state.elapsed]), [['vampire-s-r1', 1], ['vampire-s-r1', 2]]);
    appendFileSync(join(r1, 'decisions.jsonl'), JSON.stringify({ event: 'decision', phase: 'levelup', applied: true, choice: 'select:0', state: obs({ elapsed: 2, phase: 'levelup' }),
        candidates: { 'select:0': { name: 'ニンニク', new: true, tags: ['early_garlic'] } } }) + '\n' + JSON.stringify({ event: 'decision', phase: 'levelup', applied: false, choice: 'select:1', state: obs({ elapsed: 2, phase: 'levelup' }), candidates: { 'select:1': { name: 'x' } } }) + '\n');
    f.poll();
    assert.deepEqual(got.slice(-2).map(g => g.pick?.option?.name ?? null), ['ニンニク', null], 'only an applied choice is passed on as a pick');
    appendFileSync(join(r1, 'decisions.jsonl'), [{ event: 'choice_planned', attempt: 7, phase: 'levelup', choice: 'select:2', state: obs({ elapsed: 3, phase: 'levelup' }), candidates: { 'select:2': { name: '王の聖書', new: false } } },
        { event: 'decision', attempt: 7, phase: 'levelup', applied: true, choice: 'select:2', state: obs({ elapsed: 3, phase: 'levelup' }), candidates: { 'select:2': { name: '王の聖書' } } }].map(r => JSON.stringify(r)).join('\n') + '\n');
    f.poll();
    assert.deepEqual(got.slice(-2).map(g => g.pick?.option?.name ?? null), ['王の聖書', null], 'announced when planned, not again when pressed');
    got.length = 2;
    mkdirSync(r2); writeFileSync(join(r2, 'decisions.jsonl'), JSON.stringify({ state: obs({ elapsed: 0 }) }) + '\n');
    const future = new Date(Date.now() + 5000); utimesSync(join(r2, 'decisions.jsonl'), future, future);
    assert.equal(f.poll(), 1); assert.equal(got.at(-1).runId, 'vampire-s-r2');
    appendFileSync(join(r1, 'decisions.jsonl'), JSON.stringify({ state: obs({ elapsed: 3 }) }) + '\n');
    const later = new Date(Date.now() + 9000); utimesSync(join(r1, 'decisions.jsonl'), later, later);
    assert.equal(f.poll(), 0, 'a finished run is not resumed');
});

test('Vampire Survivors events reach Noa\'s affect (frustration/tilt rise on low HP and when surrounded; game over once)', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit, jev: { chat: async () => ({ accept: true }), speech: async () => ({ accept: true }) },
        conversation: { generate: async () => 'x' }, voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e); e.blocks.start(); e.blocks.startGame(); e.blocks.beginGame();
    e.ingestGame({ runId: 'r1', state: obs({ elapsed: 0 }) });
    const before = { ...e.affect.state };
    const r = e.ingestGame({ runId: 'r1', state: obs({ elapsed: 5, player: { hp: 20 } }) });
    assert.ok(r.events.some(x => x.type === 'hp_low'));
    assert.ok(e.affect.state.frustration > before.frustration + .1, 'low HP is felt as frustration');
    const seen = [], orig = e.affect.appraiseGameEvent.bind(e.affect); e.affect.appraiseGameEvent = (type, f) => { seen.push(type); return orig(type, f); };
    const end = e.ingestGame({ runId: 'r1', state: obs({ elapsed: 6, phase: 'gameover', player: { hp: 0 } }) });
    // Live 2026-10-14: the results step never saw a Vampire death (the run ends in the observed state, not in a tick).
    assert.equal(end.events.filter(x => x.type === 'game_over').length, 1, 'the death reaches the affect');
    assert.deepEqual(seen.filter(x => x === 'game_over'), ['game_over']);
    const again = e.ingestGame({ runId: 'r1', state: obs({ elapsed: 6, phase: 'gameover', player: { hp: 0 } }) });
    assert.ok(!(again.events || []).some(x => x.type === 'game_over'), 'once per death');
});

test('a frustrated Noa takes the frustrated wording for a fixed game line', () => {
    const show = new VampireShow({ dataDir: null }, { now: () => 0 });
    const e = { type: 'surrounded', facts: {} };
    assert.ok(LINES.surrounded.includes(show.linesFor(e)[0]), 'calm by default');
    show.tone = 'frustrated';
    assert.deepEqual(show.linesFor(e), FRUSTRATED_LINES.surrounded);
    assert.equal(show.linesFor({ type: 'level_up', facts: { level: 3 } }), LINES.level_up, 'no frustrated level-up');
    for (const pool of Object.values(FRUSTRATED_LINES)) for (const line of pool) assert.doesNotMatch(line, /お前|てめ|死ね|ばか|クソ|視聴者|みんな/, 'aimed at the game, never at viewers');
});

test('Vampire Survivors programme in TalkEngine: game lines are gated as game_reaction with the observed facts, the game-name answer is fixed', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    assert.equal(c.game.id, 'vampire-survivors');
    const judged = [], generated = [];
    const e = new TalkEngine(c, { ledger: ledger(), audit,
        jev: { chat: async () => ({ accept: true, action: 'reply' }), speech: async (text, s, ev, ctx) => { judged.push({ text, ctx }); return { accept: true, effect: 'none', mood: 'warm' }; } },
        conversation: { generate: async ctx => { generated.push(ctx); return 'モデルの文'; } },
        voice: { synthesize: async () => ({ kind: 'wav', durationMs: 40, bytes: wav(.04) }) }, research: { search: async () => { throw new Error('x'); } } });
    t.after(() => e.stop('test')); active(e); e.blocks.start(); e.blocks.startGame(); e.blocks.beginGame(); // past the opening talk
    assert.ok(e.status().vampire, 'the stage gets a vampire status, not a blocks board');
    assert.equal(e.status().blocks, undefined);
    assert.equal(e.ingestGame({ runId: 'r1', state: obs({ elapsed: 0 }) }).accepted, true);
    e.blocks.announcements = []; // skip the intro
    e.ingestGame({ runId: 'r1', state: obs({ elapsed: 30, player: { level: 2 } }) });
    const u = e.utterance({ kind: 'autonomous', topicBeat: 0 }, null, null);
    assert.equal(u.utterance, 'game_reaction'); assert.match(u.template, /レベル2/);
    assert.equal(u.observation.game, VAMPIRE_TITLE); assert.equal(u.observation.level, 2); assert.equal(u.observation.facts.level, 2);
    e.blocks.events = []; e.blocks.announcements = []; e.director.beatSpec = () => ({ id: 'vampire-1', game: true });
    e.ingestGame({ runId: 'r1', state: obs({ elapsed: 65, player: { level: 2 } }) }); e.blocks.events = [];
    const g = e.blocksUtterance({ kind: 'autonomous', topicBeat: 0 }, null);
    assert.equal(g.utterance, 'game_commentary'); assert.equal(g.template, g.observation.point, 'commentary is spoken as written (still gated), not rewritten by the model');
    const a = e.blocksUtterance({ kind: 'reply' }, { text: 'これ何のゲーム？' });
    assert.equal(a.utterance, 'game_fact'); assert.match(a.template, /Vampire Survivors.*生き残るゲーム/);
    assert.equal(e.ingestGame({ roundId: 'round-001', events: [] }).accepted, false, 'a NOA BLOCKS stage report is not a vampire run');
    const hi = e.blocksUtterance({ kind: 'reply' }, { text: 'こんばんは' });
    assert.equal(hi.utterance, 'comment_ack'); assert.equal(hi.template, 'こんばんは！来てくれてありがとう、ゆっくりしていってね。');
    assert.equal(e.blocksUtterance({ kind: 'reply' }, { text: '初見です！' }).utterance, 'comment_ack');
    const lv = e.blocksUtterance({ kind: 'reply' }, { text: '今何レベル？' });
    assert.equal(lv.utterance, 'game_fact'); assert.equal(lv.template, 'いまレベル2だよ！'); assert.deepEqual(lv.observation.facts, { level: 2 });
    assert.match(e.blocksUtterance({ kind: 'reply' }, { text: '自己ベストは？' }).template, /まだ自己ベストの記録はない/);
    assert.equal(e.blocksUtterance({ kind: 'reply' }, { text: '好きな食べ物は？' }).utterance, 'comment_reply', 'anything else: the normal reply');
});

test('round reflection uses recent evidence and releases only its own completed speech', t => {
    let now = 0; const emitted = [];
    const s = new VampireShow({ lobbyMinutes: 0 }, { now: () => now, emit: (type, data) => emitted.push({ type, data }) });
    s.ingest({ runId: 'vampire-test-r1', state: obs({ elapsed: 20, player: { hp: 20 } }) });
    drain(s);
    s.ingest({ runId: 'vampire-test-r1', state: obs({ elapsed: 23, phase: 'gameover', player: { hp: 0 } }) });
    now = 1500;
    const lines = drain(s), review = lines.find(l => l.eventId.startsWith('recap-'));
    assert.match(s.review.lines[review.eventId].event, /体力は、最大の17パーセント/); assert.match(review.text, /体力がかなり少なく/); assert.match(review.text, /次は体力を大事に/);
    assert.equal(review.facts.nextTactic, 'health_priority');
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 0);
    s.playbackCompleted('result-vampire-test-r1');
    s.playbackCompleted('recap-other');
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 0);
    s.playbackCompleted(review.eventId); s.playbackCompleted(review.eventId);
    assert.equal(s.intermissionChat, true);
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 0);
    now = 54999; s.tick(); assert.equal(s.intermissionChat, true);
    s.playbackCompleted('recap-resume-vampire-test-r1');
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 0);
    now += 1; s.tick(); assert.equal(s.intermissionChat, false);
    assert.ok(drain(s).some(l => l.eventId === 'recap-resume-vampire-test-r1'));
    s.playbackCompleted('recap-resume-vampire-test-r1');
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 0, 'an early resume ACK still respects the death-based deadline');
    now = 60000; s.tick();
    assert.deepEqual(emitted.filter(x => x.type === 'round_review_completed').map(x => x.data), [{ runId: 'vampire-test-r1', tactic: 'health_priority' }]);
    s.ingest({ runId: 'vampire-test-r2', state: obs({ elapsed: 0 }) });
    s.playbackCompleted(review.eventId);
    assert.equal(emitted.filter(x => x.type === 'round_review_completed').length, 1);
});

test('old low health is not claimed as the final situation', t => {
    let now = 0; const s = show(t, () => now);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 2, player: { hp: 10 } }) }); drain(s);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 60, phase: 'gameover', player: { hp: 0 } }) });
    now = 1500; const review = drain(s).find(l => l.eventId.startsWith('recap-'));
    assert.match(review.text, /原因はまだ決めつけられない/);
    assert.equal(review.facts.nextTactic, 'escape_space');
});

test('vampire: a boss, being surrounded and getting out are events with their own lines', t => {
    const s = show(t); s.start();
    const ring = n => Array.from({ length: n }, (_, i) => ({ type: 'BAT1', x: Math.cos(i) * 1.0, y: Math.sin(i) * 1.0 }));
    s.ingest({ runId: 'r1', state: obs({ elapsed: 10, player: { x: 0, y: 0 } }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 11, player: { x: 0, y: 0 }, enemies: [...ring(12), { type: 'BOSS_XLMANTIS', x: 5, y: 5 }] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 12, player: { x: 0, y: 0 }, enemies: [...ring(13), { type: 'BOSS_XLMANTIS', x: 5, y: 5 }] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 13, player: { x: 0, y: 0 }, enemies: ring(2) }) });
    const types = s.events.map(e => e.type);
    assert.equal(types.filter(x => x === 'boss').length, 1, 'once per boss type');
    assert.equal(types.filter(x => x === 'surrounded').length, 1, 'once until out again');
    assert.equal(types.filter(x => x === 'escaped').length, 1);
    for (const type of ['boss', 'surrounded', 'escaped']) assert.ok(LINES[type].length >= 2);
});

test('vampire: the Ender at hp <= 0 is beaten at once (the game clock stops at the kill)', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1830, enemies: [{ type: 'BOSS_ENDER', hp: 23205, x: 3, y: 0 }] }) }); now = 20000; drain(s);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 2570, enemies: [{ type: 'BOSS_ENDER', hp: 19, x: 3, y: 0 }] }) });
    assert.ok(!s.events.some(e => e.type === 'boss_defeated'), 'still standing');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 2570, enemies: [{ type: 'BOSS_ENDER', hp: -7, x: 3, y: 0 }] }) });
    assert.equal(s.events.filter(e => e.type === 'boss_defeated').length, 1);
    assert.ok(LINES.boss_defeated.includes(drain(s)[0]?.text));
});

test('vampire: the Ender beaten is a celebration, followed by more lines and the relic page', t => {
    let now = 0; const s = show(t, () => now); s.start();
    const ender = [{ type: 'BOSS_ENDER', x: 3, y: 0 }];
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1830, enemies: ender }) }); drain(s);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1900, enemies: ender }) }); now = 20000; drain(s);
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1901, enemies: [], enemy_snapshot_truncated: true }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1906, enemies: [], enemy_snapshot_truncated: true }) });
    assert.ok(!s.events.some(e => e.type === 'boss_defeated'), 'not from a truncated enemy list');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1907, enemies: [] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1909, enemies: [] }) });
    assert.ok(!s.events.some(e => e.type === 'boss_defeated'), 'gone 2 s: not yet');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1910, enemies: [] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1911, enemies: [] }) });
    assert.equal(s.events.filter(e => e.type === 'boss_defeated').length, 1, 'once');
    const first = drain(s).map(l => l.text);
    assert.ok(LINES.boss_defeated.includes(first[0]), first.join(' / '));
    assert.deepEqual(first.slice(1), ENDER_CHEERS, 'then the cheers, in order');
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1912, phase: 'menu', enemies: [], menu: { options: [{ id: 'itemfound:SelectButton', label: '選択' }] } }) });
    now = 80000; const lines = drain(s).map(l => l.text);
    assert.ok(lines.includes(RELIC_CHEER), lines.join(' / '));
    for (const l of [...LINES.boss_defeated, ...ENDER_CHEERS, RELIC_CHEER]) assert.ok(sentences(l).length <= 2, l);
});

test('vampire: an Ender that is still out, or Noa down, is no celebration', t => {
    const s = show(t); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1830, enemies: [{ type: 'BOSS_ENDER', x: 3, y: 0 }] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1840, enemies: [{ type: 'BOSS_ENDER', x: 3, y: 0 }] }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 1841, enemies: [], player: { hp: 0 } }) });
    assert.ok(!s.events.some(e => e.type === 'boss_defeated'));
});

test('vampire revive: after a logged Revive the same run reopens (game lines go on); without it a late state stays round_over', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'run-r1', state: obs({ elapsed: 0 }) }); drain(s);
    s.ingest({ runId: 'run-r1', state: obs({ elapsed: 300, player: { level: 29 } }) });
    now = 5000; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 320, phase: 'gameover', player: { level: 29, hp: 0 } }) });
    assert.equal(s.phase, 'results');
    assert.equal(s.ingest({ runId: 'run-r1', state: obs({ elapsed: 321, player: { level: 29, hp: 50 } }) }).reason, 'round_over', 'no revive logged');
    s.ingest({ runId: 'run-r1', state: obs({ elapsed: 322, phase: 'gameover', player: { level: 29, hp: 0 } }), revive: true });
    const r = s.ingest({ runId: 'run-r1', state: obs({ elapsed: 322, player: { level: 29, hp: 66 } }) });
    assert.equal(r.accepted, true); assert.equal(s.phase, 'playing');
    const lines = drain(s).map(x => x.text);
    assert.ok(lines.includes('復活した！まだまだ続けるよ！')); assert.ok(!lines.some(x => /生き延びて/.test(x)), 'the result of the death it came back from is dropped');
    assert.equal(s.night.rounds, 0);
    now = 9000; s.ingest({ runId: 'run-r1', state: obs({ elapsed: 900, phase: 'gameover', player: { level: 40, hp: 0 } }) });
    assert.equal(s.phase, 'results'); assert.equal(s.lastResult.seconds, 900); assert.equal(s.night.rounds, 1);
});
test('vampire commentary: the level at every fifth level, the count at a new fifty, the time left to the best; hp wordings rotate', t => {
    let now = 0; const s = show(t, () => now); s.records = { ANTONIO: { seconds: 600 } }; s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) });
    const say = (elapsed, o = {}) => { now += 16000; s.ingest({ runId: 'r1', state: obs({ elapsed, ...o }) }); drain(s); const out = [];
        for (let c; (c = s.commentary());) { out.push(c); s.markCommentary(c); } return out; };
    const kinds = out => out.map(c => c.kind);
    assert.ok(!kinds(say(20, { player: { level: 4 } })).includes('level'), 'a level the level-up line just said is not repeated');
    const five = say(40, { player: { level: 5 } }).find(c => c.kind === 'level'); assert.match(five.text, /レベル5/);
    assert.ok(!kinds(say(70, { player: { level: 6 }, enemy_count_total: 49 })).includes('enemies'), 'under fifty: no count');
    assert.match(say(90, { enemy_count_total: 120 }).find(c => c.kind === 'enemies').text, /100体/);
    assert.ok(!kinds(say(110, { enemy_count_total: 60 })).includes('enemies'), 'a lower count after a higher one is not said');
    const pace = say(310).find(c => c.kind === 'pace'); assert.match(pace.text, /自己ベスト.*(あと|残り)5分/);
    const hp = new Set(); for (let e = 360; e < 720; e += 120) hp.add(say(e).find(c => c.kind === 'hp')?.text); now += 16000;
    assert.equal(hp.size, 3, 'each two-minute slot has its own wording');
});
test('vampire commentary: in a quiet stretch, a recap of tonight for newcomers and a light invitation to comment, each at most every few minutes', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.night = { rounds: 2, bestSeconds: 400, bestLevel: 20, bestWeapons: [] };
    s.ingest({ runId: 'r3', state: obs({ elapsed: 0 }) });
    s.ingest({ runId: 'r3', state: obs({ elapsed: 30, player: { hp: 20, max_hp: 100 } }) });
    assert.equal(s.commentary()?.kind === 'night' || s.commentary()?.kind === 'invite', false, 'not in the first 90 s of play');
    s.ingest({ runId: 'r3', state: obs({ elapsed: 100, player: { hp: 20, max_hp: 100 } }) });
    const said = [];
    for (let i = 0; i < 6; i++) { const c = s.commentary(); if (c) { said.push(c.kind); s.markCommentary(c); } now += 16000; }
    assert.ok(said.includes('night') && said.includes('invite'));
    assert.equal(said.filter(k => k === 'invite').length, 1); assert.equal(said.filter(k => k === 'night').length, 1);
    now = 13 * 60000; const later = []; for (let i = 0; i < 4; i++) { const c = s.commentary(); if (c) { later.push(c.kind); s.markCommentary(c); } now += 16000; }
    assert.ok(later.includes('invite'), 'the invitation comes back after its interval');
});
test('vampire commentary: when the stream goes to Twitch, Noa says how Twitch chat votes on her level-up item (every ten minutes, quiet moments only)', t => {
    const run = viewerVotes => {
        let now = 0; const s = new VampireShow({ lobbyMinutes: 0 }, { dataDir: temp(t), now: () => now, viewerVotes }); s.start();
        s.ingest({ runId: 'r1', state: obs({ elapsed: 0 }) }); s.ingest({ runId: 'r1', state: obs({ elapsed: 100, player: { hp: 20, max_hp: 100 } }) });
        const said = [];
        for (let i = 0; i < 6; i++) { const c = s.commentary(); if (c) { said.push(c); s.markCommentary(c); } now += 16000; }
        now = 11 * 60000; for (let i = 0; i < 4; i++) { const c = s.commentary(); if (c) { said.push(c); s.markCommentary(c); } now += 16000; }
        return said.filter(c => c.kind === 'vote');
    };
    const votes = run(true);
    assert.equal(votes.length, 2, 'once, then again after its interval'); assert.notEqual(votes[0].text, votes[1].text);
    for (const v of votes) { assert.match(v.text, /Twitch/); assert.match(v.text, /番号/); assert.ok((v.text.match(/[。！？]/g) || []).length <= 2, v.text); }
    assert.deepEqual(run(false), [], 'not without Twitch (YouTube chat does not reach the game)');
});
test('vampire lines: every event has several wordings, each at most two sentences', () => {
    for (const [type, pool] of Object.entries(LINES)) {
        if (type !== 'level_up' && type !== 'chest') assert.ok(pool.length >= 3, `${type} has ${pool.length}`);
        for (const l of pool) assert.ok((l.match(/[。！？]/g) || []).length <= 2 && !/やば|死|殺|囲まれ/.test(l), l);
    }
});

test('post-game talk: one concrete topic per line in turn, never the review plan again', () => {
    const o = { weapons: ['ムチ', '聖水'] };
    const goals = [1, 2, 3, 4].map(n => intermissionGoal(o, n));
    assert.equal(new Set(goals).size, 4, 'four different topics in a row');
    for (const g of goals) { assert.match(g, /^ゲームオーバー後の休憩。/); assert.match(g, /次に試す作戦はもう話したので言い直さず/); assert.ok(sentences(g).length >= 1); }
    assert.match(intermissionGoal(o, 0), /observation\.weapons/);
    // No weapons observed: the weapon topic is skipped, not asked about.
    assert.doesNotMatch(intermissionGoal({}, 0), /weapons/); assert.equal(intermissionGoal({}, 0), intermissionGoal(o, 1));
});

test('a talk beat during the game gets its goal without the show title or beat labels (read out live 10/9)', async t => {
    const c = setup(t, { SHOW_PROFILE: 'talk' }); c.mode = 'live'; c.llmProvider = 'ollama';
    let body;
    const conv = new Conversation(c, ledger(), async (_url, options) => { body = JSON.parse(options.body); return response({ message: { content: '夜の静けさの中で遊ぶの、好きなんだ。' } }); });
    const context = { kind: 'autonomous', utterance: 'monologue', goal: '夜ふかしの好み', angle: '夜ふかしの好み', topic: 'ノアの夜ふかしゲーム部', programmeTitle: 'ノアの夜ふかしゲーム部',
        displayFocus: 'いつでも気軽に', beatLabel: '夜ふかし', recentTopics: ['ノアの夜ふかしゲーム部'], recentSpeeches: ['宝箱！'], observation: { game: VAMPIRE_TITLE, phase: 'playing' } };
    await conv.generate(context);
    const user = JSON.parse(body.messages[1].content).untrustedContext;
    assert.equal(user.goal, '夜ふかしの好み'); assert.deepEqual(user.recentSpeeches, ['宝箱！']);
    for (const k of ['topic', 'programmeTitle', 'displayFocus', 'beatLabel', 'recentTopics', 'angle']) assert.equal(user[k], undefined, k);
    assert.doesNotMatch(body.messages[1].content, /夜ふかしゲーム部|いつでも気軽に/);
    assert.match(JSON.parse(body.messages[1].content).instruction, /^今回やること：夜ふかしの好み。recentSpeeches は言い終えた発言/);
    // Talk programmes without a game keep their topic.
    const { observation, ...talk } = context; await conv.generate(talk);
    assert.equal(JSON.parse(body.messages[1].content).untrustedContext.topic, 'ノアの夜ふかしゲーム部');
});

test('model-written talk is told what it may say about the game and how to say it, in play and in the post-game break', () => {
    const s = new VampireShow({ lobbyMinutes: 0 });
    const play = s.promptRule('monologue');
    Object.defineProperty(s, 'intermissionChat', { get: () => true });
    for (const rule of [play, s.promptRule('monologue')]) {
        assert.match(rule, /言ってよいのは observation にある事実/); assert.match(rule, /一人称は「私」/); assert.match(rule, /やばい・マジ・死ぬ/);
        // Bad endings are not quoted as examples: a small model copied 「〜ねー」「〜だろ」 from the list (local run 2026-10-10).
        assert.doesNotMatch(rule, /「〜ねー」|「〜だろ」/);
    }
});

// Live 2026-10-17 (MACHINE r6, the 20th try): the Directer's phase-4 fake game over closed the round, so the kill, the
// ending and the next game were all refused and Noa said 「もう一回頑張るね」 over a win.
const directer = phase => ({ x: 80, y: -40, phase, break_enabled: false, broken_masks: 0, invulnerable: false });
test('vampire: the Directer\'s phase-4 fake game over is held, and the run going on is a surprise, not a death', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 700, directer: directer(4) }) }); now = 20000; drain(s);
    const fake = s.ingest({ runId: 'r1', state: obs({ phase: 'gameover', elapsed: 717, directer: directer(4), player: { hp: 0 } }) });
    assert.equal(s.phase, 'playing', 'not a result yet');
    assert.ok(!fake.events.some(e => e.type === 'game_over') && !s.events.some(e => e.type === 'game_over'));
    now = 23000; s.tick(); assert.equal(s.phase, 'playing', 'still held 3 s later');
    const back = s.ingest({ runId: 'r1', state: obs({ elapsed: 720, directer: directer(4), player: { hp: 60 } }) });
    assert.equal(back.accepted, true);
    assert.equal(s.events.filter(e => e.type === 'fake_death').length, 1);
    assert.ok(LINES.fake_death.includes(drain(s)[0]?.text));
    now = 40000; s.tick(); assert.equal(s.phase, 'playing', 'the hold was dropped: no late death');
    s.ingest({ runId: 'r1', state: obs({ phase: 'gameover', elapsed: 760, directer: directer(4), player: { hp: 0 } }) });
    s.ingest({ runId: 'r1', state: obs({ elapsed: 763, directer: directer(4), player: { hp: 60 } }) });
    assert.equal(s.events.filter(e => e.type === 'fake_death').length, 1, 'once per run');
    for (const l of LINES.fake_death) assert.ok(sentences(l).length <= 2, l);
});

test('vampire: a held phase-4 death that no living state follows is a real game over (after the hold, or at the next run)', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 700, directer: directer(4) }) });
    s.ingest({ runId: 'r1', state: obs({ phase: 'gameover', elapsed: 717, level: 30, directer: directer(4), player: { hp: 0, level: 30 } }) });
    now = 7999; s.tick(); assert.equal(s.phase, 'playing');
    now = 8000; s.tick(); assert.equal(s.phase, 'results');
    assert.equal(s.lastResult.reason, 'game_over'); assert.equal(s.lastResult.seconds, 717);
    const u = show(t, () => now); u.start();
    u.ingest({ runId: 'r1', state: obs({ elapsed: 700, directer: directer(4) }) });
    u.ingest({ runId: 'r1', state: obs({ phase: 'gameover', elapsed: 717, directer: directer(4), player: { hp: 0 } }) });
    u.ingest({ runId: 'r2', state: obs({ elapsed: 1 }) });
    assert.equal(u.lastResult.reason, 'game_over', 'confirmed before the next run begins');
    assert.equal(u.round.roundId, 'r2');
});

test('vampire: a death in another Directer phase is a game over at once', t => {
    const s = show(t); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 400, directer: directer(3) }) });
    s.ingest({ runId: 'r1', state: obs({ phase: 'gameover', elapsed: 406, directer: directer(3), player: { hp: 0 } }) });
    assert.equal(s.phase, 'results'); assert.equal(s.lastResult.reason, 'game_over');
});

test('vampire: the ending is a clear: cheers, credits talk, the goal reached, and the next game in the same run is a new round', t => {
    let now = 0; const s = show(t, () => now); s.start();
    s.ingest({ runId: 'r6', state: obs({ elapsed: 840, directer: directer(5), player: { hp: 59, level: 31 } }) }); now = 20000; drain(s);
    const end = s.ingest({ runId: 'r6', state: obs({ phase: 'menu', state: 'VampireSurvivors.UI.GameStateFinalFireworks', elapsed: 852, player: { hp: 59, level: 31 } }) });
    assert.ok(end.events.some(e => e.type === 'run_cleared'), 'reaches the affect');
    const lines = drain(s).map(l => l.text);
    assert.ok(LINES.run_cleared.includes(lines[0]), lines.join(' / '));
    assert.deepEqual(lines.slice(1), CLEAR_CHEERS);
    assert.equal(s.goalResult().reached, true);
    assert.equal(s.commentary(), null, 'the cheers first');
    now = 20000 + 40000; const c = s.commentary();
    assert.equal(c.kind, 'credits'); assert.equal(c.text, CREDITS_LINES[0]); s.markCommentary(c);
    now = 20000 + 60000; assert.equal(s.commentary(), null, 'one every 40 s');
    now = 20000 + 80000; assert.equal(s.commentary().text, CREDITS_LINES[1]);
    // no game over is taken from the ending, whatever its hp reads
    s.ingest({ runId: 'r6', state: obs({ phase: 'menu', state: 'VampireSurvivors.UI.GameStateFinalFireworks', elapsed: 852, player: { hp: 0 } }) });
    assert.equal(s.phase, 'playing');
    const next = s.ingest({ runId: 'r6', state: obs({ elapsed: 0, player: { hp: 133, level: 1 } }) });
    assert.equal(next.accepted, true, 'not refused as out of order');
    assert.equal(s.lastResult.reason, 'cleared');
    assert.notEqual(s.round.roundId, 'r6'); assert.equal(s.phase, 'playing');
    assert.equal(s.ingest({ runId: 'r6', state: obs({ elapsed: 5, player: { hp: 133 } }) }).accepted, true, 'later states of the run follow the new round');
    for (const l of [...LINES.run_cleared, ...CLEAR_CHEERS, ...CREDITS_LINES]) assert.ok(sentences(l).length <= 2, l);
});

test('vampire: the Directer gone after its last phase while Noa stands is a clear', t => {
    const s = show(t); s.start();
    s.ingest({ runId: 'r1', state: obs({ elapsed: 840, directer: directer(5) }) });
    assert.ok(!s.events.some(e => e.type === 'run_cleared'));
    s.ingest({ runId: 'r1', state: obs({ elapsed: 845 }) });
    assert.equal(s.events.filter(e => e.type === 'run_cleared').length, 1);
    const u = show(t); u.start();
    u.ingest({ runId: 'r1', state: obs({ elapsed: 10 }) }); u.ingest({ runId: 'r1', state: obs({ elapsed: 11, directer: directer(1) }) });
    u.ingest({ runId: 'r1', state: obs({ elapsed: 12 }) });
    assert.ok(!u.events.some(e => e.type === 'run_cleared'), 'not before its last phase');
});
