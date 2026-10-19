// Deliberately artificial trajectories. NEVER use these on a console.
import { NEUTRAL } from '../src/smash-kirby.mjs';
export function sample(id = 'jump', kind = 'jump', count = 20, { dx = .5, dy = .6, move, intangible = false } = {}) {
  return { id, kind, move, startMode: 'airborne', endMode: 'airborne', entry: { vx: [-1, 1], vy: [-1, 1] },
    input: [{ ...NEUTRAL, buttons: kind === 'jump' ? ['X'] : kind === 'attack' ? ['A'] : kind === 'air_dodge' ? ['R'] : [], lx: 1, frames: Math.min(2, count) }],
    frames: Array.from({ length: count }, (_, i) => ({ dx: [dx * (i + 1) / count, dx * (i + 1) / count], dy: [dy * (i + 1) / count, dy * (i + 1) / count],
      vx: [0, 0], vy: [0, 0], intangible: intangible && i >= 2 && i < 29, canGrabLedge: i === count - 1, canLand: false })) };
}
export function fixture() {
  const s = { version: 1, character: 'kirby', gameVersion: 'synthetic', controllerProfileId: 'synthetic-standard', matchId: 'test-match', stockId: 'stock-1', frame: 100, capturedAtMs: 1000, calibrationId: 'SYNTHETIC_ONLY', inputP95Ms: 20,
    self: { x: [-1.55, -1.53], y: [-.55, -.53], vx: [0, 0], vy: [0, 0], mode: 'airborne', facing: 1, jumps: [5, 5], airDodge: 'available', actionable: true, confidence: 1 },
    stage: { id: 'SYNTHETIC_STAGE', centerX: 0, blast: { x: [-3, 3], y: [-3, 3] }, solids: [], targets: [
      { kind: 'ledge', x: [-1.08, -.95], y: [-.1, .15] }, { kind: 'ledge', x: [.95, 1.08], y: [-.1, .15] }] },
    threats: { coverageFrames: 240, confidence: 1, boxes: [] } };
  const library = { version: 1, character: 'kirby', gameVersion: 'synthetic', controllerProfileId: 'synthetic-standard', id: 'SYNTHETIC_ONLY', stageId: 'SYNTHETIC_STAGE', source: 'synthetic-test-only', maxObservationAgeMs: 100, maxInputP95Ms: 40,
    samples: [sample(), sample('dodge', 'air_dodge', 62, { move: 'neutral', intangible: true }), sample('bair', 'attack', 40, { move: 'bair' })] };
  return { s, library };
}
