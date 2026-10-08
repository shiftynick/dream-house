# Browser render performance — October 7, 2026

The browser renderer now uses demand-driven WebGL2 PBR rendering instead of continuous raster/progressive path tracing. See [the rendering decision and official sources](browser-rendering-approach.md). Historical path-tracer results in [verification](verification.md) remain historical measurements; they do not describe the replacement renderer.

## Repeatable command

```sh
npm run capture:render -- --port 5193 --gpu hardware --out .data/verification/render-performance/current --performance-smoke --lifecycle-smoke --refined
```

Use a fresh output directory for each comparison and run only one GPU evaluation at a time. The recorded `baseline/` was collected on the prechange source, not the current checkout; the harness refuses to overwrite existing directories named `baseline` without explicit `--overwrite`. Do not edit browser-served files during a run. Each phase settles for two seconds, then measures about three seconds on the fixed synthetic furnished cabin at 1440 × 1000/DPR 1. Orbit uses a held mouse button and deterministic pointer motion. Walkthrough obtains actual pointer lock, holds W for the measurement, then explicitly releases the key and pointer lock. Actual R3F camera positions/quaternions confirm movement; per-frame camera steps expose idle-delta teleports. The newer probe also records pointer-lock occupancy and camera-motion frame counts.

The probe counts WebGL draw submissions independently from browser animation callbacks. Metadata reports browser rAF intervals and intervals between rAFs containing new draw submissions, their p50/p95, elapsed time, frame counts, draw counts, camera changes, and renderer diagnostic attributes. A monitoring rAF callback does not invalidate the application's demand loop. These measure browser scheduling and submitted drawing on the actual GPU; they are not GPU-completed draw timings, guaranteed screen FPS, or general performance promises.

## Baseline

Actual renderer: **ANGLE Intel Mesa Graphics ARL, OpenGL ES 3.2**. The installed NVIDIA device was not the browser's selected GPU. Scene fingerprint: `2d46a4838c77acbf11c86bf68a986d46ecc146edc973449b0c0c6bfc2808ae65`. Source hashes were unchanged throughout the baseline. Evidence is local in `.data/verification/render-performance/baseline/`; prechange renderer files were separately copied to `/tmp/terrain-performance-baseline/`.

| Phase                        | Before rendered frames / GL draws | Before browser interval p50 / p95 | After rendered frames / GL draws | After browser interval p50 / p95 |
| ---------------------------- | --------------------------------: | --------------------------------: | -------------------------------: | -------------------------------: |
| Live idle                    |                      129 / 68,757 |                    16.7 / 50.1 ms |                            0 / 0 |                   16.7 / 16.7 ms |
| Live orbit                   |                       69 / 36,121 |                    49.9 / 66.7 ms |                     180 / 24,513 |                   16.7 / 16.7 ms |
| Live walk                    |                      105 / 27,077 |                    33.3 / 50.0 ms |                      181 / 7,965 |                   16.7 / 16.7 ms |
| Refined / Presentation idle  |                          91 / 182 |                    16.7 / 16.8 ms |                            0 / 0 |                   16.7 / 16.7 ms |
| Refined / Presentation orbit |                       90 / 63,234 |                    16.7 / 16.7 ms |                     180 / 25,591 |                   16.7 / 16.7 ms |
| Refined / Presentation walk  |                        52 / 8,196 |                    16.7 / 83.3 ms |                      181 / 7,916 |                   16.7 / 16.7 ms |

Each recorded phase lasted roughly three seconds. Baseline Live orbit moved the camera 12.30 m along its orbit; Live walk moved it 11.48 m including a trailing camera observation, with a maximum measured frame step of 0.175 m. Baseline Refined orbit ended at zero accumulated samples while moving: smooth browser callbacks did not mean a converged traced view. Refined walk moved only 0.29 m during the nominal held-key phase; its timings are not evidence of sustained-motion walkthrough FPS. The final comparison should emphasize identical Live orbit input and settled idle drawing.

Single baseline broker captures took 799 ms exterior and 736 ms interior. These include the local broker/browser delivery path, not only GPU rendering. A single capture per view does not establish median or tail latency.

## After-change observations

The matching after run used the same scene fingerprint, browser GPU, viewport, DPR and orbit stimulus; renderer source hashes remained unchanged throughout. Evidence is in `.data/verification/render-performance/after/`. The Live orbit browser interval p50/p95 improved from 49.9/66.7 ms to 16.7/16.7 ms, while draw-containing frames increased from 69 to 180 over roughly three seconds. Different cadence samples the same time-based orbit input more often, so the final camera position need not be bit-identical.

Both settled Live and Presentation phases submitted **zero application draws**. Shadow and AO counters also stayed unchanged during idle. During orbit/walk, AO telemetry was `moving` and neither cached-shadow nor AO counters increased; settled views showed AO `on`. Live and Presentation walks each moved for 181 sampled frames with pointer lock present in all 181 frames, traveling about 11.74/11.77 m including the trailing camera observation. Maximum observed steps were 0.195/0.224 m, far below an idle-delta teleport; the initial sample includes browser automation latency before measurement begins.

Single after broker captures took **274 ms exterior and 229 ms interior**, versus 799/736 ms before. These are individual observations, not a latency distribution.

The lifecycle assertions passed mode switching, floor-plan sofa picking, resizing, lighting/material/furniture edits, shadow refresh, forced context loss/restoration, and a capture whose fingerprint matched the edited saved geometry. The first after run logged React root-unmount and WebGL cross-context disposal warnings. Subsequent cleanup deferred the offscreen root teardown, disposed AO resources on context loss, and replaced the selected-room nested React root with a directly owned projected label.

The final lifecycle-only recheck is in `.data/verification/render-performance/lifecycle-clean/`. It passed those assertions plus a visible selected-room label after Plan → Explore, with no page exceptions or browser console warnings/errors and unchanged renderer source hashes throughout. Its source hashes describe the final cleanup source; the performance table above retains the original `after/` measurement provenance. Cleanup-only changes were not presented as a new performance measurement.

## Interior daylight and finish pass

The October 7 interior pass is compared with the optimized raster `after/` above. Fresh evidence is in `.data/verification/interior-study/final-resumed-checks/`, with the same scene, GPU, viewport, DPR and stimulus. Its source hashes exactly match the thirteen-image `final-resumed/` study and stayed unchanged during both runs. The old `final-checks/` is an intermediate run with lifecycle deletion warnings, not the accepted lifecycle result.

| Phase              | Optimized raster frames / GL draws | Final interior frames / GL draws | Optimized browser p50 / p95 | Final browser p50 / p95 |
| ------------------ | ---------------------------------: | -------------------------------: | --------------------------: | ----------------------: |
| Live idle          |                              0 / 0 |                            0 / 0 |              16.7 / 16.7 ms |          16.7 / 16.7 ms |
| Live orbit         |                       180 / 24,513 |                     180 / 23,972 |              16.7 / 16.7 ms |          16.7 / 16.7 ms |
| Live walk          |                        181 / 7,965 |                     181 / 11,182 |              16.7 / 16.7 ms |          16.7 / 16.7 ms |
| Presentation idle  |                              0 / 0 |                            0 / 0 |              16.7 / 16.7 ms |          16.7 / 16.8 ms |
| Presentation orbit |                       180 / 25,591 |                     152 / 20,889 |              16.7 / 16.7 ms |          16.7 / 33.5 ms |
| Presentation walk  |                        181 / 7,916 |                     181 / 11,174 |              16.7 / 16.7 ms |          16.7 / 16.7 ms |

Submitted-draw interval p50/p95 matches the browser intervals during the final motion phases. Idle has no submitted-draw intervals because it submits no draws. Shadow and AO counters remain unchanged throughout both idle and motion measurements; AO reports `moving` during motion and `on` after settling. Both walks have 181 motion frames and pointer-lock frames, travel about 11.74/11.75 m including the trailing observation and have maximum observed steps of 0.194/0.204 m.

Live orbit and walkthrough cadence meet the previous guardrail. Added finish/lighting work increases interior walkthrough draws, and Presentation orbit still misses frames with 33.5 ms p95. Its lower total draw count partly reflects fewer rendered frames and is not evidence of better performance. Batching wall cells and frames reduced the intermediate Live orbit's 43,409 draws to 23,972 without changing the fixed-study scene/cameras. These results do not claim every renderer mode improved.

Room-environment build telemetry ranges from 53.9 to 73.8 ms across this single run. Lighting, palette, furniture and post-restoration lighting edits took observed 202.3, 194.3, 95.2 and 179.4 ms to the ready frame plus shadow refresh. Each is one observation including automation/polling overhead, not a distribution or GPU-completed latency. The final study's exterior/interior broker captures took 298/262 ms; the checks run took 525/287 ms, illustrating variation in this end-to-end path.

Final lifecycle checks pass with zero browser warnings/errors and page exceptions, including relighting after forced WebGL restoration and a broker capture matching the edited scene fingerprint. The harness now records console diagnostics structurally and rejects them before declaring lifecycle success. Verification port 5193 was cleaned up. The production workspace and legacy project stayed byte-identical, and no paid service was used. The daylight/material approximations and image observations are described in [the interior study](interior-study.md).
