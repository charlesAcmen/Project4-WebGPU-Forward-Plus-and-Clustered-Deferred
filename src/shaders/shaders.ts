// CHECKITOUT: this file loads all the shaders and preprocesses them with some common code

import { Camera } from '../stage/camera';
import { defaultClusterGridConfig } from '../stage/cluster_config';

import commonRaw from './common.wgsl?raw';

import naiveVertRaw from './naive.vs.wgsl?raw';
import naiveFragRaw from './naive.fs.wgsl?raw';

import forwardPlusFragRaw from './forward_plus.fs.wgsl?raw';

import clusteredDeferredFragRaw from './clustered_deferred.fs.wgsl?raw';
import clusteredDeferredFullscreenVertRaw from './clustered_deferred_fullscreen.vs.wgsl?raw';
import clusteredDeferredFullscreenFragRaw from './clustered_deferred_fullscreen.fs.wgsl?raw';

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

    lightRadius: 2,
    clusterTileSizePixels: defaultClusterGridConfig.tileSizePixels,
    clusterDepthSliceCount: defaultClusterGridConfig.depthSliceCount,
    maxLightsPerCluster: defaultClusterGridConfig.maxLightsPerCluster,
};

// =================================

function evalShaderRaw(raw: string) {
    return eval('`' + raw.replaceAll('${', '${constants.') + '`');
}

const commonSrc: string = evalShaderRaw(commonRaw);

function processShaderRaw(raw: string) {
    return commonSrc + evalShaderRaw(raw);
}

function processClusteringShaderRaw(raw: string) {
    return commonSrc + evalShaderRaw(clusteringCommonRaw) + evalShaderRaw(raw);
}

export const naiveVertSrc: string = processShaderRaw(naiveVertRaw);
export const naiveFragSrc: string = processShaderRaw(naiveFragRaw);

export const forwardPlusFragSrc: string = processShaderRaw(forwardPlusFragRaw);

export const clusteredDeferredFragSrc: string = processShaderRaw(clusteredDeferredFragRaw);
export const clusteredDeferredFullscreenVertSrc: string = processShaderRaw(clusteredDeferredFullscreenVertRaw);
export const clusteredDeferredFullscreenFragSrc: string = processShaderRaw(clusteredDeferredFullscreenFragRaw);

export const moveLightsComputeSrc: string = processShaderRaw(moveLightsComputeRaw);
export const clusteringComputeSrc: string = processClusteringShaderRaw(clusteringComputeRaw);
export const adaptiveClusteringComputeSrc: string = processClusteringShaderRaw(adaptiveClusteringComputeRaw);
