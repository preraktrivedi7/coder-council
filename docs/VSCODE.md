# Coder Council for VS Code

Coder Council for VS Code is a Codex-compatible coding workspace plus a thin client for
the Coder Council CLI. Codex App Server owns Codex authentication, thread history,
models, skills, approvals, and streamed coding events. The Coder Council CLI remains the
source of truth for independent-candidate orchestration, safety policy, provider
configuration, run artifacts, and the one-writer build lock.

## Install a local build

Requirements are VS Code 1.95+, Node.js 20+, Coder Council, and the official Codex CLI.
Authenticate Codex with `codex login` before opening the extension.

```bash
npm install
npm link
npm --prefix extensions/vscode install
npm run check:vscode
npm run test:vscode
npm run package:vscode
code --install-extension artifacts/coder-council-vscode-0.3.0.vsix
```

If the `code` launcher is unavailable, use **Extensions: Install from VSIX…** and
select `artifacts/coder-council-vscode-0.3.0.vsix`. Reload VS Code, open a project, then
select the Coder Council icon and **Open coding workspace**.

The packaged VSIX is a local build artifact and is intentionally git-ignored.

## Coding workspace

The editor panel provides:

- Codex thread navigation, search, workspace/all-history scope, and new threads.
- Direct reading and resumption of Codex history. Nothing is exported, copied, or
  re-serialized into `.council/`; the extension reads the existing Codex store via
  App Server. Threads belonging to another folder remain view-only until that
  folder is opened.
- Streamed agent messages, plans, command output, file changes, turn diffs, status,
  cancellation, and VS Code-native command/file approval dialogs.
- Code mode with workspace-write sandboxing and on-request approvals.
- Plan, Ask, and Review modes with read-only sandboxing.
- Council mode, which sends the task through Council's independent candidate and
  synthesis workflow rather than a single Codex thread turn.
- Optional bounded active-editor/selection context. Editor content is marked as
  untrusted context before it is sent to Codex.
- Codex model and reasoning-effort selection from the installed CLI's live model
  catalog.

The Activity Bar view is intentionally compact: it lists recent project threads,
provider status, and launch/setup actions. The full conversation UI opens as a
normal editor tab—not a narrow split—so it has enough room for coding, tools, and
diffs.

## Model and provider setup

Open **Setup** in the coding workspace. It covers:

- Codex/ChatGPT login and App Server connection.
- Ollama server startup, model pull, and one-step Council seat enablement.
- OpenRouter environment preparation and one-step `openrouter/free` enablement.
- A one-click free-first pool that enables OpenRouter free plus local Ollama and
  forces paid fallback off.
- Optional OpenCode authentication.
- Council init, doctor, models, runs, stats, config validation, and config file.

Non-secret install/login commands are prepared in an integrated terminal but are
never run silently. OpenRouter is the exception: exporting a key inside VS Code
cannot update the already-running extension host. Fully quit VS Code, export
`OPENROUTER_API_KEY` in an external terminal, then launch VS Code from that same
terminal. **Reload Window** is insufficient because it reuses the parent process
environment. The extension never asks for or stores provider tokens; direct
provider keys remain in the launching process environment. `config seat` changes
only the optional seat's `enabled` and `model` fields, preserves JSONC comments,
validates the entire resulting configuration, and rejects non-free OpenRouter
routes.

Equivalent CLI setup is:

```bash
council config free-first
council config seat ollama enable qwen3-coder:30b
council config seat openrouterFree enable openrouter/free
council config validate
council doctor
```

The Ollama model name is an example; use a model that is installed and appropriate
for the machine. `free-first` uses `auto`, so Ollama selects the first installed
model at run time. When both free paths are healthy, automatic Council routing uses
OpenRouter free as challenger and Ollama as a different arbiter instead of spending
both roles on the same provider.

## Executable discovery

For Council operations, the adapter resolves:

1. `council.commandPath`, when configured.
2. `<workspace>/bin/council.js`.
3. This repository's `bin/council.js` in an Extension Development Host.
4. `council` on the extension host's `PATH`.

JavaScript files run through `council.nodePath`. Codex App Server runs through
`council.codexPath` (default `codex`). The default also discovers the official
standalone install at `~/.local/bin/codex` and common Homebrew locations, which
avoids macOS GUI `PATH` differences. No command uses a shell. For SSH, containers,
WSL, or Codespaces, install Council, Codex, and the workspace extension in the
remote environment.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `council.commandPath` | empty | Optional Council executable or `bin/council.js`. |
| `council.codexPath` | `codex` | Codex CLI used for local App Server. |
| `council.nodePath` | `node` | Node executable for JavaScript CLI paths. |
| `council.defaultMode` | `code` | Initial compose mode. |
| `council.timeoutSeconds` | `600` | Council CLI timeout, from 1 to 3600 seconds. |
| `council.confirmBuild` | `true` | Reserved confirmation policy for Council builds. |
| `council.maxOutputBytes` | `4194304` | Per-stream retained-output ceiling. |

Executable-path settings are restricted in untrusted workspaces. Restricted Mode
renders the UI but starts neither Codex nor Council.

## Security and data boundaries

- Codex App Server uses stdio JSONL. The extension does not open a TCP listener.
- The App Server process is spawned directly as `codex app-server`; Council CLI
  operations use fixed argument arrays and a positional delimiter.
- Webviews use extension-local resources, a nonce, and a strict Content Security
  Policy. Dynamic provider and model output is assigned with `textContent`, never
  inserted as HTML.
- Prompt input is capped at 64 KiB, selected editor content at 32 KiB, App Server
  messages at 8 MiB, and Council output at its configured byte ceiling.
- Private reasoning content is discarded at the extension-host boundary. Only the
  concise reasoning summary exposed by Codex is eligible for display.
- No OAuth/access/refresh token is stored in VS Code settings, extension state, or
  `.council/`. The only persisted extension value is the selected Codex thread ID.
- Cross-workspace threads are readable but cannot execute until their workspace is
  open and trusted.

## Troubleshooting

- `Unable to start Codex App Server`: verify `command -v codex`, run
  `codex login status`, or set `council.codexPath` to the absolute executable.
- `Unable to start Council`: run `npm link`, restart VS Code, or set
  `council.commandPath`.
- Restricted Mode: review the workspace, then use **Manage trust**.
- Ollama unavailable: install Ollama, prepare `ollama serve`, pull a model, enable
  that exact model in Setup, then rerun Doctor.
- OpenRouter remains unavailable after `export`: an integrated terminal cannot
  update its parent extension host. Fully quit VS Code, export the key in an
  external terminal, launch VS Code from that terminal, then rerun Doctor. Never
  paste the key into chat, `.council/`, or VS Code settings.
- An imported thread is view-only: open its folder in VS Code before sending a new
  turn.
- Remote workspace cannot see local tools: install/link both CLIs in the remote
  extension host rather than pointing at local paths.
