// Stream compaction in a higher sense:CSR,Compressed Sparse Row
// Adaptive clustering keeps a bounded global index pool compact. The first
// pass counts intersections, the second assigns contiguous ranges, and the
// third pass writes the final light indices.
@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read_write> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read_write> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read_write> clusterOverflowFlags: array<u32>;

struct ClusterAabb {
    min: vec3f,
    max: vec3f,
}

fn clusterBounds(clusterIndex: u32, tilesX: u32, tilesY: u32) -> ClusterAabb {
    let zSlice = clusterIndex / (tilesX * tilesY);
    let tileIndex = clusterIndex % (tilesX * tilesY);
    let tileY = tileIndex / tilesX;
    let tileX = tileIndex % tilesX;

    let minPixel = vec2f(f32(tileX * ${clusterTileSizePixels}u), f32(tileY * ${clusterTileSizePixels}u));
    let maxPixel = min(minPixel + vec2f(f32(${clusterTileSizePixels}u)), cameraUniforms.viewport.xy);
    let minNdcX = minPixel.x * cameraUniforms.viewport.z * 2.f - 1.f;
    let maxNdcX = maxPixel.x * cameraUniforms.viewport.z * 2.f - 1.f;
    let yAtMinPixel = 1.f - minPixel.y * cameraUniforms.viewport.w * 2.f;
    let yAtMaxPixel = 1.f - maxPixel.y * cameraUniforms.viewport.w * 2.f;
    let minNdc = vec2f(minNdcX, min(yAtMinPixel, yAtMaxPixel));
    let maxNdc = vec2f(maxNdcX, max(yAtMinPixel, yAtMaxPixel));

    let nearPlane = cameraUniforms.projectionParams.x;
    let farPlane = cameraUniforms.projectionParams.y;
    let depthNear = depthAtSlice(zSlice, nearPlane, farPlane);
    let depthFar = depthAtSlice(zSlice + 1u, nearPlane, farPlane);
    let tanHalfFovY = cameraUniforms.projectionParams.z;
    let aspectRatio = cameraUniforms.projectionParams.w;
    let nearScale = vec2f(depthNear * tanHalfFovY * aspectRatio, depthNear * tanHalfFovY);
    let farScale = vec2f(depthFar * tanHalfFovY * aspectRatio, depthFar * tanHalfFovY);
    let nearMin = minNdc * nearScale;
    let nearMax = maxNdc * nearScale;
    let farMin = minNdc * farScale;
    let farMax = maxNdc * farScale;

    var bounds: ClusterAabb;
    bounds.min = vec3f(
        min(min(nearMin.x, nearMax.x), min(farMin.x, farMax.x)),
        min(min(nearMin.y, nearMax.y), min(farMin.y, farMax.y)),
        -depthFar,
    );
    bounds.max = vec3f(
        max(max(nearMin.x, nearMax.x), max(farMin.x, farMax.x)),
        max(max(nearMin.y, nearMax.y), max(farMin.y, farMax.y)),
        -depthNear,
    );
    return bounds;
}

fn clusterCount() -> u32 {
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    return tilesX * tilesY * ${clusterDepthSliceCount}u;
}

@compute
@workgroup_size(${clusteringWorkgroupSize})
//Pass 1:count the number of lights that intersect each cluster.
//This is used to allocate a contiguous range of indices for each cluster in the global index pool.
fn countClusters(@builtin(global_invocation_id) globalId: vec3u) {
    let clusterIndex = globalId.x;
    if (clusterIndex >= clusterCount()) {
        return;
    }

    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let bounds = clusterBounds(clusterIndex, tilesX, tilesY);
    var candidateLightCount = 0u;
    for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
        let lightViewPos = (cameraUniforms.viewMat * vec4f(lightSet.lights[lightIndex].pos, 1.f)).xyz;
        if (sphereIntersectsAabb(lightViewPos, ${lightRadius}f, bounds.min, bounds.max)) {
            candidateLightCount += 1u;
        }
    }

    clusterMetadata[clusterIndex].candidateLightCount = candidateLightCount;
    clusterMetadata[clusterIndex].lightCount = 0u;
}

@compute
@workgroup_size(1)
//Pass 2:assign contiguous ranges of indices for each cluster in the global index pool.
fn prefixClusterCounts() {
    let indexPoolCapacity = arrayLength(&clusterLightIndices);
    var nextLightIndexOffset = 0u;
    for (var clusterIndex = 0u; clusterIndex < clusterCount(); clusterIndex++) {
        let candidateLightCount = clusterMetadata[clusterIndex].candidateLightCount;
        let remainingCapacity = indexPoolCapacity - nextLightIndexOffset;
        let assignedCapacity = min(candidateLightCount, remainingCapacity);

        clusterMetadata[clusterIndex].lightIndexOffset = nextLightIndexOffset;
        clusterMetadata[clusterIndex].lightIndexCapacity = assignedCapacity;
        clusterMetadata[clusterIndex].lightCount = 0u;
        //select is equaivalent to a conditional expression
        //in C++: clusterOverflowFlags[clusterIndex] = (assignedCapacity < candidateLightCount) ? 1u : 0u;
        //in SASS（底层汇编）:ISELP,integer select
        //in AMD:V_CNDMASK,SPIR_V OpSelect
        //no warp divergence
        clusterOverflowFlags[clusterIndex] = select(0u, 1u, assignedCapacity < candidateLightCount);
        nextLightIndexOffset += assignedCapacity;
    }
}

@compute
@workgroup_size(${clusteringWorkgroupSize})
//Pass 3:fill the global index pool with the indices of lights that intersect each cluster.
fn fillClusterLists(@builtin(global_invocation_id) globalId: vec3u) {
    let clusterIndex = globalId.x;
    if (clusterIndex >= clusterCount()) {
        return;
    }

    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let bounds = clusterBounds(clusterIndex, tilesX, tilesY);
    let lightIndexOffset = clusterMetadata[clusterIndex].lightIndexOffset;
    let lightIndexCapacity = clusterMetadata[clusterIndex].lightIndexCapacity;
    var lightCount = 0u;
    for (var lightIndex = 0u; lightIndex < lightSet.numLights; lightIndex++) {
        let lightViewPos = (cameraUniforms.viewMat * vec4f(lightSet.lights[lightIndex].pos, 1.f)).xyz;
        if (sphereIntersectsAabb(lightViewPos, ${lightRadius}f, bounds.min, bounds.max)) {
            if (lightCount < lightIndexCapacity) {
                clusterLightIndices[lightIndexOffset + lightCount] = lightIndex;
                lightCount += 1u;
            }
        }
    }
    clusterMetadata[clusterIndex].lightCount = lightCount;
}
