import test from 'node:test';
import assert from 'node:assert/strict';
import { gameAction, publicGameAction, ACTION_LOG_SIZE } from '../src/game-decision.mjs';
import { ActionLogView } from '../public/action-log-view.mjs';

const head = (meets, extra = {}) => ({ minimum_enemy_clearance: meets ? .5 : .2, meets_clearance_margin: meets, experience_progress: 0, ...extra });
const move = (choice, candidates, seq = 1, elapsed = 221.6) => ({ event: 'decision', applied: true, phase: 'combat', choice,
    state: { game: 'vampire_survivors', seq, elapsed }, candidates, judgment: { model: 'local-chooser-v2', probabilities: { [choice]: 1 } } });

test('a command becomes a fixed-wording action with the reason from the logged candidate facts', () => {
    const cands = { north: head(true, { chest_progress: .2 }), east: head(true, { experience_progress: .4 }), south: head(false) };
    assert.deepEqual(publicGameAction(gameAction(move('north', cands))), { seq: 1, t: 221, kind: 'move', arrow: '↑', text: '宝箱へ' });
    assert.equal(publicGameAction(gameAction(move('east', cands))).text, '近くの宝石へ');
    assert.equal(publicGameAction(gameAction(move('south', cands))).text, '宝石へ（すき間）');
    const trapped = { north: head(false), stay: head(false) };
    assert.equal(publicGameAction(gameAction(move('north', trapped))).text, '包囲から脱出');
    const field = { west: head(true, { gem_field_progress: .3 }), stay: head(true) };
    assert.deepEqual(publicGameAction(gameAction(move('west', field))), { seq: 1, t: 221, kind: 'move', arrow: '←', text: '宝石の山へ' });
    assert.equal(publicGameAction(gameAction(move('stay', field))).text, '空いている方へ');
});

test('level-ups name only known items; unknown text and shapes never cross the boundary', () => {
    const up = { ...move('select:1', {}), phase: 'levelup', candidates: { 'select:0': { name: '炎の杖' }, 'select:1': { name: '雷の指輪', next_level: 3 } } };
    assert.deepEqual(publicGameAction(gameAction(up)), { seq: 1, t: 221, kind: 'levelup', arrow: '★', text: '雷の指輪 Lv3' });
    up.candidates['select:1'].name = '<script>';
    assert.equal(gameAction(up), null);
    assert.equal(gameAction({ ...move('north', { north: head(true) }), applied: false }), null);
    assert.equal(gameAction({ ...move('north', { north: head(true) }), state: { game: 'other', seq: 1, elapsed: 1 } }), null);
    assert.equal(publicGameAction({ seq: 1, t: 1, kind: 'move', dir: 'north', reason: 'made_up' }), null);
    assert.equal(publicGameAction({ seq: 1, t: 1, kind: 'levelup', name: 'ニンニク', level: 99 }), null);
});

function view() {
    const doc = { createElement(tag) { return { tag, ownerDocument: doc, hidden: false, className: '', textContent: '', children: [],
        append(...els) { this.children.push(...els); }, replaceChildren(...els) { this.children = els; } }; } };
    const root = doc.createElement('aside'); const v = new ActionLogView(root);
    v.setState({ running: true, phase: 'playing', runId: 'vampire-r1', epoch: 1 });
    return { v, root };
}

test('the stage panel shows the last commands as plain text and hides outside a playing run', () => {
    const { v, root } = view();
    const items = [{ seq: 1, t: 61, kind: 'move', arrow: '↑', text: '宝箱へ' }, { seq: 2, t: 62, kind: 'levelup', arrow: '★', text: '雷の指輪 Lv3' }];
    assert.equal(v.update({ runId: 'vampire-r1', epoch: 1, items }), true);
    assert.equal(root.hidden, false);
    assert.deepEqual(v.list.children.map(li => li.children.map(s => s.textContent)), [['1:01', '↑', '宝箱へ'], ['1:02', '★', '雷の指輪 Lv3']]);
    assert.equal(v.update({ runId: 'other', epoch: 1, items }), false);
    assert.equal(v.update({ runId: 'vampire-r1', epoch: 1, items: [{ ...items[0], text: '<b>' }] }), false);
    assert.equal(v.update({ runId: 'vampire-r1', epoch: 1, items: Array(ACTION_LOG_SIZE + 1).fill(items[0]) }), false);
    v.setState({ phase: 'lobby' }); assert.equal(root.hidden, true);
    assert.equal(v.update({ runId: 'vampire-r1', epoch: 1, items }), false);
});

test('the engine sends the run\'s last commands at most twice a second, only from the log and only while playing', async t => {
    const { TalkEngine } = await import('../src/talk-engine.mjs');
    const { setup, ledger, audit } = await import('./helpers.mjs');
    const c = setup(t, { SHOW_PROFILE: 'talk', SHOW_PROGRAMME: 'noa-vampire', READ_COMMENTS: 'false' });
    const e = new TalkEngine(c, { ledger: ledger(), audit, jev: {}, conversation: {}, voice: {} });
    e.running = true; e.epoch = 3; const events = [];
    e.blocks = { phase: 'playing', round: { roundId: 'vampire-r1' }, ingest: () => ({ accepted: true, faces: [] }) };
    e.event = (type, data) => events.push({ type, data });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const action = seq => ({ seq, t: seq, kind: 'move', dir: 'north', reason: 'chest' });
    e.ingestGame({ runId: 'vampire-r1', state: {}, action: action(1) });
    t.mock.timers.tick(600); assert.equal(events.length, 0, 'a renderer report cannot add commands');
    for (let s = 1; s <= 7; s++) e.ingestGame({ runId: 'vampire-r1', state: {}, action: action(s) }, { fromLog: true });
    e.ingestGame({ runId: 'vampire-r1', state: {}, action: action(7) }, { fromLog: true });
    assert.equal(events.length, 0); t.mock.timers.tick(500);
    assert.equal(events.length, 1); assert.equal(events[0].type, 'game_actions');
    assert.deepEqual(events[0].data.items.map(a => a.seq), [3, 4, 5, 6, 7]);
    assert.deepEqual(events[0].data.items[0], { seq: 3, t: 3, kind: 'move', arrow: '↑', text: '宝箱へ' });
    e.blocks.phase = 'results'; e.ingestGame({ runId: 'vampire-r1', state: {}, action: action(8) }, { fromLog: true });
    t.mock.timers.tick(600); assert.equal(events.length, 1);
});
