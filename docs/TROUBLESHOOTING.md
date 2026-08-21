# Troubleshooting

Start with:

```bash
council doctor
council config validate
council models
```

## OpenAI seat unavailable

Install and authenticate either current OpenCode or the official Codex CLI. For
OpenCode, use `/connect` -> OpenAI -> ChatGPT Plus/Pro. For Codex, run `codex login`
and verify `codex login status`. Council does not inspect either credential store.

## OpenCode server unavailable

Council first probes `http://127.0.0.1:4096/global/health`, then uses the OpenCode
non-interactive CLI fallback. Run `opencode serve --hostname 127.0.0.1 --port 4096`
if you want the programmatic server path.

## Kimi reports unknown provider

The community plugin is not loaded. Review [AUTH.md](AUTH.md), install the pinned
plugin globally, complete `opencode auth login -p kimi-for-coding-oauth`, and add its
documented provider block. Leaving Kimi disabled is always supported.

## OpenRouter request refused

Check that the model is exactly `openrouter/free` or ends in `:free`, and that
`OPENROUTER_API_KEY` exists in the process environment. Council will not fall back
to a paid route. A reported nonzero cost trips the free-seat breaker for the current
process; inspect provider configuration before retrying.

## Ollama not running or has no models

Start Ollama and pull a model. The default endpoint is
`http://127.0.0.1:11434`. An absent local server does not affect OpenAI-only mode.

## Incomplete run after interruption

```bash
council runs list
council runs abandon <run-id>
```

The abandon command changes only the matching running record; it does not delete
artifacts.

## Build says another writer is active

Another Council build owns `.council/build.lock`. Wait for it to finish. If a process
crashed, confirm no Council build process remains before manually removing only that
specific lock file. Council never removes an active lock on assumption.

