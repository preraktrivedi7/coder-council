import fs from "node:fs/promises";
import path from "node:path";
import { createId, ensureDir, isoNow, runCommand, sha256, withTimeout } from "./utils.js";
import { CouncilError, SafetyError, ValidationError } from "./errors.js";
import { extractStructured, validateFindings } from "./schemas.js";
import { councilPath, RunStore } from "./store.js";

const SEVERITY = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export async function captureGitState(root) {
  const [status, branch, commit, diff] = await Promise.all([
    runCommand(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--",
        ".",
        ":(exclude).council/runs/**",
        ":(exclude).council/logs/**",
        ":(exclude).council/evaluations/private-feedback.jsonl",
      ],
      { cwd: root },
    ),
    runCommand("git", ["branch", "--show-current"], { cwd: root }),
    runCommand("git", ["rev-parse", "HEAD"], { cwd: root }),
    runCommand("git", ["diff", "--no-ext-diff", "--binary"], { cwd: root, maxBytes: 8 * 1024 * 1024 }),
  ]);
  if ([status, branch, commit, diff].some((result) => result.code !== 0)) {
    throw new ValidationError("Current directory is not a readable Git working tree");
  }
  return {
    status: status.stdout.trimEnd(),
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
    diff: diff.stdout,
    fingerprint: sha256({ status: status.stdout, diff: diff.stdout }),
  };
}

export function dedupeFindings(groups) {
  const byIdentity = new Map();
  for (const group of groups) {
    for (const finding of group) {
      const identity = [
        String(finding.file || "").toLowerCase(),
        Number(finding.line || 0),
        String(finding.issue || "").toLowerCase().replace(/\W+/g, " ").trim(),
      ].join(":");
      const normalized = {
        id: finding.id || createId("finding"),
        severity: finding.severity || "info",
        file: finding.file || "",
        line: Number(finding.line || 0),
        issue: finding.issue || "",
        evidence: finding.evidence || "",
        recommendedFix: finding.recommendedFix || "",
        reportedBy: [...new Set(finding.reportedBy || [])],
      };
      if (!byIdentity.has(identity)) byIdentity.set(identity, normalized);
      else {
        const existing = byIdentity.get(identity);
        existing.reportedBy = [...new Set([...existing.reportedBy, ...normalized.reportedBy])];
        if (SEVERITY[normalized.severity] > SEVERITY[existing.severity]) existing.severity = normalized.severity;
        if (!existing.evidence && normalized.evidence) existing.evidence = normalized.evidence;
      }
    }
  }
  return [...byIdentity.values()].sort(
    (left, right) => SEVERITY[right.severity] - SEVERITY[left.severity] || left.file.localeCompare(right.file) || left.line - right.line,
  );
}

async function reviewWithSeat(seat, root, diff, timeoutMs, signal) {
  const response = await withTimeout(
    (timedSignal) =>
      seat.run({
        runId: createId("review"),
        purpose: "review",
        system:
          "Review only the supplied git diff. Do not edit files or run mutating commands. Return JSON findings and no private chain-of-thought.",
        user: `Return {"findings": [...]} using severity info|low|medium|high|critical.\n\nGit diff:\n${diff || "(empty diff)"}`,
        projectRoot: root,
        timeoutMs,
        signal: timedSignal,
        readOnly: true,
      }),
    timeoutMs,
    signal,
  );
  let value;
  try {
    value = extractStructured(response);
  } catch {
    return [];
  }
  const validation = validateFindings(value);
  if (!validation.valid) return [];
  return validation.value.map((finding) => ({
    ...finding,
    reportedBy: [...new Set([...(finding.reportedBy || []), seat.id])],
  }));
}

export async function reviewWorkingTree(options) {
  const { root, seats, timeoutMs = 600_000, signal, store = new RunStore(root) } = options;
  const before = await captureGitState(root);
  const run = await store.create({ workflow: "review", metadata: { projectCommit: before.commit } });
  const available = [];
  for (const seat of seats) {
    if (seat && (await seat.isAvailable())) available.push(seat);
  }
  if (!available.length) {
    await store.finish(run, "failed", { error: { name: "CouncilError", message: "No read-only review seat is available" } });
    throw new CouncilError("No read-only review seat is available");
  }
  try {
    const groups = await Promise.all(
      available.slice(0, 2).map((seat) => reviewWithSeat(seat, root, before.diff, timeoutMs, signal)),
    );
    const findings = dedupeFindings(groups);
    const after = await captureGitState(root);
    if (after.fingerprint !== before.fingerprint) {
      throw new SafetyError("Review changed the working tree; Council will not revert changes automatically");
    }
    await store.writeStage(run, "review", { findings });
    await store.writeFinal(
      run,
      findings.length
        ? findings.map((finding) => `- [${finding.severity}] ${finding.file}:${finding.line} ${finding.issue}`).join("\n")
        : "No actionable findings.",
    );
    await store.finish(run, "complete", { findings: findings.length });
    return { run, findings, before, after, text: findings.length ? JSON.stringify(findings, null, 2) : "No actionable findings." };
  } catch (error) {
    await store.finish(run, "failed", { error: { name: error.name, message: error.message } });
    throw error;
  }
}

export async function withWriterLock(root, operation) {
  const directory = councilPath(root);
  await ensureDir(directory);
  const lockPath = path.join(directory, "build.lock");
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: isoNow() })}\n`);
  } catch (error) {
    if (error.code === "EEXIST") throw new SafetyError("Another Council implementation writer is already active");
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

export function assertSafeVerificationCommand(command) {
  const forbidden = [
    /(?:^|\s)rm\s+-[a-z]*r/i,
    /git\s+reset\s+--hard/i,
    /git\s+clean\b/i,
    /git\s+push\b/i,
    /git\s+checkout\s+--/i,
    /\bsudo\b/i,
  ];
  if (forbidden.some((pattern) => pattern.test(command))) {
    throw new SafetyError(`Destructive or publishing verification command refused: ${command}`);
  }
}

export async function runVerification(root, commands, signal) {
  const results = [];
  for (const command of commands) {
    assertSafeVerificationCommand(command);
    const result = await runCommand("/bin/sh", ["-lc", command], {
      cwd: root,
      signal,
      timeoutMs: 10 * 60_000,
    });
    results.push({ command, code: result.code, stdout: result.stdout, stderr: result.stderr });
    if (result.code !== 0) break;
  }
  return results;
}

export async function buildWorkingTree(options) {
  const { root, writer, reviewers = [], objective, planText, config, signal, store = new RunStore(root) } = options;
  return withWriterLock(root, async () => {
    const before = await captureGitState(root);
    const run = await store.create({
      workflow: "build",
      metadata: { projectCommit: before.commit, dirtyAtStart: Boolean(before.status) },
    });
    try {
      const writerResponse = await writer.run({
        runId: run.id,
        purpose: "implementation",
        system:
          "You are the sole implementation writer. Preserve unrelated dirty changes. Do not reset, clean, commit, or push. Implement the approved task, test it, and summarize concise evidence without private chain-of-thought.",
        user: JSON.stringify({ objective, plan: planText, initialGitStatus: before.status }),
        projectRoot: root,
        timeoutMs: config.budgets.timeoutSeconds * 1000,
        signal,
        readOnly: false,
      });
      const verification = await runVerification(root, config.workflows.verificationCommands, signal);
      const failed = verification.some((result) => result.code !== 0);
      const review = failed || !reviewers.length
        ? { findings: [] }
        : await reviewWorkingTree({
            root,
            seats: reviewers,
            timeoutMs: config.budgets.timeoutSeconds * 1000,
            signal,
            store,
          });
      const material = review.findings.filter((finding) => ["critical", "high"].includes(finding.severity));
      let fixResponse = null;
      let finalVerification = verification;
      if (!failed && material.length) {
        fixResponse = await writer.run({
          runId: run.id,
          purpose: "implementation",
          system:
            "You remain the sole implementation writer. Address only supported review findings. Preserve unrelated changes; do not reset, clean, commit, or push.",
          user: JSON.stringify({ objective, findings: material }),
          projectRoot: root,
          timeoutMs: config.budgets.timeoutSeconds * 1000,
          signal,
          readOnly: false,
        });
        finalVerification = await runVerification(root, config.workflows.verificationCommands, signal);
      }
      const after = await captureGitState(root);
      const success = finalVerification.every((result) => result.code === 0);
      await store.writeStage(run, "build", {
        writer: writer.id,
        writerSummary: writerResponse.text,
        fixSummary: fixResponse?.text || null,
        verification: finalVerification.map(({ command, code }) => ({ command, code })),
        findings: review.findings,
        before: { branch: before.branch, commit: before.commit, status: before.status },
        after: { branch: after.branch, commit: after.commit, status: after.status },
      });
      await store.finish(run, success ? "complete" : "failed", { verificationPassed: success });
      if (!success) throw new CouncilError("Build verification failed");
      return {
        run,
        writer: writer.id,
        writerSummary: writerResponse.text,
        findings: review.findings,
        verification: finalVerification,
        before,
        after,
        text: `Build completed by ${writer.id}. Verification passed: ${finalVerification.map((item) => item.command).join(", ")}.`,
      };
    } catch (error) {
      await store.finish(run, signal?.aborted ? "abandoned" : "failed", {
        error: { name: error.name, message: error.message },
      });
      throw error;
    }
  });
}
