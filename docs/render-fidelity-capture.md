# Local render fidelity evidence

Run a deterministic synthetic cabin through the real browser renderer without model or audio providers:

```sh
npm run capture:render -- --out .data/verification/render-fidelity/evidence/current
```

Use a different output directory for each comparison. The recorded `baseline/` belongs to the historical renderer; reproducing it requires that historical source. Existing evidence directories named `baseline` are protected from overwrite unless `--overwrite` is explicit. The command requires an installed Chromium (`/usr/bin/chromium` by default; override with `--chromium /path/to/chromium`). `playwright-core` is a locked development dependency; no browser download is needed.

The command starts and stops its own `scripts/scenario-server.ts` on port 5186. Use `--port 5187` if occupied. It refuses production ports 5173/5174 and a listening verification server: it never resets another process. Startup verifies the scenario server PID before fixture reset. Normal completion, capture failure, Ctrl+C, and SIGTERM close the owned browser and stop/wait for the owned server; a stuck server is killed after three seconds. Storage is exclusively `.data/verification/render-fidelity-<port>`; separate ports have separate synthetic projects and can run concurrently. This intentionally replaces that synthetic verification project. The scenario entry point never loads `.env` or installs cloud adapters. Browser requests to origins other than its own loopback server are blocked. No project library, provider credentials, production process, desktop screenshot, or paid call is involved.

## Raster evidence

`interior-live.png` and `exterior-live.png` use the local render broker, the same Architecture/Environment/Site code as the editor, a fixed furnished cabin, day lighting, and southeast camera framing at 768 × 576. The interior is a closed living room with sofa, armchair, table, and rug. The broker currently emits JPEG; these images are decoded and saved as PNG without recovering JPEG detail. Compare these against captures made by this same command, rather than treating PNG as lossless original renderer output.

`fixture.json` records the exact synthetic scene. `metadata.json` records viewport, browser version, WebGL renderer, render request, camera, hash, capture dimensions, and elapsed time. Primary renderer source SHA-256 hashes and `rendererSourceChangedDuringCapture` identify accidental code changes during a comparison run. `diagnostics.log` records server and browser warnings/errors. Metadata and diagnostics are saved even when later capture work fails.

## Optional interactive Live and Presentation evidence

```sh
npm run capture:render -- --out .data/verification/render-fidelity/evidence/current-presentation --refined
```

This also captures `exterior-viewport-live.png`, `interior-viewport-live.png`, and corresponding `*-viewport-refined.png` files. These export the canvas framebuffer directly as PNG, without overlapping editor controls or desktop pixels. The viewport is 1440 × 1000 at DPR 1; editor layout determines the canvas bounds, recorded in metadata. Exterior uses the app's Reset camera framing. Interior uses Walk through's initial camera at `[0, 1.7, 2]`, looking at `[0, 1.7, -5]` with a 43° field of view. Lighting is explicitly Daylight. Compare paired viewport Live/Presentation images with each other: their cameras differ from broker images.

The `--refined` flag and `*-viewport-refined.png` filenames retain the old internal preset name for tooling compatibility; they now capture **Presentation**, an immediate raster mode. Metadata labels it `raster-presentation` with no sample target. No progressive path tracer, shader convergence wait, denoiser, or tracing worker runs in the current app. Legacy `--refined-samples`/wait options remain usable when this harness is run against a historical tracing checkout; old `path-traced`/incomplete/fallback metadata should be read as historical evidence.

The default headless browser deliberately uses ANGLE SwiftShader for repeatability across machines. It does not benchmark the user's GPU. No automatic provider or system GPU configuration changes are made.

## Performance and lifecycle smoke

Add `--interior-study` for three fixed furnished-room viewpoints under day/golden/evening lighting and sealed-room controls. See [study cameras, baseline observations and provenance](interior-study.md).

Add `--performance-smoke` to measure actual WebGL draw submissions and browser frame intervals during settled idle, orbit dragging, and held-key walkthrough. Add `--lifecycle-smoke` to check raster modes, plan furniture picking, mode switching, resize, lighting/material/furniture edits, context recovery, and a capture of edited geometry. See [measurement definitions and before/after evidence](render-performance.md). These options preserve the same synthetic-storage and no-cloud rules. Run only one GPU evaluation at a time for comparable results.

Unexpected main-frame navigation after the initial page load invalidates a run. Avoid writing HTML or editing served source while collecting evidence. Metadata records source hashes and whether renderer files changed during the run.

For a bounded mode-order comparison, add `--performance-order presentation-first` to a fresh `--performance-smoke` run. The default is `live-first`; both use identical reset cameras, orbit input and held-key walkthrough. Recorded `performanceSmoke.modeOrder` preserves the measurement order. Comparing orders can reveal reproducibility or warm-up sensitivity, but does not by itself identify CPU or GPU bottlenecks.

Browser warnings and errors are retained in both `diagnostics.log` and metadata's `browserDiagnostics`. Lifecycle success requires these and page exceptions to be empty, including after context restoration and a subsequent lighting edit. A passed assertion sequence accompanied by console warnings is not an accepted lifecycle run.

To request the browser's actual hardware GPU, use `--gpu hardware` and a separate output directory, optionally `--port 5187` if the default port is occupied. This removes the forced SwiftShader setting and enables GPU acceleration; it does not guarantee that Chromium can use the NVIDIA device. Inspect `metadata.json`'s `webgl.unmaskedRenderer` before claiming hardware rendering. Compare before/after with the same GPU setting and actual renderer; never compare hardware timing to the SwiftShader baseline as a code speedup.
