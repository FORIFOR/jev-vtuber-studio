#!/usr/bin/env node
// Training audio for an RVC model of Noa's voice (docs/HUMAN_VOICE.md, NOA Studio Phase 3b). Speaks each line of a
// text file with the Studio's AivisSpeech voice (AIVIS_URL / AIVIS_STYLE, コハク) and writes one WAV per line, a
// transcript list and the voice model's licence (ACML 1.0 allows derived models; it must travel with them, and the
// result must never pass as the speaker's or an official voice). Training happens outside the Studio.
//   node scripts/kohaku-dataset.mjs --text sentences.txt --out data/kohaku-dataset [--limit 600]
// Use a text whose licence you have checked. Lines are spoken as written; empty lines and lines over 120 characters
// are skipped.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadEnv } from '../src/config.mjs';
import { wavInfo } from '../src/stt.mjs';

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const textFile = arg('text'), out = arg('out', 'data/kohaku-dataset'), limit = Number(arg('limit', '600'));
if (!textFile) { console.error('Usage: node scripts/kohaku-dataset.mjs --text sentences.txt [--out data/kohaku-dataset] [--limit 600]'); process.exit(2); }
loadEnv();
const c = config(), base = String(c.aivisURL).replace(/\/$/, ''), speaker = String(c.aivisStyle);
const lines = readFileSync(textFile, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && x.length <= 120).slice(0, limit);
mkdirSync(join(out, 'wavs'), { recursive: true });

// The voice model's own licence text, from the engine (written next to the audio; keep it with any derived model).
// Style id -> speaker (GET /speakers) -> the installed model carrying that speaker (GET /aivm_models).
const speakers = await (await fetch(`${base}/speakers`)).json(), models = await (await fetch(`${base}/aivm_models`)).json();
const uuid = speakers.find(sp => sp.styles?.some(st => String(st.id) === speaker))?.speaker_uuid;
const model = Object.values(models).find(m => m.manifest?.speakers?.some(sp => sp.uuid === uuid));
if (!model) { console.error(`AivisSpeech style ${speaker} was not found among the installed models.`); process.exit(1); }
if (model?.manifest?.license) writeFileSync(join(out, 'LICENSE-voice-model.md'), model.manifest.license);
writeFileSync(join(out, 'README.txt'), [
    `Source voice: ${model?.manifest?.name || 'AivisSpeech style ' + speaker} (AivisSpeech). Credit on stream: ${c.aivisCredit || 'AivisSpeech'}.`,
    'Licence: see LICENSE-voice-model.md (keep it with this audio and any model trained from it).',
    'Never present the result as the original speaker, the creator or an official voice.', ''].join('\n'));

const list = [];
let total = 0;
for (const [i, text] of lines.entries()) {
    const query = await (await fetch(`${base}/audio_query?${new URLSearchParams({ text, speaker })}`, { method: 'POST' })).json();
    const r = await fetch(`${base}/synthesis?${new URLSearchParams({ speaker })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    if (!r.ok) { console.error(`line ${i + 1}: synthesis failed (${r.status})`); continue; }
    const wav = Buffer.from(await r.arrayBuffer()), name = `${String(i + 1).padStart(4, '0')}.wav`;
    writeFileSync(join(out, 'wavs', name), wav);
    list.push(`wavs/${name}|${text}`);
    try { total += wavInfo(wav).durationMs / 1000; } catch { }
    if ((i + 1) % 25 === 0) console.log(`${i + 1}/${lines.length} lines · about ${Math.round(total / 60)} min`);
}
writeFileSync(join(out, 'transcripts.txt'), list.join('\n') + '\n');
console.log(`Wrote ${list.length} WAVs to ${out} (about ${Math.round(total / 60)} min).`);
