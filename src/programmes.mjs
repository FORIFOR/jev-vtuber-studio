import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sentences } from './director.mjs';
// Programmes (config/programmes.json) are editable from the Studio's settings page without touching the repository:
// an edited programme is saved whole under data/programmes/<id>.json and replaces the built-in one of the same id at
// load. Every save is validated with the same bounds the tests hold the built-ins to (two sentences and 180 characters
// per spoken demo, distinct tasks, ids present), so an edit cannot put the engine in a state the tests never saw.

export const BUILTIN_FILE = resolve(import.meta.dirname, '..', 'config', 'programmes.json');
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/, CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
export const overridesDir = dataDir => join(dataDir, 'programmes');

export const builtinProgrammes = (file = BUILTIN_FILE) => JSON.parse(readFileSync(file, 'utf8'));

/** The built-ins with any valid saved edit in their place; invalid files are left out and named in warnings. */
export function loadProgrammes(dataDir, file = BUILTIN_FILE) {
    const builtin = builtinProgrammes(file), warnings = [], dir = dataDir ? overridesDir(dataDir) : null;
    if (!dir || !existsSync(dir)) return { programmes: builtin, warnings };
    const programmes = builtin.map(p => {
        const path = join(dir, `${p.id}.json`);
        if (!existsSync(path)) return p;
        try {
            const edited = JSON.parse(readFileSync(path, 'utf8')), problems = validateProgramme(edited, p);
            if (problems.length) { warnings.push(`${p.id}: ${problems[0]}`); return p; }
            return { ...edited, custom: true };
        } catch { warnings.push(`${p.id}: 保存した企画を読めません`); return p; }
    });
    for (const name of readdirSync(dir)) if (name.endsWith('.json') && !builtin.some(p => `${p.id}.json` === name)) warnings.push(`${name}: 既定にない企画は読み込みません`);
    return { programmes, warnings };
}

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROL.test(v);
const spoken = (v, max = 180) => text(v, max) && sentences(v).length <= 2;
/** Problems with a programme, in words an operator can act on (empty: valid). `builtin` is the programme it replaces. */
export function validateProgramme(p, builtin = null) {
    const out = [];
    if (!p || typeof p !== 'object' || Array.isArray(p)) return ['企画の形式が違います'];
    if (!ID.test(String(p.id))) out.push('id は英小文字・数字・ハイフンで指定してください');
    if (builtin && p.id !== builtin.id) out.push('id は変えられません');
    if (!text(p.title, 60)) out.push('企画名は1〜60文字');
    if (p.hook !== undefined && !text(p.hook, 200)) out.push('狙い（hook）は1〜200文字');
    if (p.question !== undefined && !text(p.question, 200)) out.push('視聴者への問いは1〜200文字');
    for (const [k, label] of [['openingLine', '最初の挨拶'], ['closingLine', '締めの言葉']]) if (p[k] !== undefined && !spoken(p[k])) out.push(`${label}は2文・180文字以内`);
    if (builtin) for (const k of ['game', 'gameMode']) if ((p[k] ?? null) !== (builtin[k] ?? null)) out.push('ゲームの指定は変えられません');
    if (!Array.isArray(p.cards) || !p.cards.length) return [...out, 'カードが1枚以上必要です'];
    const tasks = new Set(), cardIds = new Set();
    p.cards.forEach((c, i) => {
        const where = `カード${i + 1}`;
        if (!c || typeof c !== 'object' || !text(c.id, 40) || cardIds.has(c.id)) { out.push(`${where}: id が重複または不正`); return; } cardIds.add(c.id);
        if (!text(c.title, 60)) out.push(`${where}: タイトルは1〜60文字`);
        if (!Array.isArray(c.angles) || !c.angles.length || c.angles.some(a => !text(a, 200))) out.push(`${where}: 観点（angles）が必要`);
        if (!Array.isArray(c.beats) || !c.beats.length) { out.push(`${where}: 段階（beats）が1つ以上必要`); return; }
        if (builtin) { const b = builtin.cards.find(x => x.id === c.id); if (!b) out.push(`${where}: 既定にないカード`); else if (b.beats.length !== c.beats.length) out.push(`${where}: 段階の数は変えられません（${b.beats.length}）`); }
        const beatIds = new Set();
        c.beats.forEach((b, j) => {
            const at = `${where} 段階${j + 1}`;
            if (!b || typeof b !== 'object' || !text(b.id, 40) || beatIds.has(b.id)) { out.push(`${at}: id が重複または不正`); return; } beatIds.add(b.id);
            if (!text(b.label, 30)) out.push(`${at}: ラベルは1〜30文字`);
            if (!text(b.task, 400)) out.push(`${at}: 課題（task）は1〜400文字`);
            else if (tasks.has(b.task)) out.push(`${at}: 課題が他の段階と同じです`); else tasks.add(b.task);
            if (!spoken(b.demo)) out.push(`${at}: 見本（demo）は2文・180文字以内`);
            if (b.display !== undefined && !text(b.display, 30)) out.push(`${at}: 画面表示は1〜30文字`);
        });
        if (Array.isArray(c.demo) && c.demo.some(d => !spoken(d))) out.push(`${where}: デモ台詞は各2文・180文字以内`);
    });
    return out;
}

/** The part of a programme the editor shows and may change (the rest, such as beat flags, is kept as built in). */
export function editable(p) {
    return { id: p.id, title: p.title, hook: p.hook ?? '', question: p.question ?? '', openingLine: p.openingLine ?? '', closingLine: p.closingLine ?? '', custom: p.custom === true,
        game: p.game ?? (p.gameMode === 'blocks' ? 'blocks' : null),
        cards: p.cards.map(c => ({ id: c.id, title: c.title, beats: c.beats.map(b => ({ id: b.id, label: b.label, task: b.task, demo: b.demo, display: b.display ?? '', lobby: b.lobby === true, game: b.game === true })) })) };
}

/** The current programme with the editor's fields applied, by card id and beat id (unknown ids are ignored). */
export function applyEdit(current, edit) {
    const str = v => typeof v === 'string' ? v.trim() : undefined;
    const p = structuredClone(current); delete p.custom;
    for (const k of ['title', 'hook', 'question', 'openingLine', 'closingLine']) { const v = str(edit?.[k]); if (v !== undefined) p[k] = v; }
    for (const ec of Array.isArray(edit?.cards) ? edit.cards : []) {
        const c = p.cards.find(x => x.id === ec?.id); if (!c) continue;
        for (const eb of Array.isArray(ec.beats) ? ec.beats : []) {
            const b = c.beats.find(x => x.id === eb?.id); if (!b) continue;
            for (const k of ['label', 'task', 'demo', 'display']) { const v = str(eb[k]); if (v !== undefined) b[k] = v; }
        }
        if (Array.isArray(c.demo)) c.demo = c.beats.filter(b => !b.lobby).map(b => b.demo); // the card's demo list mirrors its beats
    }
    return p;
}

/** Validate and save an edited programme under data/programmes/; returns the problems instead when it is not valid. */
export function saveProgramme(dataDir, programme, builtin) {
    const problems = validateProgramme(programme, builtin);
    if (problems.length) return { saved: false, problems };
    const dir = overridesDir(dataDir); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${programme.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(programme, null, 2) + '\n', { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    return { saved: true, problems: [] };
}
export function resetProgramme(dataDir, id) { if (!ID.test(String(id))) return false; const path = join(overridesDir(dataDir), `${id}.json`); const had = existsSync(path); rmSync(path, { force: true }); return had; }
