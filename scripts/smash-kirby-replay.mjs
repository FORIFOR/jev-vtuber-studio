#!/usr/bin/env node
// Offline only: reads observations and returns plans. Never pairs or controls Switch.
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { planKirbyRecovery, validateLibrary } from '../src/smash-kirby.mjs';

async function main(args) {
  if (args.length === 1 && args[0] === '--demo') {
    const { fixture } = await import('../test/smash-kirby-fixtures.mjs');
    for (const scenario of ['unopposed', 'early_edgeguard', 'late_dodge_punish']) {
      const { s, library } = fixture();
      if (scenario === 'early_edgeguard') s.threats.boxes = [{ from: 10, to: 12, x: [-2, 0], y: [-1, 1] }];
      if (scenario === 'late_dodge_punish') { library.samples = [library.samples[1]]; s.threats.boxes = [{ from: 40, to: 42, x: [-2, 0], y: [-1, 1] }]; }
      console.log(JSON.stringify({ source: 'synthetic-test-only', scenario, result: planKirbyRecovery(s, library, { nowMs: 1000 }) }));
    }
    return;
  }
  if (args.length !== 4 || args[0] !== '--library' || args[2] !== '--observations') throw new Error('Usage: node scripts/smash-kirby-replay.mjs --demo | --library library.json --observations observations.jsonl');
  const library = validateLibrary(JSON.parse(await readFile(args[1], 'utf8')));
  const input = createReadStream(args[3], { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let previous = null, epoch = null, count = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 65536) throw new Error('Observation exceeds 64 KiB');
    const s = JSON.parse(line), identity = JSON.stringify([s.matchId, s.stockId]);
    if (!Number.isFinite(s.decisionAtMs)) throw new Error('Recorded decisionAtMs is required; replay must not erase transport latency');
    if (epoch === identity && previous !== null && s.frame <= previous) throw new Error('Out-of-order observation');
    epoch = identity; previous = s.frame; count++;
    console.log(JSON.stringify({ source: 'offline-replay', frame: s.frame, result: planKirbyRecovery(s, library, { nowMs: s.decisionAtMs }) }));
  }
  if (!count) throw new Error('No observations; no successful validation can be inferred');
}
main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 2; });
