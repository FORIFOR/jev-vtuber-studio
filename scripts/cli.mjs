#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) { console.error('Node.js 22.12+ is required. / Node.js 22.12以降を導入してください。'); process.exit(1); }
const [command = 'start', ...args] = process.argv.slice(2);
if (['help', '--help', '-h'].includes(command)) {
 console.log('Jev VTuber Studio\n  node scripts/cli.mjs start  # saved settings, guided local setup\n  node scripts/cli.mjs demo   # fixed-script offline demo\n  node scripts/cli.mjs doctor # metadata checks, not a rehearsal\nNo external stream is started automatically.');
} else if (['start', 'demo', 'doctor'].includes(command)) {
 const file = command === 'doctor' ? 'scripts/doctor.mjs' : command === 'start' ? 'scripts/supervised.mjs' : 'src/server.mjs';
 const child = spawn(process.execPath, [resolve(root, file), ...(command === 'demo' ? ['--demo'] : []), ...args], { cwd: root, stdio: 'inherit', env: process.env });
 child.on('error', () => { console.error('Cannot launch local Studio.'); process.exitCode = 1; });
 child.on('exit', code => { process.exitCode = code ?? 1; });
 for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (!child.killed) child.kill(sig); });
} else { console.error('Unknown command. Run node scripts/cli.mjs --help'); process.exitCode = 1; }
