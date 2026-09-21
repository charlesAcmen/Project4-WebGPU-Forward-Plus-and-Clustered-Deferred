/**
 * Release builds start conservatively on touch-class devices, then use frame
 * pacing as a coarse overload signal. Development intentionally exposes the
 * full light-count range so stress testing is never hidden by this policy.
 */
export interface RenderBudget {
    readonly enforced: boolean;
    readonly initialLightCount: number;
    readonly maxLightCount: number;
    readonly minimumLightCount: number;
    //thrashold for frame time to consider the device overloaded and reduce light count
    //different from GPU timestamp，frameTimeMs is affected by CPU,browser scheduling and switching between tabs.
    //hence this is a more conservative threshold to signal overload.
    readonly targetFrameTimeMs: number;
    //GPU rendering reso=maxDevicePixelRatio * canvas CSS size
    readonly maxDevicePixelRatio: number;
}

function isTouchClassDevice(): boolean {
    //pointer is thick and/or has touch points
    //laptop with touch screen is considered touch-class device
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

export function createRenderBudget(): RenderBudget {
    if (import.meta.env.DEV) {
        // Keep the 5000-light stress range, but retain the same overload
        // safety valve as release builds so an accidental extreme setting
        // cannot leave the development tab unresponsive indefinitely.
        return {
            enforced: true,
            initialLightCount: 500,
            maxLightCount: 5000,
            minimumLightCount: 1,
            targetFrameTimeMs: 45,
            maxDevicePixelRatio: Number.POSITIVE_INFINITY,
        };
    }

    //for mobile and tablet
    if (isTouchClassDevice()) {
        return {
            enforced: true,
            initialLightCount: 128,
            maxLightCount: 256,
            minimumLightCount: 32,
            targetFrameTimeMs: 45,
            // Full phone DPR can multiply both visibility-buffer and compute work.
            maxDevicePixelRatio: 1.25,
        };
    }

    //roughly for pc
    return {
        enforced: true,
        initialLightCount: 500,
        maxLightCount: 1500,
        minimumLightCount: 64,
        targetFrameTimeMs: 45,
        maxDevicePixelRatio: 2,
    };
}
