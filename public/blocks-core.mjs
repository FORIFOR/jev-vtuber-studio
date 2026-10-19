// NOA BLOCKS core: pure, DOM-free logic shared by the stage (browser) and the server/tests (Node).
// Everything a host may say about the game is computed here from the real board, never guessed by a model.
export const COLS = 10, ROWS = 20;
export const SPEEDS = Object.freeze({ slow: { label: 'ゆっくり', dropDelay: 8 }, normal: { label: '標準', dropDelay: 5 }, fast: { label: '速め', dropDelay: 3 } });
export const DANGER = Object.freeze({ enter: 14, exit: 10 }); // stack height (rows); hysteresis so one danger is one event

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** rows: ROWS arrays of COLS booleans (row 0 = top). */
export function metrics(rows) {
    let highest = 0, holes = 0;
    for (let x = 0; x < COLS; x++) {
        let seen = false;
        for (let y = 0; y < ROWS; y++) {
            if (rows[y]?.[x]) { if (!seen) { seen = true; highest = Math.max(highest, ROWS - y); } }
            else if (seen) holes++;
        }
    }
    return { highestStack: highest, holes, danger: highest >= DANGER.enter ? 'high' : highest >= DANGER.exit ? 'mid' : 'low' };
}

/** Turns successive snapshots into discrete, de-duplicated game events with stable ids. */
export class EventTracker {
    constructor(roundId) { this.roundId = roundId; this.inDanger = false; this.lines = 0; this.score = 0; this.maxClear = 0; this.dangerRecoveries = 0; this.log = []; }
    event(type, snap, facts) {
        const e = { id: `${this.roundId}:${snap.revision}:${type}`, roundId: this.roundId, revision: snap.revision, type, gameTimeMs: snap.elapsedMs, facts };
        this.log.push(e); if (this.log.length > 50) this.log.shift();
        return e;
    }
    update(snap, { linesCleared = 0, scoreDelta = 0, gameOver = false } = {}) {
        const out = [];
        if (linesCleared > 0) {
            this.maxClear = Math.max(this.maxClear, linesCleared);
            out.push(this.event('line_clear', snap, { count: linesCleared, totalLines: snap.clearedLines, scoreDelta }));
        }
        if (!this.inDanger && snap.highestStack >= DANGER.enter) { this.inDanger = true; out.push(this.event('danger_enter', snap, { highestStack: snap.highestStack })); }
        else if (this.inDanger && snap.highestStack <= DANGER.exit) { this.inDanger = false; this.dangerRecoveries++; out.push(this.event('danger_exit', snap, { highestStack: snap.highestStack })); }
        if (gameOver) out.push(this.event('game_over', snap, { totalLines: snap.clearedLines, score: snap.score }));
        this.lines = snap.clearedLines; this.score = snap.score;
        return out;
    }
}

/** The bot's placement is reached by real inputs: rotations first (Blockrain 'left' = +1), then sideways moves. */
export function planMoves(orientation, x, targetOrientation, targetX) {
    const ops = [], r = ((targetOrientation - orientation) % 4 + 4) % 4;
    if (r === 3) ops.push('rotateRight'); else for (let i = 0; i < r; i++) ops.push('rotateLeft');
    const dx = targetX - x;
    for (let i = 0; i < Math.abs(dx); i++) ops.push(dx < 0 ? 'moveLeft' : 'moveRight');
    return ops;
}

/** Result of one round against the same-rules personal best. */
export function roundResult({ lines, score, maxClear = 0, dangerRecoveries = 0, speed = 'normal' }, best = null) {
    const prev = Number.isFinite(best?.lines) ? best.lines : null;
    return { lines, score, maxClear, dangerRecoveries, speed, previousBest: prev, delta: prev === null ? null : lines - prev, newBest: prev === null ? lines > 0 : lines > prev };
}
