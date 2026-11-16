import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ENV_LLM_CONTEXT_TOKENS, ENV_LLM_MAX_OUTPUT_TOKENS, ENV_LLM_TIMEOUT_MS, LOCAL_DEFAULT_CONTEXT_TOKENS, LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_ANTHROPIC_MODEL, DEFAULT_LOCAL_BASE_URL, ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_EFFORT, ENV_LLM_MODE, ENV_LLM_MODEL,
  LLM_MODES, type LlmMode,
} from "@app-brain/brain-protocol";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatProvider } from "./openai";
import { SamplingProvider } from "./sampling";
import type { LlmProvider } from "./types";

export interface LlmSetup {
  mode: LlmMode;
  /** The model asked for, for status and pricing before any call. */
  model: string | null;
  /** Null when the server cannot generate right now; `problem` says why. */
  provider: LlmProvider | null;
  problem: string | null;
}

const positiveInt = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n > 0 ? n : undefined;
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Builds the provider from the environment the extension passed. Evaluated on every use rather than once,
 * because whether sampling works depends on the client that connected after startup. The API key is read
 * here and handed straight to the SDK: it is never stored on the setup object, logged, or put in a message.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv, server: Server): LlmSetup {
  const raw = (env[ENV_LLM_MODE] ?? "agent").trim() || "agent";
  const mode: LlmMode = (LLM_MODES as readonly string[]).includes(raw) ? (raw as LlmMode) : "agent";
  const unknownMode = mode === "agent" && raw !== "agent" ? `Unknown LLM mode “${raw}”.` : null;
  const model = env[ENV_LLM_MODEL]?.trim() || null;

  switch (mode) {
    case "agent":
      return { mode, model: null, provider: null, problem: unknownMode ?? "Server-side generation is off (LLM mode “agent”): agents write docs with save_summary. Pick another mode in the settings to let the server write them." };
    case "api-key": {
      const apiKey = env[ENV_LLM_API_KEY]?.trim();
      const m = model ?? DEFAULT_ANTHROPIC_MODEL;
      if (!apiKey) return { mode, model: m, provider: null, problem: "No API key. Run “Brain: Set LLM API Key”." };
      const effort = (EFFORTS as readonly string[]).includes(env[ENV_LLM_EFFORT] ?? "") ? (env[ENV_LLM_EFFORT] as (typeof EFFORTS)[number]) : undefined;
      return { mode, model: m, provider: new AnthropicProvider({ apiKey, model: m, baseURL: env[ENV_LLM_BASE_URL]?.trim() || undefined, effort }), problem: null };
    }
    case "local": {
      if (!model) return { mode, model: null, provider: null, problem: "Set “brain.llm.model” to the model your local server runs (for example llama3.1)." };
      const baseUrl = env[ENV_LLM_BASE_URL]?.trim() || DEFAULT_LOCAL_BASE_URL;
      return {
        mode, model, problem: null,
        provider: new OpenAiCompatProvider({
          baseUrl, model, apiKey: env[ENV_LLM_API_KEY]?.trim() || undefined,
          contextTokens: positiveInt(env[ENV_LLM_CONTEXT_TOKENS]) ?? LOCAL_DEFAULT_CONTEXT_TOKENS,
          maxOutputTokens: positiveInt(env[ENV_LLM_MAX_OUTPUT_TOKENS]) ?? LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
          timeoutMs: positiveInt(env[ENV_LLM_TIMEOUT_MS]),
        }),
      };
    }
    case "vscode-lm": {
      if (!SamplingProvider.available(server)) return { mode, model, provider: null, problem: "The editor is not connected, or it cannot run prompts for the server. Use the VS Code extension." };
      return { mode, model, provider: new SamplingProvider(server, model), problem: null };
    }
  }
}
