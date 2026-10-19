import { DEFAULT_OUTFIT_ID, isOutfitId } from '../../public/avatar-outfits.mjs';

// Only detached hood pieces are removed. Body contains the covered shoulders and sleeves.
export const HOOD_PART_NAMES = Object.freeze([
    'Noa hood outer', 'Noa hood lining', 'Noa hood stitched edge', 'Noa hood folded rim',
    'Noa hood bound side 0', 'Noa hood bound side 1', 'Noa hood bottom binding', 'Noa hood center seam',
    'Noa hood drawcord -1', 'Noa hood drawcord 1', 'Noa drawcord tip -1', 'Noa drawcord tip 1',
    'Noa drawcord eyelet -1', 'Noa drawcord eyelet 1',
]);

export const OUTFIT_MATERIAL_COLORS = Object.freeze({
    'signal-hoodie': Object.freeze({}),
    'midnight-hoodie': Object.freeze({
        'Noa hoodie cotton': '#4b515d',
        'Noa hood cotton': '#515866',
        'Noa hoodie blue': '#8da7be',
        'Noa hood lining': '#7d899c',
        'Noa hood seam thread': '#656e7e',
        'Noa charcoal undershirt': '#e1e3e6',
        'Noa zipper pull enamel': '#8da7be',
    }),
    'studio-jacket': Object.freeze({
        'Noa hoodie cotton': '#dce5e4',
        'Noa hood cotton': '#dce5e4',
        'Noa hoodie blue': '#496f75',
        'Noa hood lining': '#a4bbb9',
        'Noa hood seam thread': '#adc1be',
        'Noa charcoal undershirt': '#283b40',
        'Noa zipper pull enamel': '#b4ccc6',
    }),
});

const materialNames = new Set(Object.values(OUTFIT_MATERIAL_COLORS).flatMap(colors => Object.keys(colors)));
const sourceName = object => object.userData?.name || object.name;
const materialName = material => material.name.replace(/ \(Outline\)$/, '');
const objectMaterials = object => Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];

function hasSkinnedSurface(object) {
    let found = false;
    object.traverse(child => {
        if (child.isSkinnedMesh && child.geometry?.getAttribute('skinIndex')?.count > 0
            && child.geometry?.getAttribute('skinWeight')?.count > 0) found = true;
    });
    return found;
}

/** Reversible material/visibility changes; no mesh, rig, texture or animation replacement. */
export class NoaOutfitController {
    constructor(scene) {
        if (!scene?.traverse) throw new TypeError('Noa outfit switching requires a loaded scene');
        const required = new Set(['Body', 'Noa fitted undershirt', ...HOOD_PART_NAMES]);
        const nodes = new Map();
        const materials = new Map();
        const foundMaterials = new Set();
        scene.traverse(object => {
            const name = sourceName(object);
            if (required.has(name)) {
                if (nodes.has(name)) throw new Error(`Duplicate Noa clothing node: ${name}`);
                nodes.set(name, object);
            }
            for (const material of objectMaterials(object)) {
                const name = materialName(material);
                if (!materialNames.has(name) || materials.has(material)) continue;
                if (!material.color?.isColor || !material.shadeColorFactor?.isColor)
                    throw new Error(`Noa clothing requires MToon colors: ${name}`);
                foundMaterials.add(name);
                materials.set(material, {
                    name, color: material.color.clone(), shade: material.shadeColorFactor.clone(),
                });
            }
        });
        for (const name of required) {
            const node = nodes.get(name);
            if (!node || !hasSkinnedSurface(node)) throw new Error(`Noa clothing surface is missing: ${name}`);
        }
        for (const name of materialNames) {
            if (!foundMaterials.has(name)) throw new Error(`Noa clothing material is missing: ${name}`);
        }
        const body = nodes.get('Body'), inner = nodes.get('Noa fitted undershirt');
        if (!body.visible || !inner.visible) throw new Error('Noa shoulder and undershirt coverage must remain visible');
        const bodyMaterials = new Set();
        body.traverse(object => objectMaterials(object).forEach(material => bodyMaterials.add(materialName(material))));
        if (!bodyMaterials.has('Noa hoodie cotton') || !bodyMaterials.has('Noa hoodie blue'))
            throw new Error('Noa covered shoulder and sleeve materials are missing');
        this.materials = materials;
        this.hood = HOOD_PART_NAMES.map(name => {
            const node = nodes.get(name);
            let containsCoverage = false;
            node.traverse(child => { if (child === body || child === inner) containsCoverage = true; });
            if (containsCoverage) throw new Error('Noa hood must not own the body coverage');
            return { node, visible: node.visible };
        });
        this.outfitId = DEFAULT_OUTFIT_ID;
        this.disposed = false;
    }

    setOutfit(id) {
        if (!isOutfitId(id)) throw new TypeError('Unknown Noa outfit');
        if (this.disposed) throw new Error('Noa outfit controller is disposed');
        const colors = OUTFIT_MATERIAL_COLORS[id];
        for (const [material, original] of this.materials) {
            material.color.copy(original.color);
            material.shadeColorFactor.copy(original.shade);
            if (colors[original.name]) {
                material.color.set(colors[original.name]);
                // Preserve the authored shade-to-base ratio in linear working space.
                for (const channel of ['r', 'g', 'b']) {
                    const ratio = original.color[channel] > 0 ? original.shade[channel] / original.color[channel] : 1;
                    material.shadeColorFactor[channel] = Math.min(1, material.color[channel] * ratio);
                }
            }
        }
        for (const { node, visible } of this.hood) node.visible = visible && id !== 'studio-jacket';
        this.outfitId = id;
        return id;
    }

    dispose() {
        if (this.disposed) return;
        this.setOutfit(DEFAULT_OUTFIT_ID);
        this.materials.clear();
        this.hood.length = 0;
        this.disposed = true;
    }
}
