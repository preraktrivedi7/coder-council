"use strict";

const OPERATIONS = Object.freeze({
  init: { command: "init", args: [], label: "Initialize project", writesProjectState: true },
  doctor: { command: "doctor", args: [], label: "Run doctor" },
  models: { command: "models", args: [], label: "List models" },
  ask: { command: "ask", args: [], label: "Ask", input: true, providerUsage: true },
  council: { command: "council", args: [], label: "Run Council", input: true, providerUsage: true },
  plan: { command: "plan", args: [], label: "Plan feature", input: true, providerUsage: true, writesProjectState: true },
  review: { command: "review", args: [], label: "Review working tree", providerUsage: true, writesProjectState: true },
  build: { command: "build", args: [], label: "Build feature", input: true, providerUsage: true, mutatesSource: true },
  stats: { command: "stats", args: [], label: "Show stats" },
  benchmarkAdd: { command: "benchmark", args: ["add"], label: "Add benchmark", input: true, writesProjectState: true },
  benchmarkRun: { command: "benchmark", args: ["run"], label: "Run benchmark", providerUsage: true, writesProjectState: true },
  benchmarkPending: { command: "benchmark", args: ["pending"], label: "Pending ratings" },
  benchmarkRate: { command: "benchmark", args: ["rate"], label: "Rate benchmark", input: true, inputKind: "benchmarkRating", writesProjectState: true },
  benchmarkReport: { command: "benchmark", args: ["report"], label: "Benchmark report", writesProjectState: true },
  configShow: { command: "config", args: ["show"], label: "Show config" },
  configValidate: { command: "config", args: ["validate"], label: "Validate config" },
  setupOllama: { command: "config", args: ["seat", "ollama", "enable"], label: "Enable Ollama model", input: true, writesProjectState: true },
  setupOpenrouterFree: { command: "config", args: ["seat", "openrouterFree", "enable", "openrouter/free"], label: "Enable OpenRouter free-only", writesProjectState: true },
  setupFreeFirst: { command: "config", args: ["free-first", "auto"], label: "Enable free-first pool", writesProjectState: true },
  runsList: { command: "runs", args: ["list"], label: "List runs" },
  runsAbandon: { command: "runs", args: ["abandon"], label: "Abandon run", input: true, writesProjectState: true },
  authOpenai: { command: "auth", args: ["openai"], label: "OpenAI setup" },
  authKimi: { command: "auth", args: ["kimi"], label: "Kimi setup" },
});

function resolveOperation(action, input = "") {
  const operation = OPERATIONS[action];
  if (!operation) throw new Error(`Unsupported Council action: ${action}`);
  const normalized = String(input || "").trim();
  if (operation.input && !normalized) throw new Error(`${operation.label} requires input`);
  if (Buffer.byteLength(normalized, "utf8") > 64 * 1024) throw new Error("Council input exceeds 64 KiB");
  let inputArgs = operation.input ? [normalized] : [];
  if (operation.inputKind === "benchmarkRating") {
    const match = normalized.match(
      /^(\S+)\s+([1-5])\s+(none|duplicate|useful-detail|material-improvement|critical-catch|harmful)$/,
    );
    if (!match) {
      throw new Error(
        "Rate benchmark input must be: <evaluation-id> <1..5> <contribution-label>",
      );
    }
    inputArgs = match.slice(1);
  }
  return {
    ...operation,
    args: [...operation.args, ...inputArgs],
  };
}

module.exports = { OPERATIONS, resolveOperation };
