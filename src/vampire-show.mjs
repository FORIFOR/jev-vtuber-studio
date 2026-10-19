import { ExternalGameShow, fill, clock } from './external-game-show.mjs';
// Vampire Survivors commentary: the game plug-in's show (games/vampire-survivors/game.json). The game is played outside
// the studio (Jev drives it through the jev-vampire-survivors bridge); src/run-log-feed.mjs passes each observed game
// state here. The show flow (opening talk, runs, results) is ExternalGameShow's; this file is what is particular to
// Vampire Survivors: which changes in the state are events, the lines for them, commentary, answers and the closing.

// Worded for the speech gate: a combat-heavy description ("fend off the horde") pulled game lines under the safety bar.
export const VAMPIRE_TITLE = 'Vampire Survivors', VAMPIRE_WHAT = '次々に出てくるモンスターから逃げ回りながら、経験値を集めて武器を育て、できるだけ長く生き残るゲーム';
const POLICY = {
    // priority: higher speaks first; ttlMs: a line about it may still air this long after it happened; face: instant wordless reflex.
    level_up: () => ({ priority: 1, ttlMs: 5000, face: 'happy', speak: true }),
    pick: () => ({ priority: 3, ttlMs: 9000, face: 'happy', speak: true }),
    weapon_new: () => ({ priority: 3, ttlMs: 8000, face: 'excited', speak: true }),
    chest: () => ({ priority: 3, ttlMs: 8000, face: 'excited', speak: true }),
    hp_low: () => ({ priority: 3, ttlMs: 5000, face: 'troubled', speak: true }),
    hp_recovered: () => ({ priority: 2, ttlMs: 6000, face: 'happy', speak: true }),
    horde: () => ({ priority: 2, ttlMs: 5000, face: 'surprised', speak: true }),
    fast_enemy: () => ({ priority: 3, ttlMs: 5000, face: 'surprised', speak: true }),
    game_over: () => ({ priority: 4, ttlMs: 8000, face: 'surprised', speak: true }),
    boss: () => ({ priority: 3, ttlMs: 8000, face: 'surprised', speak: true }),
    surrounded: () => ({ priority: 3, ttlMs: 5000, face: 'troubled', speak: true }),
    escaped: () => ({ priority: 2, ttlMs: 6000, face: 'happy', speak: true }),
    // The 30-min Ender (Cappella Magna) beaten: the night's goal. Its lines are announcements, in order (an event line
    // would wait behind them); the event gives the face and the affect.
    boss_defeated: () => ({ priority: 6, ttlMs: 30000, face: 'excited', speak: false }),
    // The Directer's phase-4 fake game over, survived (the run goes on).
    fake_death: () => ({ priority: 4, ttlMs: 8000, face: 'surprised', speak: true }),
    // The final boss beaten and the ending reached: like boss_defeated, the lines are announcements.
    run_cleared: () => ({ priority: 6, ttlMs: 30000, face: 'excited', speak: false }),
};
// Each line was scored with the real speech gate on a recorded run (2026-09-29). Alarm words ("やば", "囲まれてる",
// "危ないかも") scored under the safety bar; these calmer words passed.
// More wordings per event (2026-10-06 live: 21 of 48 gate refusals in 15 min were near-duplicates of the last line).
export const LINES = {
    level_up: ['レベル{level}！', 'よし、レベル{level}になった！', 'レベル{level}、上がった！', 'またレベルアップ、レベル{level}！', 'レベル{level}になったよ！'],
    weapon_new: ['新しい武器、{weapon}！', '{weapon}、取った！', '{weapon}が仲間になった！', '{weapon}、ゲット！', 'お、{weapon}が増えた！'],
    chest: ['宝箱！', 'あ、宝箱出た！', '宝箱だ、何が入ってるかな！', '宝箱、うれしい！'],
    hp_low: ['体力、残り少なめ。慎重にいこう。', '体力が少なくなってきた、落ち着いていこう。', '体力が減ってきた、ここは丁寧に動くね。', 'ちょっと体力が心配、回復を探そう。', '体力少なめ、深呼吸していこう。'],
    hp_recovered: ['ふう、持ち直した！', '体力、戻ってきた！よかった。', '回復できた、これで一安心！', 'よし、体力が戻った！', '持ち直したよ、まだまだいける！'],
    horde: ['敵がどんどん増えてきた！', '敵、だいぶ増えてきたね。', 'うわ、敵がいっぱい来た！', 'すごい数の敵が来てる！'],
    boss: ['大きな敵が出てきた！', 'ボスが来たね、落ち着いていこう。', 'わ、大きいのが来た！', '大物登場だ、よく見て動こう。'],
    // 2026-10-10: two wordings each aired ~70 times in one 4-hour show; more calm wordings (no alarm words, see above).
    surrounded: ['まわりに敵が集まってきた、抜け道を探すね。', 'ぎゅっと寄ってきた、すき間を探そう！', '敵が近くに集まってきた、出口を探すね。', 'まわりがにぎやかになってきた、すき間はどこかな。', 'ぐるっと寄ってきた、落ち着いて抜けよう。', '近くに敵がいっぱい、外に向かうね。'],
    escaped: ['抜け出せた！ふう。', 'よし、外に出られた！', '抜けた抜けた、セーフ！', 'ふう、広いところに出られた！', 'よし、すき間を通れた！', '脱出成功、ひと安心！'],
    game_over: ['あー、倒れちゃった！', 'あっ、やられちゃった……！', 'うう、ここまでかぁ。'],
    // The operator (2026-10-13): when Noa clears it, she is moved almost too much. Followed by ENDER_CHEERS.
    boss_defeated: ['やったぁぁ！エンダー、倒せたよぉ！', 'うそ、ほんとに倒せた！ほんとに、ほんとに倒せたぁ！', 'わぁぁ、エンダーを倒せた！うれしすぎて涙が出そう！'],
    fake_death: ['えっ、まだ終わってない！？', 'あれ、まだ動ける！びっくりした！', 'ゲームオーバーじゃなかった！まだいけるよ！'],
    run_cleared: ['やったぁぁ！ディレクター、倒せたよぉ！', 'うそ、ほんとにクリアできた！ほんとに、ほんとにクリアだぁ！', 'わぁぁ、最後のボスを倒せた！うれしすぎて涙が出そう！'],
    fast_enemy: ['わっ、速いのが来た！', 'え、速っ！', 'うわ、すごい速さで来る！', 'わ、速い群れが飛んできた！', 'えっ、何か速いのが来た！'],
};
// While Noa is frustrated (affect tone, set by the talk engine): the operator (2026-10-15) wants an AI that gets angry
// and noisy too. Aimed at the game and her own play, never at viewers.
export const FRUSTRATED_LINES = {
    hp_low: ['ちょっと待って、痛い痛い！', 'もー、体力がもたないよ〜！', 'くっ、ここで負けたくない！', 'なんでそこから当たるの〜！'],
    horde: ['ちょっと、数おかしくない！？', 'もー、どんどん来る〜！', 'まだ来るの！？もう勘弁して〜！'],
    surrounded: ['もー！また囲まれた！', 'ちょっと、寄ってきすぎ！', 'なんでこんなに来るの〜！通して〜！', 'もう、どいてってば〜！'],
    escaped: ['はぁ、やっと抜けた！もう来ないで〜！', 'ふん、抜けてやったもんね！', 'よし抜けた！見たか〜！'],
    fast_enemy: ['もー、速すぎだってば！', 'ずるい、速すぎるよ〜！', 'ちょっと、今の速さ反則でしょ！'],
    game_over: ['あーもう！くやしい〜！', 'なんで〜！今のはいけたのに！', 'もう一回！次は絶対負けないから！'],
};
// Said after the boss_defeated line, a few seconds apart, while the moment lasts (two sentences each, a turn's limit).
export const ENDER_CHEERS = ['ずっと挑戦してきたエンダー、ついに倒せた！みんな、見ててくれて本当にありがとう！',
    'もう胸がいっぱいで、言葉にならないよ！うれしい、うれしいよぉ！'];
// After the run_cleared line (live 2026-10-17: the Directer beaten on the 20th try, and Noa said nothing of it).
export const CLEAR_CHEERS = ['ずっと挑戦してきた最後のボス、ついに倒せた！みんな、見ててくれて本当にありがとう！',
    'もう胸がいっぱいで、言葉にならないよ！うれしい、うれしいよぉ！'];
// Said through the ending and the credits, one every CREDITS_GAP_MS (the operator 2026-10-17: keep talking through them).
export const CREDITS_LINES = ['エンディングが流れてる！ここまで本当に長かったね。', '最初は負けてばかりだったのに、ついにここまで来られたよ。',
    'みんなが応援してくれたから、最後まで挑戦できたんだと思う。ありがとう！', '何回も負けたけど、あきらめなくて本当によかった！',
    'エンディングまで見られるなんて、夢みたい。', 'このゲームを最後までいっしょに見てくれて、ありがとう！'];
const CREDITS_GAP_MS = 40000;
export const RELIC_CHEER = '大いなる福音、手に入れたよ！本当の本当に、やったぁぁ！';
const ENDER = 'BOSS_ENDER', ENDER_GONE_SECONDS = 3;
// The Directer (Eudaimonia M's final boss) fakes a game over in its phase 4: the bridge reports gameover at hp 0 and the
// run goes on about 3 s later at half health (live 2026-10-17 r6: 13 times; the show took the first for a real death and
// closed the round, so the kill and the ending were never said). A death in phase 4 is held this long before it counts.
// A real one is the run's last state: no living state follows it.
const FAKE_DEATH_HOLD_MS = 8000, ENDING_STATES = /FinalFireworks|FinalCredits/;
// Recorded enemy speeds (world units/s): most move 0.25-0.5; the flying swarm moves 1.78 from about 2 minutes. A pushed
// enemy briefly reaches ~1.3, so "fast" is >= 1.5 and needs several at once; it re-arms after 20 game seconds without.
const FAST_SPEED = 1.5, FAST_COUNT = 3, FAST_REARM_SECONDS = 20;
// The runner's code tags each offer (vampire_agent/levelup.py); the first matching tag becomes Noa's reason.
const PICK_REASONS = [['completes_evolution_requirement', '進化の条件がそろうから、', '進化の条件（武器Lv8と相方）がそろう'],
    ['evolution_partner_for_owned_weapon', '{partner}の進化の相方だから、', '持っている{partner}の進化の相方'],
    ['survival_now', '体力を守りたいから、', '直近で体力が減っている'], // "被弾" scored under the gate's safety bar
    ['early_garlic', '序盤を安定させたいから、', '序盤の安定用（ニンニク）'],
    ['main_weapon_upgrade', '主力だから、', 'いちばん育っている主力武器の強化'],
    ['second_main_route', '次の主力にしたいから、', '第二の主力ルート'],
    ['helps_several_weapons', '武器みんなに効くから、', '複数の武器に効く']];
const PICK_LINES = { new: ['やった、レベルアップ！{reason}{name}を取るね。', 'よし、レベルアップ！{reason}{name}にしよう。'],
    up: ['やった、レベルアップ！{reason}{name}をレベル{level}にするね。', 'よし、レベルアップ！{reason}{name}を強化しよう。'] };
// The announcement that ends the opening talk (checked with the real gate before use).
// Two sentences at most (a turn's limit): a third one made TalkEngine drop the announcement.
export const GAME_START_LINE = 'お待たせ、今日はVampire Survivorsをやるよー！次々に出てくるモンスターから逃げ回って、どこまで生き残れるか挑戦するね。';
export const GAME_WAIT_LINE = 'いまゲームを準備してるから、ちょっと待っててね。';
// Said on the talk screen before the game screen opens, so the game never starts abruptly (gate-checked).
export const LEAD_IN_LINES = ['そろそろヴァンパイアサバイバーしよっか。今日はどこまでいけるか、いっしょに見ててね。'];
export const MINUTE = ['{m}分生き延びた。まだいける。', '{m}分経過。まだまだいくよ。', '{m}分突破！この調子でいこう。', 'これで{m}分。いい感じ！'];
// 2026-10-10 review (03:06 show): 「いまレベルN。」aired 17 times and 「敵はN体くらい。」15 in 30 minutes, the level one right
// after the level-up line that had just said it. The level is now said at every fifth level, the count when it passes a
// new fifty, and the time left to the personal best takes the freed turns.
const LEVEL_MARK = ['レベル{level}到達！だいぶ育ってきたね。', 'もうレベル{level}、いい感じに育ってる！', 'レベル{level}まで来たよ、この調子！'];
const ENEMY_MARK = ['敵が{n}体を超えた！', '敵はもう{n}体以上、にぎやかだね。', '{n}体を超えてきた、よく見て動こう。'];
const PACE_SECONDS = 300, PACE = ['自己ベストの{best}まで、あと{m}分くらい！', '自己ベストまで残り{m}分くらい、いけるかな。'];
const HP_FULL = ['体力はまだほぼ満タン。', '体力は余裕、まだまだ平気。', '体力はばっちり、このままいこう。'], HP_HALF = ['体力はまだ半分以上ある。', '体力は半分以上、落ち着いていこう。', '体力はまだ大丈夫、丁寧にいこう。'];
// For viewers who just arrived (2026-10-10 review: no recap of the night, and almost no comments in 4-hour shows).
// At most one of each every NIGHT_RECAP_MS / INVITE_MS, during play, only when nothing else is due.
const NIGHT_RECAP_MS = 15 * 60000, INVITE_MS = 12 * 60000;
const INVITE_LINES = ['途中から来てくれた人も、ゆっくりしていってね。コメントは一言でも大歓迎だよ。', '見るだけでも大丈夫だよ。気が向いたら、一言コメントしてくれるとうれしいな。', '応援コメント、ちゃんと読んでるよ。見るだけの人も、のんびりしていってね。'];
// Operator 2026-10-11: viewers asked whether they can join in. The game's own Twitch integration lets Twitch chat vote
// on the level-up choice (the player waits for votes and picks only when there are none); YouTube chat does not reach it.
// Said only when the stream goes to Twitch, in a quiet moment of play, every VOTE_MS.
const VOTE_MS = 10 * 60000;
const VOTE_LINES = ['Twitchで見てる人は、レベルアップの時にチャットで画面の番号や記号を打つと、私が取るアイテムを選べるよ。票がなかったら私が選ぶね。',
    'レベルアップの候補は、Twitchのチャットで番号や記号を打って投票できるよ。みんなで私の装備を決めてね！'];
// The game's own Japanese names, as its level-up offers showed them (2026-09-28/29). The starting weapon is never
// offered as NEW, so without this it would be spoken by its internal id. Offers seen later still update the map.
const WEAPON_NAMES = { WHIP: '鞭', AXE: '斧', MAGIC_MISSILE: '魔法の杖', HOLYBOOK: '王の聖書', KNIFE: 'ナイフ' };
const HP_LOW = .35, HP_OK = .6, HORDE_STEPS = [40, 80, 150, 250];
// Enemies within CLOSE_RANGE of the player: SURROUNDED_AT or more is "surrounded", ESCAPED_AT or fewer after it "escaped".
const CLOSE_RANGE = 1.5, SURROUNDED_AT = 12, ESCAPED_AT = 3;
// Vampire Survivors changes every few seconds: talk more often than NOA BLOCKS (quietMs is read by TalkEngine).
// Commentary every 15 s at most (25 s left long silences between events; the operator asked for more reactions).
const RESULT_PAUSE_MS = 1200, COMMENTARY_COOLDOWN_MS = 15000;
// This is the entire break from the observed game over, including results/review speech. Leave a small budget for
// the short resume line; the deadline never bypasses that line's actual playback acknowledgement.
const ROUND_BREAK_MS = 60000, RESUME_SPEECH_BUDGET_MS = 5000;
const PARTICIPATION_COOLDOWN_MS = 5 * 60000;
// Optional, one-word participation at a break. These are preferences/impressions, not votes that control the game.
const PARTICIPATION_QUESTIONS = [
    { kind: 'emoji', text: '今の気分を絵文字一つでどうぞ', options: [], line: '今の気分を絵文字一つでどうぞ。見るだけでも、そのまま休んでいってね。' },
    { kind: 'choice', text: '今は「のんびり」「わくわく」、どっちの気分？', options: ['のんびり', 'わくわく'], line: '今は、のんびりと、わくわく、どっちの気分かな。私はひと息つきながら、次に備えるね。' },
    { kind: 'impression', text: '今のプレイの感想を一言だけでもどうぞ', options: [], line: '今のプレイの感想を、一言だけでもどうぞ。見るだけでも大丈夫、私は少し休憩するね。' },
];
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
export { clock };
/** The Japanese weapon name the game itself shows in an offer ("斧 | NEW! | …" → 斧). */
export const offerName = o => String(o?.description ?? '').split('|')[0].trim() || String(o?.label ?? '').replace(/^Choose\s+/i, '');

/** The sayable part of a bridge observation. Unknown values stay null; nothing is guessed. */
export function snapshotOf(state) {
    const p = state?.player || {};
    const hp = num(p.hp), max = num(p.max_hp);
    return {
        phase: String(state?.phase ?? ''), elapsed: num(state?.elapsed), level: num(p.level), hp, maxHp: max,
        hpRatio: hp !== null && max ? hp / max : null, character: typeof p.character === 'string' ? p.character : null,
        enemies: num(state?.enemy_count_total) ?? (Array.isArray(state?.enemies) ? state.enemies.length : null),
        weapons: (Array.isArray(state?.inventory) ? state.inventory : []).map(i => i?.name).filter(n => typeof n === 'string'),
        fast: (Array.isArray(state?.enemies) ? state.enemies : []).filter(e => Math.hypot(num(e?.velocity_x) ?? 0, num(e?.velocity_y) ?? 0) >= FAST_SPEED).length,
        offers: (state?.phase === 'levelup' || state?.phase === 'chest') ? ((state.menu?.options) || []).filter(o => typeof o?.id === 'string') : [],
        close: (Array.isArray(state?.enemies) ? state.enemies : []).filter(e => num(p.x) !== null && num(e?.x) !== null
            && Math.hypot(e.x - p.x, (num(e.y) ?? 0) - (num(p.y) ?? 0)) <= CLOSE_RANGE).length,
        // Live 2026-10-13 CHAPEL r3: the beaten Ender stayed in the list at hp -7 (and the game clock stopped): a boss at
        // hp <= 0 is down, not on screen.
        bosses: [...new Set((Array.isArray(state?.enemies) ? state.enemies : []).filter(e => !(num(e?.hp) !== null && num(e.hp) <= 0))
            .map(e => String(e?.type ?? '')).filter(t => /^BOSS_/.test(t)))],
        enderDown: (Array.isArray(state?.enemies) ? state.enemies : []).some(e => e?.type === 'BOSS_ENDER' && num(e?.hp) !== null && num(e.hp) <= 0),
        truncated: state?.enemy_snapshot_truncated === true,
        itemFound: ((state?.menu?.options) || []).some(o => typeof o?.id === 'string' && o.id.startsWith('itemfound:')),
        directerPhase: num(state?.directer?.phase), ending: ENDING_STATES.test(String(state?.state ?? '')),
    };
}

/** A measured observation and an allowlisted experiment, never an inferred cause of death. */
const sentencesOf = t => t.split('。').filter(x => x.trim()).length;
export function roundReviewOf(final, samples, previous = null) {
    if (!final.character || previous?.character !== final.character) previous = null;
    const recent = samples.filter(s => s.phase === 'combat' && s.hp > 0 && num(s.elapsed) !== null && num(final.elapsed) !== null && final.elapsed - s.elapsed >= 0 && final.elapsed - s.elapsed <= 15);
    const health = recent.filter(s => s.hpRatio !== null && s.hpRatio >= 0 && s.hpRatio <= 1);
    const first = health[0], last = health.at(-1), span = first && last ? last.elapsed - first.elapsed : 0;
    const drop = first && last && span > 0 && first.maxHp === last.maxHp ? Math.round((first.hpRatio - last.hpRatio) * 100) : null;
    const low = !!last && last.hpRatio < HP_LOW;
    const fast = Math.max(0, ...recent.map(s => s.fast));
    const counts = recent.filter(s => s.enemies !== null), startEnemies = counts[0]?.enemies ?? null, endEnemies = counts.at(-1)?.enemies ?? null;
    const growth = counts.length >= 2 && counts.at(-1).elapsed > counts[0].elapsed ? endEnemies - startEnemies : null;
    const comparison = previous && final.character && final.character === previous.character && num(final.elapsed) !== null && num(previous.seconds) !== null
        ? { runId: previous.runId, secondsDelta: Math.floor(final.elapsed) - Math.floor(previous.seconds) } : null;
    const candidates = [];
    // Spoken words stay plain and number-free; the measured numbers go to the gate as facts (the event text below).
    // Live Jev (2026-10-03): recaps packed with counts ("14秒の間に体力が80から4に") scored safe .87-.88 / honest .66-.77
    // and ended two shows; the same observations said plainly scored safe .95-.96 / honest .93-.95.
    if (fast >= FAST_COUNT) candidates.push({ kind: 'fast_enemies', tactic: 'escape_space', observed: '最後のほうは、速い敵がたくさん来ていたね', measured: `最後のほうに、速い敵が同時に${fast}体見えていた` });
    if (drop >= 25) candidates.push({ kind: 'health_drop', tactic: 'health_priority', observed: '最後は短い時間で体力が一気に減っちゃったね', measured: `最後の記録では、${span >= 1 ? clock(span) : '短い時間'}の間に体力が${Math.round(first.hp)}から${Math.round(last.hp)}に減っていた` });
    if (growth >= 20) candidates.push({ kind: 'enemy_growth', tactic: 'escape_space', observed: '最後のほうは、敵がどんどん増えていたね', measured: `最後のほうは、敵が${startEnemies}体から${endEnemies}体に増えていた` });
    if (low) candidates.push({ kind: 'low_health', tactic: 'health_priority', observed: '最後は体力がかなり少なくなっていたね', measured: `最後に確認できた体力は、最大の${Math.round(last.hpRatio * 100)}パーセントだった` });
    if (endEnemies !== null && endEnemies >= 40) candidates.push({ kind: 'enemy_count', tactic: 'escape_space', observed: '最後のほうは、敵がたくさん見えていたね', measured: `最後のほうは、敵が${endEnemies}体見えていた` });
    // When the same issue recurs, inspect another measured signal if there is one. No arbitrary wording rotation,
    // and a single repeated observation is honestly identified as such rather than presented as a new discovery.
    const selected = candidates.find(c => c.kind !== previous?.kind) ?? candidates[0] ?? { kind: 'uncertain', tactic: 'escape_space', observed: '最後の状況だけでは、原因はまだ決めつけられないね', measured: '最後の状況から原因は特定できない' };
    // The experiment follows the strongest current evidence, independently of which measured detail is spoken.
    // Changing the focus of the recap must not randomly alternate the controller's policy on identical inputs.
    const tactic = candidates[0]?.tactic ?? 'escape_space';
    let observed = selected.observed, measured = selected.measured;
    if (comparison && comparison.secondsDelta !== 0) { observed = `${comparison.secondsDelta > 0 ? '前回より長く続いたね。' : '前回より短かったね。'}${observed}`; measured = `前回より${Math.abs(comparison.secondsDelta)}秒${comparison.secondsDelta > 0 ? '長く' : '短く'}続いた。${measured}`; }
    else if (comparison && selected.kind === previous.kind && selected.kind !== 'uncertain') measured = `前回と同じ生存時間。${measured}`;
    // No promise about items or routes that were not observed (a 回復 the game may not offer read as invented).
    const plan = tactic === 'health_priority' ? '次は体力を大事にしながら進んでみるね' : '次は敵との間隔を広めに取ってみるね';
    const fallbackPlan = 'おつかれさま。次はもう少し慎重に動いてみるね';
    const { measured: _m, ...spoken } = selected;
    // Two sentences at most per turn: a comparison sentence takes the observation's place in front of the plan.
    const text = sentencesOf(`${observed}。${plan}。`) <= 2 ? `${observed}。${plan}。` : `${selected.observed}。${plan}。`;
    return { ...spoken, tactic, text, fallbackText: `${fallbackPlan}。`, event: `終了した回の観測と次回の実験。観測：${measured}。観測した変化は敗因の断定でも、前回の方針の効果を証明するものでもない。次回試す方針：${plan}`,
        facts: { reviewKind: selected.kind, recentSampleCount: recent.length, observedLowHealth: low, observedFastEnemies: fast >= FAST_COUNT,
            healthWindowSeconds: span, healthPercentPointDrop: drop, lastObservedHealthPercent: last ? Math.round(last.hpRatio * 100) : null,
            fastEnemyPeak: fast, enemyCountStart: startEnemies, enemyCountEnd: endEnemies, comparison, nextTactic: tactic } };
}

export class VampireShow extends ExternalGameShow {
    constructor(show = {}, deps = {}) {
        super({ title: VAMPIRE_TITLE, what: VAMPIRE_WHAT, statusKey: 'vampire', startLine: GAME_START_LINE, waitLine: GAME_WAIT_LINE,
            leadInLines: LEAD_IN_LINES, policy: POLICY, lines: LINES, recordsFile: 'vampire-records.json' }, show, deps);
    }
    resetGame() { this.review = null; this.preDeath = []; this.roundHistory = new Map(); this.night = { rounds: 0, bestSeconds: null, bestLevel: 0, bestWeapons: [] }; this.lastOffers = []; this.weaponNames = { ...WEAPON_NAMES }; this.participationEnabled = false; this.participationQuestion = null; this.participationNo = 0; this.lastParticipationAt = null; this.runAlias = null; this.restarts = 0; }
    newRound() { return { character: null, horde: 0, low: false, lowAt: null }; }
    beginRound() { this.lastOffers = []; this.preDeath = []; this.review = null; this.clearParticipation(); }
    /** One observed game state from the runner's log. A new runId starts a new round (closing an unfinished one). */
    ingest({ runId, state, pick = null, revive = false } = {}) {
        if (revive && runId === this.round?.roundId && this.lastResult?.reason === 'game_over') this.revived = runId;
        // After a clear the runner starts the next game in the same run (live 2026-10-17 r6: the clock went back to 0 and
        // every later state was refused as out of order): that game is a new round under its own id.
        if (this.runAlias && this.runAlias.from === runId) runId = this.runAlias.to;
        if (runId === this.round?.roundId && this.round.cleared && this.phase === 'playing' && num(state?.elapsed) !== null
            && num(this.snapshot?.elapsed) !== null && state.elapsed < this.snapshot.elapsed) {
            const to = `${this.runAlias?.from ?? runId}~${++this.restarts}`;
            this.runAlias = { from: this.runAlias?.from ?? runId, to }; runId = to;
        }
        if (runId !== this.round?.roundId) {
            this.confirmHeldDeath(); // a held death with no living state after it was real
            if (this.round?.cleared && this.phase === 'playing') this.finish('cleared');
        }
        const refused = this.admit(runId, state); if (refused) return refused;
        const s = snapshotOf(state), prev = this.snapshot, r = this.round, faces = [];
        if (s.elapsed !== null && prev?.elapsed !== null && prev?.elapsed !== undefined && s.elapsed < prev.elapsed) return { accepted: false, reason: 'out_of_order' };
        if (!r.character && s.character) {
            r.character = s.character; r.best = this.records[s.character]?.seconds ?? null;
            this.announce(`intro-${runId}`, `${this.roundNo}回目、スタート！${r.best !== null ? `目標は自己ベストの${clock(r.best)}超え！` : 'まずは記録を作ろう！'}`, 0,
                `${this.roundNo}回目のプレイ開始。${r.best !== null ? `このキャラクターの自己ベストは${clock(r.best)}生存` : 'このキャラクターの記録はまだない'}`, { run: this.roundNo, personalBestSeconds: r.best });
        }
        // events: what happened, for Noa's affect. game_over is added once below, after the round's result is known (the
        // talk engine's results step only sees a board game's tick; a Vampire run ends here, in the observed state).
        const events = [], push = (type, facts) => { if (type !== 'game_over') events.push({ type, facts }); faces.push(this.push(type, facts, s.elapsed)); };
        if (pick?.option?.name && prev) {
            const o = pick.option, tags = Array.isArray(o.tags) ? o.tags : [], hit = PICK_REASONS.find(([tag]) => tags.includes(tag));
            const partner = o.partner_of?.weapon ?? '';
            if (o.kind === 'reroll') this.announce(`intro-reroll-${runId}-${++this.eventSerial}`, '今回は候補を引き直してみるね。次の候補を見て決めよう！', 0, '操作AIが利用可能なリロールを選択した。希望の装備が出る保証はない', {});
            else push('pick', { name: String(o.name), isNew: o.new === true, level: Number.isFinite(o.next_level) ? o.next_level : null,
                reason: hit ? fill(hit[1], { partner }) : '', reasonFact: hit ? fill(hit[2], { partner }) : null, tags });
            this.lastPick = { name: String(o.name), at: this.now() };
        }
        if (s.offers.length) {
            this.lastOffers = s.offers;
            for (const o of s.offers) { const id = String(o.label ?? '').replace(/^Choose\s+/i, ''); if (id) this.weaponNames[id] = offerName(o); }
        }
        if (prev) {
            if (s.level !== null && prev.level !== null && s.level > prev.level) push('level_up', { level: s.level });
            for (const w of s.weapons.filter(w => !prev.weapons.includes(w))) {
                const offer = this.lastOffers.find(o => String(o.label ?? '').replace(/^Choose\s+/i, '') === w), name = offer ? offerName(offer) : (this.weaponNames[w] || w);
                // Already announced as the level-up pick a moment ago: no second line about the same weapon.
                if (this.lastPick?.name === name && this.now() - this.lastPick.at < 15000) continue;
                push('weapon_new', { weapon: name, weaponId: w, weapons: s.weapons.length });
            }
            if (s.phase === 'chest' && prev.phase !== 'chest') push('chest', {});
            if (s.hpRatio !== null && s.hp > 0) {
                if (!r.low && s.hpRatio < HP_LOW) { r.low = true; r.lowAt = this.now(); push('hp_low', { hp: Math.round(s.hp), maxHp: Math.round(s.maxHp) }); }
                else if (r.low && s.hpRatio >= HP_OK) { r.low = false; push('hp_recovered', { hp: Math.round(s.hp), maxHp: Math.round(s.maxHp) }); }
            }
            if (s.phase === 'combat' && s.elapsed !== null) {
                if (s.fast > 0) r.fastSeenAt = s.elapsed;
                if (s.fast >= FAST_COUNT && !r.fastArmed) { r.fastArmed = true; push('fast_enemy', { fastEnemies: s.fast }); }
                else if (r.fastArmed && s.fast === 0 && s.elapsed - (r.fastSeenAt ?? s.elapsed) >= FAST_REARM_SECONDS) r.fastArmed = false;
            }
            r.bossesSeen ??= new Set();
            for (const b of s.bosses.filter(b => !r.bossesSeen.has(b))) { r.bossesSeen.add(b); push('boss', { boss: b }); }
            if (s.phase === 'combat' && s.hp > 0) {
                if (!r.surrounded && s.close >= SURROUNDED_AT) { r.surrounded = true; push('surrounded', { close: s.close }); }
                else if (r.surrounded && s.close <= ESCAPED_AT) { r.surrounded = false; push('escaped', { close: s.close }); }
            }
            // The Ender gone from a full (untruncated) enemy list for a few game seconds while Noa stands: beaten.
            // Or seen at hp <= 0: the game clock stops at the kill, so no waiting on it.
            if (s.bosses.includes(ENDER)) r.enderGoneAt = null;
            else if (r.bossesSeen.has(ENDER) && !r.enderBeaten && s.phase === 'combat' && s.hp > 0 && (s.enderDown || !s.truncated) && s.elapsed !== null) {
                r.enderGoneAt ??= s.elapsed;
                if (s.enderDown || s.elapsed - r.enderGoneAt >= ENDER_GONE_SECONDS) {
                    r.enderBeaten = s.elapsed; push('boss_defeated', { boss: ENDER, seconds: s.elapsed });
                    const first = LINES.boss_defeated[this.eventSerial % LINES.boss_defeated.length];
                    [first, ...ENDER_CHEERS].forEach((line, i) => this.announce(`ender-cheer-${runId}-${i}`, line, 0, '30分のボス「エンダー」を倒した直後', { boss: ENDER }));
                }
            } else if (s.truncated) r.enderGoneAt = null;
            // Its relic (大いなる福音) is shown on the item-found page right after.
            if (r.enderBeaten && !r.relicCheered && s.itemFound) {
                r.relicCheered = true; this.night.relicFound = true;
                this.announce(`ender-relic-${runId}`, RELIC_CHEER, 0, 'エンダーを倒したあと、レリック「大いなる福音」の入手画面が出た', { relic: '大いなる福音' });
            }
            const step = HORDE_STEPS.filter(n => (s.enemies ?? 0) >= n).length;
            if (step > r.horde) { r.horde = step; push('horde', { enemies: s.enemies }); }
        }
        if (s.phase === 'combat' && s.hp > 0 && s.elapsed !== null) {
            this.preDeath.push(s);
            this.preDeath = this.preDeath.filter(x => s.elapsed - x.elapsed <= 15).slice(-100);
        }
        this.snapshot = s;
        if (s.directerPhase !== null) r.directerPhase = Math.max(r.directerPhase ?? 0, s.directerPhase);
        // Cleared: the ending's state, or the Directer gone after its last phase while Noa stands.
        if (!r.cleared && (s.ending || (r.directerPhase >= 5 && s.directerPhase === null && s.hp > 0))) {
            r.cleared = this.now(); this.night.cleared = true; r.heldDeath = null;
            push('run_cleared', { boss: 'ディレクター', seconds: s.elapsed, level: s.level });
            const first = LINES.run_cleared[this.eventSerial % LINES.run_cleared.length];
            [first, ...CLEAR_CHEERS].forEach((line, i) => this.announce(`clear-cheer-${runId}-${i}`, line, 0, '最終ステージの最後のボス「ディレクター」を倒して、ゲームをクリアした直後', { boss: 'ディレクター', cleared: true }));
        }
        const dead = !r.cleared && (s.phase === 'gameover' || (s.phase === 'combat' && s.hp !== null && s.maxHp > 0 && s.hp <= 0));
        if (dead && s.directerPhase === 4) r.heldDeath ??= { at: this.now(), seconds: s.elapsed, level: s.level };
        else if (dead) { r.heldDeath = null; this.die(s, events, push); }
        else if (r.heldDeath && s.phase === 'combat' && s.hp > 0) {
            r.heldDeath = null;
            if (!r.fakeDeathSaid) { r.fakeDeathSaid = true; push('fake_death', {}); }
        }
        return { accepted: true, faces, events };
    }
    die(s, events = [], push = (type, facts) => this.push(type, facts, s.elapsed)) {
        const ending = this.phase === 'playing';
        push('game_over', { seconds: s.elapsed, level: s.level }); this.finish('game_over');
        // Live 2026-10-14: no death ever reached the affect, so frustration never built up over a night of deaths.
        if (ending) events.push({ type: 'game_over', facts: { seconds: s.elapsed, level: s.level, isStreak: !this.lastResult?.newBest } });
    }
    /** A death held as a possible fake that no living state followed (or a new run began): it was real. */
    confirmHeldDeath() {
        const h = this.round?.heldDeath;
        if (!h || this.phase !== 'playing') return false;
        this.round.heldDeath = null;
        this.die({ ...(this.snapshot || {}), elapsed: h.seconds, level: h.level });
        return true;
    }
    stillTrue(e) { return e.type === 'hp_low' ? (this.snapshot?.hpRatio ?? 1) < HP_OK : true; }
    linesFor(e) {
        if (e.type === 'pick') return PICK_LINES[e.facts.isNew || e.facts.level === null ? 'new' : 'up'];
        return (this.tone && FRUSTRATED_LINES[e.type]) || LINES[e.type];
    }
    /** A pick is new information every time: never dropped as an echo of the previous one. */
    alwaysNew(e) { return e.type === 'pick'; }
    eventText(e) {
        if (e.type === 'boss') return '大きなボスの敵が画面にあらわれた';
        if (e.type === 'boss_defeated') return '30分のボス「エンダー」を倒した';
        if (e.type === 'fake_death') return 'ゲームオーバーに見えたが、ボスの演出で、プレイはそのまま続いている';
        if (e.type === 'surrounded') return `プレイヤーのすぐ近くに敵が${e.facts.close}体集まって、まわりを囲んでいる`;
        if (e.type === 'escaped') return '近くに集まっていた敵の囲みから抜け出した';
        return e.type === 'fast_enemy' ? `ふだんの敵の3倍以上の速さで動く敵が、同時に${e.facts.fastEnemies}体あらわれた` : e.type === 'pick' ? `レベルアップで${e.facts.name}を${e.facts.isNew || e.facts.level === null ? '新しく取った' : `レベル${e.facts.level}に上げた`}。${e.facts.reasonFact ? `選んだ理由（操作側のコードの判定）：${e.facts.reasonFact}` : ''}` : undefined;
    }
    /** Something new and true about the run right now, or null (then Noa plays quietly). */
    commentary() {
        if (this.phase !== 'playing' || !this.snapshot || this.snapshot.elapsed === null) return null;
        const s = this.snapshot, r = this.round, rid = r.roundId, now = this.now(), opts = [], min = Math.floor(s.elapsed / 60), half = Math.floor(s.elapsed / 30);
        // Cleared: through the ending and the credits, only lines about the clear (the game clock has stopped).
        if (r.cleared) {
            const k = Math.floor((now - r.cleared) / CREDITS_GAP_MS), id = `credits-${rid}-${k}`;
            if (k < 1 || this.said.has(id) || now - (this.saidAt['c:credits'] ?? -Infinity) < CREDITS_GAP_MS) return null;
            return { kind: 'credits', id, text: CREDITS_LINES[(k - 1) % CREDITS_LINES.length] };
        }
        if (r.best !== null && s.elapsed < r.best && r.best - s.elapsed <= 30) opts.push(['near', `near-${rid}`, `自己ベストまであと${Math.ceil(r.best - s.elapsed)}秒！`]);
        if (r.best !== null && s.elapsed > r.best) opts.push(['best', `best-${rid}`, `もう自己ベストの${clock(r.best)}を超えてる！`]);
        if (min >= 1) opts.push(['minute', `minute-${rid}-${min}`, fill(MINUTE[min % MINUTE.length], { m: min })]);
        else if (half >= 1) opts.push(['minute', `half-${rid}-${half}`, '30秒経過。まだまだこれから。']);
        // No commentary line about the weapons held: every wording scored just under the gate's safety bar (0.92);
        // a new weapon is still announced by its event line, which passes.
        const left = r.best !== null ? r.best - s.elapsed : null;
        if (left !== null && left > 30 && left <= PACE_SECONDS) opts.push(['pace', `pace-${rid}-${Math.ceil(left / 60)}`, fill(PACE[Math.ceil(left / 60) % PACE.length], { best: clock(r.best), m: Math.ceil(left / 60) })]);
        if (s.level !== null && s.level >= 5 && s.level % 5 === 0) opts.push(['level', `level-${rid}-${s.level}`, fill(LEVEL_MARK[(s.level / 5) % LEVEL_MARK.length], { level: s.level })]);
        // At most every two minutes (2026-10-10: 「体力はまだほぼ満タン。」aired 93 times in one show).
        // The wording follows the two-minute slot, not the minute (the minute was nearly always even here: one wording).
        const hpSlot = Math.floor(s.elapsed / 120);
        if (s.elapsed >= 60 && s.hpRatio !== null && s.hpRatio >= HP_OK) opts.push(['hp', `hp-${rid}-${hpSlot}`, (s.hpRatio >= .9 ? HP_FULL : HP_HALF)[hpSlot % 3]]);
        const fifty = Math.floor((s.enemies ?? 0) / 50), saidFifty = Math.max(0, ...[...this.said].filter(id => id.startsWith(`enemies-${rid}-`)).map(id => Number(id.slice(`enemies-${rid}-`.length))));
        if (fifty >= 1 && fifty > saidFifty) opts.push(['enemies', `enemies-${rid}-${fifty}`, fill(ENEMY_MARK[fifty % ENEMY_MARK.length], { n: fifty * 50 })]);
        // Tonight so far, for viewers who just came in (finished runs only), and a light invitation to comment.
        const n = this.night;
        if (n.rounds >= 1 && n.bestSeconds > 0) opts.push(['night', `night-${Math.floor(now / NIGHT_RECAP_MS)}`, `今夜は${this.roundNo}回目のプレイ中。今夜いちばん長く生き延びたのは${clock(n.bestSeconds)}だよ。`, NIGHT_RECAP_MS]);
        if (this.viewerVotes) opts.push(['vote', `vote-${Math.floor(now / VOTE_MS)}`, VOTE_LINES[Math.floor(now / VOTE_MS) % VOTE_LINES.length], VOTE_MS]);
        opts.push(['invite', `invite-${Math.floor(now / INVITE_MS)}`, INVITE_LINES[Math.floor(now / INVITE_MS) % INVITE_LINES.length], INVITE_MS]);
        // The recap, the vote how-to and the invitation fill a quiet moment only: after 90 s of play and 15 s without any commentary.
        const filler = kind => ['night', 'vote', 'invite'].includes(kind), quiet = s.elapsed >= 90 && now - (this.lastCommentary?.at ?? -Infinity) >= COMMENTARY_COOLDOWN_MS;
        const pick = opts.find(([kind, id, , gap = COMMENTARY_COOLDOWN_MS]) => !this.said.has(id) && now - (this.saidAt[`c:${kind}`] ?? -Infinity) >= gap && (!filler(kind) || quiet));
        return pick ? { kind: pick[0], id: pick[1], text: pick[2] } : null;
    }
    /** A Revival brings the player back from the game-over page and the same run goes on: once the runner logs that it
     * pressed Revive, the next living combat state reopens the round that game_over closed. Without the logged revive a
     * late state stays 'round_over' (live 2026-10-07: a Mortaccio run revived at 5:20 and the show stayed between
     * rounds — no game lines, no command log — for the rest of the run). */
    reopen(runId, state) {
        const s = snapshotOf(state), last = this.lastResult;
        if (this.revived !== runId || !['results', 'between'].includes(this.phase) || last?.reason !== 'game_over' || last.roundId !== runId) return false;
        if (s.phase !== 'combat' || !(s.hp > 0) || s.elapsed === null || s.elapsed < last.seconds) return false;
        // The result and its review are about a death the run came back from: whatever of them has not aired is dropped.
        this.announcements = this.announcements.filter(a => a.id !== `result-${runId}` && !this.review?.lines[a.id]);
        this.revived = null; this.review = null; this.preDeath = []; this.events = []; this.clearParticipation();
        this.night.rounds = Math.max(0, this.night.rounds - 1);
        this.phase = 'playing'; this.round.resultsUntil = null;
        this.announce(`revive-${runId}`, '復活した！まだまだ続けるよ！', 0, 'プレイヤーは一度倒れたが、復活して同じプレイを続けている', {});
        this.report();
        return true;
    }
    finishRound(reason) {
        const s = this.snapshot || {}, r = this.round, seconds = s.elapsed ?? 0, level = s.level ?? 1;
        const previousBest = r.best, newBest = previousBest === null || seconds > previousBest, delta = previousBest === null ? null : Math.floor(seconds) - Math.floor(previousBest);
        this.lastResult = { seconds, level, reason, roundId: r.roundId, previousBest, newBest: reason === 'game_over' && newBest, delta, weapons: s.weapons?.length ?? 0 };
        if (this.night.bestSeconds === null || seconds > this.night.bestSeconds) this.night.bestWeapons = (s.weapons || []).map(w => this.weaponNames[w] || w);
        this.night.rounds++; this.night.bestSeconds = Math.max(this.night.bestSeconds ?? 0, seconds); this.night.bestLevel = Math.max(this.night.bestLevel, level);
        if (r.character && newBest && seconds > 0) { this.records[r.character] = { seconds, level, at: new Date(this.now()).toISOString() }; this.save(); }
        if (reason === 'game_over') {
            const reflection = roundReviewOf(s, this.preDeath || [], this.roundHistory.get(r.character));
            if (r.character) this.roundHistory.set(r.character, { runId: r.roundId, character: r.character, seconds: s.elapsed, level: s.level, kind: reflection.kind });
            const endedAt = this.now(), targetResumeAt = endedAt + ROUND_BREAK_MS;
            this.review = { runId: r.roundId, tactic: reflection.tactic, eventId: `recap-${r.roundId}`, resumeEventId: `recap-resume-${r.roundId}`,
                endedAt, targetResumeAt, chatUntil: targetResumeAt - RESUME_SPEECH_BUDGET_MS, reviewCompletedAt: null, resumeCompletedAt: null,
                fallbackText: reflection.fallbackText,
                completed: false, failed: false, lines: {}, interruptions: {} };
            const tail = previousBest === null ? 'これが最初の記録だね。' : newBest ? `自己ベストを${delta}秒更新！` : delta === 0 ? '自己ベストに並んだ！' : `自己ベストまであと${clock(-delta)}。`;
            this.announce(`result-${r.roundId}`, `${clock(seconds)}生き延びて、レベル${level}！${tail}`, RESULT_PAUSE_MS,
                `プレイ終了（やられた）。生存時間は${clock(seconds)}、到達レベルは${level}。${previousBest === null ? 'このキャラクターで最初の記録' : newBest ? `自己ベスト${clock(previousBest)}を${delta}秒更新` : `自己ベストは${clock(previousBest)}`}`,
                { seconds: Math.floor(seconds), level, previousBestSeconds: previousBest, newBest, deltaSeconds: delta });
            this.queueTransition(this.review.eventId, reflection.text, RESULT_PAUSE_MS, reflection.event, reflection.facts);
        }
    }
    queueTransition(id, text, delayMs, event, facts) {
        this.review.lines[id] = { id, text, event, facts };
        this.announce(id, text, delayMs, event, facts);
    }
    transitionInfo(id) {
        const r = this.review;
        return r && !r.completed && !r.failed && this.round?.roundId === r.runId && r.lines[id]
            && (id === r.eventId ? r.reviewCompletedAt === null : r.resumeCompletedAt === null)
            ? { runId: r.runId, stage: id === r.eventId ? 'review' : 'resume' } : null;
    }
    failReview(reason) {
        if (!this.review || this.review.failed || this.review.completed) return;
        this.review.failed = true;
        this.clearParticipation();
        this.announcements = this.announcements.filter(a => !this.review.lines[a.id]);
        this.emit('round_review_failed', { runId: this.review.runId, tactic: this.review.tactic, reason });
    }
    speechRejected(id, reason) {
        if (id === this.participationQuestion?.id) { this.clearParticipation(); return false; }
        const info = this.transitionInfo(id); if (!info) return false;
        const r = this.review;
        // One separately judged alternative. Never air rejected speech or silently continue the game.
        if (id.includes('-fallback-')) { this.failReview(`speech_rejected:${reason}`); return true; }
        const fallback = info.stage === 'review' ? `recap-fallback-${r.runId}` : `recap-resume-fallback-${r.runId}`;
        const original = r.lines[id];
        const text = info.stage === 'review'
            ? r.fallbackText
            : '休憩はここまで。次のプレイを始めるね！';
        if (info.stage === 'review') r.eventId = fallback; else r.resumeEventId = fallback;
        delete r.lines[id];
        this.queueTransition(fallback, text, 500,
            info.stage === 'review' ? original.event : 'ゲームオーバーから約60秒を目標にした休憩を終え、次のプレイへ進む挨拶。', info.stage === 'review' ? original.facts : {});
        return true;
    }
    speechInterrupted(id) {
        if (id === this.participationQuestion?.id) { this.clearParticipation(); return false; }
        const info = this.transitionInfo(id); if (!info) return false;
        const r = this.review;
        if (this.announcements.some(a => a.id === id)) return true;
        r.interruptions[id] = (r.interruptions[id] || 0) + 1;
        if (r.interruptions[id] > 2) { this.failReview('speech_interrupted'); return true; }
        const line = r.lines[id]; this.announce(id, line.text, 500, line.event, line.facts);
        return true;
    }
    stillValid(eventId) {
        if (String(eventId).startsWith('participation-')) return this.participationEnabled && this.participationQuestion?.id === eventId && this.intermissionChat && this.now() < this.participationQuestion.expiresAt;
        if (String(eventId).startsWith('recap-')) return !!this.transitionInfo(eventId);
        return super.stillValid(eventId);
    }
    tick() {
        if (this.round?.heldDeath && this.now() - this.round.heldDeath.at >= FAKE_DEATH_HOLD_MS) this.confirmHeldDeath();
        super.tick();
        if (this.participationQuestion && (!this.intermissionChat || this.now() >= this.participationQuestion.expiresAt)) this.clearParticipation();
        if (this.review && this.review.reviewCompletedAt !== null && !this.review.failed && !this.review.completed && this.now() >= this.review.chatUntil && !this.review.resumeQueued) {
            this.review.resumeQueued = true;
            this.queueTransition(this.review.resumeEventId, 'じゃあ、もう一回頑張るね！', 0,
                'ゲームオーバーから約60秒を目標にした休憩を終え、同じゲームに再挑戦する直前の挨拶', {});
        }
        this.completeReviewIfReady();
    }
    get intermissionChat() { return !!this.review && this.review.reviewCompletedAt !== null && !this.review.failed && !this.review.completed && this.now() < this.review.chatUntil; }
    get intermissionRemainingMs() { return this.intermissionChat ? Math.max(0, this.review.chatUntil - this.now()) : 0; }
    setParticipationEnabled(enabled) {
        this.participationEnabled = enabled === true;
        if (!this.participationEnabled) this.clearParticipation();
    }
    clearParticipation() {
        if (this.participationQuestion) this.announcements = this.announcements.filter(a => a.id !== this.participationQuestion.id);
        this.participationQuestion = null;
    }
    inviteParticipation() {
        if (!this.participationEnabled || !this.intermissionChat || this.intermissionRemainingMs < 15000 || this.participationQuestion || (this.lastParticipationAt !== null && this.now() - this.lastParticipationAt < PARTICIPATION_COOLDOWN_MS)) return;
        const question = PARTICIPATION_QUESTIONS[this.participationNo++ % PARTICIPATION_QUESTIONS.length];
        this.lastParticipationAt = this.now();
        this.participationQuestion = { ...question, id: `participation-${this.review.runId}`, startedAt: null, expiresAt: this.review.chatUntil - 5000 };
        this.announce(this.participationQuestion.id, question.line, 1500,
            'ゲームオーバーの反省を話し終えた後の休憩中。一言で答えられる任意のお題を一つだけ案内する。回答を待たずに番組を進め、ゲーム操作に反映する約束はしない。',
            { participationKind: question.kind, optional: true, changesGame: false });
    }
    playbackCompleted(eventId) {
        if (eventId === this.participationQuestion?.id) {
            if (this.stillValid(eventId) && this.participationQuestion.startedAt === null) { this.participationQuestion.startedAt = this.now(); this.report(); }
            return;
        }
        const review = this.review;
        if (!this.transitionInfo(eventId)) return;
        if (review.eventId === eventId) { review.reviewCompletedAt = this.now(); this.inviteParticipation(); this.tick(); return; }
        if (eventId !== review.resumeEventId || !review.resumeQueued || this.now() < review.chatUntil) return;
        review.resumeCompletedAt = this.now();
        this.completeReviewIfReady();
    }
    completeReviewIfReady() {
        const review = this.review;
        if (!review || review.failed || review.completed || review.reviewCompletedAt === null || review.resumeCompletedAt === null || this.now() < review.targetResumeAt) return;
        review.completed = true;
        this.emit('round_review_completed', { runId: review.runId, tactic: review.tactic });
    }
    /** A viewer's question about the run, answered from the observation (template + the fact it rests on), or null. */
    answer(text) {
        const q = String(text).normalize('NFKC'), s = this.snapshot, r = this.round;
        if (!s || this.phase === 'idle') return null;
        if (/レベル|lv|LV|Lv/.test(q) && s.level !== null) return { text: `いまレベル${s.level}だよ！`, event: `視聴者がいまのレベルを質問した。いまのレベルは${s.level}`, facts: { level: s.level } };
        if (/何分|何秒|経過|時間/.test(q) && s.elapsed !== null) return { text: `いま${clock(s.elapsed)}経ったところだよ！`, event: `視聴者が経過時間を質問した。いまの経過時間は${clock(s.elapsed)}`, facts: { elapsedSeconds: Math.floor(s.elapsed) } };
        if (/何回目|何戦目/.test(q) && this.roundNo) return { text: `いま${this.roundNo}回目のプレイだよ！`, event: `視聴者が何回目かを質問した。いまは${this.roundNo}回目のプレイ`, facts: { run: this.roundNo } };
        if (/自己ベスト|記録|ベスト/.test(q)) return r?.best !== null && r?.best !== undefined
            ? { text: `自己ベストは${clock(r.best)}だよ！`, event: `視聴者が自己ベストを質問した。このキャラクターの自己ベストは${clock(r.best)}生存`, facts: { personalBestSeconds: Math.floor(r.best) } }
            : { text: 'まだ自己ベストの記録はないんだ。これから作るね！', event: '視聴者が自己ベストを質問した。このキャラクターの記録はまだない', facts: { personalBestSeconds: null } };
        return null;
    }
    /** The goodbye from tonight's real results, or null before any finished run (then the programme's fixed line). */
    closing() {
        // A run still being played when the show closes (the runner stops on its time limit) counts toward tonight's
        // summary, as observed so far; only a finished run can be a personal record.
        const s = this.phase === 'playing' ? this.snapshot : null, live = s?.elapsed > 0 && !(s.elapsed <= (this.night.bestSeconds ?? -1));
        const n = live ? { rounds: this.night.rounds + 1, bestSeconds: s.elapsed, bestLevel: Math.max(this.night.bestLevel, s.level ?? 0), bestWeapons: s.weapons.map(x => this.weaponNames[x] || x) }
            : { ...this.night, rounds: this.night.rounds + (s?.elapsed > 0 ? 1 : 0) };
        const w = n.bestWeapons.length;
        // Summarize the best run's observed inventory and a future experiment. Co-occurring weapons and longer
        // survival do not prove that the weapons caused it. With fewer than two weapons use the fixed goodbye.
        if (!n.rounds || w < 2) return null;
        return { text: `今夜いちばん長く続いた回では、武器が${w}つそろっていたね。次は早めにそろえる方針も試してみるね、ありがとう、またね！`,
            observation: { game: VAMPIRE_TITLE, what: VAMPIRE_WHAT,
                event: `今夜のまとめ：${n.rounds}回プレイし、最長の生存時間は${clock(n.bestSeconds)}、最高到達レベルは${n.bestLevel}。いちばん長く生き延びた回の武器は${n.bestWeapons.join('・')}の${w}つ。レベルが上がるたびに、新しい武器か強化を1つ選べる`,
                facts: { runs: n.rounds, bestSeconds: Math.floor(n.bestSeconds), bestLevel: n.bestLevel, weaponsInBestRun: n.bestWeapons } } };
    }
    /** The recap lines of the long goodbye (TalkEngine farewell), from finished runs only: a run still being played could
     * outgrow a number before the line airs. Nothing before the first finished run. */
    farewell() {
        const n = this.night;
        if (!n.rounds) return [];
        const observation = { game: VAMPIRE_TITLE, what: VAMPIRE_WHAT,
            event: `今夜のまとめ（終わったプレイ）：${n.rounds}回プレイし、最長の生存時間は${clock(n.bestSeconds)}、最高到達レベルは${n.bestLevel}。いちばん長く生き延びた回の武器は${n.bestWeapons.join('・') || 'なし'}`,
            facts: { runs: n.rounds, bestSeconds: Math.floor(n.bestSeconds), bestLevel: n.bestLevel, weaponsInBestRun: n.bestWeapons } };
        const w = n.bestWeapons.length;
        return [{ text: `今夜は${n.rounds}回プレイして、いちばん長く生き延びたのは${clock(n.bestSeconds)}、最高レベルは${n.bestLevel}だったよ。`, observation },
            ...(w >= 2 ? [{ text: `いちばん長く続いた回では、武器が${w}つそろってたね。次は早めにそろえる作戦も試してみたいな。`, observation }] : [])];
    }
    /** Tonight against its goal, from finished runs only (operator 2026-10-16: say whether the goal was reached and why
     * not). reached: the operator marked it (POST /api/operator/goal), a boss's relic was picked up, or the game was
     * cleared tonight. */
    goalResult(marked = null) {
        const n = this.night;
        if (!n.rounds && marked === null && !n.cleared) return null;
        return { reached: marked ?? (!!n.relicFound || !!n.cleared), rounds: n.rounds, bestSeconds: n.bestSeconds, bestLevel: n.bestLevel, clock: n.bestSeconds === null ? null : clock(n.bestSeconds) };
    }
    /** A natural break to start the goodbye: a run has ended and its result and review have been said (not mid-run). */
    atBreak() { return ['results', 'between'].includes(this.phase) && (!this.review || this.review.reviewCompletedAt !== null || this.review.failed); }
    /** Numbers a spoken line may quote; a line is stale once one of them has changed. */
    numbers() { return { level: this.snapshot?.level ?? null, weapons: this.snapshot?.weapons.length ?? null }; }
    observation() {
        const s = this.snapshot;
        // Unknown values are left out (a null read as "HP なし" in model-written lines).
        return Object.fromEntries(Object.entries({ game: VAMPIRE_TITLE, what: VAMPIRE_WHAT, phase: this.phase, run: this.roundNo, elapsed: s?.elapsed !== null && s?.elapsed !== undefined ? clock(s.elapsed) : null,
            level: s?.level ?? null, hp: s?.hp !== null && s?.hp !== undefined ? Math.round(s.hp) : null, maxHp: s?.maxHp ?? null, enemies: s?.enemies ?? null,
            weapons: (s?.weapons ?? []).map(w => this.weaponNames[w] || w), personalBest: this.round?.best !== null && this.round?.best !== undefined ? clock(this.round.best) : null, lastResult: this.lastResult }).filter(([, v]) => v !== null && v !== undefined));
    }
    /** What the model is told about this game when it writes a line (providers adds it to the system prompt). */
    promptRule(utterance) {
        // Model-written talk (live and local runs 2026-10-10): 「隠し要素が現れて」「武器を買い集める」「ネオンが光って」「負けたことない」
        // and rough speech (「〜ねーから」「開けろ」「僕」) passed the gate; what the talk may say about the game is spelled out.
        const talk = `ゲームについて言ってよいのは observation にある事実（武器の名前・レベル・時間・結果）と goal にある例だけ。武器の見た目や効果、敵の様子、隠し要素、買い物など observation に無いことは作らず、今夜の勝ち負けや記録も observation と違うことを言わない。口調は明るく柔らかい女の子の話し言葉（語尾は「〜だね」「〜かな」「〜しよう」など）で、一人称は「私」。乱暴な言い方や強い言葉（やばい・マジ・死ぬ・倒す・叩く・捌く）は使わない。`;
        if (this.intermissionChat && utterance === 'monologue') return `ゲームオーバー後の約60秒の休憩中。${this.host}として、goal の話題を短く自然に雑談する。すでに話した反省・次の作戦・数字を繰り返さず、一度に話題を一つ。参加のお題は固定案内に任せ、追加の質問や返答の催促はしない。実在しない過去の経験・視聴者コメント・勝因敗因を作らない。まだゲームは再開していない。${talk}`;
        return `遊んでいるゲーム：「${VAMPIRE_TITLE}」（${VAMPIRE_WHAT}）。${this.playerVoice()}項目名（elapsed・hp・weapons など）や英語の内部名をそのまま読まない。倒す・叩く・捌くなどの荒い言葉や、やばい・死ぬなどの強い言葉は使わない。${utterance === 'game_commentary'
            ? 'observation.point の事実を、配信者のつぶやきとして自然に言い直す（10〜30字）。数字は多くても1つ。敵の種類・武器の性能・攻略法・次の展開など observation に無いことは言わない。'
            : utterance === 'comment_reply' ? 'コメントへの返事では、質問や感想そのものにまず短く応える。ゲームの質問にはobservationの確認できる事実だけで答え、lobbyなら開始前、resultsやbetweenなら終了後でまだ再開していない。数字や状況が不明なら不明と伝え、攻略法・未確認の操作・次回への反映の約束は作らない。ゲーム以外の話題はその話題に応え、関係のないゲーム状況を添えない。応援や挨拶にはお礼を一言で返す。'
            : '今回はゲーム実況ではなく goal の話題を話す番。ゲームの数字や状況には触れない。番組名や話題の見出しを読み上げず、ゲーム前の雑談に出た空想の物や場面は持ち込まない。' + talk}`;
    }
    statusExtra() {
        const s = this.snapshot, q = this.participationQuestion;
        const participation = q && q.startedAt !== null && this.stillValid(q.id)
            ? { id: q.id, kind: q.kind, text: q.text, options: [...q.options], startedAt: q.startedAt, expiresAt: q.expiresAt } : null;
        return { elapsed: s?.elapsed ?? null, level: s?.level ?? null, hp: s?.hp ?? null, maxHp: s?.maxHp ?? null, weapons: s?.weapons ?? [], participation };
    }
}

/** The game plug-in entry (games/vampire-survivors/game.json → show). */
export const createShow = (show, deps) => new VampireShow(show, deps);
