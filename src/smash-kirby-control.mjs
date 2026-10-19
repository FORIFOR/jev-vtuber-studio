import { randomUUID } from 'node:crypto';
import { planKirbyRecovery, commandForPlan, validateLibrary, validateObservation, NEUTRAL } from './smash-kirby.mjs';
const epoch = s => JSON.stringify([s.matchId, s.stockId, s.character, s.calibrationId, s.stage.id, s.gameVersion, s.controllerProfileId]);
const validP = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/** Reuse the Studio's metered Jev.ask(state, questions, signal). Never await this
 * on the control loop. A failed, late, expensive or uncertain answer is advisory only. */
export class JevRecoveryAdvisor {
  constructor({ ask, now = Date.now, timeoutMs = 200, ttlMs = 250 } = {}) {
    if (typeof ask !== 'function' || !(timeoutMs > 0) || !(ttlMs > 0)) throw new TypeError('ask and positive time limits required');
    Object.assign(this, { ask, now, timeoutMs, ttlMs }); this.pending = false;
  }
  async request(s, plan) {
    if (this.pending || plan.status !== 'planned' || plan.choices.length < 2) return null;
    this.pending = true;
    const controller = new AbortController(), start = this.now();
    const choices = structuredClone(plan.choices), criteria = Object.fromEntries(choices.map((r, i) => [`r${i}`, {
      firstSkill: r.id, route: r.kinds, target: r.target,
      use: 'All provided candidates have a recovery continuation within the local model. Prefer evasion and preserving recovery resources; counterattack only when its endlag is covered.',
    }]));
    const question = { type: 'choice', instructions: 'Select one already locally checked Kirby recovery route. Do not invent actions, calculate physics, or treat model feasibility as a guarantee. Prioritize survival over damage.', criteria };
    let timer;
    try {
      const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeoutMs); });
      const answer = await Promise.race([Promise.resolve().then(() => this.ask({
        character: 'kirby', mode: s.self.mode, resources: { jumps: s.self.jumps, airDodge: s.self.airDodge },
        candidates: choices.map(r => ({ id: r.id, route: r.kinds, target: r.target })),
      }, { recovery: question }, controller.signal)), timeout]);
      const a = answer?.recovery, keys = Object.keys(criteria);
      if (!a || a.type !== 'choice' || !keys.includes(a.choice) || !validP(a.confidence) || a.confidence < .5) return null;
      if (!a.probabilities || Object.keys(a.probabilities).length !== keys.length || keys.some(k => !validP(a.probabilities[k])) || Math.abs(Object.values(a.probabilities).reduce((x, y) => x + y, 0) - 1) > .015 || a.probabilities[a.choice] < Math.max(...Object.values(a.probabilities))) return null;
      if (this.now() - start >= this.timeoutMs) return null;
      return { skill: choices[Number(a.choice.slice(1))].id, epoch: epoch(s), mode: s.self.mode,
        observedFrame: s.frame, expiresAtMs: start + this.ttlMs, confidence: a.confidence };
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); this.pending = false; }
  }
}

/** A new video frame is allowed; a changed stock/mode or invalid CURRENT route is not. */
export function applyRecoveryAdvice(s, plan, advice, nowMs = Date.now()) {
  if (!advice || nowMs >= advice.expiresAtMs || advice.epoch !== epoch(s) || advice.mode !== s.self.mode || advice.observedFrame > s.frame) return plan;
  const selected = plan.choices.find(r => r.id === advice.skill);
  return selected ? { ...plan, selected, selectionSource: 'jev-advisory-revalidated' } : plan;
}

/** Nonblocking state publisher. send(packet) must only write to a persistent local
 * pipe; it must not do SSH handshakes or network round trips on each game frame.
 * The Pi-side watchdog owns continuous 120 Hz NXBT transmission.
 * Live mode is disabled by default and is NOT enabled by a successful unit test. */
export class KirbyInputExecutor {
  constructor(library, { send = () => {}, now = Date.now, live = false, packetLifetimeMs = 120 } = {}) {
    validateLibrary(library);
    if (typeof send !== 'function' || typeof now !== 'function' || !Number.isFinite(packetLifetimeMs) || packetLifetimeMs < 20 || packetLifetimeMs > 200) throw new TypeError('invalid executor options');
    this.library = structuredClone(library);
    Object.assign(this, { send, now, live, packetLifetimeMs });
    this.session = randomUUID(); this.sequence = 0; this.current = null; this.epoch = null; this.lastFrame = null; this.armed = !live;
  }
  arm() {
    if (this.live && (this.library.source !== 'measured' || this.library.approval?.hardwareVerified !== true || !this.library.approval?.evidence)) throw new Error('Live input requires measured, hardware-verified calibration');
    this.armed = true;
  }
  publish(command, reason) {
    const time = this.now();
    const packet = { version: 1, session: this.session, seq: ++this.sequence, issuedAtMs: time, expiresAtMs: time + this.packetLifetimeMs, command: structuredClone(command) };
    if (this.live) this.send(packet);
    return { packet, dryRun: !this.live, reason };
  }
  stop(reason = 'operator_stop') { this.current = null; this.armed = false; return this.publish(NEUTRAL, reason); }
  tick(s, advice = null) {
    try { validateObservation(s); }
    catch { return this.stop('invalid_observation'); }
    const now = this.now(), identity = epoch(s);
    if (this.epoch !== null && this.epoch !== identity) { this.epoch = identity; this.lastFrame = null; return this.stop('stock_match_or_calibration_changed'); }
    this.epoch = identity;
    if (this.lastFrame !== null && s.frame <= this.lastFrame) return this.stop('duplicate_or_out_of_order_frame');
    this.lastFrame = s.frame;
    if (!this.armed) return this.publish(NEUTRAL, 'disarmed');
    if (now < s.capturedAtMs || now - s.capturedAtMs > this.library.maxObservationAgeMs || s.inputP95Ms > this.library.maxInputP95Ms || s.self.confidence < .95 || s.threats.confidence < .95) return this.stop('stale_uncertain_or_latency_violation');
    if (['dead', 'unknown', 'hitstun', 'grounded'].includes(s.self.mode)) { this.current = null; return this.publish(NEUTRAL, s.self.mode); }
    if (this.current && this.current.mode !== s.self.mode) this.current = null;
    if (this.current) {
      if (now < this.current.start) return this.stop('clock_moved_backwards');
      const elapsed = Math.floor((now - this.current.start) * 60 / 1000);
      if (elapsed < this.current.durationFrames) {
        let offset = 0;
        for (const part of this.current.input) { offset += part.frames; if (elapsed < offset) return this.publish(part, 'executing_measured_skill'); }
        return this.publish(NEUTRAL, 'awaiting_endlag_no_retrigger');
      }
      this.current = null;
    }
    const raw = planKirbyRecovery(s, this.library, { nowMs: now });
    const plan = applyRecoveryAdvice(s, raw, advice, now);
    if (plan.status !== 'planned' || (this.live && !plan.liveEligible)) return { ...this.publish(NEUTRAL, plan.status), plan };
    this.current = { ...commandForPlan(plan, this.library), start: now, mode: s.self.mode };
    return { ...this.publish(this.current.input[0], 'skill_started'), plan, startedSkill: { id: this.current.skill, kind: this.current.kind, inputId: `${this.session}:${this.sequence}` } };
  }
}
