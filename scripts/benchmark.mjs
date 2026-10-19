// Explicit opt-in to metered inference. This measures trial generation, not livestream delivery.
import { writeFileSync } from 'node:fs';
import { config, loadEnv } from '../src/config.mjs';
import { Ledger, Audit } from '../src/store.mjs';
import { rehearse } from '../src/settings.mjs';
import { Metrics } from '../src/metrics.mjs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
 console.log('npm run benchmark -- --confirm-metered --runs=3 [--out=report.json]\nUses the configured real APIs. Does not publish or play audio; output is not comment-to-viewer latency.');
} else {
 try {
  if (!args.includes('--confirm-metered')) throw new Error('Explicit --confirm-metered is required; no request was made.');
  const n = Number(args.find(x => x.startsWith('--runs='))?.split('=')[1] || 3);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('runs must be 1..10');
  loadEnv(); const c = config(); if (c.mode !== 'live') throw new Error('Save live settings first.');
  const ledger = new Ledger(c.dataDir, c.limits), audit = new Audit(c.dataDir), metrics = new Metrics();
  const samples = [];
  for (let i = 0; i < n; i++) {
   const started = performance.now(), result = await rehearse(c, ledger, audit);
   const elapsed = Math.round(performance.now() - started);
   samples.push({ attempt: i + 1, ok: result.ok, totalMs: elapsed, checks: result.checks, voice: result.voice ?? null });
   if (result.ok) { metrics.record('rehearsal_to_wav_ms', elapsed); for (const step of result.checks) metrics.record(step.name, step.ms); }
  }
  const report = { scope: 'real configured API rehearsal; no playback, OBS, comment intake or YouTube delivery measurement', at: new Date().toISOString(), node: process.version,
   model: c.llmProvider === 'gemini' ? c.geminiModel : c.llmModel, coldFirstSampleNotExcluded: true, requestedRuns: n, samples, metrics: metrics.snapshot(), usage: ledger.snapshot() };
  const out = JSON.stringify(report, null, 2) + '\n'; console.log(out);
  const target = args.find(x => x.startsWith('--out='))?.slice(6); if (target) writeFileSync(target, out, { mode: 0o600, flag: 'wx' });
  if (samples.some(x => !x.ok)) process.exitCode = 1;
 } catch (e) { console.error(e.message); process.exitCode = 1; }
}
