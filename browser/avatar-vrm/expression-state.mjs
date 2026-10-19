import { EXPRESSIONS, VOWEL_NAMES, clamp } from './controls.mjs';

export const BROW_MORPHS = Object.freeze({
    raised: 'Fcl_BRW_Surprised', worried: 'Fcl_BRW_Sorrow', focused: 'Fcl_BRW_Angry', warm: 'Fcl_BRW_Fun',
});

/** Factories keep this binding setup testable against the actual VRM metadata. */
export function prepareExpressionGroups(manager, createExpression, createMorphBind) {
    const primitives = new Set();
    for (const name of EXPRESSIONS) {
        const expression = manager.getExpression(name);
        if (!expression) continue;
        for (const bind of expression.binds) for (const primitive of bind.primitives || []) primitives.add(primitive);
        for (const [suffix, prefix] of [['mouth', 'Fcl_MTH_'], ['eyes', 'Fcl_EYE_'], ['brows', 'Fcl_BRW_']]) {
            if (manager.getExpression(`${name}_${suffix}`)) continue;
            const group = createExpression(`${name}_${suffix}`);
            for (const bind of [...expression.binds]) {
                const dictionary = bind.primitives?.[0]?.morphTargetDictionary;
                const target = Object.entries(dictionary || {}).find(([, index]) => index === bind.index)?.[0];
                if (!target?.startsWith(prefix)) continue;
                expression.deleteBind(bind); group.addBind(bind);
            }
            if (group.binds.length) manager.registerExpression(group);
        }
    }
    for (const [channel, target] of Object.entries(BROW_MORPHS)) {
        const name = `noa_brow_${channel}`;
        if (manager.getExpression(name)) continue;
        const group = createExpression(name), byIndex = new Map();
        for (const primitive of primitives) {
            const index = primitive.morphTargetDictionary?.[target];
            if (!Number.isInteger(index)) continue;
            if (!byIndex.has(index)) byIndex.set(index, []);
            byIndex.get(index).push(primitive);
        }
        for (const [index, meshes] of byIndex) group.addBind(createMorphBind({ primitives: meshes, index, weight: 1 }));
        if (group.binds.length) manager.registerExpression(group);
    }
}

/** No timers or randomness: all motion comes from the stage's existing rig. */
export class ExpressionState {
    constructor() {
        this.weights = Object.fromEntries(EXPRESSIONS.map(name => [name, Number(name === 'neutral')]));
        this.vowels = Object.fromEntries(Object.values(VOWEL_NAMES).map(name => [name, 0]));
        this.brows = Object.fromEntries(Object.keys(BROW_MORPHS).map(name => [name, 0]));
        this.values = {};
    }

    update(dt, controls) {
        const delta = clamp(dt, 0, .25, 0), values = this.values;
        const selected = EXPRESSIONS.includes(controls.expression) ? controls.expression : 'neutral';
        const reaction = selected === 'neutral' ? 0 : clamp(controls.expressionWeight);
        const restHappy = clamp(controls.rest?.happy, 0, .18) * (1 - reaction);
        const restWorried = clamp(controls.rest?.worried, 0, .16) * (1 - reaction);
        const restBlush = clamp(controls.rest?.blush, 0, .25) * (1 - reaction);
        const expressive = reaction + restHappy + restWorried + restBlush;
        const blend = 1 - Math.exp(-delta / (expressive < 1 - this.weights.neutral ? .28 : .14));
        for (const name of EXPRESSIONS) {
            const target = name === 'neutral' ? 1 - expressive
                : Number(name === selected) * reaction + Number(name === 'happy') * restHappy + Number(name === 'worried') * restWorried + Number(name === 'blush') * restBlush;
            this.weights[name] += (target - this.weights[name]) * blend;
            values[name] = this.weights[name];
        }
        let speech = 0;
        for (const name of Object.keys(this.vowels)) {
            const target = clamp(controls.vowels?.[name]);
            const blend = 1 - Math.exp(-delta / (target > this.vowels[name] ? .035 : .065));
            this.vowels[name] = controls.mouthLocked ? 0 : this.vowels[name] + (target - this.vowels[name]) * blend;
            values[name] = this.vowels[name]; speech += this.vowels[name];
        }
        const left = clamp(controls.blink?.left), right = clamp(controls.blink?.right);
        const closure = Math.max(left, right);
        for (const name of EXPRESSIONS) {
            values[`${name}_eyes`] = this.weights[name] * (1 - closure);
            values[`${name}_mouth`] = controls.mouthLocked ? Number(name === 'neutral') : this.weights[name] * (1 - clamp(speech));
            // Brows have their own bounded channels; never double-add preset binds.
            values[`${name}_brows`] = 0;
        }
        // The resting blush is colour only: its eye half (the source Fun preset's Fcl_EYE_Fun) made the eyes half-lidded.
        values.blush_eyes = Math.max(0, this.weights.blush - restBlush) * (1 - closure);
        // Resting mouth corners: lift the happy mouth beyond the light resting smile, yielding to speech and reactions.
        if (!controls.mouthLocked) values.happy_mouth = Math.max(values.happy_mouth, clamp(controls.rest?.mouth, 0, .5) * (1 - reaction) * (1 - clamp(speech)));
        // Resting smile in the eyes: the laugh preset's eye half, closed by blinks and yielding to reactions.
        values.laugh_eyes = Math.max(values.laugh_eyes, clamp(controls.rest?.eyes, 0, .4) * (1 - reaction) * (1 - closure));
        let browTotal = 0;
        for (const name of Object.keys(this.brows)) {
            const target = clamp(controls.brows?.[name], 0, .6);
            const blend = 1 - Math.exp(-delta / (target > this.brows[name] ? .12 : .22));
            this.brows[name] += (target - this.brows[name]) * blend;
            browTotal += this.brows[name];
        }
        const browScale = Math.min(1, .6 / (browTotal || 1));
        for (const name of Object.keys(this.brows)) values[`noa_brow_${name}`] = this.brows[name] * browScale;
        values.blink = 0; values.blinkLeft = left; values.blinkRight = right;
        return values;
    }
}
