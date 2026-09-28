# Terrain

A local, voice-first architectural concept studio. Start on an empty hillside, describe a home, and refine one persistent 3D model. The design agent uses architectural operations, checks its work, and can repair a draft before applying it.

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

Use Gateway model IDs. The design model must support function/tool calling; sending a viewport image also requires image input support. Choose a voice supported by the speech model. Replies default to **AI voice · Vercel Gateway**. **System voice** uses browser speech synthesis when available; replies can also be turned off.

Keys and settings persist across restarts in `.data/connections.json`, written with an atomic rename and owner-only `0600` permissions. Credentials are plaintext in that local file; the server never returns them to the browser or includes them in project exports. Leave the key field blank when saving other settings to preserve the existing key.

Alternatively, copy `.env.example` to `.env`, set `AI_GATEWAY_API_KEY`, and restart. A key saved in Connections takes precedence. Optional `AI_GATEWAY_MODEL`, `AI_GATEWAY_SPEECH_MODEL`, `AI_GATEWAY_TRANSCRIPTION_MODEL`, and `AI_GATEWAY_SPEECH_VOICE` environment settings override UI model choices; unset them and restart to use UI settings. `.env` and `.data/` are ignored by Git. Keep any custom data directory out of source control too.

Legacy OpenRouter and direct OpenAI keys are not reused as Gateway credentials. Existing saved model choices are preserved; select Sonnet in Connections if an older installation uses a different model. No credentials ship with the project. Local editing, rendering, history, and alternatives work without a key.

## Designing with the agent

1. Type an instruction, or hold **Space** outside text fields/the microphone button and release to transcribe. Enter sends typed text; Shift+Enter adds a line.
2. The agent receives the house and persistent brief, the last ten messages, your selected room, and the active view/camera. Select a room before saying “make this bigger.”
3. It uses local commands to attach wings, resize rooms from an edge, move groups, connect doorways or floors, change materials, and preserve requirements. Coordinates and related movements are calculated by the geometry engine.
4. Edits happen in an unsaved draft. The interface shows progress, changes, issues, and valid previews. Structured validation errors can trigger a bounded repair pass. **Cancel** stops the run and discards its draft.
5. A valid modest edit is committed automatically as one undo step. Deletions, substantial area changes, changes to protected requirements, and explicit agent proposals require review. A failed attempt leaves the saved geometry unchanged and offers a retry.

The **Design brief** keeps confirmed requirements, assumptions, and preferences with the house. The agent can create machine-checked connectivity, symmetry, locked-room, and overlook requirements. You can edit descriptions/sources or add freeform notes. Freeform notes inform the agent but are not geometric assertions.

**Include current 3D view with my request** is off by default. Enabling it sends a small image of the house viewport with subsequent 3D-view requests. It does not capture the desktop, and no image is sent from plan view. Visual context supplements numerical geometry checks; the agent does not run an automatic rendered-image review after every operation.

## Editor and rendering

- Orbit and pan, inspect a floor plan with wall openings and stairs, or enter the walkthrough. Walkthrough: click the view, WASD to move, Q/E down/up, Shift to move faster, Escape to release the mouse. Movement has no collision or gravity simulation.
- Choose Live, Clay, Wireframe, or Light study. Light study progressively path-traces the same geometry, resets on camera changes, and accumulates up to 128 samples. Shader compilation can be slow on integrated GPUs; the browser/OS chooses the GPU.
- Select a space to edit its name, dimensions, position, use, walls, and room palette. Whole-house material choices reset individual room overrides. Roof style and terrain slope are editable.
- Undo/redo use buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Save named alternatives and compare them using the same camera. Restoring an alternative is undoable.
- Export/import project JSON, export a PNG of the 3D view, or start a new house from Alternatives. Starting over preserves history and saved alternatives. The optional sample never loads by default.

## Cost and privacy

- No background model calls. A design run can make **up to six model calls**, with up to two repair opportunities and twenty tool calls. Local geometry operations do not make provider calls. Provider failures and truncated responses are not automatically retried; geometry repair does involve additional paid model calls.
- Each model response is capped at 6,000 output tokens. The initial request contains the current house/brief and ten recent messages; subsequent rounds include tool results from that run.
- The default daily cap is **60 cloud requests**, shared across every design round, transcription, and speech. It persists across restarts and resets at UTC midnight. A spoken exchange uses a variable number of requests. This is a request cap, not a dollar budget.
- Displayed costs include only reported design charges. Audio charges and unreported design charges are excluded; check Vercel AI Gateway for complete spending. A run with any unknown model charge reports its total as unknown.
- Recordings are capped at 60 seconds and sent after release. Audio is processed in memory, not stored as a project asset.
- Prompts, geometry, brief/context, optional viewport images, recorded speech, and spoken-reply text go through Vercel AI Gateway to the selected providers. Rendering, saved projects, history, alternatives, and exports stay local.
- Local run summaries retain stages, issues, changes, model name, and available usage for diagnosis. They omit keys, viewport images, raw audio, and private model reasoning. There are no remote fonts, telemetry, rendering services, or cloud project storage.

## Local files and existing projects

`.data/project.json` stores the house, up to 60 undo/redo steps, 30 alternatives, and 100 messages. Queued saves use atomic renames. Invalid saves do not replace a valid file; corrupt files produce an error instead of silently resetting the project. Exports provide portable backups. Other local files are `connections.json`, `usage.json`, and `runs/<run-id>.json`.

Project saves carry a revision number. A stale tab receives a conflict instead of overwriting a newer house. Use one editing tab at a time; this is conflict protection, not collaborative editing. Draft proposals live in server memory for 30 minutes and disappear on server restart. Committed edits remain in project history.

Older version-1 projects load without conversion: missing revisions default to zero, missing relationship metadata means an empty brief/graph, and rooms inherit the house palette unless overridden. Existing centered door flags remain usable. Old disconnected rooms or unlinked stairs can appear as warnings; the agent does not silently invent missing relationships or redesign unrelated spaces. New draft edits must preserve existing routes and connect new interior rooms, unless an explicit confirmed requirement permits a real courtyard route.

## Scope

Terrain is an architectural concept editor. It supports rectangular room volumes, aligned openings, groups, linked straight stairs, flat/pitched roofs, terrain, and a fireplace. Validation checks overlaps, connections, stair landing references, circulation changes, and supported requirements. Furniture and planting remain schematic.

This is not a CAD/BIM or construction-document system. It does not solve general floor-plan constraints, arbitrary wall shapes, structural engineering, accessibility, building codes, or comprehensive stair safety. Shared walls use one rendered surface. Linked stairs cut upper slabs; legacy unlinked stairs have no inferred openings. Partially covered pitched roofs use flat exposed patches to avoid intruding into upper rooms. Floor plans are concept views, and realistic assets/joins need further refinement.

## Checks

```sh
npm test
npm run build
```

Tests exercise semantic geometry, persistent requirements, legacy compatibility, valid previews, bounded repair, cancellation, confirmation, atomic persistence, revision conflicts, idempotent commits, rendering geometry, and the actual HTTP adapter. Provider responses are injected mocks; these tests spend no API credits.

With the server running and a Gateway key configured, opt into paid verification:

```sh
npm run verify:gateway -- --live
npm run verify:design -- --live --case selected
```

The Gateway check synthesizes a sentence, transcribes the generated audio, and runs a bounded design task. The two audio calls plus design rounds use up to eight paid requests. With `ffmpeg` available, transcription exercises WebM/Opus; otherwise it uses WAV. The design check defaults to a small selected-room material edit; `--case attach`, `empty`, `resize`, or `all` exercise other synthetic scenarios, with up to six model calls per case.

Both scripts use preview-only fixtures, report actual usage, and verify that the saved project stays byte-identical. They do not commit generated designs. `TERRAIN_BASE_URL` selects another loopback port. Microphone permissions and real-world recording quality still need a microphone session.

## Architecture

The geometry engine, draft lifecycle, model adapter, and HTTP server are separate. [`docs/architecture.md`](docs/architecture.md) describes the contracts, validation policy, control API, and extension points. The same commands and application service can support a future MCP adapter. **No MCP server is implemented or exposed.**

| Component                                       | Responsibility                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `shared/model.ts`, `shared/geometry.ts`         | Validated document, history, dimensions, adjacency, circulation helpers               |
| `shared/design.ts`                              | Semantic command schemas, deterministic execution, inspection, requirement validation |
| `shared/draft.ts`, `shared/harness.ts`          | Unsaved drafts, change/confirmation rules, context, progress contracts                |
| `server/agent.ts`                               | Tool-using model loop, prompt, repair limits, Gateway model adapter                   |
| `server/design-service.ts`, `server/storage.ts` | Shared draft/commit service and revisioned atomic persistence                         |
| `server/app.ts`, `server/index.ts`              | HTTP controls, agent runs, usage, voice, Vite/static hosting                          |
| `server/gateway.ts`, `server/connections.ts`    | Audio transports, credentials, settings, provider errors                              |
| `src/SceneView.tsx`, `src/renderGeometry.ts`    | 3D/plan geometry, openings, slab cutouts, camera context, path tracing                |
| `src/App.tsx`, `src/useVoice.ts`                | Editor, proposals, brief, saving, alternatives, push-to-talk                          |

Integration references: [Vercel Gateway Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [Gateway transcription](https://vercel.com/docs/ai-gateway/modalities/speech-to-text), [Gateway speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech), [Three GPU PathTracer](https://github.com/gkjohnson/three-gpu-pathtracer).
