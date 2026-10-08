# Renderer fidelity work — October 7, 2026

This is the historical first fidelity pass, collected before the progressive path tracer was removed. Its images, sample counts and test totals describe that source revision. The current app uses optimized Live/Presentation raster rendering; see [the performance results](render-performance.md) and [the subsequent interior daylight study](interior-study.md). Running the current capture command does not reproduce the historical traced output.

The restart priority was more convincing local house and interior rendering. An Astra implementation agent performed four build/capture/inspection iterations. A separate Astra reviewer examined source and actual images; Sol built and checked the repeatable capture tooling and application lifecycle scenarios. No model or audio API calls were needed.

## Result

- Furniture uses rounded edges, separate cushions, feet, trim and surface details within its saved dimensions. Upholstery responds to the furniture palette. Existing furniture kinds, IDs, placement and persistence contracts are preserved.
- Deterministic local color, normal and roughness maps have physical-scale grain. Wall cladding remains continuous across opening subdivisions.
- Sky radiance orientation and glass shadow handling are corrected. Refined cameras inside enclosed rooms receive photographic exposure compensation; exterior and raster exposure remain stable.
- Live views and broker captures share restrained contact occlusion. Path-traced output uses edge-preserving denoising after real samples accumulate.
- The formerly near-black enclosed Refined interior is now readable. Cushion rim artifacts and excessive terrain relief found in early revisions were corrected after image inspection.

## Evidence and verification

Use [the capture command](render-fidelity-capture.md) to reproduce the synthetic cabin. Evidence is local and ignored under `.data/verification/render-fidelity/evidence/`:

- `baseline/` and `final/` use the same fixture, camera, daylight, viewport and SwiftShader renderer. Broker scene hashes and cameras match; both final Refined views reached eight actual samples. Final metadata records unchanged renderer sources during capture.
- `iteration-4-hardware/` reached 64 actual samples for both views on **Intel ARL**, at render scale 0.596. These images are additional quality evidence, not a same-sample/device comparison with the SwiftShader baseline or a claim about NVIDIA performance.
- `lifecycle-smoke/` checks Live/Clay/Wireframe, plan furniture selection, rapid Refined cancellation, resizing, forced WebGL loss/restoration and a successful broker capture afterward. No page exceptions or console errors were observed.

All **210 tests**, TypeScript, production build and whitespace checks passed. Six new renderer tests cover saved furniture bounds including asymmetric resizing, rounded UV continuity, material data, sky/exposure policy and contact-shading failure recovery/disposal. Tooling checks also exercised launch failure, interruption and occupied-port refusal. The capture harness rejects unexpected page navigation, owns and cleans up its server/browser, and distinguishes real samples from incomplete refinement or raster fallback.

The user's production workspace and legacy project files remained byte-identical. The app continues running locally on port 5174. App-model evaluation spending was **$0** against the authorized $5 cap.

## Quality and performance limits

This improves realism; it is not fully converged photographic output. Refined retains some upholstery/doorway speckle and softens fine material detail at the integrated GPU's resolution cap. Vegetation and architectural detailing remain conceptual.

The added quality costs GPU work. Matched SwiftShader broker captures took approximately 3.09 seconds exterior and 3.83 seconds interior, versus 1.77 and 1.74 seconds in the baseline. Another final run took 3.87/5.16 seconds, showing timing variation. Intel captures took about 1.1 seconds, compared with approximately 0.33 seconds in the earlier hardware check. These are individual capture measurements, not interactive frame-rate benchmarks or a speedup claim.

The Intel 64-sample exterior took about 51 seconds to its first cold sample and 84 seconds to the captured target. The subsequent interior took about 1.4 seconds to its first warm sample and 33 seconds to the target. Cold shader preparation remains slow.

After deliberate context loss/restoration, rendering, UI status and broker capture recovered; the canvas's old diagnostic error attribute remained until a later rendering-mode initialization. This did not affect the verified recovery, but diagnostic consumers should use current render outcome rather than that stale attribute alone.
