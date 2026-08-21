import fs from "node:fs/promises";
import path from "node:path";
import { serializeDefaultConfig } from "./config.js";
import { assertNoCredentialsInProject, redact } from "./security.js";
import {
  atomicWrite,
  createId,
  ensureDir,
  isoNow,
  pathExists,
  readJson,
  writeJson,
} from "./utils.js";

const TEXT_FILES = {
  "project.md": "# Coder Council project\n\nDescribe the project, objectives, and constraints here.\n",
  "decisions.md": "# Decisions\n\n",
  "assumptions.md": "# Assumptions\n\n",
  "open-questions.md": "# Open questions\n\n",
};

export function councilPath(root = process.cwd()) {
  return path.join(root, ".council");
}

async function writeIfMissing(target, content) {
  if (await pathExists(target)) return false;
  await atomicWrite(target, content);
  return true;
}

export async function initializeProject(root = process.cwd()) {
  const base = councilPath(root);
  const created = [];
  await ensureDir(base);
  for (const directory of ["runs", "artifacts", "evaluations", "logs"]) {
    const target = path.join(base, directory);
    if (!(await pathExists(target))) created.push(path.relative(root, target));
    await ensureDir(target);
  }
  if (await writeIfMissing(path.join(base, "config.jsonc"), serializeDefaultConfig())) {
    created.push(".council/config.jsonc");
  }
  for (const [name, contents] of Object.entries(TEXT_FILES)) {
    if (await writeIfMissing(path.join(base, name), contents)) created.push(`.council/${name}`);
  }
  const stateTarget = path.join(base, "state.json");
  if (
    await writeIfMissing(
      stateTarget,
      `${JSON.stringify({ version: 1, createdAt: isoNow(), updatedAt: isoNow(), decisions: [] }, null, 2)}\n`,
    )
  ) {
    created.push(".council/state.json");
  }
  return { root: base, created, alreadyInitialized: created.length === 0 };
}

export async function recordDecision(root, decision) {
  assertNoCredentialsInProject(decision);
  const base = councilPath(root);
  const stateFile = path.join(base, "state.json");
  const state = await readJson(stateFile);
  const record = {
    id: decision.id || createId("decision"),
    date: decision.date || isoNow(),
    title: decision.title,
    status: decision.status || "proposed",
    decision: decision.decision,
    rationale: decision.rationale || [],
    evidence: decision.evidence || [],
    ...(decision.runId ? { runId: decision.runId } : {}),
    ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
  };
  state.decisions ||= [];
  state.decisions.push(record);
  state.updatedAt = isoNow();
  await writeJson(stateFile, state);
  await fs.appendFile(
    path.join(base, "decisions.md"),
    `## ${record.title}\n\n- ID: ${record.id}\n- Status: ${record.status}\n- Date: ${record.date}\n\n${record.decision}\n\n`,
  );
  return record;
}

export class RunStore {
  constructor(root = process.cwd(), { enabled = true } = {}) {
    this.root = root;
    this.enabled = enabled;
  }

  async create({ workflow, runId = createId("run"), metadata = {} }) {
    const startedAt = isoNow();
    const stamp = startedAt.replace(/[:.]/g, "-");
    const directory = path.join(councilPath(this.root), "runs", `${stamp}-${runId}`);
    const record = redact({
      id: runId,
      workflow,
      status: "running",
      startedAt,
      finishedAt: null,
      calls: [],
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null, cost: null, credits: null },
      ...metadata,
    });
    if (this.enabled) {
      await ensureDir(directory);
      await writeJson(path.join(directory, "run.json"), record);
    }
    return { id: runId, directory, record };
  }

  async writeStage(run, name, value) {
    const safe = redact(value);
    assertNoCredentialsInProject(safe);
    if (this.enabled) await writeJson(path.join(run.directory, `${name}.json`), safe);
    return safe;
  }

  async writeFinal(run, markdown) {
    const safe = redact(markdown);
    if (this.enabled) await atomicWrite(path.join(run.directory, "final.md"), `${safe.trim()}\n`);
  }

  async update(run, patch) {
    run.record = redact({ ...run.record, ...patch });
    if (this.enabled) await writeJson(path.join(run.directory, "run.json"), run.record);
    return run.record;
  }

  async finish(run, status = "complete", patch = {}) {
    return this.update(run, { ...patch, status, finishedAt: isoNow() });
  }
}

export async function listRuns(root = process.cwd()) {
  const runsRoot = path.join(councilPath(root), "runs");
  let entries = [];
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runsRoot, entry.name);
    try {
      runs.push({ directory, ...(await readJson(path.join(directory, "run.json"))) });
    } catch {
      runs.push({ directory, status: "corrupt", id: entry.name });
    }
  }
  return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export async function markRunAbandoned(root, runId) {
  const runs = await listRuns(root);
  const matches = runs.filter((run) => run.id === runId || path.basename(run.directory).includes(runId));
  if (matches.length !== 1) throw new Error(`Expected one incomplete run for ${runId}, found ${matches.length}`);
  const run = matches[0];
  if (run.status !== "running") return run;
  const updated = { ...run, status: "abandoned", finishedAt: isoNow() };
  delete updated.directory;
  await writeJson(path.join(run.directory, "run.json"), updated);
  return { directory: run.directory, ...updated };
}
