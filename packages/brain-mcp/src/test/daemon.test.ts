import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, statSync, chmodSync, rmSync, utimesSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  AdminTools, AgentTools, DAEMON_INFO_FILE, DAEMON_LOCK_FILE, DaemonInfoSchema, Resources, daemonHealthy, ensureRuntimeDir, llmFingerprint, pidAlive,
  readDaemonInfo, runtimeDir, runtimeBase, workspaceKey, writeDaemonInfo,
} from "@app-brain/brain-protocol";
import { bearerOk, isAllowedHost, isLoopback } from "../daemon";
import { anthropicOk, docFor, startFakeLlm } from "./fakeLlm";
import { ADMIN, INIT_BODY, JSON_HEADERS, httpClient, raw, setup, startDaemonProc, status, waitFor } from "./daemonHelpers";
import { tool } from "./helpers";
import { cleanDir } from "./cleanDir";

const linux = process.platform === "linux";

const WINDOWS = process.platform === "win32";

describe("request checks", () => {
  it("accepts only our own host name on our own port", () => {
    assert.equal(isAllowedHost("127.0.0.1:4000", 4000), true);
    assert.equal(isAllowedHost("localhost:4000", 4000), true);
    for (const bad of [undefined, "", "127.0.0.1", "127.0.0.1:4001", "evil.example:4000", "127.0.0.1.evil.com:4000", "localhost:4000.evil.com", "0.0.0.0:4000", "[::1]:4000"]) {
      assert.equal(isAllowedHost(bad, 4000), false, String(bad));
    }
  });
  it("recognises loopback peers only", () => {
    for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(ok), true);
    for (const bad of [undefined, "10.0.0.5", "192.168.1.2", "::ffff:10.0.0.5", "0.0.0.0"]) assert.equal(isLoopback(bad), false, String(bad));
  });
  it("compares bearer tokens exactly", () => {
    assert.equal(bearerOk("Bearer s3cret", "s3cret"), true);
    for (const bad of [undefined, "", "s3cret", "Bearer", "Bearer ", "bearer s3cret", "Bearer s3cret ", "Bearer s3cre", "Bearer s3cretx", "Basic s3cret", "Bearer  s3cret"]) {
      assert.equal(bearerOk(bad, "s3cret"), false, String(bad));
    }
  });
});

describe("where the runtime files live, and who may read them", () => {
  it("has one stable directory per workspace, outside the workspace, overridable", () => {
    const a = runtimeDir("/work/a", {}), b = runtimeDir("/work/b", {});
    assert.notEqual(a, b);
    assert.equal(a, runtimeDir("/work/a/", {}), "a trailing slash is the same workspace");
    assert.equal(path.dirname(a), runtimeBase({}));
    assert.equal(runtimeBase({ BRAIN_RUNTIME_DIR: "/custom/dir" }), path.resolve("/custom/dir"));
    assert.match(workspaceKey("/work/a"), /^[0-9a-f]{16}$/);
    assert.ok(!a.startsWith("/work/a"), "never inside the workspace: that would create .brain before init");
  });
  // Windows has no POSIX modes (access is by the profile's ACL) and symlinks need privileges.
  it("makes the directory private, repairs one that is too open, and refuses a symlink", { skip: WINDOWS && "POSIX permissions" }, () => {
    const base = path.join(os.tmpdir(), `brain-rt-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(base);
      const dir = path.join(base, "ok");
      ensureRuntimeDir(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      chmodSync(dir, 0o777);
      ensureRuntimeDir(dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700, "a directory that was too open is tightened");
      const target = path.join(base, "elsewhere");
      mkdirSync(target);
      const link = path.join(base, "link");
      symlinkSync(target, link);
      assert.throws(() => ensureRuntimeDir(link), /not a plain directory/);
    } finally { cleanDir(base); }
  });
  it("writes server.json privately and atomically, and rejects a malformed one", async () => {
    const dir = ensureRuntimeDir(path.join(os.tmpdir(), `brain-rt2-${process.pid}-${Date.now()}`));
    try {
      const info = { pid: process.pid, port: 4000, url: "http://127.0.0.1:4000/mcp", agentToken: "t".repeat(43), version: "0", protocolVersion: "0.2", startedAt: "x", workspace: "/w", outputDir: ".brain", llmFingerprint: "f" };
      await writeDaemonInfo(dir, info);
      if (!WINDOWS) assert.equal(statSync(path.join(dir, DAEMON_INFO_FILE)).mode & 0o777, 0o600);
      assert.deepEqual(await readDaemonInfo(dir), info);
      assert.deepEqual(readdirSync(dir), [DAEMON_INFO_FILE], "no temp file left behind");
      writeFileSync(path.join(dir, DAEMON_INFO_FILE), "{ not json");
      assert.equal(await readDaemonInfo(dir), null);
      writeFileSync(path.join(dir, DAEMON_INFO_FILE), JSON.stringify({ ...info, agentToken: "short" }));
      assert.equal(await readDaemonInfo(dir), null, "a token that short is not accepted");
      assert.equal(DaemonInfoSchema.safeParse({ ...info, port: 0 }).success, false);
    } finally { cleanDir(dir); }
  });
  it("tells a live pid from a dead one, and never calls a dead daemon healthy", async () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(2 ** 22 + 12345), false);
    const info = { pid: 2 ** 22 + 12345, port: 1, url: "http://127.0.0.1:1/mcp", agentToken: "t".repeat(43), version: "0", protocolVersion: "0.2", startedAt: "x", workspace: "/w", outputDir: ".brain", llmFingerprint: "f" };
    assert.equal(await daemonHealthy(info), false);
    assert.equal(await daemonHealthy({ ...info, pid: process.pid }), false, "alive pid but nothing listening");
  });
  it("fingerprints LLM settings so a change is noticed, without exposing the key", () => {
    const s = { mode: "api-key", model: "m", baseUrl: "", effort: "", apiKey: "sk-secret-value" };
    const f = llmFingerprint("token-a", s);
    assert.match(f, /^[0-9a-f]{32}$/);
    assert.equal(llmFingerprint("token-a", s), f);
    assert.notEqual(llmFingerprint("token-a", { ...s, apiKey: "sk-other" }), f, "a new key is a change");
    assert.notEqual(llmFingerprint("token-a", { ...s, model: "m2" }), f);
    assert.notEqual(llmFingerprint("token-b", s), f, "keyed by the token: useless without it");
    assert.ok(!f.includes("secret"));
  });
});

describe("the daemon", () => {
  it("starts, listens on loopback only, publishes a private server.json, and writes nothing into the workspace", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      assert.ok(d.info, d.stderr());
      const file = path.join(runtimeDir(e.ws, e.env), DAEMON_INFO_FILE);
      if (!WINDOWS) assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(new URL(d.info.url).hostname, "127.0.0.1");
      assert.equal(d.info.pid, d.child.pid);
      assert.equal(d.info.workspace, e.ws);
      assert.equal(await daemonHealthy(d.info), true);
      const c = await httpClient(d.info, "probe");
      assert.equal((await waitFor(async () => (await status(c)).index.files >= 4)), true);
      await c.close();
      assert.equal(existsSync(path.join(e.ws, ".brain")), false, "indexing works before init without creating .brain");

      // not reachable from other addresses
      const external = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
      if (external) {
        const reachable = await new Promise<boolean>((resolve) => {
          const s = net.connect({ host: external.address, port: d.info.port }, () => { s.destroy(); resolve(true); });
          s.on("error", () => resolve(false));
        });
        assert.equal(reachable, false, `must not listen on ${external.address}`);
      }
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("answers only requests that pass every check, and says nothing useful to those that do not", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const i = d.info;
      const post = (o: object) => raw(i, { method: "POST", headers: JSON_HEADERS, body: INIT_BODY, ...o });
      assert.equal((await post({ auth: false })).status, 401, "no token");
      assert.equal((await post({ headers: { ...JSON_HEADERS, authorization: "Bearer wrong" } })).status, 401);
      assert.equal((await post({ path: `/mcp?token=${i.agentToken}`, auth: false })).status, 401, "a token in the URL is not accepted");
      assert.equal((await raw(i, { path: "/health", auth: false })).status, 401);
      const wrongToken = await post({ headers: { ...JSON_HEADERS, authorization: "Bearer wrong" } });
      assert.ok(!wrongToken.body.includes(i.agentToken), "never echoes the real token");
      assert.equal((await post({ headers: { ...JSON_HEADERS, host: "evil.example" } })).status, 403, "DNS rebinding: wrong Host");
      assert.equal((await post({ headers: { ...JSON_HEADERS, host: `127.0.0.1:${i.port + 1}` } })).status, 403);
      assert.equal((await post({ headers: { ...JSON_HEADERS, origin: "https://evil.example" } })).status, 403, "a web page is never a client");
      assert.equal((await raw(i, { path: "/health" })).status, 200);
      assert.equal((await raw(i, { path: "/health", method: "POST" })).status, 405);
      assert.equal((await raw(i, { path: "/nope" })).status, 404);
      assert.equal((await raw(i, { method: "PUT", path: "/mcp" })).status, 405);
      assert.equal((await raw(i, { method: "GET", path: "/mcp" })).status, 400, "no session");
      assert.equal((await raw(i, { method: "DELETE", path: "/mcp" })).status, 400);
      assert.equal((await post({ body: "{ nope" })).status, 400, "not JSON");
      assert.equal((await post({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status, 400, "must initialize first");
      assert.equal((await post({ headers: { ...JSON_HEADERS, "mcp-session-id": "00000000-0000-0000-0000-000000000000" } })).status, 404, "unknown session");
      assert.equal((await raw(i, { method: "GET", path: "/mcp", headers: { "mcp-session-id": "nope" } })).status, 404);
      // and the real thing still works afterwards
      const ok = await post({});
      assert.equal(ok.status, 200, ok.body);
      assert.match(ok.body, /"serverInfo":\{"name":"brain-mcp"/);
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("survives an oversized or truncated request and keeps serving", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const big = Buffer.alloc(5 * 1024 * 1024, "a");
      const r = await raw(d.info, { method: "POST", headers: JSON_HEADERS, body: big }).catch((err: NodeJS.ErrnoException) => ({ status: -1, body: err.code ?? "" }));
      assert.ok([413, -1].includes(r.status), `status ${r.status}`);
      assert.equal(await daemonHealthy(d.info), true, "still up");
      const c = await httpClient(d.info, "after");
      assert.equal((await tool(c, AgentTools.searchCode, { query: "session" })).isError, false);
      await c.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("serves several clients at once, each with its own role, and attributes usage to the right one", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const agent = await httpClient(d.info, "claude-code");
      const other = await httpClient(d.info, "cursor");
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      await waitFor(async () => (await status(admin)).index.files >= 4);

      const clients = (await status(admin)).server.clients;
      assert.deepEqual(clients.map((c: any) => c.name).sort(), ["brain-vscode", "claude-code", "cursor"]);
      assert.deepEqual(clients.filter((c: any) => c.admin).map((c: any) => c.name), ["brain-vscode"], "only the one that presented the admin token");
      assert.equal((await status(admin)).server.transport, "http");

      assert.equal((await tool(agent, AdminTools.init)).isError, true, "an agent cannot use admin tools");
      assert.equal((await tool(other, AdminTools.reviewSummary, { target: "x", action: "approve", by: "me" })).isError, true);
      assert.equal((await tool(admin, AdminTools.init)).isError, false);

      await Promise.all([...Array(10)].flatMap((_, i) => [tool(agent, AgentTools.searchCode, { query: "session", limit: 1 + (i % 3) }), tool(other, AgentTools.getSymbol, { name: "SessionStore" })]));
      const usage = JSON.parse(((await admin.readResource({ uri: Resources.usage })).contents[0] as { text: string }).text);
      assert.equal(usage.byClient["claude-code"], 10);
      assert.equal(usage.byClient.cursor, 10);
      assert.equal(usage.byClient["brain-vscode"], undefined, "the extension is not an agent");

      await agent.close();
      assert.equal(await waitFor(async () => (await status(admin)).server.clients.length === 2), true, "a closed session leaves the list");
      await other.close();
      await admin.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("notices a client that vanished without saying goodbye, and ends a session at once when told to", async () => {
    const e = setup();
    const d = await startDaemonProc(e); // grace period 400 ms
    try {
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      const names = async () => (await status(admin)).server.clients.map((c: any) => c.name).sort();

      const vanished = await httpClient(d.info, "crashed");
      assert.deepEqual(await names(), ["brain-vscode", "crashed"]);
      await vanished.close(); // the SDK just drops the connection: no DELETE, like a crashed agent
      assert.equal(await waitFor(async () => (await names()).join() === "brain-vscode", 6000), true, "dropped once its notification stream stayed closed");

      const polite = await httpClient(d.info, "polite");
      assert.deepEqual(await names(), ["brain-vscode", "polite"]);
      await (polite as any)._transport.terminateSession(); // the protocol's own goodbye
      assert.equal(await waitFor(async () => (await names()).join() === "brain-vscode", 1500), true, "gone at once, without waiting for the grace period");
      await polite.close();

      // a client that never opened a stream cannot be seen leaving, so it is not dropped for being quiet
      const raw1 = await raw(d.info, { method: "POST", headers: JSON_HEADERS, body: INIT_BODY });
      assert.equal(raw1.status, 200);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal((await names()).length, 2, "kept: no stream means no way to tell it left");
      await admin.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("tells every subscribed client when something changes", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const a = await httpClient(d.info, "watcher-a");
      const b = await httpClient(d.info, "watcher-b");
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      await waitFor(async () => (await status(admin)).index.files >= 4);
      const got = { a: 0, b: 0 };
      a.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { if (n.params.uri === Resources.status) got.a++; });
      b.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { if (n.params.uri === Resources.status) got.b++; });
      await a.subscribeResource({ uri: Resources.status });
      await b.subscribeResource({ uri: Resources.status });
      await tool(admin, AdminTools.init);
      assert.equal(await waitFor(() => got.a > 0 && got.b > 0), true, JSON.stringify(got));
      await b.unsubscribeResource({ uri: Resources.status });
      const before = got.b;
      await tool(admin, AdminTools.reindex);
      await waitFor(() => got.a > 1);
      assert.equal(got.b, before, "an unsubscribed client hears nothing");
      await Promise.all([a.close(), b.close(), admin.close()]);
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("keeps the admin token and the API key out of every file, process listing and response", async () => {
    const KEY = "sk-ant-api03-DAEMONTESTKEY0123456789abcdef";
    const fake = await startFakeLlm((r) => ({ json: anthropicOk(docFor(r), { in: 500, out: 100 }) }));
    const e = setup();
    const d = await startDaemonProc(e, { secrets: { adminToken: ADMIN, llm: { mode: "api-key", model: "test-model", baseUrl: fake.url, effort: "", apiKey: KEY } } });
    try {
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      await waitFor(async () => (await status(admin)).index.files >= 4);
      const st = await status(admin);
      assert.deepEqual([st.llm.mode, st.llm.ready, st.llm.model], ["api-key", true, "test-model"], "the key reached the daemon, over stdin");

      // use the key for real, so it has been handled by the running daemon
      await tool(admin, AdminTools.init);
      const cfg = (await tool(admin, AdminTools.getConfig)).body;
      await tool(admin, AdminTools.setConfig, { config: { ...cfg, pricing: { "test-model": { inputPerMtok: 3, outputPerMtok: 15 } } } });
      assert.equal((await tool(admin, AdminTools.generateDocs, { confirm: true, under: "src/db/pool.ts" })).isError, false);
      assert.equal(await waitFor(async () => JSON.parse(((await admin.readResource({ uri: Resources.generation })).contents[0] as { text: string }).text).state === "done", 15000), true);
      assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);

      const secrets = [ADMIN, KEY];
      const info = readFileSync(path.join(runtimeDir(e.ws, e.env), DAEMON_INFO_FILE), "utf8");
      const log = readFileSync(path.join(runtimeDir(e.ws, e.env), "daemon.log"), "utf8");
      const everyResource = JSON.stringify(await Promise.all(Object.values(Resources).map(async (u) => (await admin.readResource({ uri: u }).catch(() => null))?.contents[0])));
      for (const [where, text] of [["server.json", info], ["daemon.log", log], ["daemon stderr", d.stderr()], ["resources", everyResource]] as const) {
        for (const s of secrets) assert.ok(!text.includes(s), `${where} contains a secret`);
      }
      if (linux) {
        const environ = readFileSync(`/proc/${d.child.pid}/environ`, "latin1");
        const cmdline = readFileSync(`/proc/${d.child.pid}/cmdline`, "latin1");
        for (const s of secrets) {
          assert.ok(!environ.includes(s), "a secret is readable from /proc/<pid>/environ");
          assert.ok(!cmdline.includes(s), "a secret is on the command line");
        }
      }
      // the fingerprint matches what a client holding the token would compute: that is how the extension spots a change
      assert.equal(d.info.llmFingerprint, llmFingerprint(d.info.agentToken, { mode: "api-key", model: "test-model", baseUrl: fake.url, effort: "", apiKey: KEY }));
      assert.notEqual(d.info.llmFingerprint, llmFingerprint(d.info.agentToken, { mode: "api-key", model: "test-model", baseUrl: fake.url, effort: "", apiKey: "another" }));
      await admin.close();
    } finally { d.kill(); await d.exit; await fake.close(); e.cleanup(); }
  });

  it("refuses a wrong admin token, and has no admin at all when none was given", async () => {
    const e = setup();
    const d = await startDaemonProc(e, { secrets: null });
    try {
      const c = await httpClient(d.info, "brain-vscode");
      const r = await tool(c, AdminTools.hello, { adminToken: ADMIN });
      assert.equal(r.body.admin, false, "no admin token configured: nobody is admin");
      assert.equal((await tool(c, AdminTools.init)).isError, true);
      await c.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
    const e2 = setup();
    const d2 = await startDaemonProc(e2);
    try {
      const c = await httpClient(d2.info, "brain-vscode");
      assert.equal((await tool(c, AdminTools.hello, { adminToken: "x".repeat(32) })).body.admin, false);
      assert.equal((await tool(c, AdminTools.hello, { adminToken: ADMIN })).body.admin, true);
      await c.close();
    } finally { d2.kill(); await d2.exit; e2.cleanup(); }
  });

  it("rejects bad secrets on stdin without echoing them, and does not start", async () => {
    const e = setup();
    const secret = "SUPERSECRETVALUE0123456789abcdef";
    const d = await startDaemonProc(e, { secrets: { adminToken: "short", llm: { apiKey: secret } }, wait: false });
    const code = await d.exit;
    assert.notEqual(code, 0);
    assert.ok(!d.stderr().includes(secret), "an error must not repeat what it was given");
    assert.match(d.stderr(), /expected shape/);
    assert.equal(await readDaemonInfo(runtimeDir(e.ws, e.env)), null);
    e.cleanup();
  });

  it("allows only one daemon per workspace", async () => {
    const e = setup();
    const first = await startDaemonProc(e);
    try {
      const second = await startDaemonProc(e, { wait: false });
      assert.equal(await second.exit, 0, "a second start is a success: the daemon exists");
      assert.match(second.stderr(), /already running|is starting/);
      const info = await readDaemonInfo(runtimeDir(e.ws, e.env));
      assert.deepEqual([info!.pid, info!.agentToken], [first.info.pid, first.info.agentToken], "the first daemon's file is untouched");
      assert.equal(await daemonHealthy(first.info), true);
      // two starting at the same moment: exactly one wins
      const e2 = setup();
      const racers = await Promise.all([startDaemonProc(e2, { wait: false }), startDaemonProc(e2, { wait: false }), startDaemonProc(e2, { wait: false })]);
      await waitFor(async () => (await readDaemonInfo(runtimeDir(e2.ws, e2.env))) !== null);
      await new Promise((r) => setTimeout(r, 1000));
      const alive = racers.filter((r) => r.child.exitCode === null);
      assert.equal(alive.length, 1, `${alive.length} daemons are running`);
      for (const r of racers) r.kill();
      await Promise.all(racers.map((r) => r.exit));
      e2.cleanup();
    } finally { first.kill(); await first.exit; e.cleanup(); }
  });

  it("treats a lock that is still being written as a daemon starting, never as a stale one to remove", async () => {
    // The holder creates the lock, then writes its pid. In that gap the file is empty; a second daemon must not delete it.
    const e = setup();
    const lock = path.join(ensureRuntimeDir(runtimeDir(e.ws, e.env)), DAEMON_LOCK_FILE);
    try {
      writeFileSync(lock, "");
      const second = await startDaemonProc(e, { wait: false });
      assert.equal(await second.exit, 0);
      assert.match(second.stderr(), /is starting/);
      assert.equal(existsSync(lock), true, "the lock is still there");
      // an unreadable lock that is old is a crash's leftover, and is replaced
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const third = await startDaemonProc(e);
      try { assert.equal(await daemonHealthy(third.info), true); } finally { third.kill(); await third.exit; }
    } finally { e.cleanup(); }
  });

  it("recovers from a daemon that was killed without cleaning up", async () => {
    const e = setup();
    const a = await startDaemonProc(e);
    const oldInfo = a.info;
    a.kill("SIGKILL");
    await a.exit;
    assert.ok(await readDaemonInfo(runtimeDir(e.ws, e.env)), "the dead daemon left its file and lock behind");
    assert.equal(await daemonHealthy(oldInfo), false, "and nothing mistakes that for a live daemon");
    const b = await startDaemonProc(e);
    try {
      assert.notEqual(b.info.pid, oldInfo.pid);
      assert.notEqual(b.info.agentToken, oldInfo.agentToken, "a fresh token for a fresh daemon");
      assert.equal(await daemonHealthy(b.info), true);
    } finally { b.kill(); await b.exit; e.cleanup(); }
  });

  // On Windows SIGTERM ends a process at once, so nothing runs to clean up; the editor removes the file itself.
  it("cleans up when stopped, and only removes its own file", { skip: WINDOWS && "SIGTERM is a hard kill" }, async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    const dir = runtimeDir(e.ws, e.env);
    const c = await httpClient(d.info, "client");
    d.kill("SIGTERM");
    assert.equal(await d.exit, 0);
    assert.equal(await readDaemonInfo(dir), null, "server.json removed");
    assert.equal(existsSync(path.join(dir, "daemon.lock")), false, "lock released");
    await c.close().catch(() => {});
    assert.equal(await daemonHealthy(d.info), false);
    e.cleanup();
  });

  it("stops on an admin request, and not on an agent's", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const agent = await httpClient(d.info, "claude-code");
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      assert.equal((await tool(agent, AdminTools.shutdown)).isError, true);
      assert.equal(await daemonHealthy(d.info), true, "the agent could not stop it");
      assert.equal((await tool(admin, AdminTools.shutdown)).body.stopping, true);
      assert.equal(await d.exit, 0);
      assert.equal(await readDaemonInfo(runtimeDir(e.ws, e.env)), null);
    } finally { d.kill(); e.cleanup(); }
  });

  it("exits by itself when nobody is connected, and not while somebody is", async () => {
    const e = setup();
    const lonely = await startDaemonProc(e, { args: ["--idle-exit-ms", "700"] });
    assert.equal(await Promise.race([lonely.exit, new Promise((r) => setTimeout(() => r("still running"), 6000))]), 0, "nobody ever connected");
    assert.equal(await readDaemonInfo(runtimeDir(e.ws, e.env)), null);

    const busy = await startDaemonProc(e, { args: ["--idle-exit-ms", "700"] });
    try {
      const c = await httpClient(busy.info, "stays");
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(busy.child.exitCode, null, "a connected client keeps it alive");
      await c.close();
      assert.equal(await Promise.race([busy.exit, new Promise((r) => setTimeout(() => r("still running"), 6000))]), 0, "and it leaves once the client has gone");
    } finally { busy.kill(); await busy.exit; e.cleanup(); }
  });

  it("forgets sessions when it restarts, so a client must initialize again", async () => {
    const e = setup();
    const a = await startDaemonProc(e);
    const c = await httpClient(a.info, "client");
    const sid = (c as any)._transport.sessionId as string;
    a.kill();
    await a.exit;
    const b = await startDaemonProc(e);
    try {
      const r = await raw(b.info, { method: "POST", headers: { ...JSON_HEADERS, "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
      assert.equal(r.status, 404, "the new daemon has never heard of that session");
    } finally { b.kill(); await b.exit; e.cleanup(); }
  });
});
