// TODO-3: implement the Clustered Deferred fullscreen fragment shader

// Similar to the Forward+ fragment shader, but with vertex information coming from the G-buffer instead.
//from compute shader
@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read> clusterOverflowFlags: array<u32>;
//from gbuffer
@group(${bindGroup_scene}) @binding(5) var positionGBuffer: texture_2d<f32>;
@group(${bindGroup_scene}) @binding(6) var albedoGBuffer: texture_2d<f32>;
@group(${bindGroup_scene}) @binding(7) var normalGBuffer: texture_2d<f32>;
//calculate which cluster based on screen coordinates and world position of the fragment
fn clusterIndexForFragment(fragCoord: vec4f, posWorld: vec3f) -> u32 {
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let tileX = min(u32(fragCoord.x) / ${clusterTileSizePixels}u, tilesX - 1u);
    let tileY = min(u32(fragCoord.y) / ${clusterTileSizePixels}u, tilesY - 1u);

    // Visible view-space points have negative Z, so clustering uses -Z distance.
    let viewDepth = max(-(cameraUniforms.viewMat * vec4f(posWorld, 1.f)).z, cameraUniforms.projectionParams.x);
    let nearPlane = cameraUniforms.projectionParams.x;
    let farPlane = cameraUniforms.projectionParams.y;
    //percentage:
    let normalizedDepth = log(viewDepth / nearPlane) / log(farPlane / nearPlane);
    let depthSlice = u32(clamp(
        floor(normalizedDepth * f32(${clusterDepthSliceCount})),
        0.f,
        f32(${clusterDepthSliceCount} - 1),
    ));
    return (depthSlice * tilesY + tileY) * tilesX + tileX;
}

@fragment
//@location(0):MRT,multiple render targets.
//colorAttachment0:positionGBuffer, colorAttachment1:albedoGBuffer, colorAttachment2:normalGBuffer
fn main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
    let pixelCoord = vec2i(i32(fragCoord.x), i32(fragCoord.y));
    //load world position from g-buffer after render pass
    let position = textureLoad(positionGBuffer, pixelCoord, 0);
    //in render pass,g-buffer was cleared as [0,0,0,0],and set as [vec3f.pos,1.f] when things present in that space
    if (position.a == 0.f) {
        //skip as empty space，do not look up light cluster to conserve bandwidth and avoid unnecessary light calculations
        return vec4f(0.f, 0.f, 0.f, 1.f);
    }

    //load albedo and normal from g-buffer only when the position is valid, to avoid unnecessary bandwidth usage
    let albedo = textureLoad(albedoGBuffer, pixelCoord, 0).rgb;
    let normal = normalize(textureLoad(normalGBuffer, pixelCoord, 0).xyz);
    //look up the cluster index for this fragment based on its screen coordinates and world position
    let clusterIndex = clusterIndexForFragment(fragCoord, position.xyz);
    let cluster = clusterMetadata[clusterIndex];

    var totalLightContrib = vec3f(0.f);
    if (clusterOverflowFlags[clusterIndex] != 0u) {
        // Match Forward+: do not trade lighting correctness for a hard pool limit.
        for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
            //fallback to brute-force lighting for this cluster, as it has overflowed the light index pool
            totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], position.xyz, normal);
        }
    } else {
        //cluster's light list not all across light set
        for (var localLightIndex = 0u; localLightIndex < cluster.lightCount; localLightIndex++) {
            let lightIndex = clusterLightIndices[cluster.lightIndexOffset + localLightIndex];
            totalLightContrib += calculateLightContrib(lightSet.lights[lightIndex], position.xyz, normal);
        }
    }

    return vec4f(albedo * totalLightContrib, 1.f);
}
