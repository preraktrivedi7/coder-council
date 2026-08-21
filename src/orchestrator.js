import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CouncilError, ValidationError } from "./errors.js";
import {
  STRUCTURED_SHAPES,
  extractStructured,
  validateCandidate,
  validateCritique,
  validateRevision,
  validateSynthesis,
} from "./schemas.js";
import { RunStore } from "./store.js";
import { clone, createId, isoNow, sha256, withTimeout } from "./utils.js";

const PROMPT_NAMES = ["candidate", "critic", "reviser", "arbiter", "synthesizer"];

async function loadPrompts() {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");
  const entries = await Promise.all(
    PROMPT_NAMES.map(async (name) => [name, (await fs.readFile(path.join(directory, `${name}.md`), "utf8")).trim()]),
  );
  return Object.fromEntries(entries);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export function createTaskPacket(input = {}) {
  const packet = {
    id: input.id || createId("task"),
    createdAt: input.createdAt || isoNow(),
    objective: input.objective || "",
    constraints: clone(input.constraints || []),
    projectContext: input.projectContext || "",
    decisionContext: input.decisionContext || "",
    requestedOutput: input.requestedOutput || "Actionable answer",
    evaluationCriteria: clone(input.evaluationCriteria || []),
  };
  return deepFreeze(packet);
}

export function compareCandidates(primary, challenger) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const sameRecommendation = normalize(primary.recommendation) === normalize(challenger.recommendation);
  const primaryRisks = new Set(primary.risks.map(normalize));
  const challengerRisks = new Set(challenger.risks.map(normalize));
  const uniquePrimary = primary.risks.filter((risk) => !challengerRisks.has(normalize(risk)));
  const uniqueChallenger = challenger.risks.filter((risk) => !primaryRisks.has(normalize(risk)));
  const disagreements = sameRecommendation
    ? []
    : [
        {
          topic: "recommendation",
          primaryPosition: primary.recommendation,
          challengerPosition: challenger.recommendation,
          severity: "high",
          resolvableBy: "judgment",
        },
      ];
  return {
    agreement: sameRecommendation
      ? [{ claim: primary.recommendation, strength: "strong" }]
      : [{ claim: "Both candidates addressed the same controlled task", strength: "partial" }],
    disagreements,
    uniquePrimaryInsights: uniquePrimary,
    uniqueChallengerInsights: uniqueChallenger,
    needsCrossCritique: !sameRecommendation || uniquePrimary.length > 0 || uniqueChallenger.length > 0,
    needsExternalVerification:
      primary.unknowns.length > 0 || challenger.unknowns.length > 0 ||
      primary.verificationSteps.length > 0 || challenger.verificationSteps.length > 0,
  };
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async use(operation) {
    if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

class WorkflowRuntime {
  constructor(options) {
    this.maxCalls = options.maxCalls;
    this.timeoutMs = options.timeoutMs;
    this.projectRoot = options.projectRoot;
    this.runId = options.runId;
    this.signal = options.signal;
    this.calls = [];
    this.semaphore = new Semaphore(options.maxConcurrentCalls || 2);
  }

  async invoke(seat, request) {
    if (this.calls.length >= this.maxCalls) throw new CouncilError(`Model call budget exceeded (${this.maxCalls})`);
    const call = {
      index: this.calls.length,
      seat: seat.id,
      purpose: request.purpose,
      startedAt: isoNow(),
      finishedAt: null,
      model: null,
      error: null,
    };
    this.calls.push(call);
    try {
      const response = await this.semaphore.use(() =>
        withTimeout(
          (signal) =>
            seat.run({
              ...request,
              runId: this.runId,
              projectRoot: this.projectRoot,
              timeoutMs: this.timeoutMs,
              signal,
              readOnly: request.readOnly ?? true,
            }),
          this.timeoutMs,
          this.signal,
        ),
      );
      call.finishedAt = isoNow();
      call.model = response.model;
      call.provider = response.provider;
      call.latencyMs = response.latencyMs;
      call.usage = response.usage;
      call.billingMode = response.billingMode;
      return response;
    } catch (error) {
      call.finishedAt = isoNow();
      call.error = { name: error.name, message: error.message };
      throw error;
    }
  }

  async structured(seat, request, validator, shape, { retries = 1 } = {}) {
    let feedback = "";
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.invoke(seat, {
          ...request,
          user: `${request.user}\n\nRequired JSON shape:\n${JSON.stringify(shape, null, 2)}${feedback}`,
        });
        const value = extractStructured(response);
        const validation = validator(value);
        if (!validation.valid) throw new ValidationError(validation.errors.join("; "));
        return { value: validation.value ?? value, response, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !(error instanceof ValidationError)) throw error;
        feedback = `\n\nPrevious output was invalid: ${error.message}. Return corrected JSON only.`;
      }
    }
    throw lastError;
  }
}

function candidateUser(taskPacket, taskHash) {
  return `Controlled TaskPacket hash: ${taskHash}\n\n${JSON.stringify(taskPacket, null, 2)}`;
}

function safeSynthesis(primary, challenger, comparison) {
  const preferred = comparison.disagreements.length ? "hybrid" : "primary";
  return {
    recommendation:
      preferred === "primary"
        ? primary.finalPosition || primary.recommendation
        : `${primary.finalPosition || primary.recommendation}\n\nChallenger: ${challenger.finalPosition || challenger.recommendation}`,
    why: ["Bounded deterministic synthesis was used after structured synthesis was unavailable."],
    consensus: comparison.agreement.map((item) => item.claim),
    unresolvedDisagreements: comparison.disagreements,
    risks: [...new Set([...(primary.remainingRisks || primary.risks || []), ...(challenger.remainingRisks || challenger.risks || [])])],
    verificationBeforeAction: [],
    preferredCandidate: preferred,
    confidence: Math.min(primary.confidence ?? 0.5, challenger.confidence ?? 0.5),
  };
}

export function formatSynthesis(synthesis) {
  const items = (values) => (values.length ? values.map((value) => `- ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n") : "- None");
  return [
    `# Recommendation\n\n${synthesis.recommendation}`,
    `## Why\n\n${items(synthesis.why)}`,
    `## Agreement\n\n${items(synthesis.consensus)}`,
    `## Unresolved disagreement\n\n${items(synthesis.unresolvedDisagreements)}`,
    `## Verification needed\n\n${items(synthesis.verificationBeforeAction)}`,
    `## Confidence\n\n${synthesis.confidence}`,
  ].join("\n\n");
}

export async function runCouncil(options) {
  const {
    root,
    config,
    primary,
    challenger,
    arbiter = null,
    objective,
    projectContext = "",
    decisionContext = "",
    constraints = [],
    evaluationCriteria = [],
    explicitChallenger = false,
    signal,
    store = new RunStore(root),
    projectCommit = null,
  } = options;
  const prompts = await loadPrompts();
  const taskPacket = createTaskPacket({
    objective,
    projectContext,
    decisionContext,
    constraints,
    evaluationCriteria,
    requestedOutput: "Evidence-backed recommendation with risks and verification",
  });
  const taskHash = sha256(taskPacket);
  const run = await store.create({
    workflow: "council",
    metadata: {
      taskHash,
      projectCommit,
      candidateIsolation: {
        sameTaskHash: true,
        sharedConversation: false,
        candidateAReceivedCandidateB: false,
        candidateBReceivedCandidateA: false,
      },
    },
  });
  const runtime = new WorkflowRuntime({
    maxCalls: config.budgets.maxModelCallsPerRun,
    maxConcurrentCalls: Math.min(2, config.budgets.maxConcurrentCalls),
    timeoutMs: config.budgets.timeoutSeconds * 1000,
    projectRoot: root,
    runId: run.id,
    signal,
  });
  const storedTask = config.privacy.storePrompts
    ? { ...taskPacket, hash: taskHash }
    : { ...taskPacket, objective: "[not stored]", projectContext: "[not stored]", decisionContext: "[not stored]", hash: taskHash };
  const storedResponse = (value) => (config.privacy.storeResponses ? value : { stored: false });
  await store.writeStage(run, "task", storedTask);
  await store.writeStage(run, "context", {
    taskHash,
    projectContext: config.privacy.storePrompts ? projectContext : "[not stored]",
    decisionContext: config.privacy.storePrompts ? decisionContext : "[not stored]",
    candidateEvidence: { materiallyEquivalent: true, primaryTaskHash: taskHash, challengerTaskHash: taskHash },
  });
  const controlledUser = candidateUser(taskPacket, taskHash);
  try {
    const [primarySettled, challengerSettled] = await Promise.allSettled([
      runtime.structured(
        primary,
        { purpose: "candidate", system: prompts.candidate, user: controlledUser },
        validateCandidate,
        STRUCTURED_SHAPES.candidate,
      ),
      runtime.structured(
        challenger,
        { purpose: "candidate", system: prompts.candidate, user: controlledUser },
        validateCandidate,
        STRUCTURED_SHAPES.candidate,
      ),
    ]);
    if (primarySettled.status === "rejected") throw primarySettled.reason;
    if (challengerSettled.status === "rejected") {
      if (explicitChallenger) throw challengerSettled.reason;
      const primaryCandidate = primarySettled.value.value;
      const degraded = {
        recommendation: primaryCandidate.recommendation,
        why: primaryCandidate.reasoningSummary,
        consensus: [],
        unresolvedDisagreements: ["Challenger unavailable; no independent comparison was completed."],
        risks: primaryCandidate.risks,
        verificationBeforeAction: primaryCandidate.verificationSteps,
        preferredCandidate: "primary",
        confidence: primaryCandidate.confidence,
      };
      await store.writeStage(run, "primary-candidate", storedResponse(primaryCandidate));
      await store.writeStage(run, "synthesis", storedResponse(degraded));
      await store.writeFinal(run, config.privacy.storeResponses ? formatSynthesis(degraded) : "Response storage disabled.");
      await store.finish(run, "complete", {
        calls: runtime.calls,
        degradedMode: true,
        degradedReason: challengerSettled.reason.message,
      });
      return { run, taskPacket, taskHash, synthesis: degraded, degraded: true, text: formatSynthesis(degraded) };
    }

    const primaryCandidate = primarySettled.value.value;
    const challengerCandidate = challengerSettled.value.value;
    await Promise.all([
      store.writeStage(run, "primary-candidate", storedResponse(primaryCandidate)),
      store.writeStage(run, "challenger-candidate", storedResponse(challengerCandidate)),
    ]);
    const comparison = compareCandidates(primaryCandidate, challengerCandidate);
    await store.writeStage(run, "comparison", storedResponse(comparison));

    let primaryCritique = null;
    let challengerCritique = null;
    let primaryRevision = { finalPosition: primaryCandidate.recommendation, changesFromOriginal: [], acceptedCritiques: [], rejectedCritiques: [], remainingRisks: primaryCandidate.risks, confidence: primaryCandidate.confidence };
    let challengerRevision = { finalPosition: challengerCandidate.recommendation, changesFromOriginal: [], acceptedCritiques: [], rejectedCritiques: [], remainingRisks: challengerCandidate.risks, confidence: challengerCandidate.confidence };

    if (comparison.needsCrossCritique && config.debate.crossCritique) {
      [primaryCritique, challengerCritique] = (
        await Promise.all([
          runtime.structured(
            primary,
            {
              purpose: "critic",
              system: prompts.critic,
              user: JSON.stringify({ taskPacket, ownCandidate: primaryCandidate, otherCandidate: challengerCandidate, comparison }),
            },
            validateCritique,
            STRUCTURED_SHAPES.critique,
            { retries: 0 },
          ),
          runtime.structured(
            challenger,
            {
              purpose: "critic",
              system: prompts.critic,
              user: JSON.stringify({ taskPacket, ownCandidate: challengerCandidate, otherCandidate: primaryCandidate, comparison }),
            },
            validateCritique,
            STRUCTURED_SHAPES.critique,
            { retries: 0 },
          ),
        ])
      ).map((result) => result.value);
      await Promise.all([
        store.writeStage(run, "primary-critique", storedResponse(primaryCritique)),
        store.writeStage(run, "challenger-critique", storedResponse(challengerCritique)),
      ]);

      if (config.debate.revision) {
        [primaryRevision, challengerRevision] = (
          await Promise.all([
            runtime.structured(
              primary,
              {
                purpose: "revision",
                system: prompts.reviser,
                user: JSON.stringify({ taskPacket, ownCandidate: primaryCandidate, otherCandidate: challengerCandidate, comparison, primaryCritique, challengerCritique }),
              },
              validateRevision,
              STRUCTURED_SHAPES.revision,
              { retries: 0 },
            ),
            runtime.structured(
              challenger,
              {
                purpose: "revision",
                system: prompts.reviser,
                user: JSON.stringify({ taskPacket, ownCandidate: challengerCandidate, otherCandidate: primaryCandidate, comparison, primaryCritique: challengerCritique, challengerCritique: primaryCritique }),
              },
              validateRevision,
              STRUCTURED_SHAPES.revision,
              { retries: 0 },
            ),
          ])
        ).map((result) => result.value);
        await Promise.all([
          store.writeStage(run, "primary-revision", storedResponse(primaryRevision)),
          store.writeStage(run, "challenger-revision", storedResponse(challengerRevision)),
        ]);
      }
    }

    let arbiterResult = null;
    if (arbiter && runtime.calls.length <= runtime.maxCalls - 2 && (await arbiter.isAvailable())) {
      const response = await runtime.invoke(arbiter, {
        purpose: "arbiter",
        system: prompts.arbiter,
        user: JSON.stringify({ taskPacket, comparison, primaryRevision, challengerRevision }),
      });
      try {
        arbiterResult = extractStructured(response);
      } catch {
        arbiterResult = { summary: response.text };
      }
      await store.writeStage(run, "arbiter", storedResponse(arbiterResult));
    }

    let synthesis;
    try {
      synthesis = (
        await runtime.structured(
          primary,
          {
            purpose: "synthesis",
            system: prompts.synthesizer,
            user: JSON.stringify({ taskPacket, comparison, primaryRevision, challengerRevision, arbiter: arbiterResult }),
          },
          validateSynthesis,
          STRUCTURED_SHAPES.synthesis,
          { retries: 0 },
        )
      ).value;
    } catch (error) {
      if (!(error instanceof ValidationError) && !/budget/i.test(error.message)) throw error;
      synthesis = safeSynthesis(primaryRevision, challengerRevision, comparison);
    }
    const text = formatSynthesis(synthesis);
    await store.writeStage(run, "synthesis", storedResponse(synthesis));
    await store.writeFinal(run, config.privacy.storeResponses ? text : "Response storage disabled.");
    await store.finish(run, "complete", { calls: runtime.calls, degradedMode: false });
    return {
      run,
      taskPacket,
      taskHash,
      primaryCandidate,
      challengerCandidate,
      comparison,
      primaryCritique,
      challengerCritique,
      primaryRevision,
      challengerRevision,
      arbiter: arbiterResult,
      synthesis,
      degraded: false,
      text,
    };
  } catch (error) {
    await store.finish(run, signal?.aborted ? "abandoned" : "failed", {
      calls: runtime.calls,
      error: { name: error.name, message: error.message },
    });
    throw error;
  }
}

export async function runAsk(options) {
  const {
    root,
    config,
    primary,
    objective,
    projectContext = "",
    projectCommit = null,
    signal,
    store = new RunStore(root),
  } = options;
  const prompts = await loadPrompts();
  const taskPacket = createTaskPacket({ objective, projectContext, requestedOutput: "Direct answer" });
  const taskHash = sha256(taskPacket);
  const run = await store.create({ workflow: "ask", metadata: { taskHash, projectCommit } });
  const runtime = new WorkflowRuntime({
    maxCalls: config.budgets.maxModelCallsPerRun,
    maxConcurrentCalls: 1,
    timeoutMs: config.budgets.timeoutSeconds * 1000,
    projectRoot: root,
    runId: run.id,
    signal,
  });
  try {
    const response = await runtime.invoke(primary, {
      purpose: "candidate",
      system: prompts.candidate,
      user: candidateUser(taskPacket, taskHash),
    });
    await store.writeStage(
      run,
      "task",
      config.privacy.storePrompts
        ? { ...taskPacket, hash: taskHash }
        : { ...taskPacket, objective: "[not stored]", projectContext: "[not stored]", hash: taskHash },
    );
    await store.writeStage(run, "context", {
      taskHash,
      projectContext: config.privacy.storePrompts ? projectContext : "[not stored]",
    });
    await store.writeStage(run, "primary-candidate", config.privacy.storeResponses ? response : { stored: false });
    await store.writeFinal(run, config.privacy.storeResponses ? response.text : "Response storage disabled.");
    await store.finish(run, "complete", { calls: runtime.calls });
    return { run, taskPacket, taskHash, response, text: response.text };
  } catch (error) {
    await store.finish(run, signal?.aborted ? "abandoned" : "failed", {
      calls: runtime.calls,
      error: { name: error.name, message: error.message },
    });
    throw error;
  }
}
