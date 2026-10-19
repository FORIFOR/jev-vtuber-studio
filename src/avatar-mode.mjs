import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_AVATAR_MODE, isAvatarMode } from '../public/avatar-modes.mjs';

const READ_ERROR = '保存済みのアバター表示を読み込めませんでした。標準の2D表示を使用しています。';

export class AvatarModeValidationError extends Error {}

export class AvatarMode {
    constructor(dataDir) {
        this.dir = dataDir;
        this.path = join(dataDir, 'avatar-mode.json');
        this.state = { mode: DEFAULT_AVATAR_MODE, revision: 0 };
        this.warning = null;
        try {
            const saved = JSON.parse(readFileSync(this.path, 'utf8'));
            if (saved?.version !== 1 || !isAvatarMode(saved.mode) || !Number.isSafeInteger(saved.revision) || saved.revision < 0)
                throw new Error('Invalid avatar mode state');
            this.state = { mode: saved.mode, revision: saved.revision };
        } catch (error) {
            if (error.code !== 'ENOENT') this.warning = READ_ERROR;
        }
    }

    snapshot() {
        return { ...this.state, ...(this.warning ? { warning: this.warning } : {}) };
    }

    select(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            Object.keys(data).length !== 1 || !isAvatarMode(data.mode))
            throw new AvatarModeValidationError('2Dまたは3Dのアバター表示を選択してください。');
        if (data.mode === this.state.mode && !this.warning) return false;
        if (this.state.revision >= Number.MAX_SAFE_INTEGER)
            throw new Error('Avatar mode revision limit reached');
        const next = { mode: data.mode, revision: this.state.revision + 1 };
        const temporary = join(this.dir, `.avatar-mode-${randomUUID()}.tmp`);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        try {
            writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`, { flag: 'wx', mode: 0o600, flush: true });
            renameSync(temporary, this.path);
        } finally {
            try { rmSync(temporary, { force: true }); } catch { /* A cleanup failure must not undo a successful rename. */ }
        }
        // A failed save must not change the mode already displayed by viewers.
        this.state = next;
        this.warning = null;
        return true;
    }
}
