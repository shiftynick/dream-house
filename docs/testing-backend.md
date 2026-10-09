# Local subscription testing

Terrain can run its architectural builder and independent image critic through headless Codex CLI. This is a local backend; the browser still calls Terrain's loopback HTTP API. Install Codex and sign in with `codex login` using ChatGPT before starting the server.

```dotenv
DESIGN_BACKEND=codex-cli
CODEX_MODEL=gpt-6.1-sol
VOICE_ENABLED=false
```

`CODEX_BINARY` optionally selects the executable. The adapter currently supports exactly Sol 6.1 with medium reasoning. Switching providers requires a server restart. `DESIGN_BACKEND=gateway` restores the API backend; it preserves its separately saved credentials and model choices. The Codex backend requires ChatGPT authentication and never falls back to Gateway after an error. Subscription quota and model availability remain governed by the signed-in account.

Each model turn starts an ephemeral CLI process in a private temporary directory. Text/tool history is sent on stdin; requested PNG/JPEG render images are attached in their original order. A phase-specific structured output schema describes Terrain commands and the critic's immutable objective manifest. Returned commands pass the original runtime validators before Terrain executes them. The builder and critic retain separate conversations, current-scene image requirements, bounded repair and honest partial-result rules.

The subprocess environment excludes application/provider keys. Native shell, patch, web, browser, apps, MCP, skills and agent capabilities are disabled. Unexpected native events, malformed responses, unknown errors, timeouts and cancellation fail closed; the process group and temporary files are cleaned up. Codex model turns have a five-minute limit; complete designs have ten minutes and generated alternatives twenty minutes. Cancellation still stops the process immediately, and model/capture/tool call limits remain unchanged. Gateway keeps its existing shorter time limits. CLI login status is checked with a bounded cached probe. Status confirms saved login, not available quota or successful model access.

Usage contains reported input/output tokens and a null dollar cost, displayed as **Subscription quota**. Codex turns do not spend the Gateway daily request cap or modify Gateway dollar counters. They still count toward the design loop's model-call limits. A failed provider attempt can consume quota even when no design is saved.

Voice defaults off for testing. Browser microphone/hold-to-talk controls and speech playback are disabled; both audio endpoints reject calls before invoking a provider. `VOICE_ENABLED=true` restores optional Gateway audio and browser speech. Existing voice settings remain saved.

## Verification

Mocked subprocess tests cover authentication selection, environment isolation, native-event rejection (including a trailing event without a newline), exact known disabled-host diagnostic handling, schema/runtime constraints, ordered images, cancellation and cleanup. HTTP tests cover selected backend routing, unavailable-login behavior, preserved Gateway settings/counters, unchanged saved houses and disabled audio.

Real subscription evidence is retained privately under `.data/verification/`. These tests use separate project storage and actual local browser renders. They must not replace an owner's saved house. A successful adapter call alone does not prove a complete architectural design; full workflow outcomes are recorded separately in the handoff.
