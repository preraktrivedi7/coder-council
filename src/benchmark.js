import path from "node:path";
import { ValidationError } from "./errors.js";
import { runAsk, runCouncil } from "./orchestrator.js";
import { councilPath, initializeProject, RunStore } from "./store.js";
import { createId, readJson, sha256, writeJson, atomicWrite } from "./utils.js";

const CONTRIBUTIONS = new Set(["none", "duplicate", "useful-detail", "material-improvement", "critical-catch", "harmful"]);

function benchmarkFile(root) {
  return path.join(councilPath(root), "evaluations", "benchmark.json");
}

export function blindArmLabels(taskId, arms) {
  const labels = ["X", "Y", "Z", "W"];
  return [...arms]
    .map((arm) => ({ arm, rank: sha256(`${taskId}:${arm}`) }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .map((entry, index) => ({ label: labels[index] || `blind-${index + 1}`, arm: entry.arm }));
}

export function kimiRecommendation(evaluations) {
  const kimi = evaluations.filter((item) => ["C", "D"].includes(item.arm) && item.status === "complete");
  const rated = kimi.filter((item) => item.rating && item.contribution);
  if (rated.length < 3) return "insufficient-evidence";
  const beneficial = rated.filter(
    (item) => item.rating >= 4 && ["material-improvement", "critical-catch"].includes(item.contribution),
  ).length;
  const harmful = rated.filter((item) => item.contribution === "harmful" || item.rating <= 1).length;
  if (harmful > beneficial) return "free-is-enough";
  if (beneficial / rated.length >= 0.6) return "keep-kimi";
  if (beneficial > 0) return "selective-kimi";
  return "free-is-enough";
}

export function generateKimiValueReport(data) {
  const evaluations = data.evaluations || [];
  const kimi = evaluations.filter((item) => ["C", "D"].includes(item.arm));
  const beneficial = kimi.filter((item) => ["material-improvement", "critical-catch"].includes(item.contribution));
  const uniqueKimi = kimi.filter((item) => item.contribution === "critical-catch").flatMap((item) => item.uniqueFindings || []);
  const recommendation = kimiRecommendation(evaluations);
  const latencies = kimi.map((item) => item.latencyMs).filter(Number.isFinite);
  const report = {
    tasks: data.tasks?.length || 0,
    kimiEvaluations: kimi.length,
    changedFinalResult: kimi.filter((item) => ![null, undefined, "none", "duplicate"].includes(item.contribution)).length,
    beneficialChanges: beneficial.length,
    uniqueKimiFindings: uniqueKimi,
    uniqueFreeOrOpenAIFindings: evaluations.filter((item) => ["A", "B"].includes(item.arm)).flatMap((item) => item.uniqueFindings || []),
    categoriesWhereKimiHelps: [...new Set(beneficial.map((item) => item.category).filter(Boolean))],
    categoriesWhereKimiAddsLittle: [...new Set(kimi.filter((item) => ["none", "duplicate"].includes(item.contribution)).map((item) => item.category).filter(Boolean))],
    medianExtraLatencyMs: latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null,
    reportedUsageCost: kimi.some((item) => item.cost !== null && item.cost !== undefined)
      ? kimi.reduce((sum, item) => sum + Number(item.cost || 0), 0)
      : null,
    recommendation,
  };
  const markdown = [
    "# Kimi value report",
    "",
    `Recommendation: **${recommendation}**`,
    "",
    `- Kimi evaluations: ${report.kimiEvaluations}`,
    `- Changed the final result: ${report.changedFinalResult}`,
    `- Beneficial material changes: ${report.beneficialChanges}`,
    `- Unique Kimi findings: ${report.uniqueKimiFindings.length}`,
    `- Unique OpenAI/free findings: ${report.uniqueFreeOrOpenAIFindings.length}`,
    `- Median extra latency: ${report.medianExtraLatencyMs ?? "unknown"}`,
    `- Extra reported usage/cost: ${report.reportedUsageCost ?? "unknown"}`,
    "",
    "The recommendation weights objective tests and human ratings above model self-evaluation.",
  ].join("\n");
  return { report, markdown };
}

async function loadBenchmark(root) {
  return readJson(benchmarkFile(root), { version: 1, tasks: [], evaluations: [] });
}

async function saveBenchmark(root, data) {
  await writeJson(benchmarkFile(root), data);
}

export async function runBenchmarkCommand(action = "report", args, context) {
  await initializeProject(context.root);
  const data = await loadBenchmark(context.root);
  if (action === "add") {
    const objective = args.join(" ");
    const task = {
      id: createId("benchmark"),
      objective,
      category: "general",
      status: objective ? "ready" : "draft",
    };
    data.tasks.push(task);
    await saveBenchmark(context.root, data);
    return { task, text: objective ? `Added benchmark task ${task.id}.` : `Created draft benchmark task ${task.id}; edit ${benchmarkFile(context.root)} to add its objective.` };
  }
  if (action === "rate") {
    const [evaluationId, rawRating, contribution = "none"] = args;
    const matches = data.evaluations.filter((item) => item.id === evaluationId || item.blindLabel === evaluationId);
    const evaluation = matches.length === 1 ? matches[0] : null;
    const rating = Number(rawRating);
    if (!evaluation || !Number.isInteger(rating) || rating < 1 || rating > 5 || !CONTRIBUTIONS.has(contribution)) {
      throw new ValidationError("Usage: council benchmark rate <evaluation-id> <1..5> <contribution-label>");
    }
    evaluation.rating = rating;
    evaluation.contribution = contribution;
    await saveBenchmark(context.root, data);
    return { evaluation, text: `Recorded rating for ${evaluation.id}.` };
  }
  if (action === "pending") {
    const pending = data.evaluations
      .filter((item) => item.status === "complete" && item.rating == null)
      .map((item) => ({
        id: item.id,
        taskId: item.taskId,
        blindLabel: item.blindLabel,
        output: item.output,
        latencyMs: item.latencyMs,
      }));
    return {
      pending,
      text: pending.length
        ? pending.map((item) => `## ${item.blindLabel} (${item.id})\n\n${item.output}`).join("\n\n")
        : "No unrated benchmark results.",
    };
  }
  if (action === "run") {
    const tasks = data.tasks.filter((task) => task.status === "ready");
    if (context.flags["dry-run"]) {
      return {
        dryRun: true,
        tasks: tasks.length,
        arms: ["A", "B", "C", "D"],
        text: `Dry run: ${tasks.length} ready benchmark task(s); no provider calls performed.`,
      };
    }
    for (const task of tasks) {
      const arms = [{ arm: "A", primary: context.seats.openai }];
      if (context.config.seats.openrouterFree.enabled || context.config.seats.ollama.enabled) {
        arms.push({ arm: "B", primary: context.seats.openai, challenger: context.config.seats.openrouterFree.enabled ? context.seats.openrouterFree : context.seats.ollama });
      }
      if (context.config.seats.kimi.enabled) {
        arms.push({ arm: "C", primary: context.seats.openai, challenger: context.seats.kimi });
      }
      if (context.config.seats.kimi.enabled && (context.config.seats.openrouterFree.enabled || context.config.seats.ollama.enabled)) {
        arms.push({ arm: "D", primary: context.seats.openai, challenger: context.seats.kimi, arbiter: context.config.seats.openrouterFree.enabled ? context.seats.openrouterFree : context.seats.ollama });
      }
      const labels = blindArmLabels(task.id, arms.map((item) => item.arm));
      for (const setup of arms) {
        const started = Date.now();
        try {
          const store = new RunStore(context.root);
          const result = setup.challenger
            ? await runCouncil({ root: context.root, config: context.config, primary: setup.primary, challenger: setup.challenger, arbiter: setup.arbiter, objective: task.objective, store })
            : await runAsk({ root: context.root, config: context.config, primary: setup.primary, objective: task.objective, store });
          data.evaluations.push({
            id: createId("evaluation"),
            taskId: task.id,
            arm: setup.arm,
            blindLabel: labels.find((item) => item.arm === setup.arm).label,
            status: "complete",
            runId: result.run.id,
            output: result.text,
            latencyMs: Date.now() - started,
            rating: null,
            contribution: null,
            cost: result.run.record.usage?.cost ?? null,
          });
        } catch (error) {
          data.evaluations.push({
            id: createId("evaluation"),
            taskId: task.id,
            arm: setup.arm,
            blindLabel: labels.find((item) => item.arm === setup.arm).label,
            status: "failed",
            error: error.message,
            latencyMs: Date.now() - started,
          });
        }
        await saveBenchmark(context.root, data);
      }
    }
    return { tasksRun: tasks.length, evaluations: data.evaluations.length, text: `Ran ${tasks.length} task(s); ${data.evaluations.length} total evaluation record(s).` };
  }
  if (action === "report") {
    const generated = generateKimiValueReport(data);
    const target = path.join(councilPath(context.root), "evaluations", "kimi-value-report.md");
    await atomicWrite(target, `${generated.markdown}\n`);
    return { ...generated.report, artifact: target, text: generated.markdown };
  }
  throw new ValidationError(`Unknown benchmark action: ${action}`);
}
