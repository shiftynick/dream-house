# Terrain

A local architectural concept studio. Keep separate houses, start on an empty hillside, and describe what you imagine. The design agent uses architectural operations, checks geometry and locally rendered views, and can repair an unsaved draft before applying it.

For the current development checkpoint and next-session context, see [HANDOFF.md](HANDOFF.md).

## Run

Requires Node.js 22.12+ (developed with Node 24).

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. The server binds to `127.0.0.1` and handles the interface, local storage, and provider requests.

For a production build:

```sh
npm run build
npm start
```

`PORT` changes the local port. `TERRAIN_DATA_DIR` selects a separate project/settings directory for isolated testing; it defaults to `.data/` in the repository.

## Connect the AI

For subscription-backed local testing, install Codex CLI and sign in using `codex login` with ChatGPT. Copy `.env.example` to `.env` and use:

```dotenv
DESIGN_BACKEND=codex-cli
CODEX_MODEL=gpt-6.1-sol
VOICE_ENABLED=false
```

Restart the server after changing these settings. Both the builder and independent image critic use **Sol 6.1 with medium reasoning**. The backend launches headless Codex for each model turn and returns architectural commands to Terrain. Terrain owns geometry, rendering, validation and saves. Codex does not receive shell, file-editing or browser tools. Its saved ChatGPT authentication supplies subscription quota; API-key login is rejected. Missing login, exhausted quota or invalid responses fail explicitly without switching to Gateway.

Voice is disabled by default during testing: recording controls and speech playback are off, and audio endpoints reject requests. Set `VOICE_ENABLED=true` to enable the existing voice features.

For API-backed use, set `DESIGN_BACKEND=gateway`, then enter a **Vercel AI Gateway key** in **Connections and settings** or set `AI_GATEWAY_API_KEY`. Gateway defaults remain:

| Purpose                 | Model / voice                      |
| ----------------------- | ---------------------------------- |
| Design and conversation | `anthropic/claude-sonnet-5.5`      |
| Speech output           | `google/gemini-3.8-flash-lite-tts` |
| Speech voice            | `Kore`                             |
| Transcription           | `spacexai/grok-stt`                |

Gateway models and credentials remain saved separately while using Codex. A saved key takes precedence over the environment key. Optional `AI_GATEWAY_MODEL`, `AI_GATEWAY_SPEECH_MODEL`, `AI_GATEWAY_TRANSCRIPTION_MODEL` and `AI_GATEWAY_SPEECH_VOICE` override saved model choices. Keys persist in `.data/connections.json` with owner-only permissions and are never returned to the browser or exported. Leave the key field blank when saving other settings to preserve it. `.env` and `.data/` are ignored by Git.

Codex usage reports tokens and **Subscription quota**, with no invented dollar charge. Gateway daily request/cost counters exclude Codex calls. Local editing and rendering work without either provider. See [testing backend details](docs/testing-backend.md).

## Designing with the agent

1. Type an instruction. When voice is enabled, hold **Space** outside text fields/the microphone button and release to transcribe. Enter sends typed text; Shift+Enter adds a line.
2. The agent receives the current house and brief, its last ten messages, your selected room, surface or furniture piece, and the active view/camera. Point to a wall, floor, roof, room or piece before saying “make this cedar,” “move this wall outward,” or “rotate this sofa.” The space inspector also provides selection controls.
3. It uses local commands to attach wings, resize rooms from an edge, move a selected wall or group, connect doorways or floors, set roofs, place dimensioned windows and doors, change particular surface materials, and preserve requirements. The geometry engine calculates coordinates and related movements.
4. Edits happen in an unsaved draft. The interface shows progress, changes, issues, and valid previews. Structured validation errors can trigger a bounded repair pass. **Cancel** stops the run and discards its draft.
5. The agent supplies a request checklist, with local geometry assertions where supported. Unfulfilled required items and consequential assumptions require review and appear in the reply. A valid modest edit is committed automatically as one undo step. Deletions, substantial area changes, changes to protected requirements, and explicit agent proposals also require review. A failed attempt leaves the saved geometry unchanged and offers a retry.

New houses start with an explicit room program, material scheme, real exterior-window intent and important features. These become immutable objectives. A separate skeptical model call checks the original request, current geometry and rendered views, then gives the builder specific repair targets. Unfinished planned requirements remain essential while budget permits; a small core cannot quietly stand in for the complete house. Existing focused edits keep the shorter workflow. See [planned designs and critique](docs/design-quality.md) for contracts and limits.

The current backend and design workflow pass **457 tests and the production build**. A fresh isolated Codex subscription run of the exact grand-lodge prompt completed in ten actual calls: eleven spaces, real windows and entrance, coordinated materials, critic-guided repairs and fresh exterior/plan captures, followed by an accepting current critique and reviewable proposal. The saved house was unchanged. This is one successful sample, not a general reliability benchmark; earlier Gateway failures remain recorded. See [current verification status](docs/design-quality.md#verification).

Ambitious houses are built across concise batches. If a response hits its output limit, the application discards all incomplete calls and allows one smaller response within the existing run budget. Earlier valid draft work is retained; final geometry and visual checks still apply.

The **Design brief** keeps confirmed requirements, assumptions, and preferences with the house. The agent can create machine-checked connectivity, symmetry, room-property locks (including roofs and openings), and overlook requirements. You can edit descriptions/sources or add freeform notes. Freeform notes inform the agent but are not geometric assertions. Request checklists distinguish geometry checks from model judgments; they do not guarantee that the model understood every detail of natural-language instructions.

Refine a pending proposal through the same text or voice composer before adopting it. Earlier proposal versions remain available; adoption applies the cumulative result as one undo step. Refinements retain original preservation baselines, required checks and disclosed concerns. Use the focused-edit scope to keep an instruction within the selected part; unintended changes require review rather than being silently applied. See [focused editing](docs/focused-editing.md).

**Let AI inspect rendered views** is on by default; its setting persists in this browser. With it enabled and a local renderer connected, the agent requests an exterior, interior, cutaway, or floor-plan image of its valid draft. It must examine the resulting image in a later model round before finishing; another edit requires a fresh image. Focused edits allow three captures; planned compositions allow six for an initial pair and two fresh repair pairs. These views use the same local geometry and leave your camera unchanged. Images are sent to the model only when requested by its render tool; the desktop is never captured. Turn the setting off to use geometry checks without image uploads.

Keep the Terrain browser tab open for visual review and generated previews. The renderer currently runs in the browser; there is no headless render service.

**Latest design check** shows the agent's visual observations and the views it reviewed. Material and roof changes require a Live 3D color view. If the agent finds a visible problem or cannot verify the result, the change is presented for confirmation with its limitations. These visual judgments supplement the geometry checks.

## Houses and visual alternatives

Open **My houses** to name a new house or return to an existing one. Switching saves your current work first. Each house has its own conversation, design brief, geometry, history, and alternatives. Creating a house starts a fresh conversation and empty site while retaining your previous house in the library. **Alternatives → Start a new house** opens the same chooser.

For taste discovery, open **Alternatives**, describe what you want to explore, and generate **two or three directions**. The agent produces distinct designs; the browser renders comparable thumbnails using one shared camera and lighting. Explore an option in 3D, compare it with the current house, then choose explicitly. Generation does not change the saved house. Choosing applies one option as an undoable edit, saves every option as an alternative, and records your choice—and an optional explanation—as a soft preference in the design brief. The unchosen designs remain available to restore later.

Generated thumbnails stay local. If visual review is enabled, the agent can separately request images during option design; those images go to the model. Generating alternatives uses multiple model runs and can cost more than a single edit.

While exploring an option, send a refinement to create a revised option without replacing its parent or changing the saved house. Discarding the revision restores the parent preview; adopting it applies the cumulative design in one undo step.

## Editor and rendering

- Orbit and pan, inspect a floor plan with wall openings and stairs, or enter the walkthrough. Walkthrough: click the view, WASD to move, Q/E down/up, Shift to move faster, Escape to release the mouse. Movement has no collision or gravity simulation.
- Choose Live, Clay, Wireframe, or Presentation. Every mode renders immediately with local WebGL2 materials and lighting. Presentation allows a larger image/contact-shading budget; it does not progressively accumulate samples. Drawing stops when the view is still, shadows refresh after relevant edits, and contact shading returns after movement settles. Local material maps and detailed furniture also appear in agent captures. The browser/OS chooses the GPU.
- Select a space to edit its name, dimensions, position, use, walls, and material. Point to a particular surface or choose **Selected part** to edit its material independently. Surface palettes override room palettes, which override the house palette. Whole-house material choices reset room and surface overrides.
- **House roof default** and **Room roof** support Flat, Gable, and Single pitch, with pitch in degrees. For a single-pitch roof, **High edge** names the elevated side; room height sets the lowest eave. **Use house default** removes a room override. Changing the house default preserves room overrides.
- **Windows & doors** edits multiple openings on the selected wall: type, center offset, width, height, and sill. Offsets run east on north/south walls and south on east/west walls. **Apply openings** submits the complete standalone set; connected room passages are displayed separately and preserved. Shared openings appear consistently on both wall faces. Windows do not create walking routes.
- **Furniture** lets you rearrange existing pieces, or add, remove, resize, rotate, and recolor individual pieces. Click a piece in 3D or the furnished floor plan to refer to it in voice/chat, or use the room inspector. The agent rearranges first and can add or replace pieces when useful. **Arrange existing furniture** preserves the inventory and architecture, checks obstacles and access, and balances sofa/table placement. Review any remaining clearance notes; it is a bounded placement search, not a complete interior-design optimizer.
- In Floor plan, drag furniture to move it or drag the selected piece's round handle to rotate it. Release creates one undo step; Escape or cancellation discards the preview. Select one window, door or passage to edit its dimensions or remove it independently, including from the opposite side of a shared wall. See [precise editing](docs/precise-editing.md) for snapping, keyboard controls and safe opening transitions.
- Ask the agent to transfer space across a shared wall, split a room or merge adjoining rooms. These atomic commands preserve outside extents, world furniture positions, opening identities and applicable requirements. The initial supported cases are complete rectangular partitions with flat roofs and no affected stairs; incompatible finishes or cuts through features are rejected. See [room transformations](docs/room-transformations.md).
- Undo/redo use buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Save named alternatives and compare them using the same camera. Restoring an alternative is undoable.
- Export/import the active project as JSON or save a PNG of the 3D view. Imports replace the active house’s design while preserving its local project identity. The optional hillside example has an upper kitchen overlooking a double-height living room, a central chimney, attached symmetric bedroom wings, lower guest suites, courtyards, and linked stairs. It never loads by default.
- **Design report** exports elevation-specific floor-plan SVGs, room-area and effective-material CSVs, and printable sheets suitable for the browser's Save as PDF. These are concept summaries; see [design reports](docs/design-reports.md).

## Cost and privacy

- No background model calls. Focused designs can make **up to twelve model calls**; planned compositions allow **up to twenty**, including independent critique, with up to two repair opportunities and thirty-two tool calls. Local geometry operations and image rendering do not make provider calls. Sending rendered evidence to the model uses image tokens and another model round. Provider failures are not automatically retried. One truncated response can recover with a smaller batch; it counts against the same model-call and no-progress limits. Recovery and geometry repair can require additional paid model calls.
- The model receives its remaining budget each round and instructions to finish during its last three rounds. Three consecutive rounds without a new draft state, fewer blocking errors, a successful capture, or new image review stop the run before another model call. Repeated inspections and unchanged edits do not count as progress; stopping leaves the saved house unchanged.
- Generated alternatives run this bounded loop for each of two or three options, up to forty or sixty model calls in total when each is a planned composition (twenty-four or thirty-six for focused options). Refinements start another bounded run. Each model response is capped at 6,000 output tokens. The working house and brief are refreshed each round; older duplicate scene payloads are omitted while operation results and errors remain. Current-draft review images remain available through final review; stale images retire. Repeating an identical view reuses its local capture, although sending image pixels in another model call still uses input tokens.
- The default daily cap is **60 Gateway requests**, shared across Gateway design rounds, transcription, and speech. Codex subscription turns are excluded. It persists across restarts and resets at UTC midnight. A spoken exchange uses a variable number of requests. This is a request cap, not a dollar budget.
- Daily usage includes reported design and audio charges. Unreported charges are excluded; check Vercel AI Gateway for complete spending. Each design run reports only its own model cost; a run with any unknown model charge reports its total as unknown.
- Recordings are capped at 60 seconds and sent after release. Audio is processed in memory, not stored as a project asset.
- Prompts, geometry, brief/context, requested review images when enabled, recorded speech, and spoken-reply text go to the selected backend. Codex receives text, geometry and requested images through headless CLI; enabled audio and Gateway designs use Vercel AI Gateway. Rendering, saved projects, history, alternative thumbnails, and exports stay local.
- Local run summaries retain stages, issues, changes, model name, and available usage for diagnosis. They omit keys, viewport images, raw audio, and private model reasoning. There are no remote fonts, telemetry, rendering services, or cloud project storage.

## Local files and existing projects

`.data/workspace.json` stores the active-house ID and library of up to 100 houses. Each house retains up to 60 undo/redo steps, 30 alternatives, and 100 messages. Generated alternatives include their thumbnails. Queued saves use atomic renames. Invalid saves do not replace a valid file; corrupt files produce an error instead of silently resetting the library. Project exports back up the active house; copying `workspace.json` backs up the full library. Other local files are `connections.json`, `usage.json`, and `runs/<run-id>.json`.

Project saves carry both a project ID and revision. A stale tab receives a conflict instead of overwriting a newer revision or a different active house. Use one editing tab at a time; this is conflict protection, not collaborative editing. Draft proposals and unchosen generated choice sets live in server memory for 30 minutes and disappear on server restart. Committed edits remain in project history.

An existing `.data/project.json` is read as the original house when no workspace library exists. Migration is lazy: reading changes neither file; the first save, project creation, or switch writes `workspace.json` and leaves `project.json` untouched as a legacy backup. Once the workspace exists, it is authoritative. Older version-1 project documents remain readable: missing revisions default to zero, missing relationship metadata means an empty brief/graph, and rooms inherit the house palette unless overridden. Existing centered door flags remain usable. Unconfigured `pitched` roofs retain their original gable rise and orientation; they are not converted to single-pitch roofs. Old disconnected rooms or unlinked stairs can appear as warnings; the agent does not silently invent missing relationships or redesign unrelated spaces. New draft edits must preserve existing routes and connect new interior rooms, unless an explicit confirmed requirement permits a real courtyard route.

## Scope

Terrain is an architectural concept editor. It supports rectangular room volumes, multiple dimensioned windows and doors, groups, linked straight stairs, flat/gable/single-pitch roofs, terrain, and a fireplace. Validation checks overlaps, aperture dimensions and shared-wall conflicts, connections, stair landing references and portal widths/headroom, circulation changes, and supported requirements. Spatial inspection also reports advisory furniture fit and aisle checks, doorway approaches and assumed swing obstructions, and sampled stair headroom and landing clearance. Furniture and planting remain schematic.

Furniture positions, dimensions, yaw, kind, and optional material are saved with each room and shared by 3D rendering, floor plans, and clearance checks. Explicit solid pieces must fit their room; collisions and circulation remain advisory unless a request's furniture-layout assertion requires them to be clear. Rugs are decorative and excluded from obstacle checks. Existing houses retain generated legacy positions until their furniture is first edited; an explicitly empty furniture list stays empty. Furniture edits participate in undo, alternatives, export, and local persistence.

These spatial checks state their assumptions: 0.6 m furniture circulation, 0.9 m around kitchen work areas, 0.9 m door approaches and stair landings, and 2 m stair headroom. Swing checks assume one inward leaf as wide as the opening; handing and leaf count are not modeled. These warnings invite design review and do not certify building-code or accessibility compliance.

This is not a CAD/BIM or construction-document system. It does not solve general floor-plan constraints, arbitrary wall shapes, structural engineering, accessibility, building codes, or comprehensive stair safety. Each room owns its inward half of a shared wall, allowing different finishes on opposite faces. Linked stairs cut upper slabs; legacy unlinked stairs have no inferred openings. Partially covered sloping roofs use flat exposed patches to avoid intruding into upper rooms. Sloped wall caps support clerestory apertures, but roof joins, foundations, terrain interaction, and floor plans remain concept geometry.

## Checks

For repeatable local browser images and actual draw/frame diagnostics, see [capture tooling](docs/render-fidelity-capture.md), [performance evidence](docs/render-performance.md), and the [furniture realism study](docs/furniture-study.md). These use an isolated synthetic project and no cloud adapters.

```sh
npm test
npm run build
```

Tests exercise semantic geometry and surface selection, persistent requirements, advisory spatial checks, legacy migration and project isolation, fresh render evidence and broker ownership, alternative selection/preferences, bounded repair, cancellation, confirmation, atomic persistence, revision conflicts, idempotent commits, rendering geometry, and the actual HTTP adapter. Provider responses are injected mocks; these tests spend no API credits.

For a small opt-in real-model sample with isolated browser renders and cumulative cost accounting, see [capability verification](docs/capability-verification.md). Carry the prior ledger when continuing a run; do not reset the evaluation budget by restarting the script.

For an isolated browser session with explicitly injected model and audio responses:

```sh
SCENARIO_RUN=manual-check SCENARIO_PORT=5186 npx tsx scripts/scenario-server.ts
```

This separate entry point uses `.data/verification/manual-check`, never loads `.env`, and has no cloud model/audio adapter. The application, geometry, saves, and browser renderer are real. Its `/__verification/turns`, `/__verification/reset`, and `/__verification/render` endpoints queue simulated responses, install a fixture, or request a local capture. These endpoints exist only on this test server. Simulated speech uses silence and does not measure voice quality.

For a numerical benchmark of the local engine:

```sh
npx tsx scripts/benchmark.ts
```

It reports median and p95 times for inspection, a local material edit, and scene fingerprinting on the scenario fixtures. It makes no model calls and does not measure browser rendering or end-to-end voice latency. Successful agent responses also contain timing/context metrics; measurements and verification outcomes belong in the work log, not these capability descriptions.

With the server running and a Gateway key configured, opt into paid verification:

```sh
npm run verify:gateway -- --live
npm run verify:design -- --live --case selected
```

The Gateway check synthesizes a sentence, transcribes the generated audio, and runs a bounded design task. The two audio calls plus design rounds use up to fourteen paid requests. With `ffmpeg` available, transcription exercises WebM/Opus; otherwise it uses WAV. The design check defaults to a small selected-room material edit; `--case attach`, `empty`, `resize`, or `all` exercise other synthetic scenarios, with up to twelve model calls per case.

Both scripts use preview-only fixtures, report actual usage, and verify that the saved project stays byte-identical. They do not commit generated designs. `TERRAIN_BASE_URL` selects another loopback port. Microphone permissions and real-world recording quality still need a microphone session.

## Architecture

The geometry engine, draft lifecycle, model adapter, and HTTP server are separate. [`docs/architecture.md`](docs/architecture.md) describes the contracts, validation policy, control API, and extension points. The same commands and application service can support a future MCP adapter. **No MCP server is implemented or exposed.**

| Component                                                                                             | Responsibility                                                                     |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `shared/model.ts`, `shared/geometry.ts`                                                               | Project documents, history, dimensions, adjacency, circulation helpers             |
| `shared/design.ts`, `shared/spatial.ts`, `shared/architecture.ts`, `shared/openings.ts`               | Semantic operations, roof/aperture geometry, requirements, spatial advisories      |
| `shared/assessment.ts`, `shared/examples.ts`                                                          | Request assertions and a coherent hillside example                                 |
| `shared/selection.ts`, `shared/render.ts`                                                             | Surface identity, material precedence, render requests and deterministic cameras   |
| `shared/draft.ts`, `shared/harness.ts`, `shared/alternatives.ts`                                      | Drafts, confirmation, agent context/progress, choice contracts                     |
| `server/agent.ts`, `server/agent-context.ts`                                                          | Model loop, request assessment, context compaction, capture reuse, Gateway adapter |
| `server/design-service.ts`, `server/storage.ts`                                                       | Draft commits and atomic multi-house persistence                                   |
| `server/render-service.ts`, `server/alternative-service.ts`                                           | Render-provider broker and visual choice generation/acceptance                     |
| `server/app.ts`, `server/index.ts`                                                                    | HTTP controls, runs, usage, voice, Vite/static hosting                             |
| `server/gateway.ts`, `server/connections.ts`                                                          | Audio transports, credentials, settings, provider errors                           |
| `src/SceneView.tsx`, `src/renderGeometry.ts`, `src/RenderCapture.tsx`, `src/rasterRenderer.ts`        | Shared interactive/offscreen rendering, surfaces, openings, slab cutouts           |
| `src/App.tsx`, `src/ArchitectureControls.tsx`, `src/ProjectChooser.tsx`, `src/VisualAlternatives.tsx` | Editor, roof/opening controls, project library, proposals, brief, visual choices   |
| `src/useProject.ts`, `src/useRenderBridge.ts`, `src/useVisualAlternatives.ts`, `src/useVoice.ts`      | Revisioned saves, local capture transport, alternatives, push-to-talk              |

Integration references: [Vercel Gateway Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [Gateway transcription](https://vercel.com/docs/ai-gateway/modalities/speech-to-text), [Gateway speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech).
