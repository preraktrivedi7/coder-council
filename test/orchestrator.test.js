import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FakeSeat } from "../src/seats/base.js";
import { listRuns, RunStore } from "../src/store.js";
import { runAsk, runCouncil } from "../src/orchestrator.js";
import { candidate, critique, revision, synthesis, tempProject, testConfig } from "./helpers.js";

test("independent candidates share task hash, start concurrently, and cannot see each other", async (t) => {
  const root = await tempProject(t);
  const starts = [];
  const primary = new FakeSeat({
    id: "primary",
    provider: "provider-a",
    model: "model-a",
    delayMs: 45,
    responses: [
      () => { starts.push({ seat: "primary", at: Date.now() }); return { structured: candidate("Primary plan", { risks: ["A risk"] }) }; },
      { structured: critique("primary") },
      { structured: revision("Revised primary") },
      { structured: synthesis() },
    ],
  });
  const challenger = new FakeSeat({
    id: "challenger",
    provider: "provider-b",
    model: "model-b",
    delayMs: 45,
    responses: [
      () => { starts.push({ seat: "challenger", at: Date.now() }); return { structured: candidate("Challenger plan", { risks: ["B risk"] }) }; },
      { structured: critique("challenger") },
      { structured: revision("Revised challenger") },
    ],
  });
  const result = await runCouncil({
    root,
    config: testConfig(),
    primary,
    challenger,
    objective: "Choose a plan",
  });
  assert.equal(result.degraded, false);
  assert.equal(primary.requests[0].user, challenger.requests[0].user);
  assert.match(primary.requests[0].user, new RegExp(result.taskHash));
  assert.doesNotMatch(primary.requests[0].user, /Challenger plan/);
  assert.doesNotMatch(challenger.requests[0].user, /Primary plan/);
  assert.ok(Math.abs(starts[0].at - starts[1].at) < 30, JSON.stringify(starts));
  assert.equal(result.run.record.candidateIsolation.sameTaskHash, true);
  assert.equal(result.run.record.candidateIsolation.candidateAReceivedCandidateB, false);
  assert.deepEqual(result.run.record.calls.map((call) => call.model).sort(), [
    "model-a", "model-a", "model-a", "model-a", "model-b", "model-b", "model-b",
  ].sort());
});

test("invalid structured candidate retries once and never loops", async (t) => {
  const root = await tempProject(t);
  const primary = new FakeSeat({ id: "primary", responses: [{ text: "not json" }, { text: "still not json" }] });
  const challenger = new FakeSeat({ id: "challenger", responses: [{ structured: candidate("valid") }] });
  await assert.rejects(
    runCouncil({ root, config: testConfig(), primary, challenger, objective: "test retry" }),
    /valid JSON/,
  );
  assert.equal(primary.requests.length, 2);
  assert.equal(challenger.requests.length, 1);
});

test("challenger failure degrades safely unless explicitly requested", async (t) => {
  const root = await tempProject(t);
  const primary = new FakeSeat({ id: "primary", responses: [{ structured: candidate("Primary only") }] });
  const challenger = new FakeSeat({ id: "challenger", failure: new Error("challenger offline") });
  const result = await runCouncil({
    root,
    config: testConfig(),
    primary,
    challenger,
    objective: "degrade",
  });
  assert.equal(result.degraded, true);
  assert.equal(result.synthesis.preferredCandidate, "primary");
  assert.match(result.run.record.degradedReason, /offline/);

  const strictPrimary = new FakeSeat({ id: "primary", responses: [{ structured: candidate("Primary only") }] });
  await assert.rejects(
    runCouncil({
      root,
      config: testConfig(),
      primary: strictPrimary,
      challenger,
      objective: "strict",
      explicitChallenger: true,
    }),
    /offline/,
  );
});

test("run persistence writes only executed stages and resolved identities", async (t) => {
  const root = await tempProject(t);
  const primary = new FakeSeat({
    id: "primary",
    provider: "fake-a",
    model: "actual-a",
    responses: [{ structured: candidate("same") }, { structured: synthesis("same") }],
  });
  const challenger = new FakeSeat({
    id: "challenger",
    provider: "fake-b",
    model: "actual-b",
    responses: [{ structured: candidate("same") }],
  });
  const result = await runCouncil({ root, config: testConfig(), primary, challenger, objective: "persist" });
  const names = await fs.readdir(result.run.directory);
  assert.ok(names.includes("primary-candidate.json"));
  assert.ok(names.includes("challenger-candidate.json"));
  assert.ok(names.includes("comparison.json"));
  assert.ok(names.includes("synthesis.json"));
  assert.equal(names.includes("primary-critique.json"), false);
  const record = JSON.parse(await fs.readFile(path.join(result.run.directory, "run.json"), "utf8"));
  assert.deepEqual(record.calls.map((call) => call.model), ["actual-a", "actual-b", "actual-a"]);
});

test("timeout cancels bounded provider work and marks the run failed", async (t) => {
  const root = await tempProject(t);
  const primary = new FakeSeat({ id: "primary", delayMs: 200, responses: [{ structured: candidate("slow") }] });
  const challenger = new FakeSeat({ id: "challenger", delayMs: 200, responses: [{ structured: candidate("slow too") }] });
  const config = testConfig({ budgets: { maxModelCallsPerRun: 7, timeoutSeconds: 0.03, maxConcurrentCalls: 2 } });
  await assert.rejects(runCouncil({ root, config, primary, challenger, objective: "timeout" }), /timed out|aborted/i);
  const runs = await listRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(primary.active, 0);
  assert.equal(challenger.active, 0);
});

test("external cancellation stops providers and marks the run abandoned", async (t) => {
  const root = await tempProject(t);
  const controller = new AbortController();
  const primary = new FakeSeat({ id: "primary", delayMs: 200, responses: [{ structured: candidate("slow") }] });
  const challenger = new FakeSeat({ id: "challenger", delayMs: 200, responses: [{ structured: candidate("slow too") }] });
  const promise = runCouncil({
    root,
    config: testConfig(),
    primary,
    challenger,
    objective: "cancel",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("cancelled by test")), 20);
  await assert.rejects(promise, /cancelled by test/);
  const runs = await listRuns(root);
  assert.equal(runs[0].status, "abandoned");
  assert.equal(primary.active, 0);
  assert.equal(challenger.active, 0);
});

test("no-store mode leaves no run directory", async (t) => {
  const root = await tempProject(t);
  const primary = new FakeSeat({ id: "primary", responses: [{ structured: candidate("same") }, { structured: synthesis("same") }] });
  const challenger = new FakeSeat({ id: "challenger", responses: [{ structured: candidate("same") }] });
  await runCouncil({
    root,
    config: testConfig(),
    primary,
    challenger,
    objective: "ephemeral",
    store: new RunStore(root, { enabled: false }),
  });
  assert.deepEqual(await listRuns(root), []);
});

test("run logs redact secrets and honor prompt/response storage switches", async (t) => {
  const root = await tempProject(t);
  const token = `sk-${"z".repeat(40)}`;
  const primary = new FakeSeat({ id: "primary", responses: [{ text: `answer ${token}` }] });
  const config = testConfig({
    privacy: {
      storePrompts: false,
      storeResponses: false,
      redactEnvironmentSecrets: true,
      telemetry: false,
    },
  });
  const result = await runAsk({ root, config, primary, objective: `secret objective ${token}` });
  const task = await fs.readFile(path.join(result.run.directory, "task.json"), "utf8");
  const response = await fs.readFile(path.join(result.run.directory, "primary-candidate.json"), "utf8");
  const final = await fs.readFile(path.join(result.run.directory, "final.md"), "utf8");
  assert.doesNotMatch(`${task}${response}${final}`, new RegExp(token));
  assert.match(task, /\[not stored\]/);
  assert.match(response, /"stored": false/);
  assert.match(final, /storage disabled/i);
});
