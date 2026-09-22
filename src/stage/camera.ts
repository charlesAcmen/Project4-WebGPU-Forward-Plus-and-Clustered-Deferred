import { Mat4, mat4, Vec3, vec3 } from "wgpu-matrix";
import { toRadians } from "../math_util";
import { device, canvas, fovYDegrees, aspectRatio } from "../renderer";
import {
    createCameraUniformData,
    writeCameraClusteringParams,
    writeCameraInverseViewProjection,
    writeCameraView,
    writeCameraViewProjection,
} from "./gpu_layouts";

export interface CameraPose {
    position: readonly [number, number, number];
    yaw: number;
    pitch: number;
}

export const sponzaStartPose: CameraPose = {
    position: [-7, 2, 0],
    yaw: 0,
    pitch: 0,
};
//CPU side representation of the camera uniforms
class CameraUniforms {
    //readonly:can not be modified after initialization
    readonly buffer = createCameraUniformData();
    //reinterpret the buffer as a Float32Array
    private readonly floatView = this.buffer;

    //setter:automatically called when the property is assigned a value
    set viewProjMat(mat: Float32Array) {
        // TODO-1.1: set the first 16 elements of `this.floatView` to the input `mat`
        writeCameraViewProjection(this.floatView, mat);
    }

    set viewMat(mat: Float32Array) {
        writeCameraView(this.floatView, mat);
    }

    set inverseViewProjMat(mat: Float32Array) {
        writeCameraInverseViewProjection(this.floatView, mat);
    }

    // TODO-2: add extra functions to set values needed for light clustering here
    setClusteringParams(
        nearPlane: number,
        farPlane: number,
        tanHalfFovY: number,
        aspectRatio: number,
        viewportWidth: number,
        viewportHeight: number,
    ): void {
        writeCameraClusteringParams(
            this.floatView,
            nearPlane,
            farPlane,
            tanHalfFovY,
            aspectRatio,
            viewportWidth,
            viewportHeight,
        );
    }
}

export class Camera {
    uniforms: CameraUniforms = new CameraUniforms();
    uniformsBuffer: GPUBuffer;// GPU buffer for camera uniforms

    projMat: Mat4 = mat4.create();// Projection matrix
    cameraPos: Vec3 = vec3.create(-7, 2, 0);//camera position in world space
    cameraFront: Vec3 = vec3.create(0, 0, -1);//camera viewing direction
    cameraUp: Vec3 = vec3.create(0, 1, 0); // Camera up vector
    cameraRight: Vec3 = vec3.create(1, 0, 0); // Camera right vector
    //no int,float,double in TypeScript, only number type（IEEE 754）
    // Horizontal heading angle in degrees; rotates the view direction around the world Y axis.
    yaw: number = 0;
    // Vertical elevation angle in degrees; tilts the view up or down and is clamped to avoid a flipped camera.
    pitch: number = 0;
    moveSpeed: number = 0.004;
    sensitivity: number = 0.15;

    //equivalent to static constexpr float nearPlane = 0.1f; in C++
    static readonly nearPlane = 0.1;
    static readonly farPlane = 1000;

    //equivalent to std::unordered_map<string, boolean> keys in C++
    keys: { [key: string]: boolean } = {};
    // Pointer Lock has no touch equivalent. Keep the active finger and its
    // previous CSS-pixel position so a one-finger drag can use the same
    // relative yaw/pitch update as desktop mouse movement.
    private activeTouchPointerId: number | undefined;
    private lastTouchX = 0;
    private lastTouchY = 0;
    private inputLocked = false;

    setInputLocked(locked: boolean): void {
        this.inputLocked = locked;
        if (locked) {
            this.keys = {};
            if (document.pointerLockElement === canvas) void document.exitPointerLock();
        }
    }

    constructor () {
        // TODO-1.1: set `this.uniformsBuffer` to a new buffer of size `this.uniforms.buffer.byteLength`
        // ensure the usage is set to `GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST` since we will be copying to this buffer
        // check `lights.ts` for examples of using `device.createBuffer()`
        //
        // note that you can add more variables (e.g. inverse proj matrix) to this buffer in later parts of the assignment
        this.uniformsBuffer = device.createBuffer({
            label: "camera uniforms",
            size: this.uniforms.buffer.byteLength,
            //UNIFORM:every vertex read in the same frame and the same draw call
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.projMat = mat4.perspective(toRadians(fovYDegrees), aspectRatio, Camera.nearPlane, Camera.farPlane);

        this.rotateCamera(0, 0); // set initial camera vectors

        //this refers to Camera instance,rather than being the window object
        window.addEventListener('keydown', (event) => this.onKeyEvent(event, true));
        window.addEventListener('keyup', (event) => this.onKeyEvent(event, false));
        window.onblur = () => this.keys = {}; // reset keys on page exit so they don't get stuck (e.g. on alt + tab)

        canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event), { passive: false });
        canvas.addEventListener('pointermove', (event) => this.onPointerMove(event), { passive: false });
        canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
        canvas.addEventListener('pointercancel', (event) => this.onPointerUp(event));
        canvas.addEventListener('lostpointercapture', (event) => this.onPointerUp(event));
    }

    /** Rebuild the projection whenever renderer.ts changes the drawing size. */
    resizeProjection(): void {
        this.projMat = mat4.perspective(toRadians(fovYDegrees), aspectRatio, Camera.nearPlane, Camera.farPlane);
    }

    applyPose(pose: CameraPose): void {
        this.cameraPos = vec3.create(...pose.position);
        this.yaw = pose.yaw;
        this.pitch = pose.pitch;
        this.keys = {};
        this.rotateCamera(0, 0);
    }

    private onKeyEvent(event: KeyboardEvent, down: boolean) {
        if (this.inputLocked) return;
        this.keys[event.key.toLowerCase()] = down;
        if (this.keys['alt']) { // prevent issues from alt shortcuts
            event.preventDefault();
        }
    }

    private rotateCamera(dx: number, dy: number) {
        this.yaw += dx;
        this.pitch -= dy;

        if (this.pitch > 89) {
            this.pitch = 89;
        }
        if (this.pitch < -89) {
            this.pitch = -89;
        }

        const front = mat4.create();
        front[0] = Math.cos(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));
        front[1] = Math.sin(toRadians(this.pitch));
        front[2] = Math.sin(toRadians(this.yaw)) * Math.cos(toRadians(this.pitch));

        this.cameraFront = vec3.normalize(front);
        this.cameraRight = vec3.normalize(vec3.cross(this.cameraFront, [0, 1, 0]));
        this.cameraUp = vec3.normalize(vec3.cross(this.cameraRight, this.cameraFront));
    }

    private onPointerDown(event: PointerEvent): void {
        if (this.inputLocked) return;
        if (event.pointerType === 'mouse') {
            if (event.button === 0) {
                canvas.requestPointerLock();
            }
            return;
        }

        if (event.pointerType !== 'touch' || this.activeTouchPointerId !== undefined) {
            return;
        }

        this.activeTouchPointerId = event.pointerId;
        this.lastTouchX = event.clientX;
        this.lastTouchY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    private onPointerMove(event: PointerEvent): void {
        if (this.inputLocked) return;
        if (event.pointerType === 'touch' && event.pointerId === this.activeTouchPointerId) {
            const dx = event.clientX - this.lastTouchX;
            const dy = event.clientY - this.lastTouchY;
            this.lastTouchX = event.clientX;
            this.lastTouchY = event.clientY;
            this.rotateCamera(dx * this.sensitivity, dy * this.sensitivity);
            event.preventDefault();
            return;
        }

        if (document.pointerLockElement === canvas) {
            this.rotateCamera(event.movementX * this.sensitivity, event.movementY * this.sensitivity);
        }
    }

    private onPointerUp(event: PointerEvent): void {
        if (event.pointerType === 'mouse') {
            if (event.button === 0 && document.pointerLockElement === canvas) {
                document.exitPointerLock();
            }
            return;
        }

        if (event.pointerId === this.activeTouchPointerId) {
            this.activeTouchPointerId = undefined;
        }
    }

    private processInput(deltaTime: number) {
        let moveDir = vec3.create(0, 0, 0);
        if (this.keys['w']) {
            moveDir = vec3.add(moveDir, this.cameraFront);
        }
        if (this.keys['s']) {
            moveDir = vec3.sub(moveDir, this.cameraFront);
        }
        if (this.keys['a']) {
            moveDir = vec3.sub(moveDir, this.cameraRight);
        }
        if (this.keys['d']) {
            moveDir = vec3.add(moveDir, this.cameraRight);
        }
        if (this.keys['q']) {
            moveDir = vec3.sub(moveDir, this.cameraUp);
        }
        if (this.keys['e']) {
            moveDir = vec3.add(moveDir, this.cameraUp);
        }

        let moveSpeed = this.moveSpeed * deltaTime;
        const moveSpeedMultiplier = 3;
        if (this.keys['shift']) {
            moveSpeed *= moveSpeedMultiplier;
        }
        if (this.keys['alt']) {
            moveSpeed /= moveSpeedMultiplier;
        }

        if (vec3.length(moveDir) > 0) {
            const moveAmount = vec3.scale(vec3.normalize(moveDir), moveSpeed);
            this.cameraPos = vec3.add(this.cameraPos, moveAmount);
        }
    }

    onFrame(deltaTime: number) {
        this.processInput(deltaTime);

        const lookPos = vec3.add(this.cameraPos, vec3.scale(this.cameraFront, 1));
        const viewMat = mat4.lookAt(this.cameraPos, lookPos, [0, 1, 0]);
        const viewProjMat = mat4.mul(this.projMat, viewMat);
        // TODO-1.1: set `this.uniforms.viewProjMat` to the newly calculated view proj mat
        this.uniforms.viewProjMat = viewProjMat;
        // Compute this once on the CPU instead of performing a matrix inverse
        // independently for every packed-deferred lighting invocation.
        this.uniforms.inverseViewProjMat = mat4.inverse(viewProjMat);

        // TODO-2: write to extra buffers needed for light clustering here
        this.uniforms.viewMat = viewMat;
        this.uniforms.setClusteringParams(
            Camera.nearPlane,
            Camera.farPlane,
            Math.tan(toRadians(fovYDegrees) * 0.5),
            aspectRatio,
            canvas.width,
            canvas.height,
        );

        // TODO-1.1: upload `this.uniforms.buffer` (host side) to `this.uniformsBuffer` (device side)
        // check `lights.ts` for examples of using `device.queue.writeBuffer()`
        device.queue.writeBuffer(this.uniformsBuffer, 0, this.uniforms.buffer);
    }
}
