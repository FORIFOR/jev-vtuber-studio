/** Programme state is committed only after a whole host turn is acknowledged.
 * Projection uses the same cursor rules as commit, without mutating heard history.
 */
import { lobbyCards } from './lobby-scenes.mjs';
export class Director {
    constructor(cards, { beatsPerTopic = 9, finite = false, programme = null, lobbyScenes = null } = {}) {
        if (!Array.isArray(cards) || !cards.length || cards.some(c => !c.id || !c.title || !Array.isArray(c.angles) || !c.angles.length)) throw new Error('Invalid topic cards');
        this.baseCards = cards; this.lobbyScenes = lobbyScenes; this.beatsPerTopic = beatsPerTopic; this.finite = finite; this.programme = programme; this.reset();
    }
    reset(seed = Date.now()) {
        this.cards = lobbyCards(this.baseCards, this.lobbyScenes, seed);
        this.lobbyHeard = []; this.lobbyCompleted = [];
        this.index = 0; this.beat = 0; this.revision = 0; this.opened = false; this.closed = false; this.closing = false;
        this.exhausted = false; this.history = []; this.dialogue = []; this.recentSpeeches = [];
        this.committed = new Set(); this.committedTurns = 0; this.lastQuestionAt = 0; this.lastHeard = null;
    }
    get card() { return this.cards[Math.min(this.index, this.finite ? this.cards.length - 1 : Infinity) % this.cards.length]; }
    beatLimit() { return this.card.beats?.length || this.beatsPerTopic; }
    cursor() { return { index: this.index, beat: this.beat, revision: this.revision, opened: this.opened, closing: this.closing, closed: this.closed }; }
    key(s = this.cursor()) { return `${s.index}:${s.revision}:${s.beat}:${s.opened ? 1 : 0}:${s.closing ? 1 : 0}:${s.closed ? 1 : 0}`; }
    projected(turn) {
        const s = this.cursor();
        if (!turn || (turn.serial !== undefined && this.committed.has(turn.serial)) || (turn.revision !== undefined && turn.revision !== s.revision)) return s;
        if (turn.kind === 'opening') s.opened = true;
        if (turn.kind === 'autonomous') s.beat++;
        // Cross-card projection is intentionally not speculated: the engine waits
        // for the transition ACK and starts on the next card, avoiding stale speech.
        return s;
    }
    atBoundary(turn) {
        if (turn?.kind !== 'autonomous' || turn.revision !== this.revision) return false;
        const story = this.beatSpec().lobbyStory;
        return this.beat + 1 >= this.beatLimit() || !!(story && story.step === story.total);
    }
    beatSpec(beat = this.beat) {
        const card = this.card;
        return card.beats?.[Math.min(beat, card.beats.length - 1)] || {
            id: `beat-${beat}`, label: ['案を出す', '別の角度', 'まとめる'][Math.min(2, Math.floor(beat / 3))],
            task: card.angles[Math.floor(beat / 3) % card.angles.length]
        };
    }
    snapshot() {
        const b = this.beatSpec();
        // scene: the opening-talk scene being talked about (e.g. today's news headline), for the stage's theme box.
        return { title: this.card.title, id: this.card.id, scene: b.lobbyStory?.title || null, beat: this.beat, revision: this.revision,
            stage: this.closed ? 'closed' : this.closing ? 'closing' : this.opened ? 'on_air' : 'opening',
            recentTopics: this.history.slice(-3), programme: this.programme ? { id: this.programme.id, title: this.programme.title, hook: this.programme.hook, question: this.programme.question } : null,
            progress: { round: Math.min(this.index + 1, this.cards.length), rounds: this.cards.length, step: Math.min(this.beat + 1, this.beatLimit()), steps: this.beatLimit(), label: b.label, focus: b.display || b.task },
            lastHeard: this.lastHeard, exhausted: this.exhausted, committedTurns: this.committedTurns };
    }
    /** A beat the gate would not approve is skipped (nothing aired, nothing committed as heard). */
    skipBeat() { if (this.closing || this.exhausted) return; if (++this.beat >= this.beatLimit()) this.nextTopic(); }
    /** A rejected premise cannot be assumed in its continuation. Nothing skipped becomes heard. */
    skipLobbyScene() {
        const id = this.beatSpec().lobbyStory?.sceneId;
        if (!id) { this.skipBeat(); return; }
        for (let n = 0; n < 6 && this.beatSpec().lobbyStory?.sceneId === id && !this.closing; n++) this.skipBeat();
    }
    skipLobby() {
        for (let n = 0; n < this.beatLimit() && this.beatSpec().lobby && !this.closing; n++) this.skipBeat();
    }
    nextTopic() {
        if (this.exhausted) return;
        this.history.push(this.card.title); this.history = this.history.slice(-3);
        this.revision++; this.beat = 0;
        if (this.finite && this.index + 1 >= this.cards.length) { this.exhausted = true; this.closing = true; return; }
        this.index++;
    }
    insertTopic(title, angles = null, jumpNow = false) {
        if (!title || typeof title !== 'string') throw new Error('Invalid topic title');
        const safeTitle = title.trim().slice(0, 48);
        const safeAngles = Array.isArray(angles) && angles.length ? angles.map(a => String(a).slice(0, 100)) : [
            `${safeTitle}について、ノア自身の考えや好み、具体例を交えて自然に話す。`,
            `${safeTitle}に関する面白い視点や意外な一面を考えてみる。`,
            `${safeTitle}について感じたことや気付きを短くまとめる。`
        ];
        const customCard = {
            id: `custom-${Date.now()}`,
            title: safeTitle,
            angles: safeAngles,
            beats: safeAngles.map((task, i) => ({
                id: `custom-beat-${i}`,
                label: i === 0 ? '話題の紹介' : i === 1 ? '深掘り' : 'まとめ',
                task,
                display: safeTitle
            }))
        };
        this.cards.splice(this.index + 1, 0, customCard);
        if (jumpNow) this.nextTopic();
        return customCard;
    }
    context(candidate, projected = null) {
        const s = this.projected(projected);
        // A viewer's comment during a long goodbye (TalkEngine farewell) is answered as a reply, not as a closing line.
        const kind = this.closing ? (candidate ? candidate.kind || 'reply' : 'closing') : !s.opened ? 'opening' : candidate?.kind || 'autonomous';
        const beat = Math.min(s.beat, this.beatLimit() - 1), b = this.beatSpec(beat);
        return { kind, topic: this.card.title, topicId: this.card.id, topicBeat: beat,
            progressKey: this.key(s), beatId: b.id, beatLabel: b.label, displayFocus: b.display || b.task,
            angle: b.task, goal: kind === 'opening' ? (this.programme?.hook || 'お題と、これから考える問いを一度だけ提示する') : kind === 'closing' ? '実際に話した内容から一つの気付きをまとめて終了する。新しい結論を捏造しない' : candidate ? 'コメントの内容へ直接返し、現在のお題へ戻す。元の結論を繰り返さない' : b.task,
            programmeTitle: this.programme?.title || this.card.title,
            returningTo: candidate ? this.card.title : null, recentTopics: [...this.history],
            dialogue: this.dialogue.slice(-4), recentSpeeches: this.recentSpeeches.slice(-6),
            ...(b.lobbyStory ? { lobbyStory: { ...b.lobbyStory,
                heard: this.lobbyHeard.filter(x => x.sceneId === b.lobbyStory.sceneId).map(({ beatId, text }) => ({ beatId, text })),
                previousScenes: this.lobbyCompleted.slice(-12) } } : {}),
            allowQuestion: !!b.invite && Date.now() - this.lastQuestionAt >= 180000,
            comment: candidate?.text || null, demo: b.demo ? [b.demo] : this.card.demo || [] };
    }
    commit(turn) {
        if (turn.serial !== undefined) {
            if (this.committed.has(turn.serial)) return false;
            this.committed.add(turn.serial); if (this.committed.size > 1024) this.committed.delete(this.committed.values().next().value);
        }
        if (turn.kind === 'opening') this.opened = true;
        if (turn.kind === 'closing' && turn.closingFinal !== false) this.closed = true; // a long goodbye closes on its last line
        if (turn.comment) this.dialogue.push({ comment: turn.comment, reply: turn.text });
        this.dialogue = this.dialogue.slice(-6);
        if (turn.text) {
            this.recentSpeeches.push(turn.text); this.recentSpeeches = this.recentSpeeches.slice(-8);
            this.lastHeard = String(turn.text).slice(0, 220);
            if (/[?？]/.test(turn.text)) this.lastQuestionAt = Date.now();
        }
        this.committedTurns++;
        if (turn.kind === 'autonomous' && turn.lobbyStory && turn.text && turn.progressKey === this.key()) {
            const story = turn.lobbyStory;
            this.lobbyHeard.push({ sceneId: story.sceneId, beatId: turn.beatId, text: String(turn.text).slice(0, 220) });
            this.lobbyHeard = this.lobbyHeard.slice(-6);
            if (story.step === story.total) {
                this.lobbyCompleted.push({ sceneId: story.sceneId, title: story.title, lastHeard: String(turn.text).slice(0, 140) });
                this.lobbyCompleted = this.lobbyCompleted.slice(-12);
            }
        }
        if ((turn.revision === undefined || turn.revision === this.revision) && turn.kind === 'autonomous' && ++this.beat >= this.beatLimit()) this.nextTopic();
        return true;
    }
}
export function sentences(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty speech');
    return (text.match(/[^。！？!?]+[。！？!?]*[」』”]?/gu) || [text]).map(x => x.trim()).filter(Boolean);
}
