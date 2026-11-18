import * as path from "node:path";
import { MAX_LSP_EDGES_PER_FILE, type LspEdgeKind, type PutEdgesInput, type PutEdgesResult } from "@app-brain/brain-protocol";

/** Pure (no `vscode` import) so the rules about what is sent, and what is not, are tested. */
export interface CodeSymbol {
  kind: "callable" | "type";
  /** Where the language server should be asked about it (0-based). */
  line: number;
  character: number;
}

/** What the editor's language servers can tell us. Files are absolute paths. A provider that fails returns nothing. */
export interface LanguageFacts {
  symbols(file: string): Promise<CodeSymbol[]>;
  /** Files the symbol calls into. */
  callees(file: string, symbol: CodeSymbol): Promise<string[]>;
  /** Files that declare what the type extends or implements. */
  supertypes(file: string, symbol: CodeSymbol): Promise<string[]>;
}

export interface EdgeSink {
  putEdges(input: PutEdgesInput): Promise<PutEdgesResult>;
}

export interface BridgeOptions {
  /** Most symbols asked about in one file. Each is a round trip to a language server, so this bounds the cost on big files. */
  maxSymbols?: number;
}

const SKIP = /(^|\/)(node_modules|\.git|\.brain|dist|out|build|vendor|__pycache__)\//;

/** The workspace-relative path of `abs`, or null when it is outside the workspace or somewhere not worth an edge. */
export function relativeInside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return SKIP.test(rel) ? null : rel;
}

export interface AnalyseResult {
  /** "sent": edges were stored. "no-symbols": the language server had nothing (not ready, or no server), so nothing was changed. */
  state: "sent" | "no-symbols" | "not-indexed" | "error";
  edges: number;
  skipped: number;
}

export class EdgeBridge {
  constructor(
    private readonly root: string,
    private readonly facts: LanguageFacts,
    private readonly sink: EdgeSink,
    private readonly opts: BridgeOptions = {},
  ) {}

  /**
   * Asks the language server what `rel`'s code calls and extends, and stores the answer.
   * An empty answer from the server is not "no edges": the server may not be ready, so the old edges stay.
   */
  async analyse(rel: string): Promise<AnalyseResult> {
    const abs = path.join(this.root, rel);
    let symbols: CodeSymbol[];
    try { symbols = await this.facts.symbols(abs); } catch { return { state: "error", edges: 0, skipped: 0 }; }
    if (symbols.length === 0) return { state: "no-symbols", edges: 0, skipped: 0 };

    const found = new Map<string, { to: string; kind: LspEdgeKind }>();
    for (const sym of symbols.slice(0, this.opts.maxSymbols ?? 60)) {
      const [files, kind] = sym.kind === "type" ? [await this.safe(() => this.facts.supertypes(abs, sym)), "extends" as const] : [await this.safe(() => this.facts.callees(abs, sym)), "calls" as const];
      for (const f of files) {
        const to = relativeInside(this.root, f);
        if (to && to !== rel) found.set(`${kind}\0${to}`, { to, kind });
      }
    }
    const edges = [...found.values()].sort((a, b) => a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)).slice(0, MAX_LSP_EDGES_PER_FILE);
    try {
      const r = await this.sink.putEdges({ from: rel, edges });
      return { state: "sent", edges: r.stored, skipped: r.skipped.length };
    } catch {
      return { state: "not-indexed", edges: 0, skipped: 0 }; // the server does not know this file (yet): the next save tries again
    }
  }

  private async safe(fn: () => Promise<string[]>): Promise<string[]> {
    try { return await fn(); } catch { return []; }
  }

  /** Many files, one at a time so the language servers are not flooded. Stops when `cancelled()` says so. */
  async analyseMany(rels: string[], onProgress?: (done: number, total: number) => void, cancelled: () => boolean = () => false): Promise<{ sent: number; edges: number; empty: number }> {
    let sent = 0, edges = 0, empty = 0;
    for (let i = 0; i < rels.length && !cancelled(); i++) {
      const r = await this.analyse(rels[i]);
      if (r.state === "sent") { sent++; edges += r.edges; } else if (r.state === "no-symbols") empty++;
      onProgress?.(i + 1, rels.length);
    }
    return { sent, edges, empty };
  }
}

/** Runs `analyse` for a file shortly after its last save, one at a time. */
export class SaveScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly run: (rel: string) => Promise<unknown>, private readonly delayMs = 1500) {}

  schedule(rel: string) {
    clearTimeout(this.timers.get(rel));
    this.timers.set(rel, setTimeout(() => {
      this.timers.delete(rel);
      this.chain = this.chain.then(() => this.run(rel)).catch(() => {});
    }, this.delayMs));
  }

  /** For tests and shutdown: what is queued. */
  get pending(): number { return this.timers.size; }

  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
