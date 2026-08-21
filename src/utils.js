import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { TimeoutError } from "./errors.js";

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function createId(prefix = "run") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function isoNow() {
  return new Date().toISOString();
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWrite(target, contents) {
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function writeJson(target, value) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(target, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return clone(fallback);
    throw error;
  }
}

export function combineSignals(...signals) {
  const usable = signals.filter(Boolean);
  if (usable.length === 0) return undefined;
  return AbortSignal.any(usable);
}

export async function withTimeout(operation, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const signal = combineSignals(controller.signal, outerSignal);
  const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
  timer.unref?.();
  try {
    return await operation(signal);
  } catch (error) {
    if (controller.signal.aborted && !outerSignal?.aborted) throw new TimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    signal,
    timeoutMs = 30_000,
    input,
    maxBytes = 4 * 1024 * 1024,
    shell = false,
  } = options;
  return withTimeout(
    (timedSignal) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          signal: timedSignal,
          shell,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const collect = (current, chunk) =>
          (current + chunk.toString("utf8")).slice(-maxBytes);
        child.stdout.on("data", (chunk) => (stdout = collect(stdout, chunk)));
        child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
        child.on("error", reject);
        child.on("close", (code, closeSignal) =>
          resolve({ code, signal: closeSignal, stdout, stderr }),
        );
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
      }),
    timeoutMs,
    signal,
  );
}

export function unwrapData(value) {
  return value?.data ?? value;
}
