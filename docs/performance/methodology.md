# Performance measurement protocol

This implementation supplies live CPU/GPU measurements and an opt-in cluster
snapshot. It does **not** run the 3.3 benchmark state machine or 3.4 JSON/CSV
export; those were explicitly excluded. No course performance conclusion follows
from a screenshot or from a successful build alone.

## What the numbers mean

- `Frame interval`: time between `requestAnimationFrame` callbacks. It includes
  browser scheduling/vsync effects and is not a GPU rendering duration.
- `CPU update`: camera update plus the starter animated-light update/submit.
- `CPU encode + submit`: host time spent inside the selected renderer's `draw()`.
- `GPU frame work`: timestamp from the first measured renderer/clustering pass
  beginning to the last measured renderer pass ending. It excludes the separate
  starter light-motion pass, presentation, and display scan-out.
- `GPU pass sum`: sum of measured pass durations. It may be smaller than the
  full GPU span because gaps between passes are not included.
- Each rolling metric uses completed samples from the most recent one second.
  Median is the central value; p95 is the nearest-rank 95th percentile.

After mode, strategy, light count, physical resolution, or camera-preset changes,
the measurement epoch resets. The next 30 frames are discarded; `ACTIVE` also
requires one second of valid samples and at least one GPU readback. Old asynchronous
readbacks cannot enter the new epoch. A full eight-slot GPU readback ring drops a
sample instead of waiting or growing indefinitely. If `timestamp-query` is not
available, the application still renders, but the Overlay says `UNAVAILABLE` and
GPU values remain absent. Never use CPU values as a substitute for GPU time.

Chrome may quantize timestamps. Record whether the browser's WebGPU developer
features flag was enabled; do not mix those results with normal-browser runs.

## Manual controlled comparison

1. Use one browser/GPU/driver, one physical canvas resolution, one scene build,
   and the `reset camera preset` control before each comparable condition.
   The Overlay shows the actual backing-buffer resolution. For resolution
   comparisons, set the target viewport, reload, and verify that value before
   recording; resizing rebuilds resources and invalidates the old epoch.
2. Use the same light count and cluster strategy for Forward+ versus base
   Clustered Deferred. First check both final images and browser validation
   messages; a visually incorrect mode does not pass the comparison gate.
3. Switch modes, wait for `ACTIVE`, and record GPU median/p95 in milliseconds,
   sample count, pass breakdown, resolution, mode, strategy, lights, and camera
   preset. Repeat trials and alternate condition order. Do not compare a
   warmup value with an active value.
4. For fixed versus adaptive, use `cluster snapshot` after timing. It pauses
   timed sampling while its readback runs, then starts a fresh epoch. Record
   overflow clusters and dropped light references alongside timing; a faster
   result with missing lights is not an equivalent-quality result.
5. For observer-effect checks, hold the same workload and compare the GUI's
   `off`, `timestamp only`, and `timestamp + overlay` modes using an external
   browser/GPU profiler. Repeat in reversed order. The app cannot use its own
   disabled timer to establish the `off` baseline.

The starter light animation is not frozen or reseeded. Consequently, one
snapshot or one short trial is not a controlled proof. Report repetitions and
the remaining animation/environment variability. The GUI's release light
budget may lower lights automatically; confirm the displayed count remained
fixed before accepting a trial. Use a development build when sweeping beyond
the release budget.

Suggested first matrix: Forward+ and base Deferred at 50/100/250/500 lights,
fixed strategy; then fixed/adaptive at one light count where both render
correctly. Only increase light counts after a pilot shows no device loss or
extreme frame time. The 8.33, 16.67, and 33.33 ms budgets are thresholds for
later analysis, not measured outcomes.

## Current evidence boundary

TypeScript/build checks verify host-side types and bundling. They do not compile
WGSL on the target GPU, prove timestamp-query availability, establish visual
equivalence, quantify instrumentation overhead, or produce the assignment's
charts and before/after measurements. Those require real-device runs. Because
automated collection/export was excluded, do not present manually transcribed
Overlay values as a raw-sample dataset.
