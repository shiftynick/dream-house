Current renderer update, October 8, 2026: progressive path tracing was superseded by demand-driven WebGL2 PBR and single-frame Presentation. The reviewed furniture refinement passes 221 tests and the production build, with source-matched images and clean graphics recovery. See [the furniture study](furniture-study.md), [current browser performance evidence](render-performance.md), and [the rendering decision](browser-rendering-approach.md). The dated results below remain truthful historical records; tracing sample/build timings no longer describe the current renderer.

# Editable furniture — September 29, 2026

**204 automated tests and the production build passed.** Furniture is now persistent scene data, shared by 3D meshes, furnished floor plans, selection, clearance inspection and agent commands. Tests cover legacy lazy materialization, stable IDs, room-local movement, rotated bounds, deterministic arrangement, impossible fits, duplicate/missing IDs, locks, request assertions, rendered-evidence invalidation, baseline inventory deltas and save/reload/undo/redo through the shared design service.

Browser checks used a private copy of the existing house. Manual movement and rotation, addition/removal, selection for voice context, persistence across reload, and undo/redo succeeded. A simulated chat used real geometry, HTTP, storage and a matching local plan capture; it committed as one undo entry with all architecture unchanged. The plan and cutaway were visually inspected. These injected scenarios made no cloud calls.

The first real Sonnet evaluation exposed excessive additions followed by repeated clearance polishing. It ended in a proposal without changing the saved scene, used all three capture opportunities, and inaccurately described its modified inventory as original. The workflow now requires the deterministic rearranger first for broad placement requests, keeps additions tied to requested functions, distinguishes advisory clearances from actual collisions/access obstructions, and includes furniture deltas against the saved baseline in every draft inspection.

Repeating the same request with the original conversation succeeded using `anthropic/claude-sonnet-5.5`: the sofa, coffee table and rug were rearranged; no pieces were added/replaced; bedroom/bath furniture and every architectural field were preserved. A fresh furnished plan matched the committed scene fingerprint. The result had no living-room clearance warnings and saved as exactly one undo entry. This took **three model calls, one local capture and $0.163190 reported design cost**. Both live attempts together used eight model calls and **$0.730664**. One automatic speech request was also counted; no additional speech charge was reported, so this is design cost rather than a complete provider bill. These are individual regression checks, not general quality or cost guarantees.

Furniture remains schematic. The arranger uses a bounded search and conservative rotated bounding boxes; it does not solve general furnishing relationships, arbitrary shapes, or complete pedestrian routes. Remaining aisle/wall notes may need judgment, especially for intentional bed/nightstand and table/chair groupings. Existing furniture stays generated until its first edit. The production workspace remained byte-identical through verification and restart at `http://localhost:5173`. Source/bundle credential scans and formatting passed; test usage was merged into the local counter once. Private test projects, captures and credentials are excluded from Git.

---

# Geometry, harness and rendering upgrade — September 28, 2026

**192 automated tests, TypeScript and the production build passed.** Browser scenarios used isolated storage and injected model/audio responses except for two explicitly evaluated Sonnet design requests. The production workspace remained byte-identical through verification and restart. Source and bundle credential scans passed. Existing non-blocking Vite bundle-size and upstream Zod annotation warnings remain.

## Verified behavior

- True single-pitch roofs have controlled pitch/high edge, room overrides, thin roof shells, sloped wall heads and clerestory openings. Legacy gables retain their effective geometry. Manual roof/opening edits, undo and redo were checked in the browser.
- Windows and doors coexist on one wall. Tests cover shared-wall ownership, raised stair doorways, resizing, opening collisions and preservation of legacy doorways when adding a window. The hillside example has 13 spaces, four linked stairs and one circulation component containing all 11 indoor rooms, with no blocking geometry errors.
- Simulated browser chat exercised creation with a matching local render, a visible failure with unchanged saved geometry, successful retry, cancellation, partial-request review, acceptance/undo, and an empty new project followed by reopening the prior project. The intentionally wrong roof response claimed 25° after applying 14°; local assertions disclosed the actual angle and required confirmation.
- Synthetic push-to-talk exercised recording, track release, transcription, agent response and the speech-response path. HTTP tests additionally cover provider cancellation and reported audio charges, including a provider that finishes after cancellation. Microphone permission, real recording quality and noisy-room recognition were not evaluated.
- Exterior, interior, cutaway and plan images were inspected for the cabin; exterior, cutaway and plan images were also inspected for the hillside and 24-room scenes. Captures work without animation-frame scheduling. The capture broker now delivers jobs through long polling with ownership, cancellation and stale-result checks.
- Path tracing accumulated samples on both Intel ARL and AMD Vega 20 browser renderers. The final Intel check prepared geometry in 464 ms, reached its first sample after about 34.7 seconds of cold shader setup, and reached four samples in 36.1 seconds. A light change reused the existing geometry build. Refined → Live → Refined retained the renderer/worker, prepared refreshed material references in 62 ms, reached the first sample in 410 ms and eight samples in 2.7 seconds. Forced WebGL context loss recovered to the live raster view. These are individual checks, not frame-rate guarantees.

## Real model checks and spending

Vercel AI Gateway / `anthropic/claude-sonnet-5.5` created a connected cedar cabin with an open living/kitchen connection, bedroom, bathroom, south deck, north-rising 12° roofs, south-facing glazing and a separate deck door. It requested and reviewed an exterior image, and its typed geometry assertions passed. This took four model calls, approximately 39.7 seconds and **$0.269348 reported design cost**. The layout includes an en-suite bathroom, which the reply identifies as an assumption; advisory furnishing warnings remain.

A second request widened only the living room's existing south window from 2.3 m to exactly 2.5 m. Comparing the saved scene against a copy with only that width changed matched exactly. The agent reviewed a matching image and finished in two calls, approximately 9.7 seconds and **$0.115868 reported design cost**.

Combined reported design cost was **$0.385216 for six calls**. Two automatic speech outputs also ran; their costs were not recorded by the earlier server instance used for these checks, so this is not a complete total. The updated server now records provider-reported audio costs. Eight paid request counts and the known charges were merged into local usage once. All scripted scenarios used zero-cost injected responses. Private credentials, projects, captures and diagnostic evidence remain excluded from Git.

## Measurements and limits

On this computer's Intel ARL browser renderer, old capture checks took approximately 1.5–2.18 seconds. New cabin captures took 419 ms exterior, 484 ms interior, 445 ms cutaway and 111 ms plan; hillside captures took 510/376/76 ms and the 24-room scene 420/397/115 ms for exterior/cutaway/plan. Geometry changed between these capture fixtures, so these measurements demonstrate the delivery-path improvement rather than a universal rendering speedup.

A separate controlled comparison used identical legacy fixture JSON, camera, lighting, 768 × 576 pixels and DPR 1, with five warmups and 40 completed `gl.render` + `gl.finish` draws. Both versions used the same Intel GPU. These are completed draw timings, **not interactive FPS**.

| Scene                  | Old median / p95 | New median / p95 | Draw calls, old → new | Triangles, old → new |
| ---------------------- | ---------------- | ---------------- | --------------------- | -------------------- |
| Cabin, 4 rooms         | 0.6 / 0.7 ms     | 0.5 / 0.7 ms     | 93 → 135              | 26,228 → 72,024      |
| Hillside, 12 rooms     | 1.5 / 1.9 ms     | 1.2 / 1.6 ms     | 295 → 336             | 30,188 → 75,816      |
| Larger scene, 24 rooms | 4.0 / 51.5 ms    | 3.7 / 43.1 ms    | 607 → 700             | 32,408 → 78,828      |

The extra geometry adds frames, roof details, furnishings and terrain shaping. Shared-system noise dominates the larger scene's tail latency; the small median differences do not establish a reliable viewport speedup. `npx tsx scripts/benchmark.ts` measured local inspection medians of 0.14/0.92/2.29 ms and material-edit medians of 0.13/0.61/1.29 ms for the cabin/new hillside/24-room fixtures.

The collaborative preview moved between Linux and Mac clients during this work. Hardware was identified for each measurement; cross-machine timings were not combined into a before/after claim. Remote HTTP test tabs used a test-only secure-random UUID shim, while the production app was verified at secure-context localhost. No production origins or system/browser configuration were changed.

The renderer remains an architectural concept viewer: general boolean roof joins, arbitrary wall shapes, construction details and engineering/code compliance are outside the model. Cold Intel shader setup is still slow; live rendering remains available during preparation. Agent images use fast local rendering, not converged path tracing. The reusable design/render services and schemas can support a future MCP adapter; no MCP server is exposed.

---

# Model-budget and background-capture follow-up — September 28, 2026

The reported cabin request exhausted the former six-call budget while refining and reviewing a valid draft. The harness now allows at most 12 model calls and 32 tool calls, supplies the remaining budget before every round, reserves time for final visual review, and stops repeated rounds that make no progress. Advisory furniture warnings no longer invite unnecessary layout changes in the system instructions.

- **126 automated tests passed**, including an eight-round repair/capture/correction/final-review regression, hard model/tool limits, repeated-inspection and scene-cycling termination, and capture cancellation/error handling.
- **TypeScript, production build, formatting, whitespace and credential scans passed.** Existing non-blocking Vite bundle-size and upstream Zod annotation warnings remain.
- Retried the exact failed cabin description through the browser's retry button on an isolated copy. Sonnet completed in **five calls**, with one local exterior capture, a geometry repair, review of the matching final scene, and a successful save. The saved scene matched the returned result and contained four spaces. Reported model cost was **$0.175854**.
- This is a completed agent flow, not exact fulfillment of every architectural detail: the generated cabin explicitly disclosed a flat-roof approximation because mono-pitch roofs are unsupported, and a wide south door instead of a full glazed south wall. Schematic furnishing warnings remained visible.
- An initial live retry exposed capture's dependency on browser animation frames. After replacing that dependency, the real render bridge completed exterior, interior, cutaway and plan captures with `requestAnimationFrame` disabled. All four returned 768 × 576 images in approximately 1–2 seconds; each image was visually inspected and showed the requested scene/view.
- Reviewed the simplified empty-state interface and project, alternatives and help dialogs. Removed decorative slogans and renamed the terrain control **Site slope**.

The two live verification attempts used seven model calls with total reported cost **$0.249202**. That includes the failed capture attempt; it is not a per-edit estimate. These charges were added to local usage accounting. The user's production workspace remained byte-identical throughout testing and restart. Private captures, test projects and credentials remain excluded from Git.

---

# Visual design and project-library verification — September 28, 2026

Verified with Vercel AI Gateway and `anthropic/claude-sonnet-5.5`, using a separate local data directory and the real browser render bridge. The original project remained byte-identical and has a separate backup. Private projects, captures and credentials are excluded from Git.

- **119 automated tests passed**, including migration, cross-project revisions, atomic-write recovery, rendering ownership/camera checks, cancellation, stale alternatives, preference saving, exact surface edits, and spatial advisories.
- **Production build and formatting passed.** Existing non-blocking Vite bundle-size and upstream Zod annotation warnings remain.
- Source and production bundles were scanned for the configured secret; none was found.

| Browser/live scenario           | Verified outcome                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New house                       | Empty scene, clean conversation, brief, history and alternatives; the original house remained available.                                                                                                                    |
| First design and visual review  | Sonnet created connected rooms, requested a plan image and examined it in a later model round before committing.                                                                                                            |
| Ambiguous “this wall”           | With no selection, the agent asked which wall and made no geometry changes.                                                                                                                                                 |
| Selected wall material          | Clicking the bathroom east wall and asking for cedar changed only that surface; geometry and all other surfaces stayed identical. Sonnet requested and inspected an interior image facing the wall.                         |
| Visual alternatives             | Two distinct terrace layouts generated without saving changes. Their local exterior thumbnails used identical cameras. The final run correctly rendered cedar decking.                                                      |
| Choice failure and retry        | A controlled HTTP 503 appeared visibly while exploring in 3D; the saved house stayed unchanged. Retrying accepted the real generated choice.                                                                                |
| Accept, undo and redo           | Acceptance saved both options and thumbnails, added the stated reason as a soft preference, and created one undo entry. Undo restored the original scene; redo restored the chosen design.                                  |
| Exact wall movement             | A selected north wall moved outward exactly 0.5 m; the opposite edge, other rooms, connections and finishes stayed unchanged. Sonnet inspected a fresh cutaway before committing; the visible viewport stayed in plan mode. |
| Project switching               | Reopening each house restored its own conversation, alternatives, brief and undo history. The complete test project matched its saved snapshot.                                                                             |
| Delayed import during switching | A controlled delayed file read was released after opening another house. The app cancelled the import and preserved the newly opened house.                                                                                 |
| Direct 3D picking               | Clicking the rendered bathroom wall selected its east surface and updated the voice-reference context.                                                                                                                      |

Browser verification exposed thin floor-plan wall hit targets, ignored terrace materials, and hidden choice errors. These were fixed and the affected flows were rerun. Independent review also corrected stale-choice recovery, capture camera validation, and asynchronous import isolation.

Reported design charges for this follow-up verification totaled **$1.11480** and were merged into the app's usage counter. This includes exploratory runs and retesting fixes; it is not a per-edit cost estimate. Voice transport was covered by regression tests and the earlier live verification below; real microphone/noise quality was not retested here.

The model can request exterior, interior, cutaway and plan images. These are fast local renders, not converged path-traced captures; an open Terrain browser supplies the renderer. Images reach the model only with visual review enabled. Clearance warnings use schematic furniture and explicit assumptions. The reusable services remain ready for a future MCP adapter, with no MCP server exposed.

The production server was restarted on `http://localhost:5173` with the existing project preserved.

---

# Initial harness verification — September 28, 2026

Verified locally using the configured Vercel AI Gateway and `anthropic/claude-sonnet-5.5`. Live editing used a separate data directory; the user's original project remained byte-identical. Credentials and private test projects are excluded from the repository.

## Automated checks

- `npm test`: 70 tests passed, including pure geometry, constraints, draft repair, rendering geometry, persistence, and HTTP integration.
- `npm run build`: TypeScript and production bundling passed. Vite retains its non-blocking large-bundle warning and upstream Zod comment warnings.
- Formatting, whitespace, and credential scans passed. The running production app loaded the existing project with revision zero and the new control API.

## Live checks

| Scenario                                            | Verified outcome                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing 12-room house, attach upper bedrooms       | Bedroom/bathroom wings moved together; indoor doors and stair links added; requested main-room dimensions and courtyards preserved. Saved, reloaded, undone, and redone successfully. |
| Selected-room material change through browser retry | A simulated failed request left geometry unchanged and saved an actionable error. Retrying with Sonnet changed only the selected bedroom's palette.                                   |
| `verify:design --case selected`                     | Selection resolved correctly; other room and geometry preserved.                                                                                                                      |
| `verify:design --case attach`                       | Both bedroom/bathroom wings attached with aligned indoor passages; separate studio unchanged.                                                                                         |
| `verify:design --case empty`                        | Created a connected two-room house with the requested dimensions from an empty site.                                                                                                  |
| `verify:design --case resize`                       | Kitchen west edge stayed fixed; connected suite and its fireplace moved with the enlarged east edge.                                                                                  |
| `verify:gateway`                                    | Gemini TTS generated speech; Grok STT transcribed the WebM/Opus conversion; Sonnet produced a valid preview-only house.                                                               |
| Proposal controls in browser                        | A controlled proposal used the real draft service. Saved geometry stayed unchanged before acceptance; accepting made one undo entry; undo restored the prior scene.                   |

All four semantic evaluation cases finished in two model calls with no repairs. Both live scripts confirmed that saved project data stayed unchanged. The initial larger-house run exposed an incorrect doorway warning for a partial neighbor; that defect was fixed and covered by a regression test.

This verification used 17 design-model rounds and two audio calls. Reported design charges totaled $0.52772, excluding audio. These are individual successful samples, not latency, cost, or general design-quality guarantees.

Real microphone permissions/noise quality, arbitrary architectural forms, and construction/code correctness were not evaluated. At this initial verification stage, viewport images were optional input and there was no tool-driven rendered-image review loop. The follow-up verification below covers that addition. MCP remains an architectural extension point, with no server exposed.
