import * as path from "node:path";
import type { DocStatus, Graph, GraphEdge, GraphLevel, GraphNode, TrustTier } from "@app-brain/brain-protocol";
import type { BrainStore } from "../store";
import { cycles as findCycles } from "./format";

export interface DocInfo {
  status: DocStatus;
  trust: TrustTier | null;
}
/** Keyed `file:<path>` or `module:<dir>`. Missing means no doc. */
export type DocIndex = Map<string, DocInfo>;

const NO_DOC: DocInfo = { status: "none", trust: null };
const dirOf = (p: string) => path.posix.dirname(p);
const below = (p: string, dir: string) => dir === "." || p === dir || p.startsWith(dir + "/");

export interface GraphArgs {
  level: GraphLevel;
  /** A file or directory to centre the graph on. */
  root?: string;
  /** Hops to expand beyond the root. */
  depth: number;
  /** Most nodes returned; the most connected are kept. */
  limit: number;
}

/** Keeps the `limit` best-connected ids, preferring to keep the seeds. */
function cap(ids: Set<string>, limit: number, degree: (id: string) => number, seeds: Set<string>): { kept: Set<string>; truncated: boolean } {
  if (ids.size <= limit) return { kept: ids, truncated: false };
  const ranked = [...ids].sort((a, b) => Number(seeds.has(b)) - Number(seeds.has(a)) || degree(b) - degree(a) || a.localeCompare(b));
  return { kept: new Set(ranked.slice(0, limit)), truncated: true };
}

/** Breadth-first expansion over an undirected view of the edges. */
function expand(seeds: Set<string>, adjacency: Map<string, Set<string>>, hops: number): Set<string> {
  const seen = new Set(seeds);
  let frontier = [...seeds];
  for (let i = 0; i < hops && frontier.length; i++) {
    const next: string[] = [];
    for (const id of frontier) for (const n of adjacency.get(id) ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); }
    frontier = next;
  }
  return seen;
}

function adjacencyOf(edges: { from: string; to: string }[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  for (const e of edges) { add(e.from, e.to); add(e.to, e.from); }
  return adj;
}

export function buildGraph(store: BrainStore, docs: DocIndex, args: GraphArgs): Graph {
  const files = store.graphFiles();
  const rawEdges = store.allEdges();
  const doc = (kind: "file" | "module", id: string) => docs.get(`${kind}:${id}`) ?? NO_DOC;
  const root = args.root && args.root !== "." ? path.posix.normalize(args.root.replace(/\\/g, "/").replace(/\/+$/, "")) : args.root === "." ? "." : undefined;
  if (root?.startsWith("..") || root?.startsWith("/")) throw new Error(`root must be a path inside the repository: ${args.root}`);

  if (args.level === "file") {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const adj = adjacencyOf(rawEdges);
    let seeds: Set<string>;
    if (root === undefined) seeds = new Set();
    else if (byPath.has(root)) seeds = new Set([root]);
    else {
      seeds = new Set(files.filter((f) => below(f.path, root)).map((f) => f.path));
      if (seeds.size === 0) throw new Error(`Nothing indexed at ${args.root}. Use a file or directory path relative to the workspace root.`);
    }
    const selected = root === undefined ? new Set(files.map((f) => f.path)) : expand(seeds, adj, args.depth);
    const degree = (id: string) => (byPath.get(id)?.imported_by ?? 0) + (byPath.get(id)?.imports ?? 0);
    const { kept, truncated } = cap(selected, args.limit, degree, seeds);
    const nodes: GraphNode[] = [...kept].sort().map((id) => {
      const f = byPath.get(id)!;
      const d = doc("file", id);
      return { id, kind: "file", files: 1, symbols: f.symbols, importedBy: f.imported_by, imports: f.imports, language: f.lang, doc: d.status, trust: d.trust };
    });
    const edges: GraphEdge[] = rawEdges
      .filter((e) => kept.has(e.from) && kept.has(e.to))
      .map((e) => ({ from: e.from, to: e.to, weight: 1, confidence: e.confidence as "resolved" | "guess", cycle: false }));
    // An edge is "circular" when it crosses between two modules that depend on each other.
    const { cycles, scc } = moduleCycles(files, rawEdges);
    for (const e of edges) {
      const a = scc.get(dirOf(e.from));
      e.cycle = a !== undefined && dirOf(e.from) !== dirOf(e.to) && a === scc.get(dirOf(e.to));
    }
    return { level: "file", root: root ?? null, nodes, edges, cycles, totals: { nodes: selected.size, edges: rawEdges.length }, truncated };
  }

  // ---- module level: one node per directory, edges aggregated across its files ----
  const { agg, cycles, scc } = moduleCycles(files, rawEdges);
  const mods = new Map<string, { files: number; symbols: number; langs: Map<string, number> }>();
  for (const f of files) {
    const m = mods.get(dirOf(f.path)) ?? mods.set(dirOf(f.path), { files: 0, symbols: 0, langs: new Map() }).get(dirOf(f.path))!;
    m.files++;
    m.symbols += f.symbols;
    m.langs.set(f.lang, (m.langs.get(f.lang) ?? 0) + 1);
  }
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const [key, a] of agg) {
    const [from, to] = key.split("\0");
    outDeg.set(from, (outDeg.get(from) ?? 0) + a.weight);
    inDeg.set(to, (inDeg.get(to) ?? 0) + a.weight);
  }
  const edgeList = [...agg.keys()].map((k) => { const [from, to] = k.split("\0"); return { from, to }; });
  let seeds = new Set<string>();
  if (root !== undefined) {
    seeds = new Set([...mods.keys()].filter((d) => below(d, root)));
    if (seeds.size === 0) throw new Error(`No module at ${args.root}. Modules are directories that contain source files.`);
  }
  const selected = root === undefined ? new Set(mods.keys()) : expand(seeds, adjacencyOf(edgeList), args.depth);
  const { kept, truncated } = cap(selected, args.limit, (id) => (inDeg.get(id) ?? 0) + (outDeg.get(id) ?? 0), seeds);
  const nodes: GraphNode[] = [...kept].sort().map((id) => {
    const m = mods.get(id)!;
    const d = doc("module", id);
    const lang = [...m.langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { id, kind: "module", files: m.files, symbols: m.symbols, importedBy: inDeg.get(id) ?? 0, imports: outDeg.get(id) ?? 0, language: lang, doc: d.status, trust: d.trust };
  });
  const edges: GraphEdge[] = [];
  for (const [key, a] of [...agg].sort((x, y) => x[0].localeCompare(y[0]))) {
    const [from, to] = key.split("\0");
    if (!kept.has(from) || !kept.has(to)) continue;
    edges.push({ from, to, weight: a.weight, confidence: a.guess === a.weight ? "guess" : "resolved", cycle: scc.get(from) !== undefined && scc.get(from) === scc.get(to) });
  }
  return { level: "module", root: root ?? null, nodes, edges, cycles, totals: { nodes: selected.size, edges: agg.size }, truncated };
}

/** Aggregates file edges into directory edges and finds circular dependencies among directories. */
function moduleCycles(files: { path: string }[], edges: { from: string; to: string; confidence: string }[]) {
  const known = new Set(files.map((f) => f.path));
  const agg = new Map<string, { weight: number; guess: number }>();
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const a = dirOf(e.from);
    const b = dirOf(e.to);
    if (a === b) continue;
    const key = `${a}\0${b}`;
    const cur = agg.get(key) ?? agg.set(key, { weight: 0, guess: 0 }).get(key)!;
    cur.weight++;
    if (e.confidence === "guess") cur.guess++;
  }
  const adj = new Map<string, string[]>();
  for (const key of agg.keys()) {
    const [from, to] = key.split("\0");
    (adj.get(from) ?? adj.set(from, []).get(from)!).push(to);
    if (!adj.has(to)) adj.set(to, []);
  }
  const cycles = findCycles(adj);
  const scc = new Map<string, number>();
  cycles.forEach((c, i) => c.forEach((m) => scc.set(m, i)));
  return { agg, cycles, scc };
}

// ---------------------------------------------------------------------------
// JSON-LD export: typed, linked data for tools that want it instead of Markdown.
// Derived and deterministic (sorted), so it diffs cleanly. Not a second source of truth.
// ---------------------------------------------------------------------------

const BRAIN = "https://app-brain.dev/ns#";

export function toJsonLd(store: BrainStore, docs: DocIndex): Record<string, unknown> {
  const files = store.graphFiles();
  const edges = store.allEdges();
  const dirs = [...new Set(files.map((f) => dirOf(f.path)))].sort();
  const fileId = (p: string) => `brain:files/${p}`;
  const modId = (d: string) => `brain:modules/${d === "." ? "_root" : d}`;
  const docProps = (kind: "file" | "module", id: string) => {
    const d = docs.get(`${kind}:${id}`) ?? NO_DOC;
    return { docStatus: d.status, ...(d.trust ? { trust: d.trust } : {}) };
  };
  return {
    "@context": {
      "@vocab": BRAIN,
      brain: BRAIN,
      id: "@id",
      type: "@type",
      from: { "@type": "@id" },
      to: { "@type": "@id" },
      partOf: { "@type": "@id" },
    },
    "@graph": [
      ...dirs.map((d) => ({ id: modId(d), type: "Module", path: d, ...docProps("module", d) })),
      ...files.map((f) => ({
        id: fileId(f.path), type: "File", path: f.path, language: f.lang, symbols: f.symbols,
        partOf: modId(dirOf(f.path)), ...docProps("file", f.path),
      })),
      ...edges.map((e) => ({
        type: "Dependency", kind: e.kind, from: fileId(e.from), to: fileId(e.to), source: e.source, confidence: e.confidence,
      })),
    ],
  };
}
