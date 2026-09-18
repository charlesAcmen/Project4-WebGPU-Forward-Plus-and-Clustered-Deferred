import * as renderer from '../renderer';
import * as shaders from '../shaders/shaders';
import { Stage } from '../stage/stage';
import { VisibilitySceneData } from '../stage/scene';

/**
 * The Visibility Buffer path keeps geometry-pass bandwidth small:
 *
 *   geometry pass: r32uint(ObjectID, TriangleID) + depth32float
 *   compute pass : reconstruct/interpolate attributes, then clustered lighting
 *
 * Base clustered deferred and packed deferred intentionally remain separate
 * selectable implementations for both comparison and extra-credit evidence.
 */
interface VisibilityBufferResources {
    geometrySceneBindGroup: GPUBindGroup;
    visibilityModelBindGroupLayout: GPUBindGroupLayout;
    lightingSceneBindGroup: GPUBindGroup;
    lightingOutputBindGroupLayout: GPUBindGroupLayout;
    geometryPipeline: GPURenderPipeline;
    lightingComputePipeline: GPUComputePipeline;
    visibilityTextureView: GPUTextureView;
    depthTextureView: GPUTextureView;
    debugUniformBuffer: GPUBuffer;
}

interface VisibilityDrawResources {
    // One tiny uniform/bind group per Node x Primitive render item. The object
    // table is indexed later in compute; this uniform is only the producer-side
    // value that tells the geometry fragment shader what it should write.
    bindGroup: GPUBindGroup;
}

/**
 * These are intentionally renderer-local inspection views, not alternative
 * render paths. They let the GUI identify the first broken stage in the
 * ObjectID -> triangle -> interpolation -> lighting chain while preserving
 * the normal final-lighting result as the default.
 */
export const visibilityDebugViews = {
    finalLighting: 'final clustered lighting',
    idCoverage: 'visibility ID coverage',
    barycentrics: 'reconstructed barycentrics',
    albedo: 'reconstructed albedo',
} as const;

export type VisibilityDebugView = typeof visibilityDebugViews[keyof typeof visibilityDebugViews];

let selectedVisibilityDebugView: VisibilityDebugView = visibilityDebugViews.finalLighting;

export function setVisibilityDebugView(view: VisibilityDebugView): void {
    selectedVisibilityDebugView = view;
}

function selectedVisibilityDebugMode(): number {
    switch (selectedVisibilityDebugView) {
        case visibilityDebugViews.idCoverage:
            return 1;
        case visibilityDebugViews.barycentrics:
            return 2;
        case visibilityDebugViews.albedo:
            return 3;
        case visibilityDebugViews.finalLighting:
        default:
            return 0;
    }
}

/**
 * WGSL compilation is asynchronous from the application's point of view:
 * createShaderModule() returns immediately, while diagnostics become available
 * through getCompilationInfo(). Keep errors visible in DevTools, where they
 * name the generated shader line instead of silently producing a black frame.
 */
function logShaderDiagnostics(label: string, module: GPUShaderModule): void {
    void module.getCompilationInfo().then(info => {
        for (const message of info.messages) {
            if (message.type === 'error') {
                console.error(`${label} WGSL error at ${message.lineNum}:${message.linePos}: ${message.message}`);
            } else if (message.type === 'warning') {
                console.warn(`${label} WGSL warning at ${message.lineNum}:${message.linePos}: ${message.message}`);
            }
        }
    });
}

export class VisibilityBufferRenderer extends renderer.Renderer {
    private readonly visibilitySceneData: VisibilitySceneData;
    private readonly resources: VisibilityBufferResources;
    private readonly drawResourcesByObjectId: VisibilityDrawResources[] = [];
    // Only `mode` changes. The GPU buffer remains 16 bytes for WGSL uniform
    // alignment, while this reusable CPU upload needs just the first u32.
    private readonly debugModeData = new Uint32Array(1);

    constructor(stage: Stage) {
        super(stage);

        // `primitive_index` is optional WebGPU functionality. renderer.ts
        // requests it when available, and main.ts prevents this renderer from
        // being selected when the active adapter does not expose the feature.
        if (!renderer.supportsPrimitiveIndex) {
            throw new Error("Visibility Buffer requires the WebGPU primitive-index feature.");
        }

        this.visibilitySceneData = this.scene.getVisibilitySceneData();
        this.resources = this.createResources();
        this.createPerDrawResources();
    }

    private createResources(): VisibilityBufferResources {
        const geometrySceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Visibility Buffer geometry scene bind group layout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: 'uniform' },
            }],
        });
        const geometrySceneBindGroup = renderer.device.createBindGroup({
            label: 'Visibility Buffer geometry scene bind group',
            layout: geometrySceneBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.camera.uniformsBuffer } }],
        });

        const visibilityModelBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Visibility Buffer model and object-ID bind group layout',
            entries: [
                {
                    // The unchanged naive vertex shader consumes this binding.
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                },
                {
                    // visibility_gbuffer.fs.wgsl consumes the per-draw ObjectID.
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        //geometry pass writes:
        //visibilityTexture: r32uint(ObjectID, TriangleID)
        //depthTexture: depth32float
        //compared to original deffered pass：
        //world position + normal + albedo + depth
        //conserving much more bandwidth, especially for large scenes with many small triangles
        const visibilityTexture = renderer.device.createTexture({
            label: 'Visibility Buffer ObjectID and TriangleID attachment',
            size: [renderer.canvas.width, renderer.canvas.height],
            // r32uint is one 32-bit channel, exactly the compact identity
            // attachment described in the assignment rather than a packed
            // normal/albedo G-buffer.
            format: 'r32uint',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const depthTexture = renderer.device.createTexture({
            label: 'Visibility Buffer sampleable depth attachment',
            size: [renderer.canvas.width, renderer.canvas.height],
            // The compute pass needs textureLoad(depth), unlike the base path's
            // non-sampled depth24plus attachment.
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const visibilityTextureView = visibilityTexture.createView();
        const depthTextureView = depthTexture.createView();

        const lightingSceneBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Visibility Buffer compute shading scene bind group layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
                { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
                { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                {
                    binding: 10,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { viewDimension: '2d-array' },
                },
                { binding: 11, visibility: GPUShaderStage.COMPUTE, sampler: {} },
                {
                    // A 16-byte uniform matches VisibilityDebugUniforms. It
                    // selects a diagnostic output without recompiling WGSL or
                    // rebuilding the geometry pipeline.
                    binding: 13,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
            ],
        });
        const debugUniformBuffer = renderer.device.createBuffer({
            label: 'Visibility Buffer diagnostic mode uniform',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const lightingSceneBindGroup = renderer.device.createBindGroup({
            label: 'Visibility Buffer compute shading scene bind group',
            layout: lightingSceneBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lights.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusters.metadataStorageBuffer } },
                { binding: 3, resource: { buffer: this.clusters.lightIndexStorageBuffer } },
                { binding: 4, resource: { buffer: this.clusters.overflowStorageBuffer } },
                { binding: 5, resource: depthTextureView },
                { binding: 6, resource: visibilityTextureView },
                { binding: 7, resource: { buffer: this.visibilitySceneData.vertexStorageBuffer } },
                { binding: 8, resource: { buffer: this.visibilitySceneData.indexStorageBuffer } },
                { binding: 9, resource: { buffer: this.visibilitySceneData.objectStorageBuffer } },
                { binding: 10, resource: this.visibilitySceneData.materialTextureArrayView },
                { binding: 11, resource: this.visibilitySceneData.materialSampler },
                { binding: 13, resource: { buffer: debugUniformBuffer } },
            ],
        });
        const lightingOutputBindGroupLayout = renderer.device.createBindGroupLayout({
            label: 'Visibility Buffer compute shading output bind group layout',
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                storageTexture: { access: 'write-only', format: 'rgba8unorm' },
            }],
        });

        const geometryVertexShader = renderer.device.createShaderModule({
            label: 'Visibility Buffer geometry vertex shader',
            code: shaders.naiveVertSrc,
        });
        const geometryFragmentShader = renderer.device.createShaderModule({
            label: 'Visibility Buffer geometry fragment shader',
            code: shaders.visibilityGBufferFragSrc,
        });
        const lightingComputeShader = renderer.device.createShaderModule({
            label: 'Visibility Buffer compute shading shader',
            code: shaders.visibilityLightingComputeSrc,
        });
        logShaderDiagnostics('Visibility geometry vertex', geometryVertexShader);
        logShaderDiagnostics('Visibility geometry fragment', geometryFragmentShader);
        logShaderDiagnostics('Visibility compute shading', lightingComputeShader);

        const geometryPipeline = renderer.device.createRenderPipeline({
            label: 'Visibility Buffer geometry pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Visibility Buffer geometry pipeline layout',
                bindGroupLayouts: [
                    geometrySceneBindGroupLayout,
                    visibilityModelBindGroupLayout,
                    renderer.materialBindGroupLayout,
                ],
            }),
            depthStencil: {
                depthWriteEnabled: true,
                depthCompare: 'less',
                format: 'depth32float',
            },
            vertex: {
                // The visibility pass intentionally reuses the world-space
                // transform path proven by Naive/Deferred.
                module: geometryVertexShader,
                buffers: [renderer.vertexBufferLayout],
            },
            fragment: {
                module: geometryFragmentShader,
                targets: [{ format: 'r32uint' }],
            },
        });

        const lightingComputePipeline = renderer.device.createComputePipeline({
            label: 'Visibility Buffer compute shading pipeline',
            layout: renderer.device.createPipelineLayout({
                label: 'Visibility Buffer compute shading pipeline layout',
                bindGroupLayouts: [lightingSceneBindGroupLayout, lightingOutputBindGroupLayout],
            }),
            compute: {
                module: lightingComputeShader,
            },
        });

        return {
            geometrySceneBindGroup,
            visibilityModelBindGroupLayout,
            lightingSceneBindGroup,
            lightingOutputBindGroupLayout,
            geometryPipeline,
            lightingComputePipeline,
            visibilityTextureView,
            depthTextureView,
            debugUniformBuffer,
        };
    }

    private createPerDrawResources(): void {
        for (const renderItem of this.visibilitySceneData.renderItems) {
            // Four u32 values match VisibilityDrawUniforms. It is intentionally
            // a distinct buffer per render item: simple and easy to inspect,
            // while the Sponza scene has only 103 entries. A production engine
            // would pack these into a dynamic-offset uniform buffer.
            const objectIdData = new Uint32Array([renderItem.objectId, 0, 0, 0]);
            const objectIdUniformBuffer = renderer.device.createBuffer({
                label: `Visibility Buffer ObjectID uniform ${renderItem.objectId}`,
                size: objectIdData.byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            renderer.device.queue.writeBuffer(objectIdUniformBuffer, 0, objectIdData);

            this.drawResourcesByObjectId[renderItem.objectId] = {
                bindGroup: renderer.device.createBindGroup({
                    label: `Visibility Buffer draw bind group ${renderItem.objectId}`,
                    layout: this.resources.visibilityModelBindGroupLayout,
                    entries: [
                        { binding: 0, resource: { buffer: renderItem.node.modelMatUniformBuffer } },
                        { binding: 1, resource: { buffer: objectIdUniformBuffer } },
                    ],
                }),
            };
        }
    }

    // 1. doLightClustering()
    // 2. geometry pass
    // 3. compute shading pass
    // 4. submit
    override draw(): void {
        const encoder = renderer.device.createCommandEncoder({ label: 'Visibility Buffer command encoder' });

        // The same cluster list is produced before either packed or visibility
        // shading. Visibility changes geometry/material bandwidth, not light
        // culling policy or overflow behavior.
        this.lights.doLightClustering(encoder);

        const geometryPass = encoder.beginRenderPass({
            label: 'Visibility Buffer geometry pass',
            colorAttachments: [{
                view: this.resources.visibilityTextureView,
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
        geometryPass.setPipeline(this.resources.geometryPipeline);
        geometryPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.geometrySceneBindGroup);

        // Iterate the pre-flattened object table, not only Mesh primitives:
        // each Node x Primitive receives the same ObjectID used in storage.
        let lastMaterialId: number | undefined;
        for (const renderItem of this.visibilitySceneData.renderItems) {
            const drawResources = this.drawResourcesByObjectId[renderItem.objectId];
            if (drawResources === undefined) {
                throw new Error(`Missing Visibility Buffer draw resources for object ${renderItem.objectId}.`);
            }
            geometryPass.setBindGroup(shaders.constants.bindGroup_model, drawResources.bindGroup);
            const material = renderItem.primitive.material;
            if (material.id !== lastMaterialId) {
                geometryPass.setBindGroup(shaders.constants.bindGroup_material, material.materialBindGroup);
                lastMaterialId = material.id;
            }
            geometryPass.setVertexBuffer(0, renderItem.primitive.vertexBuffer);
            geometryPass.setIndexBuffer(renderItem.primitive.indexBuffer, 'uint32');
            //objectID for this current draw
            //TriangleId = current fragment primitive_index
            geometryPass.drawIndexed(renderItem.primitive.numIndices);
        }
        geometryPass.end();

        // getCurrentTexture() is per-frame. All persistent Visibility resources
        // live in Scene/resources, while only this output binding is recreated.
        const outputTextureView = renderer.context.getCurrentTexture().createView();
        // Updating four u32 slots is deliberately cheap. It keeps the GUI
        // inspection selector live even while a single renderer instance keeps
        // drawing many animation frames.
        this.debugModeData[0] = selectedVisibilityDebugMode();
        renderer.device.queue.writeBuffer(this.resources.debugUniformBuffer, 0, this.debugModeData);
        const lightingOutputBindGroup = renderer.device.createBindGroup({
            label: 'Visibility Buffer compute shading output bind group',
            layout: this.resources.lightingOutputBindGroupLayout,
            entries: [{ binding: 0, resource: outputTextureView }],
        });

        const lightingPass = encoder.beginComputePass({ label: 'Visibility Buffer compute shading pass' });
        lightingPass.setPipeline(this.resources.lightingComputePipeline);
        lightingPass.setBindGroup(shaders.constants.bindGroup_scene, this.resources.lightingSceneBindGroup);
        lightingPass.setBindGroup(1, lightingOutputBindGroup);
        const workgroupSize = shaders.constants.deferredLightingWorkgroupSize;
        lightingPass.dispatchWorkgroups(
            Math.ceil(renderer.canvas.width / workgroupSize),
            Math.ceil(renderer.canvas.height / workgroupSize),
        );
        lightingPass.end();

        renderer.device.queue.submit([encoder.finish()]);
    }
}
