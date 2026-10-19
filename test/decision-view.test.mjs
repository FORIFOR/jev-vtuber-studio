import test from 'node:test';
import assert from 'node:assert/strict';
import { DecisionView } from '../public/decision-view.mjs';

function harness({ nativeTimers = false } = {}) {
    let now = 1000000, serial = 0; const timers = new Map();
    const doc = { createElement(tag) { return { tag, ownerDocument: doc, hidden: false, dataset: {}, children: [], textContent: '',
        appendChild(el) { this.children.push(el); }, replaceChildren(...els) { this.children = els; } }; } };
    const root = doc.createElement('section'); const view = new DecisionView(root, { now: () => now, ...(nativeTimers ? {} : {
        setTimer(fn, ms) { timers.set(++serial, { fn, at: now + ms }); return serial; }, clearTimer(id) { timers.delete(id); } }) });
    const state = { running: true, phase: 'playing', runId: 'vampire-r1', epoch: 1 }; view.setState(state);
    const decision = (seq, extra = {}) => ({ version: 1, applied: true, id: `vampire-r1:${seq}:${seq}`, sequence: seq, attempt: seq,
        runId: 'vampire-r1', phase: 'combat', epoch: 1, recordedAt: now, expiresAt: now + 2000, hpPercent: 35,
        choice: { id: 'north', label: '上へ移動' }, candidates: [{ id: 'north', label: '上へ移動', probability: .6 }, { id: 'east', label: '右へ移動', probability: .4 }], ...extra });
    function advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } }
    return { view, root, timers, state, decision, advance, get now() { return now; } };
}

test('HUD renders bounded plain text, pre-input HP and distribution, then expires within two seconds', () => {
    const h = harness(); assert.equal(h.root.hidden, true); assert.equal(h.view.push(h.decision(1)), true);
    assert.equal(h.root.hidden, false); assert.equal(h.view.parts.choice.textContent, '上へ移動 · 入力受付済み');
    assert.equal(h.view.parts.note.textContent, '候補の選択分布 · 上位3件まで'); assert.equal(h.view.parts.hp.textContent, '判断前のHP 35%');
    assert.equal(h.view.parts.candidates.children[0].children[1].textContent, '60%');
    assert.equal(h.view.parts.candidates.children[0].dataset.selected, 'true');
    h.advance(1999); assert.equal(h.root.hidden, false); h.advance(1); assert.equal(h.root.hidden, true); assert.equal(h.timers.size, 0);
});

test('high-frequency combat uses an eight-second cooldown and consumes suppressed sequences', () => {
    const h = harness(); h.view.push(h.decision(1)); h.advance(500); const dropped = h.decision(2);
    assert.equal(h.view.push(dropped), false); h.advance(1500); assert.equal(h.root.hidden, true);
    h.advance(6000); assert.equal(h.view.push({ ...dropped, recordedAt: h.now, expiresAt: h.now + 2000 }), false);
    assert.equal(h.view.push(h.decision(3)), true);
});

test('levelup replaces combat immediately but cannot flicker another levelup or reset its timer', () => {
    const h = harness(); h.view.push(h.decision(1)); h.advance(200);
    assert.equal(h.view.push(h.decision(2, { phase: 'levelup' })), true); h.advance(200);
    assert.equal(h.view.push(h.decision(3, { phase: 'levelup' })), false);
    h.advance(1799); assert.equal(h.root.hidden, false); h.advance(1); assert.equal(h.root.hidden, true);
    assert.equal(h.view.push(h.decision(4)), false);
});

test('absolute expiry and repeated state snapshots do not lengthen display', () => {
    const h = harness(); const old = h.decision(1); h.advance(1500); assert.equal(h.view.push(old), true);
    h.view.setState(h.state); h.advance(499); assert.equal(h.root.hidden, false); h.advance(1); assert.equal(h.root.hidden, true);
    assert.equal(h.view.push(old), false);
});

test('stop, phase change, connection clear and run or epoch switch hide and cancel the timer', () => {
    for (const state of [{ running: false }, { phase: 'results' }, { runId: 'vampire-r2' }, { epoch: 2 }]) {
        const h = harness(); const d = h.decision(1); h.view.push(d); h.view.setState({ ...h.state, ...state });
        assert.equal(h.root.hidden, true); assert.equal(h.timers.size, 0); assert.equal(h.view.push(d), false);
    }
    const h = harness(), d = h.decision(1); h.view.push(d); h.view.clear(); assert.equal(h.root.hidden, true); assert.equal(h.view.push(d), false);
    h.view.dispose(); h.advance(9000); assert.equal(h.view.push(h.decision(2)), false); assert.equal(h.timers.size, 0);
});

test('stale, malformed, cross-run, duplicate and out-of-order events stay hidden', () => {
    for (const extra of [{ applied: false }, { expiresAt: 1005000 }, { recordedAt: 1001000, expiresAt: 1003000 },
        { candidates: Array(4).fill({ id: 'north', label: '上', probability: .25 }) }, { choice: { id: 'north', label: '<script>' } },
        { candidates: [{ id: 'north', label: '上', probability: NaN }] }, { runId: 'old-run' }, { epoch: 0 }]) {
        const h = harness(); assert.equal(h.view.push(h.decision(1, extra)), false); assert.equal(h.root.hidden, true);
    }
    const h = harness(); h.view.push(h.decision(2)); h.advance(8000);
    assert.equal(h.view.push(h.decision(1)), false); assert.equal(h.view.push(h.decision(2)), false);
});

test('disconnect/reconnect in the same run preserves consumed sequences and the combat cooldown', () => {
    for (const disconnect of [{ running: false }, { running: false, runId: null }]) {
        const h = harness(), d = h.decision(1); h.view.push(d); h.view.setState(disconnect); h.advance(200); h.view.setState(h.state);
        assert.equal(h.view.push(d), false); assert.equal(h.view.push(h.decision(2)), false);
        h.advance(7800); assert.equal(h.view.push(h.decision(3)), true);
    }
});

test('default browser timers are called as globals rather than with DecisionView as their receiver', () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout; let scheduled = 0, cleared = 0;
    try {
        globalThis.setTimeout = function (fn, ms) { assert.equal(this, undefined); assert.equal(ms, 2000); scheduled++; return 42; };
        globalThis.clearTimeout = function (id) { assert.equal(this, undefined); assert.equal(id, 42); cleared++; };
        const h = harness({ nativeTimers: true }); assert.equal(h.view.push(h.decision(1)), true); h.view.clear();
        assert.equal(scheduled, 1); assert.equal(cleared, 1); assert.equal(h.root.hidden, true);
    } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
