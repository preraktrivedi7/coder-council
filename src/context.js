import fs from "node:fs/promises";
import path from "node:path";
import { runCommand, sha256 } from "./utils.js";

export async function gitSnapshot(root = process.cwd()) {
  const [status, branch, commit] = await Promise.all([
    runCommand("git", ["status", "--porcelain"], { cwd: root }),
    runCommand("git", ["branch", "--show-current"], { cwd: root }),
    runCommand("git", ["rev-parse", "HEAD"], { cwd: root }),
  ]);
  if ([status, branch, commit].some((result) => result.code !== 0)) return null;
  return {
    status: status.stdout.trimEnd(),
    dirty: Boolean(status.stdout.trim()),
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
  };
}

export async function buildContextBundle(root, options = {}) {
  const { files = [], maxBytes = 64 * 1024, includeGit = true } = options;
  let remaining = maxBytes;
  const excerpts = [];
  let truncated = false;
  for (const relative of [...new Set(files)].sort()) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) && absolute !== path.resolve(root)) continue;
    try {
      const raw = await fs.readFile(absolute, "utf8");
      const content = raw.slice(0, Math.max(0, remaining));
      remaining -= Buffer.byteLength(content);
      excerpts.push({ file: relative, content, truncated: content.length < raw.length });
      if (content.length < raw.length || remaining <= 0) truncated = true;
      if (remaining <= 0) break;
    } catch (error) {
      excerpts.push({ file: relative, error: error.code || error.message });
    }
  }
  const bundle = {
    files: excerpts,
    truncated,
    maxBytes,
    ...(includeGit ? { git: await gitSnapshot(root) } : {}),
  };
  return { ...bundle, hash: sha256(bundle) };
}

export function equalizeBundles(first, second) {
  const firstFiles = first.files.map((item) => item.file);
  const secondFiles = second.files.map((item) => item.file);
  return {
    materiallyEquivalent:
      JSON.stringify(firstFiles) === JSON.stringify(secondFiles) && first.maxBytes === second.maxBytes,
    firstFiles,
    secondFiles,
  };
}

