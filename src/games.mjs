import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
// Games are plug-ins: games/<id>/game.json names the show (commentary) module, the controller that plays the game with
// Jev (any program that logs one JSON observation per line), and what OBS captures. Adding a game adds a folder;
// nothing in the Studio core names a particular game. See docs/GAMES.md.

export const GAMES_DIR = resolve(import.meta.dirname, '..', 'games');
const requireModule = createRequire(import.meta.url);
const ALIASES = { vampire: 'vampire-survivors' }; // programmes written before the plug-ins used gameMode "vampire"
/** Who plays: 'jev' (the manifest's controller, started with the show) or 'operator' (a person at the controls; the show
 * only comments, on what the operator reports from the Studio). */
export const PLAYERS = ['jev', 'operator'];
/** How OBS gets the picture: 'window' (the game's own window on this Mac, ScreenCaptureKit) or 'switch' (the capture
 * card set up on the Studio's Switch page: its JVS Switch Video / Audio inputs are reused in the game's scene). */
export const CAPTURE_KINDS = ['window', 'switch'];

/** The game a programme plays (external game shows only; NOA BLOCKS runs inside the stage). */
const STAGE_LAYOUTS = ['side', 'front', 'full', 'frame', 'wide']; // public/stage-theme.mjs GAME_LAYOUTS
export function gameIdOf(programme) {
    const id = programme?.game || (typeof programme?.gameMode === 'string' ? ALIASES[programme.gameMode] : null);
    return id && id !== 'blocks' ? id : null;
}

/** The validated manifest of a game, or null when it does not exist. */
export function loadGame(id, dir = GAMES_DIR) {
    if (!id || !/^[a-z0-9-]+$/.test(id)) return null;
    const file = join(dir, id, 'game.json');
    if (!existsSync(file)) return null;
    const m = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of ['id', 'title', 'show']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`games/${id}/game.json: "${k}" is required`);
    if (m.id !== id) throw new Error(`games/${id}/game.json: id must be "${id}"`);
    if (m.controller && (!Array.isArray(m.controller.command) || !m.controller.command.length || typeof m.controller.logDir !== 'string')) throw new Error(`games/${id}/game.json: controller needs "command" and "logDir"`);
    const player = m.player ?? (m.controller ? 'jev' : 'operator');
    if (!PLAYERS.includes(player)) throw new Error(`games/${id}/game.json: player must be one of ${PLAYERS.join(', ')}`);
    if (player === 'jev' && !m.controller) throw new Error(`games/${id}/game.json: a game Jev plays needs a controller`);
    const capture = { kind: 'window', ...(m.capture || {}) };
    if (!CAPTURE_KINDS.includes(capture.kind)) throw new Error(`games/${id}/game.json: capture.kind must be one of ${CAPTURE_KINDS.join(', ')}`);
    // stage: where the studio's overlays may go over this game (operator 2026-10-19): the room layout that suits it, and
    // its own HUD as fractions [x, y, w, h] of the game picture, which no overlay may cover (tests check every layout).
    if (m.stage !== undefined) {
        const s = m.stage;
        if (!s || typeof s !== 'object') throw new Error(`games/${id}/game.json: stage must be an object`);
        if (s.layout !== undefined && !STAGE_LAYOUTS.includes(s.layout)) throw new Error(`games/${id}/game.json: stage.layout must be one of ${STAGE_LAYOUTS.join(', ')}`);
        if (s.hud !== undefined && !(Array.isArray(s.hud) && s.hud.every(b => Array.isArray(b) && b.length === 4 && b.every(v => typeof v === 'number' && v >= 0 && v <= 1) && b[0] + b[2] <= 1 && b[1] + b[3] <= 1)))
            throw new Error(`games/${id}/game.json: stage.hud must be [[x, y, w, h], ...] fractions of the game picture`);
    }
    return { ...m, player, capture, dir: join(dir, id), showPath: resolve(join(dir, id), m.show) };
}

export const listGames = (dir = GAMES_DIR) => existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('_') && existsSync(join(dir, n, 'game.json'))).sort() : [];

/** A game's show module, loaded synchronously (the engine builds its show in its constructor). It exports
 * createShow(showConfig, deps) → the round director TalkEngine drives (see docs/GAMES.md for its surface). */
export function loadShowModule(game) {
    const mod = requireModule(game.showPath);
    if (typeof mod.createShow !== 'function') throw new Error(`${game.show}: export createShow(showConfig, deps)`);
    return mod;
}

/** Where the controller runs and logs, from the settings (GAME_DIR / GAME_LOG_DIR; the VAMPIRE_* names still work). */
export function controllerPaths(game, env = {}) {
    if (!game?.controller) return { dir: '', logDir: '' };
    const logSetting = env.GAME_LOG_DIR || env.VAMPIRE_RUNS_DIR || '';
    const dir = env.GAME_DIR || env.VAMPIRE_REPO || (logSetting ? dirname(logSetting) : '');
    return { dir, logDir: logSetting || (dir ? join(dir, game.controller.logDir) : '') };
}
