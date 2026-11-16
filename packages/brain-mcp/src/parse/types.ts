import type { SymbolKind } from "@app-brain/brain-protocol";

export interface ExtractedSymbol {
  name: string;
  /** `Class.method` for members, otherwise the plain name. File-local. */
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number; // 1-based, inclusive
  endLine: number;
  signature: string;
  docstring: string | null;
  /** Hash of the whitespace-normalised source of the symbol. Drives staleness later. */
  bodyHash: string;
  exported: boolean;
}

export interface ExtractedImport {
  /** The module specifier as written: `./a`, `react`, `.pkg.mod`, `os.path`. */
  specifier: string;
  line: number;
  /** For Python `from pkg import a, b`: the imported names, which may be submodules. */
  names: string[];
}

export interface ExtractResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  /** True when tree-sitter reported syntax errors (the result is best effort). */
  hadErrors: boolean;
}
