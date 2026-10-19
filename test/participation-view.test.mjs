import test from 'node:test';
import assert from 'node:assert/strict';
import { participationView, participationRows } from '../public/participation-view.mjs';
const playing = { running: true, streamTarget: 'simulcast', youtube: 'connected', twitch: 'connected', gameShow: { external: true, statusKey: 'vampire' }, vampire: { phase: 'playing', personalBest: 127 } };
test('viewer invitation follows the selected receivers and is withdrawn when unavailable or stopped', () => {
    assert.match(participationView(playing).welcome, /チャットでゲームに参加してノアを助けて/);
    // The stream transport reports 'listening' while the chat is open and quiet: that is connected.
    assert.doesNotMatch(participationView({ ...playing, youtube: 'listening' }).detail, /一部/);
    assert.match(participationView({ ...playing, youtube: 'budget_waiting' }).detail, /一部/);
    const waiting = participationView({ ...playing, streamTarget: 'youtube', youtube: 'budget_waiting' });
    assert.doesNotMatch(waiting.welcome, /コメント/);
    assert.match(waiting.detail, /お休み/);
    assert.match(participationView({ ...playing, commentsPaused: true }).detail, /お休み/);
    assert.equal(participationView({ ...playing, running: false }).visible, false);
    assert.equal(participationView({ ...playing, panic: true }).visible, false);
});
test('the on-screen goal uses real records, and only a currently aired prompt can appear', () => {
    // Today's goal from the settings (GAME_GOAL) while playing; the old fixed goal only without one.
    assert.equal(participationView({ ...playing, gameShow: { ...playing.gameShow, goal: 'ガロの塔のレリック' } }).context, '目標：ガロの塔のレリック');
    assert.match(participationView(playing).context, /^目標：/);
    const s = { ...playing, vampire: { phase: 'intermission', participation: { text: '今の気分を絵文字ひとつで', startedAt: 100, expiresAt: 200 } } };
    assert.equal(participationView(s, 99).question, '');
    assert.match(participationView(s, 100).question, /気分/);
    assert.equal(participationView(s, 200).question, '');
    assert.equal(participationView({ ...s, commentsPaused: true }, 150).question, '');
    assert.equal(participationView({ ...s, youtube: 'budget_waiting', twitch: 'stopped' }, 150).question, '');
    assert.match(participationView({ ...playing, vampire: { phase: 'lobby' } }).context, /雑談/);
});
test('participation display keeps missing measurements unknown and labels bounded counts', () => {
    const rows = participationRows({ youtube: { received: 5, approved: 3, replied: 2, uniqueParticipants: 2, uniqueParticipantsIsLowerBound: true, responseLatencyMs: { samples: 2, p50: 1234, p95: 3456 } } });
    assert.equal(rows[0].participants, '2以上');
    assert.match(rows[0].latency, /1.2秒/);
    assert.equal(rows[1].received, '—');
    assert.equal(rows[1].latency, '未測定');
});
