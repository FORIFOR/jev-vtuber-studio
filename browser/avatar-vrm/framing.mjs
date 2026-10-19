// Noa 4.92 has a 1.12x head (about six heads tall): hair and headset reach about 1.58 m and 0.15 m to each side,
// so the bust shot sits a little higher and wider while keeping the face readable at the same canvas size.
const TOP = 1.68, HEIGHT = .64, WIDTH = .50;

/** Gestures never change the crop: outstretched hands may leave a close-up. */
export function noaCloseupFrame(aspect = 3 / 4) {
    if (!Number.isFinite(aspect) || aspect <= 0) aspect = 3 / 4;
    const height = Math.max(HEIGHT, WIDTH / aspect), width = height * aspect;
    return { centerY: TOP - height / 2, height, left: -width / 2, right: width / 2, top: height / 2, bottom: -height / 2 };
}
