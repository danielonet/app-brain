import * as path from "node:path";
import { Language, Parser, type Node, type Tree } from "@vscode/tree-sitter-wasm";

/** Languages that have a grammar. Others are inventoried but not parsed. */
export type ParsedLanguage = "typescript" | "tsx" | "javascript" | "python";

const GRAMMAR: Record<ParsedLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
};

const WASM_DIR = path.dirname(require.resolve("@vscode/tree-sitter-wasm"));

let initialised: Promise<void> | null = null;
const languages = new Map<ParsedLanguage, Promise<Language>>();
const parsers = new Map<ParsedLanguage, Parser>();

/** Maps a file path to a grammar, or null when we do not parse it. */
export function grammarFor(relPath: string): ParsedLanguage | null {
  switch (path.extname(relPath).toLowerCase()) {
    case ".ts": case ".mts": case ".cts": return "typescript";
    case ".tsx": return "tsx";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "javascript";
    case ".py": return "python";
    default: return null;
  }
}

/** The family used for symbol extraction and import resolution. */
export function familyOf(lang: ParsedLanguage): "ts" | "python" {
  return lang === "python" ? "python" : "ts";
}

async function parserFor(lang: ParsedLanguage): Promise<Parser> {
  initialised ??= Parser.init({ locateFile: (file: string) => path.join(WASM_DIR, file) });
  await initialised;
  let loading = languages.get(lang);
  if (!loading) {
    loading = Language.load(path.join(WASM_DIR, GRAMMAR[lang]));
    languages.set(lang, loading);
  }
  let parser = parsers.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(await loading);
    parsers.set(lang, parser);
  }
  return parser;
}

/**
 * Parses source text. tree-sitter is error tolerant, so half-written code still
 * yields a tree. The caller must call `tree.delete()` when done.
 */
export async function parse(lang: ParsedLanguage, source: string): Promise<Tree> {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${lang} source`);
  return tree;
}

export type { Node, Tree };
