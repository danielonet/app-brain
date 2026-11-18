import { strict as assert } from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { PutEdgesInput } from "@app-brain/brain-protocol";
import { EdgeBridge, SaveScheduler, relativeInside, type CodeSymbol, type LanguageFacts } from "../lspBridge";

const root = path.resolve("/work/repo");
const abs = (r: string) => path.join(root, r);
const fn: CodeSymbol = { kind: "callable", line: 1, character: 0 };
const cls: CodeSymbol = { kind: "type", line: 5, character: 0 };

function setup(facts: Partial<LanguageFacts>, put: (i: PutEdgesInput) => Promise<{ stored: number; skipped: string[] }> = async (i) => ({ stored: i.edges.length, skipped: [] })) {
  const sent: PutEdgesInput[] = [];
  const bridge = new EdgeBridge(root, { symbols: async () => [], callees: async () => [], supertypes: async () => [], ...facts }, { putEdges: async (i) => { sent.push(i); return put(i); } });
  return { bridge, sent };
}

describe("which files a link may point at", () => {
  it("keeps files inside the workspace as relative paths, and drops the rest", () => {
    assert.equal(relativeInside(root, abs("src/a.ts")), "src/a.ts");
    assert.equal(relativeInside(root, path.resolve("/work/other/x.ts")), null);
    assert.equal(relativeInside(root, root), null);
    assert.equal(relativeInside(root, abs("node_modules/lib/index.js")), null, "a dependency is not part of this code");
    assert.equal(relativeInside(root, abs("dist/a.js")), null);
  });
});

describe("the language-server bridge", () => {
  it("turns calls and supertypes into one link per target and kind, sorted, never to itself", async () => {
    const { bridge, sent } = setup({
      symbols: async () => [fn, fn, cls],
      callees: async () => [abs("src/b.ts"), abs("src/a.ts"), abs("node_modules/x/i.js"), path.resolve("/elsewhere/y.ts")],
      supertypes: async () => [abs("src/base.ts")],
    });
    assert.deepEqual(await bridge.analyse("src/a.ts"), { state: "sent", edges: 2, skipped: 0 });
    assert.deepEqual(sent, [{ from: "src/a.ts", edges: [{ to: "src/b.ts", kind: "calls" }, { to: "src/base.ts", kind: "extends" }] }]);
  });
  it("sends nothing when the language server has no symbols: it may not be ready, and old links must stay", async () => {
    const { bridge, sent } = setup({ symbols: async () => [] });
    assert.equal((await bridge.analyse("src/a.ts")).state, "no-symbols");
    assert.equal(sent.length, 0);
  });
  it("sends an empty list when symbols exist but nothing links anywhere, so stale links are cleared", async () => {
    const { bridge, sent } = setup({ symbols: async () => [fn] });
    await bridge.analyse("src/a.ts");
    assert.deepEqual(sent, [{ from: "src/a.ts", edges: [] }]);
  });
  it("survives a provider that throws for one symbol", async () => {
    let n = 0;
    const { bridge, sent } = setup({ symbols: async () => [fn, fn], callees: async () => { if (n++ === 0) throw new Error("server crashed"); return [abs("src/b.ts")]; } });
    assert.equal((await bridge.analyse("src/a.ts")).edges, 1);
    assert.equal(sent.length, 1);
  });
  it("asks about at most maxSymbols symbols in a file", async () => {
    let asked = 0;
    const bridge = new EdgeBridge(root, { symbols: async () => Array.from({ length: 500 }, () => fn), callees: async () => { asked++; return []; }, supertypes: async () => [] }, { putEdges: async () => ({ stored: 0, skipped: [] }) }, { maxSymbols: 10 });
    await bridge.analyse("src/a.ts");
    assert.equal(asked, 10);
  });
  it("reports a file the server does not know as not indexed, rather than failing", async () => {
    const { bridge } = setup({ symbols: async () => [fn] }, async () => { throw new Error("not an indexed file"); });
    assert.equal((await bridge.analyse("src/new.ts")).state, "not-indexed");
  });
  it("goes through many files in order and stops when asked", async () => {
    const order: string[] = [];
    const { bridge } = setup({ symbols: async (f) => { order.push(path.relative(root, f)); return [fn]; } });
    let stop = false;
    const r = await bridge.analyseMany(["a.ts", "b.ts", "c.ts", "d.ts"], (done) => { if (done === 2) stop = true; }, () => stop);
    assert.deepEqual(order, ["a.ts", "b.ts"]);
    assert.equal(r.sent, 2);
  });
});

describe("after a save", () => {
  it("waits for the saving to stop, then runs once per file, one at a time", async () => {
    const ran: string[] = [];
    const s = new SaveScheduler(async (rel) => { ran.push(rel); }, 20);
    s.schedule("a.ts"); s.schedule("a.ts"); s.schedule("a.ts"); s.schedule("b.ts");
    assert.equal(s.pending, 2);
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(ran.sort(), ["a.ts", "b.ts"]);
    s.dispose();
  });
  it("does nothing once disposed", async () => {
    const ran: string[] = [];
    const s = new SaveScheduler(async (rel) => { ran.push(rel); }, 20);
    s.schedule("a.ts"); s.dispose();
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(ran, []);
  });
});
