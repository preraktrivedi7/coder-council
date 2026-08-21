import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FakeSeat } from "../src/seats/base.js";
import {
  buildWorkingTree,
  captureGitState,
  dedupeFindings,
  reviewWorkingTree,
  withWriterLock,
} from "../src/git-workflows.js";
import { initializeProject } from "../src/store.js";
import { sleep } from "../src/utils.js";
import { tempProject, testConfig } from "./helpers.js";

test("review is read-only and deduplicates findings by issue identity", async (t) => {
  const root = await tempProject(t, { git: true });
  await initializeProject(root);
  await fs.writeFile(path.join(root, "seed.txt"), "changed\n");
  const first = new FakeSeat({
    id: "reviewer-a",
    responses: [{ structured: { findings: [{ id: "a", severity: "high", file: "seed.txt", line: 1, issue: "Missing check", evidence: "diff", recommendedFix: "add check", reportedBy: [] }] } }],
  });
  const second = new FakeSeat({
    id: "reviewer-b",
    responses: [{ structured: { findings: [{ id: "b", severity: "medium", file: "seed.txt", line: 1, issue: "Missing check", evidence: "same", recommendedFix: "add it", reportedBy: [] }] } }],
  });
  const before = await captureGitState(root);
  const result = await reviewWorkingTree({ root, seats: [first, second], timeoutMs: 1_000 });
  const after = await captureGitState(root);
  assert.equal(before.fingerprint, after.fingerprint);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].reportedBy.sort(), ["reviewer-a", "reviewer-b"]);
  assert.equal(result.findings[0].severity, "high");
  assert.equal(first.requests[0].readOnly, true);
});

test("dedupe keeps unrelated issues and sorts by severity", () => {
  const result = dedupeFindings([
    [{ severity: "low", file: "a.js", line: 1, issue: "one", reportedBy: ["a"] }],
    [{ severity: "critical", file: "b.js", line: 2, issue: "two", reportedBy: ["b"] }],
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].severity, "critical");
});

test("writer lock rejects a concurrent implementation writer", async (t) => {
  const root = await tempProject(t);
  let entered = false;
  const first = withWriterLock(root, async () => {
    entered = true;
    await sleep(80);
  });
  while (!entered) await sleep(1);
  await assert.rejects(withWriterLock(root, async () => {}), /already active/);
  await first;
  await assert.doesNotReject(withWriterLock(root, async () => {}));
});

test("build uses one writer, verifies changes, and never commits or pushes", async (t) => {
  const root = await tempProject(t, { git: true });
  await initializeProject(root);
  const writer = new FakeSeat({
    id: "writer",
    readOnly: false,
    responses: [async () => {
      await fs.writeFile(path.join(root, "seed.txt"), "implemented\n");
      return { text: "implemented seed" };
    }],
  });
  const reviewer = new FakeSeat({ id: "reviewer", responses: [{ structured: { findings: [] } }] });
  const before = await captureGitState(root);
  const result = await buildWorkingTree({
    root,
    writer,
    reviewers: [reviewer],
    objective: "change seed",
    planText: "change seed safely",
    config: testConfig({ workflows: { verificationCommands: ["node -e \"const fs=require('node:fs'); process.exit(fs.readFileSync('seed.txt','utf8').trim()==='implemented'?0:1)\""], allowDirtyBuild: true, autoCommit: false, autoPush: false } }),
  });
  const after = await captureGitState(root);
  assert.equal(result.verification[0].code, 0);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(writer.requests.length, 1);
  assert.equal(writer.requests[0].readOnly, false);
  assert.equal(reviewer.requests[0].readOnly, true);
  assert.equal(after.commit, before.commit);
});
