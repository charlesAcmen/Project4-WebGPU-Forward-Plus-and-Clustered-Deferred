/**
 * Canonical CPU-side descriptions of the buffers consumed by common.wgsl.
 * Keep offsets and strides here synchronized with the handwritten WGSL structs.
 */

export const CameraGpuLayout = {
    viewProjMatFloatOffset: 0,//视图投影复合矩阵,4x4矩阵,16个float
    viewProjMatFloatCount: 16,
    viewMatFloatOffset: 16,//视图矩阵(世界坐标->观察空间)
    // Inverse(viewProj). Packed deferred compute uses this to reconstruct
    // world-space positions from the sampled depth buffer.
    inverseViewProjMatFloatOffset: 32,
    //投影参数,4个float:
    //near plane, far plane, tan(fovY/2), aspect ratio in vec4f
    projectionParamsFloatOffset: 48,
    //视口参数,4个float:
    //viewport width, viewport height, 1/width, 1/height in vec4f
    viewportFloatOffset: 52,
    float32Count: 56,
    byteSize: 224,
} as const;

/**
 * CPU-to-WGSL ABI for ModelUniforms in common.wgsl. Normals require the
 * inverse-transpose transform when a model has non-uniform scale.
 */
export const ModelGpuLayout = {
    modelMatFloatOffset: 0,
    normalMatFloatOffset: 16,
    float32Count: 32,
    byteSize: 128,
} as const;

export const LightGpuLayout = {
    //vec3f position, 1 float padding
    positionFloatOffset: 0,
    //vec3f color, 1 float padding
    colorFloatOffset: 4,
    float32sPerLight: 8,
    byteStride: 32,
} as const;

export const LightSetGpuLayout = {
    //numLights:uint32,12 bytes padding
    numLightsOffset: 0,
    headerByteSize: 16,
    //light records start here, each record is LightGpuLayout.byteStride bytes
    lightsByteOffset: 16,
} as const;

export const ClusterMetadataGpuLayout = {
    //first 4 bytes: light index offset (uint32) into LightIndexList
    //not value itself,but index into it.
    lightIndexOffsetUint32Offset: 0,
    //next 4 bytes: allocated index capacity for this cluster (uint32)
    lightIndexCapacityUint32Offset: 1,
    //next 4 bytes: number of valid light indices written this frame (uint32)
    lightCountUint32Offset: 2,
    //next 4 bytes: total light intersections before adaptive compaction (uint32)
    candidateLightCountUint32Offset: 3,
    uint32sPerCluster: 4,
    byteStride: 16,
} as const;

export const LightIndexListGpuLayout = {
    //flat huge list of light indices shared by all clusters.
    uint32sPerLightIndex: 1,
    byteStride: 4,
} as const;

export const ClusterOverflowGpuLayout = {
    //compute shader flags as 1.
    uint32sPerCluster: 1,
    byteStride: 4,
} as const;

export function createCameraUniformData(): Float32Array<ArrayBuffer> {
    return new Float32Array(CameraGpuLayout.byteSize / Float32Array.BYTES_PER_ELEMENT);
}
// ArrayLike<number>:.length & index access
export function writeCameraViewProjection(target: Float32Array, matrix: ArrayLike<number>): void {
    if (target.byteLength !== CameraGpuLayout.byteSize) {
        throw new Error("Camera uniform data must match CameraGpuLayout.byteSize.");
    }
    if (matrix.length !== CameraGpuLayout.viewProjMatFloatCount) {
        throw new Error("Camera view-projection matrix must contain 16 floats.");
    }
    target.set(matrix, CameraGpuLayout.viewProjMatFloatOffset);
}

export function writeCameraView(target: Float32Array, matrix: ArrayLike<number>): void {
    if (matrix.length !== CameraGpuLayout.viewProjMatFloatCount) {
        throw new Error("Camera view matrix must contain 16 floats.");
    }
    target.set(matrix, CameraGpuLayout.viewMatFloatOffset);
}

export function writeCameraInverseViewProjection(target: Float32Array, matrix: ArrayLike<number>): void {
    if (matrix.length !== CameraGpuLayout.viewProjMatFloatCount) {
        throw new Error("Camera inverse view-projection matrix must contain 16 floats.");
    }
    target.set(matrix, CameraGpuLayout.inverseViewProjMatFloatOffset);
}

export function writeCameraClusteringParams(
    target: Float32Array,
    nearPlane: number,
    farPlane: number,
    tanHalfFovY: number,
    aspectRatio: number,
    viewportWidth: number,
    viewportHeight: number,
): void {
    //[]:Array Literal
    target.set([nearPlane, farPlane, tanHalfFovY, aspectRatio], CameraGpuLayout.projectionParamsFloatOffset);
    target.set([viewportWidth, viewportHeight, 1 / viewportWidth, 1 / viewportHeight], CameraGpuLayout.viewportFloatOffset);
}

export function createModelUniformData(): Float32Array<ArrayBuffer> {
    return new Float32Array(ModelGpuLayout.float32Count);
}

export function writeModelUniforms(
    target: Float32Array,
    modelMat: ArrayLike<number>,
    normalMat: ArrayLike<number>,
): void {
    if (target.byteLength !== ModelGpuLayout.byteSize) {
        throw new Error("Model uniform data must match ModelGpuLayout.byteSize.");
    }
    if (modelMat.length !== 16 || normalMat.length !== 16) {
        throw new Error("Model and normal matrices must each contain 16 floats.");
    }
    target.set(modelMat, ModelGpuLayout.modelMatFloatOffset);
    target.set(normalMat, ModelGpuLayout.normalMatFloatOffset);
}
//return Float32Array:single precision floating point array
export function createLightRecordData(maxNumLights: number): Float32Array<ArrayBuffer> {
    return new Float32Array(maxNumLights * LightGpuLayout.float32sPerLight);
}

export function writeLightColor(records: Float32Array, lightIndex: number, color: ArrayLike<number>): void {
    if (color.length !== 3) {
        throw new Error("Light color must contain three floats.");
    }
    const base = lightIndex * LightGpuLayout.float32sPerLight;
    records.set(color, base + LightGpuLayout.colorFloatOffset);
}
//return Uint32Array:unsigned 32-bit integer array
export function getLightSetByteSize(maxNumLights: number): number {
    return LightSetGpuLayout.headerByteSize + (maxNumLights * LightGpuLayout.byteStride);
}

export function createLightSetHeader(): Uint32Array<ArrayBuffer> {
    return new Uint32Array(LightSetGpuLayout.headerByteSize / Uint32Array.BYTES_PER_ELEMENT);
}

export function writeLightSetNumLights(header: Uint32Array, numLights: number): void {
    if (header.byteLength !== LightSetGpuLayout.headerByteSize) {
        throw new Error("Light-set header must match LightSetGpuLayout.headerByteSize.");
    }
    header[LightSetGpuLayout.numLightsOffset] = numLights;
}

export function createClusterMetadata(clusterCount: number): Uint32Array<ArrayBuffer> {
    return new Uint32Array(clusterCount * ClusterMetadataGpuLayout.uint32sPerCluster);
}

export function writeClusterMetadata(
    metadata: Uint32Array,
    clusterIndex: number,
    lightIndexOffset: number,
    lightIndexCapacity: number,
    lightCount: number,
    candidateLightCount: number,
): void {
    const base = clusterIndex * ClusterMetadataGpuLayout.uint32sPerCluster;
    metadata[base + ClusterMetadataGpuLayout.lightIndexOffsetUint32Offset] = lightIndexOffset;
    metadata[base + ClusterMetadataGpuLayout.lightIndexCapacityUint32Offset] = lightIndexCapacity;
    metadata[base + ClusterMetadataGpuLayout.lightCountUint32Offset] = lightCount;
    metadata[base + ClusterMetadataGpuLayout.candidateLightCountUint32Offset] = candidateLightCount;
}

export function createLightIndexList(lightIndexCapacity: number): Uint32Array<ArrayBuffer> {
    return new Uint32Array(lightIndexCapacity * LightIndexListGpuLayout.uint32sPerLightIndex);
}

export function createClusterOverflowFlags(clusterCount: number): Uint32Array<ArrayBuffer> {
    return new Uint32Array(clusterCount * ClusterOverflowGpuLayout.uint32sPerCluster);
}

export function writeLightIndex(lightIndexList: Uint32Array, destinationIndex: number, lightIndex: number): void {
    lightIndexList[destinationIndex] = lightIndex;
}
