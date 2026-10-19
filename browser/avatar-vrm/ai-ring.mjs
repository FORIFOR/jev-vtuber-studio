import { clamp } from './controls.mjs';

// The headset's glowing ring is Noa's AI status light (4.91 model, material "Noa Reference AI ring"). It follows the
// stage's `led` signal: the voice level while she speaks, a slow breath while idle. Listening and thinking hold a
// steady mid glow so the ring reads as "attending" rather than "talking".
export const AI_RING_MATERIAL = /^Noa Reference AI ring( \(Outline\))?$/;
export function aiRingIntensity(extras = {}) {
    const led = clamp(extras.led, 0, 1, .3);
    if (!extras.speaking && ['thinking', 'listen'].includes(extras.reaction?.name)) return .9;
    return .35 + 1.3 * led;
}
