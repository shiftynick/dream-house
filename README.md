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

Open **Connections and settings** in the top bar:

- **OpenRouter key:** enables the design agent. The configurable initial model is `openai/gpt-4.1-mini`; choose a model supporting structured outputs.
- **OpenAI key:** enables push-to-talk transcription (`gpt-4o-mini-transcribe`) and optional cloud spoken replies (`gpt-4o-mini-tts`).
- **System voice:** uses browser speech synthesis with no API charge if your browser provides a voice. Select **AI voice** for cloud speech or turn replies off.

Keys are stored in `.data/connections.json` with owner-only permissions. They are never returned to the browser or included in exports. Alternatively copy `.env.example` to `.env` and add your keys there. `OPENROUTER_MODEL` in the environment overrides the model in the settings panel. Both `.env` and `.data/` are ignored by Git.

No credentials ship with the project. The editor, sample house, materials, camera, history, and alternatives work without any keys; natural-language generation and transcription require configured providers. No provider calls were made during development testing.

## Cost and privacy

- No background model calls or automatic paid retries.
- Up to 10 recent conversation messages plus the current scene are sent per design request. Output is capped at 6,000 tokens.
- Default daily cap: 60 cloud requests, shared across design, transcription, and cloud speech, persisted across server restarts and reset at UTC midnight. A spoken exchange can use three requests. This is **not a dollar budget**; configure spending limits with providers.
- The help panel shows provider-reported model cost. Voice charges are additional; see your provider account for complete billing.
- Recordings are capped at 60 seconds and sent only after releasing the key. Audio is processed in memory, not saved as a project asset.
- Prompts and the current scene go to OpenRouter/its selected model provider. Recorded speech goes to OpenAI. All geometry, rendering, project files, versions, and exports stay local.
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

Tests cover transactional history, geometry rejection, atomic persistence, bounded agent context, validation of model output, proposals, and failures without retries. Provider behavior is tested with injected mock responses; live voice/model latency and quality still require credentials and a microphone session.

## Architecture

- `shared/model.ts`: validated model, history, palettes, explicit sample.
- `server/agent.ts`: bounded structured-output agent request and response validation.
- `server/storage.ts`: serialized atomic project persistence.
- `server/index.ts`: loopback-only server, private connections, usage cap, voice, Vite/static hosting.
- `src/SceneView.tsx`: coherent 3D geometry, camera controls, floor plans, and progressive path tracing.
- `src/App.tsx`: editor, conversation, local saving, undo, alternatives, settings.
- `src/useVoice.ts`: push-to-talk lifecycle, permissions, release handling, and transcription.

Integration references: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [OpenAI transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [OpenAI speech](https://developers.openai.com/api/docs/guides/text-to-speech), [Three GPU PathTracer](https://github.com/gkjohnson/three-gpu-pathtracer).
