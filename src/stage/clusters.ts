import { device } from "../renderer";
import { defaultClusterGridConfig, ClusterGridConfig } from "./cluster_config";
import {
    createClusterMetadata,
    createClusterOverflowFlags,
    createLightIndexList,
    ClusterMetadataGpuLayout,
    ClusterOverflowGpuLayout,
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
    private readonly fixedMetadata: Uint32Array<ArrayBuffer>;

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
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        this.lightIndexStorageBuffer = device.createBuffer({
            label: "cluster light indices",
            size: lightIndices.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.overflowStorageBuffer = device.createBuffer({
            label: "cluster overflow flags",
            size: overflowFlags.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        device.queue.writeBuffer(this.metadataStorageBuffer, 0, metadata);
        device.queue.writeBuffer(this.overflowStorageBuffer, 0, overflowFlags);
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
            device.queue.writeBuffer(this.metadataStorageBuffer, 0, this.fixedMetadata);
        }
    }

    //prevent multiple readbacks(like clicked twice and more) in flight, 
    //which would be a waste of bandwidth and could cause race conditions
    private diagnosticReadPending = false;

    /** One opt-in readback, outside the per-frame timing path. */
    async readDiagnosticBuffers(): Promise<{ metadata: Uint32Array; overflow: Uint32Array }> {
        if (this.diagnosticReadPending) {
            throw new Error('Cluster diagnostic readback is already pending.');
        }
        this.diagnosticReadPending = true;
        const metadataBytes = this.dimensions.clusterCount * ClusterMetadataGpuLayout.byteStride;
        const overflowBytes = this.dimensions.clusterCount * ClusterOverflowGpuLayout.byteStride;
        //CPU-readback buffers
        const metadataRead = device.createBuffer({
            size: metadataBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const overflowRead = device.createBuffer({
            size: overflowBytes,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
            const encoder = device.createCommandEncoder({ label: 'Cluster diagnostic copy' });
            //resolve
            encoder.copyBufferToBuffer(this.metadataStorageBuffer, 0, metadataRead, 0, metadataBytes);
            encoder.copyBufferToBuffer(this.overflowStorageBuffer, 0, overflowRead, 0, overflowBytes);
            device.queue.submit([encoder.finish()]);
            await Promise.all([
                metadataRead.mapAsync(GPUMapMode.READ),
                overflowRead.mapAsync(GPUMapMode.READ),
            ]);
            return {
                metadata: new Uint32Array(metadataRead.getMappedRange().slice(0)),
                overflow: new Uint32Array(overflowRead.getMappedRange().slice(0)),
            };
        } finally {
            if (metadataRead.mapState === 'mapped') metadataRead.unmap();
            if (overflowRead.mapState === 'mapped') overflowRead.unmap();
            metadataRead.destroy();
            overflowRead.destroy();
            this.diagnosticReadPending = false;
        }
    }

    private validateStorageBufferSize(byteSize: number, label: string): void {
        //Per-buffer Binding Limit，128MB is commonly used
        if (byteSize > device.limits.maxStorageBufferBindingSize) {
            throw new Error(`${label} exceeds maxStorageBufferBindingSize.`);
        }
    }
}
