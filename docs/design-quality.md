# Planned designs and independent critique

A valid collection of rooms is not necessarily a complete answer to a design request. Terrain separates the intended program, factual checks, and render-based judgment so an ambitious new house cannot quietly become a small unfinished core.

## Plan before building

An empty-site design must call `plan_design` before changing geometry. A composition plan declares room IDs and purposes, required versus preferred spaces, a material strategy, exterior-window intent, important features, assumptions, and review views. Explicit single-room requests can use a focused plan. Existing focused edits retain the lighter editing workflow; broad compositions are guided to use a plan.

The application converts the plan into immutable request objectives. Later checklists may add detail, but cannot remove original requirements, weaken their priority, or replace their checks. Plan objectives reserve space for requirements discovered by the critic. A separate intent objective asks whether the program actually meets the original request, beyond satisfying the builder's chosen checklist.

The planner chooses a coherent scheme rather than assigning an unrelated finish to each room. It specifies dimensioned exterior windows for occupied spaces; an open wall or a door cannot stand in for glazing. Interior rooms require an explicit daylight rationale. The model still interprets natural language: the plan is not a deterministic architectural brief parser.

Construction establishes the required room layout before adding dimensioned windows. This lets the builder use final exposed-wall evidence rather than glazing a wall that a later wing will cover. Candidate batches that introduce windows while required program rooms are still missing receive planning feedback without changing the draft. Window placement uses complete rectangles from the final exposed-wall slots; standalone replacement inventories preserve semantic doorways, so those occupied regions remain unavailable. Doors and room connections can establish access during the layout phase. Composition plans choose exactly two required review views so the four-capture allowance can cover both the initial and repaired design.

## Inspect factual quality

`shared/design-quality.ts` adds evidence and assertions for:

- Room programs, targeted room IDs and minimum areas.
- Dimensioned windows on genuinely exposed exterior wall regions, including vertical neighbor occlusion.
- Exterior-wall, roof and floor palette membership and allowed palette counts.
- Fireplaces, terraces, courtyards and validated stair links.

Inspection lists exposed wall areas, window counts and areas, possible free window rectangles, resolved materials, and feature ownership. Whole-wall legacy open/glass settings are reported separately and do not count as dimensioned windows or safe empty window slots. Material inspection includes exposed roof-shaped wall caps. Outdoor floors without an explicit override use the renderer's deck default; they are not falsely reported as the house palette.

Terraces and courtyards retain the renderer's floor-only representation, including when dormant wall flags contain indoor defaults. They do not create a nominal wall obstruction or mirror indoor apertures. A raised outdoor floor slab still obstructs overlapping glazing and is subtracted from available window regions. Enclosed outdoor walls are not a supported representation.

These are conservative geometry checks. Roof slopes may cause glazing area to be undercounted or possible cladding exposure to be overcounted. They do not certify daylight, material realism, interior functionality, or architectural beauty.

## Render, critique, repair

A planned composition requests current-draft views covering its exterior and layout or interior. `critique_design` makes a separate skeptical model call with the original request, immutable plan, current inspection, preservation constraints, and eligible current-scene images. It does not receive the builder's conversation or self-assessment. Its only output tool is `submit_design_critique`; critic output cannot execute geometry operations.

The critic assesses original-request coverage and each objective, supplies specific repair targets, and identifies unsupported or visually unverified claims. Missing requirements can become additional immutable objectives. The builder then receives this feedback and chooses supported operations. Edits invalidate the critique and visual approval; the final scene needs fresh evidence and critique. Completion cannot silently hide unresolved planned requirements behind a valid geometry result. Review and finish can use `assessment: "canonical"` to reuse the application-owned planned or reviewed checklist; the application reevaluates its checks against the current draft and preserves consequential assumptions. This avoids retranscribing immutable requirements without weakening their checks or critic verdict.

With image inspection disabled, the critic receives numerical evidence only. Visual uncertainty remains explicit and may require proposal confirmation. A separate model context reduces self-approval, but uses the same configured provider/model and is not an independent architectural certification.

## Bounds and accounting

Focused runs allow twelve actual model calls. The first accepted composition plan raises the default to sixteen aggregate builder and critic calls; explicit caller limits remain strict. Both retain thirty-two tools, two geometry repair opportunities, one truncation recovery, and a five-minute timeout. Planned compositions allow four distinct captures so two initial views and two repaired views can fit; focused edits allow three. Critique uses the same cancellation, daily request accounting, usage callbacks and provider-reported cost accounting as generation. Images consume model input tokens even when locally cached. Before provider calls, older geometry-tool results omit duplicate scene, inspection and quality bodies once the authoritative snapshot is refreshed. The latest tool turn stays complete; pairing, errors, changes, checklist constraints, critic findings and image provenance remain available. A local ten-room fixture showed more than 60% fewer history characters; live token/cost savings are not yet measured.

After a mutation fails, remaining non-inspection calls authored in that same model response are deferred with explicit tool results. The builder receives the actual failure before submitting a new repair; multiple calls that repeat the same unresolved errors cannot consume multiple repair opportunities in one turn. Skipped calls remain subject to the tool limit, and each subsequent failing model round remains subject to the existing repair bound. Review, critique and finalization schema errors receive bounded path/message feedback and remain subject to model, tool and idle limits; they do not spend geometry repair opportunities. Diagnostic events retain these paths without storing raw tool arguments or model reasoning. Capture guidance lists current missing review views and requires actual retained pixels, including after a scene returns to a previous hash.

An incomplete result may be presented with explicit limitations when the run reaches its real bounds or a requirement is unsupported. A proposal remains separate from adoption, and failed/cancelled work preserves the saved house. Larger programs may still exceed a bounded run; this workflow improves the attempt and its honesty rather than promising perfect designs.

## Verification

Mocked tests cover plan gates, immutable objectives, separate critic accounting and tool isolation, evidence freshness, privacy, repair cycles and bounded completion. Geometry tests cover exposed glazing, roof-shaped cladding, free opening slots, material resolution and stair validity. Paid render verification uses isolated synthetic storage and a cumulative cost ledger; it never adopts generated houses into the owner's workspace.

The October 8 verification passed 370 tests and the production build, with independent harness and 3D geometry reviews. Real-model generation and subsequent critic-guided repairs produced nine connected spaces, two bathrooms, framed exterior windows, dining furniture and pitched wing roofs. The final critic still marked the lodge as needing work. A zero-cost recorded-response replay verified the repaired scene, fresh rendered evidence and honest partial-proposal handoff; its final finish was scripted. A fresh complete sixteen-call build has not been verified, and this evidence does not establish broad design reliability or architectural quality. All failed attempts remain included in the private cumulative $4.752962 evaluation ledger.

The subsequent owner-triggered run reached a nine-space rendered and critiqued draft but failed after review/finalization schema errors were misclassified as geometry repairs. Its 15 calls and $3.639974 remain recorded in application usage, separately from private evaluations. The new full-workflow test runner submits the exact original prompt through the application HTTP endpoint in isolated storage, with actual provider calls, local renders, critic and finish. It records all settled or unknown costs, full private scrubbed responses and scene checkpoints for replay; it distinguishes meaningful completion from an honest partial proposal. The added paid-test budget must be approved before running it. A scripted finish or recorded-response replay is not a fresh live success.
