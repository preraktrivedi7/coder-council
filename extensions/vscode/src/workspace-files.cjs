"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeWorkspaceAttachments(root, candidates, statSync = fs.statSync) {
  const files = [];
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 12) : []) {
    const target = path.resolve(root, String(candidate || ""));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Attachments must be files inside the current workspace");
    }
    let isFile = false;
    try { isFile = statSync(target).isFile(); } catch {}
    if (!isFile) throw new Error(`Attachment is not a readable workspace file: ${relative}`);
    if (!files.includes(relative)) files.push(relative);
  }
  return files;
}

module.exports = { normalizeWorkspaceAttachments };
