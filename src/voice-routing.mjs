import { Voice, wavDuration } from './providers.mjs';
import { request, hash } from './util.mjs';

/** Comment narration always uses VOICEVOX, independently of the host voice. */
export class CommentVoice extends Voice {
    constructor(c, ledger, fetchFn = fetch) {
        super(new Proxy(c, { get(target, key) {
            if (key === 'speaker') return target.commentSpeaker;
            if (key === 'voiceSpeed') return target.commentSpeed;
            return target[key];
        } }), ledger, fetchFn);
    }
}

/** Native Supertonic 3 HTTP contract. No audio loopback, cloud fallback or model download. */
export class SupertonicVoice {
    constructor(c, ledger, fetchFn = fetch) {
        this.c = c; this.ledger = ledger; this.fetchFn = fetchFn;
        this.queue = Promise.resolve(); this.cache = new Map();
    }
    async health(signal) {
        const r = await request(`${this.c.supertonicURL}/v1/health`, { signal, timeout: 5000, fetchFn: this.fetchFn });
        // v1/v2 do not officially support Japanese. Never silently generate with them.
        if (r?.model !== 'supertonic-3' || r?.status !== 'ok') {
            const e = new Error('Supertonic 3 must be ready for Japanese synthesis'); e.code = 'SUPERTONIC_NOT_READY'; throw e;
        }
        return r;
    }
    synthesize(text, signal) {
        const job = this.queue.then(async () => {
            if (signal?.aborted) throw signal.reason;
            if (typeof text !== 'string' || !text.trim() || text.length > 1200 || /[<>\u0000]/.test(text)) throw new Error('Invalid Supertonic input');
            if (this.c.mode === 'demo') return { kind: 'browser', durationMs: Math.min(30000, Math.max(3000, text.length * 130)), bytes: null };
            const key = hash(JSON.stringify([this.c.supertonicURL, this.c.supertonicVoice, this.c.supertonicSteps, this.c.supertonicSpeed, text]));
            if (this.cache.has(key)) return this.cache.get(key);
            await this.health(signal);
            this.ledger.reserve('tts');
            const bytes = await request(`${this.c.supertonicURL}/v1/tts`, {
                body: { text, voice: this.c.supertonicVoice, lang: 'ja', steps: this.c.supertonicSteps, speed: this.c.supertonicSpeed, response_format: 'wav' },
                signal, timeout: 20000, json: false, max: 8000000, fetchFn: this.fetchFn
            });
            if (signal?.aborted) throw signal.reason;
            const audio = { kind: 'wav', durationMs: Math.ceil(wavDuration(bytes) * 1000), bytes };
            this.cache.set(key, audio);
            while (this.cache.size > 16 || [...this.cache.values()].reduce((n, a) => n + a.bytes.length, 0) > 16000000) this.cache.delete(this.cache.keys().next().value);
            return audio;
        });
        this.queue = job.catch(() => {}); return job;
    }
}

export class ReplyVoice {
    constructor(c, ledger, fetchFn = fetch) {
        this.c = c; this.voicevox = new Voice(c, ledger, fetchFn); this.supertonic = new SupertonicVoice(c, ledger, fetchFn);
        this.cache = { clear: () => { this.voicevox.cache?.clear(); this.supertonic.cache.clear(); } };
    }
    synthesize(text, signal) {
        return (this.c.replyTtsProvider === 'supertonic' ? this.supertonic : this.voicevox).synthesize(text, signal);
    }
}
