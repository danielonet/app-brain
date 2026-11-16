import type { LlmMode } from "@app-brain/brain-protocol";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export type TokensSource = "provider-reported" | "agent-reported" | "estimated";

export interface LlmResponse {
  text: string;
  /** The model that actually answered. May differ from the one asked for. */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  tokensSource: TokensSource;
  stopReason: "end" | "max_tokens" | "refusal" | "other";
}

export interface LlmProvider {
  readonly mode: Exclude<LlmMode, "agent">;
  /** Who is on the other end, for the llm_call record: "anthropic", "openai-compatible", "vscode-lm". */
  readonly provider: string;
  /** The model asked for, when known up front. */
  readonly model: string | null;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * What went wrong, as a category the generator can act on: `auth` stops a job at once (retrying a bad
 * key just burns time), `rate_limit` and `server` are worth another try, `bad_request` is not.
 */
export type LlmErrorKind = "auth" | "rate_limit" | "timeout" | "network" | "server" | "bad_request" | "cancelled" | "unsupported" | "unknown";

export class LlmError extends Error {
  constructor(message: string, readonly kind: LlmErrorKind, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}
