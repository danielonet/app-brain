import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AdminTools, DaemonInfo, Resources, readDaemonInfo, runtimeDir } from "@app-brain/brain-protocol";
import { FILES } from "./helpers";

export const CLI = path.resolve(__dirname, "..", "cli.js");
export const ADMIN = "adm-0123456789abcdef0123456789abcdef";

export interface Env { ws: string; runtime: string; env: NodeJS.ProcessEnv; cleanup(): void }

/** A workspace with the usual files, and its own runtime dir so tests never see each other's daemons. */
export function setup(extra: Record<string, string> = {}): Env {
  const ws = mkdtempSync(path.join(tmpdir(), "brain-daemon-ws-"));
  for (const [rel, body] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const runtime = mkdtempSync(path.join(tmpdir(), "brain-daemon-rt-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BRAIN_RUNTIME_DIR: runtime };
  for (const k of Object.keys(env)) if (k.startsWith("BRAIN_LLM_") || k === "BRAIN_ADMIN_TOKEN") delete env[k];
  return { ws, runtime, env, cleanup: () => { rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); rmSync(runtime, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } };
}

export interface Proc { child: ChildProcess; info: DaemonInfo; stderr: () => string; exit: Promise<number | null>; kill(sig?: NodeJS.Signals): void }

/** Starts a daemon the way the extension does: secrets on stdin, nothing sensitive in argv or the environment. */
export async function startDaemonProc(e: Env, o: { secrets?: object | null; args?: string[]; wait?: boolean } = {}): Promise<Proc> {
  const secrets = o.secrets === undefined ? { adminToken: ADMIN } : o.secrets;
  const extra = o.args ?? [];
  const args = [CLI, "--daemon", "--workspace", e.ws, ...(secrets ? ["--secrets-from-stdin"] : []), ...(extra.includes("--session-grace-ms") ? [] : ["--session-grace-ms", "400"]), ...extra];
  const child = spawn(process.execPath, args, { env: e.env, stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const exit = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  if (secrets) child.stdin!.end(JSON.stringify(secrets) + "\n"); else child.stdin!.end();
  let info: DaemonInfo | null = null;
  if (o.wait !== false) {
    for (let i = 0; i < 150 && !info; i++) {
      info = await readDaemonInfo(runtimeDir(e.ws, e.env));
      if (info && info.pid !== child.pid) info = null; // a dead daemon's leftover file is not this daemon's
      if (!info) await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null && !info) break;
    }
  }
  return { child, info: info as DaemonInfo, stderr: () => err, exit, kill: (sig = "SIGTERM") => { try { child.kill(sig); } catch { /* gone */ } } };
}

export async function httpClient(info: DaemonInfo, name: string, o: { admin?: boolean; token?: string } = {}): Promise<Client> {
  const c = new Client({ name, version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: { authorization: `Bearer ${o.token ?? info.agentToken}` } } }));
  if (o.admin) await c.callTool({ name: AdminTools.hello, arguments: { adminToken: ADMIN } });
  return c;
}

/** Raw HTTP, so a test can send headers `fetch` refuses to (Host) and bodies it would not build. */
export function raw(info: DaemonInfo, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; auth?: boolean }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: info.port, method: o.method ?? "GET", path: o.path ?? "/mcp",
      headers: { ...(o.auth === false ? {} : { authorization: `Bearer ${info.agentToken}` }), ...(o.headers ?? {}) },
    }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

export const INIT_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
export const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

export const status = async (c: Client) => JSON.parse(((await c.readResource({ uri: Resources.status })).contents[0] as { text: string }).text);
export const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 8000, step = 50) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)); }
  return false;
};
