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
        this.resources = this.createResources();
    }

    private createResources(): ClusteredDeferredResources {
        const gBufferSceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "Clustered Deferred G-buffer scene bind group layout",
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform" },
            }],
        });
        const gBufferSceneBindGroup = renderer.device.createBindGroup({
            label: "Clustered Deferred G-buffer scene bind group",
            layout: gBufferSceneBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.camera.uniformsBuffer } }],
        });

        const positionTexture = renderer.device.createTexture({
            label: "Clustered Deferred world-position G-buffer",
            size: [renderer.canvas.width, renderer.canvas.height],
            //can be negative, so we need a float format
            format: "rgba16float",
            //TEXTURE_BINDING:textureLoad
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const albedoTexture = renderer.device.createTexture({
            label: "Clustered Deferred albedo G-buffer",
            size: [renderer.canvas.width, renderer.canvas.height],
            //albedo is always positive, so we can use a normalized format
            //per channel 8 bits:0~255
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const normalTexture = renderer.device.createTexture({
            label: "Clustered Deferred normal G-buffer",
            size: [renderer.canvas.width, renderer.canvas.height],
            //same as position, normals can be negative, so we need a float format
            format: "rgba16float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const depthTexture = renderer.device.createTexture({
            label: "Clustered Deferred depth texture",
            size: [renderer.canvas.width, renderer.canvas.height],
            //ROP,24 bits is fixed value
            format: "depth24plus",
            //Hi-Z:Hierarchical Z-buffer.
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const positionTextureView = positionTexture.createView();
        const albedoTextureView = albedoTexture.createView();
        const normalTextureView = normalTexture.createView();
        const depthTextureView = depthTexture.createView();

        const fullscreenBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "Clustered Deferred fullscreen bind group layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
                { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: {} },
                { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: {} },
            ],
        });
        const fullscreenBindGroup = renderer.device.createBindGroup({
            label: "Clustered Deferred fullscreen bind group",
            layout: fullscreenBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusters.metadataStorageBuffer } },
                { binding: 3, resource: { buffer: this.clusters.lightIndexStorageBuffer } },
                { binding: 4, resource: { buffer: this.clusters.overflowStorageBuffer } },
                { binding: 5, resource: positionTextureView },
                { binding: 6, resource: albedoTextureView },
                { binding: 7, resource: normalTextureView },
            ],
        });

        const gBufferPipeline = renderer.device.createRenderPipeline({
            label: "Clustered Deferred G-buffer pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "Clustered Deferred G-buffer pipeline layout",
                bindGroupLayouts: [
                    gBufferSceneBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: "less",
                format: "depth24plus",
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "Clustered Deferred G-buffer vertex shader",
                    code: shaders.naiveVertSrc,
                }),
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "Clustered Deferred G-buffer fragment shader",
                    code: shaders.clusteredDeferredFragSrc,
                }),
                targets: [
                    { format: "rgba16float" },
                    { format: "rgba8unorm" },
                    { format: "rgba16float" },
                ],
            },
        });

        const fullscreenPipeline = renderer.device.createRenderPipeline({
            label: "Clustered Deferred fullscreen pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "Clustered Deferred fullscreen pipeline layout",
                bindGroupLayouts: [fullscreenBindGroupLayout],
            }),
            vertex: {
                module: renderer.device.createShaderModule({
                    label: "Clustered Deferred fullscreen vertex shader",
                    code: shaders.clusteredDeferredFullscreenVertSrc,
                }),
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "Clustered Deferred fullscreen fragment shader",
                    code: shaders.clusteredDeferredFullscreenFragSrc,
                }),
                targets: [{ format: renderer.canvasFormat }],
            },
            primitive: { topology: "triangle-list" },
        });

        return {
            gBufferSceneBindGroupLayout,
            gBufferSceneBindGroup,
            fullscreenBindGroupLayout,
            fullscreenBindGroup,
            gBufferPipeline,
            fullscreenPipeline,
            depthTextureView,
            positionTextureView,
            albedoTextureView,
            normalTextureView,
        };
    }

    override draw() {
        // TODO-3: run the Forward+ rendering pass:
        // - run the clustering compute shader
        // - run the G-buffer pass, outputting position, albedo, and normals
        // - run the fullscreen pass, which reads from the G-buffer and performs lighting calculations
        const encoder = renderer.device.createCommandEncoder({ label: "Clustered Deferred command encoder" });
        const gpuFrame = this.beginGpuFrame();
        //step 1: run the clustering compute shader to calculate which lights affect which clusters
        this.lights.doLightClustering(encoder, gpuFrame);

        //step 2: run the G-buffer pass, outputting position, albedo, and normals
        const gBufferPass = encoder.beginRenderPass({
            label: "Clustered Deferred G-buffer pass",
            timestampWrites: gpuFrame?.pass('gbuffer_geometry'),
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
            timestampWrites: gpuFrame?.pass('deferred_lighting_fullscreen'),
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

        this.submitFrame(encoder, gpuFrame);
    }

}
