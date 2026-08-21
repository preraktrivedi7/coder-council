"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeWorkspaceAttachments(root, candidates, statSync = fs.statSync, pathApi = path) {
  const files = [];
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 12) : []) {
    const target = pathApi.resolve(root, String(candidate || ""));
    const relative = pathApi.relative(root, target);
    if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
      throw new Error("Attachments must be files inside the current workspace");
    }
    const normalizedRelative = relative.split(pathApi.sep).join("/");
    let isFile = false;
    try { isFile = statSync(target).isFile(); } catch {}
    if (!isFile) throw new Error(`Attachment is not a readable workspace file: ${normalizedRelative}`);
    if (!files.includes(normalizedRelative)) files.push(normalizedRelative);
  }
  return files;
}

module.exports = { normalizeWorkspaceAttachments };
