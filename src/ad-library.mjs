import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SponsorValidationError, SponsorConflictError, validateSponsorImage, sponsorText, sponsorLink, SPONSOR_IMAGE_LIMIT } from './sponsor.mjs';
// The ad library: several creatives the operator received (image, video, or a PDF rasterised locally), each with its
// own on/off, order and seconds on screen. The stage rotates through the enabled ones while the sponsor slot's master
// switch is on, and falls back to the recruitment card when none is enabled (public/sponsor-view.mjs AdRotation).
// Media is content-addressed under data/ad-media/ and served through the same authenticated route as sponsor images.

export const AD_VIDEO_LIMIT = 64 * 1024 * 1024;
export const AD_UPLOAD_LIMIT = AD_VIDEO_LIMIT;
export const AD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const AD_VIDEO_TYPES = ['video/mp4', 'video/webm'];
export const AD_UPLOAD_TYPES = [...AD_IMAGE_TYPES, ...AD_VIDEO_TYPES, 'application/pdf'];
export const AD_LIMITS = Object.freeze({ ads: 20, secondsMin: 10, secondsMax: 600, secondsDefault: 60 });
const ID = /^[a-f0-9]{64}$/, AD_ID = /^[a-f0-9-]{8,40}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => { throw new SponsorValidationError(message); };

/** What a video file says it is, from its first bytes (never from the upload's declared type alone). */
export function sniffVideo(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
    if (bytes.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
    return null;
}
const sniffMime = bytes => bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : sniffVideo(bytes);

/** First page of a PDF as PNG, with macOS's own image tool (no dependency); null where that tool is not present. */
export function rasterisePdf(bytes, { maxPx = 1920, execute = execFileSync, platform = process.platform } = {}) {
    if (platform !== 'darwin') return null;
    const dir = join(tmpdir(), `jvs-ad-${randomUUID()}`); mkdirSync(dir, { mode: 0o700 });
    try {
        const src = join(dir, 'in.pdf'), out = join(dir, 'out.png');
        writeFileSync(src, bytes, { mode: 0o600 });
        execute('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(maxPx), src, '--out', out], { stdio: 'ignore', timeout: 30000 });
        return readFileSync(out);
    } catch { return null; }
    finally { rmSync(dir, { recursive: true, force: true }); }
}

export class AdLibrary {
    constructor(dataDir, { rasterise = rasterisePdf } = {}) {
        this.dir = dataDir; this.path = join(dataDir, 'ads.json'); this.media = join(dataDir, 'ad-media'); this.rasterise = rasterise;
        this.state = { revision: 0, ads: [] }; this.damaged = false;
        try {
            if (!existsSync(this.path)) return;
            if (statSync(this.path).size > 256 * 1024) throw new Error('Invalid saved ads');
            const saved = JSON.parse(readFileSync(this.path, 'utf8'));
            if (saved?.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('Invalid saved ads');
            this.state = { revision: saved.revision, ads: this.validateAds(saved.ads) };
        } catch { this.damaged = true; }
    }
    snapshot() {
        return { revision: this.state.revision, ads: this.state.ads.map(ad => ({ ...ad, media: ad.media ? { ...ad.media, url: `/api/sponsor/image/${ad.media.id}` } : null })) };
    }
    /** A stored media file's descriptor, re-read from disk (the id is its SHA-256). */
    describe(id) {
        if (!ID.test(id)) return null;
        try {
            const path = join(this.media, id), size = statSync(path).size;
            if (size > AD_VIDEO_LIMIT) return null;
            const bytes = readFileSync(path); if (digest(bytes) !== id) return null;
            const video = sniffVideo(bytes);
            if (video) return { kind: 'video', id, mime: video, size };
            const image = validateSponsorImage(sniffMime(bytes), bytes);
            return { kind: 'image', id: image.id, mime: image.mime, width: image.width, height: image.height, size };
        } catch { return null; }
    }
    validateAds(ads) {
        if (!Array.isArray(ads) || ads.length > AD_LIMITS.ads) invalid(`広告は ${AD_LIMITS.ads} 件まで登録できます。`);
        const ids = new Set();
        return ads.map(ad => {
            if (!ad || typeof ad !== 'object' || Array.isArray(ad)) invalid('広告の形式が違います。');
            const allowed = ['id', 'enabled', 'title', 'message', 'link', 'seconds', 'sound', 'media', 'name'];
            if (Object.keys(ad).some(k => !allowed.includes(k))) invalid('広告に知らない項目があります。');
            if (typeof ad.id !== 'string' || !AD_ID.test(ad.id) || ids.has(ad.id)) invalid('広告の id が重複または不正です。'); ids.add(ad.id);
            if (typeof ad.enabled !== 'boolean') invalid('広告の表示状態を選択してください。');
            const seconds = ad.seconds === undefined ? AD_LIMITS.secondsDefault : ad.seconds;
            if (!Number.isInteger(seconds) || seconds < AD_LIMITS.secondsMin || seconds > AD_LIMITS.secondsMax) invalid(`表示秒数は ${AD_LIMITS.secondsMin}〜${AD_LIMITS.secondsMax} 秒にしてください。`);
            const title = sponsorText(ad.title ?? '', 60, '見出し'), message = sponsorText(ad.message ?? '', 120, '本文'), link = sponsorLink(sponsorText(ad.link ?? '', 240, 'リンク'));
            const name = sponsorText(ad.name ?? '', 80, 'ファイル名');
            let media = null;
            if (ad.media !== null && ad.media !== undefined) {
                if (typeof ad.media?.id !== 'string') invalid('広告のメディアが不正です。');
                media = this.describe(ad.media.id); if (!media) invalid('広告のメディアファイルが見つかりません。もう一度アップロードしてください。');
            }
            if (!media && !title) invalid('広告には画像・動画か見出しが必要です。');
            return { id: ad.id, enabled: ad.enabled, title, message, link, seconds, sound: ad.sound === true && media?.kind === 'video', media, name };
        });
    }
    /** Store an uploaded file (image, video, or PDF rasterised to an image) and describe it; nothing is shown yet. */
    addMedia(mime, bytes, name = '') {
        if (!Buffer.isBuffer(bytes) || !bytes.length) invalid('ファイルが空です。');
        if (!AD_UPLOAD_TYPES.includes(mime)) invalid('画像（PNG / JPEG / WebP）、動画（MP4 / WebM）、PDF のいずれかを選んでください。');
        let stored = bytes, descriptor;
        if (mime === 'application/pdf') {
            if (bytes.toString('latin1', 0, 5) !== '%PDF-') invalid('PDF として読めません。');
            let png = this.rasterise(bytes, { maxPx: 1920 });
            if (png && png.length > SPONSOR_IMAGE_LIMIT) png = this.rasterise(bytes, { maxPx: 1280 });
            if (!png) invalid('PDF を画像に変換できませんでした。1 ページ目を PNG か JPEG に書き出して選んでください。');
            stored = png; const image = validateSponsorImage('image/png', png);
            descriptor = { kind: 'image', id: image.id, mime: 'image/png', width: image.width, height: image.height, size: png.length, fromPdf: true };
        } else if (AD_VIDEO_TYPES.includes(mime)) {
            if (bytes.length > AD_VIDEO_LIMIT) invalid('動画は 64MiB 以下にしてください。');
            const sniffed = sniffVideo(bytes); if (sniffed !== mime) invalid('動画ファイルの形式が選択と一致しません（MP4 / WebM）。');
            descriptor = { kind: 'video', id: digest(bytes), mime, size: bytes.length };
        } else {
            const image = validateSponsorImage(mime, bytes);
            descriptor = { kind: 'image', id: image.id, mime: image.mime, width: image.width, height: image.height, size: bytes.length };
        }
        mkdirSync(this.media, { recursive: true, mode: 0o700 });
        const path = join(this.media, descriptor.id);
        if (!existsSync(path)) {
            const temporary = join(this.media, `.upload-${randomUUID()}.tmp`);
            try { writeFileSync(temporary, stored, { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, path); }
            finally { rmSync(temporary, { force: true }); }
        }
        return { ...descriptor, name: sponsorText(String(name || '').slice(0, 80), 80, 'ファイル名'), url: `/api/sponsor/image/${descriptor.id}` };
    }
    update(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['revision', 'ads'].includes(k)) || !Number.isSafeInteger(data.revision) || data.revision < 0)
            invalid('現在の広告一覧を読み込み、一覧全体を指定してください。');
        if (data.revision !== this.state.revision) throw new SponsorConflictError('別の画面で広告一覧が変更されました。最新の一覧を確認してください。');
        const ads = this.validateAds(data.ads);
        const next = { revision: this.state.revision + 1, ads };
        if (!this.damaged && JSON.stringify(ads) === JSON.stringify(this.state.ads)) return false;
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const temporary = join(this.dir, `.ads-${randomUUID()}.tmp`);
        try { writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, this.path); }
        finally { rmSync(temporary, { force: true }); }
        this.state = next; this.damaged = false; this.cleanup();
        return true;
    }
    /** Bytes of a stored media file by id (image or video), for the authenticated media route. */
    file(id) {
        const d = this.describe(id); if (!d) return null;
        return { bytes: readFileSync(join(this.media, id)), mime: d.mime };
    }
    /** Media no ad references any more is removed (a just-uploaded file not yet saved into an ad survives one hour). */
    cleanup(now = Date.now()) {
        try {
            const used = new Set(this.state.ads.map(ad => ad.media?.id).filter(Boolean));
            for (const id of readdirSync(this.media)) {
                if (!ID.test(id) || used.has(id)) continue;
                const path = join(this.media, id);
                if (now - statSync(path).mtimeMs > 3600000) rmSync(path);
            }
        } catch { /* cleanup never fails a save */ }
    }
}
