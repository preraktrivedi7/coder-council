import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { runCommand } from "../src/utils.js";

export async function tempProject(t, { git = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "council-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (git) {
    await runCommand("git", ["init", "-q"], { cwd: root });
    await runCommand("git", ["config", "user.email", "council-test@example.invalid"], { cwd: root });
    await runCommand("git", ["config", "user.name", "Council Test"], { cwd: root });
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n");
    await runCommand("git", ["add", "--", "seed.txt"], { cwd: root });
    await runCommand("git", ["commit", "-qm", "seed"], { cwd: root });
  }
  return root;
}

export function testConfig(override = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    budgets: { maxModelCallsPerRun: 7, timeoutSeconds: 2, maxConcurrentCalls: 2 },
    ...override,
  });
}

export function candidate(recommendation, extra = {}) {
  return {
    summary: recommendation,
    recommendation,
    reasoningSummary: [`Reason for ${recommendation}`],
    assumptions: [],
    risks: [],
    unknowns: [],
    verificationSteps: ["Run tests"],
    confidence: 0.75,
    ...extra,
  };
}

export function critique(label = "critique") {
  return {
    strongestPointInOtherAnswer: `${label} strongest point`,
    criticalIssues: [],
    positionChanges: [],
    stillDisagreeOn: [],
  };
}

export function revision(position) {
  return {
    finalPosition: position,
    changesFromOriginal: [],
    acceptedCritiques: [],
    rejectedCritiques: [],
    remainingRisks: [],
    confidence: 0.8,
  };
}

export function synthesis(recommendation = "Use the evidence-backed hybrid") {
  return {
    recommendation,
    why: ["Tests decide"],
    consensus: ["Verify the result"],
    unresolvedDisagreements: [],
    risks: [],
    verificationBeforeAction: ["Run tests"],
    preferredCandidate: "hybrid",
    confidence: 0.8,
  };
}

