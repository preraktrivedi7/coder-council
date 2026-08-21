import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { main, HELP } from "../src/cli.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { FakeSeat } from "../src/seats/base.js";
import { initializeProject, listRuns, markRunAbandoned, RunStore } from "../src/store.js";
import { runCommand } from "../src/utils.js";
import { tempProject } from "./helpers.js";

function captureStream() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => (text += chunk));
  return { stream, read: () => text };
}

test("required command surface is present", () => {
  for (const command of [
    "setup", "init", "doctor", "auth <openai|kimi>", "models", "ask <question>", "council <question>",
    "plan <feature>", "review", "build <feature>", "stats", "benchmark <add|run|report>",
    "config <show|validate>", "config seat <id> <state>", "config free-first [model]",
  ]) {
    assert.match(HELP, new RegExp(command.replace(/[<>|\[\]]/g, ".")));
  }
});

test("one-command setup is idempotent, free-only, and actionable without provider calls", async (t) => {
  const root = await tempProject(t);
  const stdout = captureStream();
  const available = new FakeSeat({ id: "openai" });
  const unavailable = new FakeSeat({ id: "optional", failure: new Error("absent") });
  const io = {
    cwd: root,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    seats: { openai: available, kimi: unavailable, openrouterFree: unavailable, ollama: unavailable },
    env: {},
  };
  assert.equal(await main(["setup", "--json", "--root", root], io), 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.ok, true);
  assert.equal(result.freeFirst.paidFallback, false);
  assert.equal(result.doctor.checks.telemetry.enabled, false);
  assert.equal(available.requests.length, 0);
  const configured = JSON.parse(await fs.readFile(path.join(root, ".council/config.jsonc"), "utf8"));
  assert.equal(configured.seats.openrouterFree.enabled, true);
  assert.equal(configured.seats.ollama.enabled, true);
  assert.equal(configured.spending.allowPaidInference, false);
});

test("free-first setup consumes no provider calls and enables every supported free/local pool", async (t) => {
  const root = await tempProject(t);
  await initializeProject(root);
  const stdout = captureStream();
  const code = await main(["config", "free-first", "auto", "--json", "--root", root], {
    cwd: root,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    env: {},
  });
  assert.equal(code, 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.mode, "free-first");
  assert.equal(result.paidFallback, false);
  assert.deepEqual(result.seats.map((seat) => seat.seat), ["openrouterFree", "ollama"]);
});

test("config seat enables a validated local model without provider calls", async (t) => {
  const root = await tempProject(t);
  await initializeProject(root);
  const stdout = captureStream();
  const code = await main(["config", "seat", "ollama", "enable", "qwen3-coder:30b", "--json", "--root", root], {
    cwd: root,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(code, 0);
  const result = JSON.parse(stdout.read());
  assert.deepEqual({ seat: result.seat, enabled: result.enabled, model: result.model }, {
    seat: "ollama",
    enabled: true,
    model: "qwen3-coder:30b",
  });
});

test("doctor works with Kimi absent and paid inference disabled", async (t) => {
  const root = await tempProject(t);
  await initializeProject(root);
  const stdout = captureStream();
  const stderr = captureStream();
  const available = new FakeSeat({ id: "openai" });
  const unavailable = new FakeSeat({ id: "optional", failure: new Error("absent") });
  const code = await main(["doctor", "--json", "--root", root], {
    cwd: root,
    stdout: stdout.stream,
    stderr: stderr.stream,
    seats: { openai: available, kimi: unavailable, openrouterFree: unavailable, ollama: unavailable },
    env: {},
  });
  const report = JSON.parse(stdout.read());
  assert.equal(code, 0);
  assert.equal(report.checks.kimi.configured, false);
  assert.equal(report.checks.paidInference.enabled, false);
  assert.equal(report.checks.loopback.host, "127.0.0.1");
  assert.equal(stderr.read(), "");
});

test("interrupted runs are detectable and safely abandonable", async (t) => {
  const root = await tempProject(t);
  const store = new RunStore(root);
  const run = await store.create({ workflow: "ask" });
  assert.equal((await listRuns(root))[0].status, "running");
  const closed = await markRunAbandoned(root, run.id);
  assert.equal(closed.status, "abandoned");
  assert.ok(closed.finishedAt);
});

test("dry-run does not call providers or create Council state", async (t) => {
  const root = await tempProject(t);
  const stdout = captureStream();
  const fake = new FakeSeat({ id: "openai", failure: new Error("must not run") });
  const code = await main(["build", "feature", "--dry-run", "--json", "--root", root], {
    cwd: root,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    seats: { openai: fake, kimi: fake, openrouterFree: fake, ollama: fake },
    env: {},
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.read()).dryRun, true);
  assert.equal(fake.requests.length, 0);
  await assert.rejects(fs.access(path.join(root, ".council")), /ENOENT/);
});

test("security/spending defaults and prompts never request hidden reasoning", async () => {
  assert.equal(DEFAULT_CONFIG.spending.allowPaidInference, false);
  assert.equal(DEFAULT_CONFIG.spending.openRouterFreeOnly, true);
  assert.equal(DEFAULT_CONFIG.runtime.host, "127.0.0.1");
  assert.equal(DEFAULT_CONFIG.privacy.telemetry, false);
  const promptsRoot = path.resolve("prompts");
  for (const name of await fs.readdir(promptsRoot)) {
    const text = await fs.readFile(path.join(promptsRoot, name), "utf8");
    assert.doesNotMatch(text, /(?:show|reveal|provide|write) (?:your )?(?:private )?chain[- ]of[- ]thought/i);
    assert.match(text, /chain-of-thought|concise|read-only/i);
  }
});

test("no source workflow invokes reset, clean, commit, or push", async () => {
  const sourceRoot = path.resolve("src");
  const queue = [sourceRoot];
  const files = [];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.name.endsWith(".js")) files.push(target);
    }
  }
  const source = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /runCommand\(\s*["']git["']\s*,\s*\[\s*["'](?:reset|clean|commit|push)["']/);
});

test("CLI errors in JSON mode keep stdout machine-readable", async () => {
  const result = await runCommand(process.execPath, ["bin/council.js", "unknown-command", "--json"], {
    cwd: path.resolve("."),
  });
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.exitCode, 2);
  assert.equal(result.stderr, "");
});

test("optional Kimi auth command is actionable without installing Kimi", async (t) => {
  const root = await tempProject(t);
  const stdout = captureStream();
  const code = await main(["auth", "kimi", "--json", "--root", root], {
    cwd: root,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    env: {},
  });
  const result = JSON.parse(stdout.read());
  assert.equal(code, 0);
  assert.equal(result.communityPlugin, "opencode-kimi-full@1.4.0");
  assert.match(result.commands.join(" "), /kimi-for-coding-oauth/);
});
