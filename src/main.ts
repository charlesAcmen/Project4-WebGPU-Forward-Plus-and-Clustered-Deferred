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
// dat.GUI uses native select controls, so taps open the platform picker on touch devices.
gui.domElement.classList.add('renderer-controls');
installOverlayLayout(gui);
const lightCountController = gui.add(lights, 'numLights').min(1).max(lights.maxRuntimeLights).step(1).onChange(() => {
    lights.updateLightSetUniformNumLights();
    profiler.resetForExternalChange();
});

clusters.setCapacityStrategy('adaptive');
const clusterStrategyState = { strategy: clusters.capacityStrategy };
const clusterStrategies = {
    fixed: "fixed",
    adaptive: "adaptive",
};
gui.add(clusterStrategyState, "strategy", clusterStrategies).onChange((strategy: ClusterCapacityStrategy) => {
    clusters.setCapacityStrategy(strategy);
    profiler.resetForExternalChange();
});

// This selector does not switch renderer pipelines. It changes only a tiny
// uniform consumed by Visibility Buffer's compute pass, making it safe to use
// while diagnosing which producer/consumer stage first turns into black.
const visibilityDebugState = { view: visibilityDebugViews.finalLighting };
gui.add(visibilityDebugState, 'view', visibilityDebugViews).name('visibility debug').onChange((view: VisibilityDebugView) => {
    setVisibilityDebugView(view);
    profiler.resetForExternalChange();
});

const stage = new Stage(scene, lights, camera, clusters, stats);
const profiler = new PerformanceProfiler();
profiler.enableGpuTiming(device);
const performanceOverlay = new PerformanceOverlay(profiler, canvas);
const profilingState = { mode: 'timestamp + overlay' };
gui.add(profilingState, 'mode', ['off', 'timestamp only', 'timestamp + overlay'])
    .name('profiling')
    .onChange((mode: string) => {
        profiler.setEnabled(mode !== 'off');
        performanceOverlay.setVisible(mode === 'timestamp + overlay');
    });
gui.add({
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
gui.add({ resetCamera: () => {
    camera.applyPose(sponzaStartPose);
    profiler.resetForExternalChange();
} }, 'resetCamera').name('reset camera preset');

var renderer: Renderer | undefined;
let activeRenderMode = '';

function setRenderer(mode: string) {
    // Do this check before stopping the active renderer. A machine that lacks
    // the optional primitive-index feature should continue displaying the last
    // working path instead of leaving the canvas idle after a GUI selection.
    if (mode === renderModes.visibilityBuffer && !supportsPrimitiveIndex) {
        console.error(
            'Visibility Buffer mode needs WebGPU primitive-index support; retaining the current renderer.',
        );
        renderModeController.setValue(activeRenderMode);
        return;
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
const defaultRenderMode = supportsPrimitiveIndex
    ? renderModes.visibilityBuffer
    // primitive-index is the only optional feature required by the visibility
    // path. Without it, prefer the packed clustered-deferred implementation
    // as the default bandwidth-oriented fallback; Forward+ remains selectable.
    : renderModes.clusteredDeferredOptimized;
let renderModeController = gui.add({ mode: defaultRenderMode }, 'mode', renderModes);
renderModeController.onChange(setRenderer);

setRenderer(renderModeController.getValue());

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
