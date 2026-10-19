// Text similarity is a conservative heuristic, NOT semantic proof or safety moderation.
export function normalizeSpeech(text) {
    return String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}
function grams(s) { const out = new Set(); for (let i = 0; i + 2 < s.length; i++) out.add(s.slice(i, i + 3)); return out; }
export function similarity(a, b) {
    a = normalizeSpeech(a); b = normalizeSpeech(b); if (!a || !b) return 0;
    if (a === b) return 1;
    if (Math.min(a.length, b.length) < 14) return 0;
    const aa = grams(a), bb = grams(b), overlap = [...aa].filter(x => bb.has(x)).length;
    return 2 * overlap / (aa.size + bb.size);
}
export function repetitionReason(text, recent = [], kind = 'autonomous') {
    // A new viewer may legitimately ask for a recap; contextual Jev still checks it.
    if (['closing', 'reply', 'unavailable'].includes(kind)) return null;
    if (kind !== 'opening' && kind !== 'closing' && /(?:今日|今夜)のお題(?:は|が)|こんばんは[、,]?[^\s、。,.]{1,12}です/.test(text)) return 'intro_repeated';
    return recent.some(x => similarity(text, x) >= .82) ? 'near_duplicate' : null;
}
export class ContentStalledError extends Error {
    constructor(reason) { super('Content did not advance after one repair'); this.name = 'ContentStalledError'; this.code = 'CONTENT_STALLED'; this.reason = reason; }
}
