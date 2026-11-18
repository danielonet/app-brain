import { timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  AdminTools,
  AgentTools,
  BrainStatus,
  DOC_KINDS,
  GRAPH_LEVELS,
  GenerationScopeSchema,
  ConfigSchema,
  HelloResult,
  PROTOCOL_VERSION,
  PutEdgesInputSchema,
  type PutEdgesInput,
  type PutEdgesResult,
  ReindexResult,
  Resources,
  SYMBOL_KINDS,
} from "@app-brain/brain-protocol";
import { Indexer } from "./indexer";
import { summarize, toCsv, toMarkdown } from "./cost";
import { Generator } from "./generate/generator";
import { llmFromEnv } from "./llm/factory";
import { listLlmModels, testLlm } from "./llm/diagnose";
import { SamplingProvider } from "./llm/sampling";
import { buildGraph, toJsonLd } from "./okf/graph";
import { Knowledge } from "./okf/knowledge";
import { BrainStore, type SymbolHit } from "./store";
import { watchWorkspace } from "./watcher";
import { BrainWorkspace } from "./workspace";

export const SERVER_VERSION = "0.1.0";

/** Clients whose calls are not "agent usage": the extension reads state through admin tools. */
const OWN_CLIENT = "brain-vscode";
const USAGE_RETENTION_DAYS = 30;

/** What the core knows about one connected client. */
export interface SessionHandle {
  server: McpServer;
  subscribed: Set<string>;
  admin: () => boolean;
  connectedAt: number;
}

/** Stands in for "nobody who can answer prompts is connected". */
const NO_CLIENT = { getClientCapabilities: () => undefined } as unknown as Server;

export interface BrainServerOptions {
  /** How clients reach this server, for status. Default "stdio". */
  transport?: "stdio" | "http";
  /** Set by the daemon: lets an admin client stop it. */
  onShutdown?: () => void;
  /** The daemon watches this for its idle timeout. */
  onSessionsChanged?: (count: number) => void;
  workspace: BrainWorkspace;
  /** Token a client must present in brain_admin_hello to use admin tools. Unset: admin tools are refused. */
  adminToken?: string;
  /** Watch the workspace and re-index on change. Default true. */
  watch?: boolean;
  /** Where the LLM settings come from. Defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Pretty JSON for admin tools (read by people and the extension). */
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string, extra?: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2) }],
});
/** Compact JSON for agent tools: every token the agent reads costs it. */
const compact = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const firstSentence = (doc: string | null, max = 160): string | null => {
  if (!doc) return null;
  const flat = doc.replace(/\s+/g, " ").trim();
  const m = flat.match(/^.*?[.!?](\s|$)/);
  const s = (m ? m[0] : flat).trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

const brief = (h: SymbolHit) => ({
  symbol: h.qualified_name,
  kind: h.kind,
  path: h.path,
  lines: `${h.start_line}-${h.end_line}`,
  signature: h.signature,
  doc: firstSentence(h.docstring),
  exported: Boolean(h.exported),
});

export function createBrainCore(opts: BrainServerOptions) {
  const ws = opts.workspace;
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  /** Everyone connected. One per stdio process; one per HTTP session in the daemon. All share this core. */
  const sessions = new Set<SessionHandle>();

  const diskPath = ws.abs(".cache", "brain.db");
  // Before `init` nothing is written to the workspace: the index lives in memory.
  let store = BrainStore.open(":memory:");
  let initialisedAtStart = false;
  const indexer = new Indexer(ws, store, { onProgress: (m) => setState({ message: m }) });

  const knowledge = new Knowledge(
    ws,
    () => store,
    () => {
      notify(Resources.pendingReview);
      notify(Resources.coverage);
      notify(Resources.docStatus);
      notify(Resources.status);
    },
    () => state.state === "idle",
  );

  const env = opts.env ?? process.env;
  const llm = () => llmFromEnv(env, samplingHost());
  /** The connected client that can run prompts for us: an admin one (the extension) first. */
  function samplingHost(): Server {
    const candidates = [...sessions].filter((s) => SamplingProvider.available(s.server.server)).sort((a, b) => Number(b.admin()) - Number(a.admin()));
    return (candidates[0] ?? [...sessions][0])?.server.server ?? NO_CLIENT;
  }
  const generator = new Generator({
    ws,
    store: () => store,
    knowledge,
    llm,
    log,
    onChange: () => {
      notify(Resources.generation);
      notify(Resources.status);
    },
  });

  const state = { state: "starting" as BrainStatus["state"], message: null as string | null };
  let lastNotify = 0;

  async function costSummary() {
    return summarize(store.llmCallRows(), await ws.readConfig());
  }
  async function costTotals() {
    const s = await costSummary();
    return { calls: s.totals.calls, spendUsd: s.totals.spendUsd, complete: s.complete };
  }

  async function status(): Promise<BrainStatus> {
    const c = store.counts();
    return {
      state: state.state,
      initialised: await ws.isInitialised(),
      workspace: ws.root,
      outputDir: ws.abs(),
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAt,
      server: {
        pid: process.pid,
        transport: opts.transport ?? "stdio",
        clients: [...sessions].map((s) => ({ name: s.server.server.getClientVersion()?.name ?? null, admin: s.admin() })),
      },
      index: { files: c.files, symbols: c.symbols, edges: c.edges, byLanguage: c.byLanguage, lastIndexedAt: c.lastIndexedAt },
      knowledge: await knowledge.counts(),
      llm: (({ mode, model, provider, problem }) => ({ mode, model, ready: provider !== null, problem }))(llm()),
      cost: await costTotals(),
      message: state.message,
    };
  }

  function notify(uri: string) {
    for (const s of sessions) if (s.subscribed.has(uri)) void s.server.server.sendResourceUpdated({ uri }).catch(() => {});
  }
  function setState(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    const now = Date.now();
    if (patch.state || now - lastNotify > 250) { // progress messages are throttled, state changes are not
      lastNotify = now;
      notify(Resources.status);
    }
  }

  /** After `init`, move the index from memory to .brain/.cache/brain.db so it survives restarts. */
  async function persistIndex() {
    if (store.location !== ":memory:") return;
    const old = store;
    // Copy, don't rebuild: the index is complete now, and docs can be saved straight away.
    store = await indexer.swapStore((current) => {
      current.persistTo(diskPath);
      return BrainStore.open(diskPath);
    });
    old.close();
    store.pruneUsage(USAGE_RETENTION_DAYS);
    void reindex().catch(() => {}); // picks up edits made while this ran; cheap when nothing changed
  }

  async function reindex(): Promise<ReindexResult> {
    setState({ state: "indexing", message: "Scanning files" });
    try {
      const result = await indexer.run();
      setState({ state: "idle", message: null });
      notify(Resources.status);
      void knowledge.migrateDependencyLinks().catch(() => {}); // once per run: old absolute links become relative ones
      return result;
    } catch (e) {
      log(`index failed: ${(e as Error).stack ?? e}`);
      setState({ state: "error", message: (e as Error).message });
      throw e;
    }
  }


  /** A new MCP session: its own server object, subscriptions and admin flag, over the shared core. */
  function createSession(): SessionHandle {
  const server = new McpServer({ name: "brain-mcp", version: SERVER_VERSION });
  const subscribed = new Set<string>();
  let admin = false; // set by a successful brain_admin_hello, for this session only

  // ---- resources: read-only, available to every client ---------------------
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  const resource = (name: string, uri: string, title: string, description: string, read: () => Promise<unknown> | unknown) =>
    server.registerResource(name, uri, { title, description, mimeType: "application/json" }, async (u) => ({
      contents: [{ uri: u.href, mimeType: "application/json", text: JSON.stringify(await read(), null, 2) }],
    }));

  resource("status", Resources.status, "Brain status", "Server state, initialisation and index counters.", status);
  resource("config", Resources.config, "Brain config", "Team config (.brain/config.json), or defaults when not initialised.", () => ws.readConfig());
  resource("pending-review", Resources.pendingReview, "Pending review", "Generated docs in drafts/ waiting for a human to approve or reject them.", () => knowledge.pending());
  resource("coverage", Resources.coverage, "Documentation coverage", "How many files and modules have reviewed, draft or stale docs.", () => knowledge.coverage());
  resource("doc-status", Resources.docStatus, "Documentation status", "Every file and module with its doc status (none, draft, reviewed, stale) and where the doc is.", async () => ({ items: await knowledge.docStatuses() }));
  resource("generation", Resources.generation, "Doc generation", "Progress and results of the server's doc generation job.", () => generator.state);
  resource("cost-summary", Resources.costSummary, "LLM cost", "Spend, tokens and models behind generated docs, with how much of it is exact versus estimated.", costSummary);
  resource("usage", Resources.usage, "Agent usage", "Recent calls agents made to the brain tools, with totals by client and tool.", () => store.usageSummary());

  // ---- agent tools: read-only, no admin token ---------------------------------
  /** Registers a read-only tool and records every call in the usage log (§4.4 level 1). */
  function agentTool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: true } }, (async (args: z.infer<z.ZodObject<S>>) => {
      const t0 = performance.now();
      let result: ReturnType<typeof compact> | ReturnType<typeof fail>;
      try {
        result = compact(await handler(args));
      } catch (e) {
        result = fail((e as Error).message);
      }
      const client = server.server.getClientVersion()?.name ?? "unknown";
      if (client !== OWN_CLIENT) {
        try {
          store.logUsage({
            client, tool: name, args: JSON.stringify(args),
            resultTokens: Math.ceil(result.content[0].text.length / 4),
            latencyMs: Math.round(performance.now() - t0), isError: "isError" in result,
          });
          notify(Resources.usage);
        } catch (e) {
          log(`usage log failed: ${(e as Error).message}`);
        }
      }
      return result;
    }) as never);
  }

  const notReady = () => (state.state === "indexing" || state.state === "starting" ? { indexing: true, note: "Index is still building; results may be incomplete." } : {});

  agentTool(
    AgentTools.searchCode,
    "Find functions, classes, methods, types and other symbols by name or by what they do. Matches identifiers (camelCase and snake_case split into words), signatures and doc comments. Returns compact hits; use get_symbol for one symbol's details.",
    {
      query: z.string().min(1).describe("Words or an identifier, e.g. 'user by id' or 'SessionStore'."),
      kind: z.enum(SYMBOL_KINDS).optional().describe("Restrict to one kind of symbol."),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0).describe("For paging: pass next_offset from the previous result."),
    },
    ({ query, kind, limit, offset }) => {
      const { total, hits } = store.search(query, { kind, limit, offset });
      const next = offset + hits.length;
      return { total, results: hits.map(brief), ...(next < total ? { next_offset: next } : {}), ...notReady() };
    },
  );

  agentTool(
    AgentTools.getSymbol,
    "Details of one symbol: signature, location (path and line range), doc comment, and documentation status. Pass a qualified name like 'SessionStore.get' or a plain name; add path to disambiguate.",
    { name: z.string().min(1), path: z.string().optional().describe("Repo-relative file path, to disambiguate.") },
    async ({ name, path }) => {
      const hits = store.symbolsNamed(name, path);
      if (hits.length === 0) {
        const near = store.search(name, { limit: 5, offset: 0 }).hits.map((h) => `${h.qualified_name} (${h.path})`);
        return { found: false, did_you_mean: near, ...notReady() };
      }
      const docs = await knowledge.docIndex();
      return {
        found: true,
        matches: hits.map((h) => {
          const d = docs.get(`file:${h.path}`);
          return {
            ...brief(h),
            doc: h.docstring, // full text here, not just the first sentence
            body_hash: h.body_hash,
            // Status of the file's reviewed documentation, so the agent knows how far to trust it
            // and whether get_overview has more.
            doc_status: d?.status ?? "none",
            ...(d?.trust ? { doc_trust: d.trust } : {}),
          };
        }),
      };
    },
  );

  type Walked = { path: string; depth: number; via: string; confidence: string; kind: string; source: string };
  function walk(start: string, dir: "in" | "out", maxDepth: number): Walked[] {
    const seen = new Set([start]);
    const out: Walked[] = [];
    let frontier = [start];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const e of store.neighbours(file, dir)) {
          const other = dir === "out" ? e.to : e.from;
          if (seen.has(other)) continue;
          seen.add(other);
          out.push({ path: other, depth, via: file, confidence: e.confidence, kind: e.kind, source: e.source });
          next.push(other);
        }
      }
      frontier = next;
    }
    return out;
  }
  const requireFile = (p: string) => {
    if (!store.hasFile(p)) throw new Error(`File not indexed: ${p}. Paths are relative to the workspace root, with forward slashes.`);
  };

  agentTool(
    AgentTools.getNeighbors,
    "Files a file depends on (imports) and files that depend on it, via resolved import statements. depth 1 is direct only. Each edge carries a confidence: 'resolved' or 'guess'.",
    {
      path: z.string().min(1),
      direction: z.enum(["in", "out", "both"]).default("both").describe("out = what it imports, in = what imports it."),
      depth: z.number().int().min(1).max(3).default(1),
    },
    ({ path, direction, depth }) => {
      requireFile(path);
      return {
        path,
        ...(direction !== "in" ? { imports: walk(path, "out", depth) } : {}),
        ...(direction !== "out" ? { imported_by: walk(path, "in", depth) } : {}),
        ...notReady(),
      };
    },
  );

  agentTool(
    AgentTools.impactOfChange,
    "Everything that transitively depends on a file: what could break if you change it. Grouped by distance (1 = direct importers). Based on import statements only, so calls through dynamic imports or string paths are not seen.",
    { path: z.string().min(1), depth: z.number().int().min(1).max(10).default(5), limit: z.number().int().min(1).max(200).default(100) },
    ({ path, depth, limit }) => {
      requireFile(path);
      const all = walk(path, "in", depth);
      const byDepth: Record<string, string[]> = {};
      for (const w of all.slice(0, limit)) (byDepth[w.depth] ??= []).push(w.path);
      return { path, total: all.length, by_distance: byDepth, ...(all.length > limit ? { truncated: true } : {}), ...notReady() };
    },
  );

  agentTool(
    AgentTools.listUndocumented,
    "Files (or modules) that have no reviewed documentation, most important first (ranked by how many files import them). Read the code, then call save_summary for each one you document. Stale means the code changed since the doc was written.",
    {
      kind: z.enum(DOC_KINDS).default("file"),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
    async ({ kind, limit, offset }) => ({ ...(await knowledge.listUndocumented({ kind, limit, offset })), ...notReady() }),
  );

  agentTool(
    AgentTools.saveSummary,
    "Save documentation you wrote for a file or module. It is stored as an unreviewed draft in .brain/drafts/ and only joins the knowledge base after a person approves it in VS Code. Write for another engineer: purpose, key behaviours, gotchas, how it fits. Do not paste code. You must say which model wrote it.",
    {
      target: z.string().min(1).describe("Repo-relative path of the file or directory, as returned by list_undocumented."),
      kind: z.enum(DOC_KINDS).optional().describe("Only needed if the path is ambiguous."),
      description: z.string().min(1).describe("One sentence: what this is for."),
      summary: z.string().min(1).describe("The documentation, in Markdown (no front matter)."),
      model: z.string().min(1).describe("Id of the model that wrote this summary."),
      tokens_in: z.number().int().min(0).optional().describe("Input tokens you used, if you know them. Makes the cost report exact."),
      tokens_out: z.number().int().min(0).optional().describe("Output tokens of the summary, if you know them."),
      tags: z.array(z.string()).max(10).optional(),
    },
    async ({ target, kind, description, summary, model, tokens_in, tokens_out, tags }) => {
      if (!(await ws.isInitialised())) {
        throw new Error("This workspace is not initialised. Ask the user to run “Brain: Initialise” in VS Code; that creates the .brain folder drafts are saved to.");
      }
      const saved = await knowledge.saveSummary({
        target, kind, description, summary, model, tokensIn: tokens_in, tokensOut: tokens_out, tags,
        client: server.server.getClientVersion()?.name ?? "agent",
      });
      return { saved: true, status: "draft", draft: saved.draft, note: "Saved as an unreviewed draft. It appears in the knowledge base once a person approves it in VS Code." };
    },
  );

  agentTool(
    AgentTools.getOverview,
    "Reviewed documentation for a file or a directory (module), written by an agent and approved by a person: purpose, behaviour, dependencies. Reports its trust level and warns when the code changed after it was written. Use '.' for the repository overview if one exists.",
    { path: z.string().min(1).describe("Repo-relative file or directory path, or '.'.") },
    async ({ path }) => ({ ...(await knowledge.overview(path)), ...notReady() }),
  );

  agentTool(
    AgentTools.getGraph,
    "The dependency graph: modules (directories) or files as nodes, import relationships as edges, with circular dependencies flagged and each node's documentation status. Start at module level; pass root (a file or directory) and depth to zoom in.",
    {
      level: z.enum(GRAPH_LEVELS).default("module"),
      root: z.string().optional().describe("A file or directory to centre on."),
      depth: z.number().int().min(0).max(3).default(1).describe("Hops to expand beyond root."),
      limit: z.number().int().min(5).max(400).default(150).describe("Most nodes returned; the most connected are kept."),
    },
    async ({ level, root, depth, limit }) => ({ ...buildGraph(store, await knowledge.docIndex(), { level, root, depth, limit }), ...notReady() }),
  );

  // ---- admin tools: refused until brain_admin_hello succeeds with the token ---
  const guarded = <A, R>(fn: (args: A) => Promise<R>) => async (args: A) =>
    admin ? fn(args) : fail("Admin tools require brain_admin_hello with a valid admin token.");

  server.registerTool(
    AdminTools.hello,
    {
      description: "Extension handshake. Presents the admin token and unlocks the brain_admin_* tools for this connection. Agents must not call this.",
      inputSchema: { adminToken: z.string().optional(), client: z.string().optional(), protocolVersion: z.string().optional() },
    },
    async ({ adminToken, protocolVersion }) => {
      admin = Boolean(opts.adminToken && adminToken && tokensEqual(adminToken, opts.adminToken));
      if (admin && protocolVersion && protocolVersion.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
        admin = false;
        return fail(`Protocol mismatch: server speaks ${PROTOCOL_VERSION}, client ${protocolVersion}. Update the extension or the server.`);
      }
      const result: HelloResult = {
        admin,
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
        adminTools: admin ? Object.values(AdminTools).filter((t) => t !== AdminTools.hello) : [],
      };
      return json(result);
    },
  );

  server.registerTool(
    AdminTools.init,
    { description: "Create the .brain layout (config, OKF knowledge bundle, .gitignore). Never overwrites existing files." },
    guarded(async () => {
      const result = await ws.init();
      await persistIndex();
      notify(Resources.status);
      notify(Resources.config);
      return json(result);
    }),
  );

  server.registerTool(AdminTools.getConfig, { description: "Read the team config." }, guarded(async () => json(await ws.readConfig())));

  server.registerTool(
    AdminTools.getConfigSchema,
    { description: "JSON Schema of the team config, used by the extension to render the settings form." },
    guarded(async () => json(zodToJsonSchema(ConfigSchema, { $refStrategy: "none" }))),
  );

  server.registerTool(
    AdminTools.setConfig,
    { description: "Validate and save the team config. Returns field errors on failure.", inputSchema: { config: z.record(z.unknown()) } },
    guarded(async ({ config }: { config: Record<string, unknown> }) => {
      const result = await ws.writeConfig(config);
      if ("errors" in result) return fail("Config is invalid.", result.errors);
      notify(Resources.config);
      notify(Resources.costSummary); // a new price table can price old calls
      notify(Resources.status);
      return json(result.config);
    }),
  );

  server.registerTool(
    AdminTools.reindex,
    { description: "Bring the index up to date with the workspace (incremental: only new or changed files are parsed)." },
    guarded(async () => json(await reindex())),
  );

  server.registerTool(
    AdminTools.reviewSummary,
    {
      description: "Approve or reject a generated draft. Approving moves it into the knowledge bundle with status stable and a human verification; an edited body may be supplied.",
      inputSchema: {
        target: z.string().min(1),
        action: z.enum(["approve", "reject"]),
        by: z.string().min(1).describe("Who is deciding; recorded as human:<by>."),
        note: z.string().optional(),
        body: z.string().optional().describe("Replacement body (an edit by the reviewer)."),
      },
    },
    guarded(async (a: { target: string; action: "approve" | "reject"; by: string; note?: string; body?: string }) => {
      try {
        return json(await knowledge.review(a));
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );

  server.registerTool(
    AdminTools.reviewMany,
    {
      description: "Approve or reject many generated drafts at once. Each is checked and written on its own and a failure does not stop the rest; indexes and the log are updated once. Approved documents are marked as approved in bulk.",
      inputSchema: {
        targets: z.array(z.string().min(1)).min(1).max(2000),
        action: z.enum(["approve", "reject"]),
        by: z.string().min(1).describe("Who is deciding; recorded as human:<by>."),
        note: z.string().optional(),
      },
    },
    guarded(async (a: { targets: string[]; action: "approve" | "reject"; by: string; note?: string }) => {
      try {
        return json(await knowledge.reviewMany(a));
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );

  server.registerTool(
    AdminTools.validate,
    { description: "Check the knowledge bundle: OKF conformance (every concept has a type) and graph health (broken links, orphans, dependency cycles)." },
    guarded(async () => json(await knowledge.validate())),
  );

  server.registerTool(
    AdminTools.exportGraph,
    { description: "Write the dependency graph as JSON-LD to <outputDir>/graph/graph.jsonld (derived, gitignored, deterministic)." },
    guarded(async () => {
      const doc = toJsonLd(store, await knowledge.docIndex());
      const file = ws.abs("graph", "graph.jsonld");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
      return json({ file: path.relative(ws.root, file).split(path.sep).join("/"), nodes: (doc["@graph"] as { type: string }[]).filter((n) => n.type !== "Dependency").length, edges: (doc["@graph"] as { type: string }[]).filter((n) => n.type === "Dependency").length });
    }),
  );

  server.registerTool(
    AdminTools.exportCostReport,
    { description: "Write the cost report to <outputDir>/reports/cost-<date>.csv and .md (gitignored by default)." },
    guarded(async () => {
      const config = await ws.readConfig();
      const rows = store.llmCallRows();
      const stamp = new Date().toISOString().slice(0, 10);
      const dir = ws.abs("reports");
      await mkdir(dir, { recursive: true });
      const csv = path.join(dir, `cost-${stamp}.csv`);
      const md = path.join(dir, `cost-${stamp}.md`);
      await writeFile(csv, toCsv(rows, config.pricing));
      await writeFile(md, toMarkdown(summarize(rows, config)));
      const rel = (f: string) => path.relative(ws.root, f).split(path.sep).join("/");
      return json({ csv: rel(csv), markdown: rel(md), calls: rows.length });
    }),
  );

  server.registerTool(
    AdminTools.shutdown,
    { description: "Stop the daemon. Only meaningful when the server runs as a shared daemon; clients reconnect to a new one." },
    guarded(async () => {
      if (!opts.onShutdown) return fail("This server is not a daemon, so there is nothing to shut down.");
      setImmediate(opts.onShutdown);
      return json({ stopping: true });
    }),
  );

  const scopeShape = {
    kind: GenerationScopeSchema.shape.kind,
    under: GenerationScopeSchema.shape.under,
    includeStale: GenerationScopeSchema.shape.includeStale,
    limit: GenerationScopeSchema.shape.limit,
  };

  server.registerTool(
    AdminTools.estimateGeneration,
    { description: "What generating docs would read and cost, before spending anything. Calls no model. Every number is an estimate.", inputSchema: scopeShape },
    guarded(async (scope: Record<string, unknown>) => {
      try {
        return json(await generator.estimate(scope));
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );

  server.registerTool(
    AdminTools.generateDocs,
    {
      description: "Start writing doc drafts with the configured LLM. Returns at once; progress is at brain://generation. Needs confirm: true, which a client sets only after showing the person the estimate.",
      inputSchema: { ...scopeShape, confirm: z.literal(true) },
    },
    guarded(async ({ confirm: _confirm, ...scope }: Record<string, unknown>) => {
      try {
        return json(await generator.start(scope));
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );

  server.registerTool(
    AdminTools.testLlm,
    { description: "Try the configured LLM with a tiny request and explain what is wrong if it fails: server not running, model missing, window too small, key rejected. Free for a local model; a fraction of a cent for a paid API." },
    guarded(async () => json(await testLlm(llm()))),
  );

  server.registerTool(
    AdminTools.listLlmModels,
    { description: "The models a local LLM server offers (GET /models), so one can be picked instead of typed. Local mode only." },
    guarded(async () => {
      try {
        return json(await listLlmModels(llm()));
      } catch (e) {
        return fail((e as Error).message);
      }
    }),
  );

  server.registerTool(
    AdminTools.putEdges,
    {
      description: "Store what the editor's language server says about one file's code (calls, extends), replacing what it said before. Import edges are not touched. Targets that are not indexed files are skipped.",
      inputSchema: PutEdgesInputSchema.shape,
    },
    guarded(async (input: PutEdgesInput) => {
      const r = store.replaceLspEdges(input.from, input.edges);
      if (!r) return fail(`“${input.from}” is not an indexed file.`);
      if (r.stored > 0 || input.edges.length === 0) { notify(Resources.status); }
      return json(r satisfies PutEdgesResult);
    }),
  );

  server.registerTool(
    AdminTools.cancelGeneration,
    { description: "Stop the running generation job. The document in progress is abandoned; drafts already written are kept." },
    guarded(async () => json(generator.cancel())),
  );

  const handle: SessionHandle = { server, subscribed, admin: () => admin, connectedAt: Date.now() };
  sessions.add(handle);
  opts.onSessionsChanged?.(sessions.size);
  server.server.onclose = () => {
    if (sessions.delete(handle)) opts.onSessionsChanged?.(sessions.size);
  };
  return handle;
  }

  let watcher: { close(): void } | null = null;
  return {
    createSession,
    sessionCount: () => sessions.size,
    status,
    reindex,
    /** Called once connected: opens the persisted index if the workspace is initialised, scans, and starts watching. */
    async start() {
      initialisedAtStart = await ws.isInitialised();
      if (initialisedAtStart) {
        const old = store;
        store = await indexer.swapStore(() => BrainStore.open(diskPath));
        old.close();
        store.pruneUsage(USAGE_RETENTION_DAYS);
      }
      void reindex().catch(() => {});
      if (opts.watch !== false) {
        watcher = watchWorkspace({
          root: ws.root,
          outputDirName: ws.outputDir.split("/")[0],
          onChange: () => void reindex().catch(() => {}),
          onError: (e) => log(`file watcher unavailable: ${e.message}`),
        });
      }
    },
    close() {
      generator.cancel();
      watcher?.close();
      store.close();
    },
  };
}

/**
 * One server for one stdio connection: the shape every client has used so far. The daemon builds a core and
 * gives each HTTP session its own `createSession()` instead.
 */
export function createBrainServer(opts: BrainServerOptions) {
  const core = createBrainCore(opts);
  const session = core.createSession();
  return { server: session.server, status: core.status, reindex: core.reindex, start: core.start, close: core.close };
}
