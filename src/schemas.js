import { ValidationError } from "./errors.js";

export function extractStructured(response) {
  if (response?.structured && typeof response.structured === "object") return response.structured;
  const text = response?.text || String(response || "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      const firstObject = candidate.indexOf("{");
      const lastObject = candidate.lastIndexOf("}");
      const firstArray = candidate.indexOf("[");
      const lastArray = candidate.lastIndexOf("]");
      for (const [first, last] of [
        [firstObject, lastObject],
        [firstArray, lastArray],
      ]) {
        if (first >= 0 && last > first) {
          try {
            return JSON.parse(candidate.slice(first, last + 1));
          } catch {
            // Try the next bounded extraction shape.
          }
        }
      }
    }
  }
  throw new ValidationError("Response did not contain valid JSON");
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function confidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validateCandidate(value) {
  const errors = [];
  for (const field of ["summary", "recommendation"]) {
    if (typeof value?.[field] !== "string") errors.push(`${field} must be a string`);
  }
  for (const field of ["reasoningSummary", "assumptions", "risks", "unknowns", "verificationSteps"]) {
    if (!isStringArray(value?.[field])) errors.push(`${field} must be an array of strings`);
  }
  if (!confidence(value?.confidence)) errors.push("confidence must be between 0 and 1");
  return { valid: errors.length === 0, errors };
}

export function validateCritique(value) {
  const errors = [];
  if (typeof value?.strongestPointInOtherAnswer !== "string") errors.push("strongestPointInOtherAnswer must be a string");
  if (!Array.isArray(value?.criticalIssues)) errors.push("criticalIssues must be an array");
  else {
    value.criticalIssues.forEach((issue, index) => {
      if (typeof issue?.issue !== "string" || typeof issue?.why !== "string") {
        errors.push(`criticalIssues[${index}] is invalid`);
      }
      if (!["low", "medium", "high", "fatal"].includes(issue?.severity)) {
        errors.push(`criticalIssues[${index}].severity is invalid`);
      }
    });
  }
  for (const field of ["positionChanges", "stillDisagreeOn"]) {
    if (!Array.isArray(value?.[field])) errors.push(`${field} must be an array`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateRevision(value) {
  const errors = [];
  if (typeof value?.finalPosition !== "string") errors.push("finalPosition must be a string");
  for (const field of ["changesFromOriginal", "acceptedCritiques", "rejectedCritiques", "remainingRisks"]) {
    if (!Array.isArray(value?.[field])) errors.push(`${field} must be an array`);
  }
  if (!confidence(value?.confidence)) errors.push("confidence must be between 0 and 1");
  return { valid: errors.length === 0, errors };
}

export function validateSynthesis(value) {
  const errors = [];
  if (typeof value?.recommendation !== "string") errors.push("recommendation must be a string");
  for (const field of ["why", "consensus", "unresolvedDisagreements", "risks", "verificationBeforeAction"]) {
    if (!Array.isArray(value?.[field])) errors.push(`${field} must be an array`);
  }
  if (!["primary", "challenger", "hybrid", "neither"].includes(value?.preferredCandidate)) {
    errors.push("preferredCandidate is invalid");
  }
  if (!confidence(value?.confidence)) errors.push("confidence must be between 0 and 1");
  return { valid: errors.length === 0, errors };
}

export function validateFindings(value) {
  const findings = Array.isArray(value) ? value : value?.findings;
  const errors = [];
  if (!Array.isArray(findings)) return { valid: false, errors: ["findings must be an array"] };
  findings.forEach((finding, index) => {
    if (typeof finding?.issue !== "string" || typeof finding?.file !== "string") {
      errors.push(`findings[${index}] is invalid`);
    }
    if (!["info", "low", "medium", "high", "critical"].includes(finding?.severity)) {
      errors.push(`findings[${index}].severity is invalid`);
    }
  });
  return { valid: errors.length === 0, errors, value: findings };
}

export function assertValid(value, validator, label = "structured response") {
  const result = validator(value);
  if (!result.valid) throw new ValidationError(`Invalid ${label}: ${result.errors.join("; ")}`, result.errors);
  return result.value ?? value;
}

export const STRUCTURED_SHAPES = Object.freeze({
  candidate: {
    summary: "string",
    recommendation: "string",
    reasoningSummary: ["string"],
    assumptions: ["string"],
    risks: ["string"],
    unknowns: ["string"],
    verificationSteps: ["string"],
    confidence: "number 0..1",
  },
  critique: {
    strongestPointInOtherAnswer: "string",
    criticalIssues: [{ issue: "string", severity: "low|medium|high|fatal", why: "string", verification: "string" }],
    positionChanges: [],
    stillDisagreeOn: [],
  },
  revision: {
    finalPosition: "string",
    changesFromOriginal: [],
    acceptedCritiques: [],
    rejectedCritiques: [{ critique: "string", reason: "string" }],
    remainingRisks: [],
    confidence: "number 0..1",
  },
  synthesis: {
    recommendation: "string",
    why: [],
    consensus: [],
    unresolvedDisagreements: [],
    risks: [],
    verificationBeforeAction: [],
    preferredCandidate: "primary|challenger|hybrid|neither",
    confidence: "number 0..1",
  },
});

