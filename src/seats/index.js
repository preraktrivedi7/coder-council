import { KimiSeat, OpenAISeat } from "./opencode.js";
import { OpenRouterSeat } from "./openrouter.js";
import { OllamaSeat } from "./ollama.js";

export async function createSeatRegistry(context) {
  const { config, flags, environment } = context;
  const runtime = config.runtime;
  return {
    openai: new OpenAISeat({
      model: flags["openai-model"] || config.seats.openai.model,
      host: runtime.host,
      port: runtime.port,
      readOnly: true,
    }),
    kimi: new KimiSeat({
      model:
        flags["kimi-model"] ||
        (config.seats.kimi.model === "auto"
          ? "kimi-for-coding-oauth/kimi-for-coding"
          : config.seats.kimi.model),
      billingMode: "kimi-subscription",
      host: runtime.host,
      port: runtime.port,
      readOnly: true,
    }),
    openrouterFree: new OpenRouterSeat({
      model: config.seats.openrouterFree.model,
      apiKey: environment.OPENROUTER_API_KEY,
      spending: config.spending,
    }),
    ollama: new OllamaSeat({
      model: config.seats.ollama.model,
      baseUrl: environment.OLLAMA_BASE_URL,
    }),
  };
}

export { ModelSeat, FakeSeat } from "./base.js";
export { KimiSeat, OpenAISeat, OpenCodeSeat } from "./opencode.js";
export { OpenRouterSeat, assertOpenRouterRoute, isFreeOpenRouterModel } from "./openrouter.js";
export { OllamaSeat } from "./ollama.js";
