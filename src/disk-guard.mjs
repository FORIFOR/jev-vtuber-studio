// Disk headroom for a broadcast. Live 2026-10-11 01:43: the volume filled during a 5.5 h show (OBS's own recording
// grew ~2.8 GB/h); the game player could not write its log, the show stopped without a goodbye and the stream dropped.
// Before a start, old files the Studio owns are pruned and the start needs startGb free. On air: below lowGb OBS's
// recording stops (the stream goes on); below criticalGb the show says goodbye and ends.
import { statfs } from 'node:fs/promises';
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GB = 1024 ** 3, DAY = 86400000;
export async function readDisk(path) {
    const s = await statfs(path);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}
// OBS's default recording names ("2026-10-10 20-08-02.mov"): only these are ever removed, never other videos in the folder.
export const RECORDING_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.(mov|mp4|mkv|flv|ts|m4v)$/;

/** Remove what the Studio owns and no longer needs. -> { removed: [names], bytes } (never throws). */
export function prune({ runsDir = '', dataDir = '', recordingsDir = '', keepRecordings = 2, runsDays = 7, logsDays = 14, now = Date.now() } = {}) {
    const removed = [];
    let bytes = 0;
    const size = p => { try { const s = statSync(p); if (!s.isDirectory()) return s.size; return readdirSync(p).reduce((n, x) => n + size(join(p, x)), 0); } catch { return 0; } };
    const drop = p => { const n = size(p); try { rmSync(p, { recursive: true, force: true }); removed.push(p); bytes += n; } catch { } };
    const older = (dir, match, days) => {
        if (!dir || !existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
            if (!match.test(name)) continue;
            const p = join(dir, name);
            try { if (now - statSync(p).mtimeMs > days * DAY) drop(p); } catch { }
        }
    };
    older(runsDir, /^vampire-/, runsDays);
    if (dataDir) {
        older(dataDir, /^studio-\d{8}-\d{6}\.log$/, logsDays);
        older(join(dataDir, 'round-reviews'), /^live-/, logsDays);
        older(join(dataDir, 'post-stream'), /^show_/, logsDays); // the clip studio's renders (uploaded or given up by then)
    }
    if (recordingsDir && existsSync(recordingsDir)) {
        // Newest first; one written in the last 10 minutes may still be recording and is always kept.
        const files = readdirSync(recordingsDir).filter(n => RECORDING_NAME.test(n))
            .map(n => { try { return { p: join(recordingsDir, n), t: statSync(join(recordingsDir, n)).mtimeMs }; } catch { return null; } })
            .filter(Boolean).sort((a, b) => b.t - a.t);
        for (const f of files.slice(Math.max(0, keepRecordings))) if (now - f.t > 600000) drop(f.p);
    }
    return { removed, bytes };
}

export class DiskGuard {
    constructor({ enabled = false, path = '.', read = readDisk, startGb = 20, lowGb = 8, criticalGb = 3, onChange = () => {}, onLow = () => {}, onCritical = () => {}, now = Date.now } = {}) {
        Object.assign(this, { enabled, path, read, startGb, lowGb, criticalGb, onChange, onLow, onCritical, now });
        this.state = { enabled, level: enabled ? 'unknown' : 'disabled', at: 0 };
        this.lowFired = false; this.criticalFired = false;
    }
    async sample() {
        if (!this.enabled) return this.state;
        let probe = null; try { probe = await this.read(this.path); } catch { }
        if (this.closed) return this.state; // a reading that lands after close() reports nothing
        const freeGb = probe ? Math.round(probe.freeBytes / GB * 10) / 10 : null;
        const level = freeGb === null ? 'unknown' : freeGb < this.criticalGb ? 'critical' : freeGb < this.lowGb ? 'low' : freeGb < this.startGb ? 'warning' : 'normal';
        const changed = level !== this.state.level;
        this.state = { enabled: true, at: this.now(), level, freeGb };
        if (changed) this.onChange(this.state);
        if ((level === 'low' || level === 'critical') && !this.lowFired) { this.lowFired = true; this.onLow(this.state); }
        if (level === 'critical' && !this.criticalFired) { this.criticalFired = true; this.onCritical(this.state); }
        // Room again (files removed): the next shortage is reported again.
        if (level === 'normal' || level === 'warning') { this.lowFired = false; this.criticalFired = false; }
        return this.state;
    }
    async assertStart() {
        const s = await this.sample();
        if (this.enabled && s.level !== 'normal') {
            const e = Error(s.freeGb === null ? 'ディスクの空きを確認できないため開始を止めました。'
                : `ディスクの空きが${s.freeGb}GBしかないため開始を止めました（${this.startGb}GB以上必要。録画は1時間で約3GB使います）。不要なファイルを消してから再試行してください。`);
            e.code = 'DISK_LOW'; throw e;
        }
    }
    start(intervalMs = 30000) { if (this.enabled && !this.timer) { void this.sample(); this.timer = setInterval(() => void this.sample(), intervalMs); this.timer.unref?.(); } }
    close() { this.closed = true; clearInterval(this.timer); this.timer = null; }
}
