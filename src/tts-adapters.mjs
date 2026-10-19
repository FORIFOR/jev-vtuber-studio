import { request, hash, clean } from './util.mjs';
import { wavDuration } from './providers.mjs';
import { writeWav } from './wav.mjs';
import { PcmStream } from './pcm-stream.mjs';
import { attachSpeechTiming } from './speech-timing.mjs';

/**
 * Host-voice engine adapters: local (VOICEVOX, AivisSpeech, Style-Bert-VITS2, Supertonic 3) and opt-in cloud (Gemini TTS).
 * Adapters never queue, cache PCM, reserve per-part budget or fall back to another voice: the router owns that.
 * Config is always read lazily from this.c because saveSettings mutates c in place.
 */
export const PROVIDERS = ['voicevox', 'supertonic', 'aivisspeech', 'sbv2', 'gemini-tts', 'gemini-lite-tts'];
/** Paid cloud engines: never probed or rendered unless the operator selects them (or passes --allow-cloud). */
export const CLOUD = Object.freeze(['gemini-tts', 'gemini-lite-tts']);
export const ENGINE_INFO = Object.freeze({
    voicevox: Object.freeze({ label: 'VOICEVOX', maxChars: 200, expressive: true, styles: 'id' }),
    aivisspeech: Object.freeze({ label: 'AivisSpeech', maxChars: 200, expressive: true, styles: 'id' }),
    sbv2: Object.freeze({ label: 'Style-Bert-VITS2', maxChars: 100, expressive: true, styles: 'name' }),
    supertonic: Object.freeze({ label: 'Supertonic 3', maxChars: 300, expressive: false, styles: null }),
    // Gemini TTS: speech_metadata.style is natural language; vocal tags are inserted by code only (see GeminiTtsEngine).
    'gemini-tts': Object.freeze({ label: 'Gemini 3.8 Flash TTS', maxChars: 300, expressive: true, styles: 'text', cloud: true, vocalTags: true, model: 'gemini-3.8-flash-tts', usdPerMAudio: 9, usdPerMText: .5 }),
    'gemini-lite-tts': Object.freeze({ label: 'Gemini 3.8 Flash-Lite TTS', maxChars: 300, expressive: true, styles: 'text', cloud: true, vocalTags: true, model: 'gemini-3.8-flash-lite-tts', usdPerMAudio: 6, usdPerMText: .5 }),
});
export const PACE_MULT = Object.freeze({ slow: .92, normal: 1, fast: 1.08 });
export const AIVIS_UUID = '1b4a5014-d9fd-11ee-b97d-83c170a68ed3';
const INTENSITIES = ['low', 'mid', 'high'], PACES = Object.keys(PACE_MULT);
const SUPERTONIC_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];
// Documented defaults for keys config.mjs may not provide yet. A configured value always wins.
const DEFAULTS = { aivisURL: 'http://127.0.0.1:10101', aivisStyle: 0, aivisSpeed: 1, aivisIntonation: 1, aivisTempo: 1, sbv2URL: 'http://127.0.0.1:5055', sbv2Model: '', sbv2Speaker: '', sbv2Style: 'Neutral', sbv2StyleWeight: 1, sbv2Speed: 1 };
const WAV_ERRORS = new Set(['TTS must return WAV', 'Truncated WAV', 'Unsupported WAV encoding', 'Invalid WAV duration']);
const NOT_READY = 'Supertonic 3 must be ready for Japanese synthesis';
const r3 = n => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isObject = x => !!x && typeof x === 'object' && !Array.isArray(x);
const elapsed = t0 => ({ ms: Math.round(performance.now() - t0) });
// SBV2 /models/info has no folder name: it is the directory holding config.json (or the weights), on POSIX or Windows.
const modelDir = m => String(m?.config_path || m?.model_path || '').split(/[\\/]/).at(-2) ?? '';

export class TtsError extends Error {
    constructor(code, message, { status } = {}) { super(message); this.name = 'TtsError'; this.code = code; if (status !== undefined) this.status = status; }
}
/** Normalizes any engine failure. Aborts are never wrapped; messages never echo text, URLs or settings. */
export function wrapError(e, signal) {
    if (signal?.aborted) return signal.reason ?? e;
    if (e instanceof TtsError) return e;
    const status = e?.status;
    if (Number.isInteger(status) && status >= 400)
        return new TtsError(status === 408 || status === 429 || status >= 500 ? 'TTS_ENGINE_DOWN' : 'TTS_REJECTED', `Voice engine HTTP ${status}`, { status });
    if (WAV_ERRORS.has(e?.message)) return new TtsError('TTS_ENGINE_DOWN', e.message);
    return new TtsError('TTS_ENGINE_DOWN', e?.name === 'TimeoutError' ? 'Voice engine timed out' : 'Voice engine unavailable');
}
const guard = async (signal, fn) => { try { return await fn(); } catch (e) { throw wrapError(e, signal); } };
// Identity probes: any HTTP error or non-JSON answer means another service owns the port. Network errors stay DOWN.
async function identityJSON(url, timeout, signal, fetchFn) {
    try { return await request(url, { signal, timeout, fetchFn }); }
    catch (e) {
        if (!signal?.aborted && (Number.isInteger(e?.status) || e instanceof SyntaxError))
            throw new TtsError('TTS_ENGINE_MISMATCH', 'Another service answered on the voice engine port', Number.isInteger(e?.status) ? { status: e.status } : {});
        throw e;
    }
}

export class TtsAdapter {
    static id = null;
    constructor(c, fetchFn = fetch) { this.c = c; this.fetchFn = fetchFn; this.now = Date.now; this.healthCache = null; this.healthGen = 0; }
    get id() { return this.constructor.id; }
    get info() { return ENGINE_INFO[this.id]; }
    cfg(key) { return this.c[key] ?? DEFAULTS[key]; }
    url() { throw new Error('Not implemented'); }
    /** The base voice only: never the URL or quality knobs, so prerendered phrases survive a port change. */
    identity() { return [this.id]; }
    identity16() { return hash(JSON.stringify(this.identity())).slice(0, 16); }
    quality() { return {}; }
    fingerprint() { return hash(JSON.stringify([this.identity(), this.url(), this.quality()])); }
    styleFor(family) {
        const map = this.c.hostStyleMap, v = isObject(map) && typeof family === 'string' && Object.hasOwn(map, family) ? map[family] : undefined;
        if (this.info.styles === 'id') return Number.isInteger(v) ? v : undefined;
        return (this.info.styles === 'name' || this.info.styles === 'text') && typeof v === 'string' ? v : undefined;
    }
    /** Only the params that change the voice. A null delivery is neutral / mid / normal. */
    resolve(delivery) {
        const d = { family: typeof delivery?.family === 'string' ? delivery.family : 'neutral', intensity: INTENSITIES.includes(delivery?.intensity) ? delivery.intensity : 'mid', pace: PACES.includes(delivery?.pace) ? delivery.pace : 'normal' };
        return Object.fromEntries(Object.entries(this.params(d)).map(([k, v]) => [k, typeof v === 'number' ? r3(v) : v]));
    }
    params() { throw new Error('Not implemented'); }
    // Invalid input is a rejection, never an engine failure, so it cannot open a circuit.
    validateText(text) {
        if (typeof text !== 'string' || !text.trim() || text.length > this.info.maxChars || /[<>\u0000]/.test(text)) throw new TtsError('TTS_REJECTED', 'Invalid TTS input');
    }
    async health(signal, { maxAgeMs = 0 } = {}) {
        const key = JSON.stringify([this.url(), this.identity()]), h = this.healthCache, gen = this.healthGen;
        if (h?.key === key && this.now() - h.at < maxAgeMs) return h.result;
        this.healthCache = null;
        const result = await this.probe(signal);
        if (gen === this.healthGen) this.healthCache = { key, at: this.now(), result };
        return result;
    }
    invalidate() { this.healthCache = null; this.healthGen++; }
    /** Public probe: every failure is a TtsError (network → DOWN), except an abort, which rethrows its reason. */
    probe(signal) { return guard(signal, () => { if (signal?.aborted) throw signal.reason; return this.check(signal); }); }
    async check() { throw new Error('Not implemented'); }
    async warmup(signal) { const t0 = performance.now(); await this.health(signal); return elapsed(t0); }
    async voices() { return []; }
    /** Returns the engine WAV bytes. Validates before any fetch; every failure goes through wrapError. */
    async synthesize(text, params, signal, { quality = null } = {}) {
        this.validateText(text);
        return guard(signal, async () => {
            if (signal?.aborted) throw signal.reason;
            const bytes = await this.render(text, params ?? this.resolve(null), signal, quality);
            wavDuration(bytes);
            return bytes;
        });
    }
}

export class VoicevoxEngine extends TtsAdapter {
    static id = 'voicevox';
    url() { return this.c.voiceURL; }
    styleId() { return this.c.speaker; }
    identity() { return [this.id, this.styleId()]; }
    params(d) { return { speaker: this.styleFor(d.family) ?? this.styleId(), speedScale: clamp(this.c.voiceSpeed * PACE_MULT[d.pace], .5, 2), intonationScale: { low: .9, mid: 1, high: 1.15 }[d.intensity] }; }
    tune(q, p) { q.speedScale = p.speedScale; q.intonationScale = p.intonationScale; q.volumeScale = .9; }
    async render(text, p, signal) {
        const speaker = String(p.speaker);
        const query = await request(`${this.url()}/audio_query?${new URLSearchParams({ text, speaker })}`, { method: 'POST', signal, timeout: 12000, fetchFn: this.fetchFn });
        this.tune(query, p);
        const bytes = await request(`${this.url()}/synthesis?${new URLSearchParams({ speaker })}`, { body: query, signal, timeout: 20000, json: false, max: 8000000, fetchFn: this.fetchFn });
        return attachSpeechTiming(bytes, query, this.id);
    }
    async check(signal) { return { ok: true, version: clean(await request(`${this.url()}/version`, { signal, timeout: 1500, fetchFn: this.fetchFn }), 40), detail: {} }; }
    styleIds() { return [...new Set([this.styleId(), ...Object.values(isObject(this.c.hostStyleMap) ? this.c.hostStyleMap : {}).filter(Number.isInteger)])]; }
    // Preloads every style the show can use. Never reserves the ledger.
    initialize(signal) {
        return guard(signal, async () => {
            for (const speaker of this.styleIds())
                await request(`${this.url()}/initialize_speaker?${new URLSearchParams({ speaker: String(speaker), skip_reinit: 'true' })}`, { method: 'POST', signal, timeout: 30000, json: false, fetchFn: this.fetchFn });
        });
    }
    async warmup(signal) { const t0 = performance.now(); await this.initialize(signal); return elapsed(t0); }
    voiceRow(s, st) { return { id: st.id, name: `${s.name} / ${st.name}`, credit: `VOICEVOX:${s.name}` }; }
    voices(signal) {
        return guard(signal, async () => {
            const list = await request(`${this.url()}/speakers`, { signal, timeout: 5000, fetchFn: this.fetchFn });
            if (!Array.isArray(list)) throw new TtsError('TTS_ENGINE_MISMATCH', 'Unexpected speaker list');
            return list.flatMap(s => (Array.isArray(s?.styles) ? s.styles : []).filter(st => Number.isInteger(st?.id)).map(st => this.voiceRow(s, st))).slice(0, 300);
        });
    }
}

/** VOICEVOX-compatible, but only speed, intonation (style strength) and tempo dynamics are touched. kana stays as returned. */
export class AivisSpeechEngine extends VoicevoxEngine {
    static id = 'aivisspeech';
    url() { return this.cfg('aivisURL'); }
    styleId() { return this.cfg('aivisStyle'); }
    params(d) {
        return { speaker: this.styleFor(d.family) ?? this.styleId(), speedScale: clamp(this.cfg('aivisSpeed') * PACE_MULT[d.pace], .5, 2),
            intonationScale: clamp(this.cfg('aivisIntonation') * { low: .8, mid: 1, high: 1.25 }[d.intensity], 0, 2),
            tempoDynamicsScale: clamp(this.cfg('aivisTempo') * { slow: .9, normal: 1, fast: 1.15 }[d.pace], 0, 2) };
    }
    tune(q, p) { q.speedScale = p.speedScale; q.intonationScale = p.intonationScale; q.tempoDynamicsScale = p.tempoDynamicsScale; }
    async check(signal) {
        if (this.styleId() === 0) throw new TtsError('TTS_REJECTED', 'AIVIS_STYLE not set');
        const version = await identityJSON(`${this.url()}/version`, 2000, signal, this.fetchFn);
        const m = await identityJSON(`${this.url()}/engine_manifest`, 2000, signal, this.fetchFn);
        // VOICEVOX answers the same routes; only the manifest name plus uuid proves the engine.
        if (m?.name !== 'AivisSpeech Engine' || m?.uuid !== AIVIS_UUID) throw new TtsError('TTS_ENGINE_MISMATCH', 'Not an AivisSpeech Engine');
        return { ok: true, version: clean(version, 40), detail: { name: m.name } };
    }
    async warmup(signal) { const t0 = performance.now(); await this.health(signal); await this.initialize(signal); return elapsed(t0); }
    voiceRow(s, st) { return { id: st.id, name: `${s.name} / ${st.name}`, credit: `AivisSpeech:${s.name}`, speakerUuid: s.speaker_uuid }; }
    license(speakerUuid, signal) {
        return guard(signal, async () => {
            // AivisSpeech 1.0.0 ignores resource_format=url and inlines its voice samples (~6 MB of base64); only the
            // policy text is kept, but the body must be read whole: a bounded 16 MB from the local engine.
            const r = await request(`${this.url()}/speaker_info?${new URLSearchParams({ speaker_uuid: String(speakerUuid), resource_format: 'url' })}`, { signal, timeout: 8000, fetchFn: this.fetchFn, max: 16000000 });
            const policy = typeof r?.policy === 'string' ? r.policy : '';
            // Decide from the licence's title: ACML 1.0's body lists 非営利利用・営利利用 as ALLOWED, so a body-wide search
            // for 非営利 would flag every commercial-use model. Unknown titles fall back to the body wording.
            const title = policy.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
            const nonCommercialHint = /ACML-NC|Non-?Commercial|非営利/i.test(title) || (!/Aivis Common Model License \(ACML\)/i.test(title) && /非営利限定|non-?commercial (use )?only/i.test(policy));
            return { present: !!policy, nonCommercialHint, excerpt: clean(policy, 400) };
        });
    }
}

/** Style-Bert-VITS2 server_fastapi.py: every /voice parameter is a query parameter, even for POST. */
export class Sbv2Engine extends TtsAdapter {
    static id = 'sbv2';
    url() { return this.cfg('sbv2URL'); }
    identity() { return [this.id, this.cfg('sbv2Model'), this.cfg('sbv2Speaker')]; }
    // The server limit is 100 characters, and newline would trigger its own splitting and pauses.
    validateText(text) {
        if (typeof text !== 'string' || !text.trim() || text.length > this.info.maxChars || /[\n\r<>\u0000]/.test(text)) throw new TtsError('TTS_REJECTED', 'Invalid TTS input');
    }
    params(d) {
        const speaker = this.cfg('sbv2Speaker');
        return { model_name: this.cfg('sbv2Model'), ...(speaker ? { speaker_name: speaker } : {}), style: this.styleFor(d.family) ?? this.cfg('sbv2Style'),
            style_weight: clamp(this.cfg('sbv2StyleWeight') * { low: .7, mid: 1, high: 1.5 }[d.intensity], 0, 5),
            length: clamp(1 / (this.cfg('sbv2Speed') * PACE_MULT[d.pace]), .5, 2), sdp_ratio: { slow: .15, normal: .2, fast: .3 }[d.pace] };
    }
    // Whitelisted query only: never encoding, assist_text, reference_audio_path, model_id or speaker_id.
    async render(text, p, signal) {
        // An empty model_name makes the server pick model 0, which would be another voice.
        if (!p.model_name) throw new TtsError('TTS_REJECTED', 'SBV2 model not found');
        const q = new URLSearchParams({ text, model_name: String(p.model_name), ...(p.speaker_name ? { speaker_name: String(p.speaker_name) } : {}), style: String(p.style), style_weight: String(p.style_weight),
            length: String(p.length), sdp_ratio: String(p.sdp_ratio), noise: '0.6', noisew: '0.8', language: 'JP', auto_split: 'false' });
        return request(`${this.url()}/voice?${q}`, { method: 'POST', signal, timeout: 30000, json: false, max: 8000000, fetchFn: this.fetchFn });
    }
    async models(signal) {
        const info = await identityJSON(`${this.url()}/models/info`, 2500, signal, this.fetchFn);
        const models = isObject(info) ? Object.values(info).filter(m => isObject(m) && isObject(m.spk2id) && isObject(m.style2id)) : [];
        if (!models.length) throw new TtsError('TTS_ENGINE_MISMATCH', 'Not a Style-Bert-VITS2 server');
        return models;
    }
    async check(signal) {
        const models = await this.models(signal), name = this.cfg('sbv2Model'), m = name ? models.find(x => modelDir(x) === name) : null;
        if (!m) throw new TtsError('TTS_REJECTED', 'SBV2 model not found');
        const map = isObject(this.c.hostStyleMap) ? this.c.hostStyleMap : {};
        if ([this.cfg('sbv2Style'), ...Object.values(map).filter(v => typeof v === 'string')].some(s => !Object.hasOwn(m.style2id, s))) throw new TtsError('TTS_REJECTED', 'SBV2 style not found');
        const speaker = this.cfg('sbv2Speaker');
        if (speaker && !Object.hasOwn(m.spk2id, speaker)) throw new TtsError('TTS_REJECTED', 'SBV2 speaker not found');
        return { ok: true, version: null, detail: { model: name, styles: Object.keys(m.style2id), speakers: Object.keys(m.spk2id) } };
    }
    // The first /voice per model loads its weights lazily, so warm-up is one real (budgeted) synthesis.
    async warmup(signal, ledger) {
        const t0 = performance.now();
        await this.health(signal);
        ledger?.reserve('tts');
        await this.synthesize('あ', this.resolve(null), signal);
        return elapsed(t0);
    }
    voices(signal) { return guard(signal, async () => (await this.models(signal)).map(m => ({ name: modelDir(m), speakers: Object.keys(m.spk2id), styles: Object.keys(m.style2id) }))); }
}

/** Native Supertonic 3 contract. Not expressive: pace only changes speed, never below .7. */
export class SupertonicEngine extends TtsAdapter {
    static id = 'supertonic';
    url() { return this.c.supertonicURL; }
    identity() { return [this.id, this.c.supertonicVoice]; }
    quality() { return { steps: this.c.supertonicSteps }; }
    params(d) { return { voice: this.c.supertonicVoice, speed: clamp(this.c.supertonicSpeed * PACE_MULT[d.pace], .7, 2) }; }
    render(text, p, signal, quality) {
        return request(`${this.url()}/v1/tts`, { body: { text, voice: p.voice, lang: 'ja', steps: quality?.steps ?? this.c.supertonicSteps, speed: p.speed, response_format: 'wav' }, signal, timeout: 20000, json: false, max: 8000000, fetchFn: this.fetchFn });
    }
    async check(signal) {
        const r = await request(`${this.url()}/v1/health`, { signal, timeout: 5000, fetchFn: this.fetchFn }).catch(e => {
            // A 4xx or non-JSON answer is no Supertonic 3 health route (another service, an older server): not ready, never REJECTED. 408/429/5xx and network stay DOWN.
            const w = wrapError(e, signal);
            throw !signal?.aborted && (w.code === 'TTS_REJECTED' || e instanceof SyntaxError) ? new TtsError('SUPERTONIC_NOT_READY', NOT_READY, { status: w.status }) : w;
        });
        // v1/v2 do not officially support Japanese. Never silently generate with them.
        if (r?.model !== 'supertonic-3' || r?.status !== 'ok') throw new TtsError('SUPERTONIC_NOT_READY', NOT_READY);
        return { ok: true, version: typeof r.version === 'string' ? clean(r.version, 40) : null, detail: { model: r.model } };
    }
    async voices() { return SUPERTONIC_VOICES.map(id => ({ id, name: id })); }
}

/** Wordless reaction classes → Gemini inline vocal tags (documented list). hmm has no tag. */
export const VOCAL_TAGS = Object.freeze({ gasp: '<gasp>', laugh_small: '<chuckle>', laugh_big: '<laugh>', breath_in: '<breath>', breath_out: '<exhales>', sigh: '<sigh>' });
// Delivery → a SHORT acting cue for speech_metadata. The voice's lasting character lives in the voice itself (a
// Voice Design voice_ id); repeating a long persona every request makes the voice drift, so for a designed voice
// only this cue is sent. GEMINI_TTS_STYLE (persona) is prepended only for prebuilt voices, which have no design.
const FAMILY_STYLE = { neutral: 'casual, friendly', calm: 'calm and gentle', joy: 'bright and pleased', surprise: 'briefly startled, then relieved',
    shy: 'slightly shy, with a small smile', think: 'quietly focused', worry: 'mildly disappointed, conversational' };
const INTENSITY_STYLE = { low: 'subtle', mid: '', high: 'strongly expressive' }, PACE_STYLE = { slow: 'speaking slowly', normal: '', fast: 'speaking quickly' };
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
/** Gemini 3.8 Flash TTS (generateContent). Fixed Google endpoint (never configurable), key in a header, one prebuilt
 * voice for the whole show. Input is a verbatim transcript: the only markup ever sent is one whitelisted vocal tag
 * added by code at the start or end of approved text. Output is 24 kHz mono PCM16 WAV. Spend is estimated locally
 * from returned audio length (25 audio tokens per second). */
export class GeminiTtsEngine extends TtsAdapter {
    static id = 'gemini-tts';
    constructor(c, fetchFn) { super(c, fetchFn); this.usage = { requests: 0, audioSec: 0, textChars: 0 }; }
    url() { return GEMINI_BASE; }
    voice() { return this.c.geminiTtsVoice || 'Kore'; }
    persona() { return /^voice_/.test(this.voice()) ? '' : this.c.geminiTtsStyle || ''; }
    identity() { return [this.id, this.voice(), this.persona()]; }
    params(d) {
        const style = [this.persona(), this.styleFor(d.family) ?? FAMILY_STYLE[d.family] ?? FAMILY_STYLE.neutral, INTENSITY_STYLE[d.intensity], PACE_STYLE[d.pace]].filter(Boolean).join('; ');
        return { voice: this.voice(), style };
    }
    headers() { if (!this.c.geminiKey) throw new TtsError('TTS_REJECTED', 'GEMINI_API_KEY is not set'); return { 'x-goog-api-key': this.c.geminiKey }; }
    /** `tag` = { cls, position }: one whitelisted wordless vocal event. Words always come only from `text`. */
    async synthesize(text, params, signal, { tag = null } = {}) {
        this.validateText(text);
        // A designed voice (voice_...) is addressed through the Interactions API only: collect its stream into one WAV.
        if (String((params ?? this.resolve(null)).voice).startsWith('voice_')) {
            const st = this.stream(text, params, signal, { tag }); await st.finished;
            if (st.error) throw st.error;
            if (!st.bytes) throw new TtsError('TTS_REJECTED', 'Gemini returned no audio');
            const pcm = Buffer.concat(st.chunks), f = new Float32Array(pcm.length >> 1);
            for (let i = 0; i < f.length; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
            return writeWav(f, st.rate);
        }
        const t = tag && Object.hasOwn(VOCAL_TAGS, tag.cls) ? VOCAL_TAGS[tag.cls] : null;
        const transcript = !t ? text : tag.position === 'post' ? `${text} ${t}` : `${t} ${text}`;
        return guard(signal, async () => {
            if (signal?.aborted) throw signal.reason;
            const p = params ?? this.resolve(null);
            const r = await request(`${GEMINI_BASE}/${this.info.model}:generateContent`, { headers: this.headers(), signal, timeout: 30000, fetchFn: this.quotaAware(), max: 12000000,
                body: { contents: [{ role: 'user', parts: [{ text: transcript, ...(p.style ? { speech_metadata: { style: p.style } } : {}) }] }],
                    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } } } } });
            const inline = r?.candidates?.[0]?.content?.parts?.find(x => x?.inlineData?.data)?.inlineData;
            // Blocked or empty audio is a rejection of this text, never an engine outage.
            if (!inline) throw new TtsError('TTS_REJECTED', 'Gemini returned no audio');
            let bytes = Buffer.from(String(inline.data), 'base64');
            if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF') {
                const rate = Number(/rate=(\d+)/.exec(String(inline.mimeType || ''))?.[1]) || 24000, n = Math.floor(bytes.length / 2), f = new Float32Array(n);
                for (let i = 0; i < n; i++) f[i] = bytes.readInt16LE(i * 2) / 32768;
                bytes = writeWav(f, rate);
            }
            const sec = wavDuration(bytes);
            this.usage.requests++; this.usage.audioSec += sec; this.usage.textChars += transcript.length + (p.style?.length || 0);
            return bytes;
        });
    }
    /** Streaming (Interactions API): returns a PcmStream at once; audio chunks (raw PCM16, 24 kHz mono) arrive as the model
     * speaks, so an approved line can start playing on the first chunk instead of after the whole WAV. Same voice,
     * same style, same single whitelisted vocal tag as synthesize(); words come only from `text`. */
    stream(text, params, signal, { tag = null, firstChunkTimeoutMs = 10000, timeoutMs = 60000 } = {}) {
        this.validateText(text);
        const t = tag && Object.hasOwn(VOCAL_TAGS, tag.cls) ? VOCAL_TAGS[tag.cls] : null;
        const transcript = !t ? text : tag.position === 'post' ? `${text} ${t}` : `${t} ${text}`;
        const p = params ?? this.resolve(null), out = new PcmStream({ rate: 24000 }), abort = new AbortController();
        const sig = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        const firstTimer = setTimeout(() => { if (out.firstAt === null) abort.abort(Object.assign(new Error('Voice engine timed out'), { name: 'TimeoutError' })); }, firstChunkTimeoutMs);
        (async () => {
            const res = await this.quotaAware()(`https://generativelanguage.googleapis.com/v1beta/interactions`, { method: 'POST', signal: sig, redirect: 'error',
                headers: { 'Content-Type': 'application/json', ...this.headers() },
                body: JSON.stringify({ model: this.info.model, stream: true,
                    input: [{ type: 'user_input', content: [{ type: 'text', text: transcript, ...(p.style ? { annotations: [{ type: 'speech_metadata', style: p.style }] } : {}) }] }],
                    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
                    generation_config: { speech_config: [{ voice: p.voice }] } }) });
            if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error(`Provider HTTP ${res.status}`), { status: res.status }); }
            const dec = new TextDecoder(); let buf = '';
            for await (const part of res.body) {
                buf += dec.decode(part, { stream: true });
                if (buf.length > 4000000) throw new Error('Unexpected stream framing');
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                    if (!data || data === '[DONE]') continue;
                    let j; try { j = JSON.parse(data); } catch { continue; }
                    // Quota refusals can arrive inside a 200 stream: a per-day limit (e.g. the free tier's 10 requests/day) will
                    // not recover by retrying, so it holds speech as TTS_BUDGET; other rate limits stay transient (429).
                    if (j.error) {
                        const msg = String(j.error.message || ''), code = String(j.error.code || '');
                        if (/rate_limit|RESOURCE_EXHAUSTED|429/i.test(code) || /rate limit/i.test(msg)) {
                            if (/per day|PerDay/i.test(msg)) throw new TtsError('TTS_BUDGET', 'Gemini daily quota exhausted', { status: 429 });
                            throw Object.assign(new Error('Voice engine rate limited'), { status: 429 });
                        }
                        throw Object.assign(new Error('Voice engine stream error'), { status: Number(j.error.code) || 500 });
                    }
                    const d = j.delta;
                    if (d?.type === 'audio' && typeof d.data === 'string') out.push(Buffer.from(d.data, 'base64'));
                }
            }
        })().then(() => { account(); out.end(); }, e => { account(); out.fail(wrapError(e, signal)); });
        // Billed audio is what was generated, played or not (cancelled, stale, failed): count it all, before `finished`.
        const account = () => {
            clearTimeout(firstTimer);
            this.usage.requests++; this.usage.audioSec += out.durationMs / 1000; this.usage.textChars += transcript.length + (p.style?.length || 0);
        };
        out.cancel = () => abort.abort(new Error('Stream cancelled'));
        return out;
    }
    /** A 429 for an exhausted per-day quota (e.g. the free tier's 10 requests/day/model) will not recover by retrying:
     * it becomes TTS_BUDGET (speech holds, circuit untouched). Per-minute 429s stay TTS_ENGINE_DOWN (transient). */
    quotaAware() {
        return async (url, opts) => {
            const res = await this.fetchFn(url, opts);
            if (res.status !== 429) return res;
            const body = await res.text().catch(() => '');
            if (/PerDay/i.test(body)) throw new TtsError('TTS_BUDGET', 'Gemini daily quota exhausted', { status: 429 });
            return new Response(body, { status: 429 });
        };
    }
    /** Estimated spend (USD) from audio actually returned; text input is approximated at 1 token per character. */
    cost() {
        const u = this.usage, audioTokens = u.audioSec * 25;
        return { requests: u.requests, audioSec: Math.round(u.audioSec), usd: Math.round((audioTokens * this.info.usdPerMAudio + u.textChars * this.info.usdPerMText) / 1e4) / 100, basis: 'estimate: 25 audio tokens/s, list price through 2026-12-31' };
    }
    // Model metadata GET: free, verifies the key and the model id without synthesizing.
    async check(signal) {
        const r = await request(`${GEMINI_BASE}/${this.info.model}`, { method: 'GET', headers: this.headers(), signal, timeout: 8000, fetchFn: this.fetchFn });
        if (typeof r?.name !== 'string' || !r.name.endsWith(this.info.model)) throw new TtsError('TTS_ENGINE_MISMATCH', 'Unexpected Gemini model');
        if (!isGeminiVoice(this.voice())) throw new TtsError('TTS_REJECTED', 'Unknown Gemini voice');
        return { ok: true, version: this.info.model, detail: { model: this.info.model, voice: this.voice() } };
    }
    async voices() { return GEMINI_VOICES.map(id => ({ id, name: id })); }
}
export class GeminiLiteTtsEngine extends GeminiTtsEngine { static id = 'gemini-lite-tts'; }
export const GEMINI_TTS_VOICES = GEMINI_VOICES;
/** A Voice Design id (stored per Google project, 1-year TTL) or a prebuilt name. */
export const isGeminiVoice = v => GEMINI_VOICES.includes(v) || /^voice_[A-Za-z0-9_-]{4,120}$/.test(String(v || ''));

const ENGINES = { voicevox: VoicevoxEngine, supertonic: SupertonicEngine, aivisspeech: AivisSpeechEngine, sbv2: Sbv2Engine, 'gemini-tts': GeminiTtsEngine, 'gemini-lite-tts': GeminiLiteTtsEngine };
export function createAdapter(id, c, fetchFn = fetch) {
    if (!Object.hasOwn(ENGINES, id)) throw new TtsError('TTS_REJECTED', 'Unknown TTS provider');
    return new ENGINES[id](c, fetchFn);
}
export const createAdapters = (c, fetchFn = fetch) => Object.fromEntries(PROVIDERS.map(id => [id, createAdapter(id, c, fetchFn)]));
