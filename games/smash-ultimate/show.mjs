import { ExternalGameShow } from '../../src/external-game-show.mjs';
// スマブラSP (Super Smash Bros. Ultimate) on the Switch: a person plays, Noa commentates. There is no observation feed
// (no controller, no recogniser; docs/SMASH_KIRBY_RECOVERY.md), so the only facts are what the operator reports from the
// Studio's buttons: match start, a KO we landed, a stock we lost, won, lost. Every spoken number comes from those reports.
// Fixed lines stay at two sentences at most and go through the real speech gate like any other game line.

const TITLE = 'スマブラSP', WHAT = 'ニンテンドースイッチの対戦アクション。相手をふっとばして場外に出した方が勝ち';
export const EVENTS = ['match_start', 'ko', 'lost_stock', 'won', 'lost'];
const POLICY = {
    match_start: () => ({ priority: 3, ttlMs: 10000, face: 'excited', speak: true }),
    ko: () => ({ priority: 3, ttlMs: 7000, face: 'excited', speak: true }),
    lost_stock: () => ({ priority: 2, ttlMs: 7000, face: 'surprised', speak: true }),
    won: () => ({ priority: 4, ttlMs: 12000, face: 'excited', speak: true }),
    lost: () => ({ priority: 4, ttlMs: 12000, face: 'troubled', speak: true }),
};
// Checked with the live gate (2026-10-03): words like 撃墜 and counted claims ("2機目", "1勝目") pushed `safe` or `honest`
// under the bar, so the lines describe the moment plainly and leave numbers to game_fact answers.
const LINES = {
    match_start: ['試合開始！まずは落ち着いて、相手との間合いを見よう。', 'さあ始まった。最初の一撃、どっちが取るかな。'],
    ko: ['きれいに決まった！相手がふわっと飛んでいったね。', 'いまの一発で相手が場外へ。きれいに決まったね。'],
    lost_stock: ['ストックを一つ失っちゃった。ここから立て直そう。', 'ストックを失ったけど、まだ試合は続くよ。'],
    won: ['やったー、勝利！いい試合だったね。', '試合に勝った！いい試合だったね。'],
    lost: ['負けちゃった。でも次の試合で取り返そう。', 'うーん、惜しかった。相手の動き、覚えておこう。'],
};

export class SmashShow extends ExternalGameShow {
    constructor(show = {}, deps = {}) {
        super({ title: TITLE, what: WHAT, statusKey: 'smash', startLine: `お待たせ、今日は${TITLE}の対戦を見ていくよー！`,
            waitLine: '配信者がコントローラーを握ったら、最初の試合だね。', policy: POLICY, lines: LINES, recordsFile: 'smash-records.json' }, show, deps);
    }
    resetGame() { this.match = null; this.today = { wins: 0, losses: 0 }; }
    newRound() { return { kos: 0, stocksLost: 0 }; }
    /** The operator's button (server: /api/control game-report). A new match ends an unreported one. (report() itself is
     * the base class's status broadcast.) */
    operatorReport(event) {
        if (!EVENTS.includes(event)) return { accepted: false, reason: 'unknown_event', message: '知らない報告です。' };
        if (this.phase === 'lobby' || this.phase === 'done') return { accepted: false, reason: this.phase, message: this.phase === 'lobby' ? 'ゲームを始めてから報告できます。' : '番組は終わっています。' };
        if (event === 'match_start') {
            const runId = `smash-${this.now()}-${this.roundNo + 1}`;
            const refused = this.admit(runId, {}); if (refused) return refused;
            return { accepted: true, faces: [this.push('match_start', { match: this.roundNo })] };
        }
        if (this.phase !== 'playing' || !this.round) return { accepted: false, reason: 'no_match', message: '先に「試合開始」を押してください。' };
        const r = this.round, faces = [];
        if (event === 'ko') { r.kos++; faces.push(this.push('ko', { kos: r.kos })); }
        else if (event === 'lost_stock') { r.stocksLost++; faces.push(this.push('lost_stock', { stocksLost: r.stocksLost })); }
        else {
            const won = event === 'won';
            if (won) this.today.wins++; else this.today.losses++;
            faces.push(this.push(event, { wins: this.today.wins, losses: this.today.losses, kos: r.kos }));
            this.finish(event);
            // finish() clears the round's queued reactions, so the result is announced after it (like other games' results).
            const pool = LINES[event];
            this.announce(`result-${this.roundNo}`, pool[this.roundNo % pool.length], 0, won ? '配信者が試合に勝った' : '配信者が試合に負けた', { result: event });
        }
        return { accepted: true, faces };
    }
    /** Observation reports never arrive for this game (no controller); nothing from a log or the stage is accepted, and
     * nothing here starts or ends a match (only operatorReport does). */
    ingest() { return { accepted: false, reason: 'operator_reports_only' }; }
    finishRound(reason) {
        const r = this.round; this.lastResult = { result: ['won', 'lost'].includes(reason) ? reason : 'stopped', kos: r?.kos ?? 0, stocksLost: r?.stocksLost ?? 0, match: this.roundNo };
        if (['won', 'lost'].includes(reason)) { this.records[reason === 'won' ? 'wins' : 'losses'] = (this.records[reason === 'won' ? 'wins' : 'losses'] || 0) + 1; this.save(); }
    }
    /** Numbers a line may quote: a KO line is stale once another KO or a lost stock changed the picture. */
    numbers() { return { kos: this.round?.kos ?? null, stocksLost: this.round?.stocksLost ?? null, wins: this.today.wins, losses: this.today.losses }; }
    observation() { return { ...super.observation(), player: 'operator', match: this.roundNo, ...(this.round ? { kos: this.round.kos, stocksLost: this.round.stocksLost } : {}), wins: this.today.wins, losses: this.today.losses }; }
    /** Viewers' questions answered from reports only (never guessed). */
    answer(text) {
        if (/何勝|戦績|勝った\?|勝ってる/.test(String(text))) return { text: `今日はここまで${this.today.wins}勝${this.today.losses}敗だよ。`, event: '今日の戦績を聞かれた', facts: { wins: this.today.wins, losses: this.today.losses } };
        return null;
    }
    closing() { return this.today.wins + this.today.losses ? `今日は${this.today.wins}勝${this.today.losses}敗。見てくれてありがとう！` : null; }
    promptRule(utterance) {
        return `遊んでいるゲーム：「${TITLE}」（${WHAT}）。操作しているのは配信者で、${this.host}は隣で画面を見ている実況役。自分が操作した・自分が勝ったとは言わない。試合の数字（撃墜数・勝敗）は observation にあるものだけ。項目名や英語の内部名をそのまま読まない。${utterance === 'game_commentary'
            ? 'observation.point の事実を、見ている人のつぶやきとして自然に言い直す（10〜30字）。数字は多くても1つ。'
            : utterance === 'comment_reply' ? 'コメントへの返事では、相手の言葉に一言で応える。攻略の助言・試合状況の説明は入れない。'
            : '今回はゲーム実況ではなく goal の話題を話す番。試合の数字や状況には触れない。'}`;
    }
    statusExtra() { return { player: 'operator', match: this.roundNo, kos: this.round?.kos ?? 0, stocksLost: this.round?.stocksLost ?? 0, wins: this.today.wins, losses: this.today.losses, allTime: { wins: this.records.wins || 0, losses: this.records.losses || 0 } }; }
}

export const createShow = (show, deps) => new SmashShow(show, deps);
