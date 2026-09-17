// TODO-2: implement the Forward+ fragment shader

// See naive.fs.wgsl for basic fragment shader setup; this shader should use light clusters instead of looping over all lights

// ------------------------------------
// Shading process:
// ------------------------------------
// Determine which cluster contains the current fragment.
// Retrieve the number of lights that affect the current fragment from the cluster’s data.
// Initialize a variable to accumulate the total light contribution for the fragment.
// For each light in the cluster:
//     Access the light's properties using its index.
//     Calculate the contribution of the light based on its position, the fragment’s position, and the surface normal.
//     Add the calculated contribution to the total light accumulation.
// Multiply the fragment’s diffuse color by the accumulated light contribution.
// Return the final color, ensuring that the alpha component is set appropriately (typically to 1).

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read> clusterOverflowFlags: array<u32>;

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    //built-in system value from graphic card
    @builtin(position) fragCoord: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

fn clusterIndexForFragment(fragCoord: vec4f, posWorld: vec3f) -> u32 {
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    //divide by clusterTileSizePixels to get the tile index, and clamp to ensure we don't go out of bounds
    let tileX = min(u32(fragCoord.x) / ${clusterTileSizePixels}u, tilesX - 1u);
    let tileY = min(u32(fragCoord.y) / ${clusterTileSizePixels}u, tilesY - 1u);

    // Cluster depth uses positive view-space distance because visible geometry has negative view Z.
    let viewDepth = max(-(cameraUniforms.viewMat * vec4f(posWorld, 1.f)).z, cameraUniforms.projectionParams.x);
    let nearPlane = cameraUniforms.projectionParams.x;
    let farPlane = cameraUniforms.projectionParams.y;
    let normalizedDepth = log(viewDepth / nearPlane) / log(farPlane / nearPlane);
    let depthSlice = u32(clamp(floor(normalizedDepth * f32(${clusterDepthSliceCount})), 0.f, f32(${clusterDepthSliceCount} - 1)));
    return (depthSlice * tilesY + tileY) * tilesX + tileX;
}

@fragment
fn main(in: FragmentInput) -> @location(0) vec4f {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    let clusterIndex = clusterIndexForFragment(in.fragCoord, in.pos);
    let cluster = clusterMetadata[clusterIndex];
    var totalLightContrib = vec3f(0.f);
    if (clusterOverflowFlags[clusterIndex] != 0u) {
        // Never darken a saturated cluster: correctness takes priority over culling here.
        for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
            totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], in.pos, normalize(in.nor));
        }
    } else {
        for (var localLightIndex = 0u; localLightIndex < cluster.lightCount; localLightIndex++) {
            let light = lightSet.lights[clusterLightIndices[cluster.lightIndexOffset + localLightIndex]];
            totalLightContrib += calculateLightContrib(light, in.pos, normalize(in.nor));
        }
    }

    return vec4f(diffuseColor.rgb * totalLightContrib, 1.f);
}
