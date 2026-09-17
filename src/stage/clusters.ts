import { device } from "../renderer";
import { defaultClusterGridConfig, ClusterGridConfig } from "./cluster_config";
import {
    createClusterMetadata,
    createClusterOverflowFlags,
    createLightIndexList,
    writeClusterMetadata,
} from "./gpu_layouts";

export interface ClusterDimensions {
    tilesX: number;
    tilesY: number;
    depthSliceCount: number;
    clusterCount: number;
    maxLightsPerCluster: number;
    lightIndexCapacity: number;
}

export type ClusterCapacityStrategy = "fixed" | "adaptive";

/**
 * Shared cluster-list storage for Forward+ and clustered deferred rendering.
 * Fixed lists reserve a uniform range per cluster. Adaptive lists compact the
 * same total index pool every frame, giving dense clusters unused space from
 * sparse clusters without creating an unbounded per-cluster allocation.
 */
export class Clusters {
    readonly dimensions: ClusterDimensions;
    readonly metadataStorageBuffer: GPUBuffer;
    readonly lightIndexStorageBuffer: GPUBuffer;
    readonly overflowStorageBuffer: GPUBuffer;
    capacityStrategy: ClusterCapacityStrategy = "fixed";
    private readonly fixedMetadata: Uint32Array;

    constructor(viewportWidth: number, viewportHeight: number, config: Readonly<ClusterGridConfig> = defaultClusterGridConfig) {
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            throw new Error("Cluster viewport dimensions must be positive.");
        }

        const tilesX = Math.ceil(viewportWidth / config.tileSizePixels);
        const tilesY = Math.ceil(viewportHeight / config.tileSizePixels);
        const clusterCount = tilesX * tilesY * config.depthSliceCount;
        const lightIndexCapacity = clusterCount * config.maxLightsPerCluster;

        this.dimensions = {
            tilesX,
            tilesY,
            depthSliceCount: config.depthSliceCount,
            clusterCount,
            maxLightsPerCluster: config.maxLightsPerCluster,
            lightIndexCapacity,
        };

        const metadata = createClusterMetadata(clusterCount);
        for (let clusterIndex = 0; clusterIndex < clusterCount; ++clusterIndex) {
            writeClusterMetadata(
                metadata,
                clusterIndex,
                clusterIndex * config.maxLightsPerCluster,
                config.maxLightsPerCluster,
                0,
                0,
            );
        }
        const overflowFlags = createClusterOverflowFlags(clusterCount);
        const lightIndices = createLightIndexList(lightIndexCapacity);
        this.fixedMetadata = metadata;

        this.validateStorageBufferSize(metadata.byteLength, "cluster metadata");
        this.validateStorageBufferSize(overflowFlags.byteLength, "cluster overflow flags");
        this.validateStorageBufferSize(lightIndices.byteLength, "cluster light indices");

        this.metadataStorageBuffer = device.createBuffer({
            label: "cluster metadata",
            size: metadata.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.lightIndexStorageBuffer = device.createBuffer({
            label: "cluster light indices",
            size: lightIndices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.overflowStorageBuffer = device.createBuffer({
            label: "cluster overflow flags",
            size: overflowFlags.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        device.queue.writeBuffer(this.metadataStorageBuffer, 0, metadata.buffer as ArrayBuffer);
        device.queue.writeBuffer(this.overflowStorageBuffer, 0, overflowFlags.buffer as ArrayBuffer);
    }

    /**
     * Fixed preserves the original per-cluster capacity. Adaptive performs a
     * count, compact-prefix, and fill sequence over the shared global pool.
     */
    setCapacityStrategy(strategy: ClusterCapacityStrategy): void {
        this.capacityStrategy = strategy;
        if (strategy === "fixed") {
            // Adaptive prefixing overwrites offsets and capacities every frame.
            // Restore fixed-stride metadata before returning to the baseline path.
            device.queue.writeBuffer(this.metadataStorageBuffer, 0, this.fixedMetadata.buffer as ArrayBuffer);
        }
    }

    private validateStorageBufferSize(byteSize: number, label: string): void {
        //Per-buffer Binding Limit，128MB is commonly used
        if (byteSize > device.limits.maxStorageBufferBindingSize) {
            throw new Error(`${label} exceeds maxStorageBufferBindingSize.`);
        }
    }
}
