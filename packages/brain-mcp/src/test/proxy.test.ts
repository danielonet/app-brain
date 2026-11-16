import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdminTools, AgentTools, DAEMON_INFO_FILE, Resources, ensureRuntimeDir, runtimeDir, writeDaemonInfo } from "@app-brain/brain-protocol";
import { findLiveDaemon } from "../proxy";
import { BrainWorkspace } from "../workspace";
import { CLI, Env, httpClient, setup, startDaemonProc, status, waitFor } from "./daemonHelpers";
import { tool } from "./helpers";

/** An agent the way Claude Code runs one: a stdio command, with no token and no port in its config. */
async function agent(e: Env, name = "claude-code", extraArgs: string[] = []) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "--workspace", e.ws, ...extraArgs], env: e.env as Record<string, string>, stderr: "pipe" });
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const c = new Client({ name, version: "1" });
  let closed = false;
  c.onclose = () => (closed = true);
  await c.connect(transport);
  return { c, stderr: () => stderr.join(""), closed: () => closed, pid: () => (transport as unknown as { _process?: { pid?: number } })._process?.pid };
}

describe("an agent's stdio server, with a daemon running", () => {
  it("joins the daemon instead of indexing a second time, keeps the agent role, and is counted under its own name", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      await waitFor(async () => (await status(admin)).index.files >= 4);
      const a = await agent(e);
      try {
        const st = await status(a.c);
        assert.equal(st.server.pid, d.info.pid, "answered by the daemon");
        assert.equal(st.server.transport, "http");
        assert.match(a.stderr(), /using the daemon on port/);
        assert.deepEqual((await status(admin)).server.clients.map((c: any) => c.name).sort(), ["brain-vscode", "claude-code"]);

        const r = await tool(a.c, AgentTools.searchCode, { query: "session", limit: 50 });
        assert.equal(r.isError, false);
        assert.ok(r.body.results.length > 0);
        assert.equal((await tool(a.c, AdminTools.init)).isError, true, "through the proxy it is still only an agent");
        assert.equal((await tool(a.c, AdminTools.shutdown)).isError, true);

        const usage = JSON.parse(((await admin.readResource({ uri: Resources.usage })).contents[0] as { text: string }).text);
        assert.equal(usage.byClient["claude-code"], 1, "the extension sees what the agent asked, live");
      } finally { await a.c.close(); }
      await admin.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("sees files the daemon's watcher picked up, and hears the daemon's notifications", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    try {
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      await waitFor(async () => (await status(admin)).index.files >= 4);
      const a = await agent(e);
      try {
        let heard = 0;
        a.c.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => { if (n.params.uri === Resources.status) heard++; });
        await a.c.subscribeResource({ uri: Resources.status });

        writeFileSync(path.join(e.ws, "src/fresh.ts"), "export function brandNewThing() {}\n");
        assert.equal(await waitFor(async () => (await tool(a.c, AgentTools.searchCode, { query: "brandNewThing" })).body.total > 0, 10000), true, "found through the proxy");
        assert.equal(await waitFor(() => heard > 0), true, "the daemon's status change reached the agent over the proxy");
      } finally { await a.c.close(); }
      await admin.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("ends its session at once when the agent leaves", async () => {
    const e = setup();
    const d = await startDaemonProc(e, { args: ["--session-grace-ms", "60000"] }); // a long grace: only an explicit goodbye can explain a quick exit
    try {
      const admin = await httpClient(d.info, "brain-vscode", { admin: true });
      const a = await agent(e);
      await status(a.c);
      assert.equal((await status(admin)).server.clients.length, 2);
      await a.c.close();
      assert.equal(await waitFor(async () => (await status(admin)).server.clients.length === 1, 4000), true, "the proxy sent the DELETE");
      await admin.close();
    } finally { d.kill(); await d.exit; e.cleanup(); }
  });

  it("lets the agent go when the daemon dies, instead of hanging", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    const a = await agent(e);
    try {
      await status(a.c);
      d.kill("SIGKILL");
      await d.exit;
      assert.equal(await waitFor(() => a.closed(), 8000), true, "the agent's connection closed, so it can restart its server");
    } finally { await a.c.close().catch(() => {}); d.kill(); e.cleanup(); }
  });
});

describe("an agent's stdio server, when it cannot use a daemon", () => {
  it("runs on its own when no daemon exists, exactly as before", async () => {
    const e = setup();
    const a = await agent(e);
    try {
      const st = await status(a.c);
      assert.equal(st.server.transport, "stdio");
      assert.equal(st.server.pid, a.pid());
      assert.doesNotMatch(a.stderr(), /using the daemon/);
      assert.equal(await waitFor(async () => (await status(a.c)).index.files >= 4), true);
    } finally { await a.c.close(); e.cleanup(); }
  });

  it("runs on its own when asked to, even beside a daemon", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    const a = await agent(e, "claude-code", ["--no-proxy"]);
    try {
      const st = await status(a.c);
      assert.equal(st.server.transport, "stdio");
      assert.notEqual(st.server.pid, d.info.pid);
    } finally { await a.c.close(); d.kill(); await d.exit; e.cleanup(); }
  });

  it("does not borrow a daemon that serves a different output folder", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    const a = await agent(e, "claude-code", ["--output-dir", "other-brain"]);
    try {
      assert.equal((await status(a.c)).server.transport, "stdio");
      assert.equal(await findLiveDaemon(new BrainWorkspace(e.ws, "other-brain"), e.env), null);
      assert.ok(await findLiveDaemon(new BrainWorkspace(e.ws), e.env));
    } finally { await a.c.close(); d.kill(); await d.exit; e.cleanup(); }
  });

  it("ignores the leftovers of a daemon that died", async () => {
    const e = setup();
    const dir = ensureRuntimeDir(runtimeDir(e.ws, e.env));
    await writeDaemonInfo(dir, { pid: 2 ** 22 + 777, port: 9, url: "http://127.0.0.1:9/mcp", agentToken: "t".repeat(43), version: "0", protocolVersion: "0.2", startedAt: "x", workspace: e.ws, outputDir: ".brain", llmFingerprint: "f" });
    const a = await agent(e);
    try {
      assert.equal((await status(a.c)).server.transport, "stdio");
      assert.equal(await findLiveDaemon(new BrainWorkspace(e.ws), e.env), null);
    } finally { await a.c.close(); e.cleanup(); }
  });

  it("ignores a server.json that points at something which is not our daemon", async () => {
    const e = setup();
    const impostor = await startDaemonProc(setup()); // a real daemon, but for another workspace
    const dir = ensureRuntimeDir(runtimeDir(e.ws, e.env));
    // a file for our workspace that names the impostor's port and token: the pid will not match what answers
    await writeDaemonInfo(dir, { ...impostor.info, workspace: e.ws, pid: process.pid });
    try {
      assert.equal(await findLiveDaemon(new BrainWorkspace(e.ws), e.env), null, "the answering pid is not the recorded one");
    } finally { impostor.kill(); await impostor.exit; e.cleanup(); }
  });

  it("never creates .brain in the workspace by proxying or by running a daemon", async () => {
    const e = setup();
    const d = await startDaemonProc(e);
    const a = await agent(e);
    try {
      await tool(a.c, AgentTools.searchCode, { query: "session" });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(require("node:fs").existsSync(path.join(e.ws, ".brain")), false);
    } finally { await a.c.close(); d.kill(); await d.exit; e.cleanup(); }
    void mkdirSync; void DAEMON_INFO_FILE;
  });
});
