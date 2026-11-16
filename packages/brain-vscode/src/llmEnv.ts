import type { DaemonLlm } from "./daemonManager";
import {
  ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_CONTEXT_TOKENS, ENV_LLM_EFFORT, ENV_LLM_MAX_OUTPUT_TOKENS, ENV_LLM_MODE, ENV_LLM_MODEL, ENV_LLM_TIMEOUT_MS,
  LLM_MODES, LOCAL_PRESETS, MIN_CONTEXT_TOKENS, type LocalPreset,
} from "@app-brain/brain-protocol";

/** Pure (no `vscode` import) so the rules about what reaches the server are tested. */
export interface LlmSettings {
  mode: string;
  model: string;
  baseUrl: string;
  effort: string;
  /** Local mode only. Optional so settings written before they existed still work. */
  preset?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  timeoutSeconds?: number;
}

/** The URL a local server is reached at: an explicit one wins, else the preset's well-known address. */
export function localBaseUrl(s: Pick<LlmSettings, "baseUrl" | "preset">): string {
  const explicit = s.baseUrl.trim();
  if (explicit) return explicit;
  const preset = (s.preset ?? "ollama") as LocalPreset;
  return LOCAL_PRESETS[preset]?.baseUrl ?? "";
}

/** Problems with the local settings that would make a run fail or silently give poor results, in words to act on. */
export function localProblems(s: LlmSettings): string[] {
  if (s.mode !== "local") return [];
  const out: string[] = [];
  if (!s.model.trim()) out.push("Set “brain.llm.model” to the model your local server runs. “Brain: Choose Local Model” lists what it has.");
  if (!localBaseUrl(s)) out.push("The “custom” preset needs “brain.llm.baseUrl”: your server's OpenAI-compatible URL, usually ending in /v1.");
  else {
    try { new URL(localBaseUrl(s)); } catch { out.push(`“${localBaseUrl(s)}” is not a valid URL.`); }
  }
  const ctx = s.contextTokens;
  if (ctx !== undefined && ctx > 0 && ctx < MIN_CONTEXT_TOKENS) out.push(`The context window (${ctx} tokens) is too small to document code. Use at least ${MIN_CONTEXT_TOKENS}, and run the model with that much.`);
  return out;
}

/**
 * The environment variables that tell the server how to reach an LLM. Three rules keep the key safe:
 * it goes only to modes that can use one, it travels in the environment of the process we spawn (never
 * on its command line, where `ps` shows it), and it is absent from everything else.
 */
export function llmEnv(s: LlmSettings, apiKey: string | undefined): Record<string, string> {
  const mode = (LLM_MODES as readonly string[]).includes(s.mode) ? s.mode : "agent";
  const env: Record<string, string> = {};
  if (mode === "agent") return env;
  env[ENV_LLM_MODE] = mode;
  const model = s.model.trim();
  if (model) env[ENV_LLM_MODEL] = model;
  if (mode === "api-key" || mode === "local") {
    const base = mode === "local" ? localBaseUrl(s) : s.baseUrl.trim();
    if (base) env[ENV_LLM_BASE_URL] = base;
    const key = apiKey?.trim();
    if (key) env[ENV_LLM_API_KEY] = key;
  }
  if (mode === "api-key" && s.effort.trim()) env[ENV_LLM_EFFORT] = s.effort.trim();
  if (mode === "local") {
    if ((s.contextTokens ?? 0) > 0) env[ENV_LLM_CONTEXT_TOKENS] = String(Math.floor(s.contextTokens!));
    if ((s.maxOutputTokens ?? 0) > 0) env[ENV_LLM_MAX_OUTPUT_TOKENS] = String(Math.floor(s.maxOutputTokens!));
    if ((s.timeoutSeconds ?? 0) > 0) env[ENV_LLM_TIMEOUT_MS] = String(Math.floor(s.timeoutSeconds! * 1000));
  }
  return env;
}

/** Returns a problem to show the person typing a key, or undefined when it looks usable. */
export function validateApiKey(input: string): string | undefined {
  const k = input.trim();
  if (!k) return "Enter a key.";
  if (/\s/.test(k)) return "A key has no spaces or line breaks. Paste it again without any.";
  if (k.length > 512) return "That is too long to be an API key.";
  return undefined;
}

/**
 * The same settings in the shape the daemon is started with (and fingerprinted by). Built from `llmEnv`, so the rules about
 * which mode may carry a key and an effort hold for both, and a fingerprint can never disagree with what was applied.
 */
export function daemonLlm(s: LlmSettings, apiKey: string | undefined): DaemonLlm {
  const env = llmEnv(s, apiKey);
  return {
    mode: env[ENV_LLM_MODE] ?? "agent", model: env[ENV_LLM_MODEL] ?? "", baseUrl: env[ENV_LLM_BASE_URL] ?? "",
    effort: env[ENV_LLM_EFFORT] ?? "", apiKey: env[ENV_LLM_API_KEY] ?? "",
    contextTokens: Number(env[ENV_LLM_CONTEXT_TOKENS]) || 0, maxOutputTokens: Number(env[ENV_LLM_MAX_OUTPUT_TOKENS]) || 0, timeoutMs: Number(env[ENV_LLM_TIMEOUT_MS]) || 0,
  };
}
