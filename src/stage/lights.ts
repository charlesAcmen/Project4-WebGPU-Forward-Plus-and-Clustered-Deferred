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
    }

    private populateLightsBuffer() {
        for (let lightIdx = 0; lightIdx < Lights.maxNumLights; ++lightIdx) {
            // light pos is set by compute shader so no need to set it here
            const lightColor = vec3.scale(hueToRgb(Math.random()), Lights.lightIntensity);
            writeLightColor(this.lightsArray, lightIdx, lightColor);
        }

        device.queue.writeBuffer(this.lightSetStorageBuffer, LightSetGpuLayout.lightsByteOffset, this.lightsArray.buffer as ArrayBuffer);
    }

    updateLightSetUniformNumLights() {
        writeLightSetNumLights(this.lightSetHeader, this.numLights);
        device.queue.writeBuffer(this.lightSetStorageBuffer, LightSetGpuLayout.numLightsOffset, this.lightSetHeader.buffer as ArrayBuffer);
    }

    doLightClustering(encoder: GPUCommandEncoder) {
        // TODO-2: run the light clustering compute pass(es) here
        // implementing clustering here allows for reusing the code in both Forward+ and Clustered Deferred
        const computePass = encoder.beginComputePass({ label: "light clustering compute pass" });
        computePass.setPipeline(this.lightClusteringComputePipeline);
        computePass.setBindGroup(0, this.lightClusteringBindGroup);
        const workgroupCount = Math.ceil(this.clusters.dimensions.clusterCount / shaders.constants.clusteringWorkgroupSize);
        computePass.dispatchWorkgroups(workgroupCount);
        computePass.end();
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
