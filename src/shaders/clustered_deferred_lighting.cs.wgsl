// Extra Credit lighting consumer. This one compute pass replaces the legacy
// fullscreen triangle vertex+fragment pass without changing clustering.

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read> clusterOverflowFlags: array<u32>;
@group(${bindGroup_scene}) @binding(5) var depthGBuffer: texture_depth_2d;
@group(${bindGroup_scene}) @binding(6) var packedMaterialGBuffer: texture_2d<u32>;
// Group 1 changes with the presentation texture; group 0 stays persistent.
@group(1) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;
//check sign of a value
fn signNotZero(value: f32) -> f32 {
    return select(-1.f, 1.f, value >= 0.f);
}

fn decodeOctNormal(encoded: vec2u) -> vec3f {
    let oct = vec2f(f32(encoded.x), f32(encoded.y)) / 255.f * 2.f - vec2f(1.f);
    var normal = vec3f(oct, 1.f - abs(oct.x) - abs(oct.y));
    if (normal.z < 0.f) {
        // WGSL/Dawn does not permit assigning to a vector swizzle such as
        // normal.xy. Rebuild the full vector after unfolding the octahedron.
        let unfoldedXY = (vec2f(1.f) - abs(normal.yx)) * vec2f(signNotZero(normal.x), signNotZero(normal.y));
        normal = vec3f(unfoldedXY, normal.z);
    }
    return normalize(normal);
}

fn decodeRgb565(packedBytes: vec2u) -> vec3f {
    let bits = packedBytes.x | (packedBytes.y << 8u);
    let red = f32(bits & 0x1fu) / 31.f;
    let green = f32((bits >> 5u) & 0x3fu) / 63.f;
    let blue = f32((bits >> 11u) & 0x1fu) / 31.f;
    return vec3f(red, green, blue);
}

// WebGPU depth is already in [0, 1]. Reconstructing from inverse VP removes
// the legacy world-position target while keeping the cluster lookup in world space.
fn reconstructWorldPosition(pixel: vec2u, depth: f32) -> vec3f {
    let pixelCenter = vec2f(f32(pixel.x) + 0.5f, f32(pixel.y) + 0.5f);
    let ndc = vec2f(
        pixelCenter.x * cameraUniforms.viewport.z * 2.f - 1.f,
        1.f - pixelCenter.y * cameraUniforms.viewport.w * 2.f,
    );
    let worldHomogeneous = cameraUniforms.inverseViewProjMat * vec4f(ndc, depth, 1.f);
    return worldHomogeneous.xyz / worldHomogeneous.w;
}

fn clusterIndexForPixel(pixel: vec2u, posWorld: vec3f) -> u32 {
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let tileX = min(pixel.x / ${clusterTileSizePixels}u, tilesX - 1u);
    let tileY = min(pixel.y / ${clusterTileSizePixels}u, tilesY - 1u);

    let viewDepth = max(-(cameraUniforms.viewMat * vec4f(posWorld, 1.f)).z, cameraUniforms.projectionParams.x);
    let nearPlane = cameraUniforms.projectionParams.x;
    let farPlane = cameraUniforms.projectionParams.y;
    let normalizedDepth = log(viewDepth / nearPlane) / log(farPlane / nearPlane);
    let depthSlice = u32(clamp(
        floor(normalizedDepth * f32(${clusterDepthSliceCount})),
        0.f,
        f32(${clusterDepthSliceCount} - 1),
    ));
    return (depthSlice * tilesY + tileY) * tilesX + tileX;
}

@compute @workgroup_size(${deferredLightingWorkgroupSize}, ${deferredLightingWorkgroupSize})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let dimensions = textureDimensions(depthGBuffer);
    if (globalId.x >= dimensions.x || globalId.y >= dimensions.y) {
        return;
    }

    let pixel = globalId.xy;
    let pixelCoord = vec2i(i32(pixel.x), i32(pixel.y));
    let depth = textureLoad(depthGBuffer, pixelCoord, 0);
    if (depth >= 1.f) {
        // The cleared depth value replaces the legacy position-alpha validity bit.
        textureStore(outputTexture, pixelCoord, vec4f(0.f, 0.f, 0.f, 1.f));
        return;
    }

    let packed = textureLoad(packedMaterialGBuffer, pixelCoord, 0);
    let normal = decodeOctNormal(packed.xy);
    let albedo = decodeRgb565(packed.zw);
    let position = reconstructWorldPosition(pixel, depth);
    let clusterIndex = clusterIndexForPixel(pixel, position);
    let cluster = clusterMetadata[clusterIndex];

    var totalLightContrib = vec3f(0.f);
    if (clusterOverflowFlags[clusterIndex] != 0u) {
        // Keep the base renderer's correctness fallback when a fixed list overflows.
        for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
            totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], position, normal);
        }
    } else {
        for (var localLightIndex = 0u; localLightIndex < cluster.lightCount; localLightIndex++) {
            let lightIndex = clusterLightIndices[cluster.lightIndexOffset + localLightIndex];
            totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], position, normal);
        }
    }

    textureStore(outputTexture, pixelCoord, vec4f(albedo * totalLightContrib, 1.f));
}
