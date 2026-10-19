// Noa 4.86's left side strand can settle 12.8 mm above its resting tip between
// the chest and upper-arm colliders. A small downward force releases that contact
// without shrinking either collider or resetting the simulated pose.
export function configureNoaPhysics(vrm) {
    const adjustments = [];
    for (const joint of vrm.springBoneManager?.joints || []) {
        if (!/^J_Sec_Hair[1-4]_03$/.test(joint.bone.name) || joint.settings.gravityPower !== 0) continue;
        adjustments.push({ bone: joint.bone.name, previousGravityPower: 0, gravityPower: .02 });
        joint.settings.gravityPower = .02;
    }
    return adjustments;
}
