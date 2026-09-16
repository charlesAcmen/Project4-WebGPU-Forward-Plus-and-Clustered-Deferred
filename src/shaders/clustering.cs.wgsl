// TODO-2: implement the light clustering compute shader

// ------------------------------------
// Calculating cluster bounds:
// ------------------------------------
// For each cluster (X, Y, Z):
//     - Calculate the screen-space bounds for this cluster in 2D (XY).
//     - Calculate the depth bounds for this cluster in Z (near and far planes).
//     - Convert these screen and depth bounds into view-space coordinates.
//     - Store the computed bounding box (AABB) for the cluster.

// ------------------------------------
// Assigning lights to clusters:
// ------------------------------------
// For each cluster:
//     - Initialize a counter for the number of lights in this cluster.

//     For each light:
//         - Check if the light intersects with the cluster’s bounding box (AABB).
//         - If it does, add the light to the cluster's light list.
//         - Stop adding lights if the maximum number of lights is reached.

//     - Store the number of lights assigned to this cluster.
//uniform:__constant__
@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
//<storage,read>:const __restrict__
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
//<storage,read_write>:float* global memory
@group(${bindGroup_scene}) @binding(2) var<storage, read_write> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read_write> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read_write> clusterOverflowFlags: array<u32>;
//depth=near*(far/near)^(sliceFraction)
//sliceFraction = sliceIndex / totalSlices
fn depthAtSlice(slice: u32) -> f32 {
    let nearPlane = cameraUniforms.projectionParams.x;
    let farPlane = cameraUniforms.projectionParams.y;
    let sliceFraction = f32(slice) / f32(${clusterDepthSliceCount});
    return nearPlane * pow(farPlane / nearPlane, sliceFraction);
}

fn sphereIntersectsAabb(center: vec3f, radius: f32, aabbMin: vec3f, aabbMax: vec3f) -> bool {
    let closestPoint = clamp(center, aabbMin, aabbMax);
    let delta = center - closestPoint;
    return dot(d elta, delta) <= radius * radius;
}

@compute
@workgroup_size(${clusteringWorkgroupSize})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let clusterIndex = globalId.x;
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let clusterCount = tilesX * tilesY * ${clusterDepthSliceCount}u;
    if (clusterIndex >= clusterCount) {
        return;
    }

    let zSlice = clusterIndex / (tilesX * tilesY);
    let tileIndex = clusterIndex % (tilesX * tilesY);
    let tileY = tileIndex / tilesX;
    let tileX = tileIndex % tilesX;

    //AABB defined by aabbmin and aabbmax in view space coordinates
    let minPixel = vec2f(f32(tileX * ${clusterTileSizePixels}u), f32(tileY * ${clusterTileSizePixels}u));
    let maxPixel = min(minPixel + vec2f(f32(${clusterTileSizePixels}u)), cameraUniforms.viewport.xy);
    //Ndc coordinates are in [-1, 1] range, so we need to convert from pixel coordinates to NDC.
    //Ndc is short for Normalized Device Coordinates
    let minNdcX = minPixel.x * cameraUniforms.viewport.z * 2.f - 1.f;
    let maxNdcX = maxPixel.x * cameraUniforms.viewport.z * 2.f - 1.f;
    // Framebuffer Y grows downward, while view-space/NDC Y grows upward.
    let yAtMinPixel = 1.f - minPixel.y * cameraUniforms.viewport.w * 2.f;
    let yAtMaxPixel = 1.f - maxPixel.y * cameraUniforms.viewport.w * 2.f;
    let minNdc = vec2f(minNdcX, min(yAtMinPixel, yAtMaxPixel));
    let maxNdc = vec2f(maxNdcX, max(yAtMinPixel, yAtMaxPixel));

    let depthNear = depthAtSlice(zSlice);
    let depthFar = depthAtSlice(zSlice + 1u);
    let tanHalfFovY = cameraUniforms.projectionParams.z;
    let aspectRatio = cameraUniforms.projectionParams.w;

    //physical size of the near and far planes in view space coordinates
    let nearScale = vec2f(depthNear * tanHalfFovY * aspectRatio, depthNear * tanHalfFovY);
    let farScale = vec2f(depthFar * tanHalfFovY * aspectRatio, depthFar * tanHalfFovY);
    //physical coordinates of 4 corners in meter
    let nearMin = minNdc * nearScale;
    let nearMax = maxNdc * nearScale;
    let farMin = minNdc * farScale;
    let farMax = maxNdc * farScale;
    //z axis:- cause webgpu/opengl camera looks down the -z axis.
    let aabbMin = vec3f(min(min(nearMin.x, nearMax.x), min(farMin.x, farMax.x)), min(min(nearMin.y, nearMax.y), min(farMin.y, farMax.y)), -depthFar);
    let aabbMax = vec3f(max(max(nearMin.x, nearMax.x), max(farMin.x, farMax.x)), max(max(nearMin.y, nearMax.y), max(farMin.y, farMax.y)), -depthNear);

    let lightIndexOffset = clusterMetadata[clusterIndex].lightIndexOffset;
    var acceptedLightCount = 0u;
    clusterOverflowFlags[clusterIndex] = 0u;

    for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
        let lightViewPos = (cameraUniforms.viewMat * vec4f(lightSet.lights[lightIndex].pos, 1.f)).xyz;
        //%{}f:single source of truth,f:literal suffix
        if (sphereIntersectsAabb(lightViewPos, ${lightRadius}f, aabbMin, aabbMax)) {
            if (acceptedLightCount < ${maxLightsPerCluster}u) {
                clusterLightIndices[lightIndexOffset + acceptedLightCount] = lightIndex;
                acceptedLightCount += 1u;
            } else {
                clusterOverflowFlags[clusterIndex] = 1u;
            }
        }
    }

    clusterMetadata[clusterIndex].lightCount = acceptedLightCount;
}
