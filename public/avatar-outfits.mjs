export const DEFAULT_OUTFIT_ID = 'signal-hoodie';

export const OUTFITS = Object.freeze([
    { id: DEFAULT_OUTFIT_ID, label: '白×青パーカー', colors: ['#f5f7ff', '#29476e', '#2b303b'] },
    { id: 'midnight-hoodie', label: 'チャコールパーカー', colors: ['#4b515d', '#8da7be', '#e1e3e6'] },
    { id: 'studio-jacket', label: 'フードなしジャケット', colors: ['#dce5e4', '#496f75', '#283b40'] },
].map(outfit => Object.freeze({ ...outfit, colors: Object.freeze(outfit.colors) })));

export function isOutfitId(id) {
    return typeof id === 'string' && OUTFITS.some(outfit => outfit.id === id);
}
