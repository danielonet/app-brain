import Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** For tests and gateways. Unset uses the public API. */
  baseURL?: string;
  /** Only sent when set: it is an error on models that do not take it, and a default is not ours to pick. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Claude through the official SDK. The request is deliberately plain: no `temperature` (removed on current
 * models, a 400), no `thinking` (the model's default applies), and no prefill. Non-streaming is right
 * here: a doc is a few thousand tokens at most, far below the size where the API wants streaming.
 */
export class AnthropicProvider implements LlmProvider {
  readonly mode = "api-key" as const;
  readonly provider = "anthropic";
  readonly limits = { contextTokens: null, maxOutputTokens: 8000 };
  readonly free = false;
  get endpoint() {
    return this.opts.baseURL ?? "https://api.anthropic.com";
  }
  private readonly client: Anthropic;

  private readonly opts: Omit<AnthropicOptions, "apiKey">;

  constructor({ apiKey, ...opts }: AnthropicOptions) {
    this.opts = opts; // the key is handed to the SDK and kept nowhere else
    this.client = new Anthropic({
      apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 180_000,
      maxRetries: opts.maxRetries ?? 3, // the SDK retries 408, 409, 429 and 5xx with backoff and honours retry-after
    });
  }

  get model() {
    return this.opts.model;
  }

  /** Whatever serialises or prints this object (JSON, util.inspect, a log line) gets no key. */
  toJSON() {
    return { provider: this.provider, model: this.opts.model };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `AnthropicProvider(${this.opts.model})`;
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.opts.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
        },
        { signal: req.signal },
      );
    } catch (e) {
      throw this.classify(e);
    }

    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const u = message.usage;
    // Cache reads and writes are billed differently from plain input but are all input the model read.
    const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return {
      text,
      model: message.model,
      inputTokens: u.input_tokens + cached,
      outputTokens: u.output_tokens,
      cachedTokens: cached || null,
      tokensSource: "provider-reported",
      stopReason: message.stop_reason === "end_turn" || message.stop_reason === "stop_sequence" ? "end" : message.stop_reason === "max_tokens" ? "max_tokens" : message.stop_reason === "refusal" ? "refusal" : "other",
    };
  }

  private classify(e: unknown): LlmError {
    if (e instanceof Anthropic.APIUserAbortError) return new LlmError("Cancelled.", "cancelled");
    if (e instanceof Anthropic.APIConnectionTimeoutError) return new LlmError("The request timed out.", "timeout");
    if (e instanceof Anthropic.APIConnectionError) return new LlmError(`Could not reach the API: ${e.message}`, "network");
    if (e instanceof Anthropic.AuthenticationError) return new LlmError("The API key was rejected (401). Set a valid key with “Brain: Set LLM API Key”.", "auth", 401);
    if (e instanceof Anthropic.PermissionDeniedError) return new LlmError(`The API key is not allowed to use this model (403): ${e.message}`, "auth", 403);
    if (e instanceof Anthropic.RateLimitError) return new LlmError("Rate limited (429), and the retries ran out.", "rate_limit", 429);
    if (e instanceof Anthropic.BadRequestError) return new LlmError(`The API rejected the request (400): ${e.message}`, "bad_request", 400);
    if (e instanceof Anthropic.NotFoundError) return new LlmError(`Model not found (404): ${this.opts.model}. Check “brain.llm.model”.`, "bad_request", 404);
    if (e instanceof Anthropic.APIError) return new LlmError(`API error ${e.status ?? ""}: ${e.message}`, (e.status ?? 0) >= 500 ? "server" : "unknown", e.status);
    return new LlmError(e instanceof Error ? e.message : String(e), "unknown");
  }
}
