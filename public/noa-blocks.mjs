// NOA BLOCKS runtime (browser). Extends the unmodified vendored Blockrain.js through its widget factory:
// seeded pieces, fixed 10x20 field, no auto-restart, and a bot that plays with real inputs (rotate / move / soft drop)
// instead of Blockrain's autoplay teleport. Emits read-only snapshots and events; it never talks to Jev itself.
import { COLS, ROWS, SPEEDS, mulberry32, metrics, EventTracker, planMoves } from './blocks-core.mjs';

let extended = false;
function extend($) {
    if (extended) return; extended = true;
    $.widget('aerolab.blockrain', $.aerolab.blockrain, {
        _randInt(a, b) { return a + Math.floor((this._rng || Math.random)() * (1 + b - a)); },
        // The field is always 10x20: the display scales, the logic never changes with the element's aspect ratio.
        updateSizes() {
            this._PIXEL_WIDTH = this.element.innerWidth(); this._BLOCK_WIDTH = COLS; this._BLOCK_HEIGHT = ROWS;
            this._block_size = Math.max(4, Math.floor(Math.min(this._PIXEL_WIDTH / COLS, this.element.innerHeight() / ROWS)));
            this._border_width = 2; this._PIXEL_WIDTH = this._block_size * COLS; this._PIXEL_HEIGHT = this._block_size * ROWS;
            this._$canvas.attr('width', this._PIXEL_WIDTH).attr('height', this._PIXEL_HEIGHT);
        },
    });
}

export class NoaBlocks {
    constructor(el, { $ = window.jQuery, moveIntervalMs = 100, onEvent = () => { }, onSnapshot = () => { } } = {}) {
        extend($);
        Object.assign(this, { el, $, moveIntervalMs, onEvent, onSnapshot });
        this.$el = $(el);
        this.$el.blockrain({ autoplay: false, autoplayRestart: false, showFieldOnStart: false, difficulty: 'normal', speed: 20, theme: 'candy', asdwKeys: false, playText: '', playButtonText: '', gameOverText: '', restartButtonText: '', scoreText: '',
            onPlaced: () => this.placed(), onLine: (lines, inc) => { this.pendingLines += lines; this.pendingScore += inc; }, onGameOver: () => this.ended() });
        this.game = this.$el.data('aerolab-blockrain');
        this.timer = null; this.round = null; this.revision = 0; this.pendingLines = 0; this.pendingScore = 0;
    }
    /** Starts a round from the Director: same seed + speed => same piece sequence. */
    start({ roundId, seed, speed = 'normal' }) {
        this.stop();
        const g = this.game;
        g._rng = mulberry32(seed);
        this.round = { roundId, seed, speed, startedAt: performance.now(), over: false };
        this.tracker = new EventTracker(roundId); this.revision = 0; this.pendingLines = 0; this.pendingScore = 0; this.plannedFor = null; this.ops = [];
        g.start(); g._board.paused = false; // start() keeps a previous pause; a new round always runs.
        g._board.lines = 0; // Blockrain's start() resets the score but not the line count.
        g._board.dropDelay = (SPEEDS[speed] || SPEEDS.normal).dropDelay;
        this.timer = setInterval(() => this.step(), this.moveIntervalMs);
        this.publish({});
    }
    stop() { clearInterval(this.timer); this.timer = null; if (this.game?._board) this.game._board.paused = true; }
    pause() { if (this.game?._board) this.game._board.paused = true; }
    resume() { if (this.game?._board && this.round && !this.round.over) this.game._board.paused = false; }
    step() {
        const b = this.game._board, cur = b.cur;
        if (!b.started || b.paused || b.gameover || !cur) return;
        if (this.plannedFor !== cur) {
            // Blockrain's own placement scoring decides WHERE; the move plan decides HOW, through collision checks.
            this.game._niceShapes(this.game._filled, this.game._checkCollisions, COLS, ROWS, 'normal', cur);
            this.ops = planMoves(cur.orientation, cur.x, cur.best_orientation, cur.best_x); this.plannedFor = cur;
        }
        if (this.ops.length) {
            const op = this.ops.shift(), before = [cur.orientation, cur.x];
            if (op === 'rotateLeft') cur.rotate('left'); else if (op === 'rotateRight') cur.rotate('right'); else cur[op]();
            // A blocked input abandons the plan: gravity places the piece where it is, like a missed move.
            if (before[0] === cur.orientation && before[1] === cur.x) this.ops = [];
        } else cur.drop(); // Soft drop once aligned.
    }
    snapshot() {
        const g = this.game, d = g._filled.data, rows = [];
        for (let y = 0; y < ROWS; y++) { const r = []; for (let x = 0; x < COLS; x++) r.push(d[x + y * COLS] ? 1 : 0); rows.push(r); }
        const m = metrics(rows), cur = g._board.cur;
        return { roundId: this.round?.roundId ?? null, revision: this.revision, phase: this.round?.over ? 'over' : g._board.paused ? 'paused' : 'playing', speed: this.round?.speed ?? 'normal',
            board: rows, currentPiece: cur ? { type: cur.blockType, x: cur.x, y: cur.y, orientation: cur.orientation } : null, nextPiece: g._board.next?.blockType ?? null,
            score: g._filled.score, clearedLines: g._board.lines, elapsedMs: this.round ? Math.round(performance.now() - this.round.startedAt) : 0, ...m };
    }
    publish({ gameOver = false }) {
        this.revision++;
        const snap = this.snapshot(), events = this.tracker ? this.tracker.update(snap, { linesCleared: this.pendingLines, scoreDelta: this.pendingScore, gameOver }) : [];
        this.pendingLines = 0; this.pendingScore = 0;
        this.onSnapshot(snap, events);
        for (const e of events) this.onEvent(e, snap);
    }
    placed() { this.publish({}); }
    ended() { if (this.round) this.round.over = true; this.stop(); this.publish({ gameOver: true }); }
    summary() { return this.tracker ? { maxClear: this.tracker.maxClear, dangerRecoveries: this.tracker.dangerRecoveries } : { maxClear: 0, dangerRecoveries: 0 }; }
}
