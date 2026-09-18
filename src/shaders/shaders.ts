// CHECKITOUT: this file loads all the shaders and preprocesses them with some common code

import { defaultClusterGridConfig } from '../stage/cluster_config';

import commonRaw from './common.wgsl?raw';

import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';

import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';

import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';
// The base three-MRT shaders above remain available for comparison. These two
// sources form the separate Extra Credit packed G-buffer implementation.
import clusteredDeferredPackedGBufferFragRaw from './clustered_deferred_packed_gbuffer.fs.wgsl?raw';
import clusteredDeferredLightingComputeRaw from './clustered_deferred_lighting.cs.wgsl?raw';

// Visibility Buffer is deliberately a third deferred path. Its geometry pass
// needs the optional WGSL primitive_index feature; its compute pass rebuilds
// attributes from these compact identity values and scene storage buffers.
import visibilityGBufferFragRaw from './visibility_gbuffer.fs.wgsl?raw';
import visibilityLightingComputeRaw from './visibility_lighting.cs.wgsl?raw';

import moveLightsComputeRaw from './move_lights.cs.wgsl?raw';
import clusteringCommonRaw from './clustering_common.wgsl?raw';
import clusteringComputeRaw from './clustering.cs.wgsl?raw';
import adaptiveClusteringComputeRaw from './clustering_adaptive.cs.wgsl?raw';

// CONSTANTS (for use in shaders)
// =================================

// CHECKITOUT: feel free to add more constants here and to refer to them in your shader code

// Note that these are declared in a somewhat roundabout way because otherwise minification will drop variables
// that are unused in host side code.
export const constants = {
    bindGroup_scene: 0,//camera projection matrix and lightSet buffer（once per frame）
    bindGroup_model: 1,//local translation, rotation matrix（once per switching 3d point）
    bindGroup_material: 2,//diffuse texuture and roughness texture（once per switching material）

    moveLightsWorkgroupSize: 128,
    clusteringWorkgroupSize: 64,
    deferredLightingWorkgroupSize: 8,

    // ObjectID occupies the upper 16 bits of the r32uint visibility target;
    // TriangleID occupies the lower 16. Keep this synchronized with scene.ts.
    visibilityTriangleIdBits: 16,

    lightRadius: 2,
    clusterTileSizePixels: defaultClusterGridConfig.tileSizePixels,
    clusterDepthSliceCount: defaultClusterGridConfig.depthSliceCount,
    maxLightsPerCluster: defaultClusterGridConfig.maxLightsPerCluster,
};

// =================================

type ShaderConstantName = keyof typeof constants;

// WGSL files use ${name} placeholders for numeric pipeline constants. Do not
// evaluate them as JavaScript: production minification cannot see dynamic
// property reads inside eval(), so it may remove a constant such as lightRadius.
function expandShaderConstants(raw: string): string {
    return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(constants, name)) {
            throw new Error(`Unknown WGSL shader constant: ${placeholder}`);
        }
        return String(constants[name as ShaderConstantName]);
    });
}

const commonSrc: string = expandShaderConstants(commonRaw);

function processShaderRaw(raw: string) {
    return commonSrc + expandShaderConstants(raw);
}

function processPrimitiveIndexShaderRaw(raw: string) {
    // WGSL `enable` directives must appear before every declaration. common.wgsl
    // normally comes first, so this special processor emits the feature enable
    // before the shared structs and then appends the Visibility fragment code.
    return 'enable primitive_index;\n' + commonSrc + expandShaderConstants(raw);
}

function processClusteringShaderRaw(raw: string) {
    return commonSrc + expandShaderConstants(clusteringCommonRaw) + expandShaderConstants(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);
export const clusteredDeferredPackedGBufferFragSrc: string = processShaderRaw(clusteredDeferredPackedGBufferFragRaw);
export const clusteredDeferredLightingComputeSrc: string = processShaderRaw(clusteredDeferredLightingComputeRaw);
export const visibilityGBufferFragSrc: string = processPrimitiveIndexShaderRaw(visibilityGBufferFragRaw);
export const visibilityLightingComputeSrc: string = processShaderRaw(visibilityLightingComputeRaw);

export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const clusteringComputeSrc: string = processClusteringShaderRaw(clusteringComputeRaw);
export const adaptiveClusteringComputeSrc: string = processClusteringShaderRaw(adaptiveClusteringComputeRaw);
