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
