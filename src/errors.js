export const EXIT_CODES = Object.freeze({
  OK: 0,
  VALIDATION: 2,
  PROVIDER_UNAVAILABLE: 3,
  AUTH_REQUIRED: 4,
  TIMEOUT: 5,
  WORKFLOW: 6,
  SAFETY_REFUSAL: 7,
  CANCELLED: 130,
});

export class CouncilError extends Error {
  constructor(message, exitCode = EXIT_CODES.WORKFLOW, details = null) {
    super(message);
    this.name = "CouncilError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class ValidationError extends CouncilError {
  constructor(message, details = null) {
    super(message, EXIT_CODES.VALIDATION, details);
    this.name = "ValidationError";
  }
}

export class SafetyError extends CouncilError {
  constructor(message, details = null) {
    super(message, EXIT_CODES.SAFETY_REFUSAL, details);
    this.name = "SafetyError";
  }
}

export class ProviderError extends CouncilError {
  constructor(message, { authRequired = false, details = null } = {}) {
    super(
      message,
      authRequired ? EXIT_CODES.AUTH_REQUIRED : EXIT_CODES.PROVIDER_UNAVAILABLE,
      details,
    );
    this.name = "ProviderError";
  }
}

export class TimeoutError extends CouncilError {
  constructor(message = "Operation timed out") {
    super(message, EXIT_CODES.TIMEOUT);
    this.name = "TimeoutError";
  }
}

