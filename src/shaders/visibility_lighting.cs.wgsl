// Visibility Buffer compute shading pass.
//
// The geometry pass wrote a packed ObjectID/TriangleID and a depth value. This
// pass reconstructs the hit position, fetches the original triangle from
// storage, computes barycentric coordinates, interpolates normal/UV, samples
// material color, and finally reuses the clustered light list.

struct VisibilityObject {
    // Must exactly match Scene.getVisibilitySceneData(): an eight-u32 header,
    // followed by model and normal matrices, for a total stride of 160 bytes.
    // The two per-primitive counts make each storage lookup locally
    // checkable. WGSL types must be declared before a resource binding uses
    // them.
    indexOffset: u32,
    vertexFloatOffset: u32,
    indexCount: u32,
    vertexCount: u32,
    materialLayer: u32,
    _padding0: u32,
    _padding1: u32,
    _padding2: u32,
    modelMat: mat4x4f,
    normalMat: mat4x4f,
}

struct VisibilityDebugUniforms {
    // 0 = final clustered lighting (normal mode)
    // 1 = geometry coverage / packed-ID producer
    // 2 = reconstructed barycentric coordinates
    // 3 = reconstructed albedo before lighting
    mode: u32,
    _padding0: u32,
    _padding1: u32,
    _padding2: u32,
}

@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;
@group(${bindGroup_scene}) @binding(1) var<storage, read> lightSet: LightSet;
@group(${bindGroup_scene}) @binding(2) var<storage, read> clusterMetadata: array<ClusterMetadata>;
@group(${bindGroup_scene}) @binding(3) var<storage, read> clusterLightIndices: array<u32>;
@group(${bindGroup_scene}) @binding(4) var<storage, read> clusterOverflowFlags: array<u32>;
@group(${bindGroup_scene}) @binding(5) var depthBuffer: texture_depth_2d;
@group(${bindGroup_scene}) @binding(6) var visibilityBuffer: texture_2d<u32>;

// The vertex data has the same eight-f32 layout used by renderer.ts:
// [position.xyz | normal.xyz | uv.xy]. Reading scalar f32 values avoids the
// 16-byte vec3f alignment trap that would occur with a direct WGSL Vertex
// storage struct over this compact 32-byte CPU-side stride.
@group(${bindGroup_scene}) @binding(7) var<storage, read> visibilityVertices: array<f32>;
@group(${bindGroup_scene}) @binding(8) var<storage, read> visibilityIndices: array<u32>;
@group(${bindGroup_scene}) @binding(9) var<storage, read> visibilityObjects: array<VisibilityObject>;
@group(${bindGroup_scene}) @binding(10) var visibilityMaterialTextures: texture_2d_array<f32>;
@group(${bindGroup_scene}) @binding(11) var visibilityMaterialSampler: sampler;
@group(${bindGroup_scene}) @binding(13) var<uniform> visibilityDebug: VisibilityDebugUniforms;
// Group 1 changes with the presentation texture; group 0 stays persistent.
@group(1) @binding(0) var outputTexture: texture_storage_2d<rgba8unorm, write>;

struct VisibilityVertex {
    // This is a function-local convenience type only. It is never used as a
    // storage-buffer element, so its natural vec3f padding is harmless.
    position: vec3f,
    normal: vec3f,
    uv: vec2f,
}

fn loadVisibilityVertex(vertexFloatOffset: u32, vertexIndex: u32) -> VisibilityVertex {
    let base = vertexFloatOffset + vertexIndex * 8u;
    var vertex: VisibilityVertex;
    vertex.position = vec3f(
        visibilityVertices[base],
        visibilityVertices[base + 1u],
        visibilityVertices[base + 2u],
    );
    vertex.normal = vec3f(
        visibilityVertices[base + 3u],
        visibilityVertices[base + 4u],
        visibilityVertices[base + 5u],
    );
    vertex.uv = vec2f(
        visibilityVertices[base + 6u],
        visibilityVertices[base + 7u],
    );
    return vertex;
}

// WebGPU depth is already in [0, 1]. The camera uniform stores inverse(VP)
// once per frame, avoiding a matrix inverse in every compute invocation.
fn pixelCenterNdc(pixel: vec2u) -> vec2f {
    let pixelCenter = vec2f(f32(pixel.x) + 0.5f, f32(pixel.y) + 0.5f);
    return vec2f(
        pixelCenter.x * cameraUniforms.viewport.z * 2.f - 1.f,
        1.f - pixelCenter.y * cameraUniforms.viewport.w * 2.f,
    );
}

fn reconstructWorldPosition(pixel: vec2u, depth: f32) -> vec3f {
    let ndc = pixelCenterNdc(pixel);
    let worldHomogeneous = cameraUniforms.inverseViewProjMat * vec4f(ndc, depth, 1.f);
    return worldHomogeneous.xyz / worldHomogeneous.w;
}

fn clusterIndexForPixel(pixel: vec2u, posWorld: vec3f) -> u32 {
    let tilesX = u32(ceil(cameraUniforms.viewport.x / f32(${clusterTileSizePixels})));
    let tilesY = u32(ceil(cameraUniforms.viewport.y / f32(${clusterTileSizePixels})));
    let tileX = min(pixel.x / ${clusterTileSizePixels}u, tilesX - 1u);
    let tileY = min(pixel.y / ${clusterTileSizePixels}u, tilesY - 1u);

    let viewDepth = max(-(cameraUniforms.viewMat * vec4f(posWorld, 1.f)).z, cameraUniforms.projectionParams.x);
    let normalizedDepth = log(viewDepth / cameraUniforms.projectionParams.x)
        / log(cameraUniforms.projectionParams.y / cameraUniforms.projectionParams.x);
    let depthSlice = u32(clamp(
        floor(normalizedDepth * f32(${clusterDepthSliceCount})),
        0.f,
        f32(${clusterDepthSliceCount} - 1),
    ));
    return (depthSlice * tilesY + tileY) * tilesX + tileX;
}

// Barycentric coordinates from a world-space point P and world-space triangle
// A/B/C. dot(cross(...), triangleNormal) gives a signed sub-triangle area.
// This works after depth reconstruction because P lies on the original world
// triangle plane (up to ordinary depth precision).
fn calculateBarycentrics(point: vec3f, a: vec3f, b: vec3f, c: vec3f) -> vec3f {
    let triangleNormal = cross(b - a, c - a);
    let squaredDoubleArea = dot(triangleNormal, triangleNormal);
    if (squaredDoubleArea <= 1e-20f) {
        // Degenerate input geometry has no stable interpolation. The caller
        // treats this sentinel as an invalid pixel instead of dividing by zero.
        return vec3f(-1.f);
    }
    let weightA = dot(cross(b - point, c - point), triangleNormal) / squaredDoubleArea;
    let weightB = dot(cross(c - point, a - point), triangleNormal) / squaredDoubleArea;
    return vec3f(weightA, weightB, 1.f - weightA - weightB);
}

fn barycentricsNeedFallback(barycentrics: vec3f) -> bool {
    // A small negative number can arise on a shared edge when the depth value
    // is rounded to depth32float. A large excursion is not normal rounding: it
    // means the world-space area calculation became ill-conditioned.
    let minimumWeight = min(min(barycentrics.x, barycentrics.y), barycentrics.z);
    let maximumWeight = max(max(barycentrics.x, barycentrics.y), barycentrics.z);
    return minimumWeight < -0.01f || maximumWeight > 1.01f;
}

fn edgeFunction(a: vec2f, b: vec2f, point: vec2f) -> f32 {
    return (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
}

// This is a numerical fallback, not a replacement for the assignment's
// world-space barycentric reconstruction above. Sponza contains a few very
// thin world-space triangles. Their squared world area can be so small that a
// depth32float round-off moves the reconstructed point far outside the
// triangle numerically, despite the rasterizer correctly covering the pixel.
//
// Screen-space affine weights describe that exact rasterization plane. Divide
// each by clip.w and normalize to turn them into the perspective-correct
// interpolation weights used for UVs and normals by the normal fragment path.
fn calculatePerspectiveBarycentrics(
    pixel: vec2u,
    clipA: vec4f,
    clipB: vec4f,
    clipC: vec4f,
) -> vec3f {
    let ndcA = clipA.xy / clipA.w;
    let ndcB = clipB.xy / clipB.w;
    let ndcC = clipC.xy / clipC.w;
    let signedDoubleArea = edgeFunction(ndcA, ndcB, ndcC);
    if (abs(signedDoubleArea) <= 1e-12f) {
        return vec3f(-1.f);
    }

    let pointNdc = pixelCenterNdc(pixel);
    let affineA = edgeFunction(ndcB, ndcC, pointNdc) / signedDoubleArea;
    let affineB = edgeFunction(ndcC, ndcA, pointNdc) / signedDoubleArea;
    let affineC = 1.f - affineA - affineB;
    let perspectiveUnnormalized = vec3f(
        affineA / clipA.w,
        affineB / clipB.w,
        affineC / clipC.w,
    );
    let denominator = perspectiveUnnormalized.x
        + perspectiveUnnormalized.y
        + perspectiveUnnormalized.z;
    if (abs(denominator) <= 1e-12f) {
        return vec3f(-1.f);
    }
    return perspectiveUnnormalized / denominator;
}

fn normalizedBarycentrics(barycentrics: vec3f) -> vec3f {
    // Clamp only edge-scale round-off, after rejecting genuinely invalid
    // values with barycentricsNeedFallback(). This avoids a dark/garbled
    // material sample from a tiny -epsilon UV extrapolation at triangle seams.
    let nonNegative = max(barycentrics, vec3f(0.f));
    let sum = nonNegative.x + nonNegative.y + nonNegative.z;
    return nonNegative / sum;
}

fn encodedVisibilityDebugColor(encodedVisibility: u32) -> vec3f {
    // Keep every covered pixel visibly non-black while retaining enough Object
    // and Triangle variation to reveal whether the geometry pass wrote IDs
    // across the expected scene coverage.
    let packedVisibility = encodedVisibility - 1u;
    let triangleMask = (1u << ${visibilityTriangleIdBits}u) - 1u;
    let triangleId = packedVisibility & triangleMask;
    let objectId = packedVisibility >> ${visibilityTriangleIdBits}u;
    return vec3f(
        0.2f + 0.8f * f32(objectId % 17u) / 16.f,
        0.2f + 0.8f * f32((triangleId >> 4u) % 17u) / 16.f,
        0.2f + 0.8f * f32(triangleId % 17u) / 16.f,
    );
}

@compute @workgroup_size(${deferredLightingWorkgroupSize}, ${deferredLightingWorkgroupSize})
fn main(@builtin(global_invocation_id) globalId: vec3u) {
    let dimensions = textureDimensions(depthBuffer);
    if (globalId.x >= dimensions.x || globalId.y >= dimensions.y) {
        return;
    }

    let pixel = globalId.xy;
    let pixelCoord = vec2i(i32(pixel.x), i32(pixel.y));
    let depth = textureLoad(depthBuffer, pixelCoord, 0);
    let encodedVisibility = textureLoad(visibilityBuffer, pixelCoord, 0).x;
    if (depth >= 1.f || encodedVisibility == 0u) {
        // The attachment clear and the depth clear together identify pixels
        // that have no visible geometry, so avoid all storage/texture work.
        textureStore(outputTexture, pixelCoord, vec4f(0.f, 0.f, 0.f, 1.f));
        return;
    }

    if (visibilityDebug.mode == 1u) {
        // This stops immediately after reading the two geometry attachments.
        // If the scene is covered here, black pixels in normal mode originate
        // after ObjectID/TriangleID production rather than in the G-buffer.
        textureStore(outputTexture, pixelCoord, vec4f(encodedVisibilityDebugColor(encodedVisibility), 1.f));
        return;
    }

    // Undo the non-zero background encoding before extracting the two fields.
    let packedVisibility = encodedVisibility - 1u;
    let triangleMask = (1u << ${visibilityTriangleIdBits}u) - 1u;
    let triangleId = packedVisibility & triangleMask;
    let objectId = packedVisibility >> ${visibilityTriangleIdBits}u;
    if (objectId >= arrayLength(&visibilityObjects)) {
        // A bad ID should never occur after host-side validation. Keeping this
        // guard makes a corrupted attachment fail visibly rather than read
        // beyond a storage binding, which would make debugging ambiguous.
        // Red means that the packed ObjectID did not name an object record.
        textureStore(outputTexture, pixelCoord, vec4f(1.f, 0.f, 0.f, 1.f));
        return;
    }

    let object = visibilityObjects[objectId];
    if (triangleId >= object.indexCount / 3u) {
        // Yellow means primitive_index was not local to this indexed draw, or
        // the producer and consumer disagree about one primitive's size.
        textureStore(outputTexture, pixelCoord, vec4f(1.f, 1.f, 0.f, 1.f));
        return;
    }
    let triangleIndexOffset = object.indexOffset + triangleId * 3u;
    if (triangleIndexOffset + 2u >= arrayLength(&visibilityIndices)) {
        // Orange is a global concatenation error. It should be unreachable
        // after the local indexCount check above, but is kept as a hard guard.
        textureStore(outputTexture, pixelCoord, vec4f(1.f, 0.5f, 0.f, 1.f));
        return;
    }

    let indexA = visibilityIndices[triangleIndexOffset];
    let indexB = visibilityIndices[triangleIndexOffset + 1u];
    let indexC = visibilityIndices[triangleIndexOffset + 2u];
    if (indexA >= object.vertexCount || indexB >= object.vertexCount || indexC >= object.vertexCount) {
        // Cyan means an index escaped its own primitive's vertex range. It is
        // checked before scalar vertex-buffer loads to keep the failure safe.
        textureStore(outputTexture, pixelCoord, vec4f(0.f, 1.f, 1.f, 1.f));
        return;
    }
    let localA = loadVisibilityVertex(object.vertexFloatOffset, indexA);
    let localB = loadVisibilityVertex(object.vertexFloatOffset, indexB);
    let localC = loadVisibilityVertex(object.vertexFloatOffset, indexC);

    let worldA = (object.modelMat * vec4f(localA.position, 1.f)).xyz;
    let worldB = (object.modelMat * vec4f(localB.position, 1.f)).xyz;
    let worldC = (object.modelMat * vec4f(localC.position, 1.f)).xyz;
    let position = reconstructWorldPosition(pixel, depth);
    let worldBarycentrics = calculateBarycentrics(position, worldA, worldB, worldC);
    var barycentrics = worldBarycentrics;
    if (barycentricsNeedFallback(worldBarycentrics)) {
        // Preserve the requested world-space method in the common case, and
        // use the screen-space path only when tiny world-area triangles make
        // that method unreliable at depth32float precision. Keeping these
        // three extra matrix multiplies inside the rare branch preserves the
        // intended bandwidth/per-pixel-work advantage of normal operation.
        let clipA = cameraUniforms.viewProjMat * vec4f(worldA, 1.f);
        let clipB = cameraUniforms.viewProjMat * vec4f(worldB, 1.f);
        let clipC = cameraUniforms.viewProjMat * vec4f(worldC, 1.f);
        barycentrics = calculatePerspectiveBarycentrics(pixel, clipA, clipB, clipC);
    }
    if (barycentricsNeedFallback(barycentrics)) {
        // Magenta now has one precise meaning: neither numerically stable
        // reconstruction could recover valid weights for a covered pixel.
        textureStore(outputTexture, pixelCoord, vec4f(1.f, 0.f, 1.f, 1.f));
        return;
    }
    barycentrics = normalizedBarycentrics(barycentrics);

    if (visibilityDebug.mode == 2u) {
        textureStore(outputTexture, pixelCoord, vec4f(barycentrics, 1.f));
        return;
    }

    let localNormal = barycentrics.x * localA.normal
        + barycentrics.y * localB.normal
        + barycentrics.z * localC.normal;
    let normal = normalize((object.normalMat * vec4f(localNormal, 0.f)).xyz);
    let uv = barycentrics.x * localA.uv + barycentrics.y * localB.uv + barycentrics.z * localC.uv;
    // The assignment explicitly allows LOD 0 texture sampling for this extra
    // credit. A production implementation would derive or estimate gradients.
    // texture_2d_array keeps UV and array layer as separate arguments. Unlike
    // texture_3d, the layer is an integer selector rather than the third
    // normalized coordinate component; using vec3f here would invalidate the
    // complete compute shader module before any invocation can run.
    let albedo = textureSampleLevel(
        visibilityMaterialTextures,
        visibilityMaterialSampler,
        uv,
        i32(object.materialLayer),
        0.f,
    ).rgb;

    if (visibilityDebug.mode == 3u) {
        // This isolates ID decode, index/vertex loads, interpolation, and
        // texture-array lookup from clustered-lighting behavior.
        textureStore(outputTexture, pixelCoord, vec4f(albedo, 1.f));
        return;
    }

    let clusterIndex = clusterIndexForPixel(pixel, position);
    let cluster = clusterMetadata[clusterIndex];
    var totalLightContrib = vec3f(0.f);
    if (clusterOverflowFlags[clusterIndex] != 0u) {
        // Preserve Forward+ and packed deferred correctness when a fixed
        // cluster list overflows: evaluate every light for that one cluster.
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
