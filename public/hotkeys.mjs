// Live hotkeys (docs/CONTROL.md, NOA Studio Phase 6). Pure and shared: the Studio and the Live Control Panel (keys while
// the page has focus), the server (POST /api/control {action:'hotkey'} resolves the toggles on the current state) and
// scripts/global-hotkeys.mjs (keys from any app). The map is the operator's (data/hotkeys.json), these are the defaults.
export const HOTKEY_ACTIONS = Object.freeze({
    'voice-toggle': 'AI ⇄ 人間（声）',
    'game-toggle': 'AI ⇄ 人間（ゲーム操作）',
    'listening-toggle': '通話優先 ⇄ コメント優先（通話なしならコメントのON/OFF）',
    mute: 'ノアを黙らせる（MUTE NOA）',
    resume: 'AIが話す（AI RESUME）',
    'take-over': '人間が話す（TAKE OVER）',
    'avatar-toggle': '表情 自動 ⇄ 手動',
});
export const DEFAULT_HOTKEYS = Object.freeze({ F6: 'voice-toggle', F7: 'game-toggle', F8: 'listening-toggle', F9: 'mute', F10: 'resume' });
// Keys a hotkey may use: F1-F19 alone or with modifiers, or a letter/digit with at least one modifier (never a bare
// letter: the Studio has text fields and the global helper would swallow typing).
const KEY = /^((Ctrl|Alt|Shift|Cmd)\+)*(F([1-9]|1[0-9])|[A-Z0-9])$/;

/** A keydown event as a hotkey name: 'F6', 'Ctrl+Shift+M', ... (null for keys a hotkey cannot use). */
export function keyName(e) {
    const base = /^F([1-9]|1[0-9])$/.test(e.key) ? e.key : /^Key[A-Z]$/.test(e.code || '') ? e.code.slice(3) : /^Digit[0-9]$/.test(e.code || '') ? e.code.slice(5) : null;
    if (!base) return null;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Cmd'].filter(Boolean);
    const name = [...mods, base].join('+');
    return validKey(name) ? name : null;
}
export function validKey(name) {
    if (typeof name !== 'string' || !KEY.test(name)) return false;
    const parts = name.split('+'), base = parts.at(-1);
    return /^F/.test(base) || parts.length > 1;
}
/** A saved map, checked: { key: action } with valid keys, known actions, each action once. Throws on anything else. */
export function validHotkeys(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('ショートカットの形が正しくありません。');
    const out = {}, used = new Set();
    for (const [key, action] of Object.entries(map)) {
        if (!validKey(key)) throw new Error(`${key} はショートカットに使えないキーです（F1〜F19、または修飾キー付きの英数字）。`);
        if (!Object.hasOwn(HOTKEY_ACTIONS, action)) throw new Error(`${action} は不明な操作です。`);
        if (used.has(action)) throw new Error(`「${HOTKEY_ACTIONS[action]}」に2つのキーが割り当てられています。`);
        used.add(action); out[key] = action;
    }
    return out;
}
/** F8: partner first <-> comments first in a voice call; without a call, comments on <-> off. */
export const nextListening = mode => mode === 'discord_first' ? 'comments_first' : ['comments_first', 'both', 'discord_only'].includes(mode) ? 'discord_first' : mode === 'muted' ? 'comments' : 'muted';
