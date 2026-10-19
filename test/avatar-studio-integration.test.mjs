import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = source('public/index.html'), studio = source('public/studio.mjs');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

// These source contracts verify the merged integration, not DOM execution, rendering or OBS output.
function declaration(name) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(studio);
    assert.ok(start, `${name}: named Studio handler`);
    const tail = studio.slice(start.index + start[0].length);
    const next = /\n(?:async function |function |const |let |for \(|if \(|\$\()/.exec(tail);
    return studio.slice(start.index, next ? start.index + start[0].length + next.index : studio.length);
}

function changeHandler(id) {
    const start = studio.indexOf(`$('${id}').addEventListener('change',`);
    assert.ok(start >= 0, `${id}: change handler`);
    const end = studio.indexOf('\n});', start);
    assert.ok(end > start, `${id}: complete change handler`);
    return studio.slice(start, end + 4);
}

test('merged Studio has unique IDs and includes every directly referenced control and label target', () => {
    assert.equal(new Set(ids).size, ids.length, 'duplicate IDs would connect handlers to the wrong control');
    const references = [...studio.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
    assert.ok(references.length > 50, 'inspect actual Studio DOM references');
    for (const id of references) assert.ok(ids.includes(id), `${id}: present in Studio HTML`);
    for (const match of html.matchAll(/\b(?:for|aria-describedby|aria-labelledby)="([^"]+)"/g))
        for (const id of match[1].split(/\s+/)) assert.ok(ids.includes(id), `${id}: accessible label/status target`);
    for (const id of ['avatar-mode-group', 'avatar-mode-options', 'avatar-mode-status', 'outfit-select', 'outfit-status',
        'memory-state', 'say-form', 'say-input', 'say-result', 'twitch', 'stream-target',
        'stream-target-apply', 'stream-target-state', 'go-live', 'live-dialog', 'live-heard', 'live-go',
        'start-game', 'game-kpi', 'performance-link', 'analytics-link']) assert.ok(ids.includes(id), id);
    assert.ok(html.match(/<section\b[^>]*class="[^"]*\bhost-panel\b[^"]*"[^>]*>/), 'host panel remains on the 配信 tab');
    // Avatar mode and wardrobe live in the host panel and are shown only on the 準備 tab (hidden on 配信 by studio.css).
    const host = html.match(/<section\b[^>]*class="[^"]*\bhost-panel\b[^"]*"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    for (const id of ['avatar-mode-options', 'outfit-select']) assert.ok(host.includes(`id="${id}"`), `${id}: in the host panel`);
    assert.match(source('public/studio.css'), /#workspace\[data-workspace-tab=live\] [^{]*\.avatar-settings[^{]*\.wardrobe\{display:none\}/, 'avatar settings hidden on the 配信 tab');
    assert.match(html, /<fieldset\b[^>]*id="avatar-mode-group"[^>]*disabled/);
    assert.match(html, /<select\b[^>]*id="outfit-select"[^>]*disabled/);
});

test('mode and outfit controls save only their own state without resuming preview or starting a show', () => {
    for (const [id, path] of [['avatar-mode-options', '/api/avatar/mode'], ['outfit-select', '/api/avatar/wardrobe']]) {
        const handler = changeHandler(id);
        const endpoints = [...handler.matchAll(/\bapi\('([^']+)'/g)].map(match => match[1]);
        assert.ok(endpoints.length > 0, `${id}: real persistence endpoint`);
        assert.deepEqual([...new Set(endpoints)], [path]);
        assert.doesNotMatch(handler, /\b(?:renderPreview|control|connect|checkDestination)\s*\(|previewPaused\s*=|\.src\s*=|location\./,
            `${id}: saving must not navigate, unpause or start streaming`);
    }
    for (const name of ['avatarDisplayLabel', 'updateAvatarMode', 'renderAvatarMode', 'updateWardrobe', 'renderWardrobe']) {
        assert.doesNotMatch(declaration(name), /\b(?:api|renderPreview|control|connect|checkDestination)\s*\(|previewPaused\s*=|\.src\s*=|location\./,
            `${name}: rendering selection state is read-only outside its own UI/state`);
    }
    assert.match(declaration('updateAvatarMode'), /!authoritative && snapshot\.revision < avatarSelection\.revision/);
    assert.match(declaration('updateWardrobe'), /!authoritative && snapshot\.revision < wardrobe\.revision/);
    assert.match(declaration('renderWardrobe'), /avatarSelection\.mode !== 'vrm'/);
    // There is no in-Studio preview: the labels report what is saved and point at OBS, never a preview state.
    for (const name of ['avatarDisplayLabel', 'renderAvatarMode', 'renderWardrobe', 'renderSponsor'])
        assert.doesNotMatch(declaration(name), /プレビュー(?:表示中|休止中|反映待ち|に表示中)|previewAvatar|contentDocument/, `${name}: no preview state is claimed`);
    assert.match(declaration('renderAvatarMode'), /保存済み（OBSの画面に反映）/);
    assert.match(declaration('renderWardrobe'), /保存済み（OBSの画面に反映）/);
});

test('the Studio page never loads a second copy of the stage (memory while streaming); the stage tab link follows the programme', () => {
    assert.doesNotMatch(html, /<iframe\b[^>]*id="preview"/, 'no stage preview iframe');
    assert.doesNotMatch(studio, /\/stage#token=\$\{view\}&preview=1/, 'no preview navigation');
    assert.doesNotMatch(studio, /previewPaused|renderPreview|previewAvatar/);
    const memory = declaration('renderMemory');
    for (const level of ['normal', 'warning', 'critical', 'unknown']) assert.ok(memory.includes(`${level}:`), level);
    assert.match(studio, /m\.type === 'memory'\) renderMemory\(m\.data\)/);
    assert.match(declaration('connect'), /renderMemory\(session\.memory\)/);
    assert.match(declaration('stageLink'), /chosen\?\.style === 'game' \? '&layout=game' : ''/);
    assert.match(html, /OBSのプレビューで確認/);
});

test('merged Studio keeps operator, destination confirmation, rehearsal and game control integration', () => {
    for (const path of ['/api/operator/say', '/api/obs/destination', '/api/setup/rehearse', '/api/setup/heard', '/api/obs/start'])
        assert.ok(studio.includes(`api('${path}'`), `${path}: existing production integration`);
    assert.match(studio, /if \(!d\.ready\) throw new Error/);
    assert.match(studio, /\/api\/setup\/rehearse', \{ confirm: 'RUN_CHECK' \}/);
    assert.match(studio, /if \(!r\.ok\)[^\n]*return/);
    assert.match(studio, /\/api\/obs\/start', \{ confirm: 'START', target: session\.streamTarget \}/);
    assert.match(studio, /\$\('start-game'\)\.onclick[\s\S]*if \(!confirm\(/);
    assert.match(studio, /action: 'start-game'/);
    for (const event of ['operator', 'game_runner', 'memory', 'avatar_mode', 'wardrobe'])
        assert.ok(studio.includes(`m.type === '${event}'`), `${event}: event handler retained`);
    assert.match(studio, /if \(session\?\.vtsEnabled\)[^\n]*OBSは外部アバター設定/);
});
