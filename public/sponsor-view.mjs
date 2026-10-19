/** Shared, text-only sponsor card and bounded image lifetime for Studio and stage. */
export const SPONSOR_DEFAULTS = Object.freeze({ enabled: false, mode: 'recruitment', title: '広告募集中', message: 'このスペースに広告を掲載できます', link: '', image: null });
export const SPONSOR_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const SPONSOR_IMAGE_LIMIT = 2 * 1024 * 1024;
export const AD_VIDEO_TYPES = Object.freeze(['video/mp4', 'video/webm']);
export const AD_VIDEO_LIMIT = 64 * 1024 * 1024;
export const sponsorLabel = mode => mode === 'sponsor' ? '広告 / PR' : '広告募集';
export const sponsorLayerVisible = layer => !layer || layer === 'overlay';
export function isSponsorSnapshot(value) {
    return !!value && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.enabled === 'boolean' &&
        ['recruitment', 'sponsor'].includes(value.mode) && ['title', 'message', 'link'].every(key => typeof value[key] === 'string');
}

/** Server changes never silently replace an unsaved draft. A newer hide also unchecks its visibility. */
export class SponsorDraft {
    constructor() { this.saved = null; this.value = { ...SPONSOR_DEFAULTS }; this.baseRevision = -1; this.dirty = false; this.imageData = undefined; this.imageBlob = null; }
    receive(snapshot, authoritative = false) {
        if (!isSponsorSnapshot(snapshot) || (!authoritative && snapshot.revision <= (this.saved?.revision ?? -1))) return false;
        this.saved = snapshot;
        if (!this.dirty) this.reset();
        else if (!snapshot.enabled) this.value.enabled = false;
        return true;
    }
    reset() {
        this.value = { ...(this.saved || SPONSOR_DEFAULTS) }; this.baseRevision = this.saved?.revision ?? -1;
        this.dirty = false; this.imageData = undefined; this.imageBlob = null;
    }
    edit(fields) { Object.assign(this.value, fields); this.dirty = true; }
    image(data, blob = null) { this.imageData = data; this.imageBlob = blob; this.value.image = null; this.dirty = true; }
    payload() {
        const { enabled, mode, title, message, link } = this.value;
        return { revision: this.baseRevision, enabled, mode, title, message, link, ...(this.imageData !== undefined ? { imageData: this.imageData } : {}) };
    }
}

export class SponsorView {
    constructor(root, { token = () => '', fetchFn = (...args) => fetch(...args), imageFactory = () => new Image(), urlApi = URL, onState = () => {} } = {}) {
        this.root = root; this.parts = Object.fromEntries(['label', 'title', 'message', 'link', 'image', 'video'].map(name => [name, root.querySelector(`[data-sponsor-${name}]`)]));
        this.token = token; this.fetchFn = fetchFn; this.imageFactory = imageFactory; this.urlApi = urlApi; this.onState = onState;
        this.revision = -1; this.imageKey = null; this.epoch = 0; this.urls = new Set(); this.disposed = false;
    }
    setState(state) { this.root.dataset.sponsorState = state; this.onState(state, this.revision); }
    revoke(url) { if (url && this.urls.delete(url)) this.urlApi.revokeObjectURL(url); }
    clearImage() {
        this.epoch++; this.abort?.abort(); this.abort = null; this.imageKey = null;
        this.parts.image.hidden = true; this.parts.image.removeAttribute('src');
        if (this.parts.video) { try { this.parts.video.pause?.(); } catch { } this.parts.video.hidden = true; this.parts.video.removeAttribute('src'); this.parts.video.load?.(); }
        for (const url of this.urls) this.revoke(url);
        this.activeUrl = null;
    }
    render(snapshot, { draft = false, imageBlob = null, allowed = true, authoritative = false } = {}) {
        if (this.disposed || (!draft && (!isSponsorSnapshot(snapshot) || (!authoritative && snapshot.revision < this.revision)))) return;
        this.revision = snapshot.revision ?? -1;
        this.root.dataset.sponsorRevision = String(this.revision);
        this.root.dataset.sponsorMode = snapshot.mode;
        this.parts.label.textContent = sponsorLabel(snapshot.mode);
        for (const key of ['title', 'message', 'link']) { this.parts[key].textContent = snapshot[key] || ''; this.parts[key].title = snapshot[key] || ''; }
        this.parts.link.hidden = !snapshot.link;
        this.root.hidden = !allowed || (!draft && !snapshot.enabled);
        if (this.root.hidden) { this.clearImage(); this.setState('hidden'); return; }
        const image = snapshot.image, video = snapshot.video && this.parts.video ? snapshot.video : null;
        if (!imageBlob && !image && !video) { this.clearImage(); this.setState('visible'); return; }
        const key = imageBlob || (video ? `video:${video.id}:${video.sound ? 1 : 0}` : image?.id);
        if (this.imageKey === key) { this.setState(this.root.dataset.sponsorState); return; } // Reuse pixels, but report the new revision.
        this.clearImage(); this.imageKey = key;
        const epoch = this.epoch, abort = new AbortController(); this.abort = abort;
        this.setState('loading');
        this.loading = (video ? this.loadVideo(video, abort.signal, epoch) : this.loadImage(image, imageBlob, abort.signal, epoch)).catch(() => {
            if (!this.disposed && epoch === this.epoch) { this.clearImage(); this.setState('image-error'); }
        });
    }
    async loadImage(image, localBlob, signal, epoch) {
        let blob = localBlob;
        if (!blob) {
            // Only a same-origin, content-addressed backend image is fetched. Never a pasted URL.
            if (!SPONSOR_IMAGE_TYPES.includes(image?.mime) || !/^\/api\/sponsor\/image\/[a-f0-9]+$/.test(image?.url || '')) throw new Error('Unsupported image');
            const response = await this.fetchFn(image.url, { headers: { Authorization: `Bearer ${this.token()}` }, signal });
            if (!response.ok) throw new Error('Image unavailable');
            blob = await response.blob();
        }
        if (this.disposed || epoch !== this.epoch) return;
        if (!SPONSOR_IMAGE_TYPES.includes(blob.type) || blob.size > SPONSOR_IMAGE_LIMIT) throw new Error('Unsupported image');
        const url = this.urlApi.createObjectURL(blob); this.urls.add(url);
        try {
            const decoded = this.imageFactory(); decoded.src = url;
            await decoded.decode();
            if (this.disposed || epoch !== this.epoch) return;
            this.parts.image.src = url; this.parts.image.hidden = false; this.activeUrl = url;
            this.setState('visible');
        } finally { if (this.activeUrl !== url) this.revoke(url); }
    }
    /** A video creative: same authenticated, content-addressed fetch; muted unless the ad says sound; loops on screen. */
    async loadVideo(video, signal, epoch) {
        if (!AD_VIDEO_TYPES.includes(video?.mime) || !/^\/api\/sponsor\/image\/[a-f0-9]+$/.test(video?.url || '')) throw new Error('Unsupported video');
        const response = await this.fetchFn(video.url, { headers: { Authorization: `Bearer ${this.token()}` }, signal });
        if (!response.ok) throw new Error('Video unavailable');
        const blob = await response.blob();
        if (this.disposed || epoch !== this.epoch) return;
        if (!AD_VIDEO_TYPES.includes(blob.type) || blob.size > AD_VIDEO_LIMIT) throw new Error('Unsupported video');
        const url = this.urlApi.createObjectURL(blob); this.urls.add(url);
        const el = this.parts.video;
        el.muted = !video.sound; el.loop = true; el.playsInline = true; el.autoplay = true;
        el.src = url; el.hidden = false; this.activeUrl = url;
        try { await el.play?.(); } catch { /* autoplay may need the OBS/Studio interaction; the frame still shows */ }
        this.setState('visible');
    }
    dispose() { if (this.disposed) return; this.disposed = true; this.clearImage(); }
}

/** Which creatives are on: the sponsor slot's master switch decides whether anything shows; the library's enabled ads
 * rotate (each for its seconds); with none enabled the recruitment/sponsor card itself shows. Pure, for tests. */
export function activeAds(sponsor, ads) {
    if (!sponsor?.enabled) return [];
    return (ads?.ads || []).filter(ad => ad && ad.enabled === true && (ad.media || ad.title));
}
export const adSnapshot = (ad, revision) => ({ revision, enabled: true, mode: 'sponsor', title: ad.title || '', message: ad.message || '', link: ad.link || '',
    image: ad.media?.kind === 'image' ? ad.media : null, video: ad.media?.kind === 'video' ? { ...ad.media, sound: ad.sound === true } : null });

/** Drives one SponsorView from the sponsor slot and the ad library: picks the current creative and advances on a timer. */
export class AdRotation {
    constructor(view, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now() } = {}) {
        Object.assign(this, { view, setTimer, clearTimer, now }); this.sponsor = null; this.ads = null; this.allowed = true; this.index = 0; this.timer = null; this.currentId = null; this.serial = 0;
    }
    receiveSponsor(snapshot, authoritative = false) { if (!isSponsorSnapshot(snapshot)) return; if (!authoritative && this.sponsor && snapshot.revision < this.sponsor.revision) return; this.sponsor = snapshot; this.compose(); }
    receiveAds(snapshot, authoritative = false) {
        if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.ads)) return;
        if (!authoritative && this.ads && snapshot.revision < this.ads.revision) return;
        this.ads = snapshot; this.compose();
    }
    setAllowed(allowed) { this.allowed = allowed; this.compose(); }
    get active() { return activeAds(this.sponsor, this.ads); }
    compose() {
        if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
        if (!this.sponsor) return;
        const list = this.active, revision = (this.sponsor.revision || 0) * 1000 + (this.ads?.revision || 0);
        if (!list.length) { this.currentId = null; this.view.render(this.sponsor, { allowed: this.allowed, authoritative: true }); return; }
        // Keep the creative that is on screen when the list changes; otherwise start from the first.
        let index = list.findIndex(ad => ad.id === this.currentId); if (index < 0) index = Math.min(this.index, list.length - 1);
        this.show(list, index, revision);
    }
    show(list, index, revision) {
        const ad = list[index]; this.index = index; this.currentId = ad.id;
        this.view.render(adSnapshot(ad, revision), { allowed: this.allowed, authoritative: true });
        if (list.length > 1) {
            const serial = ++this.serial;
            this.timer = this.setTimer(() => { if (serial !== this.serial) return; this.timer = null; const now = this.active; if (!now.length) return this.compose(); const next = (now.findIndex(x => x.id === this.currentId) + 1) % now.length; this.show(now, next, revision); }, Math.max(10, Number(ad.seconds) || 60) * 1000);
        }
    }
    dispose() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
}
