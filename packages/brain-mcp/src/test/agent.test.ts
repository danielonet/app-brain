import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdminTools, AgentTools, ENV_ADMIN_TOKEN, Resources, UsageSummary } from "@app-brain/brain-protocol";
import { cleanDir } from "./cleanDir";

const TOKEN = "t";
const CLI = path.resolve(__dirname, "..", "cli.js");

const FILES: Record<string, string> = {
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
  "svc/users.py": `from .repo import UserRepo

def get_user_by_id(user_id):
    """Fetch one user by id."""
    return UserRepo().find(user_id)
`,
  "svc/repo.py": `class UserRepo:
    """Persistence for users."""
    def find(self, user_id): ...
`,
  ".env": "TOKEN=supersecret_value",
  "node_modules/x/index.ts": "export function leaked() {}",
};

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-agent-"));
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

async function connect(workspace: string, opts: { clientName?: string; admin?: boolean; watch?: boolean } = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.admin) env[ENV_ADMIN_TOKEN] = TOKEN;
  else delete env[ENV_ADMIN_TOKEN];
  const client = new Client({ name: opts.clientName ?? "claude-code", version: "1" });
  const args = [CLI, "--workspace", workspace];
  if (opts.watch === false) args.push("--no-watch");
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env }));
  if (opts.admin) await client.callTool({ name: AdminTools.hello, arguments: { adminToken: TOKEN } });
  return client;
}

async function tool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(res.isError), text: res.content[0].text, body: JSON.parse(res.content[0].text) };
}
const readJson = async (c: Client, uri: string) => JSON.parse(((await c.readResource({ uri })).contents[0] as { text: string }).text);

/** Wait for the first scan to finish (status goes idle with files indexed). */
async function ready(c: Client) {
  for (let i = 0; i < 100; i++) {
    const s = await readJson(c, Resources.status);
    if (s.state === "idle" && s.index.files > 0) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("index never became ready");
}

describe("agent tools over a real index", () => {
  let ws: string;
  let c: Client;
  before(async () => {
    ws = fixture();
    c = await connect(ws, { watch: false });
    await ready(c);
  });
  after(async () => {
    await c.close();
    cleanDir(ws);
  });

  it("indexes without any admin token or init, and writes nothing into the workspace", async () => {
    const s = await readJson(c, Resources.status);
    assert.equal(s.initialised, false);
    assert.equal(s.index.files, 6); // not .env, not node_modules
    assert.ok(s.index.symbols >= 8);
    assert.equal(existsSync(path.join(ws, ".brain")), false);
  });

  it("search_code finds symbols from natural words, ranked", async () => {
    const r = (await tool(c, AgentTools.searchCode, { query: "user by id" })).body;
    assert.equal(r.results[0].symbol, "get_user_by_id");
    assert.equal(r.results[0].path, "svc/users.py");
    assert.equal(r.results[0].doc, "Fetch one user by id.");
    assert.match(r.results[0].signature, /^def get_user_by_id\(user_id\)/);

    const s = (await tool(c, AgentTools.searchCode, { query: "session" })).body;
    assert.ok(s.results.some((x: { symbol: string }) => x.symbol === "SessionStore"));
    assert.ok(s.results.some((x: { symbol: string }) => x.symbol === "createSession"));
  });

  it("search_code matches word forms (plural and singular)", async () => {
    const r = (await tool(c, AgentTools.searchCode, { query: "sessions" })).body;
    assert.ok(r.results.some((x: { symbol: string }) => x.symbol === "SessionStore"));
    const users = (await tool(c, AgentTools.searchCode, { query: "fetching users" })).body;
    assert.equal(users.results[0].symbol, "get_user_by_id");
  });

  it("search_code ranks an exact identifier first, filters by kind and pages", async () => {
    const exact = (await tool(c, AgentTools.searchCode, { query: "SessionStore" })).body;
    assert.equal(exact.results[0].symbol, "SessionStore");
    const methods = (await tool(c, AgentTools.searchCode, { query: "session", kind: "method" })).body;
    assert.ok(methods.results.length > 0 && methods.results.every((x: { kind: string }) => x.kind === "method"));
    const page1 = (await tool(c, AgentTools.searchCode, { query: "session", limit: 1 })).body;
    assert.equal(page1.results.length, 1);
    assert.equal(page1.next_offset, 1);
    const page2 = (await tool(c, AgentTools.searchCode, { query: "session", limit: 1, offset: 1 })).body;
    assert.notEqual(page2.results[0].symbol, page1.results[0].symbol);
  });

  it("search_code never returns secrets or vendored code", async () => {
    for (const q of ["leaked", "supersecret_value", "TOKEN"]) {
      const r = (await tool(c, AgentTools.searchCode, { query: q })).body;
      assert.ok(!JSON.stringify(r).includes("node_modules"), q);
      assert.ok(!JSON.stringify(r).includes("supersecret"), q);
    }
  });

  it("search_code tolerates hostile query syntax", async () => {
    for (const q of ['"unterminated', "a AND OR NOT (", "*", "col:umn", "Robert'); DROP TABLE symbol;--", "   "]) {
      const r = await tool(c, AgentTools.searchCode, { query: q.trim() || "x" });
      assert.equal(r.isError, false, q);
    }
    assert.ok((await readJson(c, Resources.status)).index.symbols > 0); // table still there
  });

  it("get_symbol returns full details, and suggestions on a miss", async () => {
    const r = (await tool(c, AgentTools.getSymbol, { name: "SessionStore.get" })).body;
    assert.equal(r.found, true);
    assert.equal(r.matches[0].path, "src/auth/session.ts");
    assert.equal(r.matches[0].kind, "method");
    assert.equal(r.matches[0].doc, "Look up a session by its id.");
    assert.equal(r.matches[0].doc_status, "none");

    const plain = (await tool(c, AgentTools.getSymbol, { name: "find" })).body; // plain method name
    assert.equal(plain.matches[0].symbol, "UserRepo.find");

    const miss = (await tool(c, AgentTools.getSymbol, { name: "SesionStore" })).body;
    assert.equal(miss.found, false);
    assert.ok(Array.isArray(miss.did_you_mean));
  });

  it("get_neighbors follows imports in both directions", async () => {
    const r = (await tool(c, AgentTools.getNeighbors, { path: "src/auth/session.ts" })).body;
    assert.deepEqual(r.imports.map((x: { path: string }) => x.path), ["src/db/pool.ts"]);
    assert.deepEqual(r.imported_by.map((x: { path: string }) => x.path), ["src/http/login.ts"]);
    assert.equal(r.imports[0].confidence, "resolved");

    const py = (await tool(c, AgentTools.getNeighbors, { path: "svc/users.py", direction: "out" })).body;
    assert.deepEqual(py.imports.map((x: { path: string }) => x.path), ["svc/repo.py"]);
    assert.equal(py.imported_by, undefined);

    const bad = await tool(c, AgentTools.getNeighbors, { path: "nope.ts" });
    assert.equal(bad.isError, true);
  });

  it("impact_of_change lists transitive dependents by distance", async () => {
    const r = (await tool(c, AgentTools.impactOfChange, { path: "src/db/pool.ts" })).body;
    assert.deepEqual(r.by_distance, { 1: ["src/auth/session.ts"], 2: ["src/http/login.ts"], 3: ["src/http/admin.ts"] });
    assert.equal(r.total, 3);
    const shallow = (await tool(c, AgentTools.impactOfChange, { path: "src/db/pool.ts", depth: 1 })).body;
    assert.equal(shallow.total, 1);
  });

  it("keeps agent output compact (single-line JSON)", async () => {
    const r = await tool(c, AgentTools.searchCode, { query: "session" });
    assert.ok(!r.text.includes("\n"));
  });

  it("logs every agent call with the client name and no admin traffic", async () => {
    const usage = (await readJson(c, Resources.usage)) as UsageSummary;
    assert.ok(usage.total >= 8);
    assert.equal(usage.byClient["claude-code"], usage.total);
    assert.ok(usage.byTool[AgentTools.searchCode] >= 4);
    const last = usage.recent[0];
    assert.equal(last.client, "claude-code");
    assert.ok(last.resultTokens > 0);
    assert.ok(last.latencyMs >= 0);
    assert.ok(!usage.recent.some((e) => e.tool.startsWith("brain_admin_")));
  });
});

describe("usage log excludes the extension's own client", () => {
  let ws: string;
  before(() => { ws = fixture(); });
  after(() => cleanDir(ws));

  it("does not count brain-vscode calls", async () => {
    const c = await connect(ws, { clientName: "brain-vscode", admin: true, watch: false });
    try {
      await ready(c);
      await tool(c, AgentTools.searchCode, { query: "session" });
      assert.equal(((await readJson(c, Resources.usage)) as UsageSummary).total, 0);
    } finally { await c.close(); }
  });

  it("notifies subscribers when an agent calls a tool", async () => {
    const c = await connect(ws, { watch: false });
    try {
      await ready(c);
      const seen = new Promise<string>((resolve) => c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { if (n.params.uri === Resources.usage) resolve(n.params.uri); }));
      await c.subscribeResource({ uri: Resources.usage });
      await tool(c, AgentTools.searchCode, { query: "session" });
      assert.equal(await Promise.race([seen, new Promise((_, r) => setTimeout(() => r(new Error("no usage notification")), 5000))]), Resources.usage);
    } finally { await c.close(); }
  });
});

describe("incremental indexing and persistence", () => {
  let ws: string;
  before(() => { ws = fixture(); });
  after(() => cleanDir(ws));

  it("takes language-server edges from the extension only, and shows them to agents with their source", async () => {
    const agent = await connect(ws, { watch: false });
    try {
      await ready(agent);
      const refused = (await agent.callTool({ name: AdminTools.putEdges, arguments: { from: "src/http/login.ts", edges: [] } })) as { isError?: boolean };
      assert.equal(refused.isError, true, "an agent cannot write edges");
    } finally { await agent.close(); }
    const c = await connect(ws, { admin: true, watch: false });
    try {
      await ready(c);
      const put = await tool(c, AdminTools.putEdges, { from: "src/http/login.ts", edges: [{ to: "src/db/pool.ts", kind: "calls" }, { to: "src/auth/session.ts", kind: "calls" }, { to: "lib/outside.ts", kind: "calls" }] });
      assert.deepEqual(put.body, { stored: 2, skipped: ["lib/outside.ts"] });
      const out = (await tool(c, AgentTools.getNeighbors, { path: "src/http/login.ts", direction: "out" })).body;
      assert.equal(out.imports.find((e: { path: string }) => e.path === "src/auth/session.ts").source, "treesitter", "an import wins when a pair has both");
      await tool(c, AdminTools.putEdges, { from: "src/http/login.ts", edges: [{ to: "svc/users.py", kind: "calls" }] });
      const calls = (await tool(c, AgentTools.getNeighbors, { path: "src/http/login.ts", direction: "out" })).body.imports.find((e: { path: string }) => e.path === "svc/users.py");
      assert.deepEqual([calls.kind, calls.source, calls.confidence], ["calls", "lsp", "resolved"]);
      assert.equal((await tool(c, AdminTools.putEdges, { from: "no/such.ts", edges: [] })).isError, true);
      const bad = (await c.callTool({ name: AdminTools.putEdges, arguments: { from: "src/http/login.ts", edges: [{ to: "x", kind: "wat" }] } })) as { isError?: boolean };
      assert.equal(bad.isError, true, "an unknown kind is refused");
    } finally { await c.close(); }
  });

  it("reports every file's documentation status for the editor's coverage view", async () => {
    const c = await connect(ws, { admin: true, watch: false });
    try {
      await ready(c);
      const { items } = await readJson(c, Resources.docStatus);
      const file = items.find((i: { kind: string; target: string }) => i.kind === "file" && i.target === "src/db/pool.ts");
      assert.deepEqual([file.status, file.docFile], ["none", null]);
      assert.ok(items.some((i: { kind: string }) => i.kind === "module"), "modules are listed too");
    } finally { await c.close(); }
  });

  it("reparses only changed files, drops deleted ones, and survives a restart after init", async () => {
    const c = await connect(ws, { admin: true, watch: false });
    try {
      await ready(c);
      await tool(c, AdminTools.init);
      await new Promise((r) => setTimeout(r, 300)); // the post-init reindex
      const first = (await tool(c, AdminTools.reindex)).body;
      assert.equal(first.changed, 0);
      assert.equal(first.files, 6);

      writeFileSync(path.join(ws, "src/db/pool.ts"), FILES["src/db/pool.ts"] + "export function disconnect() {}\n");
      unlinkSync(path.join(ws, "svc/repo.py"));
      const second = (await tool(c, AdminTools.reindex)).body;
      assert.equal(second.changed, 1);
      assert.equal(second.removed, 1);
      assert.equal(second.files, 5);
      assert.equal((await tool(c, AgentTools.searchCode, { query: "disconnect" })).body.results[0].symbol, "disconnect");
      const gone = (await tool(c, AgentTools.getSymbol, { name: "UserRepo" })).body;
      assert.equal(gone.found, false); // the deleted file's symbols are gone
      // the edge from users.py to the deleted file is gone
      assert.deepEqual((await tool(c, AgentTools.getNeighbors, { path: "svc/users.py", direction: "out" })).body.imports, []);
    } finally { await c.close(); }

    assert.ok(existsSync(path.join(ws, ".brain/.cache/brain.db")));
    const c2 = await connect(ws, { admin: true, watch: false });
    try {
      // Persisted index answers before any rescan could have finished re-parsing everything.
      const hit = (await tool(c2, AgentTools.searchCode, { query: "disconnect" })).body;
      assert.equal(hit.results[0].symbol, "disconnect");
      await ready(c2);
      assert.equal((await tool(c2, AdminTools.reindex)).body.changed, 0);
    } finally { await c2.close(); }
  });

  it("the file watcher picks up edits without a manual reindex", async () => {
    const c = await connect(ws, { watch: true });
    try {
      await ready(c);
      writeFileSync(path.join(ws, "src/http/new.ts"), "export function brandNewHandler() {}\n");
      let found = false;
      for (let i = 0; i < 60 && !found; i++) {
        await new Promise((r) => setTimeout(r, 100));
        found = (await tool(c, AgentTools.searchCode, { query: "brandNewHandler" })).body.total > 0;
      }
      assert.ok(found, "watcher did not trigger a reindex");
    } finally { await c.close(); }
  });
});
