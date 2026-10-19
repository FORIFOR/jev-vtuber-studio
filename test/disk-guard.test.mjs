import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiskGuard, prune } from '../src/disk-guard.mjs';

const GB = 1024 ** 3, DAY = 86400000;
const temp = t => { const d = mkdtempSync(join(tmpdir(), 'jvs-disk-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const file = (p, ageMs, now) => { writeFileSync(p, 'x'); const s = new Date(now - ageMs); utimesSync(p, s, s); };

test('prune: old player logs, Studio logs and round reviews go; OBS recordings past the newest two go, other videos and a live one stay', t => {
    const now = Date.now(), root = temp(t), runs = join(root, 'runs'), data = join(root, 'data'), rec = join(root, 'Movies');
    for (const d of [runs, data, join(data, 'round-reviews'), rec]) mkdirSync(d, { recursive: true });
    mkdirSync(join(runs, 'vampire-old-r1')); file(join(runs, 'vampire-old-r1', 'decisions.jsonl'), 0, now);
    utimesSync(join(runs, 'vampire-old-r1'), new Date(now - 8 * DAY), new Date(now - 8 * DAY));
    mkdirSync(join(runs, 'vampire-new-r1'));
    mkdirSync(join(runs, 'notes')); utimesSync(join(runs, 'notes'), new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    file(join(data, 'studio-20260901-200000.log'), 20 * DAY, now); file(join(data, 'studio-20261010-200000.log'), DAY, now);
    file(join(data, 'show-log.jsonl'), 60 * DAY, now);
    mkdirSync(join(data, 'round-reviews', 'live-a')); utimesSync(join(data, 'round-reviews', 'live-a'), new Date(now - 20 * DAY), new Date(now - 20 * DAY));
    file(join(rec, '2026-10-01 20-00-00.mov'), 9 * DAY, now); file(join(rec, '2026-10-05 20-00-00.mov'), 5 * DAY, now);
    file(join(rec, '2026-10-08 20-00-00.mov'), 2 * DAY, now); file(join(rec, '2026-10-10 20-00-00.mov'), 60000, now);
    file(join(rec, 'family.mov'), 90 * DAY, now);
    const r = prune({ runsDir: runs, dataDir: data, recordingsDir: rec, now });
    assert.equal(existsSync(join(runs, 'vampire-old-r1')), false); assert.equal(existsSync(join(runs, 'vampire-new-r1')), true);
    assert.equal(existsSync(join(runs, 'notes')), true, 'only the player\'s own run folders');
    assert.equal(existsSync(join(data, 'studio-20260901-200000.log')), false); assert.equal(existsSync(join(data, 'studio-20261010-200000.log')), true);
    assert.equal(existsSync(join(data, 'show-log.jsonl')), true, 'other data files are never pruned');
    assert.equal(existsSync(join(data, 'round-reviews', 'live-a')), false);
    assert.equal(existsSync(join(rec, '2026-10-10 20-00-00.mov')), true); assert.equal(existsSync(join(rec, '2026-10-08 20-00-00.mov')), true);
    assert.equal(existsSync(join(rec, '2026-10-05 20-00-00.mov')), false); assert.equal(existsSync(join(rec, '2026-10-01 20-00-00.mov')), false);
    assert.equal(existsSync(join(rec, 'family.mov')), true, 'a video OBS did not name is never removed');
    assert.equal(r.removed.length, 5); assert.ok(r.bytes > 0);
    // keepRecordings 0 still keeps one written in the last 10 minutes (it may be recording).
    prune({ recordingsDir: rec, keepRecordings: 0, now });
    assert.equal(existsSync(join(rec, '2026-10-10 20-00-00.mov')), true); assert.equal(existsSync(join(rec, '2026-10-08 20-00-00.mov')), false);
});

test('disk guard: levels, start refusal, low once (recording) then critical once (goodbye), re-armed when room returns', async () => {
    let free = 25;
    const low = [], critical = [];
    const g = new DiskGuard({ enabled: true, read: async () => ({ freeBytes: free * GB }), onLow: s => low.push(s.freeGb), onCritical: s => critical.push(s.freeGb) });
    assert.equal((await g.sample()).level, 'normal'); await g.assertStart();
    free = 15; assert.equal((await g.sample()).level, 'warning');
    await assert.rejects(g.assertStart(), e => e.code === 'DISK_LOW' && /15GB/.test(e.message));
    free = 7; await g.sample(); free = 6; await g.sample();
    assert.deepEqual(low, [7]); assert.deepEqual(critical, []);
    free = 2; await g.sample(); free = 1; await g.sample();
    assert.deepEqual(low, [7]); assert.deepEqual(critical, [2]);
    free = 30; await g.sample(); free = 5; await g.sample();
    assert.deepEqual(low, [7, 5]);
    const off = new DiskGuard({ enabled: false, read: async () => { throw Error('must not read'); } });
    assert.equal((await off.sample()).level, 'disabled'); await off.assertStart();
    const blind = new DiskGuard({ enabled: true, read: async () => { throw Error('x'); } });
    await assert.rejects(blind.assertStart(), e => e.code === 'DISK_LOW');
});

test('HTTP start is refused with the free space when the disk is short; on air, low stops the recording and critical says goodbye', async t => {
    const { createApp } = await import('../src/server.mjs'); const { setup } = await import('./helpers.mjs');
    const c = setup(t, { DISK_GUARD: '1' }); c.mode = 'live';
    let free = 12, recordingStops = 0, rehearsals = 0;
    const app = createApp(c, { remoteOptions: null, diskRead: async () => ({ freeBytes: free * GB }),
        obs: { owned: false, ready: false, stopOwned: async () => {}, stopRecording: async () => { recordingStops++; return true; }, recordDirectory: async () => '', close() {} },
        conversation: { generate: async () => { rehearsals++; throw Error('Must not call'); } } });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => app.close());
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/control`, { method: 'POST', headers: { Authorization: `Bearer ${c.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /ディスクの空きが12GB/); assert.equal(rehearsals, 0); assert.equal(app.engine.running, false);
    let closing; app.engine.running = true; app.engine.requestClose = reason => { closing = reason; };
    free = 7; await app.disk.sample(); await new Promise(r => setImmediate(r));
    assert.equal(recordingStops, 1); assert.equal(closing, undefined);
    free = 2; await app.disk.sample(); assert.equal(closing, 'disk_low');
    app.engine.running = false;
});
