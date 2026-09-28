# Terrain

A local, voice-first architectural concept studio. Start on an empty hillside, describe a home, and refine one persistent 3D model.

## Run

Requires Node.js 22.12+ (developed with Node 24).

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. The server binds to `127.0.0.1` only. The same server handles the interface, local storage, and provider requests.

For a production build:

```sh
npm run build
npm start
```

## Connect the AI

Open **Connections and settings** in the top bar and enter one **Vercel AI Gateway key** for design, transcription, and spoken replies. Click **Save connections**. The panel identifies whether a saved or environment key is configured; this does not verify provider access.

The editable defaults live in `shared/connections.ts`:

| Purpose                 | Model / voice                      |
| ----------------------- | ---------------------------------- |
| Design and conversation | `anthropic/claude-sonnet-5.5`      |
| Speech output           | `google/gemini-3.8-flash-lite-tts` |
| Speech voice            | `Kore`                             |
| Transcription           | `spacexai/grok-stt`                |

Use Gateway model IDs. The design model must support structured outputs; choose a voice supported by your speech model. Spoken replies default to **AI voice · Vercel Gateway**. **System voice** uses browser speech synthesis with no API charge if your browser provides a voice, and replies can also be turned off.

The key and settings persist across browser and server restarts in `.data/connections.json`. Writes use an atomic rename and owner-only `0600` file permissions. The file contains plaintext credentials; the server never returns keys to the browser or includes them in project exports. Leave the key field blank when saving other settings to preserve the existing key.

Alternatively, copy `.env.example` to `.env`, set `AI_GATEWAY_API_KEY`, and restart the server. A key saved in Connections takes precedence over the environment key. Optional `AI_GATEWAY_MODEL`, `AI_GATEWAY_SPEECH_MODEL`, `AI_GATEWAY_TRANSCRIPTION_MODEL`, and `AI_GATEWAY_SPEECH_VOICE` environment settings override the corresponding UI settings; unset them and restart to use the UI choices. Both `.env` and `.data/` are ignored by Git.

Legacy OpenRouter and OpenAI keys are not reused as Gateway credentials. No credentials ship with the project. The editor, sample house, materials, camera, history, and alternatives work without a key; natural-language generation, transcription, and AI speech require Gateway access.

## Cost and privacy

- No background model calls or app-level automatic paid retries.
- Up to 10 recent conversation messages plus the current scene are sent per design request. Output is capped at 6,000 tokens.
- Default daily cap: 60 cloud requests, shared across design, transcription, and cloud speech, persisted across server restarts and reset at UTC midnight. A spoken exchange can use three requests. This is **not a dollar budget**; configure spending limits with providers.
- The help panel shows only provider-reported design cost. Audio charges and unreported design charges are not included; a zero displayed total does not mean calls were free. See Vercel AI Gateway for complete spending.
- Recordings are capped at 60 seconds and sent only after releasing the key. Audio is processed in memory, not saved as a project asset.
- Design prompts, the current scene, recorded speech, and text for AI spoken replies are sent through Vercel AI Gateway to the selected model providers. All geometry, rendering, project files, versions, and exports stay local.
- No remote fonts, rendering service, telemetry, or cloud project storage.

## Editor

- Hold **Space** outside text fields, or hold the microphone button, to speak. Release to transcribe and submit.
- Type as an alternative. Enter sends; Shift+Enter adds a line.
- Orbit and pan around the house, inspect a floor plan, or enter the free-movement walkthrough.
- Walkthrough: click the view, use WASD to move, Q/E down/up, Shift for faster movement, Escape to release the mouse. Collision and gravity are not implemented.
- Choose Live, Clay, Wireframe, or Light study. Light study progressively path-traces the same geometry, pauses/reset on camera changes, and accumulates up to 128 samples. Initial shader compilation can be slow, especially on integrated GPUs. GPU selection is controlled by the browser/OS; the app requests a high-performance context but cannot force NVIDIA.
- Select a space to edit its name, dimensions, position, use, and wall types. Changes are undoable.
- Materials offers four immediate visual alternatives. Roof styles and terrain slope are editable.
- Undo/redo work with buttons or Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z.
- Save named alternatives and compare them with the current house using the same camera. Restoring a version is undoable.
- Export/import project JSON, export a PNG of the 3D view, or start a new house from Alternatives. Starting over preserves undo and saved alternatives.

The agent can apply a small change directly, ask a question, or present a proposed scene for confirmation. Responses are validated before mutation. Out-of-range dimensions, duplicate IDs, and overlapping enclosed room volumes are rejected.

The current harness makes one structured-output model request for each design instruction. Typed text goes directly to the agent; held-key audio is transcribed first. The request includes the complete current scene and the last ten conversation messages. The model returns a short reply and either a complete replacement scene or no scene when it needs to ask a question. The server checks the schema and room geometry and requires review for substantial deletions. Valid edits update the shared 3D model, enter undo history, and save locally; the reply is then spoken when enabled. There is no tool loop or automatic geometry-repair pass: an invalid proposed scene is rejected and leaves the current house unchanged.

## Local files

`.data/project.json` stores the house, up to 60 undo steps, saved alternatives, and up to 100 messages. Saves are queued and atomically renamed. Invalid saves do not replace a valid file. A corrupt existing file produces an error rather than silently resetting the project. Keep a backup by exporting periodically. Use one editing tab at a time; concurrent collaborative editing is not implemented.

## Scope

This is an initial working concept editor, not a CAD/BIM application or construction-ready design tool. Current architecture uses rectangular rooms, solid/glazed/open/door walls, flat/pitched roofs, stairs, and a central fireplace. Furniture and planting are schematic. The floor plan shows room footprints and dimensions, not detailed construction drawings. Wall joins, circulation, stair safety, accessibility, structure, arbitrary forms, and production-level photoreal assets still need refinement. Do not treat a generated design as an engineered building.

The optional sample reflects the discovery conversation. It never loads by default; new projects start with an empty site. The sample and manual controls are not a substitute for or simulation of AI generation.

## Checks

```sh
npm test
npm run build
```

Tests cover transactional history, geometry rejection, atomic persistence, connection settings and key precedence, bounded agent context, validation of model output, proposals, Gateway request formats, audio validation, and failures without retries. These tests use injected mock provider responses and do not spend API credits.

With the local server running and a Gateway key configured, run the optional live integration check:

```sh
npm run verify:gateway -- --live
```

This makes **three small paid requests**: generate a spoken sentence, transcribe that audio, and generate and validate a simple one-room design. It uses three requests from the daily cap and verifies that the saved project remains unchanged. With `ffmpeg` on PATH, generated speech is converted to WebM/Opus to exercise the browser recording format; otherwise the check transcribes the generated WAV directly. `TERRAIN_BASE_URL` can point the check at a different local port. A real microphone session is still needed to assess recording permissions and conversational voice quality.

The initial Gateway integration passed this basic live speech-to-WebM transcription roundtrip and single-room design check with exactly three requests and no saved-project changes. That run used `openai/gpt-4.1-mini` for design, with the current speech and transcription defaults.

The current `anthropic/claude-sonnet-5.5` design default also passed a bedroom-layout edit to an existing 12-room house through the actual interface, using an isolated project copy. The result passed geometry validation, saved locally, survived reload, and supported undo and redo; the spoken reply played successfully. The design request took about 26.9 seconds and reported $0.040768 in Gateway cost, excluding speech. This is one successful sample, not a general latency, cost, or design-quality benchmark. The original saved project was preserved. Noisy microphone recordings remain unbenchmarked.

## Architecture

- `shared/model.ts`: validated model, history, palettes, explicit sample.
- `shared/connections.ts`: public model and voice defaults, shared by the server and settings UI.
- `server/agent.ts`: bounded structured-output agent request and response validation.
- `server/gateway.ts`: Vercel Gateway audio requests, audio validation, cost parsing, and safe provider errors.
- `server/connections.ts`: private key persistence, validated settings, and environment precedence.
- `server/storage.ts`: serialized atomic project persistence.
- `server/index.ts`: loopback-only server, private connections, usage cap, voice, Vite/static hosting.
- `src/SceneView.tsx`: coherent 3D geometry, camera controls, floor plans, and progressive path tracing.
- `src/App.tsx`: editor, conversation, local saving, undo, alternatives, settings.
- `src/useVoice.ts`: push-to-talk lifecycle, permissions, release handling, and transcription.
- `scripts/verify-gateway.ts`: opt-in paid speech, transcription, and design integration check.

Integration references: [Vercel Gateway structured outputs](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/structured-outputs), [Vercel Gateway transcription](https://vercel.com/docs/ai-gateway/modalities/speech-to-text), [Vercel Gateway speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech), [Three GPU PathTracer](https://github.com/gkjohnson/three-gpu-pathtracer).
