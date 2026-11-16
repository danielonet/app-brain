import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { SymbolKind, UsageEntry, UsageSummary } from "@app-brain/brain-protocol";
import type { ExtractedImport, ExtractedSymbol } from "./parse/types";

/** Bump when the schema changes. The database is a derived cache, so a mismatch rebuilds it. */
const SCHEMA_VERSION = 3;

export interface FileRow {
  id: number;
  path: string;
  lang: string;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
}

export interface SymbolHit {
  id: number;
  name: string;
  qualified_name: string;
  kind: SymbolKind;
  path: string;
  start_line: number;
  end_line: number;
  signature: string;
  docstring: string | null;
  body_hash: string;
  exported: number;
}

export interface LlmCallRow {
  id: number;
  ts: string;
  target: string;
  kind: string;
  provider: string | null;
  model: string;
  mode: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  tokens_source: "provider-reported" | "agent-reported" | "estimated";
  cost_usd: number | null;
  cost_source: string | null;
  outcome: string;
}

export interface EdgeRow {
  from: string;
  to: string;
  kind: string;
  source: string;
  confidence: string;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "or", "is", "how", "does", "do", "what", "where", "which"]);

/** `getUserByID` / `get_user_by_id` -> `get user by id`. */
export function splitWords(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const word of splitWords(query).split(" ")) {
    if (word && !STOPWORDS.has(word)) seen.add(word);
  }
  return [...seen];
}

type Row = Record<string, unknown>;

export class BrainStore {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync, readonly location: string) {
    this.db = db;
  }

  /** Opens (creating or rebuilding) the database. Use ":memory:" for no persistence. */
  static open(file: string): BrainStore {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    let db = new DatabaseSync(file);
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== 0 && version !== SCHEMA_VERSION) {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(file + suffix); } catch { /* absent */ }
      }
      db = new DatabaseSync(file);
    }
    const store = new BrainStore(db, file);
    store.migrate();
    return store;
  }

  private migrate() {
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file (
        id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT NOT NULL,
        size INTEGER NOT NULL, mtime_ms REAL NOT NULL, content_hash TEXT,
        parsed INTEGER NOT NULL DEFAULT 0, had_errors INTEGER NOT NULL DEFAULT 0, indexed_at TEXT);
      CREATE TABLE IF NOT EXISTS symbol (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
        name TEXT NOT NULL, qualified_name TEXT NOT NULL, kind TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT NOT NULL,
        docstring TEXT, body_hash TEXT NOT NULL, exported INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbol_name ON symbol(name);
      CREATE INDEX IF NOT EXISTS symbol_qname ON symbol(qualified_name);
      CREATE INDEX IF NOT EXISTS symbol_file ON symbol(file_id);
      CREATE TABLE IF NOT EXISTS import_ref (
        id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
        specifier TEXT NOT NULL, line INTEGER NOT NULL, names TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS import_file ON import_ref(file_id);
      CREATE TABLE IF NOT EXISTS edge (
        src_file INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
        dst_file INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, source TEXT NOT NULL, confidence TEXT NOT NULL,
        PRIMARY KEY (src_file, dst_file, kind));
      CREATE INDEX IF NOT EXISTS edge_dst ON edge(dst_file);
      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(
        words, qualified_name, signature, docstring, path, tokenize = 'porter unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS llm_call (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
        provider TEXT, model TEXT NOT NULL, mode TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        tokens_source TEXT NOT NULL, cost_usd REAL, cost_source TEXT, outcome TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS llm_call_target ON llm_call(target);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, result_tokens INTEGER NOT NULL, latency_ms REAL NOT NULL, is_error INTEGER NOT NULL);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Copies this database to `file` (VACUUM INTO), so an in-memory index can become the
   * on-disk cache without being rebuilt. Replaces any existing file.
   */
  persistTo(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(file + suffix); } catch { /* absent */ }
    }
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  close() {
    this.cache.clear();
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as unknown as T[];
  }
  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as unknown as T | undefined;
  }
  private run(sql: string, ...params: unknown[]) {
    return this.stmt(sql).run(...(params as never[]));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- files ---------------------------------------------------------------

  files(): Map<string, FileRow> {
    return new Map(this.all<FileRow>("SELECT id, path, lang, size, mtime_ms, content_hash FROM file").map((f) => [f.path, f]));
  }

  touchFile(id: number, size: number, mtimeMs: number) {
    this.run("UPDATE file SET size = ?, mtime_ms = ? WHERE id = ?", size, mtimeMs, id);
  }

  /** Inserts or replaces a file and all of its symbols and import references. */
  putFile(
    f: { path: string; lang: string; size: number; mtimeMs: number; hash: string | null; parsed: boolean; hadErrors: boolean },
    symbols: ExtractedSymbol[],
    imports: ExtractedImport[],
  ): number {
    const existing = this.get<{ id: number }>("SELECT id FROM file WHERE path = ?", f.path);
    if (existing) this.clearFileContent(existing.id);
    const now = new Date().toISOString();
    let id: number;
    if (existing) {
      id = existing.id;
      this.run(
        "UPDATE file SET lang=?, size=?, mtime_ms=?, content_hash=?, parsed=?, had_errors=?, indexed_at=? WHERE id=?",
        f.lang, f.size, f.mtimeMs, f.hash, f.parsed ? 1 : 0, f.hadErrors ? 1 : 0, now, id,
      );
    } else {
      id = Number(
        this.run(
          "INSERT INTO file (path, lang, size, mtime_ms, content_hash, parsed, had_errors, indexed_at) VALUES (?,?,?,?,?,?,?,?)",
          f.path, f.lang, f.size, f.mtimeMs, f.hash, f.parsed ? 1 : 0, f.hadErrors ? 1 : 0, now,
        ).lastInsertRowid,
      );
    }
    for (const s of symbols) {
      const symId = Number(
        this.run(
          `INSERT INTO symbol (file_id, name, qualified_name, kind, start_line, end_line, signature, docstring, body_hash, exported)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          id, s.name, s.qualifiedName, s.kind, s.startLine, s.endLine, s.signature, s.docstring, s.bodyHash, s.exported ? 1 : 0,
        ).lastInsertRowid,
      );
      this.run(
        "INSERT INTO symbol_fts (rowid, words, qualified_name, signature, docstring, path) VALUES (?,?,?,?,?,?)",
        symId, splitWords(s.qualifiedName), s.qualifiedName, s.signature, s.docstring ?? "", f.path,
      );
    }
    for (const i of imports) {
      this.run("INSERT INTO import_ref (file_id, specifier, line, names) VALUES (?,?,?,?)", id, i.specifier, i.line, JSON.stringify(i.names));
    }
    return id;
  }

  private clearFileContent(fileId: number) {
    this.run("DELETE FROM symbol_fts WHERE rowid IN (SELECT id FROM symbol WHERE file_id = ?)", fileId);
    this.run("DELETE FROM symbol WHERE file_id = ?", fileId);
    this.run("DELETE FROM import_ref WHERE file_id = ?", fileId);
  }

  removeFile(filePath: string) {
    const row = this.get<{ id: number }>("SELECT id FROM file WHERE path = ?", filePath);
    if (!row) return;
    this.clearFileContent(row.id);
    this.run("DELETE FROM file WHERE id = ?", row.id); // edges cascade
  }

  // ---- edges ---------------------------------------------------------------

  importRefs(): { file_id: number; path: string; lang: string; specifier: string; line: number; names: string }[] {
    return this.all(
      "SELECT i.file_id, f.path, f.lang, i.specifier, i.line, i.names FROM import_ref i JOIN file f ON f.id = i.file_id ORDER BY f.path, i.line",
    );
  }

  replaceImportEdges(edges: { from: string; to: string; confidence: string }[]) {
    this.transaction(() => {
      this.run("DELETE FROM edge WHERE kind = 'imports'");
      for (const e of edges) {
        this.run(
          `INSERT OR IGNORE INTO edge (src_file, dst_file, kind, source, confidence)
           SELECT a.id, b.id, 'imports', 'treesitter', ? FROM file a, file b WHERE a.path = ? AND b.path = ?`,
          e.confidence, e.from, e.to,
        );
      }
    });
  }

  /** Files one hop away. `out` = what the file imports, `in` = what imports it. */
  neighbours(filePath: string, direction: "in" | "out"): EdgeRow[] {
    const sql =
      direction === "out"
        ? `SELECT a.path AS "from", b.path AS "to", e.kind, e.source, e.confidence FROM edge e
           JOIN file a ON a.id = e.src_file JOIN file b ON b.id = e.dst_file WHERE a.path = ? ORDER BY b.path`
        : `SELECT a.path AS "from", b.path AS "to", e.kind, e.source, e.confidence FROM edge e
           JOIN file a ON a.id = e.src_file JOIN file b ON b.id = e.dst_file WHERE b.path = ? ORDER BY a.path`;
    return this.all<EdgeRow>(sql, filePath);
  }

  hasFile(filePath: string): boolean {
    return this.get("SELECT 1 AS x FROM file WHERE path = ?", filePath) !== undefined;
  }

  // ---- symbols ---------------------------------------------------------------

  private static readonly SYMBOL_COLUMNS = `s.id, s.name, s.qualified_name, s.kind, f.path, s.start_line, s.end_line,
    s.signature, s.docstring, s.body_hash, s.exported`;

  search(query: string, opts: { kind?: SymbolKind; limit: number; offset: number }): { total: number; hits: SymbolHit[] } {
    const tokens = queryTokens(query);
    if (tokens.length === 0) return { total: 0, hits: [] };
    const phrase = (t: string) => `"${t.replace(/"/g, '""')}"*`;
    const kindSql = opts.kind ? "AND s.kind = ?" : "";
    const kindArgs = opts.kind ? [opts.kind] : [];

    for (const joiner of [" AND ", " OR "]) {
      const match = tokens.map(phrase).join(joiner);
      const total = this.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM symbol_fts JOIN symbol s ON s.id = symbol_fts.rowid WHERE symbol_fts MATCH ? ${kindSql}`,
        match, ...kindArgs,
      )!.n;
      if (total === 0) continue;
      const hits = this.all<SymbolHit>(
        `SELECT ${BrainStore.SYMBOL_COLUMNS} FROM symbol_fts
         JOIN symbol s ON s.id = symbol_fts.rowid JOIN file f ON f.id = s.file_id
         WHERE symbol_fts MATCH ? ${kindSql}
         ORDER BY (lower(s.name) = lower(?) OR lower(s.qualified_name) = lower(?)) DESC,
                  bm25(symbol_fts, 10, 8, 3, 2, 1)
         LIMIT ? OFFSET ?`,
        match, ...kindArgs, query.trim(), query.trim(), opts.limit, opts.offset,
      );
      return { total, hits };
    }
    return { total: 0, hits: [] };
  }

  /** Exact lookup by qualified name, then by plain name. */
  symbolsNamed(name: string, filePath?: string): SymbolHit[] {
    const pathSql = filePath ? "AND f.path = ?" : "";
    const args = filePath ? [filePath] : [];
    for (const column of ["s.qualified_name", "s.name"]) {
      const hits = this.all<SymbolHit>(
        `SELECT ${BrainStore.SYMBOL_COLUMNS} FROM symbol s JOIN file f ON f.id = s.file_id
         WHERE ${column} = ? ${pathSql} ORDER BY s.exported DESC, f.path, s.start_line LIMIT 10`,
        name, ...args,
      );
      if (hits.length) return hits;
    }
    return [];
  }

  // ---- counters --------------------------------------------------------------

  counts(): { files: number; symbols: number; edges: number; byLanguage: Record<string, number>; lastIndexedAt: string | null } {
    const n = (sql: string) => this.get<{ n: number }>(sql)!.n;
    const byLanguage: Record<string, number> = {};
    for (const r of this.all<{ lang: string; n: number }>("SELECT lang, COUNT(*) AS n FROM file GROUP BY lang")) byLanguage[r.lang] = r.n;
    return {
      files: n("SELECT COUNT(*) AS n FROM file"),
      symbols: n("SELECT COUNT(*) AS n FROM symbol"),
      edges: n("SELECT COUNT(*) AS n FROM edge"),
      byLanguage,
      lastIndexedAt: this.get<{ t: string | null }>("SELECT MAX(indexed_at) AS t FROM file")?.t ?? null,
    };
  }

  // ---- documentation targets -------------------------------------------------

  /** Parsed files with what ranks them for documentation: how many files import them. */
  docFiles(): { path: string; content_hash: string; symbols: number; imported_by: number; imports: number }[] {
    return this.all(
      `SELECT f.path, f.content_hash,
              (SELECT COUNT(*) FROM symbol s WHERE s.file_id = f.id) AS symbols,
              (SELECT COUNT(*) FROM edge e WHERE e.dst_file = f.id) AS imported_by,
              (SELECT COUNT(*) FROM edge e WHERE e.src_file = f.id) AS imports
       FROM file f WHERE f.parsed = 1 AND f.content_hash IS NOT NULL ORDER BY f.path`,
    );
  }

  /** Every parsed file, with import counts, for the dependency graph. */
  graphFiles(): { path: string; lang: string; symbols: number; imported_by: number; imports: number }[] {
    return this.all(
      `SELECT f.path, f.lang,
              (SELECT COUNT(*) FROM symbol s WHERE s.file_id = f.id) AS symbols,
              (SELECT COUNT(*) FROM edge e WHERE e.dst_file = f.id) AS imported_by,
              (SELECT COUNT(*) FROM edge e WHERE e.src_file = f.id) AS imports
       FROM file f WHERE f.parsed = 1 ORDER BY f.path`,
    );
  }

  allEdges(): EdgeRow[] {
    return this.all<EdgeRow>(
      `SELECT a.path AS "from", b.path AS "to", e.kind, e.source, e.confidence FROM edge e
       JOIN file a ON a.id = e.src_file JOIN file b ON b.id = e.dst_file ORDER BY a.path, b.path`,
    );
  }

  fileHash(filePath: string): string | null {
    return this.get<{ content_hash: string | null }>("SELECT content_hash FROM file WHERE path = ?", filePath)?.content_hash ?? null;
  }

  /** Parsed files at or below `dir` ("" means the whole repo). */
  filesUnder(dir: string): { path: string; content_hash: string }[] {
    const rows = this.all<{ path: string; content_hash: string }>(
      "SELECT path, content_hash FROM file WHERE parsed = 1 AND content_hash IS NOT NULL ORDER BY path",
    );
    if (!dir) return rows;
    return rows.filter((r) => r.path.startsWith(dir + "/"));
  }

  symbolsInFile(filePath: string, limit: number): { qualified_name: string; kind: string; exported: number }[] {
    return this.all(
      `SELECT s.qualified_name, s.kind, s.exported FROM symbol s JOIN file f ON f.id = s.file_id
       WHERE f.path = ? ORDER BY s.exported DESC, s.start_line LIMIT ?`,
      filePath, limit,
    );
  }

  // ---- LLM calls (PLAN-VSCODE-EXTENSION.md §4.3) -----------------------------

  logLlmCall(c: {
    target: string; kind: string; provider: string | null; model: string; mode: string;
    inputTokens: number | null; outputTokens: number | null; cachedTokens?: number | null;
    tokensSource: "provider-reported" | "agent-reported" | "estimated";
    costUsd: number | null; costSource: "price-table" | null; outcome: string;
  }) {
    this.run(
      `INSERT INTO llm_call (ts, target, kind, provider, model, mode, input_tokens, output_tokens, cached_tokens, tokens_source, cost_usd, cost_source, outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      new Date().toISOString(), c.target, c.kind, c.provider, c.model, c.mode, c.inputTokens, c.outputTokens,
      c.cachedTokens ?? null, c.tokensSource, c.costUsd, c.costSource, c.outcome,
    );
  }

  /** Marks the most recent call for a target (approved / rejected). */
  setLlmOutcome(target: string, outcome: string) {
    this.run("UPDATE llm_call SET outcome = ? WHERE id = (SELECT MAX(id) FROM llm_call WHERE target = ? AND outcome = 'generated')", outcome, target);
  }

  llmCallRows(): LlmCallRow[] {
    return this.all<LlmCallRow>("SELECT * FROM llm_call ORDER BY id");
  }

  // ---- usage log (PLAN-VSCODE-EXTENSION.md §4.4, level 1) ----------------------

  logUsage(e: { client: string; tool: string; args: string; resultTokens: number; latencyMs: number; isError: boolean }) {
    this.run(
      "INSERT INTO usage (ts, client, tool, args, result_tokens, latency_ms, is_error) VALUES (?,?,?,?,?,?,?)",
      new Date().toISOString(), e.client, e.tool, e.args.slice(0, 500), e.resultTokens, e.latencyMs, e.isError ? 1 : 0,
    );
  }

  pruneUsage(days: number) {
    this.run("DELETE FROM usage WHERE ts < ?", new Date(Date.now() - days * 86_400_000).toISOString());
  }

  usageSummary(recent = 50): UsageSummary {
    const group = (col: string) => {
      const out: Record<string, number> = {};
      for (const r of this.all<{ k: string; n: number }>(`SELECT ${col} AS k, COUNT(*) AS n FROM usage GROUP BY ${col}`)) out[r.k] = r.n;
      return out;
    };
    const rows = this.all<Row>("SELECT * FROM usage ORDER BY id DESC LIMIT ?", recent);
    const entries: UsageEntry[] = rows.map((r) => ({
      id: Number(r.id), ts: String(r.ts), client: String(r.client), tool: String(r.tool), args: String(r.args),
      resultTokens: Number(r.result_tokens), latencyMs: Number(r.latency_ms), isError: Boolean(r.is_error),
    }));
    return {
      total: this.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage")!.n,
      byClient: group("client"),
      byTool: group("tool"),
      recent: entries,
    };
  }
}
