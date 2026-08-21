"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const { CodexAppServerClient, sanitizeNotification } = require("./codex-app-server.cjs");
const { CouncilProcessAdapter } = require("./council-process.cjs");
const { resolveOperation } = require("./operations.cjs");
const { normalizeWorkspaceAttachments } = require("./workspace-files.cjs");
const { sidebarHtml, webviewHtml } = require("./webview.cjs");

const VIEW_ID = "council.control";
const PANEL_TYPE = "council.codingWorkspace";
const THREAD_KEY = "council.currentCodexThread";
const SAFE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/;

function workspaceRoot() {
  const active = vscode.window.activeTextEditor?.document?.uri;
  const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : null;
  return activeFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function configuration(root) {
  const scope = root ? vscode.Uri.file(root) : undefined;
  const config = vscode.workspace.getConfiguration("council", scope);
  return {
    commandPath: config.get("commandPath", ""),
    codexPath: config.get("codexPath", "codex"),
    nodePath: config.get("nodePath", "node"),
    defaultMode: config.get("defaultMode", "code"),
    timeoutSeconds: config.get("timeoutSeconds", 600),
    confirmBuild: config.get("confirmBuild", true),
    maxOutputBytes: config.get("maxOutputBytes", 4 * 1024 * 1024),
  };
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class CouncilWorkspaceController {
  constructor(context, adapter, output, status) {
    this.context = context;
    this.adapter = adapter;
    this.output = output;
    this.status = status;
    this.panel = null;
    this.panelReady = false;
    this.sidebar = null;
    this.codex = null;
    this.codexRoot = null;
    this.codexCommand = null;
    this.currentThread = null;
    this.currentTurnId = null;
    this.pendingRoute = null;
    this.doctorPromise = null;
    this.lastDoctor = null;
  }

  dispose() {
    this.codex?.dispose();
  }

  resolveSidebar(view) {
    this.sidebar = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = sidebarHtml(view.webview, this.context.extensionUri, vscode);
    view.webview.onDidReceiveMessage((message) => this.onSidebarMessage(message), null, this.context.subscriptions);
    view.onDidDispose(() => { if (this.sidebar === view) this.sidebar = null; }, null, this.context.subscriptions);
  }

  async onSidebarMessage(message) {
    if (message?.type === "ready" || message?.type === "refresh") return this.refreshSidebar();
    if (message?.type === "openWorkspace") return this.openWorkspace();
    if (message?.type === "newThread") {
      this.openWorkspace();
      return this.newThread();
    }
    if (message?.type === "setup") return this.openWorkspace("setup");
    if (message?.type === "selectThread") {
      this.openWorkspace();
      return this.selectThread(message.threadId);
    }
  }

  openWorkspace(route = null) {
    if (route) this.pendingRoute = route;
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, true);
      if (route) this.postPanel({ type: "navigate", route });
      return this.panel;
    }
    this.panelReady = false;
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      "Coder Council Coding Workspace",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "council.svg");
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, vscode);
    panel.webview.onDidReceiveMessage((message) => this.onPanelMessage(message), null, this.context.subscriptions);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
        this.panelReady = false;
      }
    }, null, this.context.subscriptions);
    return panel;
  }

  postPanel(message) {
    return this.panel?.webview.postMessage(message);
  }

  postSidebar(message) {
    return this.sidebar?.webview.postMessage(message);
  }

  postError(error) {
    const message = errorMessage(error);
    this.output.appendLine(`[error] ${message}`);
    if (this.panel) this.postPanel({ type: "error", message });
    else vscode.window.showErrorMessage(`Coder Council: ${message}`);
  }

  requireRootAndTrust() {
    const root = workspaceRoot();
    if (!root) throw new Error("Open a folder or workspace before running Codex or Council");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before executing local coding tools");
    return root;
  }

  ensureCodex(root) {
    const command = configuration(root).codexPath;
    if (this.codex && samePath(this.codexRoot, root) && this.codexCommand === command) return this.codex;
    this.codex?.dispose();
    const client = new CodexAppServerClient({ command, cwd: root, output: this.output });
    this.codex = client;
    this.codexRoot = root;
    this.codexCommand = command;
    client.on("notification", ({ method, params }) => {
      const event = sanitizeNotification(method, params);
      if (!event) return;
      if (method === "turn/started") this.currentTurnId = event.turn?.id || event.turnId;
      if (method === "turn/completed") this.currentTurnId = null;
      this.postPanel({ type: "codexEvent", event });
    });
    client.on("serverRequest", (request) => this.handleServerRequest(client, request));
    client.on("disconnect", (error) => {
      this.postPanel({ type: "shell", workspace: workspaceRoot(), trusted: vscode.workspace.isTrusted, codexConnected: false });
      this.output.appendLine(`[codex] ${error.message}`);
    });
    return client;
  }

  async onPanelMessage(message) {
    if (!message || typeof message !== "object") return;
    try {
      if (message.type === "ready") {
        this.panelReady = true;
        return this.loadWorkspace(message.scope || "workspace");
      }
      if (message.type === "refresh") return this.loadWorkspace(message.scope || "workspace", { forceDoctor: true });
      if (message.type === "listThreads") return this.listThreads(message.scope, message.search);
      if (message.type === "selectThread") return this.selectThread(message.threadId);
      if (message.type === "refreshThread") return this.refreshThread();
      if (message.type === "newThread") return this.newThread(message.model || "");
      if (message.type === "send") return this.send(message);
      if (message.type === "stop") return this.stop();
      if (message.type === "getSetup") return this.showSetup(true);
      if (message.type === "setupAction") return this.setupAction(message.action);
      if (message.type === "openFile") return this.openFile(message.path);
      if (message.type === "trust") return vscode.commands.executeCommand("workbench.trust.manage");
      if (message.type === "context") return this.postEditorContext(message.enabled !== false);
      if (message.type === "pickFiles") return this.pickFiles();
      if (message.type === "copy") return vscode.env.clipboard.writeText(String(message.text || "").slice(0, 1024 * 1024));
      if (message.type === "openExternal") {
        const target = String(message.url || "");
        if (!/^https:\/\//i.test(target)) throw new Error("Only HTTPS links can be opened from model output");
        return vscode.env.openExternal(vscode.Uri.parse(target));
      }
    } catch (error) {
      this.postError(error);
    }
  }

  async loadWorkspace(scope = "workspace", options = {}) {
    const root = workspaceRoot();
    const trusted = vscode.workspace.isTrusted;
    this.postPanel({
      type: "shell",
      workspace: root,
      trusted,
      codexConnected: this.codex?.connected || false,
      defaultMode: configuration(root).defaultMode,
    });
    if (!root || !trusted) return;
    const codex = this.ensureCodex(root);
    try {
      await codex.start();
      this.postPanel({ type: "shell", workspace: root, trusted, codexConnected: true, defaultMode: configuration(root).defaultMode });
      const [models] = await Promise.all([
        codex.listModels(),
        this.listThreads(scope),
      ]);
      this.postPanel({ type: "models", models });
      const savedThread = this.context.workspaceState.get(THREAD_KEY);
      if (!this.currentThread && savedThread) {
        try { await this.selectThread(savedThread); } catch { await this.context.workspaceState.update(THREAD_KEY, undefined); }
      } else if (this.currentThread) await this.refreshThread();
      this.postEditorContext(true);
      if (this.pendingRoute) {
        const route = this.pendingRoute;
        this.pendingRoute = null;
        this.postPanel({ type: "navigate", route });
      }
      if (options.forceDoctor) await this.showSetup(false, true);
    } catch (error) {
      this.postPanel({ type: "threads", threads: [], error: errorMessage(error) });
      this.postError(error);
    }
  }

  async listThreads(scope = "workspace", search = "") {
    const root = this.requireRootAndTrust();
    const codex = this.ensureCodex(root);
    const response = await codex.listAllThreads({ cwd: scope === "all" ? null : root, searchTerm: String(search || "").trim() });
    this.postPanel({ type: "threads", threads: response.data, scope, truncated: response.truncated });
    return response.data;
  }

  async selectThread(threadId) {
    if (!threadId) return;
    const root = this.requireRootAndTrust();
    const codex = this.ensureCodex(root);
    const thread = await codex.readThread(String(threadId));
    if (!thread) throw new Error("Codex thread was not found");
    this.currentThread = thread;
    await this.context.workspaceState.update(THREAD_KEY, thread.id);
    this.postPanel({ type: "thread", thread });
    return thread;
  }

  async refreshThread() {
    if (!this.currentThread?.id) return;
    return this.selectThread(this.currentThread.id);
  }

  async newThread(model = "") {
    this.openWorkspace();
    const root = this.requireRootAndTrust();
    const codex = this.ensureCodex(root);
    const thread = await codex.startThread({ cwd: root, model: model || null });
    this.currentThread = thread;
    await this.context.workspaceState.update(THREAD_KEY, thread.id);
    this.postPanel({ type: "thread", thread });
    await this.listThreads("workspace");
    return thread;
  }

  modeInstruction(mode) {
    if (mode === "plan") return "Plan mode: inspect the project and produce a concrete plan. Do not edit files or mutate the workspace.";
    if (mode === "ask") return "Ask mode: answer the question using read-only project inspection. Do not edit files or mutate the workspace.";
    if (mode === "review") return "Review mode: review the current working tree for correctness, regressions, and missing verification. Report findings first. Do not edit files.";
    return null;
  }

  activeEditorContext(root) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return null;
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder || !samePath(folder.uri.fsPath, root)) return null;
    const relative = path.relative(root, editor.document.uri.fsPath);
    const selection = editor.document.getText(editor.selection);
    const bounded = Buffer.byteLength(selection, "utf8") > 32 * 1024 ? `${selection.slice(0, 32 * 1024)}\n… selection truncated` : selection;
    const lines = editor.selection.isEmpty
      ? ""
      : ` lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
    return `Active editor: ${relative}${lines}${bounded ? `\n\nSelected text:\n${bounded}` : ""}`;
  }

  postEditorContext(enabled) {
    const root = workspaceRoot();
    const context = enabled && root ? this.activeEditorContext(root) : null;
    const label = context ? context.split("\n", 1)[0].replace("Active editor: ", "") : null;
    this.postPanel({ type: "context", label });
  }

  async pickFiles() {
    const root = this.requireRootAndTrust();
    const picked = await vscode.window.showOpenDialog({
      title: "Attach workspace files",
      defaultUri: vscode.Uri.file(root),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
    });
    if (!picked?.length) return;
    const files = normalizeWorkspaceAttachments(root, picked.map((uri) => uri.fsPath));
    this.postPanel({ type: "attachments", files });
  }

  async send(message) {
    const prompt = String(message.prompt || "").trim();
    if (!prompt) throw new Error("Enter a coding task or question");
    if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) throw new Error("Prompt exceeds 64 KiB");
    const root = this.requireRootAndTrust();
    const attachments = normalizeWorkspaceAttachments(root, message.attachments);
    const attachmentContext = attachments.length
      ? `Attached workspace files (inspect these as needed):\n${attachments.map((file) => `- ${file}`).join("\n")}`
      : null;
    if (message.mode === "council") {
      return this.runCouncil([prompt, attachmentContext].filter(Boolean).join("\n\n"));
    }
    if (this.currentThread?.cwd && !samePath(this.currentThread.cwd, root)) {
      throw new Error("This Codex thread belongs to another folder. Open that folder to continue it.");
    }
    const codex = this.ensureCodex(root);
    if (!this.currentThread) await this.newThread(message.model || "");
    const resumed = await codex.resumeThread(this.currentThread.id, root);
    if (resumed) this.currentThread = resumed;
    this.setBusy(true, "Codex working");
    const context = [message.includeContext ? this.activeEditorContext(root) : null, attachmentContext].filter(Boolean).join("\n\n") || null;
    const response = await codex.startTurn({
      threadId: this.currentThread.id,
      prompt,
      cwd: root,
      mode: message.mode || "code",
      model: message.model || null,
      effort: message.effort || null,
      context,
      modeInstruction: this.modeInstruction(message.mode),
    });
    this.currentTurnId = response?.turn?.id || null;
    return response;
  }

  async runCouncil(prompt) {
    const root = this.requireRootAndTrust();
    const operation = resolveOperation("council", prompt);
    const config = configuration(root);
    this.setBusy(true, "Council running");
    try {
      const result = await this.adapter.run(operation.command, operation.args, {
        root,
        commandPath: config.commandPath,
        nodePath: config.nodePath,
        timeoutSeconds: config.timeoutSeconds,
        maxOutputBytes: config.maxOutputBytes,
      });
      this.postPanel({ type: "councilResult", result });
      return result;
    } catch (error) {
      this.postError(error);
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  async runOperation(action, input = "") {
    const root = this.requireRootAndTrust();
    const operation = resolveOperation(action, input);
    const config = configuration(root);
    const result = await this.adapter.run(operation.command, operation.args, {
      root,
      commandPath: config.commandPath,
      nodePath: config.nodePath,
      timeoutSeconds: config.timeoutSeconds,
      maxOutputBytes: config.maxOutputBytes,
    });
    return result;
  }

  async stop() {
    if (this.adapter.cancel()) return;
    if (this.currentThread?.id && this.currentTurnId) {
      await this.codex?.interruptTurn(this.currentThread.id, this.currentTurnId);
      this.currentTurnId = null;
      this.setBusy(false);
      return;
    }
    this.postPanel({ type: "error", message: "No Codex turn or Council run is active" });
  }

  setBusy(busy, label = "") {
    this.status.text = busy ? `$(sync~spin) Coder Council: ${label || "Working"}` : "$(organization) Coder Council";
    this.status.tooltip = busy ? label : "Open Coder Council Coding Workspace";
    this.postPanel({ type: "busy", busy, label });
  }

  async handleServerRequest(client, request) {
    const { id, method, params } = request;
    try {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const isCommand = method.includes("commandExecution");
        const subject = isCommand ? params.command || "Command execution" : "Proposed file changes";
        const detail = [params.reason, params.cwd, isCommand ? null : JSON.stringify(params.changes || [], null, 2)].filter(Boolean).join("\n\n");
        const choice = await vscode.window.showWarningMessage(
          isCommand ? `Codex wants to run: ${subject}` : subject,
          { modal: true, detail },
          "Allow once",
          "Allow for session",
          "Deny",
          "Stop turn",
        );
        const decision = choice === "Allow once" ? "accept"
          : choice === "Allow for session" ? "acceptForSession"
            : choice === "Stop turn" ? "cancel" : "decline";
        client.respond(id, { decision });
        return;
      }
      if (method === "item/tool/requestUserInput") {
        const answers = {};
        for (const question of params.questions || []) {
          let answer;
          if (question.options?.length) {
            const picked = await vscode.window.showQuickPick(
              question.options.map((option) => ({ label: option.label, description: option.description })),
              { title: question.header, placeHolder: question.question, ignoreFocusOut: true },
            );
            answer = picked?.label;
          } else {
            answer = await vscode.window.showInputBox({
              title: question.header,
              prompt: question.question,
              password: question.isSecret === true,
              ignoreFocusOut: true,
            });
          }
          answers[question.id] = { answers: answer === undefined ? [] : [answer] };
        }
        client.respond(id, { answers });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        const choice = await vscode.window.showWarningMessage(
          "Codex requests additional permissions",
          { modal: true, detail: `${params.reason || "No reason supplied"}\n\n${JSON.stringify(params.permissions || {}, null, 2)}` },
          "Allow this turn",
          "Deny",
        );
        client.respond(id, { permissions: choice === "Allow this turn" ? params.permissions || {} : {}, scope: "turn" });
        return;
      }
      if (method === "mcpServer/elicitation/request") {
        client.respond(id, { action: "decline" });
        vscode.window.showInformationMessage(`Council declined an unsupported structured prompt from ${params.serverName || "an MCP server"}.`);
        return;
      }
      client.respondError(id, -32601, `Council VS Code does not implement ${method}`);
    } catch (error) {
      try { client.respondError(id, -32603, errorMessage(error)); } catch {}
    }
  }

  async runDoctor(force = false) {
    if (!force && this.lastDoctor) return this.lastDoctor;
    if (this.doctorPromise) return this.doctorPromise;
    if (this.adapter.busy) return this.lastDoctor;
    this.doctorPromise = this.runOperation("doctor")
      .then((doctor) => { this.lastDoctor = doctor; return doctor; })
      .catch((error) => ({ ok: false, error: { message: errorMessage(error) }, checks: {} }))
      .finally(() => { this.doctorPromise = null; });
    return this.doctorPromise;
  }

  async showSetup(open = true, force = false) {
    const root = workspaceRoot();
    const doctor = root && vscode.workspace.isTrusted ? await this.runDoctor(force) : null;
    const data = { doctor, codexConnected: this.codex?.connected || false };
    if (open) this.postPanel({ type: "setup", data });
    return data;
  }

  prepareTerminal(name, command) {
    const terminal = vscode.window.createTerminal({ name, cwd: workspaceRoot() || undefined });
    terminal.show(true);
    terminal.sendText(command, false);
    vscode.window.showInformationMessage(`${name}: command prepared. Review it, then press Enter.`);
  }

  async setupAction(action) {
    const docs = {
      codexDocs: "https://developers.openai.com/codex/ide/",
      ollamaDocs: "https://docs.ollama.com/quickstart",
      openrouterDocs: "https://openrouter.ai/docs/guides/routing/routers/free-router",
    };
    if (docs[action]) return vscode.env.openExternal(vscode.Uri.parse(docs[action]));
    if (action === "openConfig") return this.openConfig();
    if (action === "codexLogin") return this.prepareTerminal("Codex login", "codex login");
    if (action === "ollamaServe") return this.prepareTerminal("Ollama", "ollama serve");
    if (action === "opencodeAuth") return this.prepareTerminal("OpenCode auth", "opencode auth login");
    if (action === "openrouterEnv") {
      const choice = await vscode.window.showInformationMessage(
        "OpenRouter must be present before the VS Code extension host starts.",
        {
          modal: true,
          detail:
            "Fully quit VS Code—not only Reload Window—then open an external terminal, export OPENROUTER_API_KEY there, and launch VS Code from that same terminal. " +
            "An integrated terminal is a child of VS Code and cannot update the already-running extension host. Never paste your key into chat, .council, or VS Code settings.",
        },
        "Open OpenRouter docs",
      );
      if (choice === "Open OpenRouter docs") return vscode.env.openExternal(vscode.Uri.parse(docs.openrouterDocs));
      return undefined;
    }
    if (action === "ollamaPull") {
      const model = await vscode.window.showInputBox({
        title: "Pull an Ollama model",
        prompt: "Model name from ollama.com/library",
        placeHolder: "qwen3-coder:30b",
        validateInput: (value) => SAFE_MODEL.test(value) ? null : "Use a model name such as qwen3-coder:30b",
        ignoreFocusOut: true,
      });
      if (model) this.prepareTerminal("Ollama model", `ollama pull ${model}`);
      return;
    }
    if (action === "ollamaEnable") {
      const model = await vscode.window.showInputBox({
        title: "Enable an installed Ollama model in Council",
        prompt: "Exact model name shown by `ollama list`",
        placeHolder: "qwen3-coder:30b",
        validateInput: (value) => SAFE_MODEL.test(value) ? null : "Use a model name such as qwen3-coder:30b",
        ignoreFocusOut: true,
      });
      if (!model) return;
      await this.runOperation("setupOllama", model);
      this.lastDoctor = null;
      return this.showSetup(true, true);
    }
    if (action === "openrouterEnable") {
      await this.runOperation("setupOpenrouterFree");
      this.lastDoctor = null;
      return this.showSetup(true, true);
    }
    if (action === "freeFirst") {
      await this.runOperation("setupFreeFirst");
      this.lastDoctor = null;
      vscode.window.showInformationMessage("Coder Council free-first pool enabled. Healthy free/local seats will be used; paid fallback is off.");
      return this.showSetup(true, true);
    }
    const controls = { init: "init", models: "models", runs: "runsList", stats: "stats", validate: "configValidate" };
    if (controls[action]) {
      const result = await this.runOperation(controls[action]);
      this.postPanel({ type: "councilResult", result });
      if (action === "init") { this.lastDoctor = null; await this.showSetup(true, true); }
      return;
    }
    if (action === "doctor") {
      this.lastDoctor = null;
      await this.showSetup(true, true);
    }
  }

  async openConfig() {
    const root = this.requireRootAndTrust();
    const target = path.join(root, ".council", "config.jsonc");
    if (!fs.existsSync(target)) {
      const choice = await vscode.window.showInformationMessage("Coder Council is not initialized in this workspace.", "Initialize");
      if (choice === "Initialize") await this.runOperation("init");
    }
    if (!fs.existsSync(target)) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document);
  }

  async openFile(filePath) {
    const root = this.requireRootAndTrust();
    const target = path.resolve(root, String(filePath || ""));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to open a path outside this workspace");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  async refreshSidebar() {
    const root = workspaceRoot();
    if (!root || !vscode.workspace.isTrusted) {
      this.postSidebar({ type: "sidebar", threads: [], doctor: null, error: root ? "Trust workspace to connect" : "Open a folder" });
      return;
    }
    try {
      const codex = this.ensureCodex(root);
      const [threads, doctor] = await Promise.all([
        codex.listThreads({ cwd: root, limit: 8 }),
        this.runDoctor(false),
      ]);
      this.postSidebar({ type: "sidebar", threads: threads.data, doctor });
    } catch (error) {
      this.postSidebar({ type: "sidebar", threads: [], doctor: this.lastDoctor, error: errorMessage(error) });
    }
  }

  async compose(mode, prompt = "") {
    this.openWorkspace();
    this.postPanel({ type: "compose", mode, prompt });
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Coder Council", { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.text = "$(organization) Coder Council";
  status.tooltip = "Open Coder Council Coding Workspace";
  status.command = "council.openWorkspace";
  status.show();
  const adapter = new CouncilProcessAdapter({ extensionRoot: context.extensionPath, output });
  const controller = new CouncilWorkspaceController(context, adapter, output, status);

  context.subscriptions.push(
    output,
    status,
    adapter,
    controller,
    vscode.window.registerWebviewViewProvider(VIEW_ID, { resolveWebviewView: (view) => controller.resolveSidebar(view) }, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("council.openWorkspace", () => controller.openWorkspace()),
    vscode.commands.registerCommand("council.newThread", () => { controller.openWorkspace(); return controller.newThread(); }),
    vscode.commands.registerCommand("council.setup", () => controller.openWorkspace("setup")),
    vscode.commands.registerCommand("council.refresh", () => controller.loadWorkspace("workspace", { forceDoctor: true })),
    vscode.commands.registerCommand("council.init", () => controller.runOperation("init")),
    vscode.commands.registerCommand("council.doctor", () => controller.runOperation("doctor")),
    vscode.commands.registerCommand("council.ask", () => controller.compose("ask")),
    vscode.commands.registerCommand("council.council", () => controller.compose("council")),
    vscode.commands.registerCommand("council.plan", () => controller.compose("plan")),
    vscode.commands.registerCommand("council.review", () => controller.compose("review", "Review the current working tree for correctness and regressions.")),
    vscode.commands.registerCommand("council.build", () => controller.compose("code")),
    vscode.commands.registerCommand("council.cancel", () => controller.stop()),
    vscode.commands.registerCommand("council.openConfig", () => controller.openConfig()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { controller.refreshSidebar(); controller.loadWorkspace(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { controller.currentThread = null; controller.refreshSidebar(); controller.loadWorkspace(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("council")) { controller.lastDoctor = null; controller.refreshSidebar(); }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => controller.postEditorContext(true)),
    vscode.window.onDidChangeTextEditorSelection(() => controller.postEditorContext(true)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, CouncilWorkspaceController, configuration, samePath, workspaceRoot };
