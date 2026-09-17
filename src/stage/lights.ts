import { vec3 } from "wgpu-matrix";
import { device } from "../renderer";

import * as shaders from '../shaders/shaders';
import { Camera } from "./camera";
import { Clusters } from "./clusters";
import {
    createLightRecordData,
    createLightSetHeader,
    getLightSetByteSize,
    LightGpuLayout,
    LightSetGpuLayout,
    writeLightColor,
    writeLightSetNumLights,
} from "./gpu_layouts";

// h in [0, 1]
function hueToRgb(h: number) {
    let f = (n: number, k = (n + h * 6) % 6) => 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    return vec3.lerp(vec3.create(1, 1, 1), vec3.create(f(5), f(3), f(1)), 0.8);
}

export class Lights {
    private camera: Camera;
    private clusters: Clusters;

    numLights = 500;
    static readonly maxNumLights = 5000;
    static readonly numFloatsPerLight = LightGpuLayout.float32sPerLight; // vec3f is aligned at 16 byte boundaries

    static readonly lightIntensity = 0.1;

    lightsArray = createLightRecordData(Lights.maxNumLights);
    private readonly lightSetHeader = createLightSetHeader();
    lightSetStorageBuffer: GPUBuffer;

    timeUniformBuffer: GPUBuffer;

    moveLightsComputeBindGroupLayout: GPUBindGroupLayout;
    moveLightsComputeBindGroup: GPUBindGroup;
    moveLightsComputePipeline: GPUComputePipeline;

    lightClusteringBindGroupLayout: GPUBindGroupLayout;
    lightClusteringBindGroup: GPUBindGroup;
    lightClusteringComputePipeline: GPUComputePipeline;
    adaptiveClusterCountPipeline: GPUComputePipeline;
    adaptiveClusterPrefixPipeline: GPUComputePipeline;
    adaptiveClusterFillPipeline: GPUComputePipeline;

    // TODO-2: add layouts, pipelines, textures, etc. needed for light clustering here

    constructor(camera: Camera, clusters: Clusters) {
        this.camera = camera;
        this.clusters = clusters;

        this.lightSetStorageBuffer = device.createBuffer({
            label: "lights",
            size: getLightSetByteSize(Lights.maxNumLights),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this.populateLightsBuffer();
        this.updateLightSetUniformNumLights();

        this.timeUniformBuffer = device.createBuffer({
            label: "time uniform",
            size: 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.moveLightsComputeBindGroupLayout = device.createBindGroupLayout({
            label: "move lights compute bind group layout",
            entries: [
                { // lightSet
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" }
                },
                { // time
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "uniform" }
                }
            ]
        });

        this.moveLightsComputeBindGroup = device.createBindGroup({
            label: "move lights compute bind group",
            layout: this.moveLightsComputeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.lightSetStorageBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: this.timeUniformBuffer }
                }
            ]
        });

        this.moveLightsComputePipeline = device.createComputePipeline({
            label: "move lights compute pipeline",
            layout: device.createPipelineLayout({
                label: "move lights compute pipeline layout",
                bindGroupLayouts: [ this.moveLightsComputeBindGroupLayout ]
            }),
            compute: {
                module: device.createShaderModule({
                    label: "move lights compute shader",
                    code: shaders.moveLightsComputeSrc
                }),
                entryPoint: "main"
            }
        });

        // TODO-2: initialize layouts, pipelines, textures, etc. needed for light clustering here
        this.lightClusteringBindGroupLayout = device.createBindGroupLayout({
            label: "light clustering bind group layout",
            entries: [
                {
                    //0： camera uniform buffer
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    //constant cache,broadcast to all across the workgroups（warp）
                    buffer: { type: "uniform" },
                },
                {
                    //1： light set storage buffer
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    //shader will not modify pos+color+radius
                    //avoiding write-back and cache invalidation
                    buffer: { type: "read-only-storage" },
                },
                {
                    //2： clusters metadata storage buffer
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
                {
                    //3： clusters light index storage buffer
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
                {
                    //4： clusters overflow storage buffer
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: "storage" },
                },
            ],
        });

        this.lightClusteringBindGroup = device.createBindGroup({
            label: "light clustering bind group",
            layout: this.lightClusteringBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.uniformsBuffer } },
                { binding: 1, resource: { buffer: this.lightSetStorageBuffer } },
                { binding: 2, resource: { buffer: this.clusters.metadataStorageBuffer } },
                { binding: 3, resource: { buffer: this.clusters.lightIndexStorageBuffer } },
                { binding: 4, resource: { buffer: this.clusters.overflowStorageBuffer } },
            ],
        });

        this.lightClusteringComputePipeline = device.createComputePipeline({
            label: "light clustering compute pipeline",
            layout: device.createPipelineLayout({
                label: "light clustering compute pipeline layout",
                bindGroupLayouts: [this.lightClusteringBindGroupLayout],
            }),
            compute: {
                //Chromium tint will transpile the WGSL to SPIR-V and then back to WGSL
                module: device.createShaderModule({
                    label: "light clustering compute shader",
                    code: shaders.clusteringComputeSrc,
                }),
                //@compute entrypoint function named main in WGSL shader code
                entryPoint: "main",
            },
        });

        const adaptiveClusteringShader = device.createShaderModule({
            label: "adaptive light clustering compute shader",
            code: shaders.adaptiveClusteringComputeSrc,
        });
        const adaptiveClusteringPipelineLayout = device.createPipelineLayout({
            label: "adaptive light clustering pipeline layout",
            bindGroupLayouts: [this.lightClusteringBindGroupLayout],
        });
        this.adaptiveClusterCountPipeline = device.createComputePipeline({
            label: "adaptive cluster count pipeline",
            layout: adaptiveClusteringPipelineLayout,
            compute: { module: adaptiveClusteringShader, entryPoint: "countClusters" },
        });
        this.adaptiveClusterPrefixPipeline = device.createComputePipeline({
            label: "adaptive cluster prefix pipeline",
            layout: adaptiveClusteringPipelineLayout,
            compute: { module: adaptiveClusteringShader, entryPoint: "prefixClusterCounts" },
        });
        this.adaptiveClusterFillPipeline = device.createComputePipeline({
            label: "adaptive cluster fill pipeline",
            layout: adaptiveClusteringPipelineLayout,
            compute: { module: adaptiveClusteringShader, entryPoint: "fillClusterLists" },
        });
    }

    private populateLightsBuffer() {
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // light pos is set by compute shader so no need to set it here
            const lightColor = vec3.scale(hueToRgb(Math.random()), Lights.lightIntensity);
            writeLightColor(this.lightsArray, lightIdx, lightColor);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, LightSetGpuLayout.lightsByteOffset, this.lightsArray.buffer as ArrayBuffer);
    }

    updateLightSetUniformNumLights(): void {
        writeLightSetNumLights(this.lightSetHeader, this.numLights);
        device.queue.writeBuffer(this.lightSetStorageBuffer, LightSetGpuLayout.numLightsOffset, this.lightSetHeader.buffer as ArrayBuffer);
    }

    doLightClustering(encoder: GPUCommandEncoder) {
        // TODO-2: run the light clustering compute pass(es) here
        // implementing clustering here allows for reusing the code in both Forward+ and Clustered Deferred
        if (this.clusters.capacityStrategy === "adaptive") {
            this.doAdaptiveLightClustering(encoder);
            return;
        }

        const computePass = encoder.beginComputePass({ label: "light clustering compute pass" });
        computePass.setPipeline(this.lightClusteringComputePipeline);
        computePass.setBindGroup(0, this.lightClusteringBindGroup);
        const workgroupCount = Math.ceil(this.clusters.dimensions.clusterCount / shaders.constants.clusteringWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
    }

    private doAdaptiveLightClustering(encoder: GPUCommandEncoder): void {
        const clusterWorkgroupCount = Math.ceil(
            this.clusters.dimensions.clusterCount / shaders.constants.clusteringWorkgroupSize,
        );

        const countPass = encoder.beginComputePass({ label: "adaptive cluster count pass" });
        countPass.setPipeline(this.adaptiveClusterCountPipeline);
        countPass.setBindGroup(0, this.lightClusteringBindGroup);
        countPass.dispatchWorkgroups(clusterWorkgroupCount);
        countPass.end();

        // A separate pass makes all cluster counts visible to the serial prefix pass.
        const prefixPass = encoder.beginComputePass({ label: "adaptive cluster prefix pass" });
        prefixPass.setPipeline(this.adaptiveClusterPrefixPipeline);
        prefixPass.setBindGroup(0, this.lightClusteringBindGroup);
        prefixPass.dispatchWorkgroups(1);
        prefixPass.end();

        const fillPass = encoder.beginComputePass({ label: "adaptive cluster fill pass" });
        fillPass.setPipeline(this.adaptiveClusterFillPipeline);
        fillPass.setBindGroup(0, this.lightClusteringBindGroup);
        fillPass.dispatchWorkgroups(clusterWorkgroupCount);
        fillPass.end();
    }

    // CHECKITOUT: this is where the light movement compute shader is dispatched from the host
    onFrame(time: number) {
        device.queue.writeBuffer(this.timeUniformBuffer, 0, new Float32Array([time]));

        // not using same encoder as render pass so this doesn't interfere with measuring actual rendering performance
        const encoder = device.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.moveLightsComputePipeline);

        computePass.setBindGroup(0, this.moveLightsComputeBindGroup);

        const workgroupCount = Math.ceil(this.numLights / shaders.constants.moveLightsWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);

        computePass.end();

        device.queue.submit([encoder.finish()]);
    }
}
