import assert from "node:assert/strict";
import test from "node:test";
import { OpenAISeat, OpenCodeSeat } from "../src/seats/opencode.js";
import { OpenRouterSeat, assertOpenRouterRoute, isFreeOpenRouterModel } from "../src/seats/openrouter.js";
import { OllamaSeat } from "../src/seats/ollama.js";
import { SafetyError } from "../src/errors.js";

test("OpenRouter free-only guard rejects every non-free route", () => {
  assert.equal(isFreeOpenRouterModel("openrouter/free"), true);
  assert.equal(isFreeOpenRouterModel("meta/llama:free"), true);
  assert.equal(isFreeOpenRouterModel("openai/gpt-paid"), false);
  assert.throws(
    () => assertOpenRouterRoute("openai/gpt-paid", { allowPaidInference: false, openRouterFreeOnly: true }),
    SafetyError,
  );
});

test("OpenRouter trips circuit on provider-reported nonzero free cost", async () => {
  const seat = new OpenRouterSeat({
    apiKey: "fake-key",
    fetch: async () => ({
      ok: true,
      json: async () => ({
        model: "free-model",
        choices: [{ message: { content: "result" } }],
        usage: { cost: 0.01 },
      }),
    }),
  });
  await assert.rejects(
    seat.run({ system: "", user: "hi", timeoutMs: 100, projectRoot: process.cwd() }),
    /nonzero cost/,
  );
  assert.equal(seat.tripped, true);
});

test("Ollama absent-server health is a clean unavailable result", async () => {
  const seat = new OllamaSeat({ fetch: async () => { throw new TypeError("connection refused"); } });
  const health = await seat.health();
  assert.equal(health.available, false);
  assert.match(health.error, /connection refused/);
});

test("Ollama is ready only when the configured local model is installed", async () => {
  const fetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
  });
  const ready = await new OllamaSeat({ model: "qwen2.5-coder:7b", fetch }).health();
  const missing = await new OllamaSeat({ model: "qwen3-coder:30b", fetch }).health();
  assert.equal(ready.available, true);
  assert.equal(missing.available, false);
  assert.equal(missing.serverAvailable, true);
});

test("OpenCode uses tested CLI fallback when server is absent", async () => {
  const calls = [];
  const seat = new OpenCodeSeat({
    id: "test",
    providerID: "test-provider",
    model: "test-provider/model",
    fetch: async () => { throw new TypeError("server absent"); },
    runner: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "--version") return { code: 0, stdout: "1.18.21\n", stderr: "" };
      return { code: 0, stdout: `${JSON.stringify({ text: "fallback result" })}\n`, stderr: "" };
    },
  });
  const result = await seat.run({
    runId: "run",
    purpose: "candidate",
    system: "system",
    user: "user",
    projectRoot: process.cwd(),
    timeoutMs: 1_000,
  });
  assert.equal(result.text, "fallback result");
  assert.ok(calls.some((call) => call.args[0] === "run" && call.args.includes("--format")));
  assert.equal(result.usage.cost, null);
});

test("OpenCode programmatic server path creates an isolated session", async () => {
  const calls = [];
  const seat = new OpenCodeSeat({
    id: "server-seat",
    providerID: "openai",
    model: "openai/model-a",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/global/health")) return { ok: true, json: async () => ({ healthy: true, version: "1.18.21" }) };
      if (url.endsWith("/provider")) return { ok: true, status: 200, json: async () => ({ connected: ["openai"], all: [], default: {} }) };
      if (url.endsWith("/session")) return { ok: true, status: 200, json: async () => ({ id: "session-1" }) };
      if (url.endsWith("/session/session-1/message")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            info: { tokens: { input: 3, output: 2 } },
            parts: [{ type: "text", text: "server result" }],
          }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await seat.run({
    runId: "run",
    purpose: "candidate",
    system: "system",
    user: "user",
    projectRoot: process.cwd(),
    timeoutMs: 1_000,
    readOnly: true,
  });
  assert.equal(result.text, "server result");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.usage.inputTokens, 3);
  const body = JSON.parse(calls.find((call) => call.url.endsWith("/message")).options.body);
  assert.deepEqual(body.tools, { bash: false, edit: false, write: false, patch: false });
});

test("OpenAI seat falls back to authenticated Codex with stdin prompt", async () => {
  const calls = [];
  const seat = new OpenAISeat({
    fetch: async () => { throw new TypeError("server absent"); },
    runner: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "opencode") return { code: 127, stdout: "", stderr: "missing" };
      if (args[0] === "--version") return { code: 0, stdout: "codex-cli test", stderr: "" };
      if (args[0] === "login") return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex result" } })}\n`,
        stderr: "",
      };
    },
  });
  const result = await seat.run({
    runId: "run",
    purpose: "candidate",
    system: "system",
    user: "user",
    projectRoot: process.cwd(),
    timeoutMs: 1_000,
    readOnly: true,
  });
  assert.equal(result.text, "codex result");
  const exec = calls.find((call) => call.command === "codex" && call.args[0] === "exec");
  assert.equal(exec.args.at(-1), "-");
  assert.equal(exec.args.includes("--ask-for-approval"), false);
  assert.match(exec.options.input, /system\n\nuser/);
});

test("OpenAI seat skips an installed but unauthenticated OpenCode runtime", async () => {
  const calls = [];
  const seat = new OpenAISeat({
    fetch: async () => { throw new TypeError("server absent"); },
    runner: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      if (command === "opencode" && args[0] === "--version") return { code: 0, stdout: "1.18.21", stderr: "" };
      if (command === "opencode" && args[0] === "auth") return { code: 0, stdout: "github", stderr: "" };
      if (command === "codex" && args[0] === "--version") return { code: 0, stdout: "codex-cli test", stderr: "" };
      if (command === "codex" && args[0] === "login") return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex fallback" } })}\n`,
        stderr: "",
      };
    },
  });
  const result = await seat.run({
    runId: "run",
    purpose: "candidate",
    system: "system",
    user: "user",
    projectRoot: process.cwd(),
    timeoutMs: 1_000,
    readOnly: true,
  });
  assert.equal(result.text, "codex fallback");
  assert.equal(calls.some((call) => call.command === "opencode" && call.args[0] === "run"), false);
  assert.equal(calls.some((call) => call.command === "codex" && call.args[0] === "exec"), true);
});
