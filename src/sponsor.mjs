import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

export const SPONSOR_IMAGE_LIMIT = 2 * 1024 * 1024;
export const SPONSOR_BODY_LIMIT = 3 * 1024 * 1024;
export const DEFAULT_SPONSOR = Object.freeze({ revision: 0, enabled: false, mode: 'recruitment', title: '広告募集中', message: 'このスペースに広告を掲載できます', link: '', image: null });
const ID = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new SponsorValidationError(message); };
const badImage = () => invalid('静止画の PNG・JPEG・WebP を選択し、画像形式を確認してください。アニメーションは使用できません。');
export class SponsorValidationError extends Error {}
export class SponsorConflictError extends Error {}

function dimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8000000)
        invalid('画像は縦横 4096px 以下、合計 800万画素以下にしてください。');
    return { width, height };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return badImage();
    let at = 8, size, depth, color, interlace, ended = false, seenData = false, dataEnded = false, palette = false;
    const compressed = [];
    while (at < bytes.length) {
        if (at + 12 > bytes.length) return badImage();
        const length = bytes.readUInt32BE(at), end = at + 12 + length;
        if (end > bytes.length) return badImage();
        const type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, end - 4);
        if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return badImage();
        if (['acTL', 'fcTL', 'fdAT'].includes(type)) return badImage();
        if (at === 8 && type !== 'IHDR') return badImage();
        if (type === 'IHDR') {
            if (size || length !== 13) return badImage();
            size = dimensions(data.readUInt32BE(0), data.readUInt32BE(4));
            depth = data[8]; color = data[9]; interlace = data[12];
            if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[color]?.includes(depth) || data[10] || data[11] || interlace > 1) return badImage();
        } else if (type === 'PLTE') {
            if (seenData || palette || !length || length % 3 || length > 768 || [0, 4].includes(color)) return badImage();
            palette = true;
        } else if (type === 'IDAT') {
            if (dataEnded || (color === 3 && !palette)) return badImage();
            seenData = true; compressed.push(data);
        } else if (type === 'IEND') {
            if (length || !seenData || end !== bytes.length) return badImage();
            ended = true;
        } else if (type[0] === type[0].toUpperCase()) return badImage();
        if (seenData && type !== 'IDAT') dataEnded = true;
        at = end;
    }
    if (!ended || !size) return badImage();
    // Bound decompression by the declared pixel count, including all seven Adam7 passes.
    const bits = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color] * depth;
    const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    const rows = passes.map(([x, y, dx, dy]) => {
        const width = Math.max(0, Math.ceil((size.width - x) / dx)), height = Math.max(0, Math.ceil((size.height - y) / dy));
        return { bytes: Math.ceil(width * bits / 8) + 1, count: width ? height : 0 };
    });
    const expected = rows.reduce((sum, row) => sum + row.bytes * row.count, 0);
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (raw.length !== expected) return badImage();
    let offset = 0;
    for (const row of rows) for (let y = 0; y < row.count; y++, offset += row.bytes) if (raw[offset] > 4) return badImage();
    return size;
}

function jpeg(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return badImage();
    let at = 2, size, scan = false;
    const quantization = new Set(), huffman = new Set(), components = new Map();
    while (at < bytes.length) {
        if (bytes[at++] !== 0xff) return badImage();
        while (bytes[at] === 0xff) at++;
        const marker = bytes[at++];
        if (marker === 0xd9) return size && scan && at === bytes.length ? size : badImage();
        if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || at + 2 > bytes.length) return badImage();
        const length = bytes.readUInt16BE(at), end = at + length;
        if (length < 2 || end > bytes.length) return badImage();
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            const count = bytes[at + 7];
            if (size || length < 11 || length !== 8 + count * 3 || ![1, 3, 4].includes(count) || bytes[at + 2] !== 8) return badImage();
            size = dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
            for (let offset = at + 8; offset < end; offset += 3) {
                const id = bytes[offset], sampling = bytes[offset + 1], table = bytes[offset + 2];
                if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || table > 3) return badImage();
                components.set(id, table);
            }
        } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return badImage();
        if (marker === 0xdb) {
            let offset = at + 2;
            while (offset < end) {
                const info = bytes[offset++], precision = info >> 4, id = info & 15, tableLength = 64 * (precision + 1);
                if (precision > 1 || id > 3 || offset + tableLength > end) return badImage();
                for (let n = 0; n < 64; n++) if (!(precision ? bytes.readUInt16BE(offset + n * 2) : bytes[offset + n])) return badImage();
                quantization.add(id); offset += tableLength;
            }
        }
        if (marker === 0xc4) {
            let offset = at + 2;
            while (offset < end) {
                if (offset + 17 > end) return badImage();
                const info = bytes[offset++];
                if ((info >> 4) > 1 || (info & 15) > 3) return badImage();
                let count = 0, available = 1;
                for (let bits = 0; bits < 16; bits++) { const n = bytes[offset++]; available = available * 2 - n; count += n; if (available < 0) return badImage(); }
                if (!count || count > 256 || offset + count > end) return badImage();
                huffman.add(info); offset += count;
            }
        }
        at = end;
        if (marker === 0xda) {
            if (!size || length < 6 || length !== 6 + bytes[end - length + 2] * 2) return badImage();
            const count = bytes[end - length + 2], selected = new Set(), spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2];
            if (!count || count > components.size || spectralStart > spectralEnd || spectralEnd > 63 || !huffman.size) return badImage();
            for (let offset = end - length + 3; offset < end - 3; offset += 2) {
                const id = bytes[offset], tables = bytes[offset + 1];
                if (selected.has(id) || !components.has(id) || !quantization.has(components.get(id)) || (tables >> 4) > 3 || (tables & 15) > 3) return badImage();
                if (spectralStart === 0 && !(bytes[end - 1] >> 4) && !huffman.has(tables >> 4)) return badImage();
                if (spectralEnd > 0 && !huffman.has(0x10 | (tables & 15))) return badImage();
                selected.add(id);
            }
            scan = true;
            const start = at;
            while (at < bytes.length) {
                if (bytes[at] !== 0xff) { at++; continue; }
                if (bytes[at + 1] === 0 || (bytes[at + 1] >= 0xd0 && bytes[at + 1] <= 0xd7)) { at += 2; continue; }
                break;
            }
            if (at === start) return badImage();
        }
    }
    return badImage();
}

function webp(bytes) {
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) return badImage();
    let at = 12, canvas, picture;
    const seen = new Set();
    while (at < bytes.length) {
        if (at + 8 > bytes.length) return badImage();
        const type = bytes.toString('ascii', at, at + 4), length = bytes.readUInt32LE(at + 4), end = at + 8 + length, next = end + (length & 1), data = bytes.subarray(at + 8, end);
        if (next > bytes.length || seen.has(type) || !['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'VP8L', 'EXIF', 'XMP '].includes(type)) return badImage();
        seen.add(type);
        if (type === 'VP8X') {
            if (at !== 12 || length !== 10 || data[0] & 0xc3 || data[1] || data[2] || data[3]) return badImage();
            canvas = dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
        }
        if (type === 'VP8 ') {
            const partition = length >= 3 ? data.readUIntLE(0, 3) >>> 5 : 0;
            if (picture || length < 11 || data[0] & 1 || ((data[0] >> 1) & 7) > 3 || !(data[0] & 16) || !partition || partition > length - 10 || !data.subarray(3, 6).equals(Buffer.from('9d012a', 'hex'))) return badImage();
            picture = dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
        }
        if (type === 'VP8L') {
            if (picture || length < 9 || data[0] !== 0x2f || data[4] >> 5) return badImage();
            const bits = data.readUInt32LE(1);
            picture = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        at = next;
    }
    if (!picture || (canvas && (canvas.width !== picture.width || canvas.height !== picture.height))) return badImage();
    return picture;
}

export function validateSponsorImage(mime, bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) return badImage();
    if (bytes.length > SPONSOR_IMAGE_LIMIT) invalid('画像は 2MiB 以下にしてください。');
    try {
        const parse = { 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp }[mime];
        if (!parse) return badImage();
        return { id: digest(bytes), mime, ...parse(bytes) };
    } catch (error) {
        if (error instanceof SponsorValidationError) throw error;
        return badImage();
    }
}

/** Operator text and HTTPS links, shared with the ad library (src/ad-library.mjs). */
export { text as sponsorText, validateLink as sponsorLink };
function text(value, limit, label) {
    if (typeof value !== 'string' || !value.isWellFormed() || /[<>\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) || [...value.trim()].length > limit)
        invalid(`${label}は HTML や制御文字を含まない ${limit}文字以内のテキストにしてください。`);
    return value.trim();
}

function settings(data) {
    if (typeof data.enabled !== 'boolean' || !['recruitment', 'sponsor'].includes(data.mode)) invalid('広告の表示状態と種類を選択してください。');
    const title = text(data.title, 60, '見出し'), message = text(data.message, 120, '本文'), link = validateLink(text(data.link, 240, 'リンク'));
    return { enabled: data.enabled, mode: data.mode, title, message, link };
}

function validateLink(link) {
    if (!link) return link;
    let url;
    try { url = new URL(link); } catch { invalid('リンクは HTTPS の URL にしてください。'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /\s/u.test(link)) invalid('リンクは認証情報を含まない HTTPS の URL にしてください。');
    return link;
}
function completeness(state) {
    if (state.mode === 'sponsor' && (!state.title || (!state.message && !state.image))) invalid('スポンサー表示には見出しと、本文または画像を設定してください。');
}

/** One operator-owned slot; no network requests, model input or viewer comments enter this store. */
export class Sponsor {
    constructor(dataDir) {
        this.dir = dataDir; this.path = join(dataDir, 'sponsor.json'); this.images = join(dataDir, 'sponsor-images');
        this.state = { ...DEFAULT_SPONSOR }; this.damaged = false;
        let savedFile = false;
        try {
            if (statSync(this.path).size > 8192) throw new Error('Invalid saved sponsor');
            savedFile = true;
            const saved = JSON.parse(readFileSync(this.path, 'utf8'));
            if (saved?.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Invalid saved sponsor');
            const clean = settings(saved);
            let image = null;
            if (saved.image !== null) {
                if (!ID.test(saved.image?.id) || statSync(join(this.images, saved.image.id)).size > SPONSOR_IMAGE_LIMIT) throw new Error('Invalid saved image');
                image = validateSponsorImage(saved.image.mime, readFileSync(join(this.images, saved.image.id)));
                if (image.id !== saved.image.id || image.width !== saved.image.width || image.height !== saved.image.height) throw new Error('Invalid saved image');
            }
            const next = { revision: saved.revision, ...clean, image };
            completeness(next); this.state = next;
        } catch (error) { this.damaged = savedFile || error.code !== 'ENOENT'; }
    }

    snapshot() {
        return { ...this.state, image: this.state.image ? { ...this.state.image, url: `/api/sponsor/image/${this.state.image.id}` } : null };
    }

    update(data) {
        const allowed = ['revision', 'enabled', 'mode', 'title', 'message', 'link', 'imageData'];
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key)) || !Number.isSafeInteger(data.revision) || data.revision < 0)
            invalid('現在の設定を読み込み、広告設定をすべて指定してください。');
        if (data.revision !== this.state.revision) throw new SponsorConflictError('別の画面で広告設定が変更されました。最新の設定を確認してください。');
        const next = { revision: this.state.revision + 1, ...settings(data), image: this.state.image };
        let bytes;
        if (data.imageData === null) next.image = null;
        else if (data.imageData !== undefined) {
            const image = data.imageData;
            if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => !['mime', 'base64'].includes(key)) || typeof image.base64 !== 'string') return badImage();
            if (image.base64.length > Math.ceil(SPONSOR_IMAGE_LIMIT / 3) * 4) invalid('画像は 2MiB 以下にしてください。');
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) return badImage();
            bytes = Buffer.from(image.base64, 'base64');
            if (bytes.toString('base64') !== image.base64) return badImage();
            next.image = validateSponsorImage(image.mime, bytes);
        }
        completeness(next);
        if (!this.damaged && JSON.stringify({ ...next, revision: this.state.revision }) === JSON.stringify(this.state)) return false;
        if (!Number.isSafeInteger(next.revision)) throw new Error('Sponsor revision limit reached');
        const temporary = join(this.dir, `.sponsor-${randomUUID()}.tmp`);
        let imageTemporary, createdImage = false;
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        try {
            if (bytes) {
                mkdirSync(this.images, { recursive: true, mode: 0o700 });
                imageTemporary = join(this.images, `.sponsor-${randomUUID()}.tmp`);
                writeFileSync(imageTemporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
                try { linkSync(imageTemporary, join(this.images, next.image.id)); createdImage = true; }
                catch (error) {
                    if (error.code !== 'EEXIST' || digest(readFileSync(join(this.images, next.image.id))) !== next.image.id) throw error;
                }
            }
            writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { flag: 'wx', mode: 0o600, flush: true });
            renameSync(temporary, this.path);
        } catch (error) {
            if (createdImage) try { rmSync(join(this.images, next.image.id)); } catch { /* Preserve the settings failure. */ }
            throw error;
        } finally {
            for (const path of [temporary, imageTemporary].filter(Boolean)) try { rmSync(path, { force: true }); } catch { /* Cleanup cannot roll back a completed save. */ }
        }
        this.state = next; this.damaged = false;
        this.cleanup();
        return true;
    }

    image(id) {
        if (!ID.test(id)) return null;
        try {
            const path = join(this.images, id);
            if (statSync(path).size > SPONSOR_IMAGE_LIMIT) return null;
            const bytes = readFileSync(path);
            if (digest(bytes) !== id) return null;
            const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
            return { bytes, mime };
        } catch { return null; }
    }

    cleanup() {
        // Keep eight previous images so in-flight clients can finish old snapshots; bound each cleanup to sixteen removals.
        try {
            const old = readdirSync(this.images).filter(id => ID.test(id) && id !== this.state.image?.id)
                .map(id => ({ id, at: statSync(join(this.images, id)).mtimeMs })).sort((a, b) => b.at - a.at);
            for (const { id } of old.slice(8, 24)) rmSync(join(this.images, id));
        } catch { /* A cleanup problem must not turn a durable update into an apparent failure. */ }
    }
}
