import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AffectEngine } from '../src/affect-engine.mjs';

test('AffectEngine initializes with baseline and decays smoothly', () => {
    const t0 = 1000000;
    const ae = new AffectEngine({}, t0);
    const snap = ae.snapshot(t0);
    assert.equal(snap.frustration, 0);
    assert.equal(snap.tilt, 0);
    assert.ok(snap.blush < 0.15); // baseline blush from arousal
    assert.ok(snap.happy >= 0.4 && snap.happy <= 0.7);

    // Apply frustration spike
    ae.delta({ frustration: 0.8 }, t0 + 1000);
    assert.equal(ae.state.frustration, 0.8);

    // Decay after 25 seconds (1 tau)
    ae.decay(t0 + 1000 + 25000);
    assert.ok(ae.state.frustration < 0.35, `decayed frustration should be around 0.8 * e^-1 ~ 0.29, got ${ae.state.frustration}`);
});

test('AffectEngine appraises game events correctly', () => {
    const t0 = 1000000;
    const ae = new AffectEngine({}, t0);
    // Game over increases frustration, sadness, tilt
    ae.appraiseGameEvent('game_over', { isStreak: true }, t0 + 1000);
    assert.ok(ae.state.frustration >= 0.5);
    assert.ok(ae.state.tilt >= 0.5);
    assert.ok(ae.state.sadness >= 0.2);

    // Turnaround drops frustration and tilt
    ae.appraiseGameEvent('turnaround', {}, t0 + 2000);
    assert.ok(ae.state.joy >= 0.6);
    assert.ok(ae.state.tilt <= 0.3);
    assert.ok(ae.state.frustration <= 0.3);
});

test('Mixed emotion: blush differentiates compliment vs rage', () => {
    const t0 = 1000000;
    // 1. Compliment -> shy blush
    const ae1 = new AffectEngine({}, t0);
    ae1.appraiseComment('ノアちゃん可愛い！上手！', 'positive', t0 + 500);
    const d1 = ae1.derived();
    assert.ok(d1.blush > 0.15, 'compliment triggers blush');
    assert.equal(d1.isRageBlush, false);

    // 2. Repeated failure -> rage blush
    const ae2 = new AffectEngine({}, t0);
    ae2.delta({ frustration: 0.8, arousal: 0.8, embarrassment: 0.6 }, t0 + 500);
    const d2 = ae2.derived();
    assert.ok(d2.blush > 0.6);
    assert.equal(d2.isRageBlush, true);
});

test('Hysteresis: rage persists without chatter', () => {
    const t0 = 1000000;
    const ae = new AffectEngine({}, t0);
    // Spike anger
    ae.delta({ frustration: 0.85 }, t0 + 1000);
    ae.decay(t0 + 1900); // 900ms passed (> 800ms) -> enters rage
    assert.equal(ae.rageActive, true);

    // Frustration drops a bit (0.50), still above exit threshold (0.40)
    ae.state.frustration = 0.50;
    ae.decay(t0 + 3000);
    assert.equal(ae.rageActive, true, 'remains in rage');

    // Drops below exit threshold (0.30), needs 3.5s
    ae.state.frustration = 0.30;
    ae.state.anger = 0.10;
    ae.decay(t0 + 4000); // 1s passed
    assert.equal(ae.rageActive, true, 'has not exited yet');

    ae.decay(t0 + 8000); // 5s passed (> 3.5s)
    assert.equal(ae.rageActive, false, 'safely exited rage after cool-off');
});

test('Speech style generation provides rich prompt directives', () => {
    const t0 = 1000000;
    const ae = new AffectEngine({}, t0);
    ae.delta({ frustration: 0.85, tilt: 0.7 }, t0 + 1000);
    const prompt = ae.speechStyle(t0 + 1050);
    assert.ok(prompt.includes('イライラ'));
    assert.ok(prompt.includes('短文'));
    assert.ok(prompt.includes('いや待って待って'));
});

test('tone: two deaths in a row with a surround on top make Noa frustrated, then angry; it cools down', () => {
    const now = 1_000_000, a = new AffectEngine({}, now);
    assert.equal(a.tone(now), null);
    a.appraiseGameEvent('game_over', { isStreak: true }, now);
    assert.equal(a.tone(now + 1000), 'frustrated');
    a.appraiseGameEvent('surrounded', {}, now + 2000);
    a.appraiseGameEvent('hp_low', {}, now + 2500);
    assert.equal(a.tone(now + 4000), 'rage');
    a.tone(now + 600000); // the rage hysteresis lets go after 3.5 s of calm
    assert.equal(a.tone(now + 604000), null, 'ten minutes later she is calm again');
});
