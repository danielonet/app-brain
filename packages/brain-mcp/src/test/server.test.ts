import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdminTools, ENV_ADMIN_TOKEN, OKF_VERSION, PROTOCOL_VERSION, Resources } from "@app-brain/brain-protocol";
import { globToRegExp, isSecretFile } from "../scan.js";

const TOKEN = "test-token-123";
const CLI = path.resolve(__dirname, "..", "cli.js");

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-fixture-"));
  const put = (rel: string, body = "x") => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  put("src/a.ts");
  put("src/b.py");
  put("src/gen/skip.ts");
  put("README.md");
  put(".env", "SECRET=1");
  put("keys/server.pem", "-----BEGIN-----");
  put("node_modules/dep/index.js");
  put(".gitignore", "ignored.ts\n");
  put("ignored.ts");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

async function connect(workspace: string, token: string | undefined = TOKEN) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (token) env[ENV_ADMIN_TOKEN] = token;
  else delete env[ENV_ADMIN_TOKEN];
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "--workspace", workspace], env }));
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(res.isError), body: JSON.parse(res.content[0].text) };
};
const readJson = async (c: Client, uri: string) => JSON.parse(((await c.readResource({ uri })).contents[0] as { text: string }).text);

describe("scan helpers", () => {
  it("never treats secret files as indexable", () => {
    for (const f of [".env", ".env.local", "a/b/key.pem", "id_rsa", "x/credentials.json", ".npmrc"]) assert.ok(isSecretFile(f), f);
    for (const f of ["src/env.ts", "keyboard.ts", "README.md"]) assert.ok(!isSecretFile(f), f);
  });
  it("globs", () => {
    assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/c.ts"));
    assert.ok(globToRegExp("**/gen/**").test("src/gen/skip.ts"));
  });
});

describe("brain-mcp over stdio", () => {
  let ws: string;
  before(() => { ws = fixture(); });
  after(() => rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

  it("serves status and config to any client, without admin", async () => {
    const c = await connect(ws, undefined);
    try {
      const status = await readJson(c, Resources.status);
      assert.equal(status.protocolVersion, PROTOCOL_VERSION);
      assert.equal(status.initialised, false);
      const config = await readJson(c, Resources.config);
      assert.equal(config.docs.granularity, "module");
    } finally { await c.close(); }
  });

  it("refuses admin tools without a valid hello", async () => {
    const c = await connect(ws);
    try {
      assert.equal((await call(c, AdminTools.init)).isError, true);
      assert.equal((await call(c, AdminTools.hello, { adminToken: "wrong" })).body.admin, false);
      assert.equal((await call(c, AdminTools.init)).isError, true);
      assert.equal(existsSync(path.join(ws, ".brain")), false);
    } finally { await c.close(); }
  });

  it("refuses admin tools when the server has no token configured", async () => {
    const c = await connect(ws, "");
    try {
      assert.equal((await call(c, AdminTools.hello, { adminToken: "" })).body.admin, false);
    } finally { await c.close(); }
  });

  it("rejects a protocol major mismatch", async () => {
    const c = await connect(ws);
    try {
      const r = await call(c, AdminTools.hello, { adminToken: TOKEN, protocolVersion: "9.0" });
      assert.equal(r.isError, true);
    } finally { await c.close(); }
  });

  it("initialises the layout, with an OKF root index, and is idempotent", async () => {
    const c = await connect(ws);
    try {
      const hello = await call(c, AdminTools.hello, { adminToken: TOKEN, protocolVersion: PROTOCOL_VERSION });
      assert.equal(hello.body.admin, true);
      assert.ok(hello.body.adminTools.includes(AdminTools.init));

      const first = await call(c, AdminTools.init);
      assert.equal(first.body.alreadyInitialised, false);
      assert.ok(first.body.created.includes(".brain/config.json"));
      const index = readFileSync(path.join(ws, ".brain/knowledge/index.md"), "utf8");
      assert.match(index, new RegExp(`okf_version: "${OKF_VERSION}"`));
      assert.match(readFileSync(path.join(ws, ".brain/.gitignore"), "utf8"), /drafts\//);

      writeFileSync(path.join(ws, ".brain/knowledge/log.md"), "# Log\n\nedited by a human\n");
      const second = await call(c, AdminTools.init);
      assert.equal(second.body.alreadyInitialised, true);
      assert.deepEqual(second.body.created, []);
      assert.match(readFileSync(path.join(ws, ".brain/knowledge/log.md"), "utf8"), /edited by a human/);
    } finally { await c.close(); }
  });

  it("indexes code files only, skipping secrets, ignored and vendored files", async () => {
    const c = await connect(ws);
    try {
      await call(c, AdminTools.hello, { adminToken: TOKEN });
      const r = await call(c, AdminTools.reindex);
      // a.ts, gen/skip.ts, b.py. Not: .env, .pem, node_modules, ignored.ts, README.md
      assert.deepEqual(r.body.byLanguage, { python: 1, typescript: 2 });
      assert.equal(r.body.files, 3);
      const status = await readJson(c, Resources.status);
      assert.equal(status.state, "idle");
      assert.equal(status.index.files, 3);
      assert.equal(status.initialised, true);
    } finally { await c.close(); }
  });

  it("validates config, persists valid changes, and applies exclude globs", async () => {
    const c = await connect(ws);
    try {
      await call(c, AdminTools.hello, { adminToken: TOKEN });
      const bad = await call(c, AdminTools.setConfig, { config: { docs: { granularity: "nonsense" } } });
      assert.equal(bad.isError, true);
      assert.equal(bad.body.details[0].path, "docs.granularity");
      assert.deepEqual(bad.body.details[0].pathParts, ["docs", "granularity"]);

      const moved = await call(c, AdminTools.setConfig, { config: { outputDir: "elsewhere" } });
      assert.equal(moved.isError, true);

      const current = (await call(c, AdminTools.getConfig)).body;
      const ok = await call(c, AdminTools.setConfig, { config: { ...current, exclude: ["**/gen/**"] } });
      assert.equal(ok.isError, false);
      assert.deepEqual(JSON.parse(readFileSync(path.join(ws, ".brain/config.json"), "utf8")).exclude, ["**/gen/**"]);
      assert.equal((await call(c, AdminTools.reindex)).body.files, 2);
    } finally { await c.close(); }
  });

  it("returns a JSON schema for the settings form", async () => {
    const c = await connect(ws);
    try {
      await call(c, AdminTools.hello, { adminToken: TOKEN });
      const schema = (await call(c, AdminTools.getConfigSchema)).body;
      assert.ok(JSON.stringify(schema).includes("granularity"));
      assert.equal(schema.type, "object", "the form renders from the root, no $ref wrapper");
      assert.ok(schema.properties.pricing.additionalProperties.properties.inputPerMtok.description);
    } finally { await c.close(); }
  });

  it("notifies subscribers when status changes", async () => {
    const c = await connect(ws);
    try {
      await call(c, AdminTools.hello, { adminToken: TOKEN });
      const { ResourceUpdatedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
      const seen = new Promise<string>((resolve) =>
        c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri)),
      );
      await c.subscribeResource({ uri: Resources.status });
      await call(c, AdminTools.reindex);
      assert.equal(await Promise.race([seen, new Promise((_, r) => setTimeout(() => r(new Error("no notification")), 5000))]), Resources.status);
    } finally { await c.close(); }
  });
});
