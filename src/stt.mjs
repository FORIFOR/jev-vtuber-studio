// Speech to text for the voice-call partner (docs/COLLAB.md; operator 2026-10-19, NOA Studio Phase 2): the local
// whisper.cpp server (`whisper-server -l ja --port 8178`), never a cloud service. A segment is one utterance the capture
// page cut at a pause: 16-bit PCM WAV. Silence and whisper's stock hallucinations never become something Noa answers.

// Whisper writes these on silence or noise (measured 2026-10-19: 2 s of silence -> 「ご視聴ありがとうございました」,
// no_speech_prob ~0, so the probability cannot be trusted). A transcript made only of them is dropped.
const HALLUCINATIONS = [/ご視聴(いただき)?ありがとうございました/g, /チャンネル登録(を)?よろしく(お願いします)?/g, /(最後まで)?ご覧いただきありがとうございます/g,
    /字幕(は|by).{0,20}/g, /\[[^\]]*\]|\([^)]*\)|（[^）]*）/g];
// A lone backchannel is not something to answer (it does not drop a sentence that merely starts with one).
const BACKCHANNEL = /^(はい|うん|ええ|へえ|ふーん|なるほど|そうそう|うんうん)[。、!！?？…]*$/;
export const STT_MIN_MS = 300, STT_MAX_MS = 30000;
// RMS (of full scale) below which a segment is treated as silence and never sent to whisper.
const SILENCE_RMS = 0.006;

export class SttError extends Error { constructor(message, code) { super(message); this.code = code; } }

/** Read a PCM16 WAV: { sampleRate, channels, durationMs, rms }; throws SttError on anything else. */
export function wavInfo(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new SttError('WAV ではありません。', 'NOT_WAV');
    let at = 12, fmt = null, data = null;
    while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8;
        if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
        else if (id === 'data') { data = b.subarray(body, Math.min(b.length, body + size)); break; }
        at = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.sampleRate) throw new SttError('16bit PCM の WAV にしてください。', 'BAD_FORMAT');
    const samples = Math.floor(data.length / 2);
    let sum = 0;
    for (let i = 0; i < samples; i++) { const v = data.readInt16LE(i * 2) / 32768; sum += v * v; }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, durationMs: samples / fmt.channels / fmt.sampleRate * 1000, rms: samples ? Math.sqrt(sum / samples) : 0 };
}

/** The transcript Noa may answer, or '' when it is empty, punctuation or only whisper's stock phrases. */
export function usableTranscript(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    let rest = t;
    for (const re of HALLUCINATIONS) rest = rest.replace(re, '');
    if (BACKCHANNEL.test(rest.trim())) return '';
    return rest.replace(/[\s。、．，,.!?！？…・ー〜~「」『』"']/g, '').length >= 2 ? t.slice(0, 300) : '';
}

export class SpeechToText {
    constructor(c, fetchFn = fetch) { this.c = c; this.fetchFn = fetchFn; this.lastError = null; this.lastMs = null; }
    /** -> { text, skipped?: 'silence' | 'too_short' | 'too_long' | 'hallucination' }. Throws SttError when the server fails. */
    async transcribe(wav, signal) {
        const info = wavInfo(wav);
        if (info.durationMs < STT_MIN_MS) return { text: '', skipped: 'too_short' };
        if (info.durationMs > STT_MAX_MS) return { text: '', skipped: 'too_long' };
        if (info.rms < SILENCE_RMS) return { text: '', skipped: 'silence' };
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
        form.append('response_format', 'json'); form.append('temperature', '0'); form.append('language', this.c.sttLanguage || 'ja');
        const started = performance.now(), timeout = AbortSignal.timeout(this.c.sttTimeoutMs || 15000);
        let r;
        try { r = await this.fetchFn(`${String(this.c.sttURL).replace(/\/$/, '')}/inference`, { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
        catch (e) { this.lastError = e.name === 'TimeoutError' ? 'timeout' : 'offline'; throw new SttError('音声認識（whisper-server）に接続できません。', this.lastError === 'timeout' ? 'STT_TIMEOUT' : 'STT_OFFLINE'); }
        if (!r.ok) { this.lastError = `http_${r.status}`; throw new SttError(`音声認識がエラーを返しました（${r.status}）。`, 'STT_HTTP'); }
        const body = await r.json().catch(() => null);
        if (typeof body?.text !== 'string') { this.lastError = 'bad_response'; throw new SttError('音声認識の応答を読めませんでした。', 'STT_BAD_RESPONSE'); }
        this.lastError = null; this.lastMs = Math.round(performance.now() - started);
        const text = usableTranscript(body.text);
        return text ? { text } : { text: '', skipped: 'hallucination' };
    }
}
