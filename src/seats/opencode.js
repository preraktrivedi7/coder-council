import { ModelSeat, normalizeResponse } from "./base.js";
import { ProviderError } from "../errors.js";
import { redactText } from "../security.js";
import { isoNow, runCommand, unwrapData, withTimeout } from "../utils.js";

function splitModel(model, defaultProvider) {
  if (!model || model === "auto") return { providerID: defaultProvider, modelID: "auto" };
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: defaultProvider, modelID: model };
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

function responseText(payload) {
  const data = unwrapData(payload) || {};
  const parts = data.parts || payload?.parts || [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseCliJsonLines(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // OpenCode versions that do not support JSON output are handled below.
    }
  }
  const texts = events
    .flatMap((event) => [event.text, event.content, event.part?.text, event.item?.text])
    .filter((value) => typeof value === "string");
  return texts.at(-1) || stdout.trim();
}

export class OpenCodeSeat extends ModelSeat {
  constructor(options = {}) {
    super({
      id: options.id,
      provider: options.providerID || options.provider || "openai",
      model: options.model || "auto",
      billingMode: options.billingMode || "unknown",
      readOnly: options.readOnly ?? true,
    });
    this.providerID = options.providerID || this.provider;
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 4096;
    this.baseUrl = options.baseUrl || `http://${this.host}:${this.port}`;
    this.fetch = options.fetch || globalThis.fetch;
    this.runner = options.runner || runCommand;
    this.command = options.command || "opencode";
    this.serverAvailable = null;
    this.cliAvailable = null;
  }

  async serverHealth(signal) {
    try {
      const response = await withTimeout(
        (timedSignal) => this.fetch(`${this.baseUrl}/global/health`, { signal: timedSignal }),
        2_000,
        signal,
      );
      if (!response.ok) return { available: false, mode: "server", status: response.status };
      const details = await response.json();
      this.serverAvailable = details.healthy === true;
      return { available: this.serverAvailable, mode: "server", version: details.version || null };
    } catch (error) {
      this.serverAvailable = false;
      return { available: false, mode: "server", error: redactText(error.message) };
    }
  }

  async cliHealth(signal) {
    try {
      const result = await this.runner(this.command, ["--version"], { signal, timeoutMs: 3_000 });
      this.cliAvailable = result.code === 0;
      return {
        available: this.cliAvailable,
        mode: "cli",
        version: this.cliAvailable ? (result.stdout || result.stderr).trim() : null,
      };
    } catch (error) {
      this.cliAvailable = false;
      return { available: false, mode: "cli", error: redactText(error.message) };
    }
  }

  async health(signal) {
    const server = await this.serverHealth(signal);
    if (server.available) {
      try {
        const payload = unwrapData(await this.fetchJson("/provider", { signal }));
        const connected = payload?.connected;
        const authenticated = Array.isArray(connected) ? connected.includes(this.providerID) : null;
        return {
          ...server,
          available: authenticated === null ? server.available : authenticated,
          authenticated,
          provider: this.providerID,
        };
      } catch (error) {
        return { ...server, available: false, authenticated: false, error: redactText(error.message) };
      }
    }
    const cli = await this.cliHealth(signal);
    if (!cli.available) return cli;
    try {
      const auth = await this.runner(this.command, ["auth", "list"], { signal, timeoutMs: 3_000 });
      const authenticated = auth.code === 0 && new RegExp(this.providerID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(auth.stdout || auth.stderr);
      return { ...cli, available: authenticated, authenticated, provider: this.providerID };
    } catch (error) {
      return { ...cli, available: false, authenticated: false, error: redactText(error.message) };
    }
  }

  async isAvailable() {
    return (await this.health()).available;
  }

  async fetchJson(route, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${route}`, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    if (!response.ok) throw new ProviderError(`OpenCode ${route} returned HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  async listModels() {
    if (this.serverAvailable ?? (await this.serverHealth()).available) {
      const payload = unwrapData(await this.fetchJson("/provider"));
      const providers = payload?.all || payload?.providers || [];
      const provider = providers.find((item) => item.id === this.providerID || item.providerID === this.providerID);
      if (!provider) return [];
      const models = Array.isArray(provider.models)
        ? provider.models
        : Object.entries(provider.models || {}).map(([id, details]) => ({ id, ...details }));
      return models.map((item) => ({
        id: `${this.providerID}/${item.id || item.modelID}`,
        name: item.name || item.id || item.modelID,
        provider: this.providerID,
      }));
    }
    return this.model === "auto" ? [] : [{ id: this.model, provider: this.providerID }];
  }

  async resolveModel() {
    const selected = splitModel(this.model, this.providerID);
    if (selected.modelID !== "auto") return selected;
    if (!(this.serverAvailable ?? (await this.serverHealth()).available)) return selected;
    const payload = unwrapData(await this.fetchJson("/provider"));
    const defaults = payload?.default || {};
    const defaultModel = defaults[this.providerID];
    if (typeof defaultModel === "string") return splitModel(defaultModel, this.providerID);
    const models = await this.listModels();
    if (!models.length) return selected;
    return splitModel(models[0].id, this.providerID);
  }

  async runServer(request, model, startedAt) {
    const sessionPayload = unwrapData(
      await this.fetchJson("/session", {
        method: "POST",
        body: JSON.stringify({ title: `Coder Council ${request.purpose || "run"} ${request.runId}` }),
        signal: request.signal,
      }),
    );
    const sessionId = sessionPayload?.id;
    if (!sessionId) throw new ProviderError("OpenCode did not return a session id");
    const tools = request.readOnly === false ? undefined : { bash: false, edit: false, write: false, patch: false };
    try {
      const payload = await this.fetchJson(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        body: JSON.stringify({
          model,
          system: request.system,
          ...(tools ? { tools } : {}),
          parts: [{ type: "text", text: request.user }],
        }),
        signal: request.signal,
      });
      const text = responseText(payload);
      if (!text) throw new ProviderError("OpenCode returned no text response");
      const data = unwrapData(payload);
      const usage = data?.info?.tokens || data?.info?.usage || {};
      return normalizeResponse(
        this,
        {
          text,
          sessionId,
          model: `${model.providerID}/${model.modelID}`,
          usage: {
            inputTokens: usage.input ?? usage.inputTokens,
            outputTokens: usage.output ?? usage.outputTokens,
            cachedTokens: usage.cache?.read ?? usage.cachedTokens,
            cost: data?.info?.cost,
          },
        },
        startedAt,
      );
    } catch (error) {
      if (request.signal?.aborted) {
        await this.fetchJson(`/session/${encodeURIComponent(sessionId)}/abort`, {
          method: "POST",
          body: "{}",
        }).catch(() => {});
      }
      throw error;
    }
  }

  async runCli(request, model, startedAt) {
    const prompt = [request.system, request.user].filter(Boolean).join("\n\n");
    const args = ["run", "--format", "json"];
    if (model.modelID !== "auto") args.push("--model", `${model.providerID}/${model.modelID}`);
    args.push(prompt);
    const result = await this.runner(this.command, args, {
      cwd: request.projectRoot,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });
    if (result.code !== 0) {
      const diagnostic = redactText(result.stderr || result.stdout || `exit ${result.code}`);
      throw new ProviderError(`OpenCode CLI failed: ${diagnostic}`);
    }
    return normalizeResponse(
      this,
      { text: parseCliJsonLines(result.stdout), model: `${model.providerID}/${model.modelID}` },
      startedAt,
    );
  }

  async run(request) {
    const startedAt = isoNow();
    const model = await this.resolveModel();
    const server = await this.serverHealth(request.signal);
    if (server.available) return this.runServer(request, model, startedAt);
    const cli = await this.cliHealth(request.signal);
    if (cli.available) return this.runCli(request, model, startedAt);
    throw new ProviderError(`OpenCode is unavailable for seat ${this.id}`);
  }

  async authenticate({ dryRun = false } = {}) {
    const command = `opencode auth login -p ${this.providerID}`;
    if (dryRun) return { delegated: true, interactive: true, command };
    const health = await this.cliHealth();
    if (!health.available) throw new ProviderError("OpenCode is not installed");
    return {
      delegated: true,
      interactive: true,
      command,
      next: `Run \`${command}\` in a terminal and complete provider approval.`,
    };
  }
}

export class OpenAISeat extends OpenCodeSeat {
  constructor(options = {}) {
    super({ ...options, id: options.id || "openai", providerID: "openai", billingMode: "chatgpt-plan" });
    this.codexCommand = options.codexCommand || "codex";
  }

  async codexHealth(signal) {
    try {
      const [version, login] = await Promise.all([
        this.runner(this.codexCommand, ["--version"], { signal, timeoutMs: 3_000 }),
        this.runner(this.codexCommand, ["login", "status"], { signal, timeoutMs: 3_000 }),
      ]);
      return {
        available: version.code === 0 && login.code === 0,
        mode: "codex-cli",
        version: (version.stdout || version.stderr).trim() || null,
        authenticated: login.code === 0,
      };
    } catch (error) {
      return { available: false, mode: "codex-cli", error: redactText(error.message) };
    }
  }

  async health(signal) {
    const opencode = await super.health(signal);
    if (opencode.available) return opencode;
    return this.codexHealth(signal);
  }

  async runCodex(request, startedAt) {
    const prompt = [request.system, request.user].filter(Boolean).join("\n\n");
    const args = [
      "exec",
      "--json",
      "--sandbox",
      request.readOnly === false ? "workspace-write" : "read-only",
      "-C",
      request.projectRoot,
    ];
    if (this.model && this.model !== "auto") args.push("--model", this.model.replace(/^openai\//, ""));
    args.push("-");
    const result = await this.runner(this.codexCommand, args, {
      cwd: request.projectRoot,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      input: prompt,
    });
    if (result.code !== 0) {
      throw new ProviderError(`Codex CLI failed: ${redactText(result.stderr || result.stdout)}`, {
        authRequired: /login|auth/i.test(result.stderr),
      });
    }
    const events = result.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const agentMessages = events
      .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
      .map((event) => event.item.text)
      .filter(Boolean);
    const text = agentMessages.at(-1) || parseCliJsonLines(result.stdout);
    if (!text) throw new ProviderError("Codex CLI returned no agent message");
    const usageEvent = events.findLast((event) => event.usage)?.usage || {};
    return normalizeResponse(
      this,
      {
        provider: "openai-codex",
        model: this.model === "auto" ? "auto" : this.model,
        text,
        usage: {
          inputTokens: usageEvent.input_tokens,
          outputTokens: usageEvent.output_tokens,
          cachedTokens: usageEvent.cached_input_tokens,
        },
      },
      startedAt,
    );
  }

  async run(request) {
    const opencode = await super.health(request.signal);
    if (opencode.available) return super.run(request);
    const codex = await this.codexHealth(request.signal);
    if (codex.available) return this.runCodex(request, isoNow());
    throw new ProviderError("Neither OpenCode nor authenticated Codex CLI is available", { authRequired: true });
  }

  async authenticate({ dryRun = false } = {}) {
    const openCode = await this.cliHealth();
    const command = openCode.available ? "opencode auth login -p openai" : "codex login";
    return {
      delegated: true,
      interactive: true,
      command,
      dryRun,
      next: `Run \`${command}\` in a terminal and complete OpenAI approval.`,
    };
  }
}

export class KimiSeat extends OpenCodeSeat {
  constructor(options = {}) {
    super({
      ...options,
      id: options.id || "kimi",
      providerID: "kimi-for-coding-oauth",
      billingMode: "kimi-subscription",
      readOnly: true,
    });
  }

  async authenticate({ dryRun = false } = {}) {
    return {
      delegated: true,
      interactive: true,
      dryRun,
      communityPlugin: "opencode-kimi-full@1.4.0",
      commands: [
        "opencode plugin opencode-kimi-full@1.4.0 --global",
        "opencode auth login -p kimi-for-coding-oauth",
      ],
      next:
        "Review and install the pinned community plugin, complete Kimi device approval, then enable seats.kimi in .council/config.jsonc.",
    };
  }
}
