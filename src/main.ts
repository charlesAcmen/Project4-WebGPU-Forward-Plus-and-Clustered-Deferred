import Stats from 'stats.js';
import { GUI } from 'dat.gui';

import {
    canvas,
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
import { Camera } from './stage/camera';
import { Clusters, ClusterCapacityStrategy } from './stage/clusters';
import { Stage } from './stage/stage';
import { installOverlayLayout } from './ui/overlay_layout';
import { PerformanceProfiler } from './performance/profiler';
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
});

clusters.setCapacityStrategy('adaptive');
const clusterStrategyState = { strategy: clusters.capacityStrategy };
const clusterStrategies = {
    fixed: "fixed",
    adaptive: "adaptive",
};
gui.add(clusterStrategyState, "strategy", clusterStrategies).onChange((strategy: ClusterCapacityStrategy) => {
    clusters.setCapacityStrategy(strategy);
});

// This selector does not switch renderer pipelines. It changes only a tiny
// uniform consumed by Visibility Buffer's compute pass, making it safe to use
// while diagnosing which producer/consumer stage first turns into black.
const visibilityDebugState = { view: visibilityDebugViews.finalLighting };
gui.add(visibilityDebugState, 'view', visibilityDebugViews).name('visibility debug').onChange((view: VisibilityDebugView) => {
    setVisibilityDebugView(view);
});

const stage = new Stage(scene, lights, camera, clusters, stats);
const profiler = new PerformanceProfiler();

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
let renderModeController = gui.add({ mode: renderModes.naive }, 'mode', renderModes);
renderModeController.onChange(setRenderer);

setRenderer(renderModeController.getValue());
