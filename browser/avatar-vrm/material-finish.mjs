// MToon uniform adjustments only: keep the authored textures, alpha, outlines and
// draw calls. Colors below are in Three's linear working space, not hex/sRGB.
const FINISHES = Object.freeze({
    skin: Object.freeze({ shadingShiftFactor: -.08, shadingToonyFactor: .35, giEqualizationFactor: .7,
        parametricRimColorFactor: [.025, .017, .020], parametricRimFresnelPowerFactor: 4.5, parametricRimLiftFactor: 0, rimLightingMixFactor: .7 }),
    hair: Object.freeze({ shadingShiftFactor: -.12, shadingToonyFactor: .45, giEqualizationFactor: .6,
        parametricRimColorFactor: [.07, .095, .16], parametricRimFresnelPowerFactor: 4, parametricRimLiftFactor: .015, rimLightingMixFactor: .75 }),
    cotton: Object.freeze({ shadingShiftFactor: -.10, shadingToonyFactor: .22, giEqualizationFactor: .65,
        parametricRimColorFactor: [.009, .012, .018], parametricRimFresnelPowerFactor: 5, parametricRimLiftFactor: 0, rimLightingMixFactor: .9 }),
    hardware: Object.freeze({ shadingShiftFactor: -.08, shadingToonyFactor: .52, giEqualizationFactor: .6,
        parametricRimColorFactor: [.08, .10, .14], parametricRimFresnelPowerFactor: 3.5, parametricRimLiftFactor: 0, rimLightingMixFactor: .75 }),
});

const groups = {
    skin: ['N00_000_00_Face_00_SKIN (Instance)', 'N00_000_00_Body_00_SKIN (Instance)', 'Noa neck skin',
        'Noa jaw definition 0', 'Noa jaw definition 1', 'Noa jaw definition 2', 'Noa jaw definition 3'],
    hair: ['N00_000_Hair_00_HAIR_01 (Instance)', 'Noa navy scalp hair'],
    cotton: ['Noa hoodie cotton', 'Noa hood cotton', 'Noa hoodie blue', 'Noa hood lining', 'Noa charcoal undershirt'],
    hardware: ['Noa satin hardware', 'Noa zipper pull silver', 'Noa porcelain headset'],
};
export const NOA_FINISH_GROUPS = Object.freeze(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, Object.freeze(v)])));
const profileByName = new Map(Object.entries(groups).flatMap(([group, names]) => names.map(name => [name, FINISHES[group]])));
const applied = new WeakMap();

/** Apply once, and restore before scene disposal. No new materials or textures. */
export function configureNoaMaterials(scene, { skip = [] } = {}) {
    if (!scene?.traverse) throw new TypeError('Noa material finish requires a scene');
    if (applied.has(scene)) return applied.get(scene);
    const originals = new Map();
    scene.traverse(object => {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (!material?.isMToonMaterial || originals.has(material)) continue;
            const profile = profileByName.get(material.name.replace(/ \(Outline\)$/, ''));
            if (!profile || skip.some(group => groups[group]?.includes(material.name.replace(/ \(Outline\)$/, '')))) continue;
            const saved = {};
            for (const [key, value] of Object.entries(profile)) {
                if (Array.isArray(value)) {
                    if (!material[key]?.isColor) continue;
                    saved[key] = material[key].clone();
                    material[key].setRGB(...value);
                } else if (Number.isFinite(material[key])) {
                    saved[key] = material[key];
                    material[key] = value;
                }
            }
            originals.set(material, saved);
        }
    });
    let disposed = false;
    const result = { materialCount: originals.size, dispose() {
        if (disposed) return;
        disposed = true;
        for (const [material, saved] of originals) for (const [key, value] of Object.entries(saved)) {
            if (value?.isColor) material[key].copy(value);
            else material[key] = value;
        }
        originals.clear();
        if (applied.get(scene) === result) applied.delete(scene);
    } };
    applied.set(scene, result);
    return result;
}
