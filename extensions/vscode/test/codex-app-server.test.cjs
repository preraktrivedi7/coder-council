"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");
const {
  CodexAppServerClient,
  resolveCodexCommand,
  sanitizeItem,
  sanitizeNotification,
  sanitizeThread,
} = require("../src/codex-app-server.cjs");

test("Codex discovery finds the standalone installer outside VS Code's PATH on macOS and Linux", { skip: process.platform === "win32" }, () => {
  const expected = "/Users/test/.local/bin/codex";
  const resolved = resolveCodexCommand("codex", {
    pathValue: "/usr/bin:/bin",
    homeDir: "/Users/test",
    isExecutable: (candidate) => candidate === expected,
  });
  assert.equal(resolved, expected);
  assert.equal(resolveCodexCommand("/custom/codex"), "/custom/codex");
});

function fakeServer(respond) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let buffer = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        respond(message, (reply) => child.stdout.write(`${JSON.stringify(reply)}\n`));
      }
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
    child.emit("close", 0, "SIGTERM");
    return true;
  };
  return child;
}

test("Codex client performs initialization and supported thread requests over JSONL", async () => {
  const requests = [];
  const child = fakeServer((message, reply) => {
    requests.push(message);
    if (message.method === "initialized") return;
    if (message.method === "initialize") return reply({ id: message.id, result: { userAgent: "test" } });
    if (message.method === "thread/list") {
      return reply({
        id: message.id,
        result: {
          data: [{ id: "t1", name: "Test", preview: "hello", cwd: "/repo", modelProvider: "openai", createdAt: 1, updatedAt: 2, turns: [] }],
          nextCursor: null,
        },
      });
    }
  });
  const client = new CodexAppServerClient({ spawnImpl: () => child, cwd: "/repo", timeoutMs: 500 });
  const threads = await client.listThreads({ cwd: "/repo" });
  assert.equal(client.connected, true);
  assert.equal(threads.data[0].id, "t1");
  assert.deepEqual(requests.slice(0, 3).map((request) => request.method), ["initialize", "initialized", "thread/list"]);
  assert.equal(requests[2].params.cwd, "/repo");
  client.dispose();
});

test("Codex client forwards notifications and answers server requests", async () => {
  let requestId;
  const child = fakeServer((message, reply) => {
    if (message.method === "initialize") return reply({ id: message.id, result: {} });
    if (message.method === "initialized") {
      child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "v", itemId: "i", delta: "hi" } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 77, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "v", itemId: "i" } })}\n`);
      return;
    }
    if (message.id === 77) requestId = message;
  });
  const client = new CodexAppServerClient({ spawnImpl: () => child, timeoutMs: 500 });
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("serverRequest", (message) => client.respond(message.id, { decision: "decline" }));
  await client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications[0].method, "item/agentMessage/delta");
  assert.deepEqual(requestId, { id: 77, result: { decision: "decline" } });
  client.dispose();
});

test("Codex history loading requests every turn with full item detail", async () => {
  const turnRequests = [];
  const child = fakeServer((message, reply) => {
    if (message.method === "initialize") return reply({ id: message.id, result: {} });
    if (message.method === "initialized") return;
    if (message.method === "thread/read") {
      return reply({ id: message.id, result: { thread: { id: "t", preview: "work", cwd: "/repo", modelProvider: "openai", createdAt: 1, updatedAt: 2, turns: [] } } });
    }
    if (message.method === "thread/turns/list") {
      turnRequests.push(message.params);
      const second = Boolean(message.params.cursor);
      return reply({
        id: message.id,
        result: {
          data: [{ id: second ? "v2" : "v1", status: "completed", items: [{ id: second ? "a2" : "a1", type: "agentMessage", text: second ? "two" : "one" }] }],
          nextCursor: second ? null : "page-2",
        },
      });
    }
  });
  const client = new CodexAppServerClient({ spawnImpl: () => child, timeoutMs: 500 });
  const thread = await client.readThread("t");
  assert.deepEqual(thread.turns.map((turn) => turn.id), ["v1", "v2"]);
  assert.equal(turnRequests[0].itemsView, "full");
  assert.equal(turnRequests[0].sortDirection, "asc");
  assert.equal(turnRequests[1].cursor, "page-2");
  client.dispose();
});

test("sanitizers preserve visible coding history but never forward private reasoning content", () => {
  const reasoning = sanitizeItem({ id: "r", type: "reasoning", summary: ["Checked tests"], content: ["private chain"] });
  assert.deepEqual(reasoning, { id: "r", type: "reasoning", summary: ["Checked tests"] });
  assert.equal(JSON.stringify(reasoning).includes("private chain"), false);

  const thread = sanitizeThread({
    id: "t",
    name: null,
    preview: "Task",
    cwd: "/repo",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    turns: [{ id: "v", status: "completed", items: [{ id: "a", type: "agentMessage", text: "Done" }] }],
  }, { includeTurns: true });
  assert.equal(thread.turns[0].items[0].text, "Done");

  const hiddenDelta = sanitizeNotification("item/reasoning/textDelta", { delta: "private" });
  const summaryDelta = sanitizeNotification("item/reasoning/summaryTextDelta", { delta: "Verified build" });
  assert.equal(hiddenDelta, null);
  assert.equal(summaryDelta.delta, "Verified build");
});
