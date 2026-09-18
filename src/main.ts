import Stats from 'stats.js';
import { GUI } from 'dat.gui';

import { canvas, initWebGPU, Renderer, supportsPrimitiveIndex } from './renderer';
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

await initWebGPU();
setupLoaders();

let scene = new Scene();
await scene.loadGltf('./scenes/sponza/Sponza.gltf');

const camera = new Camera();
const clusters = new Clusters(canvas.width, canvas.height);
const lights = new Lights(camera, clusters);

const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

const gui = new GUI();
gui.add(lights, 'numLights').min(1).max(Lights.maxNumLights).step(1).onChange(() => {
    lights.updateLightSetUniformNumLights();
});

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

var renderer: Renderer | undefined;

function setRenderer(mode: string) {
    renderer?.stop();

    switch (mode) {
        case renderModes.naive:
            renderer = new NaiveRenderer(stage);
            break;
        case renderModes.forwardPlus:
            renderer = new ForwardPlusRenderer(stage);
            break;
        case renderModes.clusteredDeferred:
            renderer = new ClusteredDeferredRenderer(stage);
            break;
    }
}

const renderModes = { naive: 'naive', forwardPlus: 'forward+', clusteredDeferred: 'clustered deferred' };
let renderModeController = gui.add({ mode: renderModes.naive }, 'mode', renderModes);
renderModeController.onChange(setRenderer);

setRenderer(renderModeController.getValue());
