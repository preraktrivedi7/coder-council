"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { OPERATIONS, resolveOperation } = require("../src/operations.cjs");
const { webviewHtml } = require("../src/webview.cjs");

const extensionRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));

test("manifest contributes a restricted-workspace Activity Bar webview and commands", () => {
  assert.equal(manifest.main, "./src/extension.cjs");
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
  assert.deepEqual(
    manifest.capabilities.untrustedWorkspaces.restrictedConfigurations,
    ["council.commandPath", "council.nodePath", "council.codexPath"],
  );
  const view = manifest.contributes.views.council.find((item) => item.id === "council.control");
  assert.equal(view.type, "webview");
  const commands = new Set(manifest.contributes.commands.map((item) => item.command));
  assert.ok(manifest.contributes.configuration.properties["council.defaultMode"].enum.includes("code"));
  for (const command of [
    "council.openWorkspace",
    "council.newThread",
    "council.setup",
    "council.refresh",
    "council.init",
    "council.doctor",
    "council.ask",
    "council.council",
    "council.plan",
    "council.review",
    "council.build",
    "council.cancel",
    "council.openConfig",
  ]) assert.ok(commands.has(command), `missing ${command}`);
});

test("the operation allowlist maps every control to fixed CLI arguments", () => {
  assert.deepEqual(resolveOperation("ask", "  explain this  ").args, ["explain this"]);
  assert.deepEqual(resolveOperation("benchmarkRun").args, ["run"]);
  assert.deepEqual(resolveOperation("benchmarkRate", "eval_123 5 critical-catch").args, [
    "rate",
    "eval_123",
    "5",
    "critical-catch",
  ]);
  assert.deepEqual(resolveOperation("configValidate").args, ["validate"]);
  assert.deepEqual(resolveOperation("setupOllama", "qwen3-coder:30b").args, ["seat", "ollama", "enable", "qwen3-coder:30b"]);
  assert.deepEqual(resolveOperation("setupOpenrouterFree").args, ["seat", "openrouterFree", "enable", "openrouter/free"]);
  assert.deepEqual(resolveOperation("setupFreeFirst").args, ["free-first", "auto"]);
  assert.equal(OPERATIONS.build.mutatesSource, true);
  assert.equal(OPERATIONS.benchmarkRun.providerUsage, true);
  assert.throws(() => resolveOperation("shell", "rm -rf ."), /Unsupported/);
  assert.throws(() => resolveOperation("council", ""), /requires input/);
  assert.throws(() => resolveOperation("benchmarkRate", "eval_123 excellent"), /Rate benchmark/);
  assert.throws(() => resolveOperation("ask", "x".repeat(65 * 1024)), /64 KiB/);
});

test("webview uses local resources, a nonce, and a strict content security policy", () => {
  const vscode = {
    Uri: {
      joinPath: (...parts) => parts.map((part) => String(part)).join("/"),
    },
  };
  const webview = {
    cspSource: "vscode-webview://council",
    asWebviewUri: (value) => `safe:${value}`,
  };
  const html = webviewHtml(webview, "extension", vscode);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
  assert.match(html, /safe:extension\/media\/main\.js/);
  assert.match(html, /safe:extension\/media\/styles\.css/);
  assert.match(html, /id="threadList"/);
  assert.match(html, /id="transcript"/);
  assert.match(html, /id="sendButton"/);
  assert.match(html, /id="attachButton"/);
  assert.match(html, /id="attachmentChips"/);
  assert.match(html, /value="code"/);
  assert.match(html, /value="council"/);
});

test("webview code renders provider data as text and never uses raw HTML injection", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "media", "main.js"), "utf8");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(source, /textContent/);
  assert.match(source, /type: "send"/);
  assert.match(source, /type: "setupAction"/);
  assert.match(source, /type: "pickFiles"/);
  assert.match(source, /function richText/);
  assert.match(source, /type: "copy"/);
});

test("OpenRouter setup does not claim an integrated-terminal export can configure the extension host", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "src", "extension.cjs"), "utf8");
  assert.doesNotMatch(source, /prepareTerminal\("OpenRouter setup"/);
  assert.match(source, /external terminal/i);
  assert.match(source, /fully quit/i);
  assert.match(source, /never paste.*key.*chat/i);
});
