import { Scene } from './stage/scene';
import { Lights } from './stage/lights';
import { Camera } from './stage/camera';
import { Clusters } from './stage/clusters';
import { Stage } from './stage/stage';
import { createRenderBudget } from './stage/render_budget';
import { PerformanceProfiler } from './performance/profiler';
import { GpuFrameRecorder } from './performance/gpu_timer';

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
export var supportsTimestampQuery = false;

export var aspectRatio: number;
export const fovYDegrees = 45;

export var modelBindGroupLayout: GPUBindGroupLayout;
export var materialBindGroupLayout: GPUBindGroupLayout;

// Resize observers drive the normal path. This only catches browser viewport
// changes that arrive without a corresponding event, such as delayed mobile
// rotation notifications.
const resizeSafetyCheckIntervalMs = 500;

function configureCanvasContext(): void {
    context.configure({
        device,
        format: canvasFormat,
        //STORAGE_BINDING:compute lighting pass
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });
}

function drawingBufferSize(): { width: number; height: number } {
    // The visual viewport can be scaled separately from the layout viewport
    // by mobile browsers and DevTools device emulation. Use one measured rect
    // and one scale for both axes: a buffer must always preserve this ratio.
    const rect = canvas.getBoundingClientRect();
    const renderBudget = createRenderBudget();
    const scale = Math.min(window.devicePixelRatio, renderBudget.maxDevicePixelRatio);
    return {
        width: Math.max(1, Math.round(rect.width * scale)),
        height: Math.max(1, Math.round(rect.height * scale)),
    };
}

export function canvasNeedsResize(): boolean {
    const { width, height } = drawingBufferSize();
    return canvas.width !== width || canvas.height !== height;
}

/**
 * Synchronize the WebGPU drawing-buffer dimensions with the CSS presentation
 * size. CSS can change independently on mobile when the device rotates or the
 * browser chrome expands, so `canvas.width` must not remain at its startup
 * portrait dimensions.
 */
export function resizeCanvasToDisplaySize(): boolean {
    const { width, height } = drawingBufferSize();

    //this is not duplicated with canvasNeedsResize()
    //resizeSafetyCheck is called every resizeSafetyCheckIntervalMs for late or missing resize events
    //so if the size did not change,just skip reconfiguring the canvas context etc stuffs.
    if (canvas.width === width && canvas.height === height) {
        return false;
    }

    canvas.width = width;
    canvas.height = height;
    aspectRatio = width / height;
    configureCanvasContext();
    return true;
}

export function showWebGpuStatusOverlay(titleText: string, reason: string): void {
    canvas.style.visibility = 'hidden';

    const overlay = document.getElementById('webgpu-status-overlay') ?? document.createElement('section');
    overlay.id = 'webgpu-status-overlay';
    overlay.className = 'webgpu-unsupported-overlay';
    overlay.setAttribute('role', 'alert');

    const panel = document.createElement('div');
    panel.className = 'webgpu-unsupported-panel';

    const title = document.createElement('h1');
    title.textContent = titleText;
    const detail = document.createElement('p');
    detail.textContent = reason;
    const suggestion = document.createElement('p');
    suggestion.textContent = '请使用最新版 Chrome，并开启硬件加速后重试。';

    panel.append(title, detail, suggestion);
    overlay.replaceChildren(panel);
    if (!overlay.isConnected) {
        document.body.appendChild(overlay);
    }
}

function failWebGpuInitialization(reason: string): never {
    showWebGpuStatusOverlay('此设备暂不支持 WebGPU', reason);
    throw new Error(reason);
}

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
    supportsTimestampQuery = adapter.features.has('timestamp-query');
    try {
        device = await adapter.requestDevice({
            requiredFeatures: [
                ...(supportsPrimitiveIndex ? ['primitive-index' as const] : []),
                ...(supportsTimestampQuery ? ['timestamp-query' as const] : []),
            ],
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
    private lastResizeSafetyCheckTime = Number.NEGATIVE_INFINITY;

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
        // Avoid reading layout every frame. ResizeObserver and viewport events
        // drive the normal path; this low-frequency probe catches a delayed
        // mobile rotation notification that otherwise leaves stale resources.
        if (time - this.lastResizeSafetyCheckTime >= resizeSafetyCheckIntervalMs) {
            this.lastResizeSafetyCheckTime = time;
            if (canvasNeedsResize()) {
                window.dispatchEvent(new Event('webgpu-canvas-resize-needed'));
                this.frameRequestId = requestAnimationFrame((t) => this.onFrame(t));
                return;
            }
        }

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
