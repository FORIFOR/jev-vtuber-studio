import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SPEEDS, roundResult } from '../public/blocks-core.mjs';
// NOA BLOCKS round director + event policy. The stage runs the game (the audio-lease owner only) and reports real
// snapshots/events; this decides what the show does with them. Facts spoken about the game come from here, as templates.

export const BLOCKS_TITLE = 'NOA BLOCKS', BLOCKS_WHAT = 'ブロックを回して積んで、横一列をそろえて消す落ち物パズル';
const POLICY = {
    // priority: higher speaks first; ttlMs: a line about it may still air this long after it happened; face: instant wordless reflex.
    line_clear: e => e.facts.count >= 2 ? { priority: 3, ttlMs: 6000, face: 'excited', speak: true } : { priority: 0, ttlMs: 3000, face: 'happy', speak: false },
    danger_enter: () => ({ priority: 3, ttlMs: 5000, face: 'troubled', speak: true }),
    danger_exit: () => ({ priority: 2, ttlMs: 6000, face: 'happy', speak: true }),
    game_over: () => ({ priority: 4, ttlMs: 8000, face: 'surprised', speak: true }),
};
const LINES = {
    line_clear: ['よし、{n}ライン！', '{n}ライン消えた！', 'いいね、{n}ライン！'],
    danger_enter: ['上、かなり近い……', 'うわ、高くなってきた…', 'ちょっと積みすぎたかも…'],
    danger_exit: ['よし、今ので助かった！', 'ふう、持ち直した！'],
    game_over: ['あー、詰まっちゃった！', 'わっ、上まで来ちゃった！'],
};
/** Whole rounds that fit a session: each round is intro + play + results + pause; one minute is kept for the opening
 * and the closing. At least one round. */
export const roundsFor = (sessionMs, c) => Math.max(1, Math.floor((sessionMs - 60000) / (c.introMs + c.roundSeconds * 1000 + c.resultsMs + c.betweenMs)));
// Blockrain's scoring (public/vendor/blockrain-0.2.1.jquery.js _updateScore): points for 1..4 lines cleared at once.
export const POINTS_PER_CLEAR = Object.freeze({ 1: 400, 2: 1000, 3: 3000, 4: 12000 });
const MILESTONE = ['ここまで{n}ライン。', 'これで{n}ライン目。', '{n}ライン到達。この調子で。'];
const REPEAT_MS = 8000, FOLLOW_UP_DANGER_MS = 6000, RESULT_PAUSE_MS = 1200, COMMENTARY_COOLDOWN_MS = 45000;
/** One concrete moment of the round, from the real summary (never invented). */
// Stated as plain facts (the gate could not confirm "the best part was…", a judgement it cannot see in the data).
export function recapFor(r) {
    if (r.maxClear >= 3) return { text: `このラウンドでいちばん多く同時に消せたのは${r.maxClear}ラインだったよ。`, event: `ラウンド終了。このラウンドで一度に消した最大のライン数は${r.maxClear}ライン` };
    if (r.dangerRecoveries >= 1) return { text: `危ないところから${r.dangerRecoveries}回持ち直せたね。`, event: `ラウンド終了。積み上がって危険になったあと、${r.dangerRecoveries}回持ち直した` };
    if (r.maxClear === 2) return { text: '2ライン同時消しも決まったね。', event: 'ラウンド終了。このラウンドで一度に消した最大のライン数は2ライン' };
    return { text: '最後まで崩さずに積めたね。', event: 'ラウンド終了。危険な高さにならずに積み終えた' };
}
export const recapLine = r => recapFor(r).text;
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

export class BlocksShow {
    constructor(show = {}, { dataDir = null, now = Date.now, emit = () => { }, seed = () => Math.floor(Math.random() * 2 ** 31), canAffordRound = () => true, sessionMs = 15 * 60000 } = {}) {
        this.cfg = { roundSeconds: 180, maxRounds: 'auto', introMs: 6000, resultsMs: 12000, betweenMs: 8000, ...show };
        // 'auto': as many whole rounds as fit the session (leaving time for the opening and the closing), so the show
        // ends at a round boundary instead of the session clock cutting a round off. A number is used as given.
        if (this.cfg.maxRounds === 'auto') this.cfg.maxRounds = roundsFor(sessionMs, this.cfg);
        Object.assign(this, { dataDir, now, emit, seed, canAffordRound });
        this.path = dataDir ? join(dataDir, 'noa-blocks-records.json') : null;
        this.records = this.path && existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
        this.reset();
    }
    reset() { this.phase = 'idle'; this.roundNo = 0; this.round = null; this.snapshot = null; this.events = []; this.spoken = new Set(); this.recent = []; this.announcements = []; this.nextSpeed = 'normal'; this.lastResult = null; this.stageSummary = null; this.saidAt = {}; this.closedReason = null; this.night = { rounds: 0, bestLines: null, maxClear: 0 }; this.followUps = []; this.followAt = new Map(); this.said = new Set(); this.recentLines = []; this.dangerAt = null; this.lastCommentary = null; }
    get title() { return BLOCKS_TITLE; }
    get what() { return BLOCKS_WHAT; }
    /** Numbers a spoken line may quote; a line is stale once one of them has changed. */
    numbers() { return { lines: this.snapshot?.clearedLines ?? null, stack: this.snapshot?.highestStack ?? null }; }
    start() { this.reset(); this.beginIntro(); }
    beginIntro() {
        // A round is only started when the voice budget can carry it; otherwise close instead of going quiet mid-round.
        if (!this.canAffordRound()) {
            this.phase = 'done'; this.closedReason = 'budget'; // the programme's own closing line says goodbye
            this.emit('blocks', this.status()); return;
        }
        this.roundNo++;
        const speed = SPEEDS[this.nextSpeed] ? this.nextSpeed : 'normal', best = this.records[speed]?.lines ?? null;
        this.round = { no: this.roundNo, roundId: `round-${String(this.roundNo).padStart(3, '0')}`, seed: this.seed(), speed, startsAt: this.now() + this.cfg.introMs, endsAt: null, best };
        this.phase = 'intro'; this.snapshot = null; this.events = []; this.recent = []; this.lastCommentary = null; this.dangerAt = null; // per round
        const label = SPEEDS[speed].label, firstAtSpeed = best === null && Object.keys(this.records).length > 0;
        // Records are per speed: a new speed is a new challenge, never measured against another speed's best.
        this.announce(`intro-${this.round.roundId}`, `${this.roundNo}回戦、${label}でいくよ。${best !== null ? `目標は${label}の自己ベスト${best}ライン超え！` : firstAtSpeed ? `${label}は初挑戦、まずは記録を作ろう！` : 'まずは記録を作ろう！'}`, 0,
            `${this.roundNo}回戦のはじまり。速さは${label}。${best !== null ? `${label}の自己ベストは${best}ライン` : `${label}の記録はまだない`}`, { round: this.roundNo, speed: label, personalBest: best });
        this.emit('blocks', this.status());
    }
    /** A scripted line with what it is based on, in plain words + facts: the gate judges it against exactly that. */
    announce(id, text, delayMs = 0, event = null, facts = null) { this.announcements.push({ id, text, at: this.now(), notBefore: this.now() + delayMs, event, facts }); }
    /** Stage reports (lease-validated by the server). Stale rounds and out-of-order revisions are ignored. */
    ingest({ roundId, snapshot, events = [], summary = null } = {}) {
        if (!this.round || roundId !== this.round.roundId || this.phase !== 'playing') return { accepted: false, reason: 'stale_round' };
        if (summary && Number.isFinite(summary.maxClear)) this.stageSummary = { maxClear: summary.maxClear | 0, dangerRecoveries: summary.dangerRecoveries | 0 };
        if (snapshot && (!this.snapshot || snapshot.revision > this.snapshot.revision)) this.snapshot = snapshot;
        // The round clock starts when the stage's board is really running, never on an empty board.
        if (snapshot && this.round.endsAt === null) { this.round.endsAt = this.now() + this.cfg.roundSeconds * 1000; this.emit('blocks', this.status()); }
        const faces = [];
        for (const e of events) {
            if (typeof e?.type !== 'string' || !POLICY[e.type] || this.spoken.has(e.id) || this.events.some(x => x.id === e.id)) continue;
            const p = POLICY[e.type](e);
            this.events.push({ ...e, ...p, at: this.now() }); faces.push(p.face);
            this.recent.push({ type: e.type, gameTimeMs: e.gameTimeMs, facts: e.facts }); if (this.recent.length > 3) this.recent.shift();
            if (e.type === 'danger_enter') this.dangerAt = this.now();
            // A long, silent danger that ends well is worth one more beat: say what the silence was.
            if (e.type === 'danger_exit' && this.dangerAt !== null && this.now() - this.dangerAt >= FOLLOW_UP_DANGER_MS && !this.said.has(`follow-${this.round.roundId}`)) {
                this.said.add(`follow-${this.round.roundId}`);
                this.followAt.set(`follow-${e.id}`, this.now());
                this.followUps.push({ id: `follow-${e.id}`, text: '今ちょっと静かになってたでしょ。集中してた。', notBefore: this.now() + 2500, ttlMs: 12000, at: this.now(), facts: { dangerMs: this.now() - this.dangerAt } });
            }
            if (e.type === 'danger_exit') this.dangerAt = null;
            if (e.type === 'game_over') this.finish('game_over');
        }
        return { accepted: true, faces };
    }
    /** Is a line about this event still true right now? (a danger line after recovery is not.) */
    stillValid(eventId) {
        if (/^(intro|result|recap|next|speed)-/.test(String(eventId))) return true;
        if (String(eventId).startsWith('follow-')) { const at = this.followAt.get(eventId); return at !== undefined && this.now() - at <= 12000; }
        const e = this.events.find(x => x.id === eventId);
        if (!e || this.now() - e.at > e.ttlMs) return false;
        if (e.type === 'danger_enter') return (this.snapshot?.highestStack ?? 0) >= 12;
        return true;
    }
    /** Next thing the host should say: announcements first, then the highest-priority speakable live event. */
    takeLine() {
        if (this.announcements[0] && this.announcements[0].notBefore <= this.now()) { const a = this.announcements.shift(); return { eventId: a.id, text: a.text, kind: 'game_fact', eventText: a.event, facts: a.facts }; }
        if (this.announcements.length) return null; // a timed beat (e.g. the pause before results) is pending
        // A second reaction of the same kind within REPEAT_MS reads as an echo: the face already reacted, so stay silent.
        for (const e of this.events) if (e.speak && !this.spoken.has(e.id) && this.now() - (this.saidAt[e.type] ?? -Infinity) < REPEAT_MS) this.spoken.add(e.id);
        const live = this.events.filter(e => e.speak && !this.spoken.has(e.id) && this.stillValid(e.id)).sort((x, y) => y.priority - x.priority || y.at - x.at);
        const e = live[0];
        if (!e) {
            const i = this.followUps.findIndex(f => f.notBefore <= this.now());
            if (i < 0) return null;
            const [f] = this.followUps.splice(i, 1);
            if (this.now() - f.at > f.ttlMs) return null; // too late to connect to what happened
            return { eventId: f.id, text: f.text, kind: 'game_reaction', event: { type: 'danger_recovered', facts: f.facts } };
        }
        this.spoken.add(e.id); this.saidAt[e.type] = this.now();
        for (const x of this.events) if (x !== e && x.priority <= e.priority) this.spoken.add(x.id); // Older, lesser events are superseded.
        // Never the same reaction words twice in a short while (it reads as a loop and the gate refuses it): if every
        // variant was said recently, the face has already reacted — stay silent.
        const pool = LINES[e.type], start = this.spoken.size % pool.length;
        const text = [...pool.slice(start), ...pool.slice(0, start)].map(t => fill(t, { n: e.facts.count })).find(t => !this.recentLines.includes(t));
        if (!text) return null;
        this.recentLines.push(text); if (this.recentLines.length > 6) this.recentLines.shift();
        return { eventId: e.id, text, kind: 'game_reaction', event: e };
    }
    markSpoken(id) { this.spoken.add(id); }
    /** The goodbye built from tonight's real results, with the facts it rests on (incl. the game's scoring rule), or null
     * when no round finished (then the programme's fixed closing line is used). */
    closing() {
        const n = this.night; if (!n.rounds) return null;
        // Worded and checked against the real gate: an insight tied to tonight's biggest clear plus a plan (not a new claim).
        const m = Math.min(4, Math.max(2, n.maxClear));
        return { text: `今夜の気付きは、${m}ライン同時に消すと1ラインずつより点がずっと大きいこと。次はそれを狙って積んでみるね、ありがとう、またね！`,
            observation: { game: BLOCKS_TITLE, event: `今夜のまとめ：${n.rounds}ラウンド遊び、いちばん多く消せたのは${n.bestLines}ライン。一度に消した最大は${n.maxClear}ライン。このゲームは同時に消すライン数が多いほど1回の得点が大きい（1ライン400点、2ライン1000点、3ライン3000点、4ライン12000点）`,
                facts: { rounds: n.rounds, bestLines: n.bestLines, mostLinesClearedAtOnce: n.maxClear, pointsPerClear: POINTS_PER_CLEAR } } };
    }
    /** Something NEW and true to say about the board right now, or null (then the host stays quiet and plays).
     * Each kind has a cooldown and each specific fact is said once, so the talk follows the round instead of a list. */
    commentary() {
        if (this.phase !== 'playing' || !this.snapshot || this.round.endsAt === null) return null;
        const s = this.snapshot, now = this.now(), total = this.cfg.roundSeconds * 1000, left = this.round.endsAt - now, elapsed = total - left;
        const best = this.round.best, rid = this.round.roundId, lines = s.clearedLines, opts = [];
        if (left <= 20000) opts.push(['last20', `last20-${rid}`, 'ラスト20秒！最後まで消していこう。']);
        else if (left <= 60000) opts.push(['last60', `last60-${rid}`, '残り1分切った。ここから丁寧にいこう。']);
        if (s.highestStack >= 12) opts.push(['high', `high-${rid}-${lines}`, `いま${s.highestStack}段、そろそろ下を消したいな。`]);
        if (best !== null && elapsed > 30000) {
            const d = lines - Math.round(best * elapsed / total);
            if (d >= 2) opts.push(['pace', `ahead-${rid}-${lines}`, `自己ベストのペースより${d}ライン先に行ってる！`]);
            else if (d <= -2) opts.push(['pace', `behind-${rid}-${lines}`, `自己ベストのペースより${-d}ライン遅れてる。ここから取り返そう。`]);
            if (best - lines > 0 && best - lines <= 5) opts.push(['near', `near-${rid}-${lines}`, `自己ベストまであと${best - lines}ライン！`]);
        }
        // A milestone without a judgement: on a first record there is no pace to call good or bad.
        if (lines >= (this.lastCommentary?.lines ?? 0) + 3) opts.push(['lines', `lines-${rid}-${lines}`, fill(MILESTONE[lines % MILESTONE.length], { n: lines })]);
        if (lines === 0 && elapsed > 15000 && s.highestStack <= 6) opts.push(['calm', `calm-${rid}`, `まだ${s.highestStack}段、落ち着いて平らに積んでいこう。`]);
        const pick = opts.find(([kind, id]) => !this.said.has(id) && now - (this.saidAt[`c:${kind}`] ?? -Infinity) >= COMMENTARY_COOLDOWN_MS);
        return pick ? { kind: pick[0], id: pick[1], text: pick[2] } : null;
    }
    markCommentary(c) { this.said.add(c.id); this.saidAt[`c:${c.kind}`] = this.now(); this.lastCommentary = { lines: this.snapshot?.clearedLines ?? 0, at: this.now() }; }
    finish(reason) {
        if (this.phase !== 'playing') return;
        this.phase = 'results';
        const s = this.snapshot || { clearedLines: 0, score: 0 }, speed = this.round.speed, best = this.records[speed] ?? null;
        const r = roundResult({ lines: s.clearedLines, score: s.score, speed, ...(this.stageSummary || {}) }, best);
        this.lastResult = { ...r, reason, roundId: this.round.roundId };
        this.night.rounds++; this.night.bestLines = Math.max(this.night.bestLines ?? 0, r.lines); this.night.maxClear = Math.max(this.night.maxClear, r.maxClear || 0);
        if (r.newBest) { this.records[speed] = { lines: r.lines, score: r.score, at: new Date(this.now()).toISOString() }; this.save(); }
        this.round.resultsUntil = this.now() + this.cfg.resultsMs;
        this.events = []; // Live reactions are stale once the round is over.
        const head = reason === 'game_over' ? `結果は${r.lines}ライン！` : `時間切れ、${r.lines}ライン！`;
        const tail = r.previousBest === null ? 'これが最初の記録だね。' : r.newBest ? `自己ベストを${r.delta}ライン更新！` : r.delta === 0 ? '自己ベストに並んだ！' : `自己ベストまであと${-r.delta}ライン。`;
        // The board stops, the result shows, Noa looks at it: one beat of silence before she reads it out.
        this.announce(`result-${this.round.roundId}`, head + tail, RESULT_PAUSE_MS,
            `ラウンド終了（${reason === 'game_over' ? '上まで積み上がった' : '時間切れ'}）。結果は${r.lines}ライン。${r.previousBest === null ? 'この速さで最初の記録' : r.newBest ? `自己ベスト${r.previousBest}ラインを${r.delta}ライン更新` : `自己ベストは${r.previousBest}ライン`}`,
            { lines: r.lines, previousBest: r.previousBest, newBest: r.newBest, delta: r.delta });
        const recap = recapFor(r);
        this.announce(`recap-${this.round.roundId}`, recap.text, 0, recap.event, { lines: r.lines, mostLinesClearedAtOnce: r.maxClear, dangerRecoveries: r.dangerRecoveries });
        this.emit('blocks', this.status());
    }
    save() { if (!this.path) return; mkdirSync(this.dataDir, { recursive: true }); writeFileSync(`${this.path}.tmp`, JSON.stringify(this.records)); renameSync(`${this.path}.tmp`, this.path); }
    /** A viewer comment may pick the next round's speed; the reply states what was really applied. */
    chooseSpeed(text) {
        const k = /ゆっくり|遅め|おそめ/.test(text) ? 'slow' : /速め|はやめ|早め|速く/.test(text) ? 'fast' : /標準|ふつう|普通/.test(text) ? 'normal' : null;
        if (!k || this.phase === 'done') return null;
        // No round left today: say so instead of promising a next round that will not come.
        if (this.roundNo >= this.cfg.maxRounds && this.phase !== 'intro') return { eventId: `speed-last-${this.roundNo}`, text: `ごめんね、今日はこのラウンドで最後だから、${SPEEDS[k].label}には変えられないんだ。`, kind: 'game_fact',
            eventText: `視聴者が${SPEEDS[k].label}を希望した。今夜のラウンドは全${this.cfg.maxRounds}回で、今が${this.roundNo}回目（最後）なので、速さの変更は適用しない`, facts: { requested: SPEEDS[k].label, applied: false, round: this.roundNo, roundsTonight: this.cfg.maxRounds } };
        this.nextSpeed = k;
        return { eventId: `speed-${this.roundNo}-${k}`, text: `わかった、次のラウンドは${SPEEDS[k].label}にするね！`, kind: 'game_fact',
            eventText: `視聴者が次のラウンドの速さに${SPEEDS[k].label}を選び、次のラウンドに適用した`, facts: { requested: SPEEDS[k].label, nextRoundSpeed: SPEEDS[k].label, appliesTo: 'next round' } };
    }
    tick() {
        const t = this.now();
        if (this.phase === 'intro' && t >= this.round.startsAt) { this.phase = 'playing'; this.round.endsAt = null; this.emit('blocks', this.status()); }
        else if (this.phase === 'playing' && this.round.endsAt !== null && t >= this.round.endsAt) this.finish('time_up'); // no clock until the board runs
        else if (this.phase === 'results' && t >= this.round.resultsUntil) { this.phase = 'between'; this.round.betweenUntil = t + this.cfg.betweenMs; this.emit('blocks', this.status()); }
        else if (this.phase === 'between' && t >= this.round.betweenUntil) {
            if (this.roundNo >= this.cfg.maxRounds) { this.phase = 'done'; this.emit('blocks', this.status()); }
            else this.beginIntro();
        }
    }
    observation() {
        const s = this.snapshot;
        return { game: BLOCKS_TITLE, what: BLOCKS_WHAT, phase: this.phase, round: this.roundNo, roundsTonight: this.cfg.maxRounds, speed: this.round ? SPEEDS[this.round.speed].label : null,
            lines: s?.clearedLines ?? 0, score: s?.score ?? 0, stack: s?.highestStack ?? 0, danger: s?.danger ?? 'low', personalBest: this.round?.best ?? null, lastResult: this.lastResult };
    }
    /** Viewer-safe status for the stage: real numbers only. */
    status() {
        const s = this.snapshot, r = this.round;
        return { title: BLOCKS_TITLE, phase: this.phase, round: this.roundNo, maxRounds: this.cfg.maxRounds, roundId: r?.roundId ?? null, seed: r?.seed ?? null, speed: r?.speed ?? 'normal',
            speedLabel: SPEEDS[r?.speed ?? 'normal'].label, roundSeconds: this.cfg.roundSeconds, endsAt: r?.endsAt ?? null, startsAt: r?.startsAt ?? null, score: s?.score ?? 0, lines: s?.clearedLines ?? 0,
            nextPiece: s?.nextPiece ?? null, board: s?.board ?? null, personalBest: r?.best ?? null, recent: [...this.recent], lastResult: this.lastResult, closedReason: this.closedReason };
    }
}
