import path from "node:path";
import { loadConfig, updateFreeFirstConfig, updateSeatConfig, validateConfig } from "./config.js";
import { EXIT_CODES, ValidationError } from "./errors.js";
import { createSeatRegistry } from "./seats/index.js";
import { initializeProject, listRuns, markRunAbandoned } from "./store.js";
import { doctorReport } from "./doctor.js";
import { runWorkflowCommand } from "./commands.js";
import { statsReport } from "./stats.js";
import { runBenchmarkCommand } from "./benchmark.js";

const HELP = `Coder Council — your AI coding team

Usage:
  coder-council <command> [arguments] [flags]

Commands:
  setup                        Initialize safely and enable free/local model seats
  init                         Initialize .council project state
  doctor                       Check runtime, auth, models, and safety policy
  auth <openai|kimi>           Delegate authentication to provider runtime
  models                       List configured and available models
  ask <question>               Run the primary seat
  council <question>           Run isolated candidates and synthesis
  plan <feature>               Create a persisted plan without editing source
  review                       Review the current git diff (read-only)
  build <feature>              Run one-writer implementation workflow
  stats                        Aggregate persisted run statistics
  benchmark <add|run|report>   Manage the Kimi-value benchmark
  config <show|validate>       Display or validate project configuration
  config seat <id> <state>     Enable or disable an optional model seat
  config free-first [model]    Enable OpenRouter free + local Ollama seats
  runs <list|abandon>          Inspect or safely close incomplete runs

Flags:
  --single                     Force primary-only mode
  --council                    Force Council mode
  --openai-model <id>          Override OpenAI model
  --kimi-model <id>            Override Kimi model
  --challenger <seat>          Select challenger seat
  --arbiter <seat>             Select arbiter seat
  --verbose                    Include stage details
  --json                       Emit JSON only on stdout
  --no-store                   Do not persist the run
  --timeout <seconds>          Override timeout
  --dry-run                    Print intended actions without provider calls
`;

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const valueFlags = new Set([
    "openai-model",
    "kimi-model",
    "challenger",
    "arbiter",
    "timeout",
    "root",
    "period",
    "rating",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawName, inline] = token.slice(2).split(/=(.*)/s);
    if (valueFlags.has(rawName)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.startsWith("--")) throw new ValidationError(`--${rawName} requires a value`);
      flags[rawName] = value;
    } else flags[rawName] = inline ?? true;
  }
  return { positionals, flags };
}

function output(value, { json = false, stream = process.stdout } = {}) {
  if (json) stream.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === "string") stream.write(`${value.trimEnd()}\n`);
  else stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const environment = io.env || process.env;
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift();
  const json = Boolean(flags.json);
  const root = path.resolve(flags.root || io.cwd || process.cwd());
  if (!command || command === "help" || command === "--help" || flags.help) {
    output(HELP, { stream: stdout });
    return EXIT_CODES.OK;
  }

  if (command === "init") {
    const result = await initializeProject(root);
    output(result, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  if (command === "setup") {
    const initialized = await initializeProject(root);
    const freeFirst = await updateFreeFirstConfig(root, { ollamaModel: "auto" });
    const { config, source } = await loadConfig(root);
    const context = {
      root,
      config,
      source,
      flags,
      json,
      stdout,
      stderr,
      environment,
      signal: io.signal,
      io,
    };
    context.seats = io.seats || (await createSeatRegistry(context));
    const doctor = await doctorReport(context);
    const ready = Object.entries(doctor.checks)
      .filter(([id, check]) => ["openai", "openrouterFree", "ollama"].includes(id) && check.available)
      .map(([id]) => id);
    const nextSteps = [];
    if (!doctor.checks.codex.ok && !doctor.checks.opencode.ok) {
      nextSteps.push("Install Codex CLI: curl -fsSL https://chatgpt.com/codex/install.sh | sh");
    }
    if (!doctor.checks.openai.ok) nextSteps.push("Authenticate once: codex login");
    if (!doctor.checks.openrouterFree.available) {
      nextSteps.push("Optional free cloud pool: export OPENROUTER_API_KEY in the shell that launches VS Code");
    }
    if (!doctor.checks.ollama.available) nextSteps.push("Optional local pool: install Ollama, start it, and pull a coding model");
    const result = {
      ok: true,
      initialized,
      freeFirst,
      ready,
      doctor,
      nextSteps,
      text: [
        "Coder Council setup complete",
        `Project.................... ${initialized.root}`,
        `Ready inference paths..... ${ready.length ? ready.join(", ") : "none yet"}`,
        "Paid cloud fallback....... DISABLED",
        "Telemetry.................. DISABLED",
        ...(nextSteps.length ? ["", "Next steps:", ...nextSteps.map((step, index) => `${index + 1}. ${step}`)] : ["", "Ready. Open VS Code and select the Coder Council icon."]),
      ].join("\n"),
    };
    output(json ? result : result.text, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  const { config, source } = await loadConfig(root);
  const context = { root, config, source, flags, json, stdout, stderr, environment, signal: io.signal, io };

  if (command === "config") {
    const action = positionals[0] || "show";
    if (action === "show") output(config, { json, stream: stdout });
    else if (action === "validate") output(validateConfig(config, { throwOnError: false }), { json, stream: stdout });
    else if (action === "seat") {
      const seatId = positionals[1];
      const state = positionals[2];
      if (!new Set(["enable", "disable"]).has(state)) {
        throw new ValidationError("Config seat state must be enable or disable");
      }
      const model = positionals[3] || config.seats?.[seatId]?.model;
      output(await updateSeatConfig(root, seatId, { enabled: state === "enable", model }), { json, stream: stdout });
    }
    else if (action === "free-first") {
      output(await updateFreeFirstConfig(root, { ollamaModel: positionals[1] || "auto" }), { json, stream: stdout });
    }
    else throw new ValidationError(`Unknown config action: ${action}`);
    return EXIT_CODES.OK;
  }

  if (command === "doctor") {
    context.seats = io.seats || (await createSeatRegistry(context));
    const report = await doctorReport(context);
    output(json ? report : report.text, { json, stream: stdout });
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.PROVIDER_UNAVAILABLE;
  }

  if (command === "runs") {
    const action = positionals.shift() || "list";
    if (action === "list") output(await listRuns(root), { json, stream: stdout });
    else if (action === "abandon") output(await markRunAbandoned(root, positionals[0]), { json, stream: stdout });
    else throw new ValidationError(`Unknown runs action: ${action}`);
    return EXIT_CODES.OK;
  }

  const seats = io.seats || (await createSeatRegistry(context));
  context.seats = seats;

  if (command === "models") {
    const models = [];
    for (const [id, seat] of Object.entries(seats)) {
      const health = await seat.health();
      models.push({ seat: id, health, models: health.available ? await seat.listModels() : [] });
    }
    output(models, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  if (command === "auth") {
    const provider = positionals[0];
    if (!seats[provider]?.authenticate) throw new ValidationError(`Unsupported auth provider: ${provider || "missing"}`);
    const result = await seats[provider].authenticate({ dryRun: flags["dry-run"] });
    output(result, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  if (["ask", "council", "plan", "review", "build"].includes(command)) {
    const result = await runWorkflowCommand(command, positionals.join(" "), context);
    output(json ? result : result.text || result, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  if (command === "stats") {
    const result = await statsReport(root, { period: flags.period });
    output(json ? result : result.text, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  if (command === "benchmark") {
    const result = await runBenchmarkCommand(positionals.shift(), positionals, context);
    output(json ? result : result.text || result, { json, stream: stdout });
    return EXIT_CODES.OK;
  }

  throw new ValidationError(`Unknown command: ${command}`);
}

export { HELP };
