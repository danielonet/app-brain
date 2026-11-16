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
  pendingReview: "brain://knowledge/pending-review",
  coverage: "brain://coverage",
} as const;

/** Read-only tools for agents. Available to every client, no admin token. */
export const AgentTools = {
  searchCode: "search_code",
  getSymbol: "get_symbol",
  getNeighbors: "get_neighbors",
  impactOfChange: "impact_of_change",
  listUndocumented: "list_undocumented",
  saveSummary: "save_summary",
  getOverview: "get_overview",
  getGraph: "get_graph",
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
  reviewSummary: "brain_admin_review_summary",
  validate: "brain_admin_validate",
  exportGraph: "brain_admin_export_graph",
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
        granularity: z
          .enum(["symbol", "file", "module", "architecture-only"])
          .describe("How finely code is documented: per symbol, per file, per module, or only an architecture overview.")
          .default("module"),
        autoGenerate: z.boolean().describe("Generate docs automatically after indexing, instead of only on request.").default(false),
        maxCostUsd: z.number().nonnegative().nullable().describe("Stop a generation job at this spend. Leave empty for no cap.").default(null),
      })
      .default({}),
    commitKnowledge: z.boolean().describe("Whether the OKF bundle is meant to be committed.").default(true),
    pricing: z
      .record(
        z.object({
          inputPerMtok: z.number().nonnegative().describe("Input price, USD per million tokens."),
          outputPerMtok: z.number().nonnegative().describe("Output price, USD per million tokens."),
          cachedPerMtok: z.number().nonnegative().optional().describe("Cached-input price, USD per million tokens (optional)."),
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
  knowledge: z.object({
    reviewed: z.number().int().nonnegative(),
    drafts: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
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
  /** Dotted, for humans and logs. Ambiguous when a key contains a dot (model ids do). */
  path: string;
  /** Exact location, for matching an error to a form field. */
  pathParts: (string | number)[];
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

// ---------------------------------------------------------------------------
// Knowledge bundle (OKF) and review: PLAN-VSCODE-EXTENSION.md §5
// ---------------------------------------------------------------------------

export const DOC_KINDS = ["file", "module"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** A generated concept waiting in `drafts/` for a human decision. */
export const PendingItemSchema = z.object({
  target: z.string().describe("Repo-relative file or directory the doc describes."),
  kind: z.enum(DOC_KINDS),
  conceptPath: z.string().describe("Path of the concept inside the bundle, e.g. files/src/a.ts.md"),
  draftFile: z.string().describe("Workspace-relative path of the draft file."),
  description: z.string(),
  generatedBy: z.string(),
  generatedAt: z.string(),
  model: z.string().nullable(),
  stale: z.boolean().describe("The code changed after this draft was written."),
  replacesReviewed: z.boolean().describe("A reviewed doc for this target already exists."),
});
export type PendingItem = z.infer<typeof PendingItemSchema>;

export const CoverageSchema = z.object({
  files: z.object({ total: z.number().int(), reviewed: z.number().int(), drafts: z.number().int(), stale: z.number().int() }),
  modules: z.object({ total: z.number().int(), reviewed: z.number().int(), drafts: z.number().int(), stale: z.number().int() }),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ValidationIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.enum(["no-frontmatter", "bad-frontmatter", "missing-type", "index-frontmatter", "broken-link", "orphan", "cycle", "depends-on-missing"]),
  file: z.string().describe("Path inside the knowledge bundle."),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationResultSchema = z.object({
  conformant: z.boolean().describe("No errors: every concept parses and has a type (OKF §10)."),
  concepts: z.number().int(),
  issues: z.array(ValidationIssueSchema),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ReviewResultSchema = z.object({
  action: z.enum(["approve", "reject"]),
  target: z.string(),
  conceptPath: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

// ---------------------------------------------------------------------------
// Dependency graph: PLAN-VSCODE-EXTENSION.md §5.2
// ---------------------------------------------------------------------------

export const DOC_STATUSES = ["none", "draft", "reviewed", "stale"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

/** OKF trust tiers, derived from `verified` and never stored (OKF §4). */
export const TRUST_TIERS = ["unverified", "machine-confirmed", "human-reviewed"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const GRAPH_LEVELS = ["module", "file"] as const;
export type GraphLevel = (typeof GRAPH_LEVELS)[number];

export const GraphNodeSchema = z.object({
  id: z.string().describe("File path, or directory for a module. `.` is the repo root."),
  kind: z.enum(["file", "module"]),
  files: z.number().int().describe("Source files in the node (1 for a file)."),
  symbols: z.number().int(),
  importedBy: z.number().int().describe("Files outside the node that import something in it."),
  imports: z.number().int().describe("Files outside the node that it imports."),
  language: z.string().nullable(),
  doc: z.enum(DOC_STATUSES),
  trust: z.enum(TRUST_TIERS).nullable(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  weight: z.number().int().describe("Import links this edge stands for (1 at file level)."),
  confidence: z.enum(["resolved", "guess"]),
  cycle: z.boolean().describe("Both ends are in a circular dependency."),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSchema = z.object({
  level: z.enum(GRAPH_LEVELS),
  root: z.string().nullable(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  cycles: z.array(z.array(z.string())).describe("Circular dependencies among modules, whole repo."),
  totals: z.object({ nodes: z.number().int(), edges: z.number().int() }),
  truncated: z.boolean(),
});
export type Graph = z.infer<typeof GraphSchema>;
