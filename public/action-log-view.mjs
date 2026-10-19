// Always-on action log: the controller's last few commands of the current run (server: game_actions events).
// Writes textContent only and re-checks the small allowlisted shape; it keeps no history beyond what it shows.
const MAX_ITEMS = 5;
const ARROWS = new Set(['↑', '↗', '→', '↘', '↓', '↙', '←', '↖', '・', '★']);
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 24 && !/[\u0000-\u001f\u007f<>]/.test(v);
const second = v => Number.isSafeInteger(v) && v >= 0 && v <= 86400;
const clock = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;

export class ActionLogView {
    constructor(root) {
        this.root = root; this.state = { running: false, phase: '', runId: null, epoch: null }; this.disposed = false;
        const doc = root.ownerDocument;
        this.title = doc.createElement('div'); this.title.className = 'action-log-title'; this.title.textContent = 'ノアの操作';
        this.list = doc.createElement('ol'); this.list.className = 'action-log-items';
        root.append(this.title, this.list);
        this.clear();
    }
    setState({ running = this.state.running, phase = this.state.phase, runId = this.state.runId, epoch = this.state.epoch } = {}) {
        if (this.disposed) return;
        if (runId !== this.state.runId || epoch !== this.state.epoch) this.clear();
        this.state = { running: running === true, phase, runId, epoch };
        if (!this.state.running || phase !== 'playing') this.clear();
    }
    update(d) {
        const s = this.state;
        if (this.disposed || !s.running || s.phase !== 'playing' || !d || d.runId !== s.runId || s.epoch !== null && d.epoch !== s.epoch
            || !Array.isArray(d.items) || d.items.length < 1 || d.items.length > MAX_ITEMS) return false;
        const rows = [];
        for (const a of d.items) {
            if (!a || !second(a.t) || !ARROWS.has(a.arrow) || !text(a.text) || !['move', 'levelup'].includes(a.kind)) return false;
            const li = this.root.ownerDocument.createElement('li'); li.className = `action-log-item ${a.kind}`;
            for (const [cls, value] of [['time', clock(a.t)], ['arrow', a.arrow], ['text', a.text]]) {
                const span = this.root.ownerDocument.createElement('span'); span.className = `action-log-${cls}`; span.textContent = value; li.append(span);
            }
            rows.push(li);
        }
        this.list.replaceChildren(...rows); this.root.hidden = false;
        return true;
    }
    clear() { this.list.replaceChildren(); this.root.hidden = true; }
    dispose() { this.clear(); this.disposed = true; }
}
