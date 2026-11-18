import { createHash } from "node:crypto";
import type { EmbeddingStatus } from "@app-brain/brain-protocol";
import type { BrainStore, SymbolHit } from "../store";
import { EmbeddingError, OpenAiEmbeddings, unit } from "./provider";

const CHUNK = 64; // symbols embedded and saved at a time: progress is visible and a failure loses little
const MAX_TEXT = 1200;
export const RRF_K = 60;

/** What is embedded about a symbol: its name, signature and doc comment, and where it lives. Never its body. */
export function symbolText(s: { kind: string; qualified_name: string; signature: string; docstring: string | null; path: string }): string {
  return `${s.kind} ${s.qualified_name}\n${s.signature}\n${s.docstring ?? ""}\n${s.path}`.slice(0, MAX_TEXT);
}
const sha = (t: string) => createHash("sha1").update(t).digest("hex");

export interface EmbeddingConfig { model: string; baseUrl: string; apiKey?: string }

/**
 * Meaning-based search over symbols. Vectors are computed in the background after each index run, kept in the
 * database (so a restart does not recompute them) and compared by scanning memory: fast enough for a repository's
 * worth of symbols, and no extra service to run.
 */
export class EmbeddingService {
  private provider: OpenAiEmbeddings | null = null;
  private config: EmbeddingConfig | null = null;
  private status: EmbeddingStatus = { state: "off", model: null, endpoint: null, done: 0, total: 0, message: "Semantic search is off. Choose an embedding model to turn it on." };
  private syncing: Promise<void> | null = null;
  private again = false;
  private abort: AbortController | null = null;
  private matrix: { store: BrainStore; model: string; ids: number[]; dim: number; data: Float32Array } | null = null;

  constructor(private readonly store: () => BrainStore, private readonly onChange: () => void = () => {}) {}

  get current(): EmbeddingStatus { return this.status; }
  get ready(): boolean { return this.status.state === "ready" || (this.status.state === "building" && this.status.done > 0); }

  private set(patch: Partial<EmbeddingStatus>) { this.status = { ...this.status, ...patch }; this.onChange(); }

  /** Turns it on, off, or points it somewhere else. Returns at once; the work runs in the background. */
  configure(cfg: EmbeddingConfig | null): EmbeddingStatus {
    const same = cfg && this.config && cfg.model === this.config.model && cfg.baseUrl === this.config.baseUrl && cfg.apiKey === this.config.apiKey;
    if (same) return this.status;
    this.abort?.abort();
    this.matrix = null;
    this.config = cfg;
    if (!cfg || !cfg.model.trim()) {
      this.config = null;
      this.provider = null;
      this.set({ state: "off", model: null, endpoint: null, done: 0, total: 0, message: "Semantic search is off. Choose an embedding model to turn it on." });
      return this.status;
    }
    this.provider = new OpenAiEmbeddings({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
    this.set({ state: "building", model: cfg.model, endpoint: cfg.baseUrl, done: 0, total: 0, message: "Starting" });
    void this.sync();
    return this.status;
  }

  /** Embeds whatever has no vector yet. One run at a time: a request during a run asks for one more pass. */
  sync(): Promise<void> {
    if (!this.provider) return Promise.resolve();
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = this.run().finally(() => {
      this.syncing = null;
      if (this.again) { this.again = false; void this.sync(); }
    });
    return this.syncing;
  }

  private async run(): Promise<void> {
    const provider = this.provider, cfg = this.config;
    if (!provider || !cfg) return;
    const ctl = (this.abort = new AbortController());
    const store = this.store();
    try {
      let counts = store.vectorCounts(cfg.model);
      this.set({ state: "building", done: counts.have, total: counts.total, message: "Computing embeddings" });
      for (;;) {
        const todo = store.symbolsNeedingVectors(cfg.model, CHUNK);
        if (todo.length === 0) break;
        const rows: { symbolId: number; hash: string; vec: Float32Array }[] = [];
        const missing: { id: number; hash: string; text: string }[] = [];
        for (const s of todo) {
          const text = symbolText(s), hash = sha(text);
          const hit = store.cachedVector(hash, cfg.model);
          if (hit) rows.push({ symbolId: s.id, hash, vec: hit }); else missing.push({ id: s.id, hash, text });
        }
        if (missing.length) {
          const vecs = await provider.embed(missing.map((m) => m.text), ctl.signal);
          missing.forEach((m, i) => rows.push({ symbolId: m.id, hash: m.hash, vec: vecs[i] }));
        }
        if (ctl.signal.aborted) return;
        store.putVectors(cfg.model, rows);
        this.matrix = null;
        counts = store.vectorCounts(cfg.model);
        this.set({ done: counts.have, total: counts.total });
      }
      store.pruneVectors(cfg.model);
      this.set({ state: "ready", done: counts.have, total: counts.total, message: `${counts.have} symbols searchable by meaning.` });
    } catch (e) {
      if (ctl.signal.aborted) return; // replaced by a new configuration: that run reports
      this.set({ state: "error", message: e instanceof EmbeddingError ? e.message : `Embeddings failed: ${(e as Error).message}` });
    }
  }

  /** Symbol ids most similar in meaning to `query`, best first. Throws EmbeddingError if the endpoint cannot be reached. */
  async nearest(query: string, limit: number): Promise<{ id: number; score: number }[]> {
    const cfg = this.config, provider = this.provider;
    if (!cfg || !provider) return [];
    const store = this.store(); // the database can be replaced (after init), so a block loaded from the old one is not reused
    if (!this.matrix || this.matrix.model !== cfg.model || this.matrix.store !== store) this.matrix = { store, model: cfg.model, ...store.loadVectors(cfg.model) };
    const m = this.matrix;
    if (m.ids.length === 0) return [];
    const [q] = await provider.embed([query]);
    if (q.length !== m.dim) throw new EmbeddingError("The model returns vectors of a different size than the stored ones. Wait for the index to be rebuilt.", "bad_response");
    const scores = new Float32Array(m.ids.length);
    for (let i = 0; i < m.ids.length; i++) {
      let dot = 0;
      const o = i * m.dim;
      for (let j = 0; j < m.dim; j++) dot += q[j] * m.data[o + j];
      scores[i] = dot;
    }
    const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]).slice(0, limit);
    return order.map((i) => ({ id: m.ids[i], score: scores[i] }));
  }
}

export interface Searched {
  total: number;
  hits: SymbolHit[];
  /** How the hits were found. "keyword" with a note when meaning-based search was wanted but could not run. */
  mode: "keyword" | "semantic" | "hybrid";
  note?: string;
}

/**
 * Keyword and meaning, merged by reciprocal rank: a symbol that ranks well in either list comes up, and one that ranks well
 * in both comes first. Needs no score calibration between the two, which have different scales.
 */
export async function search(
  store: BrainStore, svc: EmbeddingService, query: string,
  opts: { kind?: SymbolHit["kind"]; limit: number; offset: number; mode: "auto" | "keyword" | "semantic" },
): Promise<Searched> {
  const keywordOnly = () => ({ ...store.search(query, opts), mode: "keyword" as const });
  if (opts.mode === "keyword") return keywordOnly();
  if (!svc.ready) {
    const r = keywordOnly();
    return opts.mode === "semantic" ? { ...r, note: `Semantic search is not ready (${svc.current.message}). These are keyword results.` } : r;
  }
  const DEPTH = 100;
  let near: { id: number; score: number }[];
  try { near = await svc.nearest(query, DEPTH * 2); } catch (e) {
    return { ...keywordOnly(), note: `Semantic search failed (${(e as Error).message}). These are keyword results.` };
  }
  const semantic = store.symbolsByIds(near.map((n) => n.id)).filter((h) => !opts.kind || h.kind === opts.kind).slice(0, DEPTH);
  if (opts.mode === "semantic") {
    return { total: semantic.length, hits: semantic.slice(opts.offset, opts.offset + opts.limit), mode: "semantic" };
  }
  const keyword = store.search(query, { kind: opts.kind, limit: DEPTH, offset: 0 }).hits;
  const score = new Map<number, number>();
  const by = new Map<number, SymbolHit>();
  for (const list of [keyword, semantic]) list.forEach((h, rank) => { by.set(h.id, h); score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + rank + 1)); });
  const fused = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => by.get(id)!);
  return { total: fused.length, hits: fused.slice(opts.offset, opts.offset + opts.limit), mode: "hybrid" };
}

export { unit };
