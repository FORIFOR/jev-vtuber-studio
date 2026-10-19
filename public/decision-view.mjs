// Ephemeral HUD only: no playback, network calls, history or requestAnimationFrame loop.
// The server allowlists labels; this last boundary still checks shape/size and writes textContent only.
const MAX_VISIBLE_MS = 2000, COMBAT_INTERVAL_MS = 8000;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const label = v => typeof v === 'string' && v.length > 0 && v.length <= 24 && !/[\u0000-\u001f\u007f<>]/.test(v);
function valid(d, now) {
    if (!d || d.version !== 1 || d.applied !== true || typeof d.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(d.runId)
        || !count(d.sequence) || !count(d.attempt) || d.attempt < 1 || !['combat', 'levelup'].includes(d.phase)
        || d.id !== `${d.runId}:${d.sequence}:${d.attempt}` || !finite(d.recordedAt) || !finite(d.expiresAt)
        || d.recordedAt > now + 100 || d.expiresAt !== d.recordedAt + MAX_VISIBLE_MS || d.expiresAt <= now
        || d.hpPercent !== null && (!finite(d.hpPercent) || d.hpPercent < 0 || d.hpPercent > 100)
        || !label(d.choice?.label) || typeof d.choice?.id !== 'string' || d.choice.id.length > 20
        || !Array.isArray(d.candidates) || d.candidates.length < 1 || d.candidates.length > 3) return false;
    const ids = new Set(); let previous = Infinity;
    for (const c of d.candidates) {
        if (!c || typeof c.id !== 'string' || c.id.length > 20 || ids.has(c.id) || !label(c.label)
            || !finite(c.probability) || c.probability < 0 || c.probability > 1 || c.probability > previous) return false;
        ids.add(c.id); previous = c.probability;
    }
    return d.candidates[0].id === d.choice.id && d.candidates[0].label === d.choice.label;
}

export class DecisionView {
    constructor(root, { now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
        this.root = root; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
        this.state = { running: false, phase: '', runId: null, epoch: null }; this.sequence = -1; this.attempt = 0;
        this.cursorRunId = null; this.cursorEpoch = null;
        this.lastShownAt = -Infinity; this.timer = null; this.visibleUntil = 0; this.visiblePhase = null; this.disposed = false;
        this.parts = {};
        for (const [name, tag] of [['title', 'div'], ['choice', 'div'], ['candidates', 'ol'], ['hp', 'div'], ['note', 'div']]) {
            const el = root.ownerDocument.createElement(tag); el.className = `decision-${name}`;
            this.parts[name] = el; root.appendChild(el);
        }
        this.clear();
    }
    setState({ running = this.state.running, phase = this.state.phase, runId = this.state.runId, epoch = this.state.epoch } = {}) {
        if (this.disposed) return;
        if (epoch !== this.cursorEpoch || runId && runId !== this.cursorRunId) {
            this.clear(); this.sequence = -1; this.attempt = 0; this.lastShownAt = -Infinity;
            this.cursorEpoch = epoch; this.cursorRunId = runId;
        }
        this.state = { running: running === true, phase, runId, epoch };
        if (!this.state.running || phase !== 'playing' || !runId) this.clear();
    }
    push(d) {
        const now = this.now(), s = this.state;
        if (this.disposed || !s.running || s.phase !== 'playing' || !valid(d, now) || d.runId !== s.runId
            || s.epoch !== null && d.epoch !== s.epoch || d.sequence <= this.sequence || d.attempt <= this.attempt) return false;
        // Consume even suppressed events, so a later duplicate cannot reappear after the cooldown.
        this.sequence = d.sequence; this.attempt = d.attempt;
        if (d.phase === 'combat' && now - this.lastShownAt < COMBAT_INTERVAL_MS
            || d.phase === 'levelup' && this.visiblePhase === 'levelup' && now < this.visibleUntil) return false;
        this.clear(); this.lastShownAt = now; this.visiblePhase = d.phase; this.visibleUntil = Math.min(now + MAX_VISIBLE_MS, d.expiresAt);
        const p = this.parts;
        p.title.textContent = 'Jevの判断'; p.choice.textContent = `${d.choice.label} · 入力受付済み`;
        p.candidates.replaceChildren();
        for (const c of d.candidates) {
            const row = this.root.ownerDocument.createElement('li'); row.className = 'decision-candidate'; row.dataset.selected = String(c.id === d.choice.id);
            for (const [kind, text] of [['label', c.label], ['probability', `${Math.round(c.probability * 100)}%`]]) {
                const span = this.root.ownerDocument.createElement('span'); span.className = `decision-candidate-${kind}`; span.textContent = text; row.appendChild(span);
            }
            p.candidates.appendChild(row);
        }
        p.hp.hidden = d.hpPercent === null; p.hp.textContent = d.hpPercent === null ? '' : `判断前のHP ${Math.round(d.hpPercent)}%`;
        p.note.textContent = '候補の選択分布 · 上位3件まで'; this.root.dataset.phase = d.phase; this.root.hidden = false;
        this.timer = this.setTimer(() => this.clear(), Math.max(0, this.visibleUntil - now));
        return true;
    }
    clear() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null; this.visibleUntil = 0; this.visiblePhase = null; this.root.hidden = true;
        delete this.root.dataset.phase;
    }
    dispose() { this.clear(); this.disposed = true; }
}
