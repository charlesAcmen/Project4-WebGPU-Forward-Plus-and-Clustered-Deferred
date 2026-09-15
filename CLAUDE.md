# CLAUDE.md

## Read first

Read `AGENTS.md` and `INSTRUCTIONS.md` before editing. This is CIS 565 Project
4, not a generic WebGPU sample: implementation and write-up requirements are
both graded, and third-party core rendering code is prohibited without course
approval.

## Fast orientation

```text
main.ts
  -> initWebGPU / load Sponza / create Camera + Lights + Stage
  -> select NaiveRenderer | ForwardPlusRenderer | ClusteredDeferredRenderer
Renderer frame loop
  -> camera.onFrame(delta)
  -> lights.onFrame(time)       # light animation compute encoder
  -> selectedRenderer.draw()    # clustering + graphics work, as applicable
```

The renderer's shared bind groups use the fixed indices defined in
`src/shaders/shaders.ts`: scene 0, model 1, material 2.

## Work plan

1. Establish a working Naive baseline before implementing a clustered path.
2. Make one shared cluster data contract across `lights.ts`, `camera.ts`,
   `clustering.cs.wgsl`, and the Forward+/deferred shaders.
3. Have both advanced renderers invoke `lights.doLightClustering(encoder)`.
4. Make Forward+ correct before building the deferred G-buffer/fullscreen
   composition.
5. Measure first; optimize second. Keep records for the README as you work.

## Important files

| Area | Host code | Shader code |
| --- | --- | --- |
| Camera uniform(s) | `src/stage/camera.ts` | `src/shaders/common.wgsl`, vertex shaders |
| Light animation | `src/stage/lights.ts` | `src/shaders/move_lights.cs.wgsl` |
| Clustering | `src/stage/lights.ts` | `src/shaders/clustering.cs.wgsl` |
| Naive baseline | `src/renderers/naive.ts` | `naive.vs.wgsl`, `naive.fs.wgsl` |
| Forward+ | `src/renderers/forward_plus.ts` | `forward_plus.fs.wgsl` |
| Deferred | `src/renderers/clustered_deferred.ts` | `clustered_deferred*.wgsl` |

## Non-negotiable checks

- Any WGSL struct/binding change requires the matching TypeScript buffer,
  bind-group layout, bind group, and pipeline layout change in the same edit.
- Respect WGSL uniform/storage alignment and padding. `vec3f` is 16-byte
  aligned; do not treat it as a tightly packed three-float array.
- Compute shaders need bounds checks. Cluster list writes need counter reset
  and capacity checks.
- Run `npm run build` after edits. Then launch `npm run dev` in Chrome with
  WebGPU enabled and inspect console validation errors; build success alone is
  insufficient.
- Validate visual parity across renderer modes and performance with stable,
  documented conditions. Use milliseconds in the report.

## Do not do

- Do not change `scenes/sponza` or generated `dist/` for renderer work.
- Do not fabricate README screenshots, video, deployment URL, or measurements.
- Do not use a fullscreen render pass when claiming the compute-pass-only
  post-processing extra credit.
- Do not discard user changes or rewrite unrelated files.
