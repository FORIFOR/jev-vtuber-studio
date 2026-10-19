import { VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { ExpressionState, prepareExpressionGroups } from './expression-state.mjs';

// Keep all expression writes here. Mouth/eye binds must not fight speech/blink.
export function splitExpressions(manager) {
    prepareExpressionGroups(manager, name => new VRMExpression(name), options => new VRMExpressionMorphTargetBind(options));
}

export class ExpressionController {
    constructor(manager) {
        this.manager = manager;
        splitExpressions(manager);
        this.state = new ExpressionState();
        this.weights = this.state.weights;
        this.vowels = this.state.vowels;
    }

    update(dt, controls) {
        for (const [name, weight] of Object.entries(this.state.update(dt, controls))) this.manager.setValue(name, weight);
    }
}
