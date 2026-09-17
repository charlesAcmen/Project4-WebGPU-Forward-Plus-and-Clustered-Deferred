import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

interface ClusteredDeferredResources {
    //producer for G-buffer geo pass
    gBufferSceneBindGroupLayout: GPUBindGroupLayout;
    gBufferSceneBindGroup: GPUBindGroup;
    //consumer for G-buffer fullscreen pass
    fullscreenBindGroupLayout: GPUBindGroupLayout;
    fullscreenBindGroup: GPUBindGroup;
    gBufferPipeline: GPURenderPipeline;
    fullscreenPipeline: GPURenderPipeline;
    //g-buffer textures
    depthTextureView: GPUTextureView;
    //MRT @location(0)
    positionTextureView: GPUTextureView;
    //MRT @location(1)
    albedoTextureView: GPUTextureView;
    //MRT @location(2)
    normalTextureView: GPUTextureView;
}

export class ClusteredDeferredRenderer extends renderer.Renderer {
    // TODO-3: add layouts, pipelines, textures, etc. needed for Forward+ here
    // you may need extra uniforms such as the camera view matrix and the canvas resolution
    private readonly resources: ClusteredDeferredResources;

    constructor(stage: Stage) {
        super(stage);

        // TODO-3: initialize layouts, pipelines, textures, etc. needed for Forward+ here
        // you'll need two pipelines: one for the G-buffer pass and one for the fullscreen pass
    }

    override draw() {
        // TODO-3: run the Forward+ rendering pass:
        // - run the clustering compute shader
        // - run the G-buffer pass, outputting position, albedo, and normals
        // - run the fullscreen pass, which reads from the G-buffer and performs lighting calculations
    }
}
