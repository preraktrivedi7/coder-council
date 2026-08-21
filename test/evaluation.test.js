import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRuns } from "../src/stats.js";
import {
  blindArmLabels,
  generateKimiValueReport,
  kimiRecommendation,
} from "../src/benchmark.js";

test("stats aggregate reported values and preserve unknowns as null", () => {
  const report = aggregateRuns([
    {
      workflow: "ask",
      status: "complete",
      calls: [
        { provider: "a", model: "m", latencyMs: 10, usage: { inputTokens: 5, outputTokens: null, cost: null, credits: null } },
      ],
    },
    {
      workflow: "council",
      status: "complete",
      degradedMode: true,
      calls: [
        { provider: "a", model: "m", latencyMs: 20, usage: { inputTokens: null, outputTokens: null, cost: null, credits: null } },
      ],
    },
  ]);
  assert.equal(report.totalRuns, 2);
  assert.equal(report.degradedRuns, 1);
  assert.equal(report.byProviderModel["a/m"].inputTokens, 5);
  assert.equal(report.byProviderModel["a/m"].outputTokens, null);
  assert.equal(report.byProviderModel["a/m"].cost, null);
  assert.equal(report.medianLatencyMs, 10);
  assert.equal(report.p95LatencyMs, 20);
});

test("benchmark arm blinding is deterministic and obscures arm identity", () => {
  const first = blindArmLabels("task", ["A", "B", "C", "D"]);
  const second = blindArmLabels("task", ["A", "B", "C", "D"]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.label), ["X", "Y", "Z", "W"]);
  assert.notDeepEqual(first.map((item) => item.arm), ["A", "B", "C", "D"]);
});

test("Kimi value report emits only an allowed recommendation category", () => {
  const evaluations = [0, 1, 2].map((index) => ({
    id: String(index),
    arm: "C",
    status: "complete",
    rating: 5,
    contribution: "critical-catch",
    category: "security",
    uniqueFindings: [`finding-${index}`],
    latencyMs: 100 + index,
    cost: null,
  }));
  assert.equal(kimiRecommendation(evaluations), "keep-kimi");
  const generated = generateKimiValueReport({ tasks: [{ id: "t" }], evaluations });
  assert.ok(["keep-kimi", "selective-kimi", "free-is-enough", "insufficient-evidence"].includes(generated.report.recommendation));
  assert.equal(generated.report.reportedUsageCost, null);
  assert.match(generated.markdown, /objective tests and human ratings/i);
});
