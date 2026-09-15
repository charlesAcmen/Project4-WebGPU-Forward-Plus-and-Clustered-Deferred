# AGENTS.md

## Project

WebGPU renderer built with Vite, TypeScript, and WGSL. It renders Sponza with
three selectable paths: Naive Forward, Forward+, and Clustered Deferred.

## Commands

```powershell
npm install
npm run dev
npm run build
```

`npm run dev` opens Vite in the browser. `npm run build` produces `dist/` and
copies `scenes/` into it. Use Chrome with WebGPU enabled and the discrete GPU
selected when visually testing renderer changes.

## Source map

- `src/main.ts`: initializes WebGPU, Sponza, camera, lights, stats, GUI, and
  switches among renderer modes.
- `src/renderer.ts`: canvas/device setup, shared model/material bind-group
  layouts, vertex layout, and request-animation-frame loop.
- `src/stage/camera.ts`: camera controls and camera uniform buffer updates.
- `src/stage/lights.ts`: light storage, animated-light compute pass, and the
  light-clustering compute path shared by advanced renderers.
- `src/renderers/naive.ts`: baseline geometry + lighting pass.
- `src/renderers/forward_plus.ts`: clustered forward pipeline.
- `src/renderers/clustered_deferred.ts`: G-buffer pass and fullscreen lighting
  pass.
- `src/shaders/`: WGSL sources. `shaders.ts` prepends `common.wgsl` and
  expands `${...}` constants.
- `scenes/sponza/`: scene geometry and textures.

## Practical implementation path

1. Complete the Naive camera uniform path in `camera.ts`, `naive.ts`,
   `common.wgsl`, and `naive.vs.wgsl`.
2. Establish one camera/cluster buffer layout across host code and WGSL.
3. Implement clustering in `lights.ts` plus `clustering.cs.wgsl`.
4. Build Forward+ from that shared cluster list.
5. Reuse the list for the Clustered Deferred G-buffer and fullscreen pass.

## Rendering contracts

- Shared bind-group indices in `shaders.constants` are scene `0`, model `1`,
  and material `2`.
- Host buffers and WGSL structs must use identical offsets, alignment, array
  stride, and binding type. A `vec3f` has 16-byte alignment; the starter light
  representation uses eight host floats per light.
- `common.wgsl` is included in every shader, so shared structs and lighting
  helpers belong there.
- The clustering dispatch needs ceiling division, global-ID bounds checks,
  per-cluster counter initialization, and a maximum capacity for each light
  list.
- Keep coordinate spaces explicit: world-space lighting data, view-space
  cluster bounds, clip space, and screen coordinates have distinct roles.
- Deferred attachments require compatible formats, usages, views, and pipeline
  targets; the fullscreen pass reads the attributes written by the G-buffer.

## Validation notes

- `npm run build` catches packaging/type-level issues.
- Browser console validation messages catch WebGPU layout, shader, and pass
  setup issues.
- Compare Naive, Forward+, and Deferred at several light counts from similar
  camera positions.
- For performance work, record milliseconds along with renderer, light count,
  resolution, GPU/browser, and camera state.
