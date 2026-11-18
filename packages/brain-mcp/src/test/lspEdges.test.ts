import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BrainStore } from "../store";

const add = (s: BrainStore, p: string) => s.putFile({ path: p, lang: "typescript", size: 1, mtimeMs: 1, hash: p, parsed: true, hadErrors: false }, [], []);

function store() {
  const s = BrainStore.open(":memory:");
  for (const f of ["a.ts", "b.ts", "c.ts"]) add(s, f);
  s.replaceImportEdges([{ from: "a.ts", to: "b.ts", confidence: "resolved" }]);
  return s;
}

describe("edges a language server supplies", () => {
  it("are stored beside import edges, and a re-index leaves them alone", () => {
    const s = store();
    assert.deepEqual(s.replaceLspEdges("a.ts", [{ to: "c.ts", kind: "calls" }]), { stored: 1, skipped: [] });
    s.replaceImportEdges([{ from: "a.ts", to: "b.ts", confidence: "resolved" }]); // what a re-index does
    assert.deepEqual(s.neighbours("a.ts", "out").map((e) => [e.to, e.kind, e.source]), [["b.ts", "imports", "treesitter"], ["c.ts", "calls", "lsp"]]);
  });
  it("replace what the server said about that file before, and nothing else", () => {
    const s = store();
    s.replaceLspEdges("a.ts", [{ to: "c.ts", kind: "calls" }]);
    s.replaceLspEdges("b.ts", [{ to: "c.ts", kind: "extends" }]);
    s.replaceLspEdges("a.ts", []);
    assert.deepEqual(s.neighbours("c.ts", "in").map((e) => [e.from, e.kind]), [["b.ts", "extends"]]);
  });
  it("list a pair of files once, as the import when there is one, so counts do not double", () => {
    const s = store();
    s.replaceLspEdges("a.ts", [{ to: "b.ts", kind: "calls" }, { to: "c.ts", kind: "calls" }]);
    assert.deepEqual(s.neighbours("a.ts", "out").map((e) => [e.to, e.kind]), [["b.ts", "imports"], ["c.ts", "calls"]]);
    assert.equal(s.allEdges().length, 2);
    assert.equal(s.counts().edges, 2);
    const a = s.graphFiles().find((f) => f.path === "a.ts")!;
    const b = s.graphFiles().find((f) => f.path === "b.ts")!;
    assert.deepEqual([a.imports, b.imported_by], [2, 1]);
  });
  it("skip targets that are not indexed, ignore a file calling itself, and refuse an unknown source", () => {
    const s = store();
    assert.deepEqual(s.replaceLspEdges("a.ts", [{ to: "node_modules/x.ts", kind: "calls" }, { to: "a.ts", kind: "calls" }]), { stored: 0, skipped: ["node_modules/x.ts"] });
    assert.equal(s.replaceLspEdges("nope.ts", []), null);
  });
  it("are dropped when the file's code changes, because the editor says it again", () => {
    const s = store();
    s.replaceLspEdges("a.ts", [{ to: "c.ts", kind: "calls" }]);
    s.replaceLspEdges("c.ts", [{ to: "b.ts", kind: "calls" }]);
    add(s, "a.ts"); // a.ts was edited and parsed again
    assert.deepEqual(s.neighbours("a.ts", "out").map((e) => e.kind), ["imports"], "its language-server edges are gone; the import is recomputed by the indexer, not here");
    assert.deepEqual(s.neighbours("c.ts", "out").map((e) => e.to), ["b.ts"], "another file's edges stay");
  });
  it("go when a file is deleted", () => {
    const s = store();
    s.replaceLspEdges("a.ts", [{ to: "c.ts", kind: "calls" }]);
    s.removeFile("c.ts");
    assert.deepEqual(s.neighbours("a.ts", "out").map((e) => e.to), ["b.ts"]);
  });
});
