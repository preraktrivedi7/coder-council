(() => {
  "use strict";

  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = {
    root: null,
    trusted: false,
    busy: false,
    currentThread: null,
    currentTurnId: null,
    threads: [],
    scope: saved.scope || "workspace",
    attachments: Array.isArray(saved.attachments) ? saved.attachments : [],
    seenItems: new Set(),
  };
  const $ = (id) => document.getElementById(id);
  const elements = {
    threadList: $("threadList"),
    search: $("threadSearch"),
    scope: $("threadScope"),
    codexDot: $("codexDot"),
    codexStatus: $("codexStatus"),
    title: $("threadTitle"),
    workspace: $("workspaceLabel"),
    badge: $("runBadge"),
    trust: $("trustNotice"),
    external: $("externalThreadNotice"),
    transcript: $("transcript"),
    prompt: $("prompt"),
    mode: $("mode"),
    model: $("model"),
    effort: $("effort"),
    includeContext: $("includeContext"),
    attachmentChips: $("attachmentChips"),
    contextChip: $("contextChip"),
    contextLabel: $("contextLabel"),
    send: $("sendButton"),
    stop: $("stopButton"),
    modeHint: $("modeHint"),
    detail: $("detailPanel"),
    detailTitle: $("detailTitle"),
    detailBody: $("detailBody"),
  };
  elements.scope.value = state.scope;
  if (saved.mode) elements.mode.value = saved.mode;
  if (saved.model) elements.model.dataset.saved = saved.model;
  if (saved.effort) elements.effort.value = saved.effort;
  if (saved.draft) elements.prompt.value = saved.draft;

  function persist() {
    vscode.setState({
      scope: elements.scope.value,
      mode: elements.mode.value,
      model: elements.model.value,
      effort: elements.effort.value,
      draft: elements.prompt.value,
      attachments: state.attachments,
    });
  }

  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined && text !== null) value.textContent = String(text);
    return value;
  }

  function appendInline(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^\s)]+\))/g;
    let cursor = 0;
    for (const match of String(text).matchAll(pattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("**")) parent.append(node("strong", "", token.slice(2, -2)));
      else if (token.startsWith("`")) parent.append(node("code", "", token.slice(1, -1)));
      else {
        const parts = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(token);
        const link = node("a", "", parts[1]);
        link.href = parts[2];
        link.addEventListener("click", (event) => {
          event.preventDefault();
          vscode.postMessage({ type: "openExternal", url: parts[2] });
        });
        parent.append(link);
      }
      cursor = match.index + token.length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function richText(text) {
    const container = node("div", "message-text rich");
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let paragraph = [];
    let list = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const value = node("p");
      appendInline(value, paragraph.join("\n"));
      container.append(value);
      paragraph = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = /^```([^`]*)$/.exec(line);
      if (fence) {
        flushParagraph();
        list = null;
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
        const raw = code.join("\n");
        const block = node("div", "code-block");
        const header = node("div", "code-block-header");
        const copy = node("button", "", "Copy");
        copy.addEventListener("click", () => {
          vscode.postMessage({ type: "copy", text: raw });
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        });
        header.append(node("span", "", fence[1].trim() || "code"), copy);
        block.append(header, node("code", "code-block-body", raw));
        container.append(block);
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushParagraph();
        list = null;
        const value = node(`h${heading[1].length}`);
        appendInline(value, heading[2]);
        container.append(value);
        continue;
      }
      const unordered = /^[-*]\s+(.+)$/.exec(line);
      const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
      if (unordered || ordered) {
        flushParagraph();
        const tag = ordered ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = node(tag);
          container.append(list);
        }
        const item = node("li");
        appendInline(item, (unordered || ordered)[1]);
        list.append(item);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        list = null;
      } else {
        list = null;
        paragraph.push(line);
      }
    }
    flushParagraph();
    return container;
  }

  function renderAttachments() {
    elements.attachmentChips.replaceChildren();
    for (const file of state.attachments) {
      const chip = node("span", "attachment-chip");
      const remove = node("button", "", "×");
      remove.title = `Remove ${file}`;
      remove.addEventListener("click", () => {
        state.attachments = state.attachments.filter((candidate) => candidate !== file);
        renderAttachments();
        persist();
      });
      chip.append(node("span", "", file), remove);
      elements.attachmentChips.append(chip);
    }
    elements.attachmentChips.classList.toggle("hidden", state.attachments.length === 0);
  }

  function formatDate(seconds) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function threadLabel(thread) {
    return thread.name || thread.preview || "Untitled thread";
  }

  function renderThreads() {
    elements.threadList.replaceChildren();
    if (!state.threads.length) {
      elements.threadList.append(node("div", "empty compact", "No matching Codex threads."));
      return;
    }
    for (const thread of state.threads) {
      const button = node("button", `thread-row${thread.id === state.currentThread?.id ? " selected" : ""}`);
      button.dataset.threadId = thread.id;
      const copy = node("span", "thread-copy");
      copy.append(node("strong", "", threadLabel(thread)), node("span", "", thread.cwd || "Codex"));
      button.append(copy, node("time", "", formatDate(thread.updatedAt)));
      button.addEventListener("click", () => vscode.postMessage({ type: "selectThread", threadId: thread.id }));
      elements.threadList.append(button);
    }
  }

  function itemContainer(item, className) {
    const wrapper = node("article", `message ${className || ""}`);
    wrapper.dataset.itemId = item.id;
    state.seenItems.add(item.id);
    return wrapper;
  }

  function textFromUserContent(content) {
    return (content || []).map((entry) => {
      if (entry.type === "text") return entry.text;
      if (entry.path) return `[${entry.type}: ${entry.path}]`;
      if (entry.url) return `[${entry.type}]`;
      return `[${entry.label || entry.type}]`;
    }).join("\n");
  }

  function showDetail(title, content, isCode = false) {
    elements.detailTitle.textContent = title;
    elements.detailBody.replaceChildren();
    const body = node(isCode ? "pre" : "div", isCode ? "detail-code" : "detail-copy", content);
    elements.detailBody.append(body);
    elements.detail.classList.remove("hidden");
  }

  function renderItem(item) {
    if (!item || !item.id) return null;
    if (item.type === "userMessage") {
      const wrapper = itemContainer(item, "user-message");
      wrapper.append(node("div", "message-label", "You"), node("div", "message-text", textFromUserContent(item.content)));
      return wrapper;
    }
    if (item.type === "agentMessage") {
      const wrapper = itemContainer(item, "agent-message");
      wrapper.append(node("div", "message-label", "Coder Council"), richText(item.text || ""));
      return wrapper;
    }
    if (item.type === "plan") {
      const wrapper = itemContainer(item, "tool-card plan-card");
      wrapper.append(node("div", "tool-title", "Plan"), richText(item.text || ""));
      return wrapper;
    }
    if (item.type === "reasoning") {
      if (!item.summary?.length) return null;
      const wrapper = itemContainer(item, "tool-card reasoning-card");
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Reasoning summary";
      details.append(summary, richText(item.summary.join("\n")));
      wrapper.append(details);
      return wrapper;
    }
    if (item.type === "commandExecution") {
      const wrapper = itemContainer(item, "tool-card command-card");
      const header = node("div", "tool-title");
      header.append(node("span", "tool-icon", ">_"), node("span", "", item.command || "Command"), node("span", `tool-status ${item.status || ""}`, item.status || ""));
      wrapper.append(header);
      if (item.aggregatedOutput) wrapper.append(node("pre", "command-output", item.aggregatedOutput));
      return wrapper;
    }
    if (item.type === "fileChange") {
      const wrapper = itemContainer(item, "tool-card file-card");
      wrapper.append(node("div", "tool-title", `Files changed · ${item.status || "pending"}`));
      for (const change of item.changes || []) {
        const row = node("button", "file-change-row");
        row.append(node("span", `change-kind ${change.kind || "update"}`, change.kind || "update"), node("span", "file-path", change.path));
        row.addEventListener("click", () => showDetail(change.path, change.diff || "No diff available.", true));
        row.addEventListener("dblclick", () => vscode.postMessage({ type: "openFile", path: change.path }));
        wrapper.append(row);
      }
      return wrapper;
    }
    if (item.type === "mcpToolCall") {
      const wrapper = itemContainer(item, "tool-card");
      wrapper.append(node("div", "tool-title", `${item.server || "MCP"} · ${item.tool || "tool"}`), node("div", "muted", item.status || ""));
      return wrapper;
    }
    return null;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { elements.transcript.scrollTop = elements.transcript.scrollHeight; });
  }

  function renderThread(thread) {
    state.currentThread = thread;
    state.seenItems.clear();
    elements.transcript.replaceChildren();
    elements.title.textContent = thread ? threadLabel(thread) : "New coding thread";
    const external = Boolean(thread?.cwd && state.root && thread.cwd !== state.root);
    elements.external.classList.toggle("hidden", !external);
    if (!thread?.turns?.length) {
      const welcome = node("div", "welcome compact-welcome");
      welcome.append(node("div", "welcome-mark", "P"), node("h2", "", "What should we build?"), node("p", "", "Use Code for implementation, Plan or Ask for read-only work, Review for the working tree, or Council for independent model comparison."));
      elements.transcript.append(welcome);
    } else {
      for (const turn of thread.turns) {
        for (const item of turn.items || []) {
          const rendered = renderItem(item);
          if (rendered) elements.transcript.append(rendered);
        }
      }
    }
    renderThreads();
    updateControls();
    scrollToBottom();
  }

  function upsertItem(item) {
    if (!item?.id) return;
    const existing = elements.transcript.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    const rendered = renderItem(item);
    if (!rendered) return;
    if (existing) existing.replaceWith(rendered);
    else {
      const pending = item.type === "userMessage" ? elements.transcript.querySelector(".pending-user") : null;
      if (pending) pending.remove();
      elements.transcript.querySelector(".welcome")?.remove();
      elements.transcript.append(rendered);
    }
    scrollToBottom();
  }

  function appendDelta(itemId, delta, type = "agentMessage") {
    let wrapper = elements.transcript.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
    if (!wrapper) {
      wrapper = itemContainer({ id: itemId }, type === "plan" ? "tool-card plan-card" : "agent-message");
      wrapper.append(node("div", type === "plan" ? "tool-title" : "message-label", type === "plan" ? "Plan" : "Coder Council"), node("div", "message-text", ""));
      elements.transcript.querySelector(".welcome")?.remove();
      elements.transcript.append(wrapper);
    }
    const text = wrapper.querySelector(".message-text");
    if (text) text.textContent += delta || "";
    scrollToBottom();
  }

  function appendCouncilResult(result) {
    const id = `council-${Date.now()}`;
    const wrapper = itemContainer({ id }, "agent-message council-result");
    wrapper.append(node("div", "message-label", "Council · multi-model"));
    const content = result?.final || result?.answer || result?.result || result?.text;
    wrapper.append(richText(typeof content === "string" ? content : JSON.stringify(result, null, 2)));
    elements.transcript.append(wrapper);
    scrollToBottom();
  }

  function setBusy(busy, label = "") {
    state.busy = busy;
    elements.badge.textContent = busy ? label || "Working" : "Ready";
    elements.badge.className = `run-badge${busy ? " running" : ""}`;
    elements.stop.classList.toggle("hidden", !busy);
    updateControls();
  }

  function updateControls() {
    const external = Boolean(state.currentThread?.cwd && state.root && state.currentThread.cwd !== state.root);
    const runnable = Boolean(state.root && state.trusted && !external);
    elements.send.disabled = !runnable || state.busy || !elements.prompt.value.trim();
    elements.prompt.disabled = !state.root;
    elements.model.disabled = elements.mode.value === "council";
    elements.effort.disabled = elements.mode.value === "council";
    const hints = {
      code: "Workspace write · approvals on request",
      plan: "Read-only planning",
      ask: "Read-only answer",
      review: "Read-only working-tree review",
      council: "Independent candidates · Council policy",
    };
    elements.modeHint.textContent = hints[elements.mode.value];
  }

  function submit() {
    const prompt = elements.prompt.value.trim();
    if (!prompt || elements.send.disabled) return;
    const pending = node("article", "message user-message pending-user");
    pending.append(node("div", "message-label", "You"), node("div", "message-text", prompt));
    elements.transcript.querySelector(".welcome")?.remove();
    elements.transcript.append(pending);
    vscode.postMessage({
      type: "send",
      prompt,
      mode: elements.mode.value,
      model: elements.model.value,
      effort: elements.effort.value,
      includeContext: elements.includeContext.checked,
      attachments: state.attachments,
    });
    elements.prompt.value = "";
    state.attachments = [];
    renderAttachments();
    persist();
    setBusy(true, elements.mode.value === "council" ? "Council running" : "Codex working");
    scrollToBottom();
  }

  function statusName(check) {
    if (!check) return { label: "Unknown", className: "unknown" };
    if (check.available === true) return { label: "Ready", className: "ready" };
    if (check.available === false) {
      if (check.configured === false) return { label: "Setup needed", className: "unknown" };
      return { label: "Unavailable", className: "error" };
    }
    if (check.ok) return { label: "Ready", className: "ready" };
    if (check.configured === false) return { label: "Setup needed", className: "unknown" };
    return { label: "Unavailable", className: "error" };
  }

  function setupCard(title, description, status, actions) {
    const card = node("section", "setup-card");
    const heading = node("div", "setup-card-heading");
    heading.append(node("h3", "", title), node("span", `setup-state ${status.className}`, status.label));
    card.append(heading, node("p", "", description));
    const controls = node("div", "setup-actions");
    for (const action of actions) {
      const button = node("button", action.primary ? "primary-button" : "secondary-button", action.label);
      button.addEventListener("click", () => vscode.postMessage({ type: "setupAction", action: action.action }));
      controls.append(button);
    }
    card.append(controls);
    return card;
  }

  function renderSetup(data) {
    elements.detailTitle.textContent = "Models & providers";
    elements.detailBody.replaceChildren();
    const intro = node("div", "setup-intro");
    intro.append(
      node("h3", "", "One workspace, several inference paths"),
      node("p", "", "Codex uses your existing ChatGPT login. Open models stay local through Ollama, or use OpenRouter's dynamic free-only pool. Setup commands are never run silently; OpenRouter requires a full relaunch from an external terminal so the extension host inherits its environment."),
    );
    elements.detailBody.append(intro);
    const checks = data?.doctor?.checks || {};
    elements.detailBody.append(
      setupCard("Free-first pool", "Enable every supported zero-cost path in one step. Council uses OpenRouter free as a challenger and a healthy local Ollama model as a distinct arbiter, with paid fallback forced off.", (checks.openrouterFree?.available || checks.ollama?.available) ? { label: "Available", className: "ready" } : { label: "Enable", className: "unknown" }, [
        { label: "Enable free-first", action: "freeFirst", primary: true },
        { label: "Free route docs", action: "openrouterDocs" },
      ]),
      setupCard("Codex + ChatGPT", "Full coding threads, streaming, approvals, history, models, and skills through Codex App Server.", data?.codexConnected ? { label: "Connected", className: "ready" } : statusName(checks.openai), [
        { label: "Prepare login", action: "codexLogin", primary: !data?.codexConnected },
        { label: "Official docs", action: "codexDocs" },
      ]),
      setupCard("Ollama · local models", "Run open-weight models on 127.0.0.1 with no cloud inference. Pull a model, then select it in .council/config.jsonc.", statusName(checks.ollama), [
        { label: "Prepare server", action: "ollamaServe", primary: !checks.ollama?.available },
        { label: "Pull model…", action: "ollamaPull" },
        { label: "Enable model…", action: "ollamaEnable" },
        { label: "Docs", action: "ollamaDocs" },
      ]),
      setupCard("OpenRouter free-only", "Optional cloud access constrained to free routes. Council rejects paid models instead of silently falling back.", statusName(checks.openrouterFree), [
        { label: "Relaunch instructions", action: "openrouterEnv", primary: checks.openrouterFree?.configured === false },
        { label: "Enable free route", action: "openrouterEnable" },
        { label: "Open config", action: "openConfig" },
        { label: "Docs", action: "openrouterDocs" },
      ]),
      setupCard("OpenCode / Kimi", "Optional challenger runtimes. Council's baseline remains fully usable without Kimi.", statusName(checks.opencode || checks.kimi), [
        { label: "Prepare OpenCode auth", action: "opencodeAuth" },
        { label: "Open config", action: "openConfig" },
      ]),
      setupCard("Coder Council controls", "Initialize project state, inspect models and runs, validate policy, and view aggregate statistics without leaving the coding workspace.", { label: "Local CLI", className: "ready" }, [
        { label: "Initialize", action: "init" },
        { label: "Models", action: "models" },
        { label: "Runs", action: "runs" },
        { label: "Stats", action: "stats" },
        { label: "Validate", action: "validate" },
        { label: "Open config", action: "openConfig" },
      ]),
    );
    const footer = node("div", "setup-footer");
    const doctor = node("button", "primary-button", "Run Coder Council doctor");
    doctor.addEventListener("click", () => vscode.postMessage({ type: "setupAction", action: "doctor" }));
    footer.append(doctor, node("p", "", "Provider-owned tools keep all credentials. Coder Council only reads availability and configuration status."));
    elements.detailBody.append(footer);
    elements.detail.classList.remove("hidden");
  }

  function applyEvent(event) {
    if (!event || (event.threadId && event.threadId !== state.currentThread?.id)) return;
    if (event.method === "item/agentMessage/delta") appendDelta(event.itemId, event.delta, "agentMessage");
    else if (event.method === "item/plan/delta" || event.method === "item/reasoning/summaryTextDelta") appendDelta(event.itemId, event.delta, "plan");
    else if (event.method === "item/started" || event.method === "item/completed") upsertItem(event.item);
    else if (event.method === "item/commandExecution/outputDelta") {
      const card = elements.transcript.querySelector(`[data-item-id="${CSS.escape(event.itemId)}"]`);
      let output = card?.querySelector(".command-output");
      if (card && !output) { output = node("pre", "command-output", ""); card.append(output); }
      if (output) output.textContent += event.delta || "";
    } else if (event.method === "turn/diff/updated") {
      const button = node("button", "diff-pill", "View current diff");
      button.addEventListener("click", () => showDetail("Current turn diff", event.diff || "No diff", true));
      elements.transcript.append(button);
    } else if (event.method === "turn/started") {
      state.currentTurnId = event.turn?.id || event.turnId;
      setBusy(true, "Codex working");
    } else if (event.method === "turn/completed") {
      state.currentTurnId = null;
      setBusy(false);
      vscode.postMessage({ type: "refreshThread" });
    } else if (event.method === "thread/name/updated") {
      elements.title.textContent = event.name || elements.title.textContent;
    } else if (event.method === "error") {
      setBusy(false);
      appendCouncilResult({ text: `Codex error: ${event.message}` });
    }
  }

  $("newThreadButton").addEventListener("click", () => vscode.postMessage({ type: "newThread", model: elements.model.value }));
  $("refreshButton").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  $("settingsButton").addEventListener("click", () => vscode.postMessage({ type: "getSetup" }));
  $("setupButton").addEventListener("click", () => vscode.postMessage({ type: "getSetup" }));
  $("attachButton").addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));
  $("closeDetail").addEventListener("click", () => elements.detail.classList.add("hidden"));
  $("trustButton").addEventListener("click", () => vscode.postMessage({ type: "trust" }));
  elements.send.addEventListener("click", submit);
  elements.stop.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  elements.prompt.addEventListener("input", () => { persist(); updateControls(); });
  elements.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submit(); }
  });
  elements.mode.addEventListener("change", () => { persist(); updateControls(); });
  elements.model.addEventListener("change", persist);
  elements.effort.addEventListener("change", persist);
  elements.scope.addEventListener("change", () => {
    state.scope = elements.scope.value;
    persist();
    vscode.postMessage({ type: "listThreads", scope: state.scope, search: elements.search.value });
  });
  let searchTimer;
  elements.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => vscode.postMessage({ type: "listThreads", scope: elements.scope.value, search: elements.search.value }), 180);
  });
  elements.includeContext.addEventListener("change", () => vscode.postMessage({ type: "context", enabled: elements.includeContext.checked }));
  $("removeContext").addEventListener("click", () => {
    elements.includeContext.checked = false;
    elements.contextChip.classList.add("hidden");
  });
  document.querySelectorAll("[data-starter]").forEach((button) => button.addEventListener("click", () => {
    elements.mode.value = button.dataset.mode;
    elements.prompt.value = button.dataset.starter;
    persist(); updateControls(); elements.prompt.focus();
  }));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "shell") {
      state.root = message.workspace || null;
      state.trusted = message.trusted === true;
      if (!saved.mode && message.defaultMode) elements.mode.value = message.defaultMode;
      elements.workspace.textContent = state.root || "No folder open";
      elements.trust.classList.toggle("hidden", !state.root || state.trusted);
      elements.codexDot.className = `status-dot${message.codexConnected ? " online" : ""}`;
      elements.codexStatus.textContent = message.codexConnected ? "Codex connected" : "Codex unavailable";
      updateControls();
    } else if (message.type === "threads") {
      state.threads = message.threads || [];
      elements.codexDot.className = `status-dot${message.error ? " error" : " online"}`;
      elements.codexStatus.textContent = message.error || `${state.threads.length}${message.truncated ? "+" : ""} Codex thread${state.threads.length === 1 ? "" : "s"}`;
      renderThreads();
    } else if (message.type === "models") {
      const selected = elements.model.value || elements.model.dataset.saved || "";
      elements.model.replaceChildren(new Option("Default model", ""));
      for (const model of message.models || []) elements.model.append(new Option(model.displayName, model.id));
      if ([...elements.model.options].some((option) => option.value === selected)) elements.model.value = selected;
      delete elements.model.dataset.saved;
    } else if (message.type === "thread") renderThread(message.thread);
    else if (message.type === "codexEvent") applyEvent(message.event);
    else if (message.type === "busy") setBusy(message.busy, message.label);
    else if (message.type === "councilResult") { document.querySelector(".pending-user")?.classList.remove("pending-user"); appendCouncilResult(message.result); setBusy(false); }
    else if (message.type === "error") { document.querySelector(".pending-user")?.classList.remove("pending-user"); appendCouncilResult({ text: message.message }); setBusy(false); }
    else if (message.type === "setup") renderSetup(message.data);
    else if (message.type === "attachments") {
      state.attachments = [...new Set([...(state.attachments || []), ...(message.files || [])])].slice(0, 12);
      renderAttachments();
      persist();
    } else if (message.type === "context") {
      elements.contextChip.classList.toggle("hidden", !message.label || !elements.includeContext.checked);
      elements.contextLabel.textContent = message.label || "";
    } else if (message.type === "navigate" && message.route === "setup") vscode.postMessage({ type: "getSetup" });
    else if (message.type === "compose") {
      if (message.mode) elements.mode.value = message.mode;
      if (message.prompt) elements.prompt.value = message.prompt;
      persist(); updateControls(); elements.prompt.focus();
    }
  });

  renderAttachments();
  updateControls();
  vscode.postMessage({ type: "ready", scope: state.scope });
})();
