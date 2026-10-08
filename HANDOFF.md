# Terrain session handoff

Current checkpoint, October 8, 2026: the owner's goal to address all five product gaps is implemented and verified. The changes cover:

- Refining pending proposals and visual alternatives before adoption, retaining parent versions and applying the cumulative design as one undo step.
- Per-request focused-change preservation against immutable starting baselines, including requirements and concerns carried through refinement.
- Atomic shared-wall space transfers, room splitting and merging with stable identities, world furniture poses, apertures and routes.
- Floor-plan furniture drag/rotation and independent opening selection/editing from either wall face.
- Elevation-specific plan SVGs, room-area/material CSVs and printable report sheets.

Read [focused editing](docs/focused-editing.md), [room transformations](docs/room-transformations.md), [precise editing](docs/precise-editing.md), and [reports](docs/design-reports.md) for contracts and limits. Room transformations initially support complete rectangular flat-roof cases without affected stairs. Incompatible transferred finishes, cuts through features, unsafe legacy-wall transitions and broken routes reject atomically rather than flattening or deleting existing details.

Current validation: **325 tests**, TypeScript and production build pass. Sol independently reviewed refinement, preservation, reports and image lifecycle; Astra independently reviewed spatial commands, gesture/opening editing and final aperture guards. Actual browser workflows cover refinement/adoption/discard, cancellation/history, focused-change review, furniture gestures and opening edits. Report QA inspected all six rendered A4 landscape pages and actual SVG/CSV downloads.

Two synthetic real-model cases pass exact geometry/preservation assertions and structured visual review: selected floor material and a one-metre shared-wall transfer. Evaluation used `anthropic/claude-sonnet-5.5`, **nine settled calls and $0.594464 reported cost** against the authorized $5 budget. The initial shared-wall attempt passed geometry but exposed premature image retirement before final review; current-scene pixels now remain through review/finish, stale images retire, and edits require fresh delivery even after restoring a previous scene hash. The bounded rerun passes. These two cases are a small sample, not a reliability or defect-detection benchmark. See [verification tooling](docs/capability-verification.md); resume costs from the cumulative ledger, never start a fresh ledger to erase prior spending. Latest private cumulative ledger is `.data/verification/capabilities-NFKAX6/ledger.json`; evidence and earlier failure remain ignored. Evaluation usage is separate from application daily usage; do not claim it is merged.

The earlier October rendering checkpoint remains shipped: world-anchored architectural textures, steep-roof UV corrections, detailed furniture, bounded room-aware daylight and demand-driven WebGL2 PBR. Live, Clay, Wireframe and single-frame Presentation remain available; progressive tracing was retired. This capability pass makes no new frame-rate claim. Personal workspace and legacy project hashes remained unchanged throughout verification; isolated fixtures never replaced the saved house.

See [the renderer decision](docs/browser-rendering-approach.md), [furniture study](docs/furniture-study.md), [interior study](docs/interior-study.md), [performance evidence](docs/render-performance.md), and [capture commands](docs/render-fidelity-capture.md). The development app uses **http://localhost:5174**. Isolated checks must never reset or replace its storage. Agent Dashboard: https://agent-dashboard.shiftynick.workers.dev; follow its API help and use the ignored AGENT_DASHBOARD_KEY without printing credentials. User preferences: Sol 6.1 medium for general agents and Astra high for 3D agents and reviews; commit and push completed work as needed.

The five-gap goal requires no further feature implementation. Future priorities should come from the owner's use of these workflows; broader real-model evaluation or more general room transformations remain possible follow-ups, not automatically authorized work. Keep intentional finishes, confirmed brief, saved IDs, undo and separate houses intact. Existing approximate daylight and variable Presentation timing remain limits; avoid another aesthetic hill climb unless requested. Unadopted drafts/options remain ephemeral and expire on server restart.

The September checkpoint below records historical project and provider verification, not current runtime availability.

Updated September 29, 2026. The user asked to stop development, leave the repository committed/pushed/clean, and record enough context for the next session. No feature implementation is in progress. The earlier upgrade goal is complete; this handoff does not start another goal or authorize the suggested follow-ups below.

## Starting point

- Public repository: [shiftynick/dream-house](https://github.com/shiftynick/dream-house), branch `main`.
- Latest feature commit: `1149be8` — persistent editable furniture and deterministic placement tools. The subsequent handoff commit changes documentation only.
- Previous major feature commit: `5ed15b3` — geometry, harness, rendering and performance upgrade.
- Working directory on the development machine: `/home/shifty/Work/dream-house`.
- At handoff, the production app is running at **http://localhost:5173**, its status endpoint returns HTTP 200, and the configured design model is `anthropic/claude-sonnet-5.5`. Temporary verification servers on 5186/5187 were stopped. Process availability must be rechecked in a future session.
- The user's real house library was preserved throughout the furniture work. Live evaluations edited private copies, not the production house. Do not restore a test fixture into the user's project.

Read [README.md](README.md) for usage, [docs/architecture.md](docs/architecture.md) for contracts, and [docs/verification.md](docs/verification.md) for measured results and caveats. [docs/upgrade-plan.md](docs/upgrade-plan.md) is a completed historical checklist, not an outstanding task list. `PROJECT_BRIEF.md`, when present locally, is ignored personal discovery material; keep it private.

## Product intent and established preferences

Terrain is a personal, voice-first house-design application. The user describes ideas without needing architectural vocabulary; the agent changes a coherent 3D house whose plan, interior and exterior stay consistent. Priorities are capable editing, reliable outcomes and attractive local rendering. Correctness was prioritized before wall-time optimization.

- App, house files and rendering stay local. Cloud model/voice APIs are acceptable; keep costs modest.
- Start a new house on an empty site. The hillside example is optional, never loaded automatically.
- Hold Space/the microphone control to speak; the app transcribes after release and can speak its reply. This is push-to-talk, not streaming duplex conversation.
- Make reasonable related edits automatically, support easy undo, and ask about major decisions or material ambiguities.
- Preserve named alternatives, history and separate houses. Help discover taste through visual choices.
- For furniture: **rearrange existing pieces first; add or replace when useful**.
- Use functional UI labels. Decorative slogans were explicitly removed.
- Prefer simulated model responses for application/geometry/browser scenarios; pay for real model calls when evaluating model behavior itself.
- Keep services reusable for a future MCP adapter. **Do not expose MCP now.**

## Running and checking the app

Node.js 22.12+ is required; development used Node 24. Dependencies are in `package-lock.json`.

```sh
npm install
npm run dev
```

Production:

```sh
npm run build
npm start
```

The server binds to `127.0.0.1`; `PORT` overrides 5173. `npm start` serves the existing `dist/`, so rebuild before expecting frontend changes. Backend changes require restarting either entry point. Check the listener before starting another server; stop only the identified Terrain process when restarting.

```sh
npm test
npm run build
git diff --check
```

The final implementation passed **204 tests**, TypeScript and the production build. Non-blocking Vite bundle-size and upstream Zod annotation warnings remain. The documentation-only handoff does not require repeating live model evaluations.

## Credentials, storage and cost

Vercel AI Gateway is the current provider. Defaults are in `shared/connections.ts`: design `anthropic/claude-sonnet-5.5`, speech `google/gemini-3.8-flash-lite-tts`, voice `Kore`, transcription `spacexai/grok-stt`. These are the configured/verified IDs at this checkpoint, not a promise of future provider availability. Saved settings and environment overrides may differ; inspect `/api/status` and the settings UI before diagnosing a provider issue.

Credentials persist in ignored `.env` or `.data/connections.json`; a saved Gateway key takes precedence over the environment key. Model environment overrides take precedence over UI model settings. Never print credentials, put them in client code, or commit them. The user previously supplied a temporary key and intended to rotate it; do not assume it will remain valid. There are no keys in the public repo.

Important local files:

| Path                     | Purpose                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `.data/workspace.json`   | Authoritative multi-house library, active house, scenes, messages, history and alternatives |
| `.data/project.json`     | Legacy source/backup; used only when no workspace exists                                    |
| `.data/connections.json` | Local provider settings and plaintext credentials, owner-only permissions                   |
| `.data/usage.json`       | Persisted daily request count and reported charges                                          |
| `.data/runs/`            | Local diagnostic summaries without credentials, image pixels or private model reasoning     |
| `.data/verification/`    | Ignored isolated test projects, backups and evidence                                        |

`TERRAIN_DATA_DIR` selects isolated storage. Back up and preserve the real workspace before migration or live verification. Project saves use identity, revision checks, a serialized save queue and atomic rename. Do not bypass these through raw whole-project writes in a new agent/control adapter. Use the draft service. Uncommitted proposals and generated choice sets expire in memory and disappear on restart.

The default daily cap is 60 cloud requests, shared by model rounds, transcription and speech; it is not a dollar cap. The latest furniture evaluation used eight model calls plus one automatic speech request across two attempts, with $0.730664 reported design cost. This usage was already merged into production accounting once. `.data/verification/furniture-live/usage-merged.json` records that merge; do not count it again. Provider-unreported audio charges are excluded from that cost figure.

## Architecture and invariants

The stack is React + TypeScript + Vite, React Three Fiber/Three.js, a local Express server and Zod contracts. The current browser renderer is WebGL2 raster PBR; it no longer imports a path tracer. There is no database, cloud project storage, hosted rendering service or MCP server.

Request flow:

1. Text or recorded speech becomes a user message. The browser flushes pending saves and includes project ID/revision, scene, selection, view/camera and optional render-client permission.
2. `server/agent.ts` runs the model against an unsaved `DesignDraft`. The model selects typed operations; local code computes geometry and validates it.
3. With visual review enabled, the model requests a local render and receives the exact draft image in a later model round. Another edit invalidates the earlier visual evidence.
4. `finish_design` supplies an outcome/checklist. Local assertions check supported claims; unmet requirements or consequential assumptions trigger proposal review.
5. `DesignService` applies commit/confirmation/revision checks. An accepted design saves atomically as one undo step. Failures/cancellation preserve saved geometry.

Main source map:

| Area                               | Files                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Documents and history              | `shared/model.ts`, `server/storage.ts`, `src/useProject.ts`, `src/projectPersistence.ts`                                                                                                               |
| Geometry and semantic commands     | `shared/design.ts`, `shared/geometry.ts`, `shared/architecture.ts`, `shared/openings.ts`, `shared/spatial.ts`                                                                                          |
| Drafts, assertions and selection   | `shared/draft.ts`, `shared/assessment.ts`, `shared/selection.ts`, `shared/harness.ts`, `server/design-service.ts`                                                                                      |
| Model loop and provider adapters   | `server/agent.ts`, `server/agent-context.ts`, `server/gateway.ts`, `server/connections.ts`                                                                                                             |
| Render requests and alternatives   | `shared/render.ts`, `server/render-service.ts`, `server/alternative-service.ts`, `src/useRenderBridge.ts`, `src/RenderCapture.tsx`                                                                     |
| Interactive render and performance | `src/SceneView.tsx`, `src/renderGeometry.ts`, `src/renderMeshes.ts`, `src/renderPerformance.ts`, `src/rasterRenderer.ts`, `src/renderMaterials.ts`, `src/renderLighting.ts`, `src/renderFurniture.tsx` |
| Furniture                          | `shared/furniture.ts`, `shared/furniture-layout.ts`, `src/FurnitureControls.tsx`, `tests/furniture.test.ts`                                                                                            |
| UI and voice                       | `src/App.tsx`, `src/ArchitectureControls.tsx`, `src/ProjectChooser.tsx`, `src/VisualAlternatives.tsx`, `src/useVoice.ts`, `src/voiceSession.ts`                                                        |
| HTTP and hosting                   | `server/app.ts`, `server/index.ts`                                                                                                                                                                     |

Preserve these contracts:

- Axes are x east, z south, elevation up; dimensions are meters. Room positions are centers.
- Roofs support flat, gable (`pitched`) and single pitch. Single-pitch direction names the **high edge**; room height is the minimum eave. Preserve legacy gable behavior and room overrides.
- Wall openings have stable IDs, local offsets, width/height/sill. Semantic shared passages must agree on both wall faces. A window is not a walking route.
- Furniture coordinates are **room-local**, with yaw 0° facing south and +90° east. Move furniture with its room once; do not apply the room displacement to both coordinates.
- Missing `room.furniture` means the legacy generated layout; `[]` means deliberately unfurnished. Reading a legacy house must not materialize or rearrange it. First furniture edit materializes its pieces with stable IDs.
- Explicit solid furniture must fit the room. Rugs are decorative. Collision/access assertions and conservative advisory aisle checks are distinct; assertions do not establish general pedestrian or building-code compliance.
- Confirmed requirements and lock snapshots cannot be silently weakened/rebased. Existing routes must survive unrelated edits.
- Capture hashes must match the final draft. Browser captures share scene geometry, do not capture the desktop, and must work when animation frames are throttled. An attached/open app tab is required; no headless renderer exists.
- The pure command contract and application services are transport-independent. A future MCP adapter should reuse them and preserve identity/revision, review, cancellation and image-permission rules.

The harness permits 12 model calls, 32 tool calls, three captures and two repair rejections. Three idle rounds stop a run. Budget notices, refreshed working-state context and history/image compaction help the model finish. Avoid increasing limits as the first response to loops; reproduce the underlying behavior.

## Latest change and its regression lesson

The agent previously could not move schematic furniture, and the floor plan omitted it. Furniture now has saved IDs, kind/name, position, rotation, dimensions and optional palette. `add_furniture`, `update_furniture`, `remove_furniture` and `arrange_furniture` are available through the existing operation schema. Manual controls, 3D picking and plan selection share those identities. Save/reload, undo/redo, scene fingerprints and requirements all include furniture.

The deterministic arranger preserves inventory/dimensions/architecture, searches bounded positions/cardinal rotations, checks access/obstacles and balances a sofa/table group. Rugs follow the sofa. It retains impossible layouts with reported issues rather than deleting pieces to manufacture success.

The first live test added too many pieces, chased conservative clearance warnings and exhausted three captures. It produced an uncommitted proposal and inaccurately called its modified layout original. Fixes now require the arranger first for broad placement requests, tie additions to requested functions, distinguish advisory notes from actual obstruction, and include furniture inventory deltas against the saved baseline in every draft inspection. Preserve this workflow when tuning prompts.

The repeat succeeded: three model calls, one matching plan capture, $0.163190 reported design cost, no new inventory, one undo step, and all architecture plus unrelated furniture preserved. The original conversation included obsolete claims about unsupported roofs/furniture, so this also checked recovery from stale chat context. Full results are in [docs/verification.md](docs/verification.md).

## Verification approach for the next session

Use tests and the no-cloud browser server for application plumbing:

```sh
SCENARIO_RUN=next-check SCENARIO_PORT=5186 npx tsx scripts/scenario-server.ts
```

This entry point never loads `.env` and has no real model/audio adapter. `/__verification/turns` queues tool responses, `/__verification/reset` installs a fixture, and `/__verification/render` requests a real local capture. Geometry, HTTP, storage and browser rendering remain real. These endpoints are absent from production. Synthetic speech is silence and does not validate microphone or voice quality.

Use a separate `TERRAIN_DATA_DIR` and port for paid browser evaluations; compare the production workspace before/after. The opt-in `verify:gateway` and `verify:design -- --live --case ...` scripts spend credits and use preview-only synthetic cases. Choose a narrow evaluation instead of replaying every case. Record actual costs and account for isolated-test usage only once.

Use the T3 collaborative preview tools when available. Hidden preview tabs can throttle interactive frame updates; inspect state after asynchronous actions. Actual browser GPU may differ from installed hardware or move with the preview client, so record the renderer before comparing performance. Existing verification covers Intel ARL and AMD Vega 20 browser contexts; do not present those measurements as guaranteed NVIDIA performance.

## Known limitations and possible follow-ups

These are candidates for the next agreed task, not unfinished work in this checkpoint:

1. **Furniture relationships and clearances:** the bounded search and axis-aligned rotated bounds are conservative. Bed/nightstand adjacency, chairs under tables, seating orientation and grouped moves would benefit from explicit relationships and more appropriate usable-side clearance rules. Meshes remain schematic; add better assets only with corresponding bounds/selection/inspection support.
2. **Agent cost and quality:** the successful small furniture run still used about 76k reported input tokens over three calls. Profile schema/context size and maintain meaningful model evaluations before changing tool exposure, prompts or model choice. Avoid restoring warning-chasing or stale-baseline claims.
3. **Rendering/performance:** the former path tracer's cold shader setup and continuous drawing were superseded by demand-driven raster rendering on October 7; current measurements are in `docs/render-performance.md`. General roof intersections, foundations, terrain interaction and architectural detailing remain concept approximations. Live/Clay/Wireframe modes and fast agent captures already work.
4. **Geometry/circulation:** rooms are rectangular volumes, stairs straight, and walkthrough has no collision/gravity simulation. General constraint solving, arbitrary plans, BIM/construction documents, engineering and compliance are out of scope today.
5. **Voice:** synthetic transport and earlier live provider checks passed, but real microphone permissions, noise robustness and conversational usability need a human microphone session.
6. **MCP:** the control API and services are prepared for an adapter, but no MCP implementation or remote authentication is present. Wait for an explicit request to expose it.

When resuming, read this handoff, check Git/runtime state and any new user changes, then establish the next objective. Preserve the user's existing projects and do not restart the completed upgrade automatically.
