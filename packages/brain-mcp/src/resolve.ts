import * as path from "node:path";
import type { ExtractedImport } from "./parse/types";

export interface ResolvedImport {
  to: string;
  confidence: "resolved" | "guess";
}

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/**
 * Turns import specifiers into repo files, using only file paths (no type
 * information). External packages and tsconfig path aliases are not resolved.
 */
export class ImportResolver {
  private readonly known: Set<string>;
  private pySuffixes: Map<string, string[]> | null = null;

  constructor(paths: Iterable<string>) {
    this.known = new Set(paths);
  }

  resolve(from: string, family: "ts" | "python", imp: ExtractedImport): ResolvedImport[] {
    const found = family === "python" ? this.python(from, imp) : this.typescript(from, imp);
    return found.filter((r) => r.to !== from);
  }

  // ---- TypeScript / JavaScript ------------------------------------------
  private typescript(from: string, imp: ExtractedImport): ResolvedImport[] {
    if (!imp.specifier.startsWith(".")) return [];
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), imp.specifier));
    const ext = path.posix.extname(base);
    const candidates: string[] = [];
    if (JS_TO_TS[ext]) {
      const stem = base.slice(0, -ext.length);
      for (const e of JS_TO_TS[ext]) candidates.push(stem + e);
    }
    candidates.push(base);
    for (const e of TS_EXTS) candidates.push(base + e);
    for (const e of TS_EXTS) candidates.push(`${base}/index${e}`);
    const hit = candidates.find((c) => this.known.has(c));
    return hit ? [{ to: hit, confidence: "resolved" }] : [];
  }

  // ---- Python -------------------------------------------------------------
  private suffixIndex(): Map<string, string[]> {
    if (this.pySuffixes) return this.pySuffixes;
    const index = new Map<string, string[]>();
    for (const p of this.known) {
      if (!p.endsWith(".py")) continue;
      const parts = p.split("/");
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join("/");
        const list = index.get(key);
        if (list) list.push(p);
        else index.set(key, [p]);
      }
    }
    return (this.pySuffixes = index);
  }

  private pyModule(dotted: string): string[] {
    const rel = dotted.replace(/\./g, "/");
    const idx = this.suffixIndex();
    return [...(idx.get(`${rel}.py`) ?? []), ...(idx.get(`${rel}/__init__.py`) ?? [])];
  }

  private python(from: string, imp: ExtractedImport): ResolvedImport[] {
    const out = new Map<string, ResolvedImport>();
    const add = (to: string, confidence: "resolved" | "guess") => {
      const prev = out.get(to);
      if (!prev || (prev.confidence === "guess" && confidence === "resolved")) out.set(to, { to, confidence });
    };
    const dots = imp.specifier.match(/^\.*/)![0].length;

    if (dots > 0) {
      // Relative: exact path arithmetic from the importing file's package.
      let dir = path.posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      if (dir === ".") dir = "";
      const rest = imp.specifier.slice(dots).replace(/\./g, "/");
      const mod = [dir, rest].filter(Boolean).join("/");
      const tryModule = (m: string): string | undefined =>
        [`${m}.py`, `${m}/__init__.py`].find((c) => this.known.has(c));
      if (rest) {
        const hit = tryModule(mod);
        if (hit) add(hit, "resolved");
      } else {
        const init = [dir, "__init__.py"].filter(Boolean).join("/");
        if (this.known.has(init)) add(init, "resolved");
      }
      for (const name of imp.names) {
        const hit = tryModule([mod, name].filter(Boolean).join("/"));
        if (hit) add(hit, "resolved");
      }
      return [...out.values()];
    }

    // Absolute: match by path suffix anywhere in the repo. A unique match is
    // reliable; several candidates are recorded as guesses.
    const hits = this.pyModule(imp.specifier);
    for (const h of hits) add(h, hits.length === 1 ? "resolved" : "guess");
    for (const name of imp.names) {
      const sub = this.pyModule(`${imp.specifier}.${name}`);
      for (const h of sub) add(h, sub.length === 1 ? "resolved" : "guess");
    }
    return [...out.values()];
  }
}
