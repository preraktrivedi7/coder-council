# Provider authentication

Council delegates authentication to provider-owned tooling. It never asks you to
paste OAuth access/refresh tokens and never reads provider auth stores.

## OpenAI / ChatGPT subscription

Preferred OpenCode path, verified 2026-08-21:

1. Install current OpenCode.
2. Run OpenCode and use `/connect`.
3. Select `OpenAI`, then `ChatGPT Plus/Pro`.
4. Complete browser authentication.
5. Run `council doctor` and `council models`.

The equivalent delegated CLI hint is:

```bash
council auth openai
```

When OpenCode is not installed, Council can use the official Codex CLI. Authenticate
it with `codex login`; `codex login status` should report ChatGPT authentication.
Council does not silently replace subscription-backed use with paid API billing.

## Kimi For Coding (optional)

The currently verified community integration is `opencode-kimi-full@1.4.0` (MIT).
Review its code and current issues before installation because it is third-party
software.

```bash
opencode plugin opencode-kimi-full@1.4.0 --global
opencode auth login -p kimi-for-coding-oauth
```

Complete the device approval, add the provider block documented by the plugin, and
use the stable target `kimi-for-coding-oauth/kimi-for-coding`. Then enable the Kimi
seat in `.council/config.jsonc` and run:

```bash
council auth kimi
council doctor
council models
```

Tokens remain in OpenCode's auth store. Council remains fully functional if Kimi is
not installed, not authenticated, rate-limited, or later removed.

## OpenRouter free routes (optional)

Create a key in OpenRouter and expose it only in the process environment:

```bash
export OPENROUTER_API_KEY="..."
```

Enable `seats.openrouterFree` and keep the model as `openrouter/free` or an explicit
model ending in `:free`. With the default spending policy, any other route is
rejected before a request. A nonzero provider-reported cost on a supposedly free
response trips the seat circuit breaker.

The VS Code extension host must inherit `OPENROUTER_API_KEY`. Fully quit VS Code,
export it in an external terminal, then launch VS Code from that same terminal.
Exporting from VS Code's integrated terminal or using **Reload Window** cannot
update the parent process environment. Council does not copy the key into
`.council/`, extension state, or VS Code settings.

## Ollama (optional)

Run Ollama locally, pull at least one model, and enable `seats.ollama`. Override the
loopback endpoint only when required:

```bash
export OLLAMA_BASE_URL=http://127.0.0.1:11434
```

Council probes `/api/tags` and uses the OpenAI-compatible `/v1/chat/completions`
endpoint. An absent server is a normal `NOT RUNNING` doctor result.

## Free-first pool

After `council init`, enable every currently supported zero-cost path together:

```bash
council config free-first
council doctor
```

This selects OpenRouter's dynamic `openrouter/free` route and Ollama `auto`, forces
paid inference off, and skips either seat when it is unavailable. If both are
healthy, automatic Council runs keep them in different challenger/arbiter roles.
Provider rate limits and availability remain provider-owned and may change.
