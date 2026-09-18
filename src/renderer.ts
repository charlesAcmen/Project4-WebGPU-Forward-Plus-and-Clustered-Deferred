import { Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Clusters } from './stage/clusters';
import { Stage } from './stage/stage';

export var canvas: HTMLCanvasElement;
export var canvasFormat: GPUTextureFormat;
export var context: GPUCanvasContext;
export var device: GPUDevice;
export var canvasTextureView: GPUTextureView;

// `primitive-index` is not part of the minimum WebGPU feature set. The
// Visibility Buffer renderer uses it to obtain the triangle number of the
// current indexed draw directly in its fragment shader. Keeping the result
// here lets the GUI leave the other render paths usable on older adapters.
export var supportsPrimitiveIndex = false;

export var aspectRatio: number;
export const fovYDegrees = 45;

export var modelBindGroupLayout: GPUBindGroupLayout;
export var materialBindGroupLayout: GPUBindGroupLayout;

// CHECKITOUT: this function initializes WebGPU and also creates some bind group layouts shared by all the renderers
export async function initWebGPU() {
    //as:type assertion
    canvas = document.getElementById("mainCanvas") as HTMLCanvasElement;

    const devicePixelRatio = window.devicePixelRatio;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;

    aspectRatio = canvas.width / canvas.height;

    if (!navigator.gpu)
    {
        let errorMessageElement = document.createElement("h1");
        errorMessageElement.textContent = "This browser doesn't support WebGPU! Try using Google Chrome.";
        errorMessageElement.style.paddingLeft = '0.4em';
        document.body.innerHTML = '';
        document.body.appendChild(errorMessageElement);
        throw new Error("WebGPU not supported on this browser");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter)
    {
        throw new Error("no appropriate GPUAdapter found");
    }

    // Visibility Buffer support is optional: request the feature when the
    // adapter exposes it, but do not prevent Naive/Forward+/Deferred from
    // running on an adapter that does not. The visibility renderer itself
    // performs the corresponding user-facing availability check.
    supportsPrimitiveIndex = adapter.features.has("primitive-index");
    device = await adapter.requestDevice({
        requiredFeatures: supportsPrimitiveIndex ? ["primitive-index"] : [],
    });

    context = canvas.getContext("webgpu")!;
    // The compute lighting pass writes the present texture directly. rgba8unorm
    // is a core write-only storage-texture format, unlike bgra8unorm which needs
    // the optional bgra8unorm-storage feature on some adapters.
    canvasFormat = "rgba8unorm";
    context.configure({
        device: device,
        format: canvasFormat,
    });

    console.log("WebGPU init successsful");
    console.log(`Visibility Buffer primitive-index support: ${supportsPrimitiveIndex}`);

    modelBindGroupLayout = device.createBindGroupLayout({
        label: "model bind group layout",
        entries: [
            { // modelMat
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: { type: "uniform" }
            }
        ]
    });

    materialBindGroupLayout = device.createBindGroupLayout({
        label: "material bind group layout",
        entries: [
            { // diffuseTex
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {}
            },
            { // diffuseTexSampler:nearest filtering,linear filtering,repeat,clamp etc
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: {}
            }
        ]
    });
}

export const vertexBufferLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
        { // pos
            format: "float32x3",
            offset: 0,
            shaderLocation: 0//@location(0) position: vec3<f32>;
        },
        { // nor
            format: "float32x3",
            offset: 12,
            shaderLocation: 1//@location(1) normal: vec3<f32>;
        },
        { // uv
            format: "float32x2",
            offset: 24,
            shaderLocation: 2//@location(2) uv: vec2<f32>;
        }
    ]
};

export abstract class Renderer {
    protected scene: Scene;
    protected lights: Lights;
    protected camera: Camera;
    protected clusters: Clusters;

    protected stats: Stats;

    private prevTime: number = 0;
    private frameRequestId: number;

    constructor(stage: Stage) {
        this.scene = stage.scene;
        this.lights = stage.lights;
        this.camera = stage.camera;
        this.clusters = stage.clusters;
        this.stats = stage.stats;

        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }

    stop(): void {
        cancelAnimationFrame(this.frameRequestId);
    }

    protected abstract draw(): void;

    // CHECKITOUT: this is the main rendering loop
    private onFrame(time: number) {
        if (this.prevTime == 0) {
            this.prevTime = time;
        }

        let deltaTime = time - this.prevTime;
        this.camera.onFrame(deltaTime);
        this.lights.onFrame(time);

        this.stats.begin();

        this.draw();

        this.stats.end();

        this.prevTime = time;
        this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
    }
}
