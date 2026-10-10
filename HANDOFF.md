# Terrain session handoff

Paused October 10, 2026 at the user's request. Project servers and verification processes are stopped, and no worker agents or development tasks remain active. Do not resume development or model evaluations until the user asks. The latest feature commit is `5de5458` on `main`; the pause documentation is committed after it. Repository: [shiftynick/dream-house](https://github.com/shiftynick/dream-house). Workspace: `/home/shifty/Work/dream-house`.

**The Agent Dashboard is retired. Do not call its API, read its inbox or use its key. Keep updates, questions and approvals here in T3.** Historical dashboard records below are evidence only.

## Current application

- Local Terrain house designer with separate saved houses, undo/history, design briefs, editable geometry/furniture, render review, proposals/alternatives and project/report exports.
- Builder and independent image critic use headless Codex CLI with ChatGPT authentication and subscription quota. Voice is disabled in both browser and HTTP endpoints.
- A persistent selector above the chat composer chooses **Sol 6.1 medium** or **Astra high** for builder, critic, refinements and alternatives. Switching is blocked during a design or preference save; a run retains one fixed model/client.
- **At shutdown, the owner's saved selection was Astra/high.** Ignored `.env` has `DESIGN_BACKEND=codex-cli`, `CODEX_MODEL=gpt-6.1-sol`, `VOICE_ENABLED=false`. `CODEX_MODEL` is only the starting default; the saved page selection takes precedence.
- Gateway keys and model settings remain saved separately. There is no automatic Gateway fallback. `DESIGN_BACKEND=gateway` restores that backend after restart. Do not print credentials, reset settings or enable voice without a new user request.
- Rendering uses Three.js WebGL2 PBR with Live, Clay, Wireframe and single-frame Presentation modes. Progressive ray tracing was retired. Architectural textures, furniture and demand rendering remain intact.

The previous five-product-gap goal is complete: proposal/alternative refinement; focused edit preservation; atomic room transforms; precise floor-plan furniture/opening controls; and SVG/CSV/print reports. No feature goal is currently active.

## Resume

The app was deliberately stopped; `http://localhost:5174` will not respond until restarted. Check the listener before launching another copy. Use the existing installation and saved data:

```sh
cd /home/shifty/Work/dream-house
codex login status
PORT=5174 npm run dev
```

Open **http://localhost:5174** and inspect `/api/status` for the selected model, reasoning effort, Codex login and disabled voice. Codex CLI 0.162.1 was installed and logged in using ChatGPT at shutdown; verify this again on resume. Login status confirms authentication, not remaining quota. Node.js 22.12+ is required; the current local runtime was Node 26.8.2.

Backend changes require a restart. `npm start` serves the existing production `dist/`; rebuild before using changed frontend code. The dev app includes a Vite websocket on port 24678; both that listener and 5174 were stopped. No separate renderer service is needed, but keep a Terrain browser tab open when the design agent requests render images.

```sh
npm test
npm run build
git diff --check
```

## Validation and evidence

Latest feature source passes **460 full tests, TypeScript and production build**. Independent Sol review cleared the selector, backend routing, schema compatibility, isolation, persistence and cancellation. Actual isolated browser checks passed model switching/reload, failed-save selection retention, disabled switching during a design and disabled voice. The pause commit changes documentation only; no new model evaluations were launched during shutdown.

A fresh Sol/medium exact-prompt run of “I would like you to build a grand lodge demonstrating the maximum awesomeness of your capabilities.” passed through the actual application HTTP workflow in **10 subscription calls**. It produced 11 spaces, validated geometry/indoor circulation, real arrival and public-bath access, coherent materials/windows, actual initial and repaired exterior/plan images, critic-guided repairs, a current accepting critique and a reviewable proposal. Reported usage: 619,848 input / 4,033 output tokens, null dollar cost. The concept was not adopted into the owner's house. This is one successful sample, not an overall reliability benchmark.

Actual Astra/high CLI inspection and an eight-objective critic using those real repaired render pixels returned valid semantic responses. Astra judged that recorded design as still needing work. This proves Astra adapter/image compatibility, not a fresh complete Astra architectural build. Independent Astra render review cleared the repaired exterior/ground-plan pair; concealed interiors and rear elevations were not newly reviewed.

Private evidence is ignored under `.data/verification/`:

- `live-codex-lodge-SzGbG0/`: successful full Sol run, result/answer, actual captures, call records and subsequent Astra critic smoke.
- `live-codex-lodge-lUzAtr/`: prior 180-second critic timeout and successful exact critic replay. Earlier schema rejection and timeout evidence remain retained; failed attempts can consume subscription quota.
- `model-toggle-ui-W7O7OU/`: passing isolated browser selector check and screenshot.
- `lodge-recipe-WkDPcS/`: earlier six-view scaffold review.

Codex limits remain five minutes per model turn, ten minutes per design, twenty minutes per alternatives request, with existing call/tool/capture/repair limits. Tokens are reported, dollar cost is null, and Gateway request/cost counters exclude Codex turns.

## Saved data and budget

Keep `.data/workspace.json` (house library), `.data/project.json` (legacy backup), `.data/connections.json` (settings/credentials), `.data/usage.json` and diagnostic runs intact. `.env`, `.data/` and personal `PROJECT_BRIEF.md` are intentionally ignored. Never replace the owner's house with a verification fixture or adopt an evaluation proposal. Model tests and browser scenarios use isolated storage. Shutdown verified workspace, legacy project and connections fingerprints unchanged from the shutdown baseline.

Earlier Gateway evaluations retain **$21.738118 spent of the authorized $22.752962**, leaving **$1.014844**. The proposed further $3 was superseded by subscription testing, not approved. Do not reset ledgers or infer another dollar approval. The private Gateway pointer is `.data/verification/live-grand-lodge-latest-ledger.json`, targeting `live-grand-lodge-2efejd/ledger.json`. Subscription tests are separate and do not erase those charges. Do not make new paid evaluations while paused.

## Possible next work, only when requested

1. Broader real-prompt reliability and architectural quality testing, especially a full Astra build. The model still makes subjective judgments and can require multiple repairs.
2. Floor-plan high-window display: `src/SceneView.tsx` projects a gable window at 7.6 m sill across a valid hall/gallery passage, making it look closed. Actual geometry has a clear 2.4 m opening; this is a display ambiguity.
3. More general room transformations, interior/rear-view coverage and smaller repeated model context if the user prioritizes them.

These are options, not queued work. The user moved focus to capabilities rather than another rendering hill climb. Use **Sol 6.1 medium** for general worker/review agents and **Astra high** for 3D work. Commit/push completed work is authorized; do not launch new top-level T3 threads unless requested.

## References

[README](README.md) covers usage; [testing backend](docs/testing-backend.md) covers Codex setup and isolation; [architecture](docs/architecture.md) and [design quality](docs/design-quality.md) cover contracts. Capability documents describe [focused editing](docs/focused-editing.md), [room transforms](docs/room-transformations.md), [precise editing](docs/precise-editing.md) and [reports](docs/design-reports.md). [Archived session history](docs/session-history.md) retains older implementation/evaluation checkpoints and charges; current instructions in this file take precedence.
