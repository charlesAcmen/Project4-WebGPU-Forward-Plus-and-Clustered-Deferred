import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

/**
 * Forward+ owns render-path objects only. Shared camera, lights, and future
 * cluster-list buffers remain in stage so deferred rendering can reuse them.
 */
export interface ForwardPlusResources {
    //unique to forward+ renderer
    sceneUniformsBindGroupLayout: GPUBindGroupLayout;
    sceneUniformsBindGroup: GPUBindGroup;
    renderPipeline: GPURenderPipeline;
    depthTextureView: GPUTextureView;
}

export class ForwardPlusRenderer extends renderer.Renderer {
    // TODO-2: add layouts, pipelines, textures, etc. needed for Forward+ here
    // you may need extra uniforms such as the camera view matrix and the canvas resolution
    private readonly resources: ForwardPlusResources;

    protected createResources(): ForwardPlusResources {
        const sceneUniformsBindGroupLayout = renderer.device.createBindGroupLayout({
            label: "Forward+ scene bind group layout",
            entries: [
                {
                    binding: 0,
                    //FRAGMENT: we need the camera uniforms in the fragment shader 
                    //to compute the cluster index for each pixel
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    //in fragment shader,read is only needed for each pixels
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });
        const sceneUniformsBindGroup = renderer.device.createBindGroup({
            label: "Forward+ scene bind group",
            layout: sceneUniformsBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusters.metadataStorageBuffer } },
                { binding: 3, resource: { buffer: this.clusters.lightIndexStorageBuffer } },
            ],
        });

        const depthTexture = renderer.device.createTexture({
            label: "Forward+ depth texture",
            size: [renderer.canvas.width, renderer.canvas.height],
            format: "depth24plus",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const depthTextureView = depthTexture.createView();
        const renderPipeline = renderer.device.createRenderPipeline({
            label: "Forward+ render pipeline",
            layout: renderer.device.createPipelineLayout({
                label: "Forward+ render pipeline layout",
                bindGroupLayouts: [
                    sceneUniformsBindGroupLayout,
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
                    label: "Forward+ vertex shader",
                    //for vertex shader，still the naive vertex src
                    code: shaders.naiveVertSrc,
                }),
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: "Forward+ fragment shader",
                    //
                    code: shaders.forwardPlusFragSrc,
                }),
                targets: [{ format: renderer.canvasFormat }],
            },
        });

        return { sceneUniformsBindGroupLayout, sceneUniformsBindGroup, renderPipeline, depthTextureView };
    }

    constructor(stage: Stage) {
        super(stage);

        // TODO-2: initialize layouts, pipelines, textures, etc. needed for Forward+ here
        this.resources = this.createResources();
    }

    override draw() {
        // TODO-2: run the Forward+ rendering pass:
        const encoder = renderer.device.createCommandEncoder({ label: "Forward+ command encoder" });
        // - run the clustering compute shader
        this.lights.doLightClustering(encoder);

        const canvasTextureView = renderer.context.getCurrentTexture().createView();
        const renderPass = encoder.beginRenderPass({
            label: "Forward+ render pass",
            colorAttachments: [{
                view: canvasTextureView,
                clearValue: [0, 0, 0, 0],
                loadOp: "clear",
                storeOp: "store",
            }],
            depthStencilAttachment: {
                view: this.resources.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });
        renderPass.setPipeline(this.resources.renderPipeline);
        renderPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.sceneUniformsBindGroup);
        this.scene.iterate(node => {
            renderPass.setBindGroup(shaders.constants.bindGroup_model, node.modelBindGroup);
        }, material => {
            renderPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
        }, primitive => {
            renderPass.setVertexBuffer(0, primitive.vertexBuffer);
            renderPass.setIndexBuffer(primitive.indexBuffer, "uint32");
            renderPass.drawIndexed(primitive.numIndices);
        });
        renderPass.end();
        // - run the main rendering pass, using the computed clusters for efficient lighting
        renderer.device.queue.submit([encoder.finish()]);
    }
}
