// Bounded, non-text operational measurements; application time != YouTube audience latency.
export class Metrics {
    constructor() { this.values = new Map(); this.counters = {}; }
    record(name, ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        const v = this.values.get(name) || []; v.push(Math.round(ms));
        if (v.length > 512) v.shift(); this.values.set(name, v);
    }
    count(name, n = 1) { this.counters[name] = (this.counters[name] || 0) + n; }
    snapshot() {
        return { counters: { ...this.counters }, latency: Object.fromEntries([...this.values].map(([k, v]) => {
            const sorted = [...v].sort((a, b) => a - b), p = n => sorted[Math.max(0, Math.ceil(sorted.length * n) - 1)];
            return [k, { samples: v.length, last: v.at(-1), p50: p(.5), p95: p(.95), max: sorted.at(-1) }];
        })) };
    }
}
