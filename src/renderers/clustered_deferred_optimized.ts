import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';

/**
 * Extra Credit path, deliberately separate from clustered_deferred.ts.
 *
 * The base renderer keeps its readable position/albedo/normal MRT implementation.
 * This renderer demonstrates the bandwidth-oriented alternative: one packed
 * rgba8uint color attachment, sampled depth reconstruction, and compute lighting.
 */
interface PackedDeferredResources {
    gBufferSceneBindGroupLayout: GPUBindGroupLayout;
    gBufferSceneBindGroup: GPUBindGroup;
    lightingSceneBindGroupLayout: GPUBindGroupLayout;
    lightingSceneBindGroup: GPUBindGroup;
    lightingOutputBindGroupLayout: GPUBindGroupLayout;
    gBufferPipeline: GPURenderPipeline;
    lightingComputePipeline: GPUComputePipeline;
    packedMaterialTextureView: GPUTextureView;
    depthTextureView: GPUTextureView;
}

export class OptimizedClusteredDeferredRenderer extends renderer.Renderer {
    private readonly resources: PackedDeferredResources;

    constructor(stage: Stage) {
        super(stage);
        this.resources = this.createResources();
    }

    private createResources(): PackedDeferredResources {
        const gBufferSceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Packed deferred G-buffer scene bind group layout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });
        const gBufferSceneBindGroup = renderer.device.createBindGroup({
            label: 'Packed deferred G-buffer scene bind group',
            layout: gBufferSceneBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.camera.uniformsBuffer } }],
        });

        const packedMaterialTexture = renderer.device.createTexture({
            label: 'Packed deferred material G-buffer: oct normal plus RGB565',
            size: [renderer.canvas.width, renderer.canvas.height],
            // Bandwidth accounting for the geometry pass:
            //
            // Base clustered deferred writes three color targets per covered
            // pixel: world position rgba16float (8 B), normal rgba16float
            // (8 B), and albedo rgba8unorm (4 B): 20 B of color data.
            //
            // This path writes one rgba8uint target: exactly 4 B. RG hold an
            // octahedral-encoded normal (8 bits per component); BA hold a
            // little-endian RGB565 albedo (5/6/5 bits). World position is not
            // stored at all: the later compute pass reconstructs it from the
            // already-required depth32float attachment and inverse VP matrix.
            // Less G-buffer data is written in the geometry pass and read in
            // the lighting pass, reducing external VRAM bandwidth pressure.
            format: 'rgba8uint',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const depthTexture = renderer.device.createTexture({
            label: 'Packed deferred sampleable depth G-buffer',
            size: [renderer.canvas.width, renderer.canvas.height],
            // depth24plus has implementation-defined storage and was not bound
            // as a texture in the base path. depth32float is sampleable here.
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const packedMaterialTextureView = packedMaterialTexture.createView();
        const depthTextureView = depthTexture.createView();

        const lightingSceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Packed deferred lighting scene bind group layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
            ],
        });
        const lightingSceneBindGroup = renderer.device.createBindGroup({
            label: 'Packed deferred lighting scene bind group',
            layout: lightingSceneBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusters.metadataStorageBuffer } },
                { binding: 3, resource: { buffer: this.clusters.lightIndexStorageBuffer } },
                { binding: 4, resource: { buffer: this.clusters.overflowStorageBuffer } },
                { binding: 5, resource: depthTextureView },
                { binding: 6, resource: packedMaterialTextureView },
            ],
        });
        const lightingOutputBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Packed deferred lighting output bind group layout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { access: 'write-only', format: 'rgba8unorm' },
            }],
        });

        const gBufferPipeline = renderer.device.createRenderPipeline({
            label: 'Packed deferred single-target G-buffer pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Packed deferred G-buffer pipeline layout',
                bindGroupLayouts: [
                    gBufferSceneBindGroupLayout,
                    renderer.modelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth32float',
            },
            vertex: {
                module: renderer.device.createShaderModule({
                    label: 'Packed deferred G-buffer vertex shader',
                    code: shaders.naiveVertSrc,
                }),
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: renderer.device.createShaderModule({
                    label: 'Packed deferred G-buffer fragment shader',
                    code: shaders.clusteredDeferredPackedGBufferFragSrc,
                }),
                targets: [{ format: 'rgba8uint' }],
            },
        });

        const lightingComputePipeline = renderer.device.createComputePipeline({
            label: 'Packed deferred lighting compute pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Packed deferred lighting compute pipeline layout',
                bindGroupLayouts: [lightingSceneBindGroupLayout, lightingOutputBindGroupLayout],
            }),
            compute: {
                module: renderer.device.createShaderModule({
                    label: 'Packed deferred lighting compute shader',
                    code: shaders.clusteredDeferredLightingComputeSrc,
                }),
            },
        });

        return {
            gBufferSceneBindGroupLayout,
            gBufferSceneBindGroup,
            lightingSceneBindGroupLayout,
            lightingSceneBindGroup,
            lightingOutputBindGroupLayout,
            gBufferPipeline,
            lightingComputePipeline,
            packedMaterialTextureView,
            depthTextureView,
        };
    }

    override draw() {
        const encoder = renderer.device.createCommandEncoder({ label: 'Packed clustered deferred command encoder' });
        const gpuFrame = this.beginGpuFrame();

        // Clustering is unchanged. Only the G-buffer representation and its
        // fullscreen consumer differ from the retained base renderer.
        this.lights.doLightClustering(encoder, gpuFrame);

        const gBufferPass = encoder.beginRenderPass({
            label: 'Packed deferred single-color G-buffer pass',
            timestampWrites: gpuFrame?.pass('gbuffer_geometry'),
            colorAttachments: [{
                view: this.resources.packedMaterialTextureView,
                clearValue: [0, 0, 0, 0],
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.resources.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
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
            gBufferPass.setIndexBuffer(primitive.indexBuffer, 'uint32');
            gBufferPass.drawIndexed(primitive.numIndices);
        });
        gBufferPass.end();

        // Only the presentation texture changes each frame. Keep the seven
        // stable inputs in a persistent group and rebuild this one-entry group.
        const outputTextureView = renderer.context.getCurrentTexture().createView();
        const lightingOutputBindGroup = renderer.device.createBindGroup({
            label: 'Packed deferred lighting output bind group',
            layout: this.resources.lightingOutputBindGroupLayout,
            entries: [{ binding: 0, resource: outputTextureView }],
        });

        const lightingPass = encoder.beginComputePass({
            label: 'Packed deferred lighting compute pass',
            timestampWrites: gpuFrame?.pass('deferred_lighting_compute'),
        });
        lightingPass.setPipeline(this.resources.lightingComputePipeline);
        lightingPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.lightingSceneBindGroup);
        lightingPass.setBindGroup(1, lightingOutputBindGroup);
        const workgroupSize = shaders.constants.deferredLightingWorkgroupSize;
        lightingPass.dispatchWorkgroups(
            Math.ceil(renderer.canvas.width / workgroupSize),
            Math.ceil(renderer.canvas.height / workgroupSize),
        );
        lightingPass.end();

        this.submitFrame(encoder, gpuFrame);
    }
}
