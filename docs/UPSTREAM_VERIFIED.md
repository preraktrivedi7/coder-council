# Upstream integrations verified — 2026-08-21

This records integration research, not immutable product constants. Coder Council resolves
models dynamically where practical and stores the model actually used in each run.

## Visual Studio Code extension API

- The extension targets VS Code `^1.95.0` and uses a custom Activity Bar view
  contributed with `viewsContainers.activitybar` and a webview view registered via
  `registerWebviewViewProvider`.
- Current extension guidance requires webview scripts to communicate through JSON
  message passing. Council uses local resource URIs, `webview.cspSource`, and a
  per-render script nonce under `default-src 'none'`.
- Workspace Trust supports `limited` untrusted-workspace capability declarations
  and restricted settings. Council displays its UI in Restricted Mode but refuses
  every CLI execution until the workspace is trusted.
- Disposables are registered on `ExtensionContext.subscriptions`; the adapter does
  not persist credentials in extension storage or `SecretStorage`.
- Packaging tooling was pinned during this build to `@vscode/vsce 3.9.2`; VS Code
  API metadata was pinned to `@types/vscode 1.95.0` to match the declared minimum.

Checked:

- https://code.visualstudio.com/api/references/contribution-points
- https://code.visualstudio.com/api/extension-guides/webview
- https://code.visualstudio.com/api/extension-capabilities/workspace-trust
- https://code.visualstudio.com/api/references/vscode-api
- https://www.npmjs.com/package/@vscode/vsce
- https://www.npmjs.com/package/@types/vscode

## OpenCode

- npm `opencode-ai`: `1.18.21` (`latest` on 2026-08-21).
- npm `@opencode-ai/sdk`: `1.18.21` (`latest` on 2026-08-21).
- The current server API documents `opencode serve`, default host `127.0.0.1`,
  default port `4096`, `GET /global/health`, provider enumeration, session creation,
  synchronous prompt execution, abort, and OpenAPI documentation at `/doc`.
- The current SDK documents `createOpencode`, `createOpencodeClient`, session
  prompting, structured JSON-schema output, cancellation, and provider discovery.
- Current provider documentation supports ChatGPT Plus/Pro authentication by
  running OpenCode, choosing `/connect`, selecting OpenAI, and choosing
  `ChatGPT Plus/Pro`. Provider credentials stay in OpenCode's auth store.
- Council therefore uses the OpenCode loopback server API as its programmatic
  path and a non-interactive OpenCode CLI adapter as a bounded fallback. It does
  not read or copy the OpenCode auth store.

Checked:

- https://dev.opencode.ai/docs/providers
- https://dev.opencode.ai/docs/server/
- https://dev.opencode.ai/docs/sdk/
- https://www.npmjs.com/package/opencode-ai
- https://www.npmjs.com/package/@opencode-ai/sdk

## Official Codex

- Installed `codex-cli 0.149.0` was checked locally.
- `codex login status` reports `Logged in using ChatGPT`.
- `codex exec` remains an explicit fallback/sanity-check path; Council does not
  inspect Codex credentials or require an OpenAI API key when ChatGPT auth works.
- Official App Server guidance identifies `codex app-server` as the interface for
  rich clients such as the Codex VS Code extension, including authentication,
  conversation history, approvals, and streamed agent events.
- The extension uses stable stdio JSONL, performs the required
  `initialize`/`initialized` handshake, and uses `thread/list`, `thread/read`,
  `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `model/list`,
  and `skills/list` from the locally generated 0.149.0 schema.
- A no-inference local probe on 2026-08-21 returned six models, one matching
  workspace thread, and one skills group. The generated schema remained temporary
  evidence and was not bundled into the extension.

Checked:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/codex/ide
- local `codex app-server generate-json-schema --experimental`

## Public setup and distribution

- Community Edition `0.3.1` keeps the CLI, VS Code extension, and Council
  orchestration free and open source; provider subscriptions and quotas remain
  provider-owned.
- Public setup exposes `coder-council setup` and retains `council` as a compatibility
  alias. The command initializes local state, enables only free/local optional seats,
  probes provider health without inference, and keeps paid fallback and telemetry off.
- The public installer builds the VS Code extension from the same source before
  installing it. No downloaded executable or provider credential is bundled in the
  repository.
- Release CI runs on Ubuntu, macOS, and Windows with Node 20 and 22. The hosted
  matrix verifies portable prompt paths, workspace attachment paths, test discovery,
  and OS-native build verification before release artifacts are published.
- A live no-store Council smoke test completed with authenticated Codex and a local
  Ollama challenger, including isolated candidates, cross-critique, revision, and
  synthesis. Paid inference remained disabled and the run did not degrade.

## Kimi For Coding (optional)

- Community plugin `opencode-kimi-full` latest npm/release version: `1.4.0`.
- Release: `v1.4.0`, published 2026-05-09; MIT license.
- Declared requirement: OpenCode `>=1.4.6`.
- Current documented install/login commands:
  `opencode plugin opencode-kimi-full@1.4.0 --global` and
  `opencode auth login -p kimi-for-coding-oauth`.
- Provider/model target remains
  `kimi-for-coding-oauth/kimi-for-coding`; discovery maps that stable alias to
  the account's current wire model.
- Open issues include questions about newer-model support and provider-account
  enforcement. Council keeps Kimi disabled by default and treats live use as
  optional until the user completes provider-owned setup.

Checked:

- https://github.com/lemon07r/opencode-kimi-full
- https://github.com/lemon07r/opencode-kimi-full/releases/tag/v1.4.0
- https://www.npmjs.com/package/opencode-kimi-full

## OpenRouter

- The official free router is currently `openrouter/free`.
- It dynamically selects among currently available free models that satisfy the
  request's required capabilities; the actual resolved model is returned in the
  response and recorded by Council.
- Explicit model variants ending in `:free` are treated as free candidates.
- Council still enforces its own deny-by-default guard and rejects every other
  route while `allowPaidInference=false` or `openRouterFreeOnly=true`.
- A provider-reported nonzero cost on a supposedly free response trips a circuit
  breaker for further automatic free-pool calls.

Checked:

- https://openrouter.ai/openrouter/free
- https://openrouter.ai/docs/guides/routing/routers/free-router
- https://openrouter.ai/docs/faq
- https://openrouter.ai/docs/api/reference/overview

## Ollama

- Ollama's local API remains available by default at `127.0.0.1:11434` and
  exposes OpenAI-compatible endpoints under `/v1`.
- Council probes availability and does not require Ollama for baseline use.

Checked:

- https://docs.ollama.com/quickstart
- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/api/introduction
