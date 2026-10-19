#!/usr/bin/env node
// Writes the public (OSS) copy of the committed tree (NOA Studio Phase 7, operator 2026-10-19): `git archive HEAD` minus
// the assets whose redistribution or origin is not confirmed (docs/ASSETS.md) and the tests that check those assets
// themselves. Local only: it never pushes; the public repository receives the result as one commit, so the private
// history (author e-mail, old local paths) is not published.
//   node scripts/export-public.mjs <empty output folder>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT } from '../src/config.mjs';

export const EXCLUDE = Object.freeze([
    'public/models/noa3d/Noa.vrm', // VRoid AvatarSample_A, modified: terms per VRoid
    'public/models/room', // the room pack (background, stickers, can): origin not recorded
    'docs/outfit-signal-preview.png', 'docs/outfit-jacket-preview.png', 'docs/outfit-midnight-preview.png', // renders of Noa.vrm
    'test/vrm-assets.test.mjs', 'test/vrm-expression-state.test.mjs', 'test/vrm-face-fit.test.mjs', 'test/vrm-framing.test.mjs', 'test/vrm-outfits.test.mjs', // check Noa.vrm itself
]);

const out = resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('Usage: node scripts/export-public.mjs <empty output folder>'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error(`${out} is not empty.`); process.exit(1); }
if (execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()) console.warn('Note: uncommitted changes are not exported (git archive HEAD).');
mkdirSync(out, { recursive: true });
execFileSync('/bin/sh', ['-c', `git archive HEAD | tar -x -C "${out.replace(/"/g, '\\"')}"`], { cwd: ROOT, stdio: 'inherit' });
for (const path of EXCLUDE) rmSync(join(out, path), { recursive: true, force: true });
console.log(`Exported HEAD (${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()}) to ${out} without ${EXCLUDE.length} private or unconfirmed paths.`);
