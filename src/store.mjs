import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
export class Ledger {
    constructor(dir, limits, now = () => new Date()) { mkdirSync(dir, { recursive: true, mode: 0o700 }); this.dir = dir; this.limits = limits; this.now = now; this.path = join(dir, 'usage.json'); this.data = { day: '', calls: {} }; if (existsSync(this.path)) {
        try {
            this.data = JSON.parse(readFileSync(this.path, 'utf8'));
            if (typeof this.data?.day !== 'string' || !this.data.calls || typeof this.data.calls !== 'object' || Array.isArray(this.data.calls) || Object.values(this.data.calls).some(v => !Number.isSafeInteger(v) || v < 0))
                throw new Error('Invalid ledger schema');
        }
        catch {
            throw new Error('Usage ledger corrupt; inspect data/usage.json before restarting');
        }
    } }
    refresh() { const day = this.now().toISOString().slice(0, 10); if (this.data.day !== day)
        this.data = { day, calls: {} }; }
    reserve(kind) { this.refresh(); if (!Object.hasOwn(this.limits, kind))
        throw new Error('Unknown budget'); if ((this.data.calls[kind] || 0) >= this.limits[kind])
        throw new Error(`Daily ${kind} call limit reached`); this.data.calls[kind] = (this.data.calls[kind] || 0) + 1; writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 }); renameSync(`${this.path}.tmp`, this.path); }
    recordUsage(provider, model, usage = {}) {
        this.refresh();
        const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.prompt_eval_count ?? usage.promptTokenCount ?? 0);
        const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.eval_count ?? usage.candidatesTokenCount ?? 0);
        if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) return;
        this.data.tokens ||= {};
        const key = `${provider}:${String(model || 'unknown').slice(0, 100)}`;
        if (!Object.hasOwn(this.data.tokens, key) && Object.keys(this.data.tokens).length >= 32) return;
        const row = this.data.tokens[key] ||= { input: 0, output: 0, responses: 0 };
        row.input += input; row.output += output; row.responses++;
        writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
        renameSync(`${this.path}.tmp`, this.path);
    }
    snapshot() { this.refresh(); return { ...this.data, calls: { ...this.data.calls }, limits: { ...this.limits } }; }
}
// Event metadata only: never persist viewer text, names, generated prose, keys or audio.
export class Audit {
    constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    log(type, meta = {}) { const p = join(this.dir, 'events.jsonl'); if (existsSync(p) && statSync(p).size > 2000000)
        renameSync(p, `${p}.1`); const allowed = {}; for (const k of ['id', 'reason', 'provider', 'ms', 'count', 'hash', 'state', 'choice', 'confidence'])
        if (meta[k] !== undefined)
            allowed[k] = String(meta[k]).slice(0, 140); appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), type, ...allowed }) + '\n', { mode: 0o600 }); }
}
export class Memory {
    constructor(pins = [], maxChars = 6000) { this.pins = [...pins]; this.items = []; this.maxChars = maxChars; }
    add(text) { this.items.push({ id: crypto.randomUUID(), text: String(text).slice(0, 280) }); while (this.items.length > 24)
        this.items.shift(); this.trim(); }
    trim() { while (this.items.reduce((s, x) => s + x.text.length, 0) > this.maxChars)
        this.items.shift(); }
    context() { return { immutableRules: [...this.pins], recentSpeech: this.items.map(x => x.text) }; }
    // Jev chooses excerpts; it never rewrites the operator's identity or immutable rules.
    async compact(jev, signal) {
        if (this.items.length < 12) return;
        const old = this.items.slice(0, -6);
        const questions = Object.fromEntries(old.map((x, i) => [`keep${i}`, { type: 'noul', instructions: `Keep record ${i} only if needed for continuity.` }]));
        try {
            const a = await jev.ask({ records: old.map(x => x.text) }, questions, signal);
            if (signal?.aborted) return;
            const discard = new Set(old.filter((x, i) => a[`keep${i}`]?.noul < .65).map(x => x.id));
            // Apply decisions only to snapshot IDs. Never overwrite concurrent appends.
            this.items = this.items.filter(x => !discard.has(x.id));
        } catch { /* preserve concurrent writes on provider failure */ }
        this.trim();
    }
}
