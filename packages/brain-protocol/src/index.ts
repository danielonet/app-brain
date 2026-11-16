/**
 * Shared contract between brain-mcp (server) and brain-vscode (extension).
 * Single source of truth for resource URIs, tool names, config and status shapes.
 * See PLAN-VSCODE-EXTENSION.md §2 and §7.
 */
import { z } from "zod";

/** Bumped on any breaking change to tools, resources or schemas below. */
export const PROTOCOL_VERSION = "0.2";

/** OKF spec version the knowledge bundle is written in (PLAN-VSCODE-EXTENSION.md §5). */
export const OKF_VERSION = "0.2";

export const DEFAULT_OUTPUT_DIR = ".brain";

export const Resources = {
  status: "brain://status",
  config: "brain://config",
  usage: "brain://usage",
} as const;

/** Read-only tools for agents. Available to every client, no admin token. */
export const AgentTools = {
  searchCode: "search_code",
  getSymbol: "get_symbol",
  getNeighbors: "get_neighbors",
  impactOfChange: "impact_of_change",
} as const;

export const SYMBOL_KINDS = ["function", "class", "method", "interface", "type", "enum", "variable"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const AdminTools = {
  hello: "brain_admin_hello",
  init: "brain_admin_init",
  getConfig: "brain_admin_get_config",
  getConfigSchema: "brain_admin_get_config_schema",
  setConfig: "brain_admin_set_config",
  reindex: "brain_admin_reindex",
} as const;

export const ENV_ADMIN_TOKEN = "BRAIN_ADMIN_TOKEN";
export const ENV_WORKSPACE = "BRAIN_WORKSPACE";

// ---------------------------------------------------------------------------
// Team config: `.brain/config.json` (committed). Personal settings (server path,
// API keys) are NOT here; they live in VS Code settings / SecretStorage.
// ---------------------------------------------------------------------------

export const ConfigSchema = z
  .object({
    outputDir: z
      .string()
      .min(1)
      .describe("Root of all generated and curated output, relative to the workspace root.")
      .default(DEFAULT_OUTPUT_DIR),
    include: z.array(z.string()).describe("Glob patterns to index. Empty means everything not excluded.").default([]),
    exclude: z.array(z.string()).describe("Glob patterns never indexed, in addition to .gitignore and secret files.").default([]),
    languages: z.array(z.string()).describe("Languages to index. Empty means auto-detect.").default([]),
    docs: z
      .object({
        granularity: z.enum(["symbol", "file", "module", "architecture-only"]).default("module"),
        autoGenerate: z.boolean().default(false),
        maxCostUsd: z.number().nonnegative().nullable().describe("Stop a generation job at this spend. null means no cap.").default(null),
      })
      .default({}),
    commitKnowledge: z.boolean().describe("Whether the OKF bundle is meant to be committed.").default(true),
    pricing: z
      .record(
        z.object({
          inputPerMtok: z.number().nonnegative(),
          outputPerMtok: z.number().nonnegative(),
          cachedPerMtok: z.number().nonnegative().optional(),
        }),
      )
      .describe("USD per million tokens, by model id. Edited by the user; never hard-coded.")
      .default({}),
  })
  .strict();

export type BrainConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): BrainConfig {
  return ConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Status: `brain://status`
// ---------------------------------------------------------------------------

export const StatusSchema = z.object({
  state: z.enum(["starting", "idle", "indexing", "error"]),
  initialised: z.boolean().describe("True when <outputDir>/config.json exists."),
  workspace: z.string(),
  outputDir: z.string().describe("Absolute path of the output root."),
  serverVersion: z.string(),
  protocolVersion: z.string(),
  startedAt: z.string(),
  index: z.object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    byLanguage: z.record(z.number().int().nonnegative()),
    lastIndexedAt: z.string().nullable(),
  }),
  message: z.string().nullable(),
});

export type BrainStatus = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// Tool results (all admin tools return one JSON object in the text content).
// ---------------------------------------------------------------------------

export const HelloResultSchema = z.object({
  admin: z.boolean(),
  protocolVersion: z.string(),
  serverVersion: z.string(),
  adminTools: z.array(z.string()),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

export const InitResultSchema = z.object({
  created: z.array(z.string()).describe("Paths created, relative to the workspace."),
  alreadyInitialised: z.boolean(),
});
export type InitResult = z.infer<typeof InitResultSchema>;

export const ReindexResultSchema = z.object({
  files: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative().describe("Files parsed again because they were new or modified."),
  removed: z.number().int().nonnegative(),
  byLanguage: z.record(z.number().int().nonnegative()),
  durationMs: z.number().nonnegative(),
});
export type ReindexResult = z.infer<typeof ReindexResultSchema>;

/** Returned (as `isError` tool content) when config validation fails. */
export interface ConfigError {
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Agent usage log: `brain://usage` (PLAN-VSCODE-EXTENSION.md §4.4, level 1)
// ---------------------------------------------------------------------------

export const UsageEntrySchema = z.object({
  id: z.number().int(),
  ts: z.string(),
  client: z.string().describe("MCP clientInfo.name from the initialize handshake."),
  tool: z.string(),
  args: z.string().describe("JSON of the arguments, truncated."),
  resultTokens: z.number().int().nonnegative().describe("Estimated tokens returned (characters / 4)."),
  latencyMs: z.number().nonnegative(),
  isError: z.boolean(),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const UsageSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byClient: z.record(z.number().int().nonnegative()),
  byTool: z.record(z.number().int().nonnegative()),
  recent: z.array(UsageEntrySchema),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
