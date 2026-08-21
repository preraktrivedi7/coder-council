# Coder Council for VS Code

Coder Council is a Codex-compatible coding workspace with a built-in multi-model decision
mode. It reads and resumes existing Codex threads through Codex App Server, streams
coding activity and diffs, handles approvals, includes active-editor context, and
adds guided Codex, Ollama, OpenRouter-free, and OpenCode setup.

## Requirements

- VS Code 1.95 or newer
- Node.js 20 or newer
- Coder Council from this checkout, `PATH`, or `council.commandPath`
- Official Codex CLI from `PATH`, the standalone install at `~/.local/bin/codex`,
  common Homebrew locations, or `council.codexPath`
- `codex login status` reporting an authenticated session

From the Coder Council repository:

```bash
npm install
npm link
npm --prefix extensions/vscode install
npm run package:vscode
code --install-extension artifacts/coder-council-vscode-0.3.0.vsix
```

Without the `code` launcher, run **Extensions: Install from VSIX…** in VS Code.
Select the Coder Council icon, then **Open coding workspace**.

## Main workflows

- **Code**: Codex workspace-write turn with on-request approvals.
- **Plan / Ask / Review**: Codex read-only turns.
- **Council**: independent Council candidates plus comparison and synthesis.
- **History**: live workspace or all-thread access from the existing Codex store.
- **Setup**: provider health, prepared login/start commands, Ollama model selection,
  one-click free-first OpenRouter/Ollama enablement, and Council CLI controls.

For OpenRouter, fully quit VS Code, export `OPENROUTER_API_KEY` from an external
terminal, and launch VS Code from that same terminal. An integrated-terminal
export cannot update the extension host. Council never asks for or stores the key.

The extension never copies Codex tokens or thread files into `.council/`. It never
reads browser cookies, never injects dynamic HTML, never displays private reasoning
content, and refuses execution in an untrusted or mismatched workspace.

See [../../docs/VSCODE.md](../../docs/VSCODE.md) for architecture, settings,
security boundaries, setup, and troubleshooting.

## Development

```bash
npm run check:vscode
npm run test:vscode
npm run package:vscode
```

Normal tests use fake JSONL/process transports and local Council commands. They do
not make provider inference calls.
