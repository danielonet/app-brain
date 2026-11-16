/**
 * Everything the daemon, the stdio proxy and the extension must agree on: where the runtime files live, what
 * `server.json` holds, and how to tell a live daemon from a stale file. Plain Node, no `vscode`.
 */
import { createHash, createHmac } from "node:crypto";
import { promises as fs, mkdirSync, lstatSync, chmodSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

export const ENV_RUNTIME_DIR = "BRAIN_RUNTIME_DIR";
export const ENV_IDLE_EXIT_MS = "BRAIN_IDLE_EXIT_MS";
export const DAEMON_INFO_FILE = "server.json";
export const DAEMON_LOCK_FILE = "daemon.lock";
export const DAEMON_LOG_FILE = "daemon.log";
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";

/**
 * What a client needs to reach a running daemon. It holds the AGENT token only: anything running as the same
 * user can read this file, so it must never hold the admin token or an API key.
 */
export const DaemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  url: z.string().url(),
  agentToken: z.string().min(16),
  version: z.string(),
  protocolVersion: z.string(),
  startedAt: z.string(),
  workspace: z.string(),
  outputDir: z.string(),
  /** HMAC of the LLM settings (and key) the daemon was started with, so an extension can tell if they changed. */
  llmFingerprint: z.string(),
});
export type DaemonInfo = z.infer<typeof DaemonInfoSchema>;

/**
 * A per-user directory for runtime files, outside the workspace: writing `.brain/` before the user runs
 * "Initialise" would break the promise that nothing is written until then. Stable across processes (it depends
 * on the home directory, not on a temp variable an app may override), so an agent's proxy finds the same daemon
 * the extension started.
 */
export function runtimeBase(env: NodeJS.ProcessEnv = process.env): string {
  if (env[ENV_RUNTIME_DIR]) return path.resolve(env[ENV_RUNTIME_DIR]!);
  const home = os.homedir();
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "app-brain", "run");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "app-brain", "run");
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "app-brain", "run");
}

export function workspaceKey(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  return createHash("sha256").update(process.platform === "win32" ? abs.toLowerCase() : abs).digest("hex").slice(0, 16);
}

export const runtimeDir = (workspaceRoot: string, env: NodeJS.ProcessEnv = process.env) => path.join(runtimeBase(env), workspaceKey(workspaceRoot));

/**
 * Creates the runtime directory private to this user. Refuses a directory that belongs to someone else or is a
 * symlink (the classic shared-temp attack), and tightens one that is ours but too open.
 */
export function ensureRuntimeDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Runtime path ${dir} is not a plain directory.`);
  if (typeof process.getuid === "function") {
    if (st.uid !== process.getuid()) throw new Error(`Runtime directory ${dir} belongs to another user; refusing to use it.`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return dir;
}

export async function readDaemonInfo(dir: string): Promise<DaemonInfo | null> {
  try {
    const parsed = DaemonInfoSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, DAEMON_INFO_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic and private: a reader never sees half a file, and the mode is set before the token is written. */
export async function writeDaemonInfo(dir: string, info: DaemonInfo): Promise<void> {
  const file = path.join(dir, DAEMON_INFO_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function removeDaemonInfo(dir: string, onlyIfPid?: number): Promise<void> {
  if (onlyIfPid !== undefined) {
    const current = await readDaemonInfo(dir);
    if (current && current.pid !== onlyIfPid) return; // someone else's daemon now: not ours to remove
  }
  await fs.rm(path.join(dir, DAEMON_INFO_FILE), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but not ours to signal
  }
}

/** A daemon is live when its pid exists AND it answers authenticated health checks as that pid. */
export async function daemonHealthy(info: DaemonInfo, timeoutMs = 1500): Promise<boolean> {
  if (!pidAlive(info.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${info.agentToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; pid?: number; protocolVersion?: string };
    return body.ok === true && body.pid === info.pid;
  } catch {
    return false;
  }
}

export interface LlmFingerprintInput {
  mode: string;
  model: string;
  baseUrl: string;
  effort: string;
  apiKey: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** Keyed with the agent token, so the fingerprint of a key is useless to anything that lacks that token. */
export function llmFingerprint(secret: string, s: LlmFingerprintInput): string {
  return createHmac("sha256", secret).update(JSON.stringify([s.mode, s.model, s.baseUrl, s.effort, s.apiKey, s.contextTokens ?? 0, s.maxOutputTokens ?? 0, s.timeoutMs ?? 0])).digest("hex").slice(0, 32);
}

/** What the extension hands the daemon on stdin: secrets must not be on the command line or in the environment. */
export const DaemonSecretsSchema = z.object({
  adminToken: z.string().min(16).optional(),
  llm: z.object({
    mode: z.string().default("agent"),
    model: z.string().default(""),
    baseUrl: z.string().default(""),
    effort: z.string().default(""),
    apiKey: z.string().default(""),
    contextTokens: z.number().int().min(0).default(0),
    maxOutputTokens: z.number().int().min(0).default(0),
    timeoutMs: z.number().int().min(0).default(0),
  }).default({}),
});
export type DaemonSecrets = z.infer<typeof DaemonSecretsSchema>;

