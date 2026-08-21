"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CouncilProcessAdapter,
  resolveCouncilInvocation,
} = require("../src/council-process.cjs");

const fixture = path.join(__dirname, "..", "fixtures", "fake-council.cjs");

function adapter() {
  return new CouncilProcessAdapter({
    invocationResolver: () => ({ command: process.execPath, args: [fixture], source: fixture }),
  });
}

test("resolves configured scripts through Node and executables directly", () => {
  assert.deepEqual(
    resolveCouncilInvocation({ commandPath: "/tmp/council.js", nodePath: "/node", workspaceRoot: "/tmp" }),
    { command: "/node", args: ["/tmp/council.js"], source: "/tmp/council.js" },
  );
  assert.deepEqual(
    resolveCouncilInvocation({ commandPath: "/tmp/council", workspaceRoot: "/tmp" }),
    { command: "/tmp/council", args: [], source: "/tmp/council" },
  );
});

test("runs Council without a shell and isolates flags from operation input", async () => {
  const result = await adapter().run("ok", ["--question"], { root: process.cwd(), timeoutSeconds: 2 });
  assert.equal(result.ok, true);
  assert.ok(result.args.includes("--json"));
  assert.ok(result.args.includes("--root"));
  assert.ok(result.args.includes(path.resolve(process.cwd())));
  assert.ok(result.args.includes("--timeout"));
  assert.ok(result.args.indexOf("--") < result.args.indexOf("ok"));
  assert.ok(result.args.includes("--question"));
});

test("surfaces structured Council failures", async () => {
  await assert.rejects(
    adapter().run("fail", [], { root: process.cwd(), timeoutSeconds: 2 }),
    (error) => error.exitCode === 2 && /expected failure/.test(error.message),
  );
});

test("allows only one active operation and supports cancellation", async () => {
  const instance = adapter();
  const running = instance.run("wait", [], { root: process.cwd(), timeoutSeconds: 60 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(instance.run("ok", [], { root: process.cwd() }), /already running/);
  assert.equal(instance.cancel(), true);
  await assert.rejects(running, (error) => error.exitCode === 130 && /cancelled/.test(error.message));
  assert.equal(instance.busy, false);
  assert.equal(instance.cancel(), false);
});

test("rejects unbounded output", async () => {
  await assert.rejects(
    adapter().run("large", [], { root: process.cwd(), timeoutSeconds: 2, maxOutputBytes: 65_536 }),
    /output exceeded/,
  );
});

test("integrates with the repository Council CLI without provider calls", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "council-vscode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instance = new CouncilProcessAdapter({
    extensionRoot: path.resolve(__dirname, ".."),
  });
  const initialized = await instance.run("init", [], { root, timeoutSeconds: 5 });
  assert.equal(initialized.root, path.join(root, ".council"));
  assert.ok(fs.existsSync(path.join(root, ".council", "config.jsonc")));
  const validation = await instance.run("config", ["validate"], { root, timeoutSeconds: 5 });
  assert.equal(validation.valid, true);
});
