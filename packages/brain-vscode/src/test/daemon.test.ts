import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { UsageSummary } from "@app-brain/brain-protocol";
import { DaemonInfo, daemonHealthy, llmFingerprint, pidAlive, readDaemonInfo, runtimeDir } from "@app-brain/brain-protocol";
import { BrainClient, TransportSpec } from "../client";
import { EnsureOptions, ensureDaemon, stopDaemon } from "../daemonManager";
import { serverLine } from "../format";
import { daemonLlm } from "../llmEnv";
import { cleanDir } from "./cleanDir";

const SERVER = require.resolve("@app-brain/brain-mcp/out/cli.js");
const ADMIN = "adm-ext-0123456789abcdef0123456789abcdef";
const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<boolean> | boolean, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(60); } return false; };

interface Space { ws: string; runtime: string; env: NodeJS.ProcessEnv; opts: EnsureOptions; pids: Set<number> }
const spaces: Space[] = [];

function space(over: Partial<EnsureOptions> = {}): Space {
  const ws = mkdtempSync(path.join(tmpdir(), "brain-ext-daemon-ws-"));
  for (const [rel, body] of Object.entries({ "src/a.ts": "import { b } from './b';\nexport function a() { return b(); }\n", "src/b.ts": "export function b() { return 1; }\n" })) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const runtime = mkdtempSync(path.join(tmpdir(), "brain-ext-daemon-rt-"));
  const env: NodeJS.ProcessEnv = { ...process.env, BRAIN_RUNTIME_DIR: runtime };
  const s: Space = {
    ws, runtime, env, pids: new Set(),
    opts: { nodePath: process.execPath, serverPath: SERVER, workspace: ws, outputDir: ".brain", adminToken: ADMIN, llm: daemonLlm({ mode: "agent", model: "", baseUrl: "", effort: "" }, undefined), env, log: () => {}, startTimeoutMs: 20000, ...over },
  };
  spaces.push(s);
  return s;
}
const ensure = async (s: Space, over: Partial<EnsureOptions> = {}) => { const h = await ensureDaemon({ ...s.opts, ...over }); s.pids.add(h.info.pid); return h; };
afterEach(async () => {
  for (const s of spaces.splice(0)) {
    const info = await readDaemonInfo(runtimeDir(s.ws, s.env));
    if (info) s.pids.add(info.pid);
    for (const pid of s.pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanDir(s.ws);
    cleanDir(s.runtime);
  }
});

describe("starting and finding the shared server", () => {
  it("starts one when there is none, detached so it outlives the window, and joins it the next time", async () => {
    const s = space();
    const a = await ensure(s);
    assert.equal(a.spawned, true);
    assert.equal(await daemonHealthy(a.info), true);
    if (linux) assert.doesNotThrow(() => process.kill(-a.info.pid, 0), "the daemon leads its own process group: closing this window does not take it down");
    const b = await ensure(s);
    assert.deepEqual([b.spawned, b.info.pid, b.info.agentToken], [false, a.info.pid, a.info.agentToken], "joined, not restarted");
  });

  it("ends up with one daemon when two windows ask at the same moment", async () => {
    const s = space();
    const [a, b] = await Promise.all([ensure(s), ensure(s)]);
    assert.equal(a.info.pid, b.info.pid, "both got the same daemon");
    assert.equal([a, b].filter((h) => h.spawned).length <= 1, true);
    await sleep(500);
    assert.equal(pidAlive(a.info.pid), true);
    assert.equal(await daemonHealthy(a.info), true);
  });

  it("replaces a daemon started with different LLM settings, or a different key, because those travel only at start-up", async () => {
    const s = space();
    const first = await ensure(s);
    const sameAgain = await ensure(s);
    assert.equal(sameAgain.info.pid, first.info.pid);

    const model = await ensure(s, { llm: daemonLlm({ mode: "local", model: "llama3", baseUrl: "", effort: "" }, undefined) });
    assert.notEqual(model.info.pid, first.info.pid);
    assert.equal(pidAlive(first.info.pid), false, "the old daemon is gone");
    assert.equal(model.spawned, true);

    const key1 = await ensure(s, { llm: daemonLlm({ mode: "api-key", model: "m", baseUrl: "", effort: "" }, "sk-one-0123456789") });
    const key2 = await ensure(s, { llm: daemonLlm({ mode: "api-key", model: "m", baseUrl: "", effort: "" }, "sk-two-0123456789") });
    assert.notEqual(key1.info.pid, key2.info.pid, "a new key is a change");
    assert.equal(key2.info.llmFingerprint, llmFingerprint(key2.info.agentToken, daemonLlm({ mode: "api-key", model: "m", baseUrl: "", effort: "" }, "sk-two-0123456789")));
    assert.ok(!JSON.stringify(key2.info).includes("sk-two"));
  });

  it("does not restart a daemon for an unrelated change, and replaces one for another output folder", async () => {
    const s = space();
    const a = await ensure(s, { llm: daemonLlm({ mode: "vscode-lm", model: " gpt ", baseUrl: "http://ignored", effort: "high" }, "sk-not-used") });
    const b = await ensure(s, { llm: daemonLlm({ mode: "vscode-lm", model: "gpt", baseUrl: "", effort: "" }, undefined) });
    assert.equal(b.info.pid, a.info.pid, "a url, an effort or a key the mode cannot use is not a change");
    const c = await ensure(s, { outputDir: "other-brain" });
    assert.notEqual(c.info.pid, a.info.pid);
    assert.equal(c.info.outputDir, "other-brain");
  });

  it("starts a new one when the last was killed and left its files behind", async () => {
    const s = space();
    const a = await ensure(s);
    process.kill(a.info.pid, "SIGKILL");
    await until(() => !pidAlive(a.info.pid));
    assert.ok(await readDaemonInfo(runtimeDir(s.ws, s.env)), "stale file still there");
    const b = await ensure(s);
    assert.notEqual(b.info.pid, a.info.pid);
    assert.equal(b.spawned, true);
    assert.equal(await daemonHealthy(b.info), true);
  });

  it("explains why it could not start, quickly", async () => {
    const s = space();
    const t0 = Date.now();
    await assert.rejects(ensureDaemon({ ...s.opts, serverPath: path.join(s.ws, "no-such-server.js") }), /exited with code/);
    assert.ok(Date.now() - t0 < 8000, "fails fast when the process exits");
    await assert.rejects(ensureDaemon({ ...s.opts, nodePath: path.join(s.ws, "no-such-node") }), /Could not start the server/);
    const sleepy = path.join(s.ws, "sleepy.js");
    writeFileSync(sleepy, "setTimeout(() => {}, 30000);");
    await assert.rejects(ensureDaemon({ ...s.opts, serverPath: sleepy, startTimeoutMs: 700 }), /did not become ready within 1s/);
  });

  it("hands over the secrets without putting them on the command line or in the environment", async () => {
    const s = space();
    const key = "sk-ant-api03-EXTSECRET0123456789abcdef";
    const h = await ensure(s, { llm: daemonLlm({ mode: "api-key", model: "m", baseUrl: "", effort: "" }, key) });
    if (linux) {
      const environ = readFileSync(`/proc/${h.info.pid}/environ`, "latin1");
      const cmdline = readFileSync(`/proc/${h.info.pid}/cmdline`, "latin1");
      for (const secret of [key, ADMIN]) {
        assert.ok(!environ.includes(secret), "a secret is readable by any process of this user from /proc/<pid>/environ");
        assert.ok(!cmdline.includes(secret), "a secret is visible in `ps`");
      }
    }
    assert.ok(!readFileSync(path.join(s.runtime, readdirOne(s.runtime), "server.json"), "utf8").includes(ADMIN), "the admin token is in no file");
  });

  it("stops a daemon cleanly, and is harmless on one that is already gone", async () => {
    const s = space();
    const h = await ensure(s);
    await stopDaemon(h.info, s.env, () => {});
    assert.equal(pidAlive(h.info.pid), false);
    assert.equal(await readDaemonInfo(runtimeDir(s.ws, s.env)), null, "its file is removed");
    await stopDaemon(h.info, s.env, () => {}); // again
  });
});

function readdirOne(dir: string): string {
  return require("node:fs").readdirSync(dir)[0];
}

describe("the extension's client on the shared server", () => {
  const client = (s: Space, over: Partial<ConstructorParameters<typeof BrainClient>[0]> = {}) => {
    const events: { conn: string; pid?: number }[] = [];
    const c: BrainClient = new BrainClient({
      nodePath: process.execPath, serverPath: SERVER, workspace: s.ws, outputDir: ".brain", log: () => {}, adminToken: ADMIN,
      transport: async (): Promise<TransportSpec> => { const h = await ensure(s); return { kind: "http", url: h.info.url, agentToken: h.info.agentToken }; },
      onState: (conn) => events.push({ conn, pid: c?.current?.server.pid }),
      ...over,
    });
    return { c, events };
  };
  const ready = async (c: BrainClient) => until(async () => { await c.refresh(); return c.current?.state === "idle" && (c.current?.index.files ?? 0) >= 2; });

  it("connects as the admin, over HTTP, and says it is shared", async () => {
    const s = space();
    const { c } = client(s);
    await c.start();
    try {
      await ready(c);
      assert.equal(c.shared, true);
      assert.equal(c.current!.server.transport, "http");
      assert.deepEqual(c.current!.server.clients, [{ name: "brain-vscode", admin: true }]);
      const init = await c.initialise();
      assert.equal(init.alreadyInitialised, false, "admin tools work");
      assert.match(serverLine(c.current!), /^Server: shared \(pid \d+\)\.\n$/);
    } finally { await c.stop(); }
  });

  it("sees an agent's calls live, through the agent's ordinary stdio config", async () => {
    const s = space();
    const seen: UsageSummary[] = [];
    const { c } = client(s, { onUsage: (u) => seen.push(u) });
    await c.start();
    const agentTransport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--workspace", s.ws], env: s.env as Record<string, string>, stderr: "ignore" });
    const agent = new Client({ name: "claude-code", version: "1" });
    try {
      await ready(c);
      await agent.connect(agentTransport);
      const st = JSON.parse(((await agent.readResource({ uri: "brain://status" })).contents[0] as { text: string }).text);
      assert.equal(st.server.pid, c.current!.server.pid, "the agent's server is the daemon: one index for both");
      await agent.callTool({ name: "search_code", arguments: { query: "function" } });
      assert.equal(await until(() => seen.some((u) => u.recent.some((e) => e.client === "claude-code" && e.tool === "search_code"))), true, "the extension heard about it as it happened");
      await c.refresh();
      assert.match(serverLine(c.current!), /Also connected: claude-code\./);
    } finally { await agent.close().catch(() => {}); await c.stop(); }
  });

  it("leaves the daemon for others when it disconnects, and stops it only when it was the last", async () => {
    const s = space();
    const { c } = client(s);
    await c.start();
    await ready(c);
    const info = (await readDaemonInfo(runtimeDir(s.ws, s.env)))!;
    const agentTransport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--workspace", s.ws], env: s.env as Record<string, string>, stderr: "ignore" });
    const agent = new Client({ name: "cursor", version: "1" });
    await agent.connect(agentTransport);
    await agent.readResource({ uri: "brain://status" });
    await c.refresh();
    assert.equal(c.current!.server.clients.length, 2);
    await c.stop({ shutdownIfAlone: true });
    await sleep(500);
    assert.equal(await daemonHealthy(info), true, "an agent is still using it: it stays");

    const second = client(s);
    await second.c.start();
    await agent.close();
    assert.equal(await until(async () => { await second.c.refresh(); return second.c.current!.server.clients.length === 1; }, 6000), true, "the agent's session ended");
    await second.c.stop({ shutdownIfAlone: true });
    assert.equal(await until(() => !pidAlive(info.pid), 6000), true, "nobody left: it stops");
    assert.equal(await readDaemonInfo(runtimeDir(s.ws, s.env)), null);
  });

  it("replaces a daemon that was started without this editor's admin token", async () => {
    const s = space();
    const stranger = await ensure(s, { adminToken: "stranger-token-0123456789abcdef0123456789" });
    let refused = 0;
    const { c } = client(s, {
      onAdminRefused: async () => { refused++; await stopDaemon((await readDaemonInfo(runtimeDir(s.ws, s.env)))!, s.env, () => {}); return true; },
    });
    await c.start();
    try {
      await ready(c);
      assert.equal(refused, 1);
      assert.notEqual(c.current!.server.pid, stranger.info.pid, "talking to a new daemon");
      assert.equal(pidAlive(stranger.info.pid), false);
      assert.equal((await c.initialise()).alreadyInitialised, false, "and this time admin works");
    } finally { await c.stop(); }
  });

  it("gives a clear error when the admin token is refused and nothing can fix it", async () => {
    const s = space();
    await ensure(s, { adminToken: "stranger-token-0123456789abcdef0123456789" });
    const states: string[] = [];
    const { c } = client(s, { onState: (conn) => states.push(conn), log: () => {} });
    await c.start();
    assert.equal(states.at(-1), "failed");
    await c.stop();
  });

  it("reconnects, with a new daemon, when the daemon is killed", async () => {
    const s = space();
    const { c, events } = client(s);
    await c.start();
    await ready(c);
    const firstPid = c.current!.server.pid;
    process.kill(firstPid, "SIGKILL");
    assert.equal(await until(async () => { try { await c.refresh(); return c.current?.server.pid !== undefined && c.current.server.pid !== firstPid && c.current.state === "idle"; } catch { return false; } }, 20000), true, `connections: ${events.map((e) => e.conn).join(",")}`);
    assert.ok(events.some((e) => e.conn === "connecting"), "it went through reconnecting");
    assert.equal((await c.initialise()).alreadyInitialised, false, "and is admin again");
    await c.stop({ shutdownIfAlone: true });
  });
});

describe("what the tooltip says about the server", () => {
  const st = (server: any) => ({ server } as never);
  it("names the shared server and who else is on it, and says when it is private", () => {
    assert.equal(serverLine(st({ pid: 7, transport: "http", clients: [{ name: "brain-vscode", admin: true }] })), "Server: shared (pid 7).\n");
    assert.equal(serverLine(st({ pid: 7, transport: "http", clients: [{ name: "brain-vscode", admin: true }, { name: "claude-code", admin: false }, { name: "claude-code", admin: false }, { name: null, admin: false }] })), "Server: shared (pid 7). Also connected: claude-code, unknown.\n");
    assert.equal(serverLine(st({ pid: 9, transport: "stdio", clients: [] })), "Server: private to this window (pid 9).\n");
  });
});
