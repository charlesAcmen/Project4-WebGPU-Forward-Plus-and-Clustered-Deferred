import { RollingStatsWindow, type RollingWindowSnapshot } from './rolling_window';
import { GpuFrameRecorder, GpuTimer, type GpuTimingSample } from './gpu_timer';
import type { Clusters } from '../stage/clusters';
import { ClusterMetadataGpuLayout } from '../stage/gpu_layouts';

//click the cluster snap shot button,and takes a screen shot lol
export interface ClusterDiagnosticSnapshot {
    strategy: 'fixed' | 'adaptive';
    activeClusters: number;
    totalClusters: number;
    acceptedMean: number;
    acceptedMedian: number;
    acceptedP95: number;
    acceptedMax: number;
    candidateMax: number;
    overflowClusters: number;
    droppedReferences: number;
    poolUsed: number;
    poolCapacity: number;
}

export interface CpuFrameSnapshot {
    status: 'WARMING UP' | 'ACTIVE' | 'UNAVAILABLE' | 'PAUSED';
    epoch: number;
    warmupFramesRemaining: number;
    frameIntervalMs: RollingWindowSnapshot;
    cpuUpdateMs: RollingWindowSnapshot;
    cpuEncodeSubmitMs: RollingWindowSnapshot;
    rendererGpuMs: RollingWindowSnapshot;
    passBusySumMs: RollingWindowSnapshot;
    gpuPassesMs: Record<string, RollingWindowSnapshot>;
    droppedGpuSamples: number;
}

/** CPU-only samples; none of these durations measure GPU execution or display. */
export class PerformanceProfiler {
    private readonly frameInterval = new RollingStatsWindow();
    private readonly cpuUpdate = new RollingStatsWindow();
    private readonly cpuEncodeSubmit = new RollingStatsWindow();
    private readonly rendererGpu = new RollingStatsWindow();
    private readonly passBusySum = new RollingStatsWindow();
    private readonly gpuPasses = new Map<string, RollingStatsWindow>();
    private gpuTimer: GpuTimer | undefined;
    private enabled = true;
    private diagnosticPending = false;
    private frameId = 0;
    private lastAcceptedGpuFrameId = 0;
    private profileThisFrame = false;
    private mode: string | undefined;
    private strategy: string | undefined;
    private lightCount: number | undefined;
    private width: number | undefined;
    private height: number | undefined;
    private previousFrameTimeMs: number | undefined;
    private pendingFrameIntervalMs: number | undefined;
    private firstValidFrameTimeMs: number | undefined;
    private warmupFramesRemaining = 30;

    enableGpuTiming(device: GPUDevice): void {
        if (device.features.has('timestamp-query')) {
            this.gpuTimer = new GpuTimer(device, sample => this.acceptGpuSample(sample));
        }
    }

    setEnabled(enabled: boolean): void {
        if (enabled !== this.enabled) {
            this.enabled = enabled;
            this.reset();
        }
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    beginGpuFrame(): GpuFrameRecorder | undefined {
        return this.profileThisFrame && this.enabled
            ? this.gpuTimer?.begin(this.rendererGpu.currentEpoch, this.frameId)
            : undefined;
    }

    setMode(mode: string): void {
        if (mode !== this.mode) {
            if (this.mode !== undefined) {
                this.reset();
            }
            this.mode = mode;
        }
    }

    resetForExternalChange(): void {
        this.reset();
    }

    beginFrame(
        timeMs: number,
        mode: string,
        strategy: string,
        lightCount: number,
        width: number,
        height: number,
    ): boolean {
        this.frameId += 1;
        this.profileThisFrame = false;
        if (
            mode !== this.mode || strategy !== this.strategy ||
            lightCount !== this.lightCount || width !== this.width || height !== this.height
        ) {
            this.reset();
            this.mode = mode;
            this.strategy = strategy;
            this.lightCount = lightCount;
            this.width = width;
            this.height = height;
        }

        const intervalMs = this.previousFrameTimeMs === undefined
            ? undefined
            : timeMs - this.previousFrameTimeMs;
        this.previousFrameTimeMs = timeMs;
        this.pendingFrameIntervalMs = undefined;

        if (!this.enabled || this.diagnosticPending) {
            return false;
        }

        if (this.warmupFramesRemaining > 0) {
            this.warmupFramesRemaining -= 1;
            return false;
        }
        if (intervalMs === undefined || !Number.isFinite(intervalMs) || intervalMs <= 0) {
            return false;
        }

        this.pendingFrameIntervalMs = intervalMs;
        this.profileThisFrame = true;
        return true;
    }

    endFrame(timeMs: number, cpuUpdateMs: number, cpuEncodeSubmitMs: number, lightCount: number): void {
        // The release governor can change the light count inside Lights.onFrame().
        // Do not attribute that transition frame to either configuration.
        if (lightCount !== this.lightCount) {
            this.reset();
            this.lightCount = lightCount;
            return;
        }
        const intervalMs = this.pendingFrameIntervalMs;
        this.pendingFrameIntervalMs = undefined;
        if (intervalMs === undefined) {
            return;
        }
        if (
            !Number.isFinite(cpuUpdateMs) || cpuUpdateMs < 0 ||
            !Number.isFinite(cpuEncodeSubmitMs) || cpuEncodeSubmitMs < 0
        ) {
            return;
        }

        this.firstValidFrameTimeMs ??= timeMs;
        this.frameInterval.addSample(timeMs, intervalMs);
        this.cpuUpdate.addSample(timeMs, cpuUpdateMs);
        this.cpuEncodeSubmit.addSample(timeMs, cpuEncodeSubmitMs);
    }

    snapshot(timeMs: number, includeGpuPasses = false): CpuFrameSnapshot {
        const gpuPassesMs: Record<string, RollingWindowSnapshot> = {};
        if (includeGpuPasses) {
            for (const [name, window] of this.gpuPasses) {
                gpuPassesMs[name] = window.snapshot(timeMs);
            }
        }
        const rendererGpuMs = this.rendererGpu.snapshot(timeMs);
        return {
            status: !this.enabled || this.diagnosticPending ? 'PAUSED' : !this.gpuTimer ? 'UNAVAILABLE' :
                this.warmupFramesRemaining > 0 ||
                this.firstValidFrameTimeMs === undefined ||
                timeMs - this.firstValidFrameTimeMs < 1000 ||
                rendererGpuMs.sampleCount === 0
                ? 'WARMING UP' : 'ACTIVE',
            epoch: this.frameInterval.currentEpoch,
            warmupFramesRemaining: this.warmupFramesRemaining,
            frameIntervalMs: this.frameInterval.snapshot(timeMs),
            cpuUpdateMs: this.cpuUpdate.snapshot(timeMs),
            cpuEncodeSubmitMs: this.cpuEncodeSubmit.snapshot(timeMs),
            rendererGpuMs,
            passBusySumMs: this.passBusySum.snapshot(timeMs),
            gpuPassesMs,
            droppedGpuSamples: this.gpuTimer?.droppedSamples ?? 0,
        };
    }

    async captureClusterDiagnostics(clusters: Clusters): Promise<ClusterDiagnosticSnapshot | undefined> {
        if (this.diagnosticPending) {
            return undefined;
        }
        this.diagnosticPending = true;
        this.reset();
        const epoch = this.rendererGpu.currentEpoch;
        try {
            const { metadata, overflow } = await clusters.readDiagnosticBuffers();
            if (epoch !== this.rendererGpu.currentEpoch) {
                return undefined;
            }
            const acceptedActive: number[] = [];
            let acceptedSum = 0;
            let acceptedMax = 0;
            let candidateMax = 0;
            let droppedReferences = 0;
            let overflowClusters = 0;
            const stride = ClusterMetadataGpuLayout.uint32sPerCluster;
            for (let index = 0; index < clusters.dimensions.clusterCount; index += 1) {
                const accepted = metadata[index * stride + ClusterMetadataGpuLayout.lightCountUint32Offset];
                const candidate = metadata[index * stride + ClusterMetadataGpuLayout.candidateLightCountUint32Offset];
                if (accepted > 0) acceptedActive.push(accepted);
                acceptedSum += accepted;
                acceptedMax = Math.max(acceptedMax, accepted);
                candidateMax = Math.max(candidateMax, candidate);
                droppedReferences += Math.max(0, candidate - accepted);
                overflowClusters += overflow[index] !== 0 ? 1 : 0;
            }
            acceptedActive.sort((a, b) => a - b);
            const count = acceptedActive.length;
            return {
                strategy: clusters.capacityStrategy,
                activeClusters: count,
                totalClusters: clusters.dimensions.clusterCount,
                acceptedMean: count === 0 ? 0 : acceptedSum / count,
                acceptedMedian: count === 0 ? 0 :
                    (acceptedActive[Math.floor((count - 1) / 2)] + acceptedActive[Math.floor(count / 2)]) / 2,
                acceptedP95: count === 0 ? 0 : acceptedActive[Math.ceil(0.95 * count) - 1],
                acceptedMax,
                candidateMax,
                overflowClusters,
                droppedReferences,
                poolUsed: acceptedSum,
                poolCapacity: clusters.dimensions.lightIndexCapacity,
            };
        } finally {
            this.reset();
            this.diagnosticPending = false;
        }
    }

    private acceptGpuSample(sample: GpuTimingSample): void {
        if (!this.enabled || sample.epoch !== this.rendererGpu.currentEpoch ||
            sample.frameId <= this.lastAcceptedGpuFrameId) {
            return;
        }
        this.lastAcceptedGpuFrameId = sample.frameId;
        const arrivalTimeMs = performance.now();
        this.rendererGpu.addSample(arrivalTimeMs, sample.rendererGpuMs);
        this.passBusySum.addSample(arrivalTimeMs, sample.passBusySumMs);
        for (const [name, durationMs] of Object.entries(sample.passes)) {
            let window = this.gpuPasses.get(name);
            if (!window) {
                window = new RollingStatsWindow();
                this.gpuPasses.set(name, window);
            }
            window.addSample(arrivalTimeMs, durationMs);
        }
    }

    private reset(): void {
        this.frameInterval.reset();
        this.cpuUpdate.reset();
        this.cpuEncodeSubmit.reset();
        this.rendererGpu.reset();
        this.passBusySum.reset();
        this.gpuPasses.clear();
        this.previousFrameTimeMs = undefined;
        this.pendingFrameIntervalMs = undefined;
        this.firstValidFrameTimeMs = undefined;
        this.warmupFramesRemaining = 30;
        this.profileThisFrame = false;
        this.lastAcceptedGpuFrameId = 0;
    }
}
