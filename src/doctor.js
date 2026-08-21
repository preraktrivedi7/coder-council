import { environmentCredentialNames, isLoopbackHost } from "./security.js";
import { runCommand } from "./utils.js";

async function commandVersion(command, args = ["--version"]) {
  try {
    const result = await runCommand(command, args, { timeoutMs: 3_000 });
    return {
      available: result.code === 0,
      version: result.code === 0 ? (result.stdout || result.stderr).trim() : null,
    };
  } catch {
    return { available: false, version: null };
  }
}

function line(name, status, detail = "") {
  return `${name.padEnd(27, ".")} ${status}${detail ? ` ${detail}` : ""}`;
}

export async function doctorReport(context) {
  const { config, seats, environment = process.env } = context;
  const [git, codex, opencode, openai, kimi, openrouter, ollama] = await Promise.all([
    commandVersion("git"),
    commandVersion("codex"),
    commandVersion("opencode"),
    seats?.openai?.health() || { available: false },
    seats?.kimi?.health() || { available: false },
    seats?.openrouterFree?.health() || { available: false },
    seats?.ollama?.health() || { available: false },
  ]);
  const checks = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 20, version: process.version },
    git: { ok: git.available, version: git.version },
    codex: { ok: codex.available, version: codex.version },
    opencode: { ok: opencode.available, version: opencode.version },
    openai: { ok: Boolean(openai.available), ...openai },
    kimi: { ok: true, configured: config.seats.kimi.enabled, ...kimi },
    openrouterFree: { ok: true, configured: config.seats.openrouterFree.enabled, ...openrouter },
    ollama: { ok: true, configured: config.seats.ollama.enabled, ...ollama },
    config: { ok: true },
    loopback: { ok: isLoopbackHost(config.runtime.host), host: config.runtime.host },
    paidInference: { ok: config.spending.allowPaidInference === false, enabled: config.spending.allowPaidInference },
    telemetry: { ok: config.privacy.telemetry === false, enabled: config.privacy.telemetry },
    credentialEnvironmentNames: environmentCredentialNames(environment),
  };
  const ok = checks.node.ok && checks.git.ok && checks.openai.ok && checks.loopback.ok && checks.paidInference.ok;
  const councilCapable = [kimi, openrouter, ollama].some((seat, index) => {
    const id = ["kimi", "openrouterFree", "ollama"][index];
    return config.seats[id].enabled && seat.available;
  });
  const text = [
    "Coder Council doctor",
    line("Node", checks.node.ok ? "OK" : "FAIL", checks.node.version),
    line("Git", checks.git.ok ? "OK" : "MISSING", checks.git.version || ""),
    line("OpenCode", checks.opencode.ok ? "OK" : "NOT INSTALLED", checks.opencode.version || ""),
    line("Codex CLI", checks.codex.ok ? "OK" : "NOT INSTALLED", checks.codex.version || ""),
    line("OpenAI seat", checks.openai.ok ? "OK" : "UNAVAILABLE", checks.openai.mode || ""),
    line("Kimi seat", config.seats.kimi.enabled ? (kimi.available ? "OK" : "UNAVAILABLE") : "NOT CONFIGURED"),
    line("OpenRouter free", config.seats.openrouterFree.enabled ? (openrouter.available ? "OK" : "UNAVAILABLE") : "NOT CONFIGURED"),
    line("Ollama", ollama.available ? "OK" : (ollama.serverAvailable ? "MODEL UNAVAILABLE" : "NOT RUNNING")),
    line("Project config", "OK"),
    line("Loopback binding", checks.loopback.ok ? "OK" : "FAIL", config.runtime.host),
    line("Paid inference", config.spending.allowPaidInference ? "ENABLED" : "DISABLED"),
    line("Telemetry", config.privacy.telemetry ? "ENABLED" : "DISABLED"),
    line("Mode", councilCapable ? "COUNCIL-CAPABLE" : "OPENAI-ONLY"),
  ].join("\n");
  return { ok, checks, text };
}
