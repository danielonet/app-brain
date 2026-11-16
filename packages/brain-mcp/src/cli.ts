#!/usr/bin/env node
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DAEMON_LOG_FILE, DEFAULT_OUTPUT_DIR, DaemonSecrets, DaemonSecretsSchema, ENV_ADMIN_TOKEN, ENV_IDLE_EXIT_MS, ENV_LLM_API_KEY, ENV_LLM_BASE_URL,
  ENV_LLM_CONTEXT_TOKENS, ENV_LLM_EFFORT, ENV_LLM_MAX_OUTPUT_TOKENS, ENV_LLM_MODE, ENV_LLM_TIMEOUT_MS, ENV_LLM_MODEL, ENV_WORKSPACE, ensureRuntimeDir, runtimeDir,
} from "@app-brain/brain-protocol";
import { DaemonAlreadyRunning, startDaemon } from "./daemon";
import { findLiveDaemon, runProxy } from "./proxy";
import { createBrainServer } from "./server";
import { BrainWorkspace } from "./workspace";

const flag = (name: string) => process.argv.includes(`--${name}`);
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Secrets for a daemon arrive on stdin as one line of JSON, so they are never in the command line (visible to `ps`)
 * nor in the environment (readable from /proc/<pid>/environ). Errors never echo what was read.
 */
async function readSecrets(): Promise<DaemonSecrets> {
  const text = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for secrets on stdin")), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => {
      buf += d;
      if (buf.length > 64 * 1024) reject(new Error("secrets on stdin are too large"));
      if (buf.includes("\n")) { clearTimeout(timer); resolve(buf.split("\n")[0]); }
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on("error", reject);
  });
  process.stdin.destroy();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error("secrets on stdin are not valid JSON"); }
  const parsed = DaemonSecretsSchema.safeParse(json);
  if (!parsed.success) throw new Error("secrets on stdin do not have the expected shape");
  return parsed.data;
}

async function openLog(file: string): Promise<(line: string) => void> {
  try {
    const st = await fs.stat(file).catch(() => null);
    if (st && st.size > 512 * 1024) await fs.rm(file); // keep it small: it is a debugging aid, not an archive
  } catch { /* best effort */ }
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(text);
    void fs.appendFile(file, text, { mode: 0o600 }).catch(() => {});
  };
}

async function runDaemon(workspace: BrainWorkspace) {
  const dir = ensureRuntimeDir(runtimeDir(workspace.root));
  const log = await openLog(path.join(dir, DAEMON_LOG_FILE));
  const secrets = flag("secrets-from-stdin") ? await readSecrets() : undefined;

  // Secrets from stdin win over the environment, and neither is passed on to anything else.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const adminToken = secrets?.adminToken ?? process.env[ENV_ADMIN_TOKEN];
  delete env[ENV_ADMIN_TOKEN];
  if (secrets) {
    for (const k of [ENV_LLM_MODE, ENV_LLM_MODEL, ENV_LLM_BASE_URL, ENV_LLM_EFFORT, ENV_LLM_API_KEY, ENV_LLM_CONTEXT_TOKENS, ENV_LLM_MAX_OUTPUT_TOKENS, ENV_LLM_TIMEOUT_MS]) delete env[k];
    const l = secrets.llm;
    if (l.mode && l.mode !== "agent") env[ENV_LLM_MODE] = l.mode;
    if (l.model) env[ENV_LLM_MODEL] = l.model;
    if (l.baseUrl) env[ENV_LLM_BASE_URL] = l.baseUrl;
    if (l.effort) env[ENV_LLM_EFFORT] = l.effort;
    if (l.apiKey) env[ENV_LLM_API_KEY] = l.apiKey;
    if (l.contextTokens > 0) env[ENV_LLM_CONTEXT_TOKENS] = String(l.contextTokens);
    if (l.maxOutputTokens > 0) env[ENV_LLM_MAX_OUTPUT_TOKENS] = String(l.maxOutputTokens);
    if (l.timeoutMs > 0) env[ENV_LLM_TIMEOUT_MS] = String(l.timeoutMs);
  }

  process.on("SIGHUP", () => {}); // a daemon outlives the terminal or editor that started it
  let daemon;
  try {
    daemon = await startDaemon({
      workspace, runtimeDir: dir, adminToken, env, log, port: arg("port") ? Number(arg("port")) : undefined,
      idleExitMs: Number(arg("idle-exit-ms") ?? process.env[ENV_IDLE_EXIT_MS] ?? "") || undefined,
      sessionGraceMs: Number(arg("session-grace-ms") ?? "") || undefined,
      watch: !flag("no-watch"),
    });
  } catch (e) {
    if (e instanceof DaemonAlreadyRunning) {
      log(e.message);
      return; // the daemon this caller wants exists: that is success
    }
    throw e;
  }
  const stop = () => void daemon.close();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.closed;
  process.exit(0);
}

async function main() {
  const workspace = new BrainWorkspace(arg("workspace") ?? process.env[ENV_WORKSPACE] ?? process.cwd(), arg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  if (flag("daemon")) return runDaemon(workspace);

  // stdout is the protocol channel; log to stderr only.
  const log = (line: string) => console.error(`brain-mcp: ${line}`);
  if (!flag("no-proxy")) {
    const daemon = await findLiveDaemon(workspace);
    if (daemon) {
      log(`using the daemon on port ${daemon.port} (pid ${daemon.pid})`);
      await runProxy(daemon, log);
      process.exit(0);
    }
  }

  const brain = createBrainServer({ workspace, adminToken: process.env[ENV_ADMIN_TOKEN], watch: !flag("no-watch"), log });
  await brain.server.connect(new StdioServerTransport());
  log(`ready: workspace=${workspace.root} output=${workspace.outputDir}`);
  await brain.start();

  const shutdown = () => {
    brain.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown); // the client went away
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  console.error("brain-mcp failed to start:", message);
  if (message.includes("no such module: fts5")) {
    console.error(`This Node (${process.version}) has no SQLite full-text search. brain-mcp needs Node 22.16 or newer.`);
  }
  process.exit(1);
});
