"use strict";

const crypto = require("node:crypto");

function resources(webview, extensionUri, vscode, script = "main.js") {
  return {
    nonce: crypto.randomBytes(16).toString("base64"),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", script)),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "styles.css")),
  };
}

function webviewHtml(webview, extensionUri, vscode) {
  const { nonce, scriptUri, styleUri } = resources(webview, extensionUri, vscode);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Coder Council Coding Workspace</title>
</head>
<body class="workspace-body">
  <div class="app-shell">
    <aside class="thread-rail">
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true">P</span>
        <div><strong>Coder Council</strong><span>coding workspace</span></div>
        <button id="settingsButton" class="icon-button" title="Provider setup" aria-label="Provider setup">⚙</button>
      </div>
      <button id="newThreadButton" class="new-thread">＋ New thread</button>
      <div class="thread-tools">
        <input id="threadSearch" type="search" placeholder="Search threads" aria-label="Search threads">
        <select id="threadScope" aria-label="Thread scope">
          <option value="workspace">This workspace</option>
          <option value="all">All Codex threads</option>
        </select>
      </div>
      <div id="threadList" class="thread-list" aria-live="polite">
        <div class="empty compact">Connecting to Codex…</div>
      </div>
      <div class="rail-footer">
        <span id="codexDot" class="status-dot"></span>
        <span id="codexStatus">Codex connecting</span>
      </div>
    </aside>

    <main class="conversation">
      <header class="conversation-header">
        <div class="thread-heading">
          <h1 id="threadTitle">New coding thread</h1>
          <span id="workspaceLabel">No workspace</span>
        </div>
        <div class="header-actions">
          <span id="runBadge" class="run-badge">Ready</span>
          <button id="refreshButton" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
          <button id="setupButton" class="secondary-button">Setup</button>
        </div>
      </header>

      <div id="trustNotice" class="banner hidden">
        <div><strong>Restricted Mode</strong><span>Trust this workspace before coding tools can run local commands.</span></div>
        <button id="trustButton" class="primary-button">Manage trust</button>
      </div>
      <div id="externalThreadNotice" class="banner hidden">
        <div><strong>History is view-only</strong><span>This thread belongs to another folder. Open that folder to continue it safely.</span></div>
      </div>

      <section id="transcript" class="transcript" aria-live="polite">
        <div id="welcome" class="welcome">
          <div class="welcome-mark">P</div>
          <h2>One workspace. Better decisions.</h2>
          <p>Chat, code, plan, review, or ask independent models to challenge each other before you ship.</p>
          <div class="starter-grid">
            <button data-starter="Implement the next useful feature and verify it." data-mode="code"><strong>Build</strong><span>Edit the workspace with approvals</span></button>
            <button data-starter="Review the current working tree for correctness and regressions." data-mode="review"><strong>Review</strong><span>Inspect changes read-only</span></button>
            <button data-starter="Create an implementation plan for: " data-mode="plan"><strong>Plan</strong><span>Explore before changing files</span></button>
            <button data-starter="What is the best approach to: " data-mode="council"><strong>Ask Council</strong><span>Compare independent candidates</span></button>
          </div>
        </div>
      </section>

      <section class="composer-wrap">
        <div id="attachmentChips" class="attachment-chips hidden" aria-label="Attached workspace files"></div>
        <div id="contextChip" class="context-chip hidden"><span id="contextLabel"></span><button id="removeContext" aria-label="Remove editor context">×</button></div>
        <div class="composer">
          <textarea id="prompt" rows="3" placeholder="Ask Coder Council to work on this codebase…" aria-label="Message"></textarea>
          <div class="composer-bar">
            <div class="composer-controls">
              <button id="attachButton" class="composer-icon" title="Attach workspace files" aria-label="Attach workspace files">＋</button>
              <select id="mode" aria-label="Mode">
                <option value="code">Code</option>
                <option value="plan">Plan</option>
                <option value="ask">Ask</option>
                <option value="review">Review</option>
                <option value="council">Council</option>
              </select>
              <select id="model" aria-label="Codex model"><option value="">Default model</option></select>
              <select id="effort" aria-label="Reasoning effort">
                <option value="">Default effort</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">XHigh</option>
              </select>
              <label class="context-toggle"><input id="includeContext" type="checkbox" checked> Editor context</label>
            </div>
            <div class="send-controls">
              <span id="modeHint">Workspace write · approvals on request</span>
              <button id="stopButton" class="stop-button hidden" title="Stop run" aria-label="Stop run">■</button>
              <button id="sendButton" class="send-button" title="Send (Cmd/Ctrl+Enter)" aria-label="Send">↑</button>
            </div>
          </div>
        </div>
        <div class="composer-note">Your provider owns authentication and history. Coder Council never stores provider credentials or private reasoning.</div>
      </section>
    </main>

    <aside id="detailPanel" class="detail-panel hidden">
      <div class="detail-header"><h2 id="detailTitle">Details</h2><button id="closeDetail" class="icon-button" aria-label="Close details">×</button></div>
      <div id="detailBody" class="detail-body"></div>
    </aside>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function sidebarHtml(webview, extensionUri, vscode) {
  const { nonce, scriptUri, styleUri } = resources(webview, extensionUri, vscode, "sidebar.js");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Coder Council</title>
</head>
<body class="sidebar-body">
  <header class="sidebar-brand"><span class="brand-mark">C</span><div><strong>Coder Council</strong><span>your AI coding team</span></div></header>
  <button id="openWorkspace" class="primary-button wide">Open coding workspace</button>
  <button id="newThread" class="secondary-button wide">＋ New thread</button>
  <section class="sidebar-section">
    <div class="sidebar-heading"><span>Recent Codex threads</span><button id="refresh" class="icon-button">↻</button></div>
    <div id="sidebarThreads" class="sidebar-threads"><div class="empty compact">Loading…</div></div>
  </section>
  <section class="sidebar-section setup-summary">
    <div class="sidebar-heading"><span>Providers</span><button id="setup" class="link-button">Setup</button></div>
    <div id="providerSummary" class="provider-summary"><span class="status-dot"></span> Checking Coder Council…</div>
  </section>
  <p class="sidebar-note">Threads are read directly from Codex App Server. Credentials never pass through Coder Council.</p>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { sidebarHtml, webviewHtml };
