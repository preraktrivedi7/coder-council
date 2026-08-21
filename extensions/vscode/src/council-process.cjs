"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

class CouncilAdapterError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CouncilAdapterError";
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr || "";
    this.result = options.result ?? null;
  }
}

function isJavaScriptFile(file) {
  return /\.(?:c?js|mjs)$/i.test(file);
}

function existingCouncilScript(workspaceRoot, extensionRoot, existsSync = fs.existsSync) {
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, "bin", "council.js") : null,
    extensionRoot ? path.resolve(extensionRoot, "..", "..", "bin", "council.js") : null,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function resolveCouncilInvocation(options = {}) {
  const {
    commandPath = "",
    nodePath = "node",
    workspaceRoot,
    extensionRoot,
    existsSync = fs.existsSync,
  } = options;
  const selected = commandPath || existingCouncilScript(workspaceRoot, extensionRoot, existsSync);
  if (!selected) return { command: "council", args: [], source: "PATH" };
  const absolute = path.isAbsolute(selected) ? selected : path.resolve(workspaceRoot || process.cwd(), selected);
  if (isJavaScriptFile(absolute)) return { command: nodePath, args: [absolute], source: absolute };
  return { command: absolute, args: [], source: absolute };
}

function appendBounded(current, chunk, limit) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) > limit) throw new CouncilAdapterError(`Council output exceeded ${limit} bytes`);
  return next;
}

class CouncilProcessAdapter {
  constructor(options = {}) {
    this.spawnImpl = options.spawnImpl || spawn;
    this.invocationResolver = options.invocationResolver || resolveCouncilInvocation;
    this.output = options.output || { append() {}, appendLine() {} };
    this.extensionRoot = options.extensionRoot || null;
    this.maxOutputBytes = options.maxOutputBytes || 4 * 1024 * 1024;
    this.current = null;
  }

  get busy() {
    return Boolean(this.current);
  }

  cancel() {
    if (!this.current) return false;
    this.current.cancelled = true;
    this.current.child.kill("SIGTERM");
    return true;
  }

  dispose() {
    this.cancel();
  }

  async run(operation, operationArgs = [], options = {}) {
    if (this.current) throw new CouncilAdapterError("Another Council command is already running");
    const root = path.resolve(options.root || process.cwd());
    const timeoutSeconds = Number(options.timeoutSeconds || 600);
    const maxOutputBytes = Number(options.maxOutputBytes || this.maxOutputBytes);
    const invocation = this.invocationResolver({
      commandPath: options.commandPath || "",
      nodePath: options.nodePath || "node",
      workspaceRoot: root,
      extensionRoot: this.extensionRoot,
    });
    const args = [
      ...invocation.args,
      "--json",
      "--root",
      root,
      "--timeout",
      String(timeoutSeconds),
      "--",
      operation,
      ...operationArgs.map(String),
    ];
    this.output.appendLine(`> ${invocation.command} ${args.map((value) => JSON.stringify(value)).join(" ")}`);

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let outputError = null;
      const child = this.spawnImpl(invocation.command, args, {
        cwd: root,
        env: options.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const active = { child, cancelled: false };
      this.current = active;
      const hardTimeout = setTimeout(() => {
        active.cancelled = true;
        child.kill("SIGTERM");
      }, Math.max(1, timeoutSeconds) * 1000 + 5_000);
      hardTimeout.unref?.();

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        if (this.current === active) this.current = null;
        if (error) reject(error);
        else resolve(value);
      };

      child.stdout.on("data", (chunk) => {
        try {
          stdout = appendBounded(stdout, chunk, maxOutputBytes);
        } catch (error) {
          outputError = error;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          stderr = appendBounded(stderr, chunk, maxOutputBytes);
          this.output.append(chunk.toString("utf8"));
          options.onProgress?.(chunk.toString("utf8"));
        } catch (error) {
          outputError = error;
          child.kill("SIGTERM");
        }
      });
      child.on("error", (error) => finish(new CouncilAdapterError(`Unable to start Council: ${error.message}`)));
      child.on("close", (code, signal) => {
        if (outputError) return finish(outputError);
        if (active.cancelled) {
          return finish(new CouncilAdapterError("Council command cancelled", { exitCode: 130, stderr }));
        }
        let parsed = null;
        if (stdout.trim()) {
          try {
            parsed = JSON.parse(stdout.trim());
          } catch (error) {
            return finish(
              new CouncilAdapterError(`Council returned invalid JSON: ${error.message}`, {
                exitCode: code,
                stderr,
              }),
            );
          }
        }
        if (code !== 0) {
          const message = parsed?.error?.message || stderr.trim() || `Council exited with code ${code}${signal ? ` (${signal})` : ""}`;
          return finish(new CouncilAdapterError(message, { exitCode: code, stderr, result: parsed }));
        }
        if (!parsed) return finish(new CouncilAdapterError("Council returned no JSON result", { exitCode: code, stderr }));
        finish(null, parsed);
      });
    });
  }
}

module.exports = {
  CouncilAdapterError,
  CouncilProcessAdapter,
  existingCouncilScript,
  resolveCouncilInvocation,
};
