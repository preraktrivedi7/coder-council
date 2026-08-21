import { listRuns } from "./store.js";

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function sumReported(values) {
  const reported = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)));
  return reported.length ? reported.reduce((sum, value) => sum + Number(value), 0) : null;
}

export function aggregateRuns(runs) {
  const calls = runs.flatMap((run) => run.calls || []);
  const byProviderModel = {};
  for (const call of calls) {
    const key = `${call.provider || "unknown"}/${call.model || "unknown"}`;
    byProviderModel[key] ||= { calls: 0, inputTokens: [], outputTokens: [], cost: [], credits: [] };
    byProviderModel[key].calls += 1;
    byProviderModel[key].inputTokens.push(call.usage?.inputTokens ?? null);
    byProviderModel[key].outputTokens.push(call.usage?.outputTokens ?? null);
    byProviderModel[key].cost.push(call.usage?.cost ?? null);
    byProviderModel[key].credits.push(call.usage?.credits ?? null);
  }
  for (const value of Object.values(byProviderModel)) {
    value.inputTokens = sumReported(value.inputTokens);
    value.outputTokens = sumReported(value.outputTokens);
    value.cost = sumReported(value.cost);
    value.credits = sumReported(value.credits);
  }
  const latencies = calls.map((call) => call.latencyMs).filter((value) => Number.isFinite(value));
  return {
    totalRuns: runs.length,
    completedRuns: runs.filter((run) => run.status === "complete").length,
    openAIOnlyRuns: runs.filter((run) => run.workflow === "ask").length,
    councilRuns: runs.filter((run) => run.workflow === "council").length,
    degradedRuns: runs.filter((run) => run.degradedMode).length,
    incompleteRuns: runs.filter((run) => run.status === "running").length,
    callCount: calls.length,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    byProviderModel,
    humanOutcomes: runs.map((run) => run.humanOutcome).filter((value) => value !== undefined && value !== null),
    uniqueUsefulContributions: runs.flatMap((run) => run.uniqueUsefulContributions || []),
  };
}

export async function statsReport(root, { period } = {}) {
  let runs = await listRuns(root);
  if (period) {
    const duration = /^([0-9]+)d$/.exec(period);
    if (duration) {
      const cutoff = Date.now() - Number(duration[1]) * 86_400_000;
      runs = runs.filter((run) => new Date(run.startedAt).getTime() >= cutoff);
    }
  }
  const report = aggregateRuns(runs);
  const text = [
    "Council stats",
    `Runs: ${report.totalRuns} (${report.completedRuns} complete, ${report.degradedRuns} degraded, ${report.incompleteRuns} incomplete)`,
    `Calls: ${report.callCount}`,
    `Latency median/p95: ${report.medianLatencyMs ?? "null"}/${report.p95LatencyMs ?? "null"} ms`,
    ...Object.entries(report.byProviderModel).map(
      ([model, value]) => `${model}: ${value.calls} calls, input=${value.inputTokens ?? "null"}, output=${value.outputTokens ?? "null"}, cost=${value.cost ?? "null"}`,
    ),
  ].join("\n");
  return { ...report, text };
}

