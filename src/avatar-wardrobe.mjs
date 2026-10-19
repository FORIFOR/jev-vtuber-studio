import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_OUTFIT_ID, isOutfitId } from '../public/avatar-outfits.mjs';

const READ_ERROR = '保存済みの衣装を読み込めませんでした。標準衣装を表示しています。';

export class WardrobeValidationError extends Error {}

export class AvatarWardrobe {
    constructor(dataDir) {
        this.dir = dataDir;
        this.path = join(dataDir, 'avatar-wardrobe.json');
        this.state = { outfitId: DEFAULT_OUTFIT_ID, revision: 0 };
        this.warning = null;
        try {
            const saved = JSON.parse(readFileSync(this.path, 'utf8'));
            if (saved?.version !== 1 || !isOutfitId(saved.outfitId) || !Number.isSafeInteger(saved.revision) || saved.revision < 0)
                throw new Error('Invalid wardrobe state');
            this.state = { outfitId: saved.outfitId, revision: saved.revision };
        } catch (error) {
            if (error.code !== 'ENOENT') this.warning = READ_ERROR;
        }
    }

    snapshot() {
        return { ...this.state, ...(this.warning ? { warning: this.warning } : {}) };
    }

    select(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            Object.keys(data).length !== 1 || !isOutfitId(data.outfitId))
            throw new WardrobeValidationError('利用できる衣装を選択してください。');
        if (data.outfitId === this.state.outfitId && !this.warning) return false;
        if (this.state.revision >= Number.MAX_SAFE_INTEGER)
            throw new Error('Wardrobe revision limit reached');
        const next = { outfitId: data.outfitId, revision: this.state.revision + 1 };
        const temporary = join(this.dir, `.avatar-wardrobe-${randomUUID()}.tmp`);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        try {
            writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { flag: 'wx', mode: 0o600, flush: true });
            renameSync(temporary, this.path);
        } finally {
            try { rmSync(temporary, { force: true }); } catch { /* A cleanup failure must not undo a successful rename. */ }
        }
        // Publish only after the durable file has replaced the previous selection.
        this.state = next;
        this.warning = null;
        return true;
    }
}
