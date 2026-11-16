import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

/**
 * The editor's own models, reached the standard MCP way: the server asks its client to run a prompt
 * (`sampling/createMessage`). Only the extension can call VS Code's language-model API, so this is how a
 * subscription model (Copilot) can write docs without the server holding a key. The client decides whether
 * and how to answer, and the user is asked for consent by VS Code.
 *
 * Token counts, when the client supplies them in `_meta.usage`, are the client's measurement and are
 * reported as such. Without them they are estimated from the text.
 */
export class SamplingProvider implements LlmProvider {
  readonly mode = "vscode-lm" as const;
  readonly provider = "vscode-lm";
  readonly limits = { contextTokens: null, maxOutputTokens: 4000 };
  readonly free = false;
  readonly endpoint = null;

  constructor(private readonly server: Server, readonly model: string | null) {}

  /** Whether the connected client can answer. */
  static available(server: Server): boolean {
    return Boolean(server.getClientCapabilities()?.sampling);
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    if (!SamplingProvider.available(this.server)) {
      throw new LlmError("The connected client cannot run prompts (no MCP sampling). Use the VS Code extension, or pick another LLM mode.", "unsupported");
    }
    let result;
    try {
      result = await this.server.createMessage(
        {
          systemPrompt: req.system,
          messages: [{ role: "user", content: { type: "text", text: req.user } }],
          maxTokens: req.maxTokens,
          includeContext: "none",
          ...(this.model ? { modelPreferences: { hints: [{ name: this.model }] } } : {}),
        },
        { signal: req.signal, timeout: 300_000 },
      );
    } catch (e) {
      if (req.signal?.aborted) throw new LlmError("Cancelled.", "cancelled");
      throw new LlmError(`The editor could not run the prompt: ${(e as Error).message}`, "unknown");
    }
    const content = Array.isArray(result.content) ? result.content[0] : result.content;
    const text = content && content.type === "text" ? content.text : "";
    const usage = (result._meta as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined)?.usage;
    const measured = typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number";
    return {
      text,
      model: result.model || this.model || "vscode-lm",
      inputTokens: measured ? usage!.inputTokens! : null,
      outputTokens: measured ? usage!.outputTokens! : Math.ceil(text.length / 4),
      cachedTokens: null,
      tokensSource: measured ? "agent-reported" : "estimated",
      stopReason: result.stopReason === "maxTokens" ? "max_tokens" : "end",
    };
  }
}
