import fs from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { buildContextBundle } from "./context.js";
import { buildWorkingTree, reviewWorkingTree } from "./git-workflows.js";
import { runAsk, runCouncil } from "./orchestrator.js";
import { initializeProject, RunStore } from "./store.js";
import { atomicWrite } from "./utils.js";

async function availableSeat(seat) {
  try {
    return Boolean(seat && (await seat.isAvailable()));
  } catch {
    return false;
  }
}

export async function chooseChallenger(context) {
  const explicit = context.flags.challenger;
  if (explicit) {
    if (!context.seats[explicit]) throw new ValidationError(`Unknown challenger seat: ${explicit}`);
    return { seat: context.seats[explicit], explicit: true };
  }
  for (const id of ["kimi", "openrouterFree", "ollama"]) {
    if (context.config.seats[id]?.enabled && (await availableSeat(context.seats[id]))) {
      return { seat: context.seats[id], explicit: false };
    }
  }
  return { seat: null, explicit: false };
}

export async function chooseArbiter(context, automaticExclusions = []) {
  const explicit = context.flags.arbiter;
  if (explicit) {
    if (!context.seats[explicit]) throw new ValidationError(`Unknown arbiter seat: ${explicit}`);
    return context.seats[explicit];
  }
  const excluded = new Set(automaticExclusions);
  for (const id of ["openrouterFree", "ollama"]) {
    if (excluded.has(id)) continue;
    if (context.config.seats[id]?.enabled && (await availableSeat(context.seats[id]))) return context.seats[id];
  }
  return null;
}

function timeoutConfig(config, flag) {
  if (flag === undefined) return config;
  const seconds = Number(flag);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ValidationError("--timeout must be a positive number");
  return { ...config, budgets: { ...config.budgets, timeoutSeconds: seconds } };
}

async function councilOrAsk(objective, context, { forceCouncil = false } = {}) {
  const config = timeoutConfig(context.config, context.flags.timeout);
  const store = new RunStore(context.root, { enabled: !context.flags["no-store"] });
  const bundle = await buildContextBundle(context.root, {
    files: [".council/project.md", ".council/decisions.md", ".council/assumptions.md", ".council/open-questions.md"],
  });
  const { seat: challenger, explicit } = await chooseChallenger(context);
  const useCouncil = forceCouncil && challenger && !context.flags.single;
  if (!useCouncil) {
    const result = await runAsk({
      root: context.root,
      config,
      primary: context.seats.openai,
      objective,
      projectContext: JSON.stringify(bundle),
      projectCommit: bundle.git?.commit || null,
      store,
      signal: context.signal,
    });
    if (forceCouncil) {
      result.degraded = true;
      result.degradedReason = challenger ? "Council disabled by --single" : "No configured challenger available";
    }
    return result;
  }
  return runCouncil({
    root: context.root,
    config,
    primary: context.seats.openai,
    challenger,
    arbiter: await chooseArbiter(context, [challenger.id]),
    objective,
    projectContext: JSON.stringify(bundle),
    projectCommit: bundle.git?.commit || null,
    explicitChallenger: explicit,
    store,
    signal: context.signal,
  });
}

export async function runWorkflowCommand(command, objective, context) {
  if (!objective && ["ask", "council", "plan", "build"].includes(command)) {
    throw new ValidationError(`${command} requires a question or feature`);
  }
  if (context.flags["dry-run"]) {
    return {
      dryRun: true,
      command,
      objective,
      paidInferenceAllowed: context.config.spending.allowPaidInference,
      text: `Dry run: ${command} would process ${JSON.stringify(objective)}. No provider or file mutation performed.`,
    };
  }
  await initializeProject(context.root);
  if (command === "ask") return councilOrAsk(objective, context, { forceCouncil: Boolean(context.flags.council) });
  if (command === "council") return councilOrAsk(objective, context, { forceCouncil: true });
  if (command === "plan") {
    const result = await councilOrAsk(objective, context, { forceCouncil: true });
    const artifact = path.join(context.root, ".council", "artifacts", `${result.run.id}-plan.md`);
    if (!context.flags["no-store"]) await atomicWrite(artifact, `${result.text.trim()}\n`);
    return { ...result, artifact, text: result.text };
  }
  if (command === "review") {
    const reviewers = [];
    for (const id of ["openai", "kimi", "openrouterFree", "ollama"]) {
      if (id === "openai" || context.config.seats[id]?.enabled) reviewers.push(context.seats[id]);
    }
    return reviewWorkingTree({
      root: context.root,
      seats: reviewers,
      timeoutMs: context.config.budgets.timeoutSeconds * 1000,
      store: new RunStore(context.root, { enabled: !context.flags["no-store"] }),
      signal: context.signal,
    });
  }
  if (command === "build") {
    const plan = await councilOrAsk(`Create an implementation plan for: ${objective}`, context, { forceCouncil: true });
    const reviewers = [];
    for (const id of ["kimi", "openrouterFree", "ollama", "openai"]) {
      if (id === "openai" || context.config.seats[id]?.enabled) reviewers.push(context.seats[id]);
    }
    return buildWorkingTree({
      root: context.root,
      writer: context.seats.openai,
      reviewers,
      objective,
      planText: plan.text,
      config: timeoutConfig(context.config, context.flags.timeout),
      store: new RunStore(context.root, { enabled: !context.flags["no-store"] }),
      signal: context.signal,
    });
  }
  throw new ValidationError(`Unsupported workflow command: ${command}`);
}
