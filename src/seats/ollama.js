import { ModelSeat, normalizeResponse } from "./base.js";
import { ProviderError } from "../errors.js";
import { isoNow, withTimeout } from "../utils.js";

export class OllamaSeat extends ModelSeat {
  constructor(options = {}) {
    super({
      id: options.id || "ollama",
      provider: "ollama",
      model: options.model || "auto",
      billingMode: "local",
      readOnly: true,
    });
    this.fetch = options.fetch || globalThis.fetch;
    this.baseUrl = (options.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  }

  async health(signal) {
    try {
      const response = await withTimeout(
        (timedSignal) => this.fetch(`${this.baseUrl}/api/tags`, { signal: timedSignal }),
        1_500,
        signal,
      );
      if (!response.ok) return { available: false, status: response.status };
      const payload = await response.json();
      const modelNames = (payload.models || []).map((model) => model.name || model.model).filter(Boolean);
      const modelAvailable = this.model === "auto" ? modelNames.length > 0 : modelNames.includes(this.model);
      return {
        available: modelAvailable,
        serverAvailable: true,
        models: modelNames.length,
        model: this.model,
        modelAvailable,
      };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  async isAvailable() {
    return (await this.health()).available;
  }

  async listModels() {
    const response = await this.fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.models || []).map((model) => ({ id: model.name || model.model, provider: "ollama" }));
  }

  async resolveModel() {
    if (this.model !== "auto") return this.model;
    const models = await this.listModels();
    if (!models.length) throw new ProviderError("Ollama is running but has no local models");
    return models[0].id;
  }

  async run(request) {
    const model = await this.resolveModel();
    const startedAt = isoNow();
    const response = await withTimeout(
      (signal) =>
        this.fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [
              ...(request.system ? [{ role: "system", content: request.system }] : []),
              { role: "user", content: request.user },
            ],
          }),
        }),
      request.timeoutMs,
      request.signal,
    );
    if (!response.ok) throw new ProviderError(`Ollama returned HTTP ${response.status}`);
    const payload = await response.json();
    return normalizeResponse(
      this,
      {
        text: payload.choices?.[0]?.message?.content || "",
        model: payload.model || model,
        usage: {
          inputTokens: payload.usage?.prompt_tokens,
          outputTokens: payload.usage?.completion_tokens,
        },
      },
      startedAt,
    );
  }
}
