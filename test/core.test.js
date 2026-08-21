import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  parseJsonc,
  updateFreeFirstConfig,
  updateSeatConfig,
  validateConfig,
} from "../src/config.js";
import { main, parseArgs } from "../src/cli.js";
import { chooseArbiter, chooseChallenger } from "../src/commands.js";
import { buildContextBundle, equalizeBundles } from "../src/context.js";
import { redact, redactText } from "../src/security.js";
import { initializeProject, recordDecision } from "../src/store.js";
import { FakeSeat } from "../src/seats/base.js";
import { tempProject } from "./helpers.js";

test("JSONC parsing and deep configuration merge preserve safety defaults", () => {
  const parsed = parseJsonc(`{
    // project override
    "seats": { "kimi": { "enabled": true, }, },
  }`);
  const config = mergeConfig(DEFAULT_CONFIG, parsed);
  assert.equal(config.seats.kimi.enabled, true);
  assert.equal(config.seats.kimi.model, "auto");
  assert.equal(config.spending.allowPaidInference, false);
  assert.deepEqual(validateConfig(config, { throwOnError: false }), { valid: true, errors: [] });
});

test("configuration refuses public listeners and disabled isolation", () => {
  const publicConfig = mergeConfig(DEFAULT_CONFIG, { runtime: { host: "0.0.0.0" } });
  assert.throws(() => validateConfig(publicConfig), /non-loopback/);
  const shared = mergeConfig(DEFAULT_CONFIG, { debate: { independentFirst: false } });
  assert.throws(() => validateConfig(shared), /independentFirst/);
});

test("seat setup preserves JSONC comments and refuses paid OpenRouter routes", async (t) => {
  const root = await tempProject(t);
  await initializeProject(root);
  const target = path.join(root, ".council/config.jsonc");
  const original = await fs.readFile(target, "utf8");
  await fs.writeFile(target, original.replace('"ollama": {', '"ollama": {\n      // configured by the user'));
  const result = await updateSeatConfig(root, "ollama", { enabled: true, model: "qwen3-coder:30b" });
  assert.equal(result.enabled, true);
  const updated = await fs.readFile(target, "utf8");
  assert.match(updated, /configured by the user/);
  const parsed = parseJsonc(updated);
  assert.equal(parsed.seats.ollama.enabled, true);
  assert.equal(parsed.seats.ollama.model, "qwen3-coder:30b");
  await assert.rejects(
    updateSeatConfig(root, "openrouterFree", { enabled: true, model: "openai/gpt-paid" }),
    /only openrouter\/free|:free/,
  );
});

test("free-first setup enables the dynamic free router and local seat atomically", async (t) => {
  const root = await tempProject(t);
  await initializeProject(root);
  const target = path.join(root, ".council/config.jsonc");
  const original = await fs.readFile(target, "utf8");
  await fs.writeFile(target, original
    .replace('"allowPaidInference": false', '"allowPaidInference": true')
    .replace('"openRouterFreeOnly": true', '"openRouterFreeOnly": false'));
  const result = await updateFreeFirstConfig(root, { ollamaModel: "qwen3-coder:30b" });
  assert.equal(result.paidFallback, false);
  assert.deepEqual(result.seats.map(({ seat, enabled, model }) => ({ seat, enabled, model })), [
    { seat: "openrouterFree", enabled: true, model: "openrouter/free" },
    { seat: "ollama", enabled: true, model: "qwen3-coder:30b" },
  ]);
  const config = parseJsonc(await fs.readFile(target, "utf8"));
  assert.equal(config.seats.openrouterFree.enabled, true);
  assert.equal(config.seats.ollama.enabled, true);
  assert.equal(config.spending.allowPaidInference, false);
  assert.equal(config.spending.openRouterFreeOnly, true);
});

test("automatic Council routing uses different healthy free seats for challenger and arbiter", async () => {
  const openrouterFree = new FakeSeat({ id: "openrouterFree" });
  const ollama = new FakeSeat({ id: "ollama" });
  const context = {
    flags: {},
    config: mergeConfig(DEFAULT_CONFIG, {
      seats: { openrouterFree: { enabled: true }, ollama: { enabled: true } },
    }),
    seats: { openrouterFree, ollama },
  };
  const challenger = await chooseChallenger(context);
  const arbiter = await chooseArbiter(context, [challenger.seat.id]);
  assert.equal(challenger.seat.id, "openrouterFree");
  assert.equal(arbiter.id, "ollama");
});

test("council init is idempotent and persists decisions without credentials", async (t) => {
  const root = await tempProject(t);
  const first = await initializeProject(root);
  const second = await initializeProject(root);
  assert.ok(first.created.length > 0);
  assert.equal(second.alreadyInitialized, true);
  const decision = await recordDecision(root, {
    title: "Use evidence",
    decision: "Tests outrank votes",
    status: "accepted",
  });
  assert.match(decision.id, /^decision_/);
  const state = JSON.parse(await fs.readFile(path.join(root, ".council/state.json"), "utf8"));
  assert.equal(state.decisions.length, 1);
  await assert.rejects(
    recordDecision(root, { title: "bad", decision: "bad", access_token: "not-allowed" }),
    /Credential-like fields/,
  );
});

test("redaction removes secrets recursively and from text", () => {
  const token = `sk-${"a".repeat(40)}`;
  const value = redact({ OPENAI_API_KEY: token, accessToken: token, nested: { note: `Bearer ${"b".repeat(30)}` } });
  assert.equal(value.OPENAI_API_KEY, "[REDACTED]");
  assert.equal(value.accessToken, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(value), /a{20}|b{20}/);
  assert.equal(redactText(`api_key=${token}`).includes(token), false);
});

test("context bundle enforces byte bounds and equivalence metadata", async (t) => {
  const root = await tempProject(t);
  await fs.writeFile(path.join(root, "large.txt"), "x".repeat(200));
  const first = await buildContextBundle(root, { files: ["large.txt"], maxBytes: 50, includeGit: false });
  const second = await buildContextBundle(root, { files: ["large.txt"], maxBytes: 50, includeGit: false });
  assert.equal(first.truncated, true);
  assert.equal(first.files[0].content.length, 50);
  assert.equal(equalizeBundles(first, second).materiallyEquivalent, true);
});

test("argument parsing supports inline values and validates missing values", () => {
  assert.deepEqual(parseArgs(["ask", "hi", "--timeout=5", "--json"]), {
    positionals: ["ask", "hi"],
    flags: { timeout: "5", json: true },
  });
  assert.deepEqual(parseArgs(["--json", "--", "ask", "--explain this"]), {
    positionals: ["ask", "--explain this"],
    flags: { json: true },
  });
  assert.throws(() => parseArgs(["ask", "hi", "--timeout"]), /requires a value/);
});

test("ask --json keeps stdout valid JSON with fake provider", async (t) => {
  const root = await tempProject(t);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => (out += chunk));
  stderr.on("data", (chunk) => (err += chunk));
  const fake = new FakeSeat({ id: "openai", responses: [{ text: "hello" }] });
  const code = await main(["ask", "hello", "--json", "--root", root], {
    cwd: root,
    stdout,
    stderr,
    seats: { openai: fake, kimi: fake, openrouterFree: fake, ollama: fake },
    env: {},
  });
  assert.equal(code, 0);
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out).text, "hello");
  assert.equal(err, "");
});
