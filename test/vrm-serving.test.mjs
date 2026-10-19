import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VRM_ASSET_PATHS, vrmAssetType } from '../src/vrm-assets.mjs';
import { createApp } from '../src/server.mjs';
import { setup } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bytes = path => readFileSync(resolve(root, path));
const source = path => bytes(path).toString('utf8');
const json = path => JSON.parse(bytes(path));
const hash = data => createHash('sha256').update(data).digest('hex');

test('served stage permits embedded VRM texture fetches without permitting external connections or scripts', async t => {
    const c = setup(t);
    const app = createApp(c, { remoteOptions: false });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => app.close());
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/stage.html`);
    assert.equal(response.status, 200);
    const directives = new Map(response.headers.get('content-security-policy').split(';')
        .filter(value => value.trim()).map(value => {
            const [name, ...values] = value.trim().split(/\s+/);
            return [name, values];
        }));
    assert.deepEqual(directives.get('connect-src'), ["'self'", 'blob:']);
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.equal(app.engine.running, false);
    await response.arrayBuffer();
});

const vrmShipped = existsSync(new URL('../public/models/noa3d/Noa.vrm', import.meta.url));
test('VRM serving allowlist names every shipped model, motion and notice, with exact MIME types', { skip: !vrmShipped && 'Noa.vrm is not in this checkout (the public repository leaves it out; docs/ASSETS.md)' }, () => {
    const files = readdirSync(resolve(root, 'public/models/noa3d'), { recursive: true })
        .map(path => `models/noa3d/${path}`)
        .filter(path => statSync(resolve(root, 'public', path)).isFile())
        .map(path => `/${path}`).sort();
    assert.deepEqual([...VRM_ASSET_PATHS].sort(), files);
    assert.equal(new Set(VRM_ASSET_PATHS).size, VRM_ASSET_PATHS.length);
    assert.ok(Object.isFrozen(VRM_ASSET_PATHS));
    for (const path of files) {
        const expected = path.endsWith('.json') ? 'application/json; charset=utf-8'
            : path.endsWith('.md') ? 'text/plain; charset=utf-8' : 'model/gltf-binary';
        assert.equal(vrmAssetType(path), expected);
        assert.ok(bytes(`public${path}`).length > 0);
    }
});

test('the asset gate rejects neighboring, transformed and non-file paths', () => {
    for (const path of VRM_ASSET_PATHS) {
        for (const denied of [path.toUpperCase(), `${path}/`, `${path}.bak`, `${path}?download=1`, `${path}\0`, path.replace('/noa3d/', '/noa3d/../'), path.replace('/noa3d/', '/noa3d/%2e%2e/')])
            assert.equal(vrmAssetType(denied), null, denied);
    }
    for (const denied of ['/models/noa3d/', '/models/noa3d', '/models/noa3d/.env', '/models/noa3d/../../data/settings.json', '/models/noa3d/manifest.json/../Noa.vrm', '/models/noa3d/motions/', '/models/noa/Noa.vrm'])
        assert.equal(vrmAssetType(denied), null, denied);
    const server = source('src/server.mjs');
    assert.ok(server.indexOf("if (req.method !== 'GET')") < server.indexOf('await serveVrmAsset('), 'existing method gate precedes VRM asset serving');
    assert.match(server, /img-src 'self' data: blob:;/);
    assert.match(server, /script-src 'self';/);
    assert.match(server, /connect-src 'self' blob:;/);
    const handler = source('src/vrm-assets.mjs');
    assert.match(handler, /pipeline\(createReadStream\(file\), res\)/);
    assert.ok(!handler.includes('readFileSync'), 'large model serving does not synchronously read the full file');
});

test('the committed VRM bundle matches its build record and every recorded project source', () => {
    const record = json('licenses/noa-vrm-build.json');
    assert.equal(record.bundle.file, 'public/noa-vrm-avatar.mjs');
    const bundle = bytes(record.bundle.file);
    assert.equal(bundle.length, record.bundle.bytes);
    assert.equal(hash(bundle), record.bundle.sha256);
    assert.deepEqual(record.dependencies, { three: '0.186.1', '@pixiv/three-vrm': '3.5.5', '@pixiv/three-vrm-animation': '3.5.5', esbuild: '0.28.2' });
    assert.ok(Object.keys(record.sources).length >= 4);
    assert.ok(record.sources['browser/avatar-vrm/noa-vrm-avatar.mjs']);
    assert.ok(record.sources['browser/avatar-vrm/controls.mjs']);
    assert.ok(record.sources['public/avatar-rig.mjs']);
    for (const [path, expected] of Object.entries(record.sources)) {
        assert.equal(relative(root, resolve(root, path)).replaceAll('\\', '/'), path, 'build record uses contained, relative paths'); // Windows separators
        assert.ok(!path.includes('node_modules'));
        assert.equal(hash(bytes(path)), expected, `${path} must be rebuilt after changes`);
    }
    for (const path of ['licenses/three-MIT.txt', 'licenses/three-vrm-MIT.txt', 'licenses/three-vrm-animation-MIT.txt'])
        assert.match(source(path), /Permission is hereby granted/);
    const pkg = json('package.json');
    assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'the server retains zero required npm dependencies');
    for (const directory of ['browser/', 'public/', 'licenses/']) assert.ok(pkg.files.includes(directory), `${directory} included in release`);
});

test('the stage connects shared avatar selection, timed reaction state, mouth data, stop and fallback', () => {
    const stage = source('public/stage.mjs');
    assert.match(stage, /import \{ DEFAULT_AVATAR_MODE, isAvatarMode \} from '\.\/avatar-modes\.mjs'/);
    assert.match(stage, /requestedAvatarMode = urlAvatarMode \|\| DEFAULT_AVATAR_MODE/);
    assert.match(stage, /import\('\.\/noa-vrm-avatar\.mjs'\)/);
    assert.match(stage, /new NoaVrmAvatar\(\$\('noa-vrm'\), \{ reducedMotion \}\)/);
    assert.match(stage, /\['noa', 'vrm'\]\.includes\(avatarMode\) \? avatarExtras\(now, level\)/);
    assert.match(stage, /start: avatar\.reaction\.start/);
    assert.match(stage, /weight: avatar\.weight\(now\)/);
    assert.match(stage, /role: current\?\.role \|\| speakingRole/);
    assert.match(stage, /vis: lip\.sample\(audioContext\?\.currentTime\)/);
    assert.match(stage, /function cancel\(\) \{ renderEpoch\+\+; lip\.reset\(\); vrmAvatar\?\.stop\(avatar\.reaction\)/);
    assert.match(stage, /candidate\.dispose\(\)/);
    assert.match(stage, /webglcontextlost/);
    assert.match(stage, /await loadLayerAvatar\(\)/);
    assert.match(stage, /showAvatar\('noa', 'fallback'\)/);
    assert.match(source('public/stage.html'), /<canvas id="noa-vrm" width="900" height="1200"[^>]*hidden/);
    const css = source('public/stage.css');
    assert.match(css, /#noa-vrm\{[^}]*aspect-ratio:3\/4/);
    assert.match(css, /body\.vrm\.vertical #canvas\.blocks-mode \.avatar/);
});

// Static integration contracts only: these checks do not claim browser lifecycle or visual verification.
test('renderer selection is isolated from audio and guards cached asynchronous activation', () => {
    const stage = source('public/stage.mjs');
    const declaration = name => {
        const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(stage);
        assert.ok(match, `${name}: top-level stage handler`);
        const tail = stage.slice(match.index + match[0].length);
        const next = /\n(?:async function |function |const |let |if |addEventListener\(|vrmCanvas\.)/.exec(tail);
        return stage.slice(match.index, next ? match.index + match[0].length + next.index : stage.length);
    };
    assert.match(stage, /\['vrm', 'noa', 'builtin', 'png', 'external'\]\.includes\(params\.get\('avatar'\)\)/);
    assert.match(stage, /params\.get\('renderer'\) === 'v3' \? 'noa' : null/);
    assert.match(declaration('applyAvatarMode'), /if \(urlAvatarMode \|\| stageDisposed/);
    assert.match(stage, /m\.type === 'avatar_mode'\) applyAvatarMode\(d\)/);
    assert.match(stage, /stream\.onopen[^\n]*avatarModeRevision = -1/);
    assert.match(stage, /if \(urlAvatarMode \|\| !token\) void selectAvatarMode\(requestedAvatarMode\)/,
        'authenticated shared views wait for the saved mode instead of preloading 3D');
    assert.match(declaration('applyAvatarMode'), /if \(avatarSelectionStarted && requestedAvatarMode/);
    const select = declaration('selectAvatarMode');
    assert.match(select, /epoch = \+\+avatarEpoch/);
    assert.match(select, /if \(stageDisposed \|\| epoch !== avatarEpoch\) return/);
    assert.match(select, /await loadVrmAvatar\(\)/);
    assert.match(select, /await loadLayerAvatar\(\)/);
    assert.match(declaration('loadLayerAvatar'), /if \(layerLoading\) return layerLoading/);
    assert.match(declaration('loadLayerAvatar'), /layerAvatar !== candidate/);
    assert.match(declaration('loadVrmAvatar'), /if \(vrmLoading\) return vrmLoading/);
    assert.match(declaration('loadVrmAvatar'), /vrmAvatar !== candidate/);
    for (const name of ['selectAvatarMode', 'showAvatar', 'applyAvatarMode', 'loadLayerAvatar', 'loadVrmAvatar']) {
        assert.doesNotMatch(declaration(name), /\b(?:cancel|claim|startSpeech)\s*\(|\b(?:audioContext|speechSynthesis|renderEpoch)\b|location\.(?:reload|assign|href)/,
            `${name}: renderer changes must not restart speech or navigate`);
    }
    const invalidate = declaration('invalidateVrm');
    const detach = invalidate.indexOf("removeEventListener('webglcontextlost'"), dispose = invalidate.indexOf('candidate.dispose()');
    assert.ok(detach >= 0 && dispose > detach,
        'intentional disposal removes the stage context-loss handler first');
    assert.match(declaration('loadVrmAvatar'), /vrmCanvas\.cloneNode\(false\)/);
    assert.match(declaration('loadVrmAvatar'), /candidate\.setOutfit\(outfitId\)/);
    assert.match(declaration('showAvatar'), /if \(entering\) vrmAvatar\.resume\(avatar\.reaction\)/);
    assert.match(declaration('showAvatar'), /nextMode === 'noa' && entering/);
    assert.match(declaration('showAvatar'), /layerAvatar\.resume\?\.\(\)/);
    assert.match(declaration('act'), /if \(avatarMode === 'noa' && layerAvatar\?\.kick\)/,
        'hidden 2D renderers do not accumulate reaction impulses');
    assert.match(declaration('applyWardrobe'), /vrmAvatar\?\.setOutfit\(outfitId\)/);
    assert.doesNotMatch(declaration('applyWardrobe'), /if \(avatarMode !== 'vrm'\) return/,
        'cached 3D wardrobe remains current while 2D is active');
});

test('shared avatar selection preserves the release game stage and its capture geometry', () => {
    const stage = source('public/stage.mjs'), html = source('public/stage.html'), css = source('public/stage.css');
    assert.match(stage, /const overlay = params\.get\('layout'\) === 'overlay'/);
    assert.match(stage, /const gameFrame = params\.get\('layout'\) === 'game'/);
    // The opening talk, the goodbye and a stopped show centre Noa (the server hides the OBS game capture for all three).
    assert.match(stage, /const talk = v\?\.phase === 'lobby' \|\| audienceState\.farewell\?\.step >= 1 \|\| audienceState\.running === false;\s+document\.body\.classList\.toggle\('lobby', talk\)/);
    assert.match(stage, /gameShowKey = d\.gameShow\?\.external \? d\.gameShow\.statusKey : null/);
    assert.match(stage, /if \(gameShowKey && m\.type === gameShowKey\)/);
    assert.match(stage, /if \(!text \|\| params\.get\('simulcast'\) === '1'\) return/);
    assert.match(stage, /params\.get\('simulcast'\) === '1' && \['comment', 'narrator'\]\.includes\(d\.role\)/);
    assert.match(stage, /if \(m\.type === 'reflex' && d\.source === 'comment'\) commentSE\(d\.reaction\)/);
    // PR #7 moved the personal best from the HUD (vs-best) into the participation goal card (participation-view.mjs).
    for (const id of ['noa-layers', 'noa-vrm', 'vs-frame', 'vs-hud', 'vs-run', 'ai-playing'])
        assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} remains present exactly once`);
    assert.match(css, /body\.game-frame\.lobby \.vs-frame,body\.game-frame\.lobby \.ai-playing/);
    assert.match(css, /:root:has\(body\.overlay\),body\.overlay,body\.overlay #canvas\{background:transparent\}/);

    // Numeric stylesheet contracts, not a browser rendering or collision test.
    const rule = selector => {
        const index = css.indexOf(`${selector}{`);
        assert.ok(index >= 0, selector);
        return css.slice(index + selector.length + 1, css.indexOf('}', index));
    };
    const px = (declarations, property) => Number(new RegExp(`(?:^|;)${property}:([0-9.]+)px(?:;|$)`).exec(declarations)?.[1]);
    const capture = rule('.vs-frame');
    assert.deepEqual(['left', 'top', 'width', 'height'].map(p => px(capture, p)), [48, 120, 1120, 630]);
    const dimensions = /<canvas id="noa-vrm" width="(\d+)" height="(\d+)"/.exec(html);
    const aspect = Number(dimensions[1]) / Number(dimensions[2]);
    for (const layout of ['game-frame', 'overlay']) {
        const declarations = rule(`body.vrm.${layout} #canvas .avatar`);
        const [left, top, width] = ['left', 'top', 'width'].map(p => px(declarations, p));
        assert.ok([left, top, width].every(Number.isFinite));
        assert.ok(left >= 0 && top >= 0 && left + width <= 1920 && top + width / aspect <= 1080, `${layout}: 3:4 canvas fits the output`);
        if (layout === 'game-frame') {
            const zoomLeft = left - width * .04;
            assert.ok(zoomLeft > px(capture, 'left') + px(capture, 'width'), 'game capture stays clear even during 1.08x face zoom');
        }
    }
    const lobby = rule('body.vrm.game-frame.lobby #canvas .avatar');
    assert.equal(px(lobby, 'left') + px(lobby, 'width') / 2, 960, 'opening talk centers the VRM without changing its selected mode');
    assert.doesNotMatch(source('src/obs.mjs'), /avatar=vrm/, 'OBS follows the selected shared mode rather than pinning 3D');
});
