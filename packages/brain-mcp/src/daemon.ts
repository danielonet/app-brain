import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  DAEMON_LOCK_FILE, DaemonInfo, ENV_LLM_API_KEY, ENV_LLM_BASE_URL, ENV_LLM_EFFORT, ENV_LLM_MODE, ENV_LLM_MODEL, HEALTH_PATH, MCP_PATH,
  PROTOCOL_VERSION, daemonHealthy, ensureRuntimeDir, llmFingerprint, pidAlive, readDaemonInfo, removeDaemonInfo, writeDaemonInfo,
} from "@app-brain/brain-protocol";
import { SERVER_VERSION, createBrainCore } from "./server";
import type { BrainWorkspace } from "./workspace";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 64;
/** A client that never opened a notification stream cannot be seen disconnecting, so it is kept this long when quiet. */
const POST_ONLY_IDLE_MS = 5 * 60 * 1000;
/** A client that did open one is gone this long after the stream closes without a new one. */
const DEFAULT_SESSION_GRACE_MS = 20_000;
const DEFAULT_IDLE_EXIT_MS = 10 * 60 * 1000;
const STARTING_GRACE_MS = 15_000;

export interface DaemonOptions {
  workspace: BrainWorkspace;
  runtimeDir: string;
  /** Lets an admin client use admin tools. Never written to any file. */
  adminToken?: string;
  /** LLM settings and anything else the core reads from the environment. */
  env: NodeJS.ProcessEnv;
  port?: number;
  /** Exit after this long with nobody connected. 0 disables. */
  idleExitMs?: number;
  /** How long after its notification stream closes a session is dropped. Clients that vanish (a crash, a closed
   *  laptop) never send the DELETE the protocol asks for, so the daemon watches the stream instead. */
  sessionGraceMs?: number;
  watch?: boolean;
  log: (line: string) => void;
}

export interface RunningDaemon {
  info: DaemonInfo;
  /** Resolves once the daemon has stopped and cleaned up. */
  closed: Promise<void>;
  close(): Promise<void>;
  sessionCount(): number;
}

/** Another daemon already serves this workspace. `info` is null while it is still starting up. */
export class DaemonAlreadyRunning extends Error {
  constructor(readonly info: DaemonInfo | null) {
    super(info ? `A brain daemon (pid ${info.pid}) is already running for this workspace.` : "A brain daemon is starting for this workspace.");
  }
}

// ---- request checks (pure, so they are tested on their own) -------------------------------------------------

/** Only our own address, by name or number, on our own port. Anything else is a DNS-rebinding attempt. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- the lock: at most one daemon per workspace -----------------------------------------------------------------

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const lock = path.join(dir, DAEMON_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await fs.open(lock, "wx", 0o600);
      await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await fh.close();
      return async () => {
        try {
          const held = JSON.parse(await fs.readFile(lock, "utf8")) as { pid?: number };
          if (held.pid === process.pid) await fs.rm(lock, { force: true });
        } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder: { pid?: number; startedAt?: number } | null = null;
    try { holder = JSON.parse(await fs.readFile(lock, "utf8")); } catch { /* unreadable: treat as stale */ }
    if (holder?.pid && holder.pid !== process.pid && pidAlive(holder.pid)) {
      const info = await readDaemonInfo(dir);
      if (info && (await daemonHealthy(info))) throw new DaemonAlreadyRunning(info);
      if (Date.now() - (holder.startedAt ?? 0) < STARTING_GRACE_MS) throw new DaemonAlreadyRunning(null); // still coming up
    }
    await fs.rm(lock, { force: true }); // the holder is gone: a crashed daemon's leftovers
  }
  throw new Error("Could not take the daemon lock.");
}

// ---- the daemon ----------------------------------------------------------------------------------------------------

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const dir = ensureRuntimeDir(opts.runtimeDir);
  const releaseLock = await acquireLock(dir);
  const { log } = opts;
  let httpServer: http.Server | null = null;
  try {
    const agentToken = randomBytes(32).toString("base64url");
    interface Entry { transport: StreamableHTTPServerTransport; lastSeen: number; streams: number; hadStream: boolean }
    const transports = new Map<string, Entry>();
    const graceMs = opts.sessionGraceMs ?? DEFAULT_SESSION_GRACE_MS;
    let closing = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let closeResolve!: () => void;
    const closed = new Promise<void>((r) => (closeResolve = r));

    const idleMs = opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    const armIdle = (count: number) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (count === 0 && idleMs > 0 && !closing) {
        idleTimer = setTimeout(() => {
          log(`no clients for ${Math.round(idleMs / 1000)}s: exiting`);
          void close();
        }, idleMs);
        idleTimer.unref();
      }
    };

    const core = createBrainCore({
      workspace: opts.workspace, adminToken: opts.adminToken, env: opts.env, watch: opts.watch, log, transport: "http",
      onShutdown: () => void close(),
      onSessionsChanged: armIdle,
    });

    let port = 0;
    const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const rpcError = (res: http.ServerResponse, status: number, code: number, message: string) =>
      send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });

    async function readBody(req: http.IncomingMessage): Promise<unknown> {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
        chunks.push(c as Buffer);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw Object.assign(new Error("not JSON"), { status: 400 });
      }
    }

    async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
      if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, { error: "forbidden" });
      if (!isAllowedHost(req.headers.host, port)) return send(res, 403, { error: "unexpected Host header" }); // DNS rebinding
      if (req.headers.origin !== undefined) return send(res, 403, { error: "browser requests are not accepted" }); // we never serve web pages
      if (!bearerOk(req.headers.authorization, agentToken)) return send(res, 401, { error: "a bearer token is required" }, { "www-authenticate": "Bearer" });

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === HEALTH_PATH) {
        if (req.method !== "GET") return send(res, 405, { error: "method not allowed" }, { allow: "GET" });
        return send(res, 200, { ok: true, pid: process.pid, version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION, sessions: transports.size });
      }
      if (url.pathname !== MCP_PATH) return send(res, 404, { error: "not found" });
      if (closing) return send(res, 503, { error: "shutting down" });

      const sid = req.headers["mcp-session-id"];
      const existing = typeof sid === "string" ? transports.get(sid) : undefined;

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          const status = (e as { status?: number }).status ?? 400;
          return rpcError(res, status, status === 413 ? -32600 : -32700, status === 413 ? "Request body too large." : "Body is not valid JSON.");
        }
        if (existing) {
          existing.lastSeen = Date.now();
          return existing.transport.handleRequest(req, res, body);
        }
        if (typeof sid === "string") return rpcError(res, 404, -32001, "Session not found. Initialize again."); // spec: unknown session
        if (!isInitializeRequest(body)) return rpcError(res, 400, -32000, "Send an initialize request first, with no session id.");
        if (transports.size >= MAX_SESSIONS) return rpcError(res, 503, -32000, "Too many sessions.");

        const session = core.createSession();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => void transports.set(id, { transport, lastSeen: Date.now(), streams: 0, hadStream: false }),
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
          allowedOrigins: [],
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await session.server.connect(transport);
        await transport.handleRequest(req, res, body);
        if (!transport.sessionId) await session.server.close().catch(() => {}); // the initialize was refused: do not leak the session
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!existing) return rpcError(res, typeof sid === "string" ? 404 : 400, -32001, typeof sid === "string" ? "Session not found." : "Missing session id.");
        existing.lastSeen = Date.now();
        if (req.method === "GET") {
          // The standalone notification stream: while it is open the client is connected, and when it closes we start the clock.
          existing.streams++;
          existing.hadStream = true;
          res.on("close", () => {
            existing.streams = Math.max(0, existing.streams - 1);
            existing.lastSeen = Date.now();
          });
        }
        return existing.transport.handleRequest(req, res);
      }
      return send(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
    }

    httpServer = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log(`request failed: ${(e as Error).message}`);
        send(res, 500, { error: "internal error" });
      });
    });
    httpServer.headersTimeout = 15_000;
    httpServer.requestTimeout = 0; // SSE streams are long-lived; bodies are bounded by size, not time
    await new Promise<void>((resolve, reject) => {
      httpServer!.once("error", reject);
      httpServer!.listen(opts.port ?? 0, "127.0.0.1", () => resolve()); // loopback only, never 0.0.0.0
    });
    port = (httpServer.address() as { port: number }).port;

    const env = opts.env;
    const info: DaemonInfo = {
      pid: process.pid, port, url: `http://127.0.0.1:${port}${MCP_PATH}`, agentToken, version: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION,
      startedAt: new Date().toISOString(), workspace: opts.workspace.root, outputDir: opts.workspace.outputDir,
      llmFingerprint: llmFingerprint(agentToken, {
        mode: env[ENV_LLM_MODE] ?? "agent", model: env[ENV_LLM_MODEL] ?? "", baseUrl: env[ENV_LLM_BASE_URL] ?? "", effort: env[ENV_LLM_EFFORT] ?? "", apiKey: env[ENV_LLM_API_KEY] ?? "",
      }),
    };
    await writeDaemonInfo(dir, info); // published only once we are listening
    await core.start();
    armIdle(0);
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, t] of transports) {
        if (t.streams > 0) continue; // connected
        if (now - t.lastSeen > (t.hadStream ? graceMs : POST_ONLY_IDLE_MS)) {
          log(`closing session ${id.slice(0, 8)}: its client is gone`);
          void t.transport.close();
        }
      }
    }, Math.max(100, Math.min(1000, graceMs / 2)));
    sweep.unref();
    log(`daemon ready on ${info.url} (pid ${process.pid})`);

    async function close() {
      if (closing) return closed;
      closing = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearInterval(sweep);
      await removeDaemonInfo(dir, process.pid); // first: nobody should find a daemon that is going away
      await Promise.allSettled([...transports.values()].map((t) => t.transport.close()));
      await new Promise<void>((r) => { httpServer!.close(() => r()); httpServer!.closeAllConnections(); });
      core.close();
      await releaseLock();
      log("daemon stopped");
      closeResolve();
      return closed;
    }

    return { info, closed, close, sessionCount: () => core.sessionCount() };
  } catch (e) {
    httpServer?.close();
    await releaseLock();
    throw e;
  }
}
