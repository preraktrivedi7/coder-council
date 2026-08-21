import { SafetyError } from "./errors.js";

export const SECRET_NAME_PATTERN = /(?:^|[_-])(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:[_-]|$)|(?:access|refresh|api|auth)(?:Key|Token|Secret|Password)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];

export function redactText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_VALUE_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
  return text;
}

export function redact(value, key = "") {
  if (SECRET_NAME_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  return value;
}

export function environmentCredentialNames(environment = process.env) {
  return Object.keys(environment).filter((name) => SECRET_NAME_PATTERN.test(name)).sort();
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function assertLoopbackHost(host) {
  if (!isLoopbackHost(host)) {
    throw new SafetyError(`Refusing non-loopback runtime host: ${host}`);
  }
}

export function assertNoCredentialsInProject(value) {
  const violations = [];
  const visit = (item, trail = []) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      const next = [...trail, key];
      if (SECRET_NAME_PATTERN.test(key) && child && child !== "[REDACTED]") {
        violations.push(next.join("."));
      }
      visit(child, next);
    }
  };
  visit(value);
  if (violations.length) {
    throw new SafetyError(`Credential-like fields may not be persisted: ${violations.join(", ")}`);
  }
}
