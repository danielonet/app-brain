import { classifyHost } from "./host";
import { LlmError, type LlmLimits, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  /** Optional: local servers (Ollama, llama.cpp, LM Studio) usually need none. */
  apiKey?: string;
  timeoutMs?: number;
  contextTokens?: number | null;
  maxOutputTokens?: number;
}

/**
 * Any server that speaks the OpenAI chat-completions protocol, for running docs through a local model.
 * Code never leaves the machine. Plain fetch, no extra dependency.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly mode = "local" as const;
  readonly provider = "openai-compatible";
  readonly limits: LlmLimits;
  /** Free when it runs on this machine or your own network. An address on the internet is someone's paid service. */
  readonly free: boolean;

  private readonly opts: Omit<OpenAiCompatOptions, "apiKey">;
  private readonly apiKey: string | undefined;

  constructor({ apiKey, ...opts }: OpenAiCompatOptions) {
    this.opts = opts;
    this.apiKey = apiKey;
    this.limits = { contextTokens: opts.contextTokens ?? null, maxOutputTokens: opts.maxOutputTokens ?? 1500 };
    this.free = classifyHost(opts.baseUrl)?.reach !== "internet";
  }

  get baseUrl() {
    return this.opts.baseUrl;
  }
  get endpoint() {
    return this.opts.baseUrl;
  }

  /** Model ids the server offers (`GET /models`), so a person can pick one instead of typing it. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch (e) {
      throw new LlmError(`Could not reach ${this.opts.baseUrl}: ${(e as Error).message}`, "network");
    }
    if (!res.ok) throw new LlmError(`${this.opts.baseUrl}/models answered ${res.status}.`, res.status === 401 || res.status === 403 ? "auth" : "bad_request", res.status);
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[]; models?: { name?: unknown; model?: unknown }[] };
    // OpenAI shape first; Ollama's native listing uses `models[].name`.
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    const alt = (body.models ?? []).map((m) => m.name ?? m.model).filter((x): x is string => typeof x === "string");
    return [...new Set([...ids, ...alt])].sort();
  }

  get model() {
    return this.opts.model;
  }

  toJSON() {
    return { provider: this.provider, model: this.opts.model, baseUrl: this.opts.baseUrl, limits: this.limits };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `OpenAiCompatProvider(${this.opts.model})`;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 600_000); // local models can be slow
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: req.maxTokens,
          messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        }),
        signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError("Cancelled.", "cancelled");
      if (timeout.aborted) throw new LlmError("The local model did not answer in time.", "timeout");
      throw new LlmError(`Could not reach ${this.opts.baseUrl}: ${(e as Error).message}. Is the local server running?`, "network");
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : "bad_request";
      throw new LlmError(`${this.opts.baseUrl} answered ${res.status}: ${body}`, kind, res.status);
    }
    let json: { model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new LlmError("The local server did not return JSON.", "server");
    }
    const choice = json.choices?.[0];
    const reported = typeof json.usage?.prompt_tokens === "number" && typeof json.usage?.completion_tokens === "number";
    const text = choice?.message?.content ?? "";
    return {
      text,
      model: json.model || this.opts.model,
      inputTokens: reported ? json.usage!.prompt_tokens! : null,
      outputTokens: reported ? json.usage!.completion_tokens! : Math.ceil(text.length / 4),
      cachedTokens: null,
      tokensSource: reported ? "provider-reported" : "estimated",
      stopReason: choice?.finish_reason === "length" ? "max_tokens" : choice?.finish_reason === "content_filter" ? "refusal" : "end",
    };
  }
}
