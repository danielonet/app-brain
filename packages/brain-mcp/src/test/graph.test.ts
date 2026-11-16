import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AdminTools, AgentTools, UsageSummary, Resources } from "@app-brain/brain-protocol";
import { trustTier } from "../okf/knowledge";
import { FILES, connect, fixture, readJson, ready, tool } from "./helpers";

const CYCLE = {
  "src/a/x.ts": `import { y } from "../b/y";\nexport function x() { return y; }\n`,
  "src/b/y.ts": `import { x } from "../a/x";\nexport const y = 1;\nexport function useX() { return x; }\n`,
};

describe("trust tiers (OKF §4, derived and never stored)", () => {
  it("derives the tier from who verified", () => {
    assert.equal(trustTier({}), "unverified");
    assert.equal(trustTier({ verified: [] }), "unverified");
    assert.equal(trustTier({ verified: { by: "ci/1.0", at: "x" } }), "machine-confirmed");
    assert.equal(trustTier({ verified: { by: "human:jdoe", at: "x" } }), "human-reviewed");
    assert.equal(trustTier({ verified: [{ by: "process:lint" }, { by: "human:a" }] }), "human-reviewed", "any human makes it human-reviewed");
    assert.equal(trustTier({ verified: [{ by: "agent/x" }, { by: "process:y" }] }), "machine-confirmed");
    assert.equal(trustTier({ verified: { by: "" } }), "unverified");
    assert.equal(trustTier({ verified: "yes" }), "unverified");
  });
});

describe("dependency graph and overview", () => {
  let ws: string;
  let c: Client;
  const p = (...parts: string[]) => path.join(ws, ".brain", ...parts);
  const graph = async (args: Record<string, unknown> = {}) => (await tool(c, AgentTools.getGraph, args)).body;

  before(async () => {
    ws = fixture(CYCLE);
    c = await connect(ws, { admin: true, clientName: "brain-vscode" });
    await ready(c, 6);
  });
  after(async () => {
    await c.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("module level: directories as nodes, aggregated edges, circular dependencies flagged", async () => {
    const g = await graph();
    assert.equal(g.level, "module");
    assert.deepEqual(g.nodes.map((n: { id: string }) => n.id), ["src/a", "src/auth", "src/b", "src/db", "src/http"]);
    const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
    assert.deepEqual(g.edges.map(key), ["src/a>src/b", "src/auth>src/db", "src/b>src/a", "src/http>src/auth"]);
    assert.deepEqual(g.cycles, [["src/a", "src/b"]]);
    const cyc = Object.fromEntries(g.edges.map((e: any) => [key(e), e.cycle]));
    assert.deepEqual(cyc, { "src/a>src/b": true, "src/auth>src/db": false, "src/b>src/a": true, "src/http>src/auth": false });
    const http = g.nodes.find((n: any) => n.id === "src/http");
    assert.equal(http.files, 2);
    assert.equal(http.kind, "module");
    assert.equal(http.language, "typescript");
    assert.equal(http.doc, "none");
    assert.equal(http.trust, null);
    assert.deepEqual(g.totals, { nodes: 5, edges: 4 });
    assert.equal(g.truncated, false);
    assert.equal(g.edges[0].weight, 1);
    assert.equal(g.edges[0].confidence, "resolved");
  });

  it("file level: every file, resolved edges, module cycles still reported", async () => {
    const g = await graph({ level: "file" });
    assert.equal(g.nodes.length, 6);
    assert.equal(g.edges.length, 5);
    assert.ok(g.edges.every((e: any) => e.confidence === "resolved" && e.weight === 1));
    assert.deepEqual(g.cycles, [["src/a", "src/b"]]);
    const circular = g.edges.filter((e: any) => e.cycle).map((e: any) => `${e.from}>${e.to}`);
    assert.deepEqual(circular, ["src/a/x.ts>src/b/y.ts", "src/b/y.ts>src/a/x.ts"], "only edges between mutually dependent modules");
    const session = g.nodes.find((n: any) => n.id === "src/auth/session.ts");
    assert.equal(session.importedBy, 1);
    assert.equal(session.imports, 1);
    assert.ok(session.symbols >= 3);
  });

  it("zooms in: a root and a depth select the neighbourhood", async () => {
    const mod0 = await graph({ root: "src/auth", depth: 0 });
    assert.deepEqual(mod0.nodes.map((n: any) => n.id), ["src/auth"]);
    assert.equal(mod0.edges.length, 0);
    const mod1 = await graph({ root: "src/auth", depth: 1 });
    assert.deepEqual(mod1.nodes.map((n: any) => n.id), ["src/auth", "src/db", "src/http"]);
    assert.equal(mod1.root, "src/auth");

    const file1 = await graph({ level: "file", root: "src/auth/session.ts", depth: 1 });
    assert.deepEqual(file1.nodes.map((n: any) => n.id), ["src/auth/session.ts", "src/db/pool.ts", "src/http/login.ts"]);
    const dir = await graph({ level: "file", root: "src/http", depth: 0 });
    assert.deepEqual(dir.nodes.map((n: any) => n.id), ["src/http/admin.ts", "src/http/login.ts"]);
    assert.equal(dir.edges.length, 1);
  });

  it("caps node count, keeping the most connected, and says so", async () => {
    const g = await graph({ level: "file", limit: 5 });
    assert.equal(g.truncated, true);
    assert.equal(g.nodes.length, 5);
    assert.equal(g.totals.nodes, 6);
    assert.ok(!g.nodes.some((n: any) => n.id === "src/http/admin.ts"), "a least-connected file is the one dropped");
    assert.ok(g.edges.every((e: any) => g.nodes.some((n: any) => n.id === e.from) && g.nodes.some((n: any) => n.id === e.to)), "no dangling edges");
  });

  it("rejects bad roots", async () => {
    for (const root of ["src/nope", "../outside", "/etc"]) assert.equal((await tool(c, AgentTools.getGraph, { root })).isError, true, root);
    assert.equal((await tool(c, AgentTools.getGraph, { level: "nonsense" })).isError, true);
  });

  it("get_overview says plainly when nothing is documented, and never serves drafts", async () => {
    const none = (await tool(c, AgentTools.getOverview, { path: "src/auth/session.ts" })).body;
    assert.equal(none.documented, false);
    assert.equal(none.draft_pending, false);
    assert.match(none.hint, /save_summary/);
    assert.equal((await tool(c, AgentTools.getOverview, { path: "nope.ts" })).body.documented, false);
    assert.equal((await tool(c, AgentTools.getOverview, { path: "../etc/passwd" })).isError, true);

    await tool(c, AdminTools.init);
    await tool(c, AgentTools.saveSummary, { target: "src/auth/session.ts", description: "Sessions.", summary: "Handles sessions securely.", model: "m1" });
    const draft = (await tool(c, AgentTools.getOverview, { path: "src/auth/session.ts" })).body;
    assert.equal(draft.documented, false);
    assert.equal(draft.draft_pending, true);
    assert.ok(!JSON.stringify(draft).includes("securely"), "an unreviewed draft must not reach agents");
    assert.equal((await graph()).nodes.find((n: any) => n.id === "src/auth").doc, "none");
    assert.equal((await graph({ level: "file" })).nodes.find((n: any) => n.id === "src/auth/session.ts").doc, "draft");
  });

  it("after approval: served with its trust level, and the graph and get_symbol show it", async () => {
    await tool(c, AdminTools.reviewSummary, { target: "src/auth/session.ts", action: "approve", by: "jdoe" });
    const o = (await tool(c, AgentTools.getOverview, { path: "src/auth/session.ts" })).body;
    assert.equal(o.documented, true);
    assert.equal(o.status, "reviewed");
    assert.equal(o.trust, "human-reviewed");
    assert.equal(o.reviewed_by, "human:jdoe");
    assert.equal(o.description, "Sessions.");
    assert.match(o.doc, /Handles sessions securely\./);
    assert.equal(o.warning, undefined);

    const n = (await graph({ level: "file" })).nodes.find((x: any) => x.id === "src/auth/session.ts");
    assert.equal(n.doc, "reviewed");
    assert.equal(n.trust, "human-reviewed");

    const sym = (await tool(c, AgentTools.getSymbol, { name: "SessionStore" })).body.matches[0];
    assert.equal(sym.doc_status, "reviewed");
    assert.equal(sym.doc_trust, "human-reviewed");
  });

  it("a code change makes the doc stale everywhere, with a warning to the agent", async () => {
    writeFileSync(path.join(ws, "src/auth/session.ts"), FILES["src/auth/session.ts"] + "export function revoke() {}\n");
    await tool(c, AdminTools.reindex);
    const o = (await tool(c, AgentTools.getOverview, { path: "src/auth/session.ts" })).body;
    assert.equal(o.status, "stale");
    assert.match(o.warning, /code changed/);
    assert.equal(o.trust, "human-reviewed", "the trust tier is about who reviewed it, not freshness");
    const n = (await graph({ level: "file" })).nodes.find((x: any) => x.id === "src/auth/session.ts");
    assert.equal(n.doc, "stale");
    assert.equal((await tool(c, AgentTools.getSymbol, { name: "SessionStore" })).body.matches[0].doc_status, "stale");
  });

  it("the repo overview serves an approved architecture.md, with the tier its verification earns", async () => {
    assert.equal((await tool(c, AgentTools.getOverview, { path: "." })).body.documented, false);
    const arch = (verified: string) => `---\ntype: Brain Architecture\ntitle: Architecture\ndescription: How it fits.\n${verified}---\n\n# Architecture\n\nThree layers.\n`;
    mkdirSync(p("knowledge"), { recursive: true });
    for (const [verified, tier] of [["", "unverified"], ["verified: { by: ci/1, at: 2026-01-01T00:00:00Z }\n", "machine-confirmed"], ["verified: { by: human:a, at: 2026-01-01T00:00:00Z }\n", "human-reviewed"]] as const) {
      writeFileSync(p("knowledge/architecture.md"), arch(verified));
      const o = (await tool(c, AgentTools.getOverview, { path: "." })).body;
      assert.equal(o.documented, true, tier);
      assert.equal(o.trust, tier);
      assert.match(o.doc, /Three layers\./);
    }
  });

  it("exports the graph as deterministic JSON-LD with provenance", async () => {
    const r = (await tool(c, AdminTools.exportGraph)).body;
    assert.equal(r.file, ".brain/graph/graph.jsonld");
    assert.equal(r.nodes, 5 + 6);
    assert.equal(r.edges, 5);
    const first = readFileSync(p("graph/graph.jsonld"), "utf8");
    await tool(c, AdminTools.exportGraph);
    assert.equal(readFileSync(p("graph/graph.jsonld"), "utf8"), first, "same input, same bytes");

    const doc = JSON.parse(first);
    assert.equal(doc["@context"]["@vocab"], "https://app-brain.dev/ns#");
    const graph = doc["@graph"];
    const file = graph.find((n: any) => n.id === "brain:files/src/auth/session.ts");
    assert.equal(file.type, "File");
    assert.equal(file.partOf, "brain:modules/src/auth");
    assert.equal(file.docStatus, "stale");
    assert.equal(file.trust, "human-reviewed");
    assert.equal(graph.find((n: any) => n.id === "brain:modules/src/db").type, "Module");
    const dep = graph.find((n: any) => n.type === "Dependency" && n.from === "brain:files/src/http/login.ts");
    assert.deepEqual({ to: dep.to, kind: dep.kind, source: dep.source, confidence: dep.confidence }, { to: "brain:files/src/auth/session.ts", kind: "imports", source: "treesitter", confidence: "resolved" });
    assert.ok(!existsSync(p("graph/graph.jsonld.tmp")));
  });

  it("graph and overview calls from agents are in the usage log; the extension's own are not", async () => {
    assert.equal(((await readJson(c, Resources.usage)) as UsageSummary).total, 0, "brain-vscode is not an agent");
    const agent = await connect(ws, { clientName: "claude-code" });
    try {
      await ready(agent, 6);
      await tool(agent, AgentTools.getGraph, {});
      await tool(agent, AgentTools.getOverview, { path: "src/auth/session.ts" });
      const u = (await readJson(agent, Resources.usage)) as UsageSummary;
      assert.equal(u.byTool.get_graph, 1);
      assert.equal(u.byTool.get_overview, 1);
    } finally { await agent.close(); }
  });
});
