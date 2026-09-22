import type { CpuFrameSample, PerformanceProfiler, ProfileSampleObserver, ClusterDiagnosticSnapshot } from './profiler';
import type { GpuTimingSample } from './gpu_timer';
import type { Clusters } from '../stage/clusters';

export interface TrialCondition {
    mode: string;
    strategy: string;
    lights: number;
    width: number;
    height: number;
    dpr: number;
    camera: { position: number[]; yaw: number; pitch: number };
    cluster: { tilesX: number; tilesY: number; depthSlices: number; maxLightsPerCluster: number; poolCapacity: number };
}

export interface BatchScenario {
    id: string;
    mode: string;
    strategy: string;
    label: string;
    lights: number;
}

function average(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateDiagnostics(snapshots: ClusterDiagnosticSnapshot[]): ClusterDiagnosticSnapshot | undefined {
    if (snapshots.length === 0) return undefined;
    const first = snapshots[0];
    return {
        strategy: first.strategy,
        sampleCount: snapshots.length,
        activeClusters: average(snapshots.map(snapshot => snapshot.activeClusters)),
        totalClusters: first.totalClusters,
        acceptedMean: average(snapshots.map(snapshot => snapshot.acceptedMean)),
        acceptedMedian: average(snapshots.map(snapshot => snapshot.acceptedMedian)),
        acceptedP95: average(snapshots.map(snapshot => snapshot.acceptedP95)),
        acceptedMax: Math.max(...snapshots.map(snapshot => snapshot.acceptedMax)),
        candidateMax: Math.max(...snapshots.map(snapshot => snapshot.candidateMax)),
        overflowClusters: average(snapshots.map(snapshot => snapshot.overflowClusters)),
        droppedReferences: average(snapshots.map(snapshot => snapshot.droppedReferences)),
        poolUsed: average(snapshots.map(snapshot => snapshot.poolUsed)),
        poolCapacity: first.poolCapacity,
    };
}

interface BatchResult {
    scenarioId: string;
    status: 'complete' | 'invalid' | 'skipped';
    invalidReason?: string;
}

interface BatchManifest {
    batchSchemaVersion: 1;
    kind: 'performance-batch';
    sessionId: string;
    startedAt: string;
    completedAt: string | null;
    status: 'running' | 'complete' | 'failed';
    failure: string | null;
    scenarios: BatchScenario[];
    results: BatchResult[];
    environment: { browser: string; timeZone: string };
}

interface OutputFile {
    relativePath: string;
    contents: string;
}

const durationMs = 5000;
const diagnosticSnapshotCount = 5;
const diagnosticSnapshotSpacingMs = 100;
const columns = [
    'frame_id', 'elapsed_ms', 'frame_interval_ms', 'cpu_update_ms', 'cpu_encode_submit_ms',
    'renderer_gpu_ms', 'pass_busy_sum_ms', 'gpu_passes_json',
];

/** A local wall-clock name for people; the browser time zone goes in metadata. */
function localTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_`
        + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function csvCell(value: string | number | undefined): string {
    if (value === undefined) return '';
    const str = String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function sameCondition(a: TrialCondition, b: TrialCondition): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function failureText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Dev-only batch recorder. The browser sends completed files to Vite's local
 * middleware, so it never owns a directory handle or asks the user for one.
 */
export class BenchmarkRecorder {
    private running = false;

    constructor(private readonly profiler: PerformanceProfiler) {}

    async runBatch(
        scenarios: BatchScenario[],
        prepareScenario: (scenario: BatchScenario) => string | undefined,
        readCondition: () => TrialCondition,
        clusters: () => Clusters,
        setLocked: (locked: boolean, label: string) => void,
        onProgress: (completed: number, total: number) => void,
    ): Promise<{ sessionId: string; results: BatchResult[] } | undefined> {
        if (this.running) return undefined;
        if (scenarios.length === 0) throw new Error('Select at least one profiling scenario.');
        if (!this.profiler.hasGpuTiming) {
            throw new Error('GPU timestamp-query is unavailable; no comparable GPU trial can be recorded.');
        }

        const startedAtDate = new Date();
        const sessionId = localTimestamp(startedAtDate);
        const manifest: BatchManifest = {
            batchSchemaVersion: 1,
            kind: 'performance-batch',
            sessionId,
            startedAt: startedAtDate.toISOString(),
            completedAt: null,
            status: 'running',
            failure: null,
            scenarios,
            results: [],
            environment: {
                browser: navigator.userAgent,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
        };

        this.running = true;
        setLocked(true, `preparing 1/${scenarios.length}`);
        try {
            await this.saveFiles(sessionId, [{ relativePath: 'batch.json', contents: JSON.stringify(manifest, null, 2) }]);
            for (const [index, scenario] of scenarios.entries()) {
                setLocked(true, `${index + 1}/${scenarios.length} · preparing ${scenario.label}`);
                const skippedReason = prepareScenario(scenario);
                let result: BatchResult;
                if (skippedReason) {
                    result = { scenarioId: scenario.id, status: 'skipped', invalidReason: skippedReason };
                } else {
                    result = await this.recordTrial(sessionId, scenario, readCondition, clusters, setLocked, index + 1, scenarios.length);
                }
                manifest.results.push(result);
                onProgress(index + 1, scenarios.length);
                await this.saveFiles(sessionId, [{ relativePath: 'batch.json', contents: JSON.stringify(manifest, null, 2) }]);
            }
            manifest.status = 'complete';
            manifest.completedAt = new Date().toISOString();
            await this.saveFiles(sessionId, [{ relativePath: 'batch.json', contents: JSON.stringify(manifest, null, 2) }]);
            return { sessionId, results: manifest.results };
        } catch (error) {
            manifest.status = 'failed';
            manifest.failure = failureText(error);
            manifest.completedAt = new Date().toISOString();
            try {
                await this.saveFiles(sessionId, [{ relativePath: 'batch.json', contents: JSON.stringify(manifest, null, 2) }]);
            } catch (saveError) {
                console.error('Could not save failed batch manifest:', saveError);
            }
            throw error;
        } finally {
            setLocked(false, 'run selected benchmark batch');
            this.running = false;
        }
    }

    private async recordTrial(
        sessionId: string,
        scenario: BatchScenario,
        readCondition: () => TrialCondition,
        clusters: () => Clusters,
        setLocked: (locked: boolean, label: string) => void,
        ordinal: number,
        total: number,
    ): Promise<BatchResult> {
        const condition = readCondition();
        if (condition.mode !== scenario.mode || condition.strategy !== scenario.strategy || condition.lights !== scenario.lights) {
            return { scenarioId: scenario.id, status: 'skipped', invalidReason: 'requested renderer condition is unavailable' };
        }
        let timer: number | undefined;
        let observer: ProfileSampleObserver | undefined;
        let invalidReason: string | undefined;
        const rows = new Map<number, { cpu: CpuFrameSample; gpu?: GpuTimingSample }>();
            let diagnostic: ClusterDiagnosticSnapshot | undefined;
        let droppedGpuSamples = 0;
        try {
            this.profiler.setEnabled(true);
            this.profiler.resetForExternalChange();
            setLocked(true, `${ordinal}/${total} · warming up ${scenario.label}`);
            const warmupDeadline = performance.now() + 12000;
            while (this.profiler.snapshot(performance.now()).status !== 'ACTIVE') {
                if (document.hidden) throw new Error('Tab was hidden during warmup.');
                if (!sameCondition(condition, readCondition())) throw new Error('Workload changed during warmup.');
                if (performance.now() > warmupDeadline) throw new Error('GPU timing did not become active within 12 seconds.');
                await delay(50);
            }
            const epoch = this.profiler.snapshot(performance.now()).epoch;
            const droppedBefore = this.profiler.snapshot(performance.now()).droppedGpuSamples;
            const startMs = performance.now();
            const endMs = startMs + durationMs;
            observer = {
                onCpuSample: sample => {
                    if (sample.epoch === epoch && sample.timeMs >= startMs && sample.timeMs < endMs) rows.set(sample.frameId, { cpu: sample });
                },
                onGpuSample: sample => {
                    if (sample.epoch === epoch) {
                        const row = rows.get(sample.frameId);
                        if (row) row.gpu = sample;
                    }
                },
            };
            this.profiler.setSampleObserver(observer);
            timer = window.setInterval(() => {
                const remaining = Math.max(0, (endMs - performance.now()) / 1000);
                setLocked(true, `${ordinal}/${total} · ${scenario.label} · recording ${remaining.toFixed(1)}s`);
            }, 200);
            setLocked(true, `${ordinal}/${total} · ${scenario.label} · recording 5.0s`);
            while (performance.now() < endMs) {
                if (document.hidden) { invalidReason = 'tab hidden'; break; }
                if (!sameCondition(condition, readCondition())) { invalidReason = 'workload changed'; break; }
                if (this.profiler.snapshot(performance.now()).epoch !== epoch) { invalidReason = 'profiler epoch changed'; break; }
                await delay(Math.min(50, Math.max(1, endMs - performance.now())));
            }
            droppedGpuSamples = this.profiler.snapshot(performance.now()).droppedGpuSamples - droppedBefore;
            setLocked(true, `${ordinal}/${total} · ${scenario.label} · finishing GPU readback`);
            await delay(1000);
            this.profiler.setSampleObserver(undefined);
            observer = undefined;
            if (!invalidReason && !sameCondition(condition, readCondition())) invalidReason = 'workload changed';
            if (!invalidReason && rows.size === 0) invalidReason = 'no CPU samples';
            if (!invalidReason && ![...rows.values()].some(row => row.gpu)) invalidReason = 'no GPU samples';
            if (!invalidReason && condition.mode !== 'naive') {
                setLocked(true, `${ordinal}/${total} · ${scenario.label} · reading cluster snapshots`);
                try {
                    const snapshots: ClusterDiagnosticSnapshot[] = [];
                    for (let index = 0; index < diagnosticSnapshotCount; index += 1) {
                        if (index > 0) await delay(diagnosticSnapshotSpacingMs);
                        const snapshot = await this.profiler.captureClusterDiagnostics(clusters());
                        if (snapshot) snapshots.push(snapshot);
                    }
                    diagnostic = aggregateDiagnostics(snapshots);
                } catch (error) {
                    console.warn('Cluster diagnostic readback failed:', error);
                }
            }
            const ordered = [...rows.values()].sort((a, b) => a.cpu.frameId - b.cpu.frameId);
            const csv = [
                columns.join(','),
                ...ordered.map(({ cpu, gpu }) => [
                    cpu.frameId, cpu.timeMs - startMs, cpu.frameIntervalMs, cpu.cpuUpdateMs,
                    cpu.cpuEncodeSubmitMs, gpu?.rendererGpuMs, gpu?.passBusySumMs,
                    gpu ? JSON.stringify(gpu.passes) : undefined,
                ].map(csvCell).join(',')),
            ].join('\n') + '\n';
            const metadata = JSON.stringify({
                schemaVersion: 2,
                sessionId,
                scenarioId: scenario.id,
                startedAt: new Date().toISOString(),
                status: invalidReason ? 'invalid' : 'complete',
                invalidReason: invalidReason ?? null,
                condition,
                droppedGpuSamples,
                clusterDiagnostic: diagnostic ?? null,
                environment: {
                    browser: navigator.userAgent,
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
                samplesFile: `${scenario.id}.csv`,
            }, null, 2);
            setLocked(true, `${ordinal}/${total} · ${scenario.label} · saving files`);
            await this.saveFiles(sessionId, [
                { relativePath: `${scenario.id}/${scenario.id}.json`, contents: metadata },
                { relativePath: `${scenario.id}/${scenario.id}.csv`, contents: csv },
            ]);
            return { scenarioId: scenario.id, status: invalidReason ? 'invalid' : 'complete', invalidReason };
        } finally {
            if (timer !== undefined) window.clearInterval(timer);
            if (observer) this.profiler.setSampleObserver(undefined);
        }
    }

    private async saveFiles(sessionId: string, files: OutputFile[]): Promise<void> {
        const response = await fetch('/__performance-capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, files }),
        });
        if (response.ok) return;
        const detail = await response.text();
        if (response.status === 404) throw new Error('Local output is available only from npm run dev.');
        throw new Error(detail || `Local output request failed (${response.status}).`);
    }
}
