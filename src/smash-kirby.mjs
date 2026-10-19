/** Kirby-only recovery planning. No capture, API calls, or device writes on import.
 * Coordinates are stage-normalized, y-up; x/y are conservative fighter bounds.
 * Motion envelopes MUST be measured for the installation before live use.
 */
export const KIRBY = Object.freeze({
  id: 'kirby', maxAirJumps: 5, fps: 60,
  reference: 'https://ultimateframedata.com/kirby',
  // Reference timings, not a physics simulator or measured input latency.
  aerialFrames: Object.freeze({ nair: 52, fair: 47, bair: 40, uair: 35, dair: 54 }),
  dodgeFrames: Object.freeze({ neutral: 62, horizontal: 102, up: 141 }),
});
const modes = new Set(['airborne', 'grounded', 'ledge', 'hitstun', 'dead', 'unknown']);
const kinds = new Set(['drift', 'jump', 'air_dodge', 'attack', 'up_special', 'ledge_option']);
const buttons = new Set(['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const probability = x => finite(x) && x >= 0 && x <= 1;
function need(ok, reason) { if (!ok) throw new TypeError(reason); }
function interval(x) { return Array.isArray(x) && x.length === 2 && x.every(finite) && x[0] <= x[1]; }
function rect(r) { return r && interval(r.x) && interval(r.y); }
const inside = (a, b) => a[0] >= b[0] && a[1] <= b[1];
const contains = (a, b) => inside(a.x, b.x) && inside(a.y, b.y);
const overlaps = (a, b) => a.x[0] <= b.x[1] && b.x[0] <= a.x[1] && a.y[0] <= b.y[1] && b.y[0] <= a.y[1];
const sum = (a, b) => [a[0] + b[0], a[1] + b[1]];
const flip = (a, sign) => sign > 0 ? [...a] : [-a[1], -a[0]];
const hull = (a, b) => ({ x: [Math.min(a.x[0], b.x[0]), Math.max(a.x[1], b.x[1])], y: [Math.min(a.y[0], b.y[0]), Math.max(a.y[1], b.y[1])] });
export const NEUTRAL = Object.freeze({ buttons: Object.freeze([]), lx: 0, ly: 0, rx: 0, ry: 0 });

export function validateCommand(c) {
  need(c && Array.isArray(c.buttons) && c.buttons.every(x => buttons.has(x)) && new Set(c.buttons).size === c.buttons.length, 'invalid buttons');
  for (const k of ['lx', 'ly', 'rx', 'ry']) need(finite(c[k]) && Math.abs(c[k]) <= 1, `invalid ${k}`);
  return c;
}
export function validateObservation(s) {
  need(s?.version === 1 && s.character === 'kirby', 'only Kirby observation v1 is supported');
  for (const k of ['matchId', 'stockId', 'calibrationId', 'gameVersion', 'controllerProfileId']) need(typeof s[k] === 'string' && s[k].length > 0 && s[k].length < 200, `invalid ${k}`);
  need(integer(s.frame) && finite(s.capturedAtMs), 'invalid frame/time');
  need(rect(s.self) && interval(s.self.vx) && interval(s.self.vy), 'invalid self bounds');
  need(modes.has(s.self.mode) && [-1, 1].includes(s.self.facing) && probability(s.self.confidence), 'invalid self state');
  need(interval(s.self.jumps) && s.self.jumps.every(integer) && s.self.jumps[0] >= 0 && s.self.jumps[1] <= 5, 'invalid jump bounds');
  need(['available', 'spent', 'unknown'].includes(s.self.airDodge), 'invalid dodge state');
  need(typeof s.self.actionable === 'boolean', 'actionable must be explicit');
  need(s.stage && typeof s.stage.id === 'string' && rect(s.stage.blast) && finite(s.stage.centerX), 'invalid stage');
  need(Array.isArray(s.stage.solids) && s.stage.solids.every(rect), 'invalid stage solids');
  need(Array.isArray(s.stage.targets) && s.stage.targets.length > 0 && s.stage.targets.length <= 8 && s.stage.targets.every(t => rect(t) && ['ledge', 'landing'].includes(t.kind)), 'invalid recovery targets');
  need(s.threats && integer(s.threats.coverageFrames) && probability(s.threats.confidence) && Array.isArray(s.threats.boxes) && s.threats.boxes.length <= 128, 'invalid threat coverage');
  for (const b of s.threats.boxes) need(rect(b) && integer(b.from) && integer(b.to) && b.to >= b.from, 'invalid threat envelope');
  need(finite(s.inputP95Ms) && s.inputP95Ms >= 0, 'invalid input latency');
  return s;
}
export function validateLibrary(l) {
  need(l?.version === 1 && l.character === 'kirby' && typeof l.id === 'string' && typeof l.stageId === 'string', 'invalid motion library');
  for (const k of ['gameVersion', 'controllerProfileId']) need(typeof l[k] === 'string' && l[k].length > 0, `invalid ${k}`);
  need(['synthetic-test-only', 'measured'].includes(l.source), 'invalid motion provenance');
  need(finite(l.maxObservationAgeMs) && l.maxObservationAgeMs >= 0 && finite(l.maxInputP95Ms) && l.maxInputP95Ms >= 0, 'invalid latency envelope');
  need(Array.isArray(l.samples) && l.samples.length > 0 && l.samples.length <= 128, 'invalid sample count');
  const ids = new Set();
  for (const p of l.samples) {
    need(typeof p.id === 'string' && !ids.has(p.id) && p.id.length <= 80, 'invalid/duplicate sample id'); ids.add(p.id);
    need(kinds.has(p.kind) && modes.has(p.startMode) && modes.has(p.endMode), 'invalid primitive kind/mode');
    need(p.entry && interval(p.entry.vx) && interval(p.entry.vy), 'invalid entry velocity');
    need(p.entry.jumps === undefined || (integer(p.entry.jumps) && p.entry.jumps <= 5), 'invalid jump index');
    need(p.entry.facing === undefined || [-1, 1].includes(p.entry.facing), 'invalid entry facing');
    need(Array.isArray(p.frames) && p.frames.length > 0 && p.frames.length <= 240, 'invalid trajectory length');
    need(Array.isArray(p.input) && p.input.length > 0 && p.input.length <= 16, 'invalid input sequence');
    let duration = 0;
    for (const i of p.input) { need(integer(i.frames) && i.frames > 0, 'invalid input duration'); validateCommand(i); duration += i.frames; }
    need(duration <= p.frames.length, 'input extends beyond measured trajectory');
    for (const f of p.frames) need(interval(f.dx) && interval(f.dy) && interval(f.vx) && interval(f.vy) && typeof f.intangible === 'boolean' && typeof f.canGrabLedge === 'boolean' && typeof f.canLand === 'boolean', 'invalid motion envelope frame');
    // No model-generated claim that an attack can be cancelled before its endlag.
    if (p.kind === 'attack') need(KIRBY.aerialFrames[p.move] !== undefined && p.frames.length >= KIRBY.aerialFrames[p.move], 'attack trace must include full airborne endlag');
    if (p.kind === 'air_dodge') need(KIRBY.dodgeFrames[p.move] !== undefined && p.frames.length >= KIRBY.dodgeFrames[p.move], 'dodge trace must include full airborne endlag');
  }
  return l;
}

/** A lower/upper resource belief, not a button counter. Requests reserve a jump;
 * only unique observed jump events decrease the upper bound. Being hit does not reset it. */
export class KirbyResources {
  constructor() { this.epoch = null; this.jumps = [0, 5]; this.airDodge = 'unknown'; this.pending = new Map(); this.events = new Set(); }
  sync({ matchId, stockId, mode, confirmed = false }) {
    const epoch = JSON.stringify([matchId, stockId]);
    if (epoch !== this.epoch) { this.epoch = epoch; this.jumps = [0, 5]; this.airDodge = 'unknown'; this.pending.clear(); this.events.clear(); }
    // Ledge grabs, hitstun and transport reconnects never silently restore resources.
    if (confirmed && mode === 'grounded') { this.jumps = [5, 5]; this.airDodge = 'available'; this.pending.clear(); }
    return this.snapshot();
  }
  reserve(id, kind) {
    need(typeof id === 'string' && id.length > 0, 'input id required');
    if (this.pending.has(id) || this.events.has(`confirmed:${id}`)) return false;
    if (kind === 'jump') { if (this.jumps[0] < 1) return false; this.jumps[0]--; }
    else if (kind === 'air_dodge') { if (this.airDodge !== 'available') return false; this.airDodge = 'unknown'; }
    else return true;
    this.pending.set(id, kind); return true;
  }
  observe({ id, kind, inputId = null }) {
    need(typeof id === 'string' && id.length > 0, 'event id required');
    if (this.events.has(id) || (inputId && this.events.has(`confirmed:${inputId}`))) return false;
    this.events.add(id);
    const reserved = inputId && this.pending.get(inputId) === kind;
    if (kind === 'jump') {
      this.jumps = [Math.max(0, this.jumps[0] - (reserved ? 0 : 1)), Math.max(0, this.jumps[1] - 1)];
      this.jumps[0] = Math.min(this.jumps[0], this.jumps[1]);
    } else if (kind === 'air_dodge') this.airDodge = 'spent';
    if (inputId) { this.pending.delete(inputId); this.events.add(`confirmed:${inputId}`); }
    return true;
  }
  snapshot() { return { jumps: [...this.jumps], airDodge: this.airDodge }; }
}

function compatible(n, p) {
  return n.mode === p.startMode && inside(n.vx, p.entry.vx) && inside(n.vy, p.entry.vy)
    && (p.entry.facing === undefined || p.entry.facing === n.facing)
    && (p.entry.jumps === undefined || (n.jumps[0] === p.entry.jumps && n.jumps[1] === p.entry.jumps))
    && (p.kind !== 'jump' || n.jumps[0] >= 1)
    && (p.kind !== 'air_dodge' || n.airDodge === 'available');
}
function walk(n, p, s, direction, horizon) {
  let previous = { x: n.x, y: n.y }, hits = n.hits, terminal = null, margin = n.margin;
  const points = [];
  for (let i = 0; i < p.frames.length; i++) {
    const f = p.frames[i], t = n.t + i + 1;
    if (t > horizon || t > s.threats.coverageFrames) return { rejected: 'insufficient_prediction_horizon' };
    const point = { x: sum(n.x, flip(f.dx, direction)), y: sum(n.y, f.dy) }, swept = hull(previous, point);
    if (!contains(swept, s.stage.blast)) return { rejected: 'blast_zone' };
    margin = Math.min(margin, swept.x[0] - s.stage.blast.x[0], s.stage.blast.x[1] - swept.x[1], swept.y[0] - s.stage.blast.y[0], s.stage.blast.y[1] - swept.y[1]);
    if (!f.intangible && s.threats.boxes.some(threat => threat.from <= t && threat.to >= t && overlaps(swept, threat))) hits++;
    if (s.stage.solids.some(r => overlaps(swept, r))) return { rejected: 'stage_collision' };
    // Reaching a goal in the model is not an observed recovery success.
    const goal = s.stage.targets.find(g => ((g.kind === 'ledge' && f.canGrabLedge) || (g.kind === 'landing' && f.canLand)) && contains(point, g));
    if (goal) { terminal = { kind: goal.kind, at: t }; points.push(point); break; }
    points.push(point); previous = point;
  }
  const last = points.at(-1), lastFrame = p.frames[points.length - 1];
  return { x: last.x, y: last.y, vx: lastFrame.vx, vy: lastFrame.vy, facing: n.facing,
    mode: terminal?.kind === 'ledge' ? 'ledge' : terminal ? 'grounded' : p.endMode,
    jumps: n.jumps.map(v => v - (p.kind === 'jump' ? 1 : 0)),
    airDodge: p.kind === 'air_dodge' ? 'spent' : n.airDodge,
    t: n.t + points.length, hits, margin, terminal, path: [...n.path, p.id], kinds: [...n.kinds, p.kind] };
}

/** Search measured motion envelopes; never infer a successful counterhit to erase threats.
 * A counterattack is permitted only if its full endlag still leaves a recovery route.
 * Beam search is bounded and incomplete: no route found != physically impossible. */
export function planKirbyRecovery(input, library, { nowMs = Date.now(), maxDepth = 4, beamWidth = 32, horizonFrames = 180, minConfidence = .95, maxExpansions = 5000 } = {}) {
  const s = validateObservation(input), l = validateLibrary(library);
  need(integer(maxDepth) && maxDepth > 0 && maxDepth <= 8 && integer(beamWidth) && beamWidth > 0 && beamWidth <= 128 && integer(horizonFrames) && horizonFrames > 0 && horizonFrames <= 600 && finite(nowMs) && probability(minConfidence) && integer(maxExpansions) && maxExpansions > 0 && maxExpansions <= 50000, 'invalid planner options');
  const result = { status: 'blocked', character: 'kirby', observationFrame: s.frame, choices: [], selected: null, emergency: null, liveEligible: false, reasons: [], diagnostics: {} };
  if (l.id !== s.calibrationId || l.stageId !== s.stage.id || l.gameVersion !== s.gameVersion || l.controllerProfileId !== s.controllerProfileId) result.reasons.push('calibration_or_stage_mismatch');
  const age = nowMs - s.capturedAtMs;
  if (age < 0 || age > l.maxObservationAgeMs) result.reasons.push('observation_stale_or_clock_mismatch');
  if (s.inputP95Ms > l.maxInputP95Ms) result.reasons.push('latency_outside_calibration');
  if (s.self.confidence < minConfidence || s.threats.confidence < minConfidence) result.reasons.push('uncertain_perception_or_threats');
  if (s.self.mode === 'unknown') result.reasons.push('unknown_self_state');
  if (result.reasons.length) return result;
  if (s.self.mode === 'dead') return { ...result, status: 'dead' };
  if (s.self.mode === 'grounded') return { ...result, status: 'grounded', reasons: ['neutral_combat_not_implemented'] };
  if (!s.self.actionable || s.self.mode === 'hitstun') return { ...result, status: 'locked', reasons: ['await_actionable_observation_no_cancel_assumed'] };
  const direction = (s.self.x[0] + s.self.x[1]) / 2 <= s.stage.centerX ? 1 : -1;
  let beam = [{ ...s.self, vx: flip(s.self.vx, direction), facing: s.self.facing * direction, t: 0, hits: 0, margin: Infinity, terminal: null, path: [], kinds: [] }];
  const goals = [], rejected = {};
  let expansions = 0;
  search: for (let depth = 0; depth < maxDepth && beam.length; depth++) {
    const next = [];
    for (const n of beam) for (const p of l.samples) {
      if (++expansions > maxExpansions) break search;
      if (!compatible(n, p)) continue;
      const r = walk(n, p, s, direction, horizonFrames);
      if (r.rejected) { rejected[r.rejected] = (rejected[r.rejected] || 0) + 1; continue; }
      if (r.terminal) goals.push(r); else next.push(r);
    }
    // Preserve a beam per first action; otherwise cheap drift can erase every evasive route.
    const groups = new Map();
    for (const n of next) { const key = n.path[0]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(n); }
    beam = [...groups.values()].flatMap(g => g.sort((a, b) => a.hits - b.hits || b.margin - a.margin || a.t - b.t).slice(0, beamWidth));
  }
  const compare = (a, b) => a.hits - b.hits || b.margin - a.margin || a.t - b.t || b.jumps[0] - a.jumps[0];
  const unique = new Map();
  for (const g of goals.sort(compare)) if (!unique.has(g.path[0])) unique.set(g.path[0], g);
  const candidates = [...unique.values()];
  const summarize = g => ({ id: g.path[0], path: g.path, kinds: g.kinds, arrivalFrame: g.terminal.at, target: g.terminal.kind,
    threatExposureFrames: g.hits, blastMargin: g.margin, jumpsRemainingLower: g.jumps[0], direction,
    basis: 'measured-envelope-model-not-guarantee' });
  result.choices = candidates.filter(g => g.hits === 0).map(summarize);
  result.selected = result.choices[0] || null;
  result.emergency = candidates.length ? summarize(candidates[0]) : null;
  result.status = result.selected ? 'planned' : 'no_model_safe_route';
  result.diagnostics = { rejected, goalCount: goals.length, expansions: Math.min(expansions, maxExpansions), expansionBudgetReached: expansions > maxExpansions, searchComplete: false };
  result.liveEligible = !!result.selected && l.source === 'measured' && l.approval?.hardwareVerified === true && typeof l.approval?.evidence === 'string' && l.approval.evidence.length > 0;
  if (!result.liveEligible) result.reasons.push('live_not_validated');
  return result;
}

/** Only the first primitive is issued. The continuation is a feasibility witness,
 * NOT a macro queue; perception must authorize the next primitive again. */
export function commandForPlan(plan, library) {
  need(plan?.status === 'planned' && plan.selected, 'no authorized plan');
  const p = library.samples.find(x => x.id === plan.selected.id);
  need(p, 'unknown primitive');
  return { skill: p.id, kind: p.kind, input: p.input.map(c => ({ ...c, buttons: [...c.buttons], lx: c.lx * plan.selected.direction, rx: c.rx * plan.selected.direction })), durationFrames: p.frames.length };
}

/** Terminal evaluation is observation-based. Ledge touch alone is NOT success. */
export class RecoveryOutcome {
  constructor({ stableFrames = 30, maxGapFrames = 3 } = {}) { this.stableFrames = stableFrames; this.maxGapFrames = maxGapFrames; this.reset(); }
  reset() { this.epoch = null; this.start = null; this.last = null; this.status = 'not_started'; }
  observe(s) {
    validateObservation(s);
    const epoch = JSON.stringify([s.matchId, s.stockId]);
    if (this.epoch !== null && this.epoch !== epoch && this.status !== 'recovered') { this.status = 'stock_changed'; return this.status; }
    this.epoch = epoch;
    if (s.self.mode === 'dead') { this.status = 'ko'; this.start = null; return this.status; }
    if (this.last !== null && s.frame <= this.last) return this.status;
    const stable = s.self.mode === 'grounded' && s.self.actionable && s.self.confidence >= .95;
    if (!stable || (this.last !== null && s.frame - this.last > this.maxGapFrames)) this.start = null;
    if (stable) { this.start ??= s.frame; this.status = s.frame - this.start >= this.stableFrames ? 'recovered' : 'landing_unconfirmed'; }
    else this.status = s.self.mode === 'ledge' ? 'ledge_reached' : 'recovering';
    this.last = s.frame; return this.status;
  }
}
