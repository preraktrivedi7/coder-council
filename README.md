<div align="center">
  <img src="docs/assets/coder-council-hero.svg" alt="Coder Council — your AI coding team" width="920">

  <h3>Your AI coding team, inside VS Code and the terminal.</h3>
  <p>Code with Codex. Add free cloud and private local models for independent review.</p>

  <p>
    <a href="https://github.com/preraktrivedi7/coder-council/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/preraktrivedi7/coder-council/actions/workflows/ci.yml/badge.svg"></a>
    <a href="https://github.com/preraktrivedi7/coder-council/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/preraktrivedi7/coder-council?color=6d5dfc"></a>
    <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-6d5dfc"></a>
    <img alt="Node 20+" src="https://img.shields.io/badge/node-20%2B-43853d">
    <img alt="paid inference off by default" src="https://img.shields.io/badge/paid%20inference-off%20by%20default-1f9d72">
  </p>

  <p><strong>Community Edition · Free and open source</strong></p>
</div>

Coder Council is an AI coding agent workspace for VS Code and the terminal. Use
familiar chat, planning, code edits, diffs, commands, approvals, and Codex history.
For important decisions, switch to **Council**: independent models answer in
isolation, challenge each other, revise, and produce one evidence-backed result.

Your existing Codex login can be the primary seat. Optional OpenRouter free routes
and local Ollama models expand the team without enabling paid per-token fallback.

## Install in one command

Run this from the project you want to work on:

```bash
curl -fsSL https://raw.githubusercontent.com/preraktrivedi7/coder-council/main/install.sh | sh
```

Then open the project in VS Code, select the **Coder Council** icon, and choose
**Open coding workspace**.

The installer checks Node.js, downloads Coder Council, verifies and installs the
VS Code extension when the `code` launcher is available, initializes the current
project, and enables safe free/local routes. It never asks for or stores provider
keys.

Requirements: Node.js 20+, Git, and macOS or Linux for the one-line installer.
The VS Code workspace needs VS Code 1.95+ and the official Codex CLI. Missing tools
produce setup instructions instead of silent fallback.

<details>
<summary><strong>Manual setup and Windows</strong></summary>

```bash
git clone https://github.com/preraktrivedi7/coder-council.git
cd coder-council
npm install
npm link
coder-council setup
```

On Windows, run those commands in PowerShell, download the `.vsix` from the
[latest release](https://github.com/preraktrivedi7/coder-council/releases/latest),
and choose **Extensions: Install from VSIX...** in VS Code.
</details>

## See the Council logic

```bash
coder-council council "Should this Node.js config writer use direct writes or atomic replacement?"
```

```text
Same task + same project evidence
        │
        ├── Codex primary ─────────┐  answers independently
        └── Ollama challenger ─────┘
                                   ↓
                         compare disagreements
                                   ↓
                         cross-critique + revise
                                   ↓
                         verified synthesis
```

In a live Community Edition smoke test, Codex and local
`qwen2.5-coder:7b` agreed on atomic replacement, then strengthened the result
through critique: exclusive temporary-file creation, restrictive permissions,
failure cleanup, crash durability, concurrent-writer behavior, and a concrete
fault-injection test plan. The run completed without degraded mode or paid
inference.

Tests and reproducible evidence outrank model votes. The initial candidates cannot
see each other, and exactly one implementation agent may write to a working tree.

## One workspace, five modes

| Mode | Best for | Access |
| --- | --- | --- |
| **Code** | Implementing, debugging, commands, and file edits | Write with approvals |
| **Plan** | Exploring a codebase and designing a change | Read-only |
| **Ask** | Understanding code, errors, and tradeoffs | Read-only |
| **Review** | Finding bugs and regressions in the working tree | Read-only |
| **Council** | Independent solutions, critique, and synthesis | Read-only orchestration |

The VS Code workspace includes searchable and resumable Codex threads, streamed
messages and tool activity, editor context, Markdown and code rendering, diffs,
approval controls, model and reasoning settings, stop controls, provider health,
and guided setup.

## Use more free AI

Coder Council combines the inference paths you already have. It does not rotate
accounts, bypass quotas, or silently switch to a paid model.

| Provider | Role | Cost behavior |
| --- | --- | --- |
| **Codex CLI** | Primary coding, history, tools, diffs, approvals | Uses your authenticated Codex access |
| **OpenRouter** | Optional pool of free cloud models | Free routes only; paid routes are rejected |
| **Ollama** | Optional private local challengers and reviewers | No per-token provider charge |
| **OpenCode** | Optional additional runtime | Uses its own provider configuration |

### OpenRouter free routes

Export the key in the external terminal that launches VS Code:

```bash
export OPENROUTER_API_KEY="..."
code .
```

If VS Code is open, quit it fully first. Reloading a window does not add a new
environment variable to the extension host. Free-only mode accepts only
`openrouter/free` or explicit `:free` model IDs.

### Local models with Ollama

```bash
ollama pull qwen2.5-coder:7b
coder-council config seat ollama enable qwen2.5-coder:7b
coder-council doctor
```

Use any Ollama coding model that fits your machine. Automatic routing tries to put
challenger and synthesis roles on different healthy seats. Unavailable optional
seats are skipped; they never trigger paid fallback.

See [provider setup](docs/AUTH.md) and [troubleshooting](docs/TROUBLESHOOTING.md).

## Codex continuity, through supported interfaces

Coder Council connects to the official
[Codex App Server](https://learn.chatgpt.com/docs/app-server) for authentication,
thread history, models, skills, approvals, and streamed coding events. It resumes
visible Codex threads without reading browser cookies, copying OAuth tokens, or
importing private reasoning into `.council/`.

Provider authentication remains owned by each provider or runtime. Your project
stores only the redacted run evidence and local configuration you choose to keep.

## Terminal commands

```bash
coder-council ask "Where is authentication handled?"
coder-council council "Choose the safest migration strategy"
coder-council plan "Add passkey login"
coder-council review
coder-council build "Implement the approved plan"
coder-council stats
```

`council` is a shorter alias. Project state lives in `.council/`. Use `--json` for
machine-readable output, `--dry-run` to inspect a run without provider calls or
state mutation, and `--no-store` to keep a run ephemeral.

## Free and safe by default

- The CLI, VS Code extension, and multi-model orchestration are Apache-2.0 licensed.
- Provider credentials stay in provider-owned tools or the process environment.
- Paid inference and telemetry are disabled.
- OpenRouter paid routes are rejected in free-only mode.
- Local services bind to `127.0.0.1`.
- Private chain-of-thought is neither requested nor persisted.
- VS Code requires workspace trust before running local tools.
- Automatic reset, clean, commit, and push are unsupported.
- Normal tests make no provider calls.

Read the [security policy](SECURITY.md), [security model](docs/SECURITY.md), and
[architecture](docs/ARCHITECTURE.md) for the exact boundaries.

## Build it with us

```bash
npm install
npm --prefix extensions/vscode install
npm test
npm run test:acceptance
npm run test:vscode
npm run check:vscode
npm run check:secrets
npm run check:public
npm run package:vscode
```

Live provider smoke tests are explicit opt-ins because they can use configured
subscriptions or provider quotas. Small, test-backed pull requests are welcome.
Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](docs/ROADMAP.md).

## FAQ

<details>
<summary><strong>Is Coder Council really free?</strong></summary>

The Community Edition is free and open source. Ollama runs locally, and OpenRouter
is locked to free routes. Codex and other provider access depend on the accounts or
subscriptions you already have. Unknown usage and cost values remain unknown.
</details>

<details>
<summary><strong>Does it replace Codex?</strong></summary>

No. Codex is the primary coding runtime. Coder Council adds the VS Code workspace,
free/local model seats, and a structured second-opinion workflow around it.
</details>

<details>
<summary><strong>Does it transfer my Codex history?</strong></summary>

It displays and resumes visible threads through Codex App Server. It does not copy
Codex credentials, browser data, or private thread databases into your project.
</details>

<details>
<summary><strong>Is Kimi required?</strong></summary>

No. The baseline works with authenticated Codex alone and becomes Council-capable
when another healthy free or local seat is available.
</details>

---

Apache-2.0 licensed. Built for developers who want faster coding without trusting
a single model blindly.
