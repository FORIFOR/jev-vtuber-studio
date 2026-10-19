// Public, deliberately small projection of the Vampire controller's applied Jev judgment.
// Probabilities are the candidate distribution, not survival odds or confidence. Names are
// the game's known Japanese names; arbitrary log/model/menu text never crosses this boundary.
export const DECISION_TTL_MS = 2000;
const DIRECTIONS = Object.freeze({ north: '上へ移動', northeast: '右上へ移動', east: '右へ移動', southeast: '右下へ移動',
    south: '下へ移動', southwest: '左下へ移動', west: '左へ移動', northwest: '左上へ移動', stay: 'その場に留まる' });
const ITEMS = new Set(['ニンニク', '王の聖書', '魔法の杖', '聖水', '雷の指輪', '鞭', 'ナイフ', '斧', '十字架', 'ファイア・ワンド', '炎の杖', '月桂樹',
    '命のトマト', '封魔の書', '白紙の学術書', '引き寄せのオーブ', '複写の輪', '空っぽの心臓', '腕当て', '燭台', '四つ葉のクローバー', 'ほうれん草',
    '鎧', '翼', '王冠', '石の仮面', '呪いの指輪', '魂食らい', '不浄の典礼', '聖なる杖', '生命の水', '雷鳴の指輪']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v, lo = 0, hi = 604800000) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const integer = (v, lo = 0) => Number.isSafeInteger(v) && v >= lo;
const runName = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(v);
// The controller's purpose-labelled early actions (jev-vampire-survivors vampire_agent/actions.py): fixed wording only.
const ACTIONS = Object.freeze({ maintain_attack: '攻撃位置を保つ', approach_enemy: '敵に近づく', align_enemy: '攻撃位置を合わせる',
    dodge_keep_target: 'よけて狙い続ける', collect_gem: '経験値を拾う', relocate_open_area: '場所を変える', escape_contact: '接触から離れる' });
const actionLabel = id => { const m = /^([a-z_]+?)(?:_[AB])?$/.exec(id); return m && Object.hasOwn(ACTIONS, m[1]) ? ACTIONS[m[1]] : null; };
function label(phase, id, name) {
    if (phase === 'combat') return Object.hasOwn(DIRECTIONS, id) ? DIRECTIONS[id] : actionLabel(id);
    if (phase !== 'levelup') return null;
    if (id === 'reroll') return name === 'リロール' ? name : null;
    return /^select:[0-9]{1,2}$/.test(id) && ITEMS.has(name) ? name : null;
}

/** Rebuild a DTO at the public event boundary; unknown fields are never copied. */
export function publicGameDecision(d, now = Date.now()) {
    if (!object(d) || d.version !== 1 || d.applied !== true || !runName(d.runId) || !integer(d.attempt, 1) || !integer(d.sequence)
        || !['combat', 'levelup'].includes(d.phase) || d.id !== `${d.runId}:${d.sequence}:${d.attempt}`
        || !finite(d.recordedAt, 1, Number.MAX_SAFE_INTEGER) || d.recordedAt > now + 100 || now - d.recordedAt >= DECISION_TTL_MS
        || d.expiresAt !== d.recordedAt + DECISION_TTL_MS || d.expiresAt <= now) return null;
    const t = d.timing;
    if (!object(t) || t.source !== 'log_mtime' || !finite(t.observationElapsedMs) || !finite(t.decisionStartedMs)
        || !finite(t.recordElapsedMs) || t.recordElapsedMs < t.decisionStartedMs || !finite(t.latencyMs, 0, 120000)) return null;
    if (d.hpPercent !== null && !finite(d.hpPercent, 0, 100)) return null;
    if (!object(d.choice) || typeof d.choice.id !== 'string' || typeof d.choice.label !== 'string' || d.choice.label !== label(d.phase, d.choice.id, d.choice.label)
        || !Array.isArray(d.candidates) || d.candidates.length < 1 || d.candidates.length > 3) return null;
    const candidates = [], seen = new Set(); let previous = Infinity;
    for (const c of d.candidates) {
        if (!object(c) || typeof c.id !== 'string' || typeof c.label !== 'string' || seen.has(c.id) || c.label !== label(d.phase, c.id, c.label)
            || !finite(c.probability, 0, 1) || c.probability > previous) return null;
        seen.add(c.id); previous = c.probability;
        candidates.push({ id: c.id, label: c.label, probability: c.probability });
    }
    if (candidates[0].id !== d.choice.id) return null;
    return { version: 1, id: d.id, runId: d.runId, attempt: d.attempt, sequence: d.sequence, phase: d.phase, applied: true,
        choice: { id: d.choice.id, label: d.choice.label }, candidates, hpPercent: d.hpPercent,
        recordedAt: d.recordedAt, expiresAt: d.expiresAt,
        timing: { observationElapsedMs: t.observationElapsedMs, decisionStartedMs: t.decisionStartedMs,
            recordElapsedMs: t.recordElapsedMs, latencyMs: t.latencyMs, source: 'log_mtime' } };
}

/** `recordedAt` is a conservative log-mtime estimate, not an instrumented action timestamp. */
export function sanitizeGameDecision(rec, { runId, recordedAt, now = Date.now() } = {}) {
    if (!object(rec) || rec.event !== 'decision' || rec.applied !== true || rec.synthetic === true || rec.reason || rec.error
        || !['combat', 'levelup'].includes(rec.phase) || !object(rec.state) || rec.state.game !== 'vampire_survivors'
        || rec.state.protocol !== 1 || rec.state.phase !== rec.phase || !integer(rec.state.seq) || !integer(rec.attempt, 1)
        || !object(rec.judgment) || !object(rec.candidates) || !object(rec.judgment.probabilities)
        || typeof rec.choice !== 'string' || rec.judgment.choice !== rec.choice) return null;
    const ids = Object.keys(rec.candidates), ps = rec.judgment.probabilities;
    if (!ids.length || ids.length > 16 || Object.keys(ps).length !== ids.length || !ids.includes(rec.choice)) return null;
    let sum = 0; const candidates = [];
    for (const id of ids) {
        const name = label(rec.phase, id, rec.candidates[id]?.name), p = ps[id];
        if (!name || !Object.hasOwn(ps, id) || !finite(p, 0, 1)) return null;
        sum += p; candidates.push({ id, label: name, probability: p });
    }
    // Match the controller parser's tolerance for distributions rounded to hundredths.
    const rounded = candidates.every(c => Math.abs(c.probability * 100 - Math.round(c.probability * 100)) < 1e-6);
    if (Math.abs(sum - 1) > (rounded ? Math.min(.05, .005 * ids.length) : .001) + 1e-9) return null;
    const chosen = candidates.find(c => c.id === rec.choice), max = Math.max(...candidates.map(c => c.probability));
    if (chosen.probability < max - 1e-6) return null;
    candidates.sort((a, b) => b.probability - a.probability || (a.id === rec.choice ? -1 : b.id === rec.choice ? 1 : a.id.localeCompare(b.id)));
    const p = rec.state.player, hpPercent = finite(p?.hp, 0, 1e6) && finite(p?.max_hp, 1e-9, 1e6) && p.hp <= p.max_hp
        ? Math.round(100 * p.hp / p.max_hp) : null;
    return publicGameDecision({ version: 1, id: `${runId}:${rec.state.seq}:${rec.attempt}`, runId, attempt: rec.attempt,
        sequence: rec.state.seq, phase: rec.phase, applied: true, choice: { id: chosen.id, label: chosen.label }, candidates: candidates.slice(0, 3), hpPercent,
        recordedAt, expiresAt: recordedAt + DECISION_TTL_MS,
        timing: { observationElapsedMs: rec.observation_elapsed_ms, decisionStartedMs: rec.decision_started_ms,
            recordElapsedMs: rec.elapsed_ms, latencyMs: rec.judgment.latency_ms, source: 'log_mtime' } }, now);
}

// Always-on action log (stage .action-log): each applied command of a Vampire run, with a reason derived here from the
// controller's own logged candidate facts in the local chooser's order (jev-vampire-survivors vampire_agent/local_chooser.py).
// Only fixed wording, known item names and small integers cross this boundary.
export const ACTION_LOG_SIZE = 5;
const REASONS = Object.freeze({ escape: '包囲から脱出', chest_gap: '宝箱へ（すき間）', gem_gap: '宝石へ（すき間）', heal: '回復アイテムへ',
    chest: '宝箱へ', big_gem: '大きな宝石へ', magnet: '宝石を拾う', field: '宝石の山へ', gem: '近くの宝石へ', open: '空いている方へ' });
const ARROWS = Object.freeze({ north: '↑', northeast: '↗', east: '→', southeast: '↘', south: '↓', southwest: '↙', west: '←', northwest: '↖', stay: '・' });
const ACTION_ITEMS = new Set([...ITEMS, 'ロウソク', '命の器', 'クローバー', '軌跡の魔弾', '純白の鳩', '時止めのナイフ', 'リロール']);
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
function moveReason(choice, cands) {
    const c = cands[choice], safe = Object.values(cands).filter(v => object(v) && v.meets_clearance_margin === true);
    if (!safe.length) return 'escape';
    if (c.meets_clearance_margin !== true) return num(c.chest_progress) > 0 ? 'chest_gap' : 'gem_gap';
    if (num(c.healing_progress) > .05 && num(c.chest_progress) <= 0) return 'heal';
    if (num(c.chest_progress) > 0) return 'chest';
    if (num(c.big_xp_progress) > .05) return 'big_gem';
    if (num(c.xp_pickups_in_magnet_path) > 0) return 'magnet';
    if (num(c.gem_field_progress) > .05) return 'field';
    if (num(c.experience_progress) > .05) return 'gem';
    return 'open';
}
/** One applied command from a decisions.jsonl record, or null. */
export function gameAction(rec) {
    if (!object(rec) || rec.event !== 'decision' || rec.applied !== true || !object(rec.state) || rec.state.game !== 'vampire_survivors'
        || !integer(rec.state.seq) || !object(rec.candidates) || typeof rec.choice !== 'string' || !Object.hasOwn(rec.candidates, rec.choice)) return null;
    const t = Math.floor(num(rec.state.elapsed));
    if (t < 0 || t > 86400) return null;
    const c = rec.candidates[rec.choice];
    if (rec.phase === 'levelup') {
        const name = object(c) && typeof c.name === 'string' && ACTION_ITEMS.has(c.name) ? c.name : null;
        const level = object(c) && integer(c.next_level, 1) && c.next_level <= 8 ? c.next_level : null;
        return name ? { seq: rec.state.seq, t, kind: 'levelup', name, level } : null;
    }
    if (rec.phase !== 'combat' || !object(c)) return null;
    if (Object.hasOwn(ARROWS, rec.choice)) return { seq: rec.state.seq, t, kind: 'move', dir: rec.choice, reason: moveReason(rec.choice, rec.candidates) };
    const purpose = actionLabel(rec.choice);
    return purpose ? { seq: rec.state.seq, t, kind: 'purpose', text: purpose } : null;
}
/** Rebuild an action at the public event boundary: the stage only ever receives these fields and wordings. */
export function publicGameAction(a) {
    if (!object(a) || !integer(a.seq) || !integer(a.t) || a.t > 86400) return null;
    if (a.kind === 'move' && Object.hasOwn(ARROWS, a.dir) && Object.hasOwn(REASONS, a.reason))
        return { seq: a.seq, t: a.t, kind: 'move', arrow: ARROWS[a.dir], text: REASONS[a.reason] };
    if (a.kind === 'levelup' && ACTION_ITEMS.has(a.name) && (a.level === null || integer(a.level, 1) && a.level <= 8))
        return { seq: a.seq, t: a.t, kind: 'levelup', arrow: '★', text: a.level ? `${a.name} Lv${a.level}` : a.name };
    if (a.kind === 'purpose' && Object.values(ACTIONS).includes(a.text)) return { seq: a.seq, t: a.t, kind: 'move', arrow: '・', text: a.text };
    return null;
}
