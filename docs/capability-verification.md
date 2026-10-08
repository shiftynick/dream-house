# Isolated live capability verification

Default invocation is a dry run and loads no credentials, opens no browser, and sends no requests:

```sh
npx tsx scripts/verify-capabilities.ts
```

For an authorized small real-model sample, use the configured gateway and open the loopback URL printed by the script in a local browser:

```sh
npx tsx scripts/verify-capabilities.ts --live --case=all
```

`--case=floor` and `--case=shared-wall` run one case. The script reads only connection settings from `TERRAIN_DATA_DIR` (default `.data`) and environment settings. It never reads the saved house. Credential values stay in process memory and are never copied to the isolated server or results. HTTP and HMR websocket traffic use one private ephemeral loopback server; shutdown closes lingering browser polls. The browser server uses temporary synthetic storage under `.data/verification/capabilities-*`; its model and audio adapters cannot call providers. Agent runs use synthetic scenes directly and never adopt their result. The browser renderer supplies real local viewport images to the default gateway model adapter; final structured visual review must reference delivered captures.

The floor case tests exact selected floor editing while preserving accent wall, roof and other rooms. The shared-wall case tests a one-metre transfer, room identities, exact exterior extents and unrelated data. Independent exact assertions run after the model's typed checklist and visual observations. This is two examples, not a statistical quality claim; passing model observations remain judgments about the captures.

Each case allows five model calls, one repair and four minutes. Requests run sequentially, with no retries, an aggregate ten-call cap, a $0.50 reservation before each call, and a $5 provider-reported cost stop. Unknown cost, transport failure, unresolved objective/visual review or exceeded reported budget stops the run. **Provider charges arrive after a request: reservations and reported-cost stops cannot guarantee a hard billing cap.** Set a provider-side spending limit if a hard $5 billing ceiling is required. No call starts while an earlier request's cost is unknown.

The private ledger records model name, call count and provider-reported charge. Case JSON is written before objective assertions (and marked passing only afterward), so failed checks retain the returned model behavior. Case JSON records synthetic scene, objective outcome, checklist, observations, capture provenance and aggregate metrics, without pixels embedded in JSON or raw model turns. At most three local capture image files per case are retained separately for visual inspection, each bounded to a one-million-character data URL before decoding. Failed runs retain the ledger, returned case evidence and a sanitized failure phase/message; upstream provider details are omitted. To continue an explicitly authorized evaluation without resetting its aggregate budget, pass its prior ledger:

```sh
npx tsx scripts/verify-capabilities.ts --live --case=shared-wall --prior-ledger=.data/verification/capabilities-EtYrsC/ledger.json
```

The imported ledger must contain known, settled, nonnegative charges and an exact total with the same $5 limit, $0.50 reservation and ten-call cap. Its charges and calls count against the continued run; six prior calls leave at most four model calls. The new ledger includes all prior entries and its source path. Without this flag a new invocation starts a fresh ledger, so do not restart an evaluation without explicitly carrying and accounting for its prior charges. Evaluation usage is separate from application usage; use the ledger to account for real spending. Close the evaluation tab after completion.

## October 8, 2026 sample

The configured `anthropic/claude-sonnet-5.5` completed the selected-floor case in two calls ($0.129996), passing exact selected-surface and unrelated-data assertions plus a matching Live interior review. The first shared-wall attempt used four calls ($0.262908): exact geometry passed, but the model correctly reported its final visual review as unverified after the harness retired pixels during an intermediate checklist round. That failed result is retained.

The harness now keeps current-draft pixels through review and finish, retires stale captures, and invalidates approval after edits. A return to an earlier scene can reuse its local capture but must receive the image again before finishing. The shared-wall rerun also uses a visible partition with a stable semantic passage, so its cutaway tests the physical boundary. It passed exact dimensions, exterior extents, identities, connection/material preservation, unrelated-study preservation and structured visual review in three calls ($0.201560). Root inspected both successful cases' local images.

The cumulative ledger totals **nine settled calls and $0.594464** of the $5 reported-cost stop. Both final objectives pass, with the initial failed sample disclosed. These examples do not establish general model reliability. The final ledger and synthetic evidence remain private under `.data/verification/capabilities-NFKAX6`; no house adoption, audio call or production project write was performed.
