import { ExternalGameShow } from '../../src/external-game-show.mjs';
// Commentary for one game (copy this folder to games/<id>/, rename, fill in). The show flow (opening talk, lead-in,
// runs, results) comes from ExternalGameShow; this file says which changes in the controller's observed state are
// events and what Noa says about them. Check every fixed line with the real speech gate before a live show
// (npm run rehearse / the Studio's trial), and keep each at two sentences at most.

const TITLE = 'My Game', WHAT = '（ゲームの説明を一文で）';
const POLICY = {
    // priority: higher speaks first; ttlMs: a line may still air this long after the event; face: instant reflex.
    score_up: () => ({ priority: 2, ttlMs: 6000, face: 'happy', speak: true }),
    game_over: () => ({ priority: 4, ttlMs: 8000, face: 'surprised', speak: true }),
};
const LINES = {
    score_up: ['スコア{score}！', 'よし、{score}点！'],
    game_over: ['あー、終わっちゃった！'],
};

export class MyGameShow extends ExternalGameShow {
    constructor(show = {}, deps = {}) {
        super({ title: TITLE, what: WHAT, statusKey: 'my-game', startLine: `お待たせ、今日は${TITLE}をやるよー！`, waitLine: 'いまゲームを準備してるから、ちょっと待っててね。',
            policy: POLICY, lines: LINES, recordsFile: 'my-game-records.json' }, show, deps);
    }
    /** One observed state from the controller's log ({ runId, state }). */
    ingest({ runId, state } = {}) {
        const refused = this.admit(runId, state); if (refused) return refused;
        const prev = this.snapshot, s = { score: Number(state.score) || 0, over: state.phase === 'gameover' }, faces = [];
        if (prev && s.score > prev.score) faces.push(this.push('score_up', { score: s.score }));
        this.snapshot = s;
        if (s.over) { faces.push(this.push('game_over', { score: s.score })); this.finish('game_over'); }
        return { accepted: true, faces };
    }
    finishRound() { this.lastResult = { score: this.snapshot?.score ?? 0 }; }
    numbers() { return { score: this.snapshot?.score ?? null }; }
    observation() { return { ...super.observation(), ...(this.snapshot ? { score: this.snapshot.score } : {}) }; }
}

export const createShow = (show, deps) => new MyGameShow(show, deps);
