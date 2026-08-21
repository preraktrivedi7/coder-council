# Security model

Council assumes repository files and model output can be hostile. Instructions from
either source never override local safety, credential, spending, or git policy.

## Assets and trust boundaries

- Provider credentials and subscription entitlements belong to provider runtimes.
- Project decisions, prompts/responses (when enabled), evaluations, and run metadata
  live under `.council/`.
- The boundary between Council and OpenCode/Codex/OpenRouter/Ollama is untrusted I/O.
- The repository working tree is both user data and untrusted model context.

## Main threats and controls

- **Prompt injection in repository files:** task-specific excerpts only; repository
  instructions cannot enable paid inference, public binding, credential access, or
  destructive git/shell behavior.
- **Candidate contamination:** candidates use separate calls/sessions and receive
  the same TaskPacket hash before either result exists. Isolation assertions are
  stored and tested.
- **Credential disclosure:** no raw environment dump; credential-shaped keys/values
  are redacted recursively; `.env` and common key files are ignored; provider auth
  stores are not read or copied.
- **Unexpected billing:** paid inference defaults off; OpenRouter permits only
  `openrouter/free` or `:free`; nonzero reported free-route cost trips a breaker.
- **Concurrent or destructive edits:** reviewer/challenger/arbiter seats are
  read-only; builds use an exclusive writer lock; reset, clean, commit, and push are
  never invoked automatically; destructive verification commands are rejected.
- **Public service exposure:** the validated runtime host is loopback-only by
  default; `0.0.0.0` is refused.
- **Unbounded work:** calls, concurrent calls, structured retries, and time are
  bounded. Ctrl+C propagates cancellation to child/provider work and marks the run
  abandoned.
- **Private reasoning collection:** prompts ask only for concise reasons,
  assumptions, risks, evidence, and verification. Hidden chain-of-thought is not
  requested or stored.

## Persistence controls

Set `privacy.storePrompts` or `privacy.storeResponses` to `false` to retain run
metadata while replacing the respective persisted content with `[not stored]` or a
storage-disabled marker. Telemetry is fixed off by the validated default config.

Run `npm run check:secrets` before sharing changes. It is a defense-in-depth scan,
not a substitute for provider-side secret revocation.

