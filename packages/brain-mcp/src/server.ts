import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  AdminTools,
  BrainStatus,
  ConfigSchema,
  HelloResult,
  PROTOCOL_VERSION,
  ReindexResult,
  Resources,
} from "@app-brain/brain-protocol";
import { scanWorkspace } from "./scan.js";
import { BrainWorkspace } from "./workspace.js";

export const SERVER_VERSION = "0.0.0";

export interface BrainServerOptions {
  workspace: BrainWorkspace;
  /** Token a client must present in brain_admin_hello to use admin tools. Unset: admin tools are refused. */
  adminToken?: string;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string, extra?: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2) }],
});

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createBrainServer(opts: BrainServerOptions) {
  const ws = opts.workspace;
  const startedAt = new Date().toISOString();
  const server = new McpServer({ name: "brain-mcp", version: SERVER_VERSION });
  const subscribed = new Set<string>();
  let admin = false; // one stdio connection = one client = one session

  const state = {
    state: "starting" as BrainStatus["state"],
    message: null as string | null,
    files: 0,
    byLanguage: {} as Record<string, number>,
    lastIndexedAt: null as string | null,
  };

  async function status(): Promise<BrainStatus> {
    return {
      state: state.state,
      initialised: await ws.isInitialised(),
      workspace: ws.root,
      outputDir: ws.abs(),
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      startedAt,
      index: { files: state.files, byLanguage: state.byLanguage, lastIndexedAt: state.lastIndexedAt },
      message: state.message,
    };
  }

  function notify(uri: string) {
    if (subscribed.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => {});
  }
  function setState(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    notify(Resources.status);
  }

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

  server.registerResource(
    "status",
    Resources.status,
    { title: "Brain status", description: "Server state, initialisation and index counters.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await status(), null, 2) }] }),
  );
  server.registerResource(
    "config",
    Resources.config,
    { title: "Brain config", description: "Team config (.brain/config.json), or defaults when not initialised.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await ws.readConfig(), null, 2) }] }),
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
      notify(Resources.status);
      notify(Resources.config);
      return json(result);
    }),
  );

  server.registerTool(
    AdminTools.getConfig,
    { description: "Read the team config." },
    guarded(async () => json(await ws.readConfig())),
  );

  server.registerTool(
    AdminTools.getConfigSchema,
    { description: "JSON Schema of the team config, used by the extension to render the settings form." },
    guarded(async () => json(zodToJsonSchema(ConfigSchema, { name: "BrainConfig", $refStrategy: "none" }))),
  );

  server.registerTool(
    AdminTools.setConfig,
    { description: "Validate and save the team config. Returns field errors on failure.", inputSchema: { config: z.record(z.unknown()) } },
    guarded(async ({ config }: { config: Record<string, unknown> }) => {
      const result = await ws.writeConfig(config);
      if ("errors" in result) return fail("Config is invalid.", result.errors);
      notify(Resources.config);
      notify(Resources.status);
      return json(result.config);
    }),
  );

  async function reindex(): Promise<ReindexResult> {
    const t0 = Date.now();
    setState({ state: "indexing", message: "Scanning files" });
    try {
      const config = await ws.readConfig();
      const files = await scanWorkspace({ workspace: ws.root, include: config.include, exclude: config.exclude, languages: config.languages });
      const byLanguage: Record<string, number> = {};
      for (const f of files) byLanguage[f.language] = (byLanguage[f.language] ?? 0) + 1;
      setState({ state: "idle", message: null, files: files.length, byLanguage, lastIndexedAt: new Date().toISOString() });
      return { files: files.length, byLanguage, durationMs: Date.now() - t0 };
    } catch (e) {
      setState({ state: "error", message: (e as Error).message });
      throw e;
    }
  }

  server.registerTool(
    AdminTools.reindex,
    { description: "Scan the workspace and refresh the index counters. (Phase 0: file inventory only; symbol indexing comes next.)" },
    guarded(async () => json(await reindex())),
  );

  return {
    server,
    status,
    reindex,
    /** Called once connected: runs the first scan in the background. */
    start() {
      void reindex().catch(() => {});
    },
  };
}
