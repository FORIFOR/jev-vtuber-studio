// Stage themes (STAGE_THEME): 'classic' is the drawn room the stage always had; 'room' is Noa's night room from the Noa
// OBS asset pack (painted background, navy/champagne frames, reaction stickers). Pure and shared (stage + tests): which
// theme a view uses, what the frame's theme/goal box says, and which reaction sticker a moment deserves, rate-limited.
import { participationView } from './participation-view.mjs';

export const STAGE_THEMES = Object.freeze(['classic', 'room']);
export const isStageTheme = v => STAGE_THEMES.includes(v);

/** An explicit view URL (#theme=room / ?theme=classic) wins; otherwise the Studio's setting (state.stageTheme); else classic. */
export function resolveStageTheme(urlTheme, stateTheme) {
    return isStageTheme(urlTheme) ? urlTheme : isStageTheme(stateTheme) ? stateTheme : 'classic';
}

/** The room frames are drawn for the 1920x1080 talk and external-game layouts only: portrait, the transparent overlay
 * layout, layered OBS sources and the in-browser games (NOA BLOCKS, star garden) keep the classic look. */
export function roomApplies(theme, { vertical = false, overlay = false, layer = null, blocks = false, inBrowserGame = false } = {}) {
    return theme === 'room' && !vertical && !overlay && !layer && !blocks && !inBrowserGame;
}

/** Content boxes of the asset pack (docs/coordinates.json, 1920x1080, left/top/width/height). The stage CSS and the OBS
 * geometry in src/obs.mjs are built from these; tests keep the three in step. */
export const ROOM_BOXES = Object.freeze({
    talk: Object.freeze({ avatar: [280, 24, 1048, 884], theme: [1410, 108, 448, 51], chat: [1404, 296, 464, 284], selected: [1430, 695, 428, 66], subtitle: [196, 930, 1030, 100], pr: [1468, 832, 352, 198] }),
    game: Object.freeze({ game: [32, 140, 1376, 774], avatar: [1438, 24, 448, 512], goal: [840, 61, 390, 53], chat: [1454, 636, 424, 182], selected: [70, 987, 396, 40], subtitle: [553, 945, 720, 92], pr: [1524, 884, 288, 162] }),
    // ROOM_GAME_LAYOUT=front (operator 2026-10-19, design 案A): a bigger game window; Noa stands in front of its lower-right
    // corner (the only box that may overlap the game: the stage page is above the capture there and transparent over it);
    // the ad, the answered comment and the chat in a right-hand column; the subtitles under the game, left of Noa.
    // avatar is the avatar element's box (its 3:4 canvas, mostly transparent); Noa's figure starts about 100 px inside it.
    front: Object.freeze({ game: [24, 96, 1456, 819], avatar: [1020, 461, 487, 649], goal: [470, 20, 760, 60], pr: [1512, 140, 384, 216], selected: [1512, 404, 384, 66], chat: [1512, 548, 384, 500], subtitle: [48, 936, 960, 116] }),
    // ROOM_GAME_LAYOUT=full (operator 2026-10-19, design 案C): the game fills the screen. Vampire's own HUD is its top
    // strip and the player stays at the centre, so everything else sits low and at the edges: Noa standing bottom-right
    // (box past the edge; her figure is inside), her subtitles as a speech bubble beside her with the answered comment
    // quoted at its top (selected, inside subtitle), the chat along the left edge, one status bar (name, goal, run, AI
    // disclosure; goal is its text) along the bottom, a small ad under the HUD's right end.
    // ROOM_GAME_LAYOUT=frame (operator 2026-10-19, design 案D after a reference screen): the game in a glowing 1600x900
    // frame; a LIVE clock, the live chat and the ad in a right-hand column; NOW PLAYING with the goal and the AI
    // disclosure inside the game's lower-left; a speech bubble beside Noa (the answered comment quoted at its top); Noa
    // as a big bust bottom-right in front of the frame; a name banner along the bottom (logo, hashtag, handle, catchphrase).
    // Noa's head starts below the ad, and the frame's bottom edge cuts her at the waist (her top always shows).
    // 2026-10-19 (operator): the game as big as it fits (1680x945), Noa bigger and deeper into the game, cut at the chest.
    frame: Object.freeze({ game: [8, 8, 1680, 945], clock: [1700, 8, 212, 104], chat: [1712, 172, 188, 240], pr: [1700, 452, 212, 119], nowPlaying: [32, 760, 700, 160], subtitle: [740, 740, 520, 170], selected: [758, 752, 484, 32], banner: [0, 962, 1300, 118], avatar: [1220, 520, 640, 853] }),
    // ROOM_GAME_LAYOUT=wide (operator 2026-10-19, 没入型 案1, for Smash): the game as big as it fits beside a slim column
    // (1600x900, no header); nothing covers the picture, so a HUD anywhere in it stays readable. Noa as a bust at the top
    // of the right-hand column, the AI disclosure, the chat and the ad under her; the subtitles, the goal and the
    // answered comment in the strip under the game. avatar is her 3:4 canvas (its transparent left part lies over the
    // game window, where the page is see-through); her figure starts at x 1620, outside the game.
    wide: Object.freeze({ game: [8, 8, 1600, 900], avatar: [1540, 8, 393, 524], chat: [1620, 644, 292, 200], pr: [1620, 880, 292, 164], subtitle: [32, 924, 1060, 112], goal: [1260, 922, 336, 48], selected: [1250, 988, 346, 50] }),
    full: Object.freeze({ game: [0, 0, 1920, 1080], avatar: [1380, 380, 560, 747], subtitle: [740, 786, 640, 206], selected: [764, 798, 592, 36], chat: [24, 560, 496, 390], bar: [24, 1004, 1346, 56], goal: [318, 1012, 462, 40], pr: [1576, 140, 320, 180] }),
});

/** The room theme's game layouts (ROOM_GAME_LAYOUT; ROOM_BOXES: 'side' is the original ROOM_BOXES.game). */
export const GAME_LAYOUTS = Object.freeze(['side', 'front', 'full', 'frame', 'wide']);
/** The layout a game airs in: its manifest's stage.layout (games/<id>/game.json: a game knows where its own HUD is,
 * operator 2026-10-19), else the Studio's setting, else 'side'. */
export function effectiveGameLayout(setting, game) {
    const own = game?.stage?.layout;
    return GAME_LAYOUTS.includes(own) ? own : GAME_LAYOUTS.includes(setting) ? setting : 'side';
}
/** The boxes of a layout (1920x1080). */
export const layoutBoxes = layout => layout === 'side' ? ROOM_BOXES.game : ROOM_BOXES[layout];

/** The theme / goal box: a live participation question first, then today's goal (GAME_GOAL) in the game layout, else the
 * current talk topic. Only observed state; nothing is invented. -> { label, text } */
export function roomTopic(s = {}, { game = false } = {}, now = Date.now()) {
    const p = participationView(s, now);
    if (p.question) return { label: 'いまのお題', text: p.question };
    if (game) {
        const goal = typeof s.gameShow?.goal === 'string' ? s.gameShow.goal.trim() : '';
        return { label: '今日の目標', text: goal || p.context.replace(/^目標：/, '') };
    }
    // During the opening talk the box follows its scene (today's news topics change it), else the programme's topic.
    const title = [s.topic?.scene, s.topic?.title, s.topic?.programme?.title].find(t => typeof t === 'string' && t.trim());
    return { label: '今日のテーマ', text: title ? title.trim() : p.context };
}

/** Which platform badges the comment frame shows: the chosen destination, both when simulcasting or not chosen yet. */
export function chatBadges(streamTarget) {
    return { youtube: streamTarget !== 'twitch', twitch: streamTarget !== 'youtube' };
}

// ---- Reaction stickers (public/models/room/react<name>.png) ------------------------------------------------------------
/** ms: on screen; priority: a higher one may replace a showing sticker; cooldownMs: the same sticker again no sooner. */
export const ROOM_REACTIONS = Object.freeze({
    anger: { ms: 1500, priority: 2, cooldownMs: 45000 },
    sweat: { ms: 1800, priority: 1, cooldownMs: 10000 },
    tears: { ms: 2400, priority: 3, cooldownMs: 90000 },
    sparkle: { ms: 1800, priority: 1, cooldownMs: 10000 },
    surprise: { ms: 1400, priority: 2, cooldownMs: 8000 },
    success: { ms: 2500, priority: 4, cooldownMs: 6000 },
    failure: { ms: 2400, priority: 3, cooldownMs: 6000 },
});
/** Never two stickers closer than this (unless a more important one takes over). */
export const REACTION_GAP_MS = 4000;
const CALM = new Set(['happy', 'laugh', 'excited', 'embarrassed', 'nod']);

/** A host line as it starts (speech_started): the line's own reaction picks the sticker. Anger only when the affect engine
 * reports real frustration (or its rage state) on a line that is not a happy one; shy lines keep their blush only. */
export function speechReactionAsset(d) {
    if (!d || (d.role ?? 'host') !== 'host') return null;
    const a = d.affect || {};
    if (!CALM.has(d.reaction) && (a.rageActive === true || (Number.isFinite(a.frustration) && a.frustration >= .7))) return 'anger';
    switch (d.reaction) {
        case 'surprised': case 'shock': return 'surprise';
        case 'troubled': return 'sweat';
        case 'laugh': case 'excited': return 'sparkle';
        case 'happy': return d.intensity === 'high' ? 'sparkle' : null;
        default: return null;
    }
}

const GAME_EVENT_ASSET = { hp_low: 'sweat', surrounded: 'sweat', boss: 'surprise', fast_enemy: 'surprise', chest: 'sparkle', weapon_new: 'sparkle' };
/** Game moments from an external game show's status (docs/GAMES.md: phase, run, recent events, lastResult). Stateful only
 * to remember what it already reacted to: the first status a view sees is never replayed, a run's result reacts once
 * (a new personal best = success, a game over = failure, every third game over in a row = tears), a level milestone
 * (every 10th level) = success. -> [{ asset, key }] */
export class GameReactionTracker {
    constructor() { this.seen = new Set(); this.primed = false; this.lastResultRound = undefined; this.misses = 0; }
    update(v) {
        if (!v || typeof v !== 'object') return [];
        const out = [], resultRound = v.lastResult?.roundId ?? null;
        const eventKeys = (Array.isArray(v.recent) ? v.recent : []).filter(e => e && typeof e.type === 'string').map(e => [e, `${v.run ?? ''}:${e.type}:${e.gameSeconds ?? ''}`]);
        if (!this.primed) {
            this.primed = true; this.lastResultRound = resultRound;
            for (const [, k] of eventKeys) this.seen.add(k);
            return [];
        }
        if (resultRound !== null && resultRound !== this.lastResultRound) {
            const r = v.lastResult;
            if (r.newBest === true) { this.misses = 0; out.push({ asset: 'success', key: `result:${resultRound}` }); }
            else if (r.reason === 'game_over') { this.misses++; out.push({ asset: this.misses % 3 === 0 ? 'tears' : 'failure', key: `result:${resultRound}` }); }
        }
        this.lastResultRound = resultRound;
        for (const [e, k] of eventKeys) {
            if (this.seen.has(k)) continue;
            this.seen.add(k); if (this.seen.size > 300) this.seen.delete(this.seen.values().next().value);
            const level = Number(e.facts?.level);
            const asset = e.type === 'level_up' ? (Number.isInteger(level) && level > 0 && level % 10 === 0 ? 'success' : null) : GAME_EVENT_ASSET[e.type] || null;
            if (asset) out.push({ asset, key: `event:${k}` });
        }
        return out;
    }
}

/** The limits live here, not in the model: each moment once, one sticker at a time (a more important one may replace
 * it), REACTION_GAP_MS between stickers, a cooldown per sticker. -> { asset, ms } or null */
export class ReactionGate {
    constructor({ now = Date.now } = {}) { this.now = now; this.keys = new Set(); this.lastAt = {}; this.active = null; this.lastShownAt = -Infinity; }
    offer(asset, key = null) {
        const spec = ROOM_REACTIONS[asset];
        if (!spec || (key && this.keys.has(key))) return null;
        const now = this.now();
        if (now - (this.lastAt[asset] ?? -Infinity) < spec.cooldownMs) return null;
        const showing = this.active && now < this.active.until;
        if (showing) { if (this.active.priority >= spec.priority) return null; }
        else if (now - this.lastShownAt < REACTION_GAP_MS && spec.priority <= (this.active?.priority ?? 0)) return null;
        if (key) { this.keys.add(key); if (this.keys.size > 500) this.keys.delete(this.keys.values().next().value); }
        this.lastAt[asset] = now; this.lastShownAt = now;
        this.active = { asset, priority: spec.priority, until: now + spec.ms };
        return { asset, ms: spec.ms };
    }
    clear() { this.active = null; }
}

// Where the head sits inside each renderer's picture (fractions of the avatar box; measured on the 2D and 3D Noa at rest),
// and where each sticker goes around it, in head widths from the head's centre (the pack's README placement guide).
export const HEAD_IN_AVATAR = Object.freeze({ vrm: { x: .49, y: .52, w: .6 }, noa: { x: .585, y: .34, w: .5 }, builtin: { x: .5, y: .4, w: .5 }, png: { x: .5, y: .3, w: .4 } });
const SPOTS = { anger: { dx: .40, dy: -.42, s: .34 }, sweat: { dx: .56, dy: -.10, s: .34 }, tears: { dx: 0, dy: .22, s: .56 }, sparkle: { dx: .55, dy: .06, s: .38 },
    surprise: { dx: .46, dy: -.52, s: .46 }, success: { dx: 0, dy: -.16, s: 1.55 }, failure: { dx: .22, dy: -.78, s: .66 } };
/** The sticker's square in canvas pixels for an avatar box { left, top, width, height }, kept on the 1920x1080 canvas;
 * null when the avatar is drawn elsewhere (VTube Studio) or the sticker is unknown. */
export function reactionBox(asset, box, mode, canvas = { width: 1920, height: 1080 }) {
    const head = HEAD_IN_AVATAR[mode], spot = SPOTS[asset];
    if (!head || !spot || !box || !(box.width > 0)) return null;
    const w = head.w * box.width, cx = box.left + head.x * box.width, cy = box.top + head.y * box.height, size = Math.round(spot.s * w);
    const left = Math.round(Math.max(0, Math.min(canvas.width - size, cx + spot.dx * w - size / 2)));
    const top = Math.round(Math.max(0, Math.min(canvas.height - size, cy + spot.dy * w - size / 2)));
    return { left, top, size };
}

// ---- NOA BEER (DRINK_MODE, src/drink-mode.mjs; operator-approved 2026-10-10) -----------------------------------------------
/** Where the can stands (1920x1080 canvas, left/top/width/height; the image is 243x512). Room layouts keep clear of every
 * ROOM_BOXES content box except Noa's own avatar box, which it stands beside; tests check this. */
export const DRINK_CAN_BOXES = Object.freeze({
    roomTalk: Object.freeze([1210, 600, 81, 170]), // on the desk to Noa's left (viewer's right), beside the mug
    roomGame: Object.freeze([1432, 386, 71, 150]), // right of the game window, at Noa's side above the comment panel
    roomFront: Object.freeze([1036, 925, 66, 140]), // front layout: under the game window, at Noa's side left of her
    roomFull: Object.freeze([1384, 936, 60, 128]), // full layout: at Noa's feet, right of the speech bubble
    roomFrame: Object.freeze([1062, 968, 50, 106]), // frame layout: on the banner, at Noa's side
    roomWide: Object.freeze([1850, 400, 50, 106]), // wide layout: in the column at Noa's side, above the chat
    classic: Object.freeze([1300, 740, 85, 180]), // classic talk (and the game layout's opening talk): beside Noa at the desk edge
    classicGame: Object.freeze([1196, 770, 81, 170]), // classic game layout (layout=game): right of the game frame and subtitles
});
/** The can is drawn on the full 1920x1080 stage only: not in portrait, the transparent overlay, layered OBS sources or NOA BLOCKS. */
export function drinkCanApplies(drinkMode, { vertical = false, overlay = false, layer = null, blocks = false } = {}) {
    return drinkMode === true && !vertical && !overlay && !layer && !blocks;
}
/** The first part of a host line that is a sip (the engine's 'drink' utterance): the can reacts once per sip. */
export const isDrinkCue = d => !!d && (d.role ?? 'host') === 'host' && d.cue?.utterance === 'drink' && !(d.cue.part > 0);
/** The reaction sticker for a sip, from its words: irritation = anger, a lost thread = sweat, a sharp sip = surprise, else sparkle. */
export function drinkReactionAsset(d) {
    if (!isDrinkCue(d)) return null;
    const t = String(d.text ?? '');
    return /悔し|怒|むか/.test(t) ? 'anger' : /何の話|あれ[、？?]/.test(t) ? 'sweat' : /しみる/.test(t) ? 'surprise' : 'sparkle';
}
