# Cost and usage model

Council distinguishes billing mode from incomplete usage telemetry:

- `chatgpt-plan`: subscription-backed OpenAI/Codex use
- `kimi-subscription`: optional Kimi For Coding entitlement
- `free`: an explicitly free provider route
- `local`: local compute such as Ollama
- `api`: explicit API billing
- `unknown`: provider did not expose enough information

The default policy is:

```json
{
  "allowPaidInference": false,
  "openRouterFreeOnly": true
}
```

Subscription access is not treated as generic API credit. Missing input/output
tokens, cached tokens, cost, or credits are stored and displayed as `null`; Council
never estimates them as zero. `council stats` aggregates only provider-reported
values and shows median/p95 call latency.

OpenRouter is guarded twice: route validation happens before each request, and a
nonzero cost reported for a free route stops further automatic free-pool calls from
that seat instance.

