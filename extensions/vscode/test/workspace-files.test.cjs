"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { normalizeWorkspaceAttachments } = require("../src/workspace-files.cjs");

test("workspace attachments are bounded, deduplicated, and normalized", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coder-council-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "export {};\n");
  assert.deepEqual(normalizeWorkspaceAttachments(root, ["src/index.js", path.join(root, "src/index.js")]), ["src/index.js"]);
});

test("workspace attachments reject traversal, directories, and missing files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coder-council-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  assert.throws(() => normalizeWorkspaceAttachments(root, ["../secret.txt"]), /inside the current workspace/);
  assert.throws(() => normalizeWorkspaceAttachments(root, ["src"]), /not a readable workspace file/);
  assert.throws(() => normalizeWorkspaceAttachments(root, ["missing.txt"]), /not a readable workspace file/);
});
