# Furniture realism study

The October 8, 2026 study uses the fixed furnished cabin and cameras from [the interior study](interior-study.md): cedar room, chalk sofa, charcoal armchair, cedar table and limestone rug. Geometry refinements are evaluated against saved dimensions, identities, picking and interactive responsiveness. No model or audio provider is involved.

```sh
npm run capture:render -- --port 5193 --gpu hardware --out .data/verification/furniture-study/current --interior-study --performance-smoke --lifecycle-smoke
```

Use a fresh output directory, keep browser-served source unchanged during capture, and run one GPU evaluation at a time. The baseline remains immutable. The thirteen images comprise two standard broker views, three fixed interior angles under day/golden/evening light, and sealed day/evening controls. These are JPEG broker captures decoded to PNG at 768 × 576. Interactive performance uses the 1440 × 1000 browser viewport at DPR 1; the editor determines canvas bounds.

The new baseline is in `.data/verification/furniture-study/baseline/`. Scene fingerprint `2d46a4838c77acbf11c86bf68a986d46ecc146edc973449b0c0c6bfc2808ae65`, sealed fingerprint `f605b150724d9ece308573ef9c87e042fd5f7d8b55615bd5e03f103be0a784fd`, camera framing and lighting requests match the previous interior study. Chromium selected **ANGLE Intel Mesa Graphics ARL, OpenGL ES 3.2**. Renderer source hashes stayed unchanged and browser diagnostics were empty.

| Phase | Baseline draw-containing frames / GL draws | Browser / submitted-draw p95 |
| --- | ---: | ---: |
| Live idle | 0 / 0 | 16.7 ms / no draws |
| Live orbit | 180 / 23,971 | 16.8 / 16.8 ms |
| Live walk | 181 / 11,141 | 16.7 / 16.7 ms |
| Presentation idle | 0 / 0 | 16.8 ms / no draws |
| Presentation orbit | 180 / 24,515 | 16.7 / 16.7 ms |
| Presentation walk | 179 / 10,950 | 16.7 / 16.7 ms |

Each phase observes roughly three seconds after settling. Both walks retain pointer lock throughout the sampled motion frames, travel about 11.77/11.76 m including the trailing camera observation and have maximum frame steps of 0.222/0.209 m. Shadow and AO counters remain unchanged during idle and motion; AO reports `moving` during motion and `on` in settled views. The room environment build observation is 58.0 ms; exterior/interior broker captures took 316/265 ms. These are individual end-to-end observations, not distributions or GPU-completed timings.

The previous interior study's Presentation orbit p95 of 33.5 ms did **not reproduce in this fresh baseline**. This observation does not isolate its cause or prove that it was fixed by a source change. The harness supports `--performance-order presentation-first` to repeat the matched stimulus with reversed mode order; it records the order in metadata. Quality settings remain unchanged. See [the measurement definitions and historical results](render-performance.md).

The first furniture iteration adds crowned upholstery, tapered supports, tabletop edge detail and thinner rug geometry. Independent review found dotted/serrated thin seams on chalk cushions and the rug perimeter. The second iteration replaces the round welts with slim flat binding, matches its normals to the supporting surface and removes a false arm-side strip. The corrected source makes rug binding orientation an explicit part property so unusual saved dimensions cannot select the wrong geometry. This stays in `src/renderFurniture.tsx`; saved furniture contracts and the picking component are unchanged.

Independent review accepted all thirteen `iteration-2/` images. The final corrected source was captured again in `final-source-matched/`; all thirteen images are **byte-identical** to those accepted images. Scene fingerprints, requests and camera framing match the baseline, GPU remains Intel ARL, renderer hashes stayed unchanged and browser diagnostics are empty. The interrupted `final-checks/` run saw source writes during capture and is invalid intermediate evidence; it is excluded from acceptance and the measurements below.

The final source keeps fourteen furniture kinds within their saved dimension envelopes across five scale combinations, with finite unit normals, continuous UVs, deterministic geometry and bounded triangle counts. A separate raycast guard tests actual batched geometry for every catalog kind at 0°, 37°, 90° and 180° yaw with changed dimensions and position: hits recover the saved piece ID and remain inside its saved bounds. Existing shared-service tests cover disk reload, undo/redo and changed furniture dimensions; the browser lifecycle confirms floor-plan picking and persistence of a sofa position edit.

| Phase | Final Live-first frames / GL draws | Final Live-first submitted p95 | Presentation-first frames / GL draws | Presentation-first submitted p95 |
| --- | ---: | ---: | ---: | ---: |
| Live idle | 0 / 0 | no draws | 0 / 0 | no draws |
| Live orbit | 137 / 18,186 | 49.9 ms | 119 / 16,335 | 50.0 ms |
| Live walk | 167 / 10,141 | 33.3 ms | 146 / 8,505 | 33.4 ms |
| Presentation idle | 0 / 0 | no draws | 0 / 0 | no draws |
| Presentation orbit | 143 / 19,355 | 33.4 ms | 173 / 23,088 | 16.8 ms |
| Presentation walk | 176 / 10,568 | 16.8 ms | 149 / 8,270 | 33.4 ms |

Both runs have identical renderer source hashes, source stability and clean diagnostics. Browser p95 matches submitted-draw p95 in the motion phases. The fresh final Live cadence misses the new baseline guardrail in both orders; these measurements are not accepted evidence of preserved responsiveness. Presentation orbit changes with the run/order, so its previous regression remains incompletely isolated. Lower total draws in a slow phase reflect fewer frames and do not establish a speedup. Settled triangle telemetry falls from 168,747 to 164,899 while settled Live draw calls remain 267. DPR remains 1, AO is suspended during motion and shadow/AO counters remain unchanged; these facts alone do not locate the bottleneck.

The source-matched lifecycle passes Live/Clay/Wireframe/Presentation transitions, resize, selected-room label, lighting/palette/furniture edits, forced context loss/restoration, a subsequent relight and an edited-scene broker capture. Browser warnings/errors and page exceptions are empty. Lighting, palette, furniture and post-restoration lighting edit-to-ready observations are 152.2, 271.4, 96.7 and 188.4 ms; environment construction observations span 0.8–91.0 ms. Each includes browser automation/polling overhead and is a single observation. The final exterior/interior broker captures took 356/373 ms.

A bounded diagnostic pair then ran archived reference `a37329e` from a private `/tmp` checkout, followed by current source, using only the two default broker captures and normal-order performance smoke. No production data or credentials were copied, and no unrelated process was stopped. Both runs have the same scene, Intel ARL GPU, 877 × 835 canvas, DPR and renderer source hashes apart from `renderFurniture.tsx`. Reference sources remained unchanged. Its symlinked dependencies caused three font-resource 403 errors from Vite's archive-root allowlist; it is diagnostic evidence with a layout-font limitation, not a clean acceptance run.

| Diagnostic phase | Reference frames / GL draws / submitted p95 | Current frames / GL draws / submitted p95 |
| --- | ---: | ---: |
| Live orbit | 180 / 23,974 / 16.8 ms | 147 / 19,565 / 33.4 ms |
| Live walk | 180 / 11,003 / 16.8 ms | 134 / 7,924 / 33.4 ms |
| Presentation orbit | 180 / 24,513 / 16.8 ms | 169 / 22,918 / 16.8 ms |
| Presentation walk | 181 / 11,143 / 16.7 ms | 142 / 8,406 / 33.4 ms |

Both diagnostic idles submit zero draws. Half-second timestamped `/proc/stat` and `/proc/loadavg` samples are retained in each diagnostic folder's `host-cpu.jsonl`. Reference whole-run host CPU utilization has median 17.3%, p95 36.1% and maximum 51.1%; the current run has median 54.9%, p95 95.4% and maximum 97.4%, with up to all 24 cores at least 90% busy in a sample. Its one-minute load average rises from 20.68 to 29.01. These are host scheduling samples across the entire run, not per-phase GPU costs. Host load is unmatched and the current run saturates the CPU, so the pair does **not isolate a furniture-caused regression**. No source tuning or speculative quality reductions were made.

After a separate ten-sample host check observed lower CPU utilization, one additional current-source run was authorized in that changed external condition. `quiet-check/` uses the same final renderer hashes, fixture, GPU, 877 × 835 canvas, DPR and normal phase order; source stayed unchanged and diagnostics are empty. Both idles submit zero draws. The **Live fixture cadence recovers** to the fresh baseline, with orbit 180 frames / 23,971 draws / 16.8 ms submitted p95 and walk 182 / 11,284 / 16.7 ms. Presentation orbit also reaches 180 / 24,515 / 16.7 ms, while Presentation walk remains slower at 142 / 8,393 / 33.4 ms. This is evidence of preserved Live responsiveness in this fixture under quieter conditions, not a promise that every phase or mode meets that cadence.

The quieter run's whole-run host CPU utilization is median 21.4%, p95 61.4% and maximum 72.8%. Timestamped samples and approximate phase completion observations are retained. Presentation orbit's approximate three-second overlap has host CPU median 26.2% / maximum 33.2%, and the slower Presentation walk overlaps 55.1% / 66.2%. The completion watcher attached after the three Live phases, so those records explicitly identify late observation and cannot establish individual Live phase/load intervals. Host load rises later in the run; these observations do not isolate a CPU or GPU bottleneck. The accepted visual and warning-free lifecycle evidence remains `final-source-matched/` with identical hashes.

The room lighting remains the bounded daylight approximation described in [the interior study](interior-study.md). Furniture refinements improve silhouettes, seams and contact-scale geometry in this fixture; they do not establish photographic or physically calibrated realism. No paid API calls are made, and production project files are checked against private pre-run hashes.
