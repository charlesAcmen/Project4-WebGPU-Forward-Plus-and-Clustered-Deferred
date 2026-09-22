import Stats from 'stats.js';
import { GUI } from 'dat.gui';

import {
    canvas,
    device,
    initWebGPU,
    Renderer,
    resizeCanvasToDisplaySize,
    showWebGpuStatusOverlay,
    supportsPrimitiveIndex,
} from './renderer';
import { NaiveRenderer } from './renderers/naive';
import { ForwardPlusRenderer } from './renderers/forward_plus';
import { ClusteredDeferredRenderer } from './renderers/clustered_deferred';
import { OptimizedClusteredDeferredRenderer } from './renderers/clustered_deferred_optimized';
import {
    setVisibilityDebugView,
    VisibilityBufferRenderer,
    VisibilityDebugView,
    visibilityDebugViews,
} from './renderers/visibility_buffer';

import { setupLoaders, Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera, sponzaStartPose } from './stage/camera';
import { Clusters, ClusterCapacityStrategy } from './stage/clusters';
import { Stage } from './stage/stage';
import { installOverlayLayout } from './ui/overlay_layout';
import { PerformanceProfiler } from './performance/profiler';
import { PerformanceOverlay } from './performance/overlay';
import type { BatchScenario, TrialCondition } from './performance/benchmark';
import { createRenderBudget } from './stage/render_budget';
//void:discard Promised return,Promise<void>
//IIFE: Immediately Invoked Function Expression to allow async/await at the top level
void (async () => {
await initWebGPU();
setupLoaders();

let scene = new Scene();
await scene.loadGltf('./scenes/sponza/Sponza.gltf');

const camera = new Camera();
let clusters = new Clusters(canvas.width, canvas.height);
const lights = new Lights(camera, clusters);

const stats = new Stats();
stats.showPanel(0);
stats.dom.classList.add('renderer-stats-overlay');
document.body.appendChild(stats.dom);

const gui = new GUI();
// These are the renderer's primary controls, not an optional debug drawer.
// Keep them visible and remove dat.GUI's otherwise empty Open/Close toggle.
gui.open();
// dat.GUI uses native select controls, so taps open the platform picker on touch devices.
gui.domElement.classList.add('renderer-controls');
installOverlayLayout(gui);
const benchmarkControls: HTMLElement[] = [];
const lightCountController = gui.add(lights, 'numLights').min(1).max(lights.maxRuntimeLights).step(1).onChange(() => {
    // dat.GUI's number box emits this only on a committed change (Enter or
    // focus loss), so partial edits never reach the GPU light-count uniform.
    lights.numLights = Math.round(lights.numLights);
    lights.updateLightSetUniformNumLights();
    profiler.resetForExternalChange();
});
benchmarkControls.push(lightCountController.domElement);

clusters.setCapacityStrategy('adaptive');
const clusterStrategyState = { strategy: clusters.capacityStrategy };
const clusterStrategies = {
    fixed: "fixed",
    adaptive: "adaptive",
};
const strategyController = gui.add(clusterStrategyState, "strategy", clusterStrategies).onChange((strategy: ClusterCapacityStrategy) => {
    clusters.setCapacityStrategy(strategy);
    profiler.resetForExternalChange();
});
benchmarkControls.push(strategyController.domElement);

// This selector does not switch renderer pipelines. It changes only a tiny
// uniform consumed by Visibility Buffer's compute pass, making it safe to use
// while diagnosing which producer/consumer stage first turns into black.
const visibilityDebugState = { view: visibilityDebugViews.finalLighting };
const debugController = gui.add(visibilityDebugState, 'view', visibilityDebugViews).name('visibility debug').onChange((view: VisibilityDebugView) => {
    setVisibilityDebugView(view);
    profiler.resetForExternalChange();
});
benchmarkControls.push(debugController.domElement);

const stage = new Stage(scene, lights, camera, clusters, stats);
const profiler = new PerformanceProfiler();
const developmentProfiling = import.meta.env.DEV;
if (developmentProfiling) profiler.enableGpuTiming(device);
const performanceOverlay = new PerformanceOverlay(profiler, canvas);
const mobileRelease = createRenderBudget().isTouchClassDevice && import.meta.env.PROD;
const profilingState = { mode: developmentProfiling && !mobileRelease ? 'timestamp + overlay' : 'off' };
profiler.setEnabled(profilingState.mode !== 'off');
performanceOverlay.setVisible(profilingState.mode === 'timestamp + overlay');
if (developmentProfiling) {
    const profilingController = gui.add(profilingState, 'mode', ['off', 'timestamp only', 'timestamp + overlay'])
        .name('profiling')
        .onChange((mode: string) => {
            profiler.setEnabled(mode !== 'off');
            performanceOverlay.setVisible(mode === 'timestamp + overlay');
        });
    benchmarkControls.push(profilingController.domElement);
    const diagnosticController = gui.add({
        captureClusters: () => {
            if (activeRenderMode === renderModes.naive) {
                console.info('Naive mode does not build cluster lists.');
                return;
            }
            void profiler.captureClusterDiagnostics(clusters)
                .then(snapshot => {
                    if (snapshot) performanceOverlay.showClusterDiagnostics(snapshot);
                })
                .catch(error => console.error('Cluster snapshot failed:', error));
        },
    }, 'captureClusters').name('cluster snapshot');
    benchmarkControls.push(diagnosticController.domElement);
}
const cameraController = gui.add({ resetCamera: () => {
    camera.applyPose(sponzaStartPose);
    profiler.resetForExternalChange();
} }, 'resetCamera').name('reset camera preset');
benchmarkControls.push(cameraController.domElement);

var renderer: Renderer | undefined;
let activeRenderMode = '';

function setRenderer(mode: string): boolean {
    // Do this check before stopping the active renderer. A machine that lacks
    // the optional primitive-index feature should continue displaying the last
    // working path instead of leaving the canvas idle after a GUI selection.
    if (mode === renderModes.visibilityBuffer && !supportsPrimitiveIndex) {
        console.error(
            'Visibility Buffer mode needs WebGPU primitive-index support; retaining the current renderer.',
        );
        renderModeController.setValue(activeRenderMode);
        return false;
    }

    renderer?.stop();

    switch (mode) {
        case renderModes.naive:
            renderer = new NaiveRenderer(stage);
            break;
        case renderModes.forwardPlus:
            renderer = new ForwardPlusRenderer(stage);
            break;
        case renderModes.clusteredDeferredBase:
            renderer = new ClusteredDeferredRenderer(stage);
            break;
        case renderModes.clusteredDeferredOptimized:
            renderer = new OptimizedClusteredDeferredRenderer(stage);
            break;
        case renderModes.visibilityBuffer:
            renderer = new VisibilityBufferRenderer(stage);
            break;
    }

    profiler.setMode(mode);
    renderer?.attachProfiler(profiler, mode);
    activeRenderMode = mode;
    return renderer !== undefined;
}

// Keep all deferred paths selectable. Each mode represents a different trade:
// base is the readable MRT reference, packed compute is G-buffer compression,
// and Visibility Buffer stores only triangle identity before reconstruction.
const renderModes = {
    naive: 'naive',
    forwardPlus: 'forward+',
    clusteredDeferredBase: 'clustered deferred (base)',
    clusteredDeferredOptimized: 'clustered deferred (packed compute)',
    visibilityBuffer: 'visibility buffer (compute reconstruction)',
};
const defaultRenderMode = mobileRelease
    // A phone can expose primitive-index and still be memory or queue limited.
    // Start every release touch device on one render pass plus clustering; the
    // heavier Visibility/Packed paths remain explicit GUI experiments.
    ? renderModes.forwardPlus
    : supportsPrimitiveIndex
        ? renderModes.visibilityBuffer
        // primitive-index is the only optional feature required by Visibility.
        // Desktop adapters without it retain the packed deferred fallback.
        : renderModes.clusteredDeferredOptimized;
let renderModeController = gui.add({ mode: defaultRenderMode }, 'mode', renderModes);
renderModeController.onChange(setRenderer);
benchmarkControls.push(renderModeController.domElement);

setRenderer(renderModeController.getValue());

const captureNotice = document.createElement('div');
captureNotice.className = 'benchmark-status';
captureNotice.setAttribute('role', 'status');
captureNotice.setAttribute('aria-live', 'polite');
captureNotice.hidden = true;
function setCaptureNotice(message: string, state: 'success' | 'error' | 'info' = 'info'): void {
    captureNotice.textContent = message;
    captureNotice.hidden = message === '';
    captureNotice.dataset.state = state;
}

function captureFailureMessage(error: unknown): string {
    return `Capture failed: ${error instanceof Error ? error.message : String(error)}`;
}
let captureController: { domElement: HTMLElement; name(label: string): unknown } | undefined;

if (developmentProfiling) {
    const { BenchmarkRecorder } = await import('./performance/benchmark');
    const benchmark = new BenchmarkRecorder(profiler);
    const scenarioOptions = [
        { id: 'naive', mode: renderModes.naive, strategy: 'none', label: 'naive' },
        { id: 'fixed_forward-plus', mode: renderModes.forwardPlus, strategy: 'fixed', label: 'forward+ / fixed' },
        { id: 'adaptive_forward-plus', mode: renderModes.forwardPlus, strategy: 'adaptive', label: 'forward+ / adaptive' },
        { id: 'fixed_clustered-deferred', mode: renderModes.clusteredDeferredBase, strategy: 'fixed', label: 'base deferred / fixed' },
        { id: 'adaptive_clustered-deferred', mode: renderModes.clusteredDeferredBase, strategy: 'adaptive', label: 'base deferred / adaptive' },
        { id: 'fixed_clustered-deferred-packed', mode: renderModes.clusteredDeferredOptimized, strategy: 'fixed', label: 'optimized deferred / fixed' },
        { id: 'adaptive_clustered-deferred-packed', mode: renderModes.clusteredDeferredOptimized, strategy: 'adaptive', label: 'optimized deferred / adaptive' },
        { id: 'fixed_visibility-buffer', mode: renderModes.visibilityBuffer, strategy: 'fixed', label: 'visibility buffer / fixed' },
        { id: 'adaptive_visibility-buffer', mode: renderModes.visibilityBuffer, strategy: 'adaptive', label: 'visibility buffer / adaptive' },
    ];
    const batchSelection: Record<string, boolean> = Object.fromEntries(scenarioOptions.map(scenario => [scenario.id, true]));
    const batchLightState = {
        light1: 500,
        light2: 750,
        light3: 1000,
        light4: 1200,
        light5: 1500,
        naiveSafetyMaximum: 250,
    };
    const batchFolder = gui.addFolder('profiling queue');
    const lightSliderNames = ['light1', 'light2', 'light3', 'light4', 'light5'] as const;
    const lightSliderControllers = lightSliderNames.map((name, index) => {
        const controller = batchFolder.add(batchLightState, name)
            .min(index === 0 ? 1 : batchLightState[lightSliderNames[index - 1]] + 1)
            .max(index === lightSliderNames.length - 1
                ? lights.maxRuntimeLights
                : batchLightState[lightSliderNames[index + 1]] - 1)
            .step(1)
            .name(`light ${index + 1}`)
            .onChange((value: number) => {
                batchLightState[name] = Math.round(value);
                updateLightSliderBounds();
            });
        return controller;
    });
    function updateLightSliderBounds(): void {
        lightSliderControllers.forEach((controller, index) => {
            controller.min(index === 0 ? 1 : batchLightState[lightSliderNames[index - 1]] + 1);
            controller.max(index === lightSliderNames.length - 1
                ? lights.maxRuntimeLights
                : batchLightState[lightSliderNames[index + 1]] - 1);
        });
    }
    const naiveSafetyController = batchFolder.add(batchLightState, 'naiveSafetyMaximum')
        .min(1).max(lights.maxRuntimeLights).step(1).name('naive safety max');
    benchmarkControls.push(...lightSliderControllers.map(controller => controller.domElement), naiveSafetyController.domElement);
    for (const scenario of scenarioOptions) {
        const controller = batchFolder.add(batchSelection, scenario.id).name(scenario.label);
        benchmarkControls.push(controller.domElement);
    }
    batchFolder.open();
    benchmarkControls.push(batchFolder.domElement);
    gui.domElement.appendChild(captureNotice);

    const captureState = { profileSelected: () => {
        const selectedOptions = scenarioOptions.filter(scenario => batchSelection[scenario.id]);
        if (selectedOptions.length === 0) {
            setCaptureNotice('Select at least one profiling scenario first.', 'error');
            return;
        }
        const requestedLights = lightSliderNames.map(name => batchLightState[name]);
        const scenarios = expandBatchScenarios(selectedOptions, requestedLights, Math.round(batchLightState.naiveSafetyMaximum));
        setCaptureNotice(`Queued ${scenarios.length} trials across ${requestedLights.length} light counts.`, 'info');
        void benchmark.runBatch(
            scenarios,
            scenario => {
                if (scenario.mode === renderModes.visibilityBuffer && !supportsPrimitiveIndex) {
                    return 'primitive-index is unavailable on this adapter';
                }
                lights.numLights = scenario.lights;
                lights.updateLightSetUniformNumLights();
                lightCountController.updateDisplay();
                renderModeController.setValue(scenario.mode);
                if (activeRenderMode !== scenario.mode) return 'renderer switch failed';
                if (scenario.strategy !== 'none') strategyController.setValue(scenario.strategy as ClusterCapacityStrategy);
                return undefined;
            },
            readTrialCondition,
            () => clusters,
            setCaptureLocked,
            (completed, total) => setCaptureNotice(`Completed ${completed}/${total}; writing output.`, 'info'),
        ).then(result => {
            if (!result) return;
            const issues = result.results.filter(item => item.status !== 'complete');
            setCaptureNotice(
                issues.length ? `Saved ${result.sessionId}; ${issues.length} scenario(s) were invalid or skipped.` : `Saved batch: ${result.sessionId}`,
                issues.length ? 'error' : 'success',
            );
        }).catch(error => {
            setCaptureNotice(captureFailureMessage(error), 'error');
            console.error('Performance batch failed:', error);
        });
    } };
    captureController = gui.add(captureState, 'profileSelected').name('run selected benchmark batch');

    function expandBatchScenarios(
        selected: typeof scenarioOptions,
        requestedLights: number[],
        naiveSafetyMaximum: number,
    ): BatchScenario[] {
        const scenarios: BatchScenario[] = [];
        for (const option of selected) {
            const lightCounts = option.mode === renderModes.naive
                ? (() => {
                    const safe = requestedLights.filter(light => light <= naiveSafetyMaximum);
                    return safe.length > 0 ? safe : [Math.min(naiveSafetyMaximum, requestedLights[0])];
                })()
                : requestedLights;
            for (const lightCount of lightCounts) {
                scenarios.push({
                    ...option,
                    id: `${option.id}_${lightCount}-lights`,
                    label: `${option.label} · ${lightCount} lights`,
                    lights: lightCount,
                });
            }
        }
        return scenarios;
    }
}

function readTrialCondition(): TrialCondition {
    const dimensions = clusters.dimensions;
    return {
        mode: activeRenderMode,
        strategy: activeRenderMode === renderModes.naive ? 'none' : clusters.capacityStrategy,
        lights: lights.numLights,
        width: canvas.width, height: canvas.height, dpr: window.devicePixelRatio,
        camera: { position: [...camera.cameraPos], yaw: camera.yaw, pitch: camera.pitch },
        cluster: {
            tilesX: dimensions.tilesX, tilesY: dimensions.tilesY,
            depthSlices: dimensions.depthSliceCount,
            maxLightsPerCluster: dimensions.maxLightsPerCluster,
            poolCapacity: dimensions.lightIndexCapacity,
        },
    };
}

function setCaptureLocked(locked: boolean, label: string): void {
    camera.setInputLocked(locked);
    lights.setFrameBudgetPaused(locked);
    for (const element of benchmarkControls) {
        element.style.pointerEvents = locked ? 'none' : '';
        element.style.opacity = locked ? '0.45' : '';
        element.setAttribute('aria-disabled', String(locked));
        element.querySelectorAll('input, select, button').forEach(input => {
            (input as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled = locked;
        });
    }
    if (captureController) {
        captureController.domElement.style.pointerEvents = locked ? 'none' : '';
        captureController.domElement.setAttribute('aria-disabled', String(locked));
        captureController.name(label);
    }
    if (locked) {
        // A batch needs timestamp samples even when the live overlay selector
        // was set to off before the user pressed the batch button.
        profiler.setEnabled(true);
        performanceOverlay.setVisible(false);
        setCaptureNotice(label, 'info');
    } else {
        profiler.setEnabled(profilingState.mode !== 'off');
        performanceOverlay.setVisible(profilingState.mode === 'timestamp + overlay');
    }
}

// Mobile rotation and dynamic browser chrome change the CSS canvas size after
// startup. Keep the drawing buffer, projection, cluster storage, and all
// size-dependent attachments as one transaction so no path can render an old
// portrait texture into a new landscape canvas.
let resizeRequestId: number | undefined;
const scheduleRendererResize = () => {
    if (resizeRequestId !== undefined) {
    //wrap all resizing into a single requestAnimationFrame to avoid multiple resizes in a single frame
        return;
    }
    resizeRequestId = requestAnimationFrame(() => {
        resizeRequestId = undefined;
        if (!resizeCanvasToDisplaySize()) {
            return;
        }

        profiler.resetForExternalChange();

        // Update all size-dependent resources in one transaction so no renderer
        // can draw with a stale projection or cluster layout.
        camera.resizeProjection();
        const previousStrategy = clusters.capacityStrategy;
        clusters = new Clusters(canvas.width, canvas.height);
        clusters.setCapacityStrategy(previousStrategy);
        lights.setClusters(clusters);
        stage.clusters = clusters;
        setRenderer(activeRenderMode);
    });
};

// ResizeObserver covers CSS changes such as 100dvh; the viewport listeners
// cover rotation and mobile browser-chrome transitions where layout changes
// before the canvas observer is delivered.
new ResizeObserver(scheduleRendererResize).observe(canvas);
window.addEventListener('resize', scheduleRendererResize, { passive: true });
window.addEventListener('orientationchange', scheduleRendererResize, { passive: true });
window.visualViewport?.addEventListener('resize', scheduleRendererResize, { passive: true });
window.addEventListener('webgpu-canvas-resize-needed', scheduleRendererResize);

// The governor can lower numLights asynchronously after sustained
// overload. Refreshing this controller keeps the displayed value truthful.
window.setInterval(() => {
    // The release safety valve can update the displayed count, but it must not
    // overwrite a number while the user is selecting, pasting, or backspacing.
    const lightInput = lightCountController.domElement.querySelector('input');
    if (document.activeElement !== lightInput) lightCountController.updateDisplay();
}, 250);
})().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    // initWebGPU already provides the more specific unsupported-device title.
    // Loading or renderer setup failures use the same visible diagnostic UI
    // instead of failing silently on a public page.
    if (!document.getElementById('webgpu-status-overlay')) {
        showWebGpuStatusOverlay('渲染器无法启动', reason);
    }
    console.error('Renderer startup failed:', error);
});
