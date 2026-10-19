import test from 'node:test';
import assert from 'node:assert/strict';
import { listGames, loadGame } from '../src/games.mjs';
import { OBS } from '../src/obs.mjs';
import { GAME_LAYOUTS, effectiveGameLayout, layoutBoxes } from '../public/stage-theme.mjs';

// Operator 2026-10-19: a layout made around one game's HUD (Vampire's top strip) must not cover another's (Smash's
// damage and stocks along the bottom). Each game says where its HUD is (games/<id>/game.json stage.hud, fractions of
// the game picture) and which layout it airs in (stage.layout); no overlay of that layout may cover the HUD.
const overlaps = ([a, b, c, d], [e, f, g, k]) => a < e + g && e < a + c && b < f + k && f < b + d;
// Noa's figure inside her mostly transparent 3:4 canvas (public/models/noa/model.json: x 245-1137 from y 72, of 1200).
const figure = ([x, y, w]) => { const s = w / 1200; return [x + 245 * s, y + 72 * s, (1137 - 245) * s, 1080 - (y + 72 * s)]; };

/** Every box a layout puts on screen for a game (1920x1080), by name. */
function overlaysOf(layout, game) {
    const B = layoutBoxes(layout), out = {};
    for (const [k, v] of Object.entries(B)) if (k !== 'game') out[k] = k === 'avatar' ? figure(v) : v;
    const obs = new OBS({ stageTheme: 'room', roomGameLayout: layout, game: { ...game, stage: undefined } });
    const spot = s => [s.transform.positionX, s.transform.positionY, s.size.width, s.size.height];
    out.chatSource = spot(obs.gameChatSpot());
    if (game.player !== 'operator') out.commandsSource = spot(obs.gameActionsSpot()); // a person's game has no commands strip
    return out;
}
const hudOf = (layout, game) => { const [gx, gy, gw, gh] = layoutBoxes(layout).game; return game.stage.hud.map(([x, y, w, h]) => [gx + x * gw, gy + y * gh, w * gw, h * gh]); };
const covering = (layout, game) => Object.entries(overlaysOf(layout, game)).filter(([, box]) => hudOf(layout, game).some(h => overlaps(box, h))).map(([k]) => k);

test('every game with a HUD airs in a layout that keeps clear of it', () => {
    const games = listGames().map(id => loadGame(id)).filter(g => g.stage?.hud);
    assert.ok(games.length >= 2, 'Vampire Survivors and Smash declare their HUD');
    for (const g of games) {
        const layout = effectiveGameLayout('side', g);
        assert.deepEqual(covering(layout, g), [], `${g.id} in ${layout}`);
    }
});

test('the layout a game names wins over the setting; without one the setting applies', () => {
    const vampire = loadGame('vampire-survivors'), smash = loadGame('smash-ultimate');
    assert.equal(effectiveGameLayout('full', vampire), vampire.stage.layout);
    assert.equal(effectiveGameLayout('frame', smash), 'wide', 'Smash stays in the layout that keeps its damage readable');
    assert.equal(effectiveGameLayout('front', { id: 'x' }), 'front');
    assert.equal(effectiveGameLayout('bogus', null), 'side');
    for (const l of GAME_LAYOUTS) assert.ok(layoutBoxes(l)?.game, l);
});

test('the layouts that would cover Smash damage are the ones with overlays low over the picture (documented, not used)', () => {
    const smash = loadGame('smash-ultimate'), vampire = loadGame('vampire-survivors');
    const report = Object.fromEntries(GAME_LAYOUTS.map(l => [l, covering(l, smash)]));
    assert.deepEqual(report.side, []);
    assert.deepEqual(report.wide, [], 'wide (operator 2026-10-19, 没入型): nothing over the picture');
    for (const l of ['front', 'full', 'frame']) assert.ok(report[l].length > 0, `${l} would cover Smash's HUD: ${report[l]}`);
    assert.deepEqual(covering('frame', vampire), [], 'Vampire in its frame layout');
});

test('a manifest stage block is validated', () => {
    const bad = [{ layout: 'huge' }, { hud: [[0, 0, 1.2, .1]] }, { hud: [[.5, 0, .6, .1]] }, { hud: 'top' }];
    // loadGame reads from disk; the same checks run on a parsed manifest through a temp games dir.
    return import('node:fs').then(async ({ mkdtempSync, mkdirSync, writeFileSync, rmSync }) => {
        const { tmpdir } = await import('node:os'), { join } = await import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'jvs-games-'));
        try {
            for (const [i, stage] of bad.entries()) {
                const id = `g${i}`; mkdirSync(join(dir, id));
                writeFileSync(join(dir, id, 'game.json'), JSON.stringify({ id, title: 'G', show: 'show.mjs', player: 'operator', stage }));
                assert.throws(() => loadGame(id, dir), /stage/, JSON.stringify(stage));
            }
            mkdirSync(join(dir, 'ok'));
            writeFileSync(join(dir, 'ok', 'game.json'), JSON.stringify({ id: 'ok', title: 'G', show: 'show.mjs', player: 'operator', stage: { layout: 'side', hud: [[0, .8, 1, .2]] } }));
            assert.equal(loadGame('ok', dir).stage.layout, 'side');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
