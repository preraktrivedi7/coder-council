(() => {
  "use strict";

  const vscode = acquireVsCodeApi();
  const threads = document.getElementById("sidebarThreads");
  const summary = document.getElementById("providerSummary");

  function button(label, onClick) {
    const element = document.createElement("button");
    element.className = "sidebar-thread";
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  }

  document.getElementById("openWorkspace").addEventListener("click", () => vscode.postMessage({ type: "openWorkspace" }));
  document.getElementById("newThread").addEventListener("click", () => vscode.postMessage({ type: "newThread" }));
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("setup").addEventListener("click", () => vscode.postMessage({ type: "setup" }));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "sidebar") {
      threads.replaceChildren();
      if (!message.threads?.length) {
        const empty = document.createElement("div");
        empty.className = "empty compact";
        empty.textContent = message.error || "No Codex threads in this workspace yet.";
        threads.append(empty);
      } else {
        for (const thread of message.threads.slice(0, 8)) {
          threads.append(button(thread.name || thread.preview || "Untitled thread", () => {
            vscode.postMessage({ type: "selectThread", threadId: thread.id });
          }));
        }
      }
      const checks = message.doctor?.checks || {};
      const ready = [checks.openai, checks.ollama, checks.openrouterFree].filter((check) => check?.available === true).length;
      summary.replaceChildren();
      const dot = document.createElement("span");
      dot.className = `status-dot ${ready ? "online" : ""}`;
      summary.append(dot, document.createTextNode(message.error ? " Setup needs attention" : ` ${ready} inference path${ready === 1 ? "" : "s"} ready`));
    }
  });

  vscode.postMessage({ type: "ready" });
})();
