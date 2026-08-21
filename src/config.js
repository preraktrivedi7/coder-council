import fs from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { assertLoopbackHost } from "./security.js";
import { clone } from "./utils.js";

export const DEFAULT_CONFIG = Object.freeze({
  runtime: { provider: "opencode", host: "127.0.0.1", port: 4096, autoStart: true },
  seats: {
    openai: { enabled: true, model: "auto", role: "primary" },
    kimi: { enabled: false, model: "auto", role: "challenger" },
    openrouterFree: { enabled: false, model: "openrouter/free", role: "arbiter" },
    ollama: { enabled: false, model: "auto", role: "reviewer" },
  },
  routing: {
    default: "openai",
    dualModelForArchitecture: true,
    dualModelForSecurityReview: true,
    dualModelForHighImpactDecision: true,
  },
  debate: {
    independentFirst: true,
    maxRounds: 1,
    crossCritique: true,
    revision: true,
    preserveDisagreement: true,
  },
  budgets: { maxModelCallsPerRun: 7, timeoutSeconds: 600, maxConcurrentCalls: 2 },
  spending: { allowPaidInference: false, openRouterFreeOnly: true },
  privacy: {
    storePrompts: true,
    storeResponses: true,
    redactEnvironmentSecrets: true,
    telemetry: false,
  },
  evaluation: { enabled: true, blindComparison: true, recordHumanOutcome: true },
  workflows: {
    verificationCommands: ["npm test"],
    allowDirtyBuild: true,
    autoCommit: false,
    autoPush: false,
  },
});

export function stripJsonComments(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      } else result += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        blockComment = false;
      } else result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (!inString && char === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    if (!inString && char === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    result += char;
    if (inString && char === "\\" && !escaped) escaped = true;
    else {
      if (char === '"' && !escaped) inString = !inString;
      escaped = false;
    }
  }
  return result.replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonc(text, source = "configuration") {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new ValidationError(`Invalid ${source}: ${error.message}`);
  }
}

export function mergeConfig(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return clone(override);
  const result = clone(base) || {};
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeConfig(result[key] || {}, value)
        : clone(value);
  }
  return result;
}

function requireBoolean(value, location, errors) {
  if (typeof value !== "boolean") errors.push(`${location} must be boolean`);
}

export function validateConfig(config, { throwOnError = true } = {}) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    errors.push("config must be an object");
  } else {
    if (!Number.isInteger(config.runtime?.port) || config.runtime.port < 1 || config.runtime.port > 65535) {
      errors.push("runtime.port must be an integer from 1 to 65535");
    }
    try {
      assertLoopbackHost(config.runtime?.host);
    } catch (error) {
      errors.push(error.message);
    }
    if (!config.seats?.[config.routing?.default]) {
      errors.push("routing.default must name a configured seat");
    }
    if (config.debate?.independentFirst !== true) {
      errors.push("debate.independentFirst is mandatory");
    }
    if (!Number.isInteger(config.budgets?.maxModelCallsPerRun) || config.budgets.maxModelCallsPerRun < 1) {
      errors.push("budgets.maxModelCallsPerRun must be a positive integer");
    }
    if (!Number.isFinite(config.budgets?.timeoutSeconds) || config.budgets.timeoutSeconds <= 0) {
      errors.push("budgets.timeoutSeconds must be positive");
    }
    if (!Number.isInteger(config.budgets?.maxConcurrentCalls) || config.budgets.maxConcurrentCalls < 1) {
      errors.push("budgets.maxConcurrentCalls must be a positive integer");
    }
    requireBoolean(config.spending?.allowPaidInference, "spending.allowPaidInference", errors);
    requireBoolean(config.spending?.openRouterFreeOnly, "spending.openRouterFreeOnly", errors);
    if (config.privacy?.telemetry !== false) errors.push("privacy.telemetry must remain false");
    if (config.workflows?.autoPush === true || config.workflows?.autoCommit === true) {
      errors.push("automatic commit/push is not supported by the MVP safety contract");
    }
    for (const [id, seat] of Object.entries(config.seats || {})) {
      requireBoolean(seat.enabled, `seats.${id}.enabled`, errors);
      if (typeof seat.model !== "string" || !seat.model) errors.push(`seats.${id}.model is required`);
    }
  }
  const result = { valid: errors.length === 0, errors };
  if (throwOnError && errors.length) throw new ValidationError(errors.join("; "), errors);
  return result;
}

export async function loadConfig(root = process.cwd(), overrides = {}) {
  const candidates = [
    path.join(root, ".council", "config.jsonc"),
    path.join(root, "council.config.json"),
    path.join(root, "council.config.jsonc"),
  ];
  let project = {};
  let source = null;
  for (const candidate of candidates) {
    try {
      project = parseJsonc(await fs.readFile(candidate, "utf8"), candidate);
      source = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, project), overrides);
  validateConfig(config);
  return { config, source };
}

export function serializeDefaultConfig() {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

const CONFIGURABLE_SEATS = new Set(["kimi", "openrouterFree", "ollama"]);
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/;

function findObjectRange(text, property) {
  const pattern = new RegExp(`"${property}"\\s*:\\s*\\{`);
  const match = pattern.exec(text);
  if (!match) return null;
  const start = text.indexOf("{", match.index);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (!inString && char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (!inString && char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (inString && char === "\\" && !escaped) { escaped = true; continue; }
    if (char === '"' && !escaped) inString = !inString;
    escaped = false;
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return null;
}

function replaceSeatField(block, field, serialized) {
  const pattern = new RegExp(`("${field}"\\s*:\\s*)(?:true|false|"(?:\\\\.|[^"\\\\])*")`);
  if (!pattern.test(block)) throw new ValidationError(`Seat configuration is missing ${field}`);
  return block.replace(pattern, (_match, prefix) => `${prefix}${serialized}`);
}

export async function updateSeatConfig(root, seatId, options = {}) {
  const [result] = await updateSeatConfigs(root, [{ seatId, ...options }]);
  return result;
}

async function updateSeatConfigs(root, updates, options = {}) {
  const normalized = updates.map(({ seatId, enabled, model: rawModel }) => {
    if (!CONFIGURABLE_SEATS.has(seatId)) throw new ValidationError(`Seat cannot be configured here: ${seatId || "missing"}`);
    const model = String(rawModel || "").trim();
    if (typeof enabled !== "boolean") throw new ValidationError("Seat enabled state must be boolean");
    if (!model) throw new ValidationError("Seat model is required");
    if (!MODEL_ID.test(model)) throw new ValidationError("Seat model contains unsupported characters");
    if (seatId === "openrouterFree" && model !== "openrouter/free" && !model.endsWith(":free")) {
      throw new ValidationError("OpenRouter setup accepts only openrouter/free or model IDs ending in :free");
    }
    return { seatId, enabled, model };
  });
  const target = path.join(root, ".council", "config.jsonc");
  let original;
  try {
    original = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new ValidationError("Initialize Council before configuring a seat");
    throw error;
  }
  let updated = original;
  for (const { seatId, enabled, model } of normalized) {
    const range = findObjectRange(updated, seatId);
    if (!range) throw new ValidationError(`Seat is missing from ${target}: ${seatId}`);
    let block = updated.slice(range.start, range.end);
    block = replaceSeatField(block, "enabled", String(enabled));
    block = replaceSeatField(block, "model", JSON.stringify(model));
    updated = `${updated.slice(0, range.start)}${block}${updated.slice(range.end)}`;
  }
  if (options.forceFreeOnly) {
    const range = findObjectRange(updated, "spending");
    if (!range) throw new ValidationError(`Spending policy is missing from ${target}`);
    let block = updated.slice(range.start, range.end);
    block = replaceSeatField(block, "allowPaidInference", "false");
    block = replaceSeatField(block, "openRouterFreeOnly", "true");
    updated = `${updated.slice(0, range.start)}${block}${updated.slice(range.end)}`;
  }
  const parsed = mergeConfig(DEFAULT_CONFIG, parseJsonc(updated, target));
  validateConfig(parsed);
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, updated, { mode: 0o600 });
  await fs.rename(temporary, target);
  return normalized.map(({ seatId, enabled, model }) => ({ seat: seatId, enabled, model, path: target }));
}

export async function updateFreeFirstConfig(root, options = {}) {
  const ollamaModel = String(options.ollamaModel || "auto").trim();
  const seats = await updateSeatConfigs(root, [
    { seatId: "openrouterFree", enabled: true, model: "openrouter/free" },
    { seatId: "ollama", enabled: true, model: ollamaModel },
  ], { forceFreeOnly: true });
  return {
    mode: "free-first",
    seats,
    paidFallback: false,
    note: "Only healthy free/local seats run; unavailable seats are skipped without paid fallback.",
  };
}
