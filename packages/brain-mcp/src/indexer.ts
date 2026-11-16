import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ReindexResult } from "@app-brain/brain-protocol";
import { extract } from "./parse/extract";
import { familyOf, grammarFor } from "./parse/parser";
import { ImportResolver } from "./resolve";
import { scanWorkspace } from "./scan";
import type { BrainStore } from "./store";
import type { BrainWorkspace } from "./workspace";

const MAX_PARSE_BYTES = 1_000_000; // larger files are inventoried, not parsed

export interface IndexerHooks {
  onProgress?: (message: string) => void;
}

export class Indexer {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ws: BrainWorkspace,
    private store: BrainStore,
    private readonly hooks: IndexerHooks = {},
  ) {}

  /**
   * Swap the database (in-memory to the on-disk cache after `init`). Waits for any
   * run in progress, so nothing writes to the old store after this resolves.
   */
  swapStore(store: BrainStore): Promise<void> {
    const done = this.queue.then(() => {
      this.store = store;
    });
    this.queue = done.catch(() => {});
    return done;
  }

  /** Runs are serialised: a second request waits for the first. */
  run(): Promise<ReindexResult> {
    const next = this.queue.then(() => this.runOnce());
    this.queue = next.catch(() => {});
    return next;
  }

  private async runOnce(): Promise<ReindexResult> {
    const t0 = Date.now();
    const store = this.store;
    const config = await this.ws.readConfig();
    this.hooks.onProgress?.("Scanning files");
    const scanned = await scanWorkspace({ workspace: this.ws.root, include: config.include, exclude: config.exclude, languages: config.languages });
    const existing = store.files();
    const seen = new Set(scanned.map((f) => f.path));

    let changed = 0;
    let removed = 0;
    let sinceYield = 0;

    for (const gone of existing.keys()) {
      if (!seen.has(gone)) {
        store.removeFile(gone);
        removed++;
      }
    }

    for (const file of scanned) {
      const prev = existing.get(file.path);
      if (prev && prev.size === file.size && prev.mtime_ms === file.mtimeMs) continue;

      const grammar = grammarFor(file.path);
      const abs = path.join(this.ws.root, file.path);
      let hash: string | null = null;
      let source: string | null = null;
      if (grammar && file.size <= MAX_PARSE_BYTES) {
        try {
          source = await fs.readFile(abs, "utf8");
          hash = createHash("sha1").update(source).digest("hex");
        } catch {
          continue; // vanished between scan and read; the next run fixes it
        }
      }
      if (prev && hash && prev.content_hash === hash) {
        store.touchFile(prev.id, file.size, file.mtimeMs); // touched, not edited
        continue;
      }

      this.hooks.onProgress?.(`Indexing ${file.path}`);
      if (grammar && source !== null) {
        const result = await extract(grammar, source);
        store.transaction(() =>
          store.putFile({ ...file, lang: file.language, hash, parsed: true, hadErrors: result.hadErrors }, result.symbols, result.imports),
        );
      } else {
        store.transaction(() => store.putFile({ ...file, lang: file.language, hash, parsed: false, hadErrors: false }, [], []));
      }
      changed++;
      if (++sinceYield % 50 === 0) await new Promise((r) => setImmediate(r)); // keep the server responsive
    }

    if (changed > 0 || removed > 0 || store.counts().edges === 0) this.resolveEdges(store);

    const counts = store.counts();
    return {
      files: counts.files,
      symbols: counts.symbols,
      edges: counts.edges,
      changed,
      removed,
      byLanguage: counts.byLanguage,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Edges are recomputed from the stored import references after any change, because
   * adding or deleting one file can change what other files' imports resolve to.
   */
  private resolveEdges(store: BrainStore) {
    const refs = store.importRefs();
    const resolver = new ImportResolver(store.files().keys());
    const edges = new Map<string, { from: string; to: string; confidence: string }>();
    for (const r of refs) {
      const grammar = grammarFor(r.path);
      if (!grammar) continue;
      const family = familyOf(grammar);
      for (const hit of resolver.resolve(r.path, family, { specifier: r.specifier, line: r.line, names: JSON.parse(r.names) as string[] })) {
        const key = `${r.path}\0${hit.to}`;
        const prev = edges.get(key);
        if (!prev || (prev.confidence === "guess" && hit.confidence === "resolved")) edges.set(key, { from: r.path, to: hit.to, confidence: hit.confidence });
      }
    }
    store.replaceImportEdges([...edges.values()]);
  }
}
