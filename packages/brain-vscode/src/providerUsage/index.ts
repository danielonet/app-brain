import { createHash } from "node:crypto";
import type { AnthropicOrgUsage, CopilotUsage, ProviderUsage } from "@app-brain/brain-protocol";
import { FetchLike, fetchAnthropicOrgUsage } from "./anthropicAdmin";
import { readClaudeCodeUsage } from "./claudeCodeLogs";
import { readCopilotUsage } from "./copilotLogs";
import { Pricing, emptyBlock } from "./shared";

export interface UsageSettings {
  claudeCodeLogs: boolean;
  /** Optional so callers written before it existed keep working: on by default, like Claude Code. */
  copilotLogs?: boolean;
  anthropicAdmin: boolean;
  lookbackDays: number;
}

export interface CollectOptions {
  workspace: string;
  pricing: Pricing;
  settings: UsageSettings;
  /** The Admin API key, from the editor's secret storage. */
  adminKey: string | undefined;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** This workspace's own `chatSessions` folder, where VS Code keeps Copilot Chat sessions. */
  copilotSessionsDir?: string;
  now?: Date;
  fetch?: FetchLike;
}

const ORG_REFRESH_MS = 60_000; // Anthropic asks for at most one poll a minute
let orgCache: { fingerprint: string; at: number; result: AnthropicOrgUsage } | undefined;

export const clampDays = (d: number) => Math.min(90, Math.max(1, Math.round(Number.isFinite(d) ? d : 30)));

/** Gathers what the providers report. Each source fails on its own; one failing never hides the other. */
export async function collectProviderUsage(o: CollectOptions): Promise<ProviderUsage> {
  const now = o.now ?? new Date();
  const days = clampDays(o.settings.lookbackDays);

  const claudeCode = o.settings.claudeCodeLogs
    ? await readClaudeCodeUsage({ workspace: o.workspace, pricing: o.pricing, lookbackDays: days, env: o.env, home: o.home, now })
    : { ...emptyBlock("off", "Reading Claude Code's local logs is turned off (setting brain.usage.claudeCodeLogs)."), source: null, sessions: 0 };

  const copilot: CopilotUsage = o.settings.copilotLogs === false
    ? { ...emptyBlock("off", "Reading Copilot Chat's local sessions is turned off (setting brain.usage.copilotLogs)."), source: null, sessions: 0, credits: null }
    : await readCopilotUsage({ dir: o.copilotSessionsDir, pricing: o.pricing, lookbackDays: days, now });

  let anthropicOrg: AnthropicOrgUsage;
  if (!o.settings.anthropicAdmin) {
    anthropicOrg = { ...emptyBlock("off", "Anthropic organisation usage is off. Turn on brain.usage.anthropicAdmin and run “Brain: Set Anthropic Admin Key”."), costIsBilled: false };
  } else if (!o.adminKey) {
    anthropicOrg = { ...emptyBlock("off", "No Anthropic Admin API key is set. Run “Brain: Set Anthropic Admin Key”."), costIsBilled: false };
  } else {
    // The fingerprint names the key and the window without keeping the key.
    const fingerprint = createHash("sha256").update(`${o.adminKey}\u0000${days}\u0000${JSON.stringify(o.pricing)}`).digest("hex");
    if (orgCache && orgCache.fingerprint === fingerprint && now.getTime() - orgCache.at < ORG_REFRESH_MS) anthropicOrg = orgCache.result;
    else {
      anthropicOrg = await fetchAnthropicOrgUsage({ key: o.adminKey, lookbackDays: days, pricing: o.pricing, fetch: o.fetch, now });
      if (anthropicOrg.state !== "error") orgCache = { fingerprint, at: now.getTime(), result: anthropicOrg };
    }
  }
  return { generatedAt: now.toISOString(), lookbackDays: days, claudeCode, copilot, anthropicOrg };
}

/** For tests. */
export const _clearOrgCache = () => { orgCache = undefined; };
