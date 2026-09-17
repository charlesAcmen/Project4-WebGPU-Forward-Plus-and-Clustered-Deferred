// CHECKITOUT: code that you add here will be prepended to all shaders

struct Light {
    // Mirrors LightGpuLayout: each vec3f occupies a 16-byte storage slot.
    pos: vec3f,
    color: vec3f
}

struct LightSet {
    // Mirrors LightSetGpuLayout: the runtime array starts at byte offset 16.
    numLights: u32,
    lights: array<Light>
}

// TODO-2: you may want to create a ClusterSet struct similar to LightSet

struct ClusterMetadata {
    // Mirrors ClusterMetadataGpuLayout: each cluster owns a contiguous index range.
    lightIndexOffset: u32,
    lightIndexCapacity: u32,
    lightCount: u32,
    candidateLightCount: u32,
}

struct CameraUniforms {
    // TODO-1.3: add an entry for the view proj mat (of type mat4x4f)
    // Mirrors CameraGpuLayout: matrices are followed by two vec4f clustering parameter blocks.
    viewProjMat: mat4x4f,
    viewMat: mat4x4f,
    // near plane, far plane, tan(fovY / 2), aspect ratio
    projectionParams: vec4f,
    // viewport width, viewport height, reciprocal width, reciprocal height
    viewport: vec4f,
}

// CHECKITOUT: this special attenuation function ensures lights don't affect geometry outside the maximum light radius
fn rangeAttenuation(distance: f32) -> f32 {
    //power of 4 is a good balance between smoothness and performance
    //becomes 0 at distance = lightRadius, and is 1 at distance = 0
    return clamp(1.f - pow(distance / ${lightRadius}, 4.f), 0.f, 1.f) / (distance * distance);
}
//Lambert diffuse lighting model
fn calculateLightContrib(light: Light, posWorld: vec3f, nor: vec3f) -> vec3f {
    let vecToLight = light.pos - posWorld;
    let distToLight = length(vecToLight);

    let lambert = max(dot(nor, normalize(vecToLight)), 0.f);
    return light.color * lambert * rangeAttenuation(distToLight);
}
