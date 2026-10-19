// Adapted from AIRoid_3D/viewer/spring-step.js. One spring integration clock.
export function stabilizeSpringStep(manager) {
    if (!manager) return () => {};
    const original = manager.update;
    const step = 1 / 120;
    let accumulated = 0;
    const update = delta => {
        if (!Number.isFinite(delta) || delta <= 0) return;
        accumulated += Math.min(delta, .1);
        while (accumulated + 1e-10 >= step) {
            original.call(manager, step);
            accumulated -= step;
        }
    };
    manager.update = update;
    return () => { if (manager.update === update) manager.update = original; };
}
