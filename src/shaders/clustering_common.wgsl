// Shared helpers used only by the fixed and adaptive clustering compute shaders.
// Keep the camera values as parameters so this file has no binding dependencies.
fn depthAtSlice(slice: u32, nearPlane: f32, farPlane: f32) -> f32 {
    let sliceFraction = f32(slice) / f32(${clusterDepthSliceCount});
    return nearPlane * pow(farPlane / nearPlane, sliceFraction);
}

fn sphereIntersectsAabb(center: vec3f, radius: f32, aabbMin: vec3f, aabbMax: vec3f) -> bool {
    let closestPoint = clamp(center, aabbMin, aabbMax);
    let delta = center - closestPoint;
    return dot(delta, delta) <= radius * radius;
}
