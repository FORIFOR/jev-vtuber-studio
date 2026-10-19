// Read-only macOS pressure probes. Never ask memory_pressure to generate load.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function readMemory() {
    const options = { timeout: 2000, maxBuffer: 8192 };
    const [level, pressure] = await Promise.all([
        exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options),
        exec('/usr/bin/memory_pressure', ['-Q'], options)
    ]);
    const freePercent = Number(pressure.stdout.match(/System-wide memory free percentage:\s*([\d.]+)%/)?.[1]);
    const pressureLevel = Number(level.stdout.trim());
    if (!Number.isFinite(freePercent) || ![1, 2, 4].includes(pressureLevel)) throw Error('Memory probe unavailable');
    return { freePercent, pressureLevel };
}
export const STALE_WARN_FREE = 40;
export class MemoryGuard {
    // sustainedStops=false (KEEP_LIVE): a warning that merely lasts is reported but never critical; only the hard limits are.
    constructor({ enabled = false, read = readMemory, now = Date.now, onChange = () => {}, onCritical = () => {}, sustainedStops = true } = {}) {
        Object.assign(this, { enabled, read, now, onChange, onCritical, sustainedStops });
        this.state = { enabled, level: enabled ? 'unknown' : 'disabled', at: 0 };
        this.warningAt = null; this.fired = false; this.closed = false;
    }
    async sample() {
        if (!this.enabled) return this.state;
        if (this.pending) return this.pending;
        this.pending = (async () => {
            let probe; try { probe = await this.read(); } catch { probe = null; }
            if (this.closed) return this.state;
            const at = this.now();
            // macOS can hold its pressure level at 2 (warn) long after memory is free again: on 2026-10-05 it stayed at 2
            // with 33-49% free and blocked a start. Level 2 with ample headroom (>= STALE_WARN_FREE) counts as normal.
            const warning = !probe || probe.pressureLevel === 4 || (probe.pressureLevel === 2 && probe.freePercent < STALE_WARN_FREE) || probe.freePercent <= 20;
            this.warningAt = warning ? (this.warningAt ?? at) : null;
            const immediate = !!probe && probe.freePercent <= 5;
            const warningMs = warning ? at - this.warningAt : 0;
            const hard = immediate ? 'emergency' : probe?.pressureLevel === 4 ? 'os_critical' : probe && probe.freePercent <= 10 ? 'low_headroom' : null;
            const reason = hard || (warningMs >= 30000 ? (probe ? 'sustained_warning' : 'probe_unavailable') : null);
            const critical = !!hard || (!!reason && this.sustainedStops);
            const level = critical ? 'critical' : !probe ? 'unknown' : warning ? 'warning' : 'normal';
            this.state = { enabled: true, at, level, ...probe, warningMs, reason };
            this.onChange(this.state);
            if (critical && (!this.fired || immediate && !this.immediateFired)) { this.fired = true; this.immediateFired ||= immediate; this.onCritical({ ...this.state, immediate }); }
            if (!warning) { this.fired = false; this.immediateFired = false; }
            return this.state;
        })();
        try { return await this.pending; } finally { this.pending = null; }
    }
    async assertStart() {
        const s = await this.sample();
        if (this.enabled && (s.level !== 'normal' || s.freePercent < 25)) {
            const e = Error('メモリの余裕を確認できないため開始を止めました。不要なアプリを閉じてから再試行してください。');
            e.code = 'MEMORY_UNSAFE'; throw e;
        }
    }
    start() { if (this.enabled && !this.timer) { void this.sample(); this.timer = setInterval(() => void this.sample(), 5000); this.timer.unref?.(); } }
    close() { this.closed = true; clearInterval(this.timer); }
}
// KEEP_LIVE's answer to a critical reading: the broadcast stays up and only the talk holds (no new lines, the local
// conversation model released). The hold ends after the reading has been normal for recoverMs in a row, measured
// against the same bar a broadcast needs to start (pressure normal, headroom >= 25%).
export class MemoryHold {
    // A hold that comes back within 10 min of a resume (the model's reload pushed memory up again) doubles the
    // calm time needed before the next resume, up to 5 min, so the talk does not flap on and off.
    constructor({ recoverMs = 20000, maxRecoverMs = 300000, flapMs = 600000 } = {}) {
        Object.assign(this, { baseMs: recoverMs, recoverMs, maxRecoverMs, flapMs, held: false, normalSince: null, resumedAt: null });
    }
    /** -> true when this reading starts a hold */
    critical(state = {}) {
        if (this.held) return false;
        const at = state.at ?? 0;
        this.recoverMs = this.resumedAt !== null && at - this.resumedAt < this.flapMs ? Math.min(this.maxRecoverMs, this.recoverMs * 2) : this.baseMs;
        this.held = true; this.normalSince = null; return true;
    }
    /** -> true when this reading ends the hold */
    update(state) {
        if (!this.held) return false;
        if (!(state.level === 'normal' && state.freePercent >= 25)) { this.normalSince = null; return false; }
        this.normalSince ??= state.at;
        if (state.at - this.normalSince < this.recoverMs) return false;
        this.held = false; this.normalSince = null; this.resumedAt = state.at; return true;
    }
    reset() { this.held = false; this.normalSince = null; this.resumedAt = null; this.recoverMs = this.baseMs; }
}
