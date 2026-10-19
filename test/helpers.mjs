import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';
export const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export function setup(t, env = {}) { const dir = mkdtempSync(join(tmpdir(), 'jvs-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return config({ DATA_DIR: dir, SHOW_PROFILE: 'playground', READ_COMMENTS: 'false', DISK_GUARD: '0', STREAM_TITLE: '0', ADMIN_TOKEN: 'a'.repeat(48), VIEW_TOKEN: 'v'.repeat(48), ...env }, []); }
export function ledger() { const calls = {}; return { reserve(k) { calls[k] = (calls[k] || 0) + 1; }, snapshot() { return { day: '2026-09-22', calls: { ...calls }, limits: { jev: 1000, llm: 100, tts: 100, search: 10, youtube: 100 } }; }, calls }; }
export const audit = { log() { } };
export function engine(c, overrides = {}) { return new Engine(c, { ledger: ledger(), audit, jev: { lastMs: 0, chat: async () => ({ accept: true, action: 'reply' }), speech: async () => ({ accept: true, effect: 'none', mood: 'warm' }) }, conversation: { generate: async () => '今夜は星を探してみよう。' }, voice: { synthesize: async () => ({ kind: 'browser', durationMs: 3000, bytes: null }) }, research: { search: async () => ({ sources: [], demo: true }) }, ...overrides }); }
export function active(e) { e.running = true; e.epoch++; e.controller = new AbortController(); e.endAt = Date.now() + 60000; e.claimRenderer('test-renderer'); return e; }
export const response = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
export function wav(seconds = .1) { const sr = 24000, size = Math.round(seconds * sr) * 2, b = Buffer.alloc(44 + size); b.write('RIFF'); b.writeUInt32LE(36 + size, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(size, 40); return b; }
export function choiceAnswer(criteria, pick) { const keys = Object.keys(criteria); return { type: 'choice', choice: pick, confidence: .9, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 1 : 0])) }; }
// Local judge (src/local-judge.mjs) in fixtures: recognise its chat request and answer it from the gate's typed
// questions, so a fixture can keep deciding per question key ({type:'noul', noul} / {type:'choice', choice, confidence}).
export function judgeRequest(body) {
    const [system, user] = body?.messages || [];
    if (!/strict judge/.test(system?.content || '')) return null;
    const { state, questions } = JSON.parse(user.content);
    return { state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.kind === 'probability'
        ? { type: 'noul', instructions: q.question } : { type: 'choice', instructions: q.question, criteria: q.options }])) };
}
/** Gate-shaped answers -> the local judge's raw JSON, as an OpenAI-compatible (default) or Ollama chat response. */
export function judgeResponse(answers, provider = 'compatible') {
    const raw = Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === 'noul' ? a.noul : { choice: a.choice, confidence: a.confidence }]));
    const content = JSON.stringify(raw);
    return provider === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] };
}
