# Interior daylight and finish study

The October 7, 2026 baseline uses the existing furnished cabin without changes: cedar room, chalk sofa, charcoal armchair, cedar table and limestone rug. Evidence is in `.data/verification/interior-study/baseline/`. Its scene fingerprint is `2d46a4838c77acbf11c86bf68a986d46ecc146edc973449b0c0c6bfc2808ae65`; renderer source hashes were stable throughout. Chromium selected ANGLE Intel Mesa Graphics ARL, not the installed NVIDIA GPU. Diagnostics contain no browser warnings or exceptions.

```sh
npm run capture:render -- --port 5193 --gpu hardware --out .data/verification/interior-study/current --interior-study
```

Use a fresh output directory and one GPU evaluation at a time. The workflow retains the standard exterior/interior broker captures and adds these three fixed interior viewpoints under `day`, `golden` and `evening` lighting:

| View                  | Supported interior angle | Camera position     | Camera target       |
| --------------------- | ------------------------ | ------------------- | ------------------- |
| Wide room             | southeast                | [2.72, 1.6, 2.04]   | [-1.28, 1.6, -0.96] |
| Windows and materials | northwest                | [-2.72, 1.6, -2.04] | [1.28, 1.6, 0.96]   |
| Seating reverse angle | northeast                | [2.72, 1.6, -2.04]  | [-1.28, 1.6, 0.96]  |

Every view uses 68° FOV and the 768 × 576 broker canvas. The browser itself is 1440 × 1000 at DPR 1. Explicit `request.camera` is ignored by the current interior contract, so this workflow uses supported deterministic angle framing instead of changing that contract. Filenames are `study-<view>-<light>.png`. These are JPEG broker output decoded to PNG, not lossless framebuffer exports.

Two additional captures, `study-sealed-day.png` and `study-sealed-evening.png`, remove all living-room wall openings and connections and make all four wall sides solid. No artificial lights are added. `fixture-sealed.json` records that control, whose fingerprint is `f605b150724d9ece308573ef9c87e042fd5f7d8b55615bd5e03f103be0a784fd`. It exposes illumination leaking into enclosed geometry; it is a visual control rather than a numerical assertion of physically correct darkness.

Each image is delivered by the real local broker after committed scene effects and two bounded explicit render passes, including shadow/environment settling. The harness checks its returned scene fingerprint and records the request, actual framing, source hashes, GPU, dimensions and latency. It fails unexpected navigation and reports source changes. It never reads or resets production projects or calls cloud providers. See [capture isolation and lifecycle details](render-fidelity-capture.md).

Baseline inspection: the windows view clearly exposes south/east apertures, floor sun patches and wood direction; the reverse view shows seating, rug edges and contact shading. Daylight makes pale sofa/rug/floor surfaces fairly flat, while the cedar ceiling remains dark. Golden hour changes sun direction and warmth but leaves broad room brightness similar. Evening is darker, but the sealed day control remains almost as bright as the open room and sealed evening remains visibly illuminated. These observations guide the next iteration; this baseline does not demonstrate photorealism or measured light transport.

After renderer changes, run the same study with `--performance-smoke --lifecycle-smoke` in a fresh folder. Compare identical scene/camera/light/GPU metadata and inspect diagnostics. Keep the previous optimized-renderer guardrail honest: approximately 16.7 ms browser/draw-frame intervals during the matching Live orbit/walk, and zero application draws after idle settling, as measured in [the performance report](render-performance.md).

## Comparison workflow

The first source-stable lighting iteration should use only `--interior-study`, with a fresh `iteration-1/` output folder. Inspect the nine open-room images and both sealed controls before deciding on further tuning. After the renderer is final, collect the matching study and performance/lifecycle checks together in `final/`. Retain the original baseline metadata and numbers; new modules such as `src/roomDaylight.ts` are recorded in subsequent provenance rather than retroactively inserted into the baseline.

Review the wide, windows and seating viewpoints under each preset for aperture-related brightness, ceiling/wall balance, readable material finish, upholstery and rug contact, and window appearance. The sealed controls should expose residual ambient illumination. Record visual improvements and tradeoffs separately from the orbit/walk/idle performance guardrails and console/context-recovery checks.

## First daylight prototype

`iteration-1/` records the first room-aware lighting prototype before finish tuning. All thirteen broker captures match the baseline scene fingerprints, requests and camera framing on the same Intel ARL GPU; renderer sources stayed unchanged and diagnostics were clean. Both sealed controls become nearly black, showing the intended reduction of ambient leakage. However, the open room is too dark: daylight rug/tabletop and sofa cushion tops lose usable detail, and evening becomes largely silhouetted. Golden-hour sun patches remain readable, but shaded materials do not. This iteration is a diagnostic intermediate, not the accepted final result or a new performance measurement.

`iteration-2/` adds aperture-fed diffuse return and a furniture-height representative field. Source hashes stayed stable and scene/camera/GPU provenance matched again, with clean diagnostics. Daytime shaded cushions, rug and table are more readable, while sealed controls remain nearly black. The wood-colored return gives pale chalk/limestone surfaces a strong brown cast; the windows view remains relatively dim and evening stays dark without artificial lighting. Initial room-environment construction telemetry was 58.3 ms in this one browser observation, not a latency distribution. Finish tuning and final performance/lifecycle evidence remain separate.

`iteration-3/` evaluates per-material diffuse spherical-harmonic illumination with the room environment retained for specular response. All scene fingerprints, camera framing and requests again match the baseline; source hashes stayed stable and the first custom shader compiled without browser diagnostics. Pale shaded surfaces look slightly more neutral than iteration 2, with readable daylight seating and near-black sealed controls. Broad room lighting remains warmer/dimmer than the old ambient baseline, and evening remains dark. Initial room-environment construction telemetry was 57.1 ms in this single observation. This remains a lighting iteration before the final finish and performance checks.

The final lifecycle probe measures individual lighting, palette and furniture edit-to-ready observations: a browser timestamp immediately before the Playwright action to the observed ready frame plus cached-shadow refresh. It includes automation/polling overhead and does not measure GPU-completed work. Before/after renderer diagnostics retain room-environment build telemetry; these observations complement continuous-motion timing rather than substituting for it.

## Final source-matched evidence

`final-resumed/` contains the final thirteen-image study after roof/exposure bounds, finish clipping, shader compatibility and resource-lifecycle corrections. All scene fingerprints and actual camera framing match the baseline, on the same Intel ARL browser GPU. Sources remained unchanged throughout, including `architecturalFinish.ts`, `roomDaylight.ts`, `renderLighting.ts` and the other renderer modules listed in metadata. Browser diagnostics are empty. Earlier `final/` and `final-checks/` are retained as intermediate evidence; the latter recorded cross-context deletion warnings and is superseded for lifecycle acceptance.

The final room retains readable shaded cushions, rug and tabletop under daylight, with stronger aperture-related illumination and floor sun patches. Wall boards, ceiling seams, baseboards and window trim provide physical-scale finish detail. The windows view stays warmer and darker than the ambient baseline; evening remains dark without artificial lights. Both sealed controls remain nearly black. These are visual observations, not a calibrated lux, reflectance or photographic-accuracy measurement.

The lighting is a bounded raster approximation: a 128 × 64 angular visibility field at one furniture-height point per room, diffuse spherical harmonics, aperture-fed surface return and a lumped cavity term. Room-local filtered environment maps supply specular response. Furniture does not participate in this visibility field; directional shadows and settled-view screen-space AO provide contact cues. Directional maps are capped at eight rooms, aperture samples at 64 and architectural patches at 512; larger scenes use bounded fallbacks. The implementation does not solve full spatial or progressive global illumination. A shader without the expected irradiance hook falls back to the local environment response.

`final-resumed-checks/` has identical renderer source hashes and clean diagnostics. It passes Live/Clay/Wireframe and Presentation mode transitions, plan picking, resize, material and furniture edits, forced context loss/restoration, another lighting edit after restoration, and an edited-geometry broker capture with the expected fingerprint. The harness now rejects browser warnings/errors as well as page exceptions before marking lifecycle success. Both private production JSON files remained byte-identical and the owned verification server was cleaned up; no paid API was called.

The final Live orbit and both walkthroughs retain 16.7 ms browser/submitted-draw p95 intervals, and both settled modes submit zero draws. Presentation orbit remains slower at 152 draw-containing frames over three seconds and 33.5 ms p95, versus the optimized raster reference's 180 frames and 16.7 ms. Wall batching restores Live orbit draw submissions to 23,972, compared with 24,513 in that reference and 43,409 in the rejected intermediate check. Room-environment construction observations are 53.9–73.8 ms; individual edit-to-ready observations are 202.3 ms lighting, 194.3 ms palette, 95.2 ms furniture and 179.4 ms post-restoration lighting. These costs and the remaining Presentation regression are documented in [the performance report](render-performance.md), rather than presented as a speedup over the historical tracer.
