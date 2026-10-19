import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TtsError } from './tts-adapters.mjs';
// Persistent cloud-voice spend (estimated USD from generated audio): survives restarts, counts audio that was generated
// but never played, and reserves an estimate BEFORE each request so concurrent requests cannot overrun the caps.
export class CloudSpend {
    constructor(dir, { dayUsd = 3, monthUsd = 10 } = {}, now = () => new Date()) {
        this.dir = dir; this.caps = { dayUsd, monthUsd }; this.now = now; this.path = join(dir, 'cloud-spend.json');
        this.data = { days: {}, months: {} }; this.reserved = new Map(); this.seq = 0; this.session = null;
        if (existsSync(this.path)) {
            try {
                const d = JSON.parse(readFileSync(this.path, 'utf8'));
                if (!d || typeof d.days !== 'object' || typeof d.months !== 'object') throw new Error();
                this.data = d;
            } catch { throw new Error('Cloud spend record corrupt; inspect data/cloud-spend.json before restarting'); }
        }
    }
    keys() { const iso = this.now().toISOString(); return { day: iso.slice(0, 10), month: iso.slice(0, 7) }; }
    pending() { let n = 0; for (const v of this.reserved.values()) n += v; return n; }
    totals() { const { day, month } = this.keys(); return { dayUsd: this.data.days[day]?.usd || 0, monthUsd: this.data.months[month]?.usd || 0 }; }
    /** Returns a reservation id, or throws TTS_BUDGET when the estimate would pass a cap. */
    reserve(estimateUsd) {
        const t = this.totals(), p = this.pending(), e = Math.max(0, Number(estimateUsd) || 0);
        if (t.dayUsd + p + e > this.caps.dayUsd || t.monthUsd + p + e > this.caps.monthUsd)
            throw new TtsError('TTS_BUDGET', 'Cloud TTS spend cap reached');
        const id = ++this.seq; this.reserved.set(id, e); return id;
    }
    /** A standing reservation under a name (e.g. the show's closing line): counted like an in-flight request until
     * released, so other speech cannot spend it. Throws TTS_BUDGET when it does not fit. Idempotent per key. */
    hold(key, usd) {
        if (this.reserved.has(key)) return key;
        const t = this.totals(), p = this.pending(), e = Math.max(0, Number(usd) || 0);
        if (t.dayUsd + p + e > this.caps.dayUsd || t.monthUsd + p + e > this.caps.monthUsd)
            throw new TtsError('TTS_BUDGET', 'Cloud TTS spend cap reached');
        this.reserved.set(key, e); return key;
    }
    release(key) { return this.reserved.delete(key); }
    /** Records what was actually generated (billed even if never played) and releases the reservation. */
    settle(id, { usd = 0, audioSec = 0 } = {}) {
        this.reserved.delete(id);
        const { day, month } = this.keys(), d = this.data.days[day] ||= { usd: 0, audioSec: 0, requests: 0 }, m = this.data.months[month] ||= { usd: 0, audioSec: 0, requests: 0 };
        for (const r of [d, m, ...(this.session ? [this.session] : [])]) { r.usd = Math.round((r.usd + usd) * 1e6) / 1e6; r.audioSec = Math.round((r.audioSec + audioSec) * 10) / 10; r.requests++; }
        // Keep the file small: the last 62 days and 24 months.
        for (const [k, keep] of [['days', 62], ['months', 24]]) { const ks = Object.keys(this.data[k]).sort(); for (const x of ks.slice(0, Math.max(0, ks.length - keep))) delete this.data[k][x]; }
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path);
    }
    /** Per-broadcast counter (the day/month records are running totals): what THIS show generated, as an estimate. */
    startSession(now = this.now()) { this.session = { startedAt: now.toISOString(), usd: 0, audioSec: 0, requests: 0 }; return this.session; }
    sessionSnapshot() { return this.session ? { ...this.session } : null; }
    /** USD still spendable under both caps (after in-flight reservations). */
    remaining() { const t = this.totals(), p = this.pending(); return Math.max(0, Math.min(this.caps.dayUsd - t.dayUsd - p, this.caps.monthUsd - t.monthUsd - p)); }
    snapshot() { return { ...this.totals(), pendingUsd: Math.round(this.pending() * 1e6) / 1e6, caps: { ...this.caps } }; }
}
