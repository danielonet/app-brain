import { ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_EFFORT, ENV_LLM_MODE, ENV_LLM_MODEL, LLM_MODES } from "@app-brain/brain-protocol";

/** Pure (no `vscode` import) so the rules about what reaches the server are tested. */
export interface LlmSettings {
  mode: string;
  model: string;
  baseUrl: string;
  effort: string;
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
    const base = s.baseUrl.trim();
    if (base) env[ENV_LLM_BASE_URL] = base;
    const key = apiKey?.trim();
    if (key) env[ENV_LLM_API_KEY] = key;
  }
  if (mode === "api-key" && s.effort.trim()) env[ENV_LLM_EFFORT] = s.effort.trim();
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
