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
        const encoder = renderer.device.createCommandEncoder({ label: "Clustered Deferred command encoder" });
        //step 1: run the clustering compute shader to calculate which lights affect which clusters
        this.lights.doLightClustering(encoder);

        //step 2: run the G-buffer pass, outputting position, albedo, and normals
        const gBufferPass = encoder.beginRenderPass({
            label: "Clustered Deferred G-buffer pass",
            colorAttachments: [
                { view: this.resources.positionTextureView, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
                { view: this.resources.albedoTextureView, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
                { view: this.resources.normalTextureView, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" },
            ],
            depthStencilAttachment: {
                view: this.resources.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
        gBufferPass.setPipeline(this.resources.gBufferPipeline);
        gBufferPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.gBufferSceneBindGroup);
        this.scene.iterate(node => {
            gBufferPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            gBufferPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            gBufferPass.setVertexBuffer(0, primitive.vertexBuffer);
            gBufferPass.setIndexBuffer(primitive.indexBuffer, "uint32");
            gBufferPass.drawIndexed(primitive.numIndices);
        });
        gBufferPass.end();

        const canvasTextureView = renderer.context.getCurrentTexture().createView();
        //step 3: run the fullscreen pass, which reads from the G-buffer and performs lighting calculations
        const fullscreenPass = encoder.beginRenderPass({
            label: "Clustered Deferred fullscreen pass",
            colorAttachments: [{
                view: canvasTextureView,
                clearValue: [0, 0, 0, 0],
                loadOp: "clear",
                storeOp: "store",
            }],
        });
        fullscreenPass.setPipeline(this.resources.fullscreenPipeline);
        fullscreenPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.fullscreenBindGroup);
        fullscreenPass.draw(3);
        fullscreenPass.end();

        renderer.device.queue.submit([encoder.finish()]);
    }

}
