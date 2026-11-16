import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  DAEMON_LOG_FILE, DaemonInfo, DaemonSecrets, daemonHealthy, ensureRuntimeDir, llmFingerprint, pidAlive, readDaemonInfo, removeDaemonInfo, runtimeDir,
} from "@app-brain/brain-protocol";

/** Plain Node, no `vscode`: the rules for starting, finding and stopping the shared server are tested directly. */
export interface DaemonLlm {
  mode: string;
  model: string;
  baseUrl: string;
  effort: string;
  apiKey: string;
}

export interface EnsureOptions {
  nodePath: string;
  serverPath: string;
  workspace: string;
  outputDir: string;
  /** Held by the extension (in secret storage), given to the daemon on stdin, never written to a file. */
  adminToken: string;
  llm: DaemonLlm;
  /** Where runtime files live. Defaults to the process environment; tests point it somewhere private. */
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  startTimeoutMs?: number;
}

export interface DaemonHandle {
  info: DaemonInfo;
  /** We started it (otherwise we joined one that was already running). */
  spawned: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

/** Asks a daemon to stop (SIGTERM, which it handles by cleaning up) and waits; escalates only if it will not. */
export async function stopDaemon(info: DaemonInfo, env: NodeJS.ProcessEnv | undefined, log: (l: string) => void): Promise<void> {
  if (!pidAlive(info.pid)) return;
  log(`stopping daemon pid ${info.pid}`);
  try { process.kill(info.pid, "SIGTERM"); } catch { /* already gone */ }
  if (await waitUntilGone(info.pid, 5000)) return;
  log(`daemon pid ${info.pid} ignored SIGTERM; killing it`);
  try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ }
  await waitUntilGone(info.pid, 2000);
  await removeDaemonInfo(runtimeDir(info.workspace, env), info.pid);
}

async function logTail(dir: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(dir, DAEMON_LOG_FILE), "utf8")).trim().split("\n").slice(-4).join("\n");
  } catch {
    return "";
  }
}

/**
 * Finds the daemon for this workspace, or starts one. A daemon that was started with different LLM settings (or a
 * different key) is replaced, because those travel only at start-up.
 */
export async function ensureDaemon(o: EnsureOptions): Promise<DaemonHandle> {
  const dir = ensureRuntimeDir(runtimeDir(o.workspace, o.env));
  const timeoutMs = o.startTimeoutMs ?? 15_000;

  const existing = await readDaemonInfo(dir);
  if (existing && (await daemonHealthy(existing))) {
    const wanted = llmFingerprint(existing.agentToken, o.llm);
    if (existing.outputDir === o.outputDir && wanted === existing.llmFingerprint) {
      o.log(`attached to the daemon on port ${existing.port} (pid ${existing.pid})`);
      return { info: existing, spawned: false };
    }
    o.log("the running daemon was started with different settings; replacing it");
    await stopDaemon(existing, o.env, o.log);
  }

  const secrets: DaemonSecrets = { adminToken: o.adminToken, llm: o.llm };
  const child = spawn(o.nodePath, [o.serverPath, "--daemon", "--workspace", o.workspace, "--output-dir", o.outputDir, "--secrets-from-stdin"], {
    detached: true, // it must outlive this window: agents and other windows share it
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, ...(o.env ?? {}) },
    windowsHide: true,
  });
  let spawnError: Error | null = null;
  let exitedWith: number | null = null;
  child.on("error", (e) => (spawnError = e));
  child.on("exit", (code) => (exitedWith = code ?? -1));
  child.stdin!.on("error", () => { /* it died before reading: reported below */ });
  child.stdin!.end(JSON.stringify(secrets) + "\n");
  child.unref();

  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const info = await readDaemonInfo(dir);
    if (info && (await daemonHealthy(info))) {
      // Our child may have lost a race to another daemon (it then exits 0); either way a healthy daemon is what we wanted.
      o.log(`${info.pid === child.pid ? "started" : "joined"} the daemon on port ${info.port} (pid ${info.pid})`);
      return { info, spawned: info.pid === child.pid };
    }
    if (spawnError) throw new Error(`Could not start the server: ${(spawnError as Error).message}`);
    if (exitedWith !== null && exitedWith !== 0) throw new Error(`The server exited with code ${exitedWith}.${(await logTail(dir)) ? "\n" + (await logTail(dir)) : ""}`);
    await sleep(100);
  }
  throw new Error(`The server did not become ready within ${Math.round(timeoutMs / 1000)}s.${(await logTail(dir)) ? "\n" + (await logTail(dir)) : ""}`);
}
