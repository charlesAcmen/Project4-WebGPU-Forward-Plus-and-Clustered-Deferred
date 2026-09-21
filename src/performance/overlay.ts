import type { ClusterDiagnosticSnapshot, PerformanceProfiler } from './profiler';
import type { RollingWindowSnapshot } from './rolling_window';

function formatMs(window: RollingWindowSnapshot): string {
    return window.median === undefined || window.p95 === undefined
        ? '—'
        : `${window.median.toFixed(2)} / ${window.p95.toFixed(2)} ms`;
}

function setIfChanged(element: HTMLElement, value: string): void {
    if (element.textContent !== value) {
        element.textContent = value;
    }
}

/** Presentation only: no readback or measurement starts from the DOM. */
export class PerformanceOverlay {
    private readonly root = document.createElement('section');
    private readonly resolution = document.createElement('div');
    private readonly frameInterval = document.createElement('div');
    private readonly gpuFrame = document.createElement('div');
    private readonly status = document.createElement('div');
    private readonly details = document.createElement('details');
    private readonly detailsBody = document.createElement('pre');
    private visible = true;
    private diagnosticEpoch: number | undefined;
    private diagnosticText = '';

    constructor(private readonly profiler: PerformanceProfiler, private readonly canvas: HTMLCanvasElement) {
        this.root.className = 'performance-overlay';
        this.root.setAttribute('aria-label', 'Performance analysis');
        const summary = document.createElement('summary');
        summary.textContent = 'Details';
        this.details.append(summary, this.detailsBody);
        this.root.append(this.resolution, this.frameInterval, this.gpuFrame, this.status, this.details);
        document.body.appendChild(this.root);
        requestAnimationFrame(() => this.update());
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        this.root.hidden = !visible;
    }

    showClusterDiagnostics(snapshot: ClusterDiagnosticSnapshot): void {
        this.details.open = true;
        this.diagnosticEpoch = this.profiler.snapshot(performance.now()).epoch;
        this.diagnosticText = [
            `Cluster snapshot (${snapshot.strategy}):`,
            `  active / total: ${snapshot.activeClusters} / ${snapshot.totalClusters}`,
            `  accepted lights (active): mean ${snapshot.acceptedMean.toFixed(1)}, median ${snapshot.acceptedMedian.toFixed(1)}, p95 ${snapshot.acceptedP95}, max ${snapshot.acceptedMax}`,
            `  max candidate: ${snapshot.candidateMax}`,
            `  overflow clusters: ${snapshot.overflowClusters}`,
            `  dropped references: ${snapshot.droppedReferences}`,
            `  index pool: ${snapshot.poolUsed} / ${snapshot.poolCapacity}`,
        ].join('\n');
    }

    private update(): void {
        if (this.visible) {
            const snapshot = this.profiler.snapshot(performance.now(), this.details.open);
            if (this.diagnosticEpoch !== snapshot.epoch) {
                this.diagnosticText = '';
            }
            setIfChanged(this.resolution, `Resolution: ${this.canvas.width} × ${this.canvas.height}`);
            setIfChanged(this.frameInterval, `Frame interval median / p95: ${formatMs(snapshot.frameIntervalMs)}`);
            setIfChanged(this.gpuFrame, `GPU frame work median / p95: ${formatMs(snapshot.rendererGpuMs)}`);
            setIfChanged(this.status, `Timing status: ${snapshot.status}`);
            if (this.details.open) {
                const passes = Object.entries(snapshot.gpuPassesMs)
                    .map(([name, window]) => `  ${name}: ${formatMs(window)}`)
                    .join('\n');
                setIfChanged(this.detailsBody, [
                    `CPU update median / p95: ${formatMs(snapshot.cpuUpdateMs)}`,
                    `CPU encode + submit median / p95: ${formatMs(snapshot.cpuEncodeSubmitMs)}`,
                    `GPU pass sum median / p95: ${formatMs(snapshot.passBusySumMs)}`,
                    `Samples: frame ${snapshot.frameIntervalMs.sampleCount}, GPU ${snapshot.rendererGpuMs.sampleCount}`,
                    `Warmup frames remaining: ${snapshot.warmupFramesRemaining}`,
                    `Dropped GPU samples (ring full): ${snapshot.droppedGpuSamples}`,
                    `GPU passes:\n${passes || '  —'}`,
                    this.diagnosticText,
                ].join('\n'));
            }
        }
        requestAnimationFrame(() => this.update());
    }
}
