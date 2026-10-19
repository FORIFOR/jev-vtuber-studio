#!/usr/bin/env node
// Hotkeys from any app (docs/CONTROL.md, NOA Studio Phase 6): `npm run hotkeys` while the Studio runs. Builds the small
// macOS helper (scripts/hotkeys.swift -> data/bin/noa-hotkeys; Carbon hotkeys, no Accessibility permission), registers
// the operator's keys (/api/hotkeys, defaults F6-F10) and sends each press to the Studio as a hotkey action, which the
// Studio resolves on the current state (POST /api/control {action:'hotkey'}). The keys are re-read every 10 s; a change
// re-registers them. Mac function keys: turn on "Use F1, F2, etc. keys as standard function keys" or hold fn.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { config, loadEnv, ROOT } from '../src/config.mjs';

loadEnv();
const c = config(), base = `http://127.0.0.1:${c.port}`, source = join(ROOT, 'scripts', 'hotkeys.swift'), binary = join(c.dataDir, 'bin', 'noa-hotkeys');
const api = async (path, data) => {
    const r = await fetch(base + path, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${c.adminToken}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
};

if (process.platform !== 'darwin') { console.error('Global hotkeys are macOS only; the Studio and /control pages still take the keys while open.'); process.exit(1); }
if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    mkdirSync(join(c.dataDir, 'bin'), { recursive: true });
    console.log('Building the hotkey helper…');
    execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: 'inherit' });
}

let child = null, keys = '', map = {};
function run(next) {
    child?.kill();
    map = next; keys = JSON.stringify(Object.keys(next).sort());
    child = spawn(binary, Object.keys(next), { stdio: ['ignore', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout }).on('line', line => {
        if (line.startsWith('ready ')) { console.log(`${line.slice(6)} → ${next[line.slice(6)]}`); return; }
        const name = map[line];
        if (!name) return;
        api('/api/control', { action: 'hotkey', name, by: 'global' })
            .then(() => console.log(`${new Date().toLocaleTimeString('ja-JP')} ${line} ${name}`), e => console.log(`${new Date().toLocaleTimeString('ja-JP')} ${line} ${name}: ${e.message}`));
    });
    child.on('exit', code => { if (child && code !== null && code !== 0) console.error(`The hotkey helper stopped (${code}).`); });
}
async function refresh() {
    try { const r = await api('/api/hotkeys'); if (JSON.stringify(Object.keys(r.map).sort()) !== keys || JSON.stringify(r.map) !== JSON.stringify(map)) run(r.map); }
    catch (e) { if (!child) { console.error(`The Studio is not reachable (${e.message}). Start it first.`); process.exit(1); } }
}
await refresh();
setInterval(() => { void refresh(); }, 10000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child?.kill(); process.exit(0); });
