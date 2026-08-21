"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveCodexCommand(command = "codex", options = {}) {
  const value = String(command || "codex").trim() || "codex";
  if (path.isAbsolute(value) || value.includes(path.sep)) return value;

  const executable = options.isExecutable || isExecutable;
  const platform = options.platform || process.platform;
  const searchPaths = String(options.pathValue ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  if (value === "codex" && platform !== "win32") {
    const home = options.homeDir || os.homedir();
    searchPaths.push(path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  }
  for (const directory of [...new Set(searchPaths)]) {
    const candidate = path.join(directory, value);
    if (executable(candidate)) return candidate;
  }
  return value;
}

class CodexAppServerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = options.code ?? null;
    this.data = options.data ?? null;
  }
}

function textInput(content) {
  if (!Array.isArray(content)) return [];
  return content.map((entry) => {
    if (entry?.type === "text") return { type: "text", text: String(entry.text || "") };
    if (entry?.type === "localImage") return { type: "localImage", path: String(entry.path || "") };
    if (entry?.type === "image") return { type: "image", url: String(entry.url || "") };
    if (entry?.type === "skill" || entry?.type === "mention") {
      return { type: entry.type, name: String(entry.name || ""), path: String(entry.path || "") };
    }
    return { type: "attachment", label: entry?.type ? String(entry.type) : "attachment" };
  });
}

function boundedText(value, limit = 2 * 1024 * 1024) {
  const text = typeof value === "string" ? value : "";
  return Buffer.byteLength(text, "utf8") <= limit ? text : `${text.slice(0, limit)}\n… output truncated by Council`;
}

function sanitizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const base = { id: String(item.id || ""), type: String(item.type || "unknown") };
  switch (item.type) {
    case "userMessage":
      return { ...base, content: textInput(item.content) };
    case "agentMessage":
      return { ...base, text: boundedText(item.text), phase: item.phase ?? null };
    case "plan":
      return { ...base, text: boundedText(item.text) };
    case "reasoning":
      // App Server may expose private reasoning content. Council deliberately forwards
      // only the provider-authored concise summary.
      return { ...base, summary: Array.isArray(item.summary) ? item.summary.map((part) => boundedText(part, 64 * 1024)) : [] };
    case "commandExecution":
      return {
        ...base,
        command: boundedText(item.command, 64 * 1024),
        cwd: String(item.cwd || ""),
        status: item.status || "inProgress",
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
        aggregatedOutput: boundedText(item.aggregatedOutput),
      };
    case "fileChange":
      return {
        ...base,
        status: item.status || "inProgress",
        changes: Array.isArray(item.changes)
          ? item.changes.map((change) => ({
              path: String(change.path || ""),
              kind: change.kind || "update",
              diff: boundedText(change.diff),
            }))
          : [],
      };
    case "mcpToolCall":
      return {
        ...base,
        server: String(item.server || ""),
        tool: String(item.tool || ""),
        status: item.status || "inProgress",
        error: item.error?.message ? String(item.error.message) : null,
      };
    case "webSearch":
      return { ...base, query: boundedText(item.query, 16 * 1024), status: item.status || null };
    case "imageView":
      return { ...base, path: String(item.path || "") };
    default:
      return base;
  }
}

function sanitizeTurn(turn) {
  return {
    id: String(turn?.id || ""),
    status: turn?.status || "unknown",
    startedAt: turn?.startedAt ?? null,
    completedAt: turn?.completedAt ?? null,
    durationMs: turn?.durationMs ?? null,
    error: turn?.error?.message ? String(turn.error.message) : null,
    items: Array.isArray(turn?.items) ? turn.items.map(sanitizeItem).filter(Boolean) : [],
  };
}

function sanitizeThread(thread, options = {}) {
  if (!thread || typeof thread !== "object") return null;
  return {
    id: String(thread.id || ""),
    name: thread.name ? String(thread.name) : null,
    preview: boundedText(thread.preview, 16 * 1024),
    cwd: String(thread.cwd || ""),
    modelProvider: String(thread.modelProvider || ""),
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    status: thread.status || null,
    source: thread.source || null,
    canAcceptDirectInput: thread.canAcceptDirectInput ?? null,
    turns: options.includeTurns && Array.isArray(thread.turns) ? thread.turns.map(sanitizeTurn) : [],
  };
}

function sanitizeNotification(method, params) {
  const common = {
    threadId: params?.threadId ? String(params.threadId) : null,
    turnId: params?.turnId ? String(params.turnId) : null,
  };
  switch (method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
      return { method, ...common, itemId: String(params?.itemId || ""), delta: boundedText(params?.delta, 256 * 1024) };
    case "item/started":
    case "item/completed":
      return { method, ...common, item: sanitizeItem(params?.item) };
    case "item/commandExecution/outputDelta":
      return { method, ...common, itemId: String(params?.itemId || ""), delta: boundedText(params?.delta, 256 * 1024) };
    case "turn/diff/updated":
      return { method, ...common, diff: boundedText(params?.diff) };
    case "turn/started":
    case "turn/completed":
      return { method, ...common, turn: params?.turn ? sanitizeTurn(params.turn) : null };
    case "thread/name/updated":
      return { method, ...common, name: params?.name ? String(params.name) : null };
    case "thread/status/changed":
      return { method, ...common, status: params?.status || null };
    case "error":
      return { method, ...common, message: String(params?.error?.message || params?.message || "Codex error") };
    default:
      return null;
  }
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawnImpl = options.spawnImpl || spawn;
    this.command = resolveCodexCommand(options.command || "codex", options.resolveOptions);
    this.cwd = options.cwd || process.cwd();
    this.output = options.output || { append() {}, appendLine() {} };
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.initialized = false;
  }

  get connected() {
    return Boolean(this.child && this.initialized);
  }

  async start() {
    if (this.connected) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
      return this;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    const child = this.spawnImpl(this.command, ["app-server"], {
      cwd: this.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = "";
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => this.output.append(chunk.toString("utf8")));
    child.on("error", (error) => this.onExit(new CodexAppServerError(`Unable to start Codex App Server: ${error.message}`)));
    child.on("close", (code, signal) => {
      const suffix = signal ? ` (${signal})` : "";
      this.onExit(new CodexAppServerError(`Codex App Server exited with code ${code ?? "unknown"}${suffix}`, { code }));
    });
    try {
      await this.requestRaw("initialize", {
        clientInfo: { name: "coder_council_vscode", title: "Coder Council Coding Workspace", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      this.initialized = true;
      this.output.appendLine("[codex] App Server connected");
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  onStdout(chunk) {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES) {
      this.onExit(new CodexAppServerError("Codex App Server message exceeded 8 MiB"));
      this.child?.kill("SIGTERM");
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.output.appendLine(`[codex] Ignored invalid JSON: ${error.message}`);
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id !== undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new CodexAppServerError(message.error.message || "Codex request failed", {
          code: message.error.code,
          data: message.error.data,
        }));
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", { id: message.id, method: message.method, params: message.params || {} });
      return;
    }
    if (message.method) this.emit("notification", { method: message.method, params: message.params || {} });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new CodexAppServerError("Codex App Server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  requestRaw(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}) {
    await this.start();
    return this.requestRaw(method, params);
  }

  notify(method, params = {}) {
    this.write(Object.keys(params).length ? { method, params } : { method });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  async listThreads(options = {}) {
    const params = { limit: options.limit || 100, sortKey: "updated_at", sortDirection: "desc" };
    if (options.cwd) params.cwd = options.cwd;
    if (options.cursor) params.cursor = options.cursor;
    if (options.searchTerm) params.searchTerm = options.searchTerm;
    const response = await this.request("thread/list", params);
    return {
      data: Array.isArray(response?.data) ? response.data.map((thread) => sanitizeThread(thread)) : [],
      nextCursor: response?.nextCursor || null,
    };
  }

  async listAllThreads(options = {}) {
    const data = [];
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.listThreads({ ...options, cursor, limit: Math.min(options.limit || 100, 100) });
      data.push(...response.data);
      cursor = response.nextCursor;
      if (!cursor) return { data, truncated: false };
    }
    return { data, truncated: true };
  }

  async readThread(threadId) {
    const response = await this.request("thread/read", { threadId, includeTurns: false });
    if (!response?.thread) return null;
    const turns = [];
    let cursor = null;
    for (let page = 0; page < 100; page += 1) {
      const pageResponse = await this.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      });
      if (Array.isArray(pageResponse?.data)) turns.push(...pageResponse.data);
      cursor = pageResponse?.nextCursor || null;
      if (!cursor) break;
    }
    return sanitizeThread({ ...response.thread, turns }, { includeTurns: true });
  }

  async resumeThread(threadId, cwd) {
    const response = await this.request("thread/resume", { threadId, cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
    return sanitizeThread(response?.thread, { includeTurns: true });
  }

  async startThread(options = {}) {
    const response = await this.request("thread/start", {
      cwd: options.cwd,
      model: options.model || null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      personality: "pragmatic",
    });
    return sanitizeThread(response?.thread, { includeTurns: true });
  }

  async startTurn(options) {
    const readOnly = options.mode === "ask" || options.mode === "plan" || options.mode === "review";
    const input = [{ type: "text", text: String(options.prompt || "") }];
    const params = {
      threadId: options.threadId,
      input,
      cwd: options.cwd,
      approvalPolicy: "on-request",
      sandboxPolicy: readOnly
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", writableRoots: [options.cwd], networkAccess: false },
    };
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    const additionalContext = {};
    if (options.context) additionalContext.activeEditor = { kind: "untrusted", value: options.context };
    if (options.modeInstruction) additionalContext.councilMode = { kind: "application", value: options.modeInstruction };
    if (Object.keys(additionalContext).length) params.additionalContext = additionalContext;
    return this.request("turn/start", params);
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async listModels() {
    const response = await this.request("model/list", { limit: 100 });
    return Array.isArray(response?.data)
      ? response.data.map((model) => ({
          id: String(model.id || model.model || ""),
          displayName: String(model.displayName || model.id || model.model || ""),
          description: model.description ? String(model.description) : "",
          defaultEffort: model.defaultReasoningEffort || null,
          supportedEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort || entry).filter(Boolean)
            : [],
        }))
      : [];
  }

  async listSkills(cwd) {
    const response = await this.request("skills/list", { cwds: [cwd], forceReload: false });
    return Array.isArray(response?.data)
      ? response.data.flatMap((group) => (group.skills || []).map((skill) => ({ name: skill.name, description: skill.description || "" })))
      : [];
  }

  onExit(error) {
    if (!this.child) return;
    this.child = null;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }

  dispose() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = false;
    child.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerError("Codex App Server stopped"));
    }
    this.pending.clear();
  }
}

module.exports = {
  CodexAppServerClient,
  CodexAppServerError,
  resolveCodexCommand,
  sanitizeItem,
  sanitizeNotification,
  sanitizeThread,
  sanitizeTurn,
};
