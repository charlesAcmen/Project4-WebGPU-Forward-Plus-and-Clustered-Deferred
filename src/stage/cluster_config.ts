/**
 * Shared Forward+ grid policy. Shader constants are derived from this module so
 * host allocation and WGSL indexing cannot silently use different dimensions.
 */
export interface ClusterGridConfig {
    //horizontal or vertical width of a cluster tile in pixels.
    //in x and y axis.
    tileSizePixels: number;
    //Logarithmic/Exponential slicing of the view frustum along the depth axis.
    depthSliceCount: number;
    maxLightsPerCluster: number;
}

export const defaultClusterGridConfig: Readonly<ClusterGridConfig> = {
    tileSizePixels: 64,
    depthSliceCount: 24,
    maxLightsPerCluster: 128,
};
