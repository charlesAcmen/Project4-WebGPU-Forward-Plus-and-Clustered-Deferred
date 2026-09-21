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

    // This query flag is intentionally available in both dev and release. It
    // verifies that a public deployment can display the same explanatory UI
    // without needing to disable WebGPU on the test device.
    if (new URLSearchParams(window.location.search).get('webgpu-overlay') === '1') {
        showWebGpuStatusOverlay(
            'WebGPU 诊断提示',
            '这是手动触发的诊断遮罩；页面的 WebGPU 初始化仍会在后台继续。',
        );
    }

    if (!navigator.gpu)
    {
        failWebGpuInitialization('浏览器没有提供 WebGPU 接口。');
    }

    let adapter: GPUAdapter | null;
    try {
        adapter = await navigator.gpu.requestAdapter();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failWebGpuInitialization(`无法请求 WebGPU 图形适配器：${detail}`);
    }
    if (!adapter)
    {
        failWebGpuInitialization('没有找到可用的 WebGPU 图形适配器。');
    }

    // Visibility Buffer support is optional: request the feature when the
    // adapter exposes it, but do not prevent Naive/Forward+/Deferred from
    // running on an adapter that does not. The visibility renderer itself
    // performs the corresponding user-facing availability check.
    supportsPrimitiveIndex = adapter.features.has("primitive-index");
    try {
        device = await adapter.requestDevice({
            requiredFeatures: supportsPrimitiveIndex ? ["primitive-index"] : [],
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failWebGpuInitialization(`无法创建 WebGPU 设备：${detail}`);
    }

    // Pipeline/attachment validation and device loss can happen after a
    // successful adapter request. Surface their browser-provided reason on a
    // deployed page instead of leaving a black canvas with console-only clues.
    device.addEventListener('uncapturederror', event => {
        showWebGpuStatusOverlay('WebGPU 渲染错误', event.error.message);
    });
    void device.lost.then(info => {
        showWebGpuStatusOverlay(
            'WebGPU 设备已丢失',
            info.message || `设备丢失原因：${info.reason}`,
        );
    });

    const canvasContext = canvas.getContext("webgpu");
    if (!canvasContext) {
        failWebGpuInitialization('浏览器无法创建 WebGPU 画布上下文。');
    }
    context = canvasContext;
    // The compute lighting pass writes the present texture directly. rgba8unorm
    // is a core write-only storage-texture format, unlike bgra8unorm which needs
    // the optional bgra8unorm-storage feature on some adapters.
    canvasFormat = "rgba8unorm";
    try {
        resizeCanvasToDisplaySize();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failWebGpuInitialization(`无法配置 WebGPU 画布：${detail}`);
    }

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
