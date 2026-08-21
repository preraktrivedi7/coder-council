# Architecture

Council owns orchestration and project/run state. Provider runtimes own credentials,
transport, subscription entitlement, and provider-specific model discovery.

```text
VS Code Activity Bar (optional)
└── allowlisted, shell-free process adapter
    └── CLI
        ├── configuration and routing
        ├── immutable TaskPacket/context builder
        ├── workflow runtime (max two concurrent calls)
        ├── run/state/evaluation stores
        ├── safety, redaction, spending, and git gates
        └── model seats
            ├── OpenCode loopback API -> OpenCode CLI fallback
            ├── official Codex CLI fallback for the OpenAI seat
            ├── guarded OpenRouter API
            └── local Ollama API
```

The VS Code extension does not duplicate Council orchestration. It resolves the CLI,
passes bounded JSON operations for the selected workspace, renders results, and
manages one child process. Workspace trust, a strict webview CSP, a fixed operation
allowlist, build/provider-use confirmations, and output/input limits form the UI
boundary. The CLI remains authoritative and retains its cross-process build lock.

## Council workflow

1. Create and hash one immutable TaskPacket.
2. Send the same controlled packet to primary and challenger concurrently. Neither
   request contains the other candidate or shares its session.
3. Compare recommendations, assumptions, risks, unknowns, and verification needs.
4. If disagreement or unique risk evidence is material, run both read-only critiques
   concurrently and then both revisions concurrently.
5. Optionally query an available free/local arbiter when call budget remains.
6. Synthesize by evidence while retaining unresolved disagreement.
7. Persist executed stages, actual resolved provider/model identities, billing mode,
   reported usage values, isolation assertions, and final output.

Unknown token, cost, and credit fields remain `null`. Structured output is retried
once with validation feedback; there is no unbounded loop.

## State

`council init` creates:

```text
.council/
├── config.jsonc
├── project.md
├── state.json
├── decisions.md
├── assumptions.md
├── open-questions.md
├── runs/
├── artifacts/
├── evaluations/
└── logs/
```

Writes use same-directory temporary files and atomic rename. Each run starts as
`running` and ends as `complete`, `failed`, or `abandoned`. `council runs abandon`
can safely close a stale run. `--no-store` uses the same workflow without creating a
run directory.

## Repository workflows

`plan` stores an artifact and does not edit source. `review` captures the diff,
forces seats read-only, deduplicates findings, and verifies the source fingerprint
did not change. `build` takes an exclusive `.council/build.lock`, allows one writer,
runs configured verification commands, uses read-only reviewers, and applies any
accepted follow-up through the same writer sequentially. Verification strings run
through Node's OS-native shell selection so the workflow behaves consistently on
macOS, Linux, and Windows; destructive and publishing commands remain denied.
