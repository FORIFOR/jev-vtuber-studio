import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeGameDecision, publicGameDecision } from '../src/game-decision.mjs';
import { RunLogFeed } from '../src/run-log-feed.mjs';
import { TalkEngine } from '../src/talk-engine.mjs';
import { setup, ledger, audit } from './helpers.mjs';

const NOW = 1000000;
const raw = (attempt = 1, extra = {}) => ({ event: 'decision', applied: true, attempt, phase: 'combat', choice: 'north', elapsed_ms: attempt * 500,
    observation_elapsed_ms: attempt * 500 - 100, decision_started_ms: attempt * 500 - 100,
    state: { protocol: 1, game: 'vampire_survivors', phase: 'combat', seq: attempt + 10, elapsed: attempt / 2, player: { hp: 35, max_hp: 100 } },
    candidates: { north: { label: 'untrusted label' }, east: {}, south: {}, stay: {} },
    judgment: { choice: 'north', confidence: .9, probabilities: { north: .6, east: .2, south: .15, stay: .05 }, latency_ms: 90, model: 'private-model', usage: { secret: 1 } },
    decision_state: { prompt: 'secret' }, prompt: 'secret', ...extra });
const menu = (attempt = 1) => {
    const r = raw(attempt); r.phase = r.state.phase = 'levelup'; r.choice = r.judgment.choice = 'select:1';
    r.candidates = { 'select:0': { name: '炎の杖' }, 'select:1': { name: 'ニンニク' }, 'select:2': { name: 'ナイフ' } };
    r.judgment.probabilities = { 'select:0': .25, 'select:1': .6, 'select:2': .15 }; return r;
};
const sanitize = (r, options = {}) => sanitizeGameDecision(r, { runId: 'vampire-r1', recordedAt: NOW, now: NOW, ...options });

test('decision projection contains only approved input facts, top three distribution and pre-action HP', () => {
    const d = sanitize(raw()); assert.ok(d); assert.equal(d.hpPercent, 35); assert.equal(d.choice.label, '上へ移動');
    assert.equal(d.candidates.length, 3); assert.deepEqual(d.candidates.map(c => c.probability), [.6, .2, .15]);
    assert.equal(d.timing.source, 'log_mtime'); assert.equal(d.expiresAt - d.recordedAt, 2000);
    assert.doesNotMatch(JSON.stringify(d), /secret|untrusted|private-model|confidence|decision_state|prompt|usage/);
    const rebuilt = publicGameDecision({ ...d, private: 'secret', timing: { ...d.timing, state: 'secret' }, choice: { ...d.choice, raw: 'secret' } }, NOW);
    assert.deepEqual(rebuilt, d);
});

test('only applied Jev decisions with a valid, matching full distribution pass', () => {
    for (const mutate of [r => { r.event = 'choice_planned'; }, r => { r.applied = false; }, r => { delete r.judgment; },
        r => { r.synthetic = true; }, r => { r.reason = 'decision expired'; }, r => { r.state.game = 'other'; },
        r => { r.state.phase = 'chest'; }, r => { r.judgment.choice = 'east'; }, r => { r.judgment.probabilities.east = .8; },
        r => { r.judgment.probabilities.north = NaN; }, r => { r.judgment.probabilities.north = '0.6'; },
        r => { r.judgment.probabilities.north = -.1; }, r => { delete r.judgment.probabilities.stay; },
        r => { r.judgment.probabilities.secret = 0; }, r => { r.state.seq = -1; }, r => { r.judgment.latency_ms = Infinity; }]) {
        const r = raw(); mutate(r); assert.equal(sanitize(r), null);
    }
    const lower = raw(); lower.choice = lower.judgment.choice = 'east'; assert.equal(sanitize(lower), null);
});

test('known Japanese game names including 炎の杖 pass; unknown names, HTML and arbitrary IDs do not', () => {
    assert.equal(sanitize(menu()).choice.label, 'ニンニク');
    for (const name of ['未知の道具', '<img src=x>', '炎の杖\nsecret']) {
        const r = menu(); r.candidates['select:0'].name = name; assert.equal(sanitize(r), null);
    }
    const r = raw(); r.candidates['<script>'] = {}; r.judgment.probabilities['<script>'] = 0; assert.equal(sanitize(r), null);
    assert.equal(sanitize(raw(), { runId: '../secret' }), null);
});

test('missing or invalid HP remains unknown, never inferred from a later observation', () => {
    for (const player of [{}, { hp: 1, max_hp: 0 }, { hp: '35', max_hp: 100 }, { hp: 100, max_hp: 35 }, { hp: -1, max_hp: 100 }]) {
        const r = raw(); r.state.player = player; assert.equal(sanitize(r).hpPercent, null);
    }
    const r = raw(); r.state.player = { hp: 0, max_hp: 100 }; assert.equal(sanitize(r).hpPercent, 0);
});

test('expired/future timestamps, impossible timing and invalid public labels fail closed', () => {
    assert.equal(sanitize(raw(), { recordedAt: NOW - 2000 }), null);
    assert.equal(sanitize(raw(), { recordedAt: NOW + 101 }), null);
    const r = raw(); r.decision_started_ms = r.elapsed_ms + 1; assert.equal(sanitize(r), null);
    const d = sanitize(raw()); assert.equal(publicGameDecision({ ...d, expiresAt: NOW + 8000 }, NOW), null);
    assert.equal(publicGameDecision({ ...d, choice: { id: 'unknown', label: null } }, NOW), null);
    const tied = raw(); tied.judgment.probabilities = { north: .4, east: .4, south: .15, stay: .05 };
    assert.equal(sanitize(tied).candidates[0].id, 'north');
});

function feedHarness(t) {
    const dir = mkdtempSync(join(tmpdir(), 'noa-decision-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    let now = NOW; const received = [], feed = new RunLogFeed(dir, d => received.push(d), { now: () => now });
    function write(run, content, append = false) {
        mkdirSync(join(dir, run), { recursive: true }); const path = join(dir, run, 'decisions.jsonl');
        (append ? appendFileSync : writeFileSync)(path, typeof content === 'string' ? content : content.map(x => JSON.stringify(x)).join('\n') + '\n');
        utimesSync(path, new Date(now), new Date(now)); return path;
    }
    return { dir, feed, received, write, advance(ms) { now += ms; }, get now() { return now; }, decisions: () => received.filter(x => x.decision).map(x => x.decision) };
}

test('feed adopts observations but never replays recent backlog, restart or bootstrap partial lines', t => {
    const h = feedHarness(t); const partial = JSON.stringify(raw(2));
    h.write('vampire-r1', JSON.stringify(raw(1)) + '\n' + partial.slice(0, 50)); assert.equal(h.feed.poll(), 1); assert.equal(h.decisions().length, 0);
    h.advance(100); h.write('vampire-r1', partial.slice(50) + '\n' + JSON.stringify(raw(3)) + '\n', true); assert.equal(h.feed.poll(), 2);
    assert.deepEqual(h.decisions().map(x => x.attempt), [3]);
    const got = [], restarted = new RunLogFeed(h.dir, d => got.push(d), { now: () => h.now }); restarted.poll();
    assert.equal(got.length, 3); assert.equal(got.some(d => d.decision), false);
});

test('feed rejects duplicate/out-of-order decisions, ages batches and keeps only the newest combat input', t => {
    const h = feedHarness(t); h.write('vampire-r1', []); h.feed.poll(); h.advance(100);
    h.write('vampire-r1', [raw(1), raw(2), raw(3)], true); h.feed.poll(); assert.deepEqual(h.decisions().map(x => x.attempt), [3]);
    h.advance(100); h.write('vampire-r1', [raw(2), raw(3)], true); h.feed.poll(); assert.equal(h.decisions().length, 1);
    h.advance(100); h.write('vampire-r1', [raw(4), { event: 'phase', elapsed_ms: 10000, state: { phase: 'combat' } }], true); h.feed.poll();
    assert.equal(h.decisions().length, 1, 'a later row cannot refresh an old decision');
});

test('planned spoken picks and later applied levelup HUD remain independent; levelup wins a batch', t => {
    const h = feedHarness(t); h.write('vampire-r1', []); h.feed.poll(); h.advance(100);
    const r = menu(1); h.write('vampire-r1', [{ ...r, event: 'choice_planned', applied: false, judgment: undefined }, r, raw(2)], true);
    h.feed.poll(); assert.equal(h.received.filter(x => x.pick).length, 1);
    assert.deepEqual(h.decisions().map(x => [x.attempt, x.phase]), [[1, 'levelup']]);
});

test('new run, truncation and stale partial completion cannot replay a HUD', t => {
    const h = feedHarness(t); h.write('vampire-r1', []); h.feed.poll(); h.advance(100);
    const partial = JSON.stringify(raw(1)); h.write('vampire-r1', partial.slice(0, 50), true); h.feed.poll();
    h.advance(2100); h.write('vampire-r1', partial.slice(50) + '\n', true); h.feed.poll(); assert.equal(h.decisions().length, 0);
    h.write('vampire-r1', [raw(2)], true); h.feed.poll(); assert.equal(h.decisions().length, 1);
    h.advance(100); h.write('vampire-r1', [raw(1)]); h.feed.poll(); assert.equal(h.decisions().length, 1);
    h.advance(100); h.write('vampire-r2', [raw(1)]); h.feed.poll(); assert.equal(h.decisions().length, 1);
    h.advance(100); h.write('vampire-r2', [raw(2)], true); h.feed.poll(); assert.equal(h.decisions().at(-1).runId, 'vampire-r2');
});

test('engine emits only accepted log decisions, rebuilds allowlist and keeps decisions out of status', t => {
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit, jev: {}, conversation: {}, voice: {} });
    assert.equal(Object.hasOwn(e.status(), 'game_decision'), false);
    e.running = true; e.epoch = 7; let accepted = true; const events = [];
    e.blocks = { phase: 'playing', round: { roundId: 'vampire-r1' }, ingest: () => ({ accepted, faces: [] }) };
    e.event = (type, data) => events.push({ type, data });
    const now = Date.now(), d = sanitize(raw(), { recordedAt: now, now }), data = { runId: d.runId, state: raw().state, decision: { ...d, secret: 'never' } };
    e.ingestGame(data); assert.equal(events.length, 0, 'renderer reports cannot forge feed provenance');
    accepted = false; e.ingestGame(data, { fromLog: true }); assert.equal(events.length, 0);
    accepted = true; e.ingestGame(data, { fromLog: true }); assert.equal(events.length, 1); assert.equal(events[0].type, 'game_decision');
    assert.equal(events[0].data.epoch, 7); assert.equal(events[0].data.secret, undefined);
    e.ingestGame(data, { fromLog: true }); assert.equal(events.length, 1);
    e.blocks.phase = 'results'; const d2 = sanitize(raw(2), { recordedAt: now, now });
    e.ingestGame({ ...data, decision: d2 }, { fromLog: true }); assert.equal(events.length, 1);
    e.blocks.phase = 'playing'; e.running = false; e.ingestGame({ ...data, decision: d2 }, { fromLog: true }); assert.equal(events.length, 1);
});

test('purpose-labelled early actions from the controller are shown with fixed Japanese wording; unknown ids are not', () => {
    const r = raw(3, { choice: 'maintain_attack_A', candidates: { maintain_attack_A: {}, align_enemy_B: {}, relocate_open_area: {} },
        judgment: { choice: 'maintain_attack_A', confidence: .8, probabilities: { maintain_attack_A: .7, align_enemy_B: .2, relocate_open_area: .1 }, latency_ms: 80, model: 'm' } });
    const d = sanitize(r);
    assert.ok(d, 'accepted');
    assert.equal(d.choice.label, '攻撃位置を保つ');
    assert.deepEqual(d.candidates.map(c => c.label), ['攻撃位置を保つ', '攻撃位置を合わせる', '場所を変える']);
    const unknown = raw(4, { choice: 'teleport_A', candidates: { teleport_A: {}, east: {} }, judgment: { choice: 'teleport_A', confidence: .9, probabilities: { teleport_A: .9, east: .1 }, latency_ms: 80, model: 'm' } });
    assert.equal(sanitize(unknown), null, 'no free text reaches the stream');
});
