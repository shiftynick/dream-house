# Terrain

A local, voice-first architectural concept studio. Keep separate houses, start on an empty hillside, and describe what you imagine. The design agent uses architectural operations, checks geometry and locally rendered views, and can repair an unsaved draft before applying it.

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

Open **Connections and settings**, enter one **Vercel AI Gateway key**, and click **Save connections**. The panel identifies whether a saved or environment key is configured; this does not verify provider access.

The editable defaults live in [`shared/connections.ts`](shared/connections.ts):

| Purpose                 | Model / voice                      |
| ----------------------- | ---------------------------------- |
| Design and conversation | `anthropic/claude-sonnet-5.5`      |
| Speech output           | `google/gemini-3.8-flash-lite-tts` |
| Speech voice            | `Kore`                             |
| Transcription           | `spacexai/grok-stt`                |

Use Gateway model IDs. The design model must support function/tool calling and image input for visual review. Choose a voice supported by the speech model. Replies default to **AI voice · Vercel Gateway**. **System voice** uses browser speech synthesis when available; replies can also be turned off.

Keys and settings persist across restarts in `.data/connections.json`, written with an atomic rename and owner-only `0600` permissions. Credentials are plaintext in that local file; the server never returns them to the browser or includes them in project exports. Leave the key field blank when saving other settings to preserve the existing key.

Alternatively, copy `.env.example` to `.env`, set `AI_GATEWAY_API_KEY`, and restart. A key saved in Connections takes precedence. Optional `AI_GATEWAY_MODEL`, `AI_GATEWAY_SPEECH_MODEL`, `AI_GATEWAY_TRANSCRIPTION_MODEL`, and `AI_GATEWAY_SPEECH_VOICE` environment settings override UI model choices; unset them and restart to use UI settings. `.env` and `.data/` are ignored by Git. Keep any custom data directory out of source control too.

Legacy OpenRouter and direct OpenAI keys are not reused as Gateway credentials. Existing saved model choices are preserved; select Sonnet in Connections if an older installation uses a different model. No credentials ship with the project. Local editing, rendering, history, and manually saved alternatives work without a key. AI design and generated alternatives need a key.

## Designing with the agent

1. Type an instruction, or hold **Space** outside text fields/the microphone button and release to transcribe. Enter sends typed text; Shift+Enter adds a line.
2. The agent receives the current house and brief, its last ten messages, your selected room or exact surface, and the active view/camera. Point to a wall, floor, roof, or room before saying “make this cedar” or “move this wall outward.” The space inspector also provides a **Selected part** control.
3. It uses local commands to attach wings, resize rooms from an edge, move a selected wall or group, connect doorways or floors, change particular surface materials, and preserve requirements. The geometry engine calculates coordinates and related movements.
4. Edits happen in an unsaved draft. The interface shows progress, changes, issues, and valid previews. Structured validation errors can trigger a bounded repair pass. **Cancel** stops the run and discards its draft.
5. A valid modest edit is committed automatically as one undo step. Deletions, substantial area changes, changes to protected requirements, and explicit agent proposals require review. A failed attempt leaves the saved geometry unchanged and offers a retry.

The **Design brief** keeps confirmed requirements, assumptions, and preferences with the house. The agent can create machine-checked connectivity, symmetry, locked-room, and overlook requirements. You can edit descriptions/sources or add freeform notes. Freeform notes inform the agent but are not geometric assertions.

**Let AI inspect rendered views** is on by default; its setting persists in this browser. With it enabled and a local renderer connected, the agent requests an exterior, interior, cutaway, or floor-plan image of its valid draft. It must examine the resulting image in a later model round before finishing; another edit requires a fresh image. Up to three captures are allowed per run. These views use the same local geometry and leave your camera unchanged. Images are sent to the model only when requested by its render tool; the desktop is never captured. Turn the setting off to use geometry checks without image uploads.

Keep the Terrain browser tab open for visual review and generated previews. The renderer currently runs in the browser; there is no headless render service.

## Houses and visual alternatives

Open **My houses** to name a new house or return to an existing one. Switching saves your current work first. Each house has its own conversation, design brief, geometry, history, and alternatives. Creating a house starts a fresh conversation and empty site while retaining your previous house in the library. **Alternatives → Start a new house** opens the same chooser.

For taste discovery, open **Alternatives**, describe what you want to explore, and generate **two or three directions**. The agent produces distinct designs; the browser renders comparable thumbnails using one shared camera and lighting. Explore an option in 3D, compare it with the current house, then choose explicitly. Generation does not change the saved house. Choosing applies one option as an undoable edit, saves every option as an alternative, and records your choice—and an optional explanation—as a soft preference in the design brief. The unchosen designs remain available to restore later.

Generated thumbnails stay local. If visual review is enabled, the agent can separately request images during option design; those images go to the model. Generating alternatives uses multiple model runs and can cost more than a single edit.

## Editor and rendering

- Orbit and pan, inspect a floor plan with wall openings and stairs, or enter the walkthrough. Walkthrough: click the view, WASD to move, Q/E down/up, Shift to move faster, Escape to release the mouse. Movement has no collision or gravity simulation.
- Choose Live, Clay, Wireframe, or Path traced. Path traced mode progressively path-traces the same geometry, resets on camera changes, and accumulates up to 128 samples. Shader compilation can be slow on integrated GPUs; the browser/OS chooses the GPU.
- Select a space to edit its name, dimensions, position, use, walls, and material. Point to a particular surface or choose **Selected part** to edit its material independently. Surface palettes override room palettes, which override the house palette. Whole-house material choices reset room and surface overrides. Roof style and terrain slope are editable.
- Undo/redo use buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Save named alternatives and compare them using the same camera. Restoring an alternative is undoable.
- Export/import the active project as JSON or save a PNG of the 3D view. Imports replace the active house’s design while preserving its local project identity. The optional sample never loads by default.

## Cost and privacy

- No background model calls. A design run can make **up to twelve model calls**, with up to two repair opportunities and thirty-two tool calls. Local geometry operations and image rendering do not make provider calls. Sending rendered evidence to the model uses image tokens and another model round. Provider failures and truncated responses are not automatically retried; geometry repair does involve additional paid model calls.
- The model receives its remaining budget each round and instructions to finish during its last three rounds. Three consecutive rounds without a new draft state, fewer blocking errors, a successful capture, or new image review stop the run before another model call. Repeated inspections and unchanged edits do not count as progress; stopping leaves the saved house unchanged.
- Generated alternatives run this bounded loop for each of two or three options, up to twenty-four or thirty-six model calls in total. Each model response is capped at 6,000 output tokens. The initial request contains the current house/brief and ten recent messages; subsequent rounds include tool results from that run.
- The default daily cap is **60 cloud requests**, shared across every design round, transcription, and speech. It persists across restarts and resets at UTC midnight. A spoken exchange uses a variable number of requests. This is a request cap, not a dollar budget.
- Displayed costs include only reported design charges. Audio charges and unreported design charges are excluded; check Vercel AI Gateway for complete spending. A run with any unknown model charge reports its total as unknown.
- Recordings are capped at 60 seconds and sent after release. Audio is processed in memory, not stored as a project asset.
- Prompts, geometry, brief/context, requested review images when enabled, recorded speech, and spoken-reply text go through Vercel AI Gateway to the selected providers. Rendering, saved projects, history, alternative thumbnails, and exports stay local.
- Local run summaries retain stages, issues, changes, model name, and available usage for diagnosis. They omit keys, viewport images, raw audio, and private model reasoning. There are no remote fonts, telemetry, rendering services, or cloud project storage.

## Local files and existing projects

`.data/workspace.json` stores the active-house ID and library of up to 100 houses. Each house retains up to 60 undo/redo steps, 30 alternatives, and 100 messages. Generated alternatives include their thumbnails. Queued saves use atomic renames. Invalid saves do not replace a valid file; corrupt files produce an error instead of silently resetting the library. Project exports back up the active house; copying `workspace.json` backs up the full library. Other local files are `connections.json`, `usage.json`, and `runs/<run-id>.json`.

Project saves carry both a project ID and revision. A stale tab receives a conflict instead of overwriting a newer revision or a different active house. Use one editing tab at a time; this is conflict protection, not collaborative editing. Draft proposals and unchosen generated choice sets live in server memory for 30 minutes and disappear on server restart. Committed edits remain in project history.

An existing `.data/project.json` is read as the original house when no workspace library exists. Migration is lazy: reading changes neither file; the first save, project creation, or switch writes `workspace.json` and leaves `project.json` untouched as a legacy backup. Once the workspace exists, it is authoritative. Older version-1 project documents remain readable: missing revisions default to zero, missing relationship metadata means an empty brief/graph, and rooms inherit the house palette unless overridden. Existing centered door flags remain usable. Old disconnected rooms or unlinked stairs can appear as warnings; the agent does not silently invent missing relationships or redesign unrelated spaces. New draft edits must preserve existing routes and connect new interior rooms, unless an explicit confirmed requirement permits a real courtyard route.

## Scope

Terrain is an architectural concept editor. It supports rectangular room volumes, aligned openings, groups, linked straight stairs, flat/pitched roofs, terrain, and a fireplace. Validation checks overlaps, connections, stair landing references, circulation changes, and supported requirements. Spatial inspection also reports advisory furniture fit and aisle checks, doorway approaches and assumed swing obstructions, and approximate stair headroom and landing clearance. Furniture and planting remain schematic.

These spatial checks state their assumptions: 0.6 m furniture circulation, 0.9 m around kitchen work areas, 0.9 m door approaches and stair landings, and 2 m stair headroom. Swing checks assume one inward leaf as wide as the opening; handing and leaf count are not modeled. These warnings invite design review and do not certify building-code or accessibility compliance.

This is not a CAD/BIM or construction-document system. It does not solve general floor-plan constraints, arbitrary wall shapes, structural engineering, accessibility, building codes, or comprehensive stair safety. Each room owns its inward half of a shared wall, allowing different finishes on opposite faces. Linked stairs cut upper slabs; legacy unlinked stairs have no inferred openings. Partially covered pitched roofs use flat exposed patches to avoid intruding into upper rooms. Floor plans are concept views, and realistic assets/joins need further refinement.

## Checks

```sh
npm test
npm run build
```

Tests exercise semantic geometry and surface selection, persistent requirements, advisory spatial checks, legacy migration and project isolation, fresh render evidence and broker ownership, alternative selection/preferences, bounded repair, cancellation, confirmation, atomic persistence, revision conflicts, idempotent commits, rendering geometry, and the actual HTTP adapter. Provider responses are injected mocks; these tests spend no API credits.

With the server running and a Gateway key configured, opt into paid verification:

```sh
npm run verify:gateway -- --live
npm run verify:design -- --live --case selected
```

The Gateway check synthesizes a sentence, transcribes the generated audio, and runs a bounded design task. The two audio calls plus design rounds use up to fourteen paid requests. With `ffmpeg` available, transcription exercises WebM/Opus; otherwise it uses WAV. The design check defaults to a small selected-room material edit; `--case attach`, `empty`, `resize`, or `all` exercise other synthetic scenarios, with up to twelve model calls per case.

Both scripts use preview-only fixtures, report actual usage, and verify that the saved project stays byte-identical. They do not commit generated designs. `TERRAIN_BASE_URL` selects another loopback port. Microphone permissions and real-world recording quality still need a microphone session.

## Architecture

The geometry engine, draft lifecycle, model adapter, and HTTP server are separate. [`docs/architecture.md`](docs/architecture.md) describes the contracts, validation policy, control API, and extension points. The same commands and application service can support a future MCP adapter. **No MCP server is implemented or exposed.**

| Component                                                                                        | Responsibility                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `shared/model.ts`, `shared/geometry.ts`                                                          | Project documents, history, dimensions, adjacency, circulation helpers           |
| `shared/design.ts`, `shared/spatial.ts`                                                          | Semantic operations, requirements, measured spatial advisories                   |
| `shared/selection.ts`, `shared/render.ts`                                                        | Surface identity, material precedence, render requests and deterministic cameras |
| `shared/draft.ts`, `shared/harness.ts`, `shared/alternatives.ts`                                 | Drafts, confirmation, agent context/progress, choice contracts                   |
| `server/agent.ts`                                                                                | Tool-using model loop, visual review, repair limits, Gateway adapter             |
| `server/design-service.ts`, `server/storage.ts`                                                  | Draft commits and atomic multi-house persistence                                 |
| `server/render-service.ts`, `server/alternative-service.ts`                                      | Render-provider broker and visual choice generation/acceptance                   |
| `server/app.ts`, `server/index.ts`                                                               | HTTP controls, runs, usage, voice, Vite/static hosting                           |
| `server/gateway.ts`, `server/connections.ts`                                                     | Audio transports, credentials, settings, provider errors                         |
| `src/SceneView.tsx`, `src/renderGeometry.ts`, `src/RenderCapture.tsx`                            | Shared interactive/offscreen rendering, surfaces, openings, slab cutouts         |
| `src/App.tsx`, `src/ProjectChooser.tsx`, `src/VisualAlternatives.tsx`                            | Editor, project library, proposals, brief, visual choices                        |
| `src/useProject.ts`, `src/useRenderBridge.ts`, `src/useVisualAlternatives.ts`, `src/useVoice.ts` | Revisioned saves, local capture transport, alternatives, push-to-talk            |

Integration references: [Vercel Gateway Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [Gateway transcription](https://vercel.com/docs/ai-gateway/modalities/speech-to-text), [Gateway speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech), [Three GPU PathTracer](https://github.com/gkjohnson/three-gpu-pathtracer).
