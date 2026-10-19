// An optional bigger model on another machine (operator 2026-10-16: an RTX 5080 Ubuntu box running Ollama, "only when it
// can be used"). LLM_REMOTE_URL / LLM_REMOTE_MODEL name it; when it answers and has the model, generation and the local
// judge use it, otherwise the configured local model goes on as before. A request that cannot reach it (connection
// refused, a 5xx) is sent again to the local model at once, and the remote one is left alone for retryMs before it is
// probed again; a timeout only marks it down (that request fails as any slow one would). The show never stops for it.
const base = url => String(url || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
const sameModel = (have, want) => have === want || have === `${want}:latest` || `${have}:latest` === want;

export class LlmRoute {
    constructor(c, { fetchFn = fetch, now = Date.now, retryMs = 300000, probeTimeoutMs = 3000 } = {}) {
        this.c = c; this.fetchFn = fetchFn; this.now = now; this.retryMs = retryMs; this.probeTimeoutMs = probeTimeoutMs;
        this.local = { url: c.llmURL, model: c.llmModel, judgeModel: c.judgeModel || '' };
        this.remote = c.llmRemoteURL && c.llmRemoteModel
            ? { url: c.llmRemoteURL, model: c.llmRemoteModel, judgeModel: c.judgeRemoteModel || (c.judgeModel ? c.llmRemoteModel : '') } : null;
        this.active = 'local'; this.lastError = null; this.retryAt = 0; this.checkedAt = null;
        this.fetch = this.fetch.bind(this);
    }
    get configured() { return !!this.remote; }
    /** Whether the remote machine answers and has its model; switches to it, or back to local with the reason. */
    async probe() {
        if (!this.remote || this.now() < this.retryAt) return this.status();
        this.checkedAt = new Date(this.now()).toISOString();
        try {
            const r = await this.fetchFn(`${base(this.remote.url)}/api/tags`, { signal: AbortSignal.timeout(this.probeTimeoutMs), redirect: 'error' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const models = ((await r.json())?.models || []).map(m => m.name || m.model);
            const missing = [this.remote.model, this.remote.judgeModel].filter(Boolean).find(want => !models.some(have => sameModel(have, want)));
            if (missing) throw new Error(`model ${missing} is not installed`);
            this.use('remote'); this.lastError = null;
        } catch (e) { this.down(e.name === 'TimeoutError' ? 'no answer' : e.message); }
        return this.status();
    }
    use(which) {
        const t = which === 'remote' ? this.remote : this.local;
        this.active = which; this.c.llmURL = t.url; this.c.llmModel = t.model;
        if (this.local.judgeModel) this.c.judgeModel = t.judgeModel || t.model;
    }
    down(reason) { this.use('local'); this.lastError = String(reason).slice(0, 120); this.retryAt = this.now() + this.retryMs; }
    /** fetch for the generator and the judge: a remote request that cannot be delivered goes to the local model. */
    async fetch(url, options = {}) {
        const remote = this.remote && this.active === 'remote' && String(url).startsWith(base(this.remote.url));
        if (!remote) return this.fetchFn(url, options);
        try {
            const r = await this.fetchFn(url, options);
            if (r.status < 500) return r;
            await r.body?.cancel?.();
            throw new Error(`HTTP ${r.status}`);
        } catch (e) {
            if (e.name === 'TimeoutError') { this.down('no answer'); throw e; } // too slow: this request fails, later ones go local
            if (options.signal?.aborted) throw e; // the caller gave up (show stopped): not the remote machine's fault
            this.down(e.message);
            let body = options.body;
            try {
                const j = JSON.parse(body);
                if (j.model === this.remote.model) j.model = this.local.model;
                else if (j.model === this.remote.judgeModel) j.model = this.local.judgeModel || this.local.model;
                body = JSON.stringify(j);
            } catch { /* not JSON: sent as it was */ }
            return this.fetchFn(base(this.local.url) + String(url).slice(base(this.remote.url).length), { ...options, body });
        }
    }
    status() {
        return { configured: this.configured, active: this.active, model: this.active === 'remote' ? this.remote.model : this.local.model,
            remote: this.remote ? { url: this.remote.url, model: this.remote.model } : null, localModel: this.local.model,
            lastError: this.lastError, retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null, checkedAt: this.checkedAt };
    }
}
