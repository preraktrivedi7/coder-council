import { ModelSeat, normalizeResponse } from "./base.js";
import { ProviderError, SafetyError } from "../errors.js";
import { isoNow, withTimeout } from "../utils.js";

export function isFreeOpenRouterModel(model) {
  return model === "openrouter/free" || model?.endsWith(":free") === true;
}

export function assertOpenRouterRoute(model, spending) {
  if ((spending.openRouterFreeOnly || !spending.allowPaidInference) && !isFreeOpenRouterModel(model)) {
    throw new SafetyError(`OpenRouter route ${model} is not an explicitly free route`);
  }
}

export class OpenRouterSeat extends ModelSeat {
  constructor(options = {}) {
    super({
      id: options.id || "openrouterFree",
      provider: "openrouter",
      model: options.model || "openrouter/free",
      billingMode: "free",
      readOnly: true,
    });
    this.fetch = options.fetch || globalThis.fetch;
    this.apiKey = options.apiKey;
    this.spending = options.spending || { allowPaidInference: false, openRouterFreeOnly: true };
    this.baseUrl = options.baseUrl || "https://openrouter.ai/api/v1";
    this.tripped = false;
  }

  async health() {
    let safety = null;
    try {
      assertOpenRouterRoute(this.model, this.spending);
    } catch (error) {
      safety = error.message;
    }
    return {
      available: Boolean(this.apiKey) && !safety && !this.tripped,
      configured: Boolean(this.apiKey),
      freeOnly: this.spending.openRouterFreeOnly,
      safety,
      circuitTripped: this.tripped,
    };
  }

  async isAvailable() {
    return (await this.health()).available;
  }

  async listModels() {
    assertOpenRouterRoute(this.model, this.spending);
    return [{ id: this.model, provider: "openrouter", free: true }];
  }

  async run(request) {
    assertOpenRouterRoute(this.model, this.spending);
    if (this.tripped) throw new SafetyError("OpenRouter free-pool circuit breaker is tripped");
    if (!this.apiKey) throw new ProviderError("OPENROUTER_API_KEY is not configured", { authRequired: true });
    const startedAt = isoNow();
    const response = await withTimeout(
      (signal) =>
        this.fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
            "x-title": "Coder Council",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              ...(request.system ? [{ role: "system", content: request.system }] : []),
              { role: "user", content: request.user },
            ],
          }),
        }),
      request.timeoutMs,
      request.signal,
    );
    if (!response.ok) throw new ProviderError(`OpenRouter returned HTTP ${response.status}`);
    const payload = await response.json();
    const cost = payload.usage?.cost ?? null;
    if (cost !== null && Number(cost) > 0 && isFreeOpenRouterModel(this.model)) {
      this.tripped = true;
      throw new SafetyError("Provider reported nonzero cost for a supposedly free OpenRouter run");
    }
    return normalizeResponse(
      this,
      {
        text: payload.choices?.[0]?.message?.content || "",
        model: payload.model || this.model,
        usage: {
          inputTokens: payload.usage?.prompt_tokens,
          outputTokens: payload.usage?.completion_tokens,
          cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
          cost,
        },
      },
      startedAt,
    );
  }
}
