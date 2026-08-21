import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const forbiddenValues = [
  /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{24,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9_]{24,}\b/g,
];

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}

const violations = [];
for (const file of await walk(root)) {
  if (/\.(png|jpg|jpeg|gif|pdf|zip|gz)$/i.test(file)) continue;
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const pattern of forbiddenValues) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) violations.push(path.relative(root, file));
  }
}
if (violations.length) {
  process.stderr.write(`Potential secrets found in: ${[...new Set(violations)].join(", ")}\n`);
  process.exitCode = 1;
} else process.stdout.write("Secret scan passed.\n");

