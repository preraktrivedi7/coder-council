import { ProviderError } from "../errors.js";
import { clone, isoNow, sleep } from "../utils.js";

export function nullUsage(usage = {}) {
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedTokens: usage.cachedTokens ?? null,
    cost: usage.cost ?? null,
    credits: usage.credits ?? null,
  };
}

export function normalizeResponse(seat, response, startedAt, finishedAt = isoNow()) {
  return {
    seat: seat.id,
    provider: response.provider || seat.provider,
    model: response.model || seat.model || "unknown",
    text: response.text || "",
    structured: response.structured ?? null,
    sessionId: response.sessionId ?? null,
    startedAt,
    finishedAt,
    latencyMs: Math.max(0, new Date(finishedAt) - new Date(startedAt)),
    usage: nullUsage(response.usage),
    billingMode: response.billingMode || seat.billingMode || "unknown",
    error: response.error ?? null,
  };
}

export class ModelSeat {
  constructor({ id, provider, model = "auto", billingMode = "unknown", readOnly = true }) {
    this.id = id;
    this.provider = provider;
    this.model = model;
    this.billingMode = billingMode;
    this.readOnly = readOnly;
  }

  async isAvailable() {
    return false;
  }

  async listModels() {
    return [];
  }

  async health() {
    return { available: await this.isAvailable() };
  }

  async run() {
    throw new ProviderError(`${this.id} does not implement run()`);
  }
}

export class FakeSeat extends ModelSeat {
  constructor(options = {}) {
    super({
      id: options.id || "fake",
      provider: options.provider || "fake",
      model: options.model || "fake-model",
      billingMode: options.billingMode || "local",
      readOnly: options.readOnly ?? true,
    });
    this.responses = [...(options.responses || [])];
    this.delayMs = options.delayMs || 0;
    this.failure = options.failure || null;
    this.requests = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async isAvailable() {
    return !this.failure;
  }

  async listModels() {
    return [{ id: this.model, provider: this.provider }];
  }

  async health() {
    return { available: !this.failure, provider: this.provider, model: this.model };
  }

  async run(request) {
    this.requests.push(clone(request));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const startedAt = isoNow();
    try {
      if (this.delayMs) await sleep(this.delayMs, request.signal);
      if (this.failure) throw this.failure;
      const next = this.responses.length ? this.responses.shift() : { text: `${this.id} response` };
      const response = typeof next === "function" ? await next(request, this) : next;
      return normalizeResponse(this, response, startedAt);
    } finally {
      this.active -= 1;
    }
  }
}

