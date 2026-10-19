export const DEFAULT_AVATAR_MODE = 'noa';

export const AVATAR_MODES = Object.freeze([
    { id: 'noa', label: '2D' },
    { id: 'vrm', label: '3D' },
].map(mode => Object.freeze(mode)));

export function isAvatarMode(id) {
    return typeof id === 'string' && AVATAR_MODES.some(mode => mode.id === id);
}
