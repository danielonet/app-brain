import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdminTools, ENV_ADMIN_TOKEN, Resources } from "@app-brain/brain-protocol";

export const TOKEN = "t";
export const CLI = path.resolve(__dirname, "..", "cli.js");

export const FILES: Record<string, string> = {
  "src/auth/session.ts": `import { pool } from "../db/pool";
/** Creates and validates user sessions. */
export class SessionStore {
  /** Look up a session by its id. */
  get(id: string) { return pool.query(id); }
}
export function createSession(userId: string) { return new SessionStore(); }
`,
  "src/db/pool.ts": `export const pool = { query(q: string) { return q; } };
/** Opens a database connection. */
export function connect(url: string) { return pool; }
`,
  "src/http/login.ts": `import { createSession } from "../auth/session";
export function loginHandler() { return createSession("u"); }
`,
  "src/http/admin.ts": `import { loginHandler } from "./login";
export function adminHandler() { return loginHandler(); }
`,
};

export function fixture(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-ws-"));
  for (const [rel, body] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

export async function connect(workspace: string, opts: { clientName?: string; admin?: boolean } = {}): Promise<Client> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.admin) env[ENV_ADMIN_TOKEN] = TOKEN;
  else delete env[ENV_ADMIN_TOKEN];
  const client = new Client({ name: opts.clientName ?? "claude-code", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "--workspace", workspace, "--no-watch"], env, stderr: "ignore" }));
  if (opts.admin) await client.callTool({ name: AdminTools.hello, arguments: { adminToken: TOKEN } });
  return client;
}

export async function tool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  let body: any;
  try { body = JSON.parse(res.content[0].text); } catch { body = { error: res.content[0].text }; }
  return { isError: Boolean(res.isError), text: res.content[0].text, body };
}

export const readJson = async (c: Client, uri: string) => JSON.parse(((await c.readResource({ uri })).contents[0] as { text: string }).text);

export async function ready(c: Client, files = 1) {
  for (let i = 0; i < 100; i++) {
    const s = await readJson(c, Resources.status);
    if (s.state === "idle" && s.index.files >= files) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("index never became ready");
}
