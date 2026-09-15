# CLAUDE.md

## Orientation

```text
main.ts
  -> initWebGPU / load Sponza / create Camera + Lights + Stage
  -> NaiveRenderer | ForwardPlusRenderer | ClusteredDeferredRenderer

Renderer frame loop
  -> camera.onFrame(delta)
  -> lights.onFrame(time)
  -> selectedRenderer.draw()
```

The advanced renderers use the same clustering entry point:
`lights.doLightClustering(encoder)`.

## Key files

| Area | TypeScript | WGSL |
| --- | --- | --- |
| Camera data | `src/stage/camera.ts` | `src/shaders/common.wgsl`, vertex shaders |
| Animated lights | `src/stage/lights.ts` | `src/shaders/move_lights.cs.wgsl` |
| Clustering | `src/stage/lights.ts` | `src/shaders/clustering.cs.wgsl` |
| Naive renderer | `src/renderers/naive.ts` | `naive.vs.wgsl`, `naive.fs.wgsl` |
| Forward+ | `src/renderers/forward_plus.ts` | `forward_plus.fs.wgsl` |
| Deferred | `src/renderers/clustered_deferred.ts` | `clustered_deferred*.wgsl` |

## Working sequence

1. Use Naive as the visual baseline.
2. Define shared camera and cluster data once, then mirror it in TypeScript and
   WGSL.
3. Implement the clustering compute pass and call it from Forward+.
4. Add the deferred G-buffer and fullscreen lighting pass using the same
   cluster data.
5. Use `npm run build` for a quick static check and `npm run dev` plus Chrome
   DevTools for runtime validation.

## WebGPU reminders

- Bind groups: scene `0`, model `1`, material `2`.
- `vec3f` is 16-byte aligned. Match host buffer offsets and WGSL struct layout.
- `common.wgsl` is prepended to each shader by `shaders.ts`.
- Compute work uses ceiling dispatch counts and bounds checks.
- G-buffer textures need render-attachment usage for writing and texture
  binding usage for the fullscreen readback path.
- Use milliseconds when recording performance comparisons.
