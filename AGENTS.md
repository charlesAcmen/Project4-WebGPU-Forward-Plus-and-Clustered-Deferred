# AGENTS.md

## Project

UPenn CIS 565 Project 4: a Vite + TypeScript + WGSL WebGPU renderer that
implements Naive Forward, Forward+, and Clustered Deferred shading for Sponza.
The public entry point is `src/main.ts`; run it in a WebGPU-capable Chrome
installation on the discrete GPU.

## Commands

```powershell
npm install
npm run dev
npm run build
```

`npm run dev` starts Vite and opens the browser. `npm run build` type-checks
through Vite and writes `dist/`, then copies `scenes/` into it. Treat a passing
build as a static check only: it does not prove GPU pipeline validation,
rendered correctness, or performance.

## Architecture and ownership

- `src/main.ts` initializes WebGPU, scene, camera, lights, stats, GUI, and
  switches renderer modes.
- `src/renderer.ts` owns WebGPU initialization, canvas configuration, shared
  model/material layouts, vertex layout, and the frame loop.
- `src/stage/camera.ts` owns camera controls and camera uniform uploads.
- `src/stage/lights.ts` owns the light buffer, light animation compute pass,
  and the reusable light-clustering compute pass.
- `src/renderers/naive.ts` is the baseline direct-lighting render pass.
- `src/renderers/forward_plus.ts` owns the Forward+ render pipeline and calls
  `Lights.doLightClustering` before shading.
- `src/renderers/clustered_deferred.ts` owns G-buffer resources/passes and the
  fullscreen lighting pass; it also reuses `Lights.doLightClustering`.
- `src/shaders/*.wgsl` are shader sources. `src/shaders/shaders.ts` prepends
  `common.wgsl` and supplies `${...}` compile-time constants.
- `scenes/sponza/` is assignment-provided scene data. Do not modify it unless
  the task explicitly changes assets.

## Implementation order

1. Finish and visually validate Naive first (camera uniform, bind group, and
   vertex shader); use it as the correctness baseline.
2. Define the shared clustering representation and its host/WGSL layouts.
3. Implement Forward+ by dispatching clustering, then shading only the lights
   listed for the current cluster.
4. Reuse that clustering path for Clustered Deferred: G-buffer geometry pass,
   then fullscreen lighting pass.
5. Add any extra-credit effect or optimization only after required modes work
   and can be measured.

## WebGPU / WGSL invariants

- Keep TypeScript buffer byte layout exactly synchronized with WGSL structs:
  account for WGSL alignment, padding, array stride, matrix alignment, and
  buffer binding type. Check layouts whenever a struct changes.
- The existing light layout is `LightSet { numLights: u32; padding; lights }`;
  each `Light` has two `vec3f` values with 16-byte alignment (8 host floats).
  Preserve this contract unless host and shader are changed together.
- Preserve bind-group indices exposed by `shaders.constants`:
  scene `0`, model `1`, material `2`. Pipeline layouts, shader declarations,
  and `setBindGroup` calls must agree.
- `common.wgsl` is prepended to every shader. Shared structs/functions belong
  there; shader-local declarations must not conflict with it.
- Use integer ceiling division for compute dispatches and bounds-check global
  invocation IDs. Reset per-cluster counters before appending indices and cap
  each list to its allocated maximum.
- Submit valid command encoders only after every pass is ended. Keep light
  animation separate from renderer timing as the starter code intends.
- Recreate size-dependent render targets if canvas dimensions can change.

## Rendering correctness

- Keep world space, view space, clip space, and screen/cluster coordinates
  explicit. Do not mix a world position with a view-space cluster AABB.
- Keep `Camera.nearPlane`, `Camera.farPlane`, FOV, and canvas aspect ratio
  consistent between clustering and rendering.
- G-buffer attachments must have compatible texture formats, usages, views,
  and pipeline targets. Its fullscreen pass samples exactly the written data.
- Verify Naive, Forward+, and Clustered Deferred at small and large light
  counts. Compare similar camera frames for visual agreement; check Chrome's
  console for WebGPU validation errors after each mode switch.

## Performance evidence

- Report timings in milliseconds, not FPS. Record renderer, light count,
  canvas resolution, browser/GPU, scene/camera state, and measurement method.
- Compare Forward+ and Clustered Deferred on more than one workload; explain
  the observed tradeoffs rather than assuming one is universally faster.
- For every optimization/effect, preserve a before/after measurement and any
  relevant parameters (for example tile/cluster dimensions and light count).
  A build or a screenshot is not performance evidence.

## Scope, academic integrity, and delivery

- Search `TODO-*` and `CHECKITOUT` before changing code; follow the assignment
  steps in `INSTRUCTIONS.md`.
- Do not copy third-party core rendering code. Any approved third-party code
  must be credited in `README.md`, per the assignment policy.
- Do not replace the README placeholder until real screenshots, video/GIF,
  deployment URL, and measured analysis exist. Never invent benchmark or
  browser/device results.
- Before committing, run `npm run build`, inspect `git diff`, and preserve
  unrelated working-tree changes. A submission also needs the requested GitHub
  Pages workflow setup and a PR titled `Project 4: YOUR NAME`.
