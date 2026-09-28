# Harness verification — September 28, 2026

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

Real microphone permissions/noise quality, arbitrary architectural forms, and construction/code correctness were not evaluated. Viewport images are optional input; there is no automated rendered-image critique loop. MCP remains an architectural extension point, with no server exposed.
