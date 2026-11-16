import { createHash } from "node:crypto";
import type { SymbolKind } from "@app-brain/brain-protocol";
import { ExtractResult, ExtractedImport, ExtractedSymbol } from "./types";
import { Node, ParsedLanguage, familyOf, parse } from "./parser";

const MAX_SIGNATURE = 300;
const MAX_DOC = 2000;

const hash = (s: string) => createHash("sha1").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
const nodes = (list: (Node | null)[]): Node[] => list.filter((n): n is Node => n !== null);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Source text from the start of `node` up to (not including) its body. */
function signatureOf(node: Node, source: string): string {
  const body = node.childForFieldName("body");
  const end = body ? body.startIndex : node.endIndex;
  let text = squash(source.slice(node.startIndex, end));
  text = text.replace(/[:{]\s*$/, "").trim(); // trailing `:` (Python) or `{`
  return clip(text, MAX_SIGNATURE);
}

function make(
  node: Node, source: string, name: string, prefix: string, kind: SymbolKind, exported: boolean,
  docstring: string | null, sigNode: Node = node,
): ExtractedSymbol {
  return {
    name,
    qualifiedName: prefix ? `${prefix}.${name}` : name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signatureOf(sigNode, source),
    docstring,
    bodyHash: hash(node.text),
    exported,
  };
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

function cleanComment(text: string): string {
  if (text.startsWith("/*")) {
    return text
      .replace(/^\/\*+\s?/, "")
      .replace(/\s*\*+\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\* ?/, ""))
      .join("\n")
      .trim();
  }
  return text.replace(/^\/\/\/?\s?/, "").trim();
}

/** Comments directly above `node` (no blank line between), as one docstring. */
function leadingComment(node: Node): string | null {
  const parts: string[] = [];
  let cursor = node;
  let prev = node.previousSibling;
  while (prev && prev.type === "comment" && cursor.startPosition.row - prev.endPosition.row <= 1) {
    parts.unshift(cleanComment(prev.text));
    cursor = prev;
    prev = prev.previousSibling;
  }
  const doc = parts.join("\n").trim();
  return doc ? clip(doc, MAX_DOC) : null;
}

const FUNCTION_VALUE = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

function tsMembers(cls: Node, source: string, className: string, out: ExtractedSymbol[], exported: boolean) {
  const body = cls.childForFieldName("body");
  if (!body) return;
  for (const m of nodes(body.namedChildren)) {
    const nameNode = m.childForFieldName("name");
    if (!nameNode) continue;
    const name = nameNode.text;
    if (m.type === "method_definition" || m.type === "abstract_method_signature") {
      out.push(make(m, source, name, className, "method", exported, leadingComment(m)));
    } else if (m.type === "public_field_definition" || m.type === "field_definition") {
      const value = m.childForFieldName("value");
      if (value && FUNCTION_VALUE.has(value.type)) out.push(make(m, source, name, className, "method", exported, leadingComment(m), value));
    }
  }
}

function tsDeclaration(node: Node, source: string, exported: boolean, doc: string | null, out: ExtractedSymbol[]) {
  const name = node.childForFieldName("name")?.text;
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature":
      if (name) out.push(make(node, source, name, "", "function", exported, doc));
      break;
    case "class_declaration":
    case "abstract_class_declaration":
      if (name) {
        out.push(make(node, source, name, "", "class", exported, doc));
        tsMembers(node, source, name, out, exported);
      }
      break;
    case "interface_declaration":
      if (name) out.push(make(node, source, name, "", "interface", exported, doc));
      break;
    case "type_alias_declaration":
      if (name) out.push(make(node, source, name, "", "type", exported, doc, node));
      break;
    case "enum_declaration":
      if (name) out.push(make(node, source, name, "", "enum", exported, doc));
      break;
    case "lexical_declaration":
    case "variable_declaration":
      for (const d of nodes(node.namedChildren)) {
        if (d.type !== "variable_declarator") continue;
        const n = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (!n || n.type !== "identifier") continue;
        if (value && FUNCTION_VALUE.has(value.type)) {
          out.push(make(node, source, n.text, "", "function", exported, doc, value));
        } else if (exported) {
          out.push(make(node, source, n.text, "", "variable", true, doc, d));
        }
      }
      break;
  }
}

function tsImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  for (const n of nodes(root.namedChildren)) {
    if (n.type !== "import_statement" && n.type !== "export_statement") continue;
    const src = n.childForFieldName("source");
    if (!src) continue; // `export const x` has no source
    out.push({ specifier: src.text.replace(/^['"`]|['"`]$/g, ""), line: n.startPosition.row + 1, names: [] });
  }
  return out;
}

function extractTs(root: Node, source: string): { symbols: ExtractedSymbol[]; imports: ExtractedImport[] } {
  const symbols: ExtractedSymbol[] = [];
  for (const n of nodes(root.namedChildren)) {
    if (n.type === "export_statement") {
      const decl = n.childForFieldName("declaration");
      if (decl) tsDeclaration(decl, source, true, leadingComment(n), symbols);
    } else {
      tsDeclaration(n, source, false, leadingComment(n), symbols);
    }
  }
  return { symbols, imports: tsImports(root) };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pyDocstring(def: Node): string | null {
  const body = def.childForFieldName("body");
  const first = body?.namedChildren[0];
  if (first?.type !== "expression_statement") return null;
  const str = first.namedChildren[0];
  if (str?.type !== "string") return null;
  const raw = str.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
  const lines = raw.split("\n");
  const indent = Math.min(
    ...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length),
    Infinity,
  );
  const dedented = [lines[0], ...lines.slice(1).map((l) => (Number.isFinite(indent) ? l.slice(indent) : l))].join("\n").trim();
  return dedented ? clip(dedented, MAX_DOC) : null;
}

function pyDefinition(node: Node, source: string, prefix: string, out: ExtractedSymbol[], decorated: Node | null) {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;
  const name = nameNode.text;
  const outer = decorated ?? node;
  const exported = !name.startsWith("_");
  if (node.type === "function_definition") {
    out.push({ ...make(outer, source, name, prefix, prefix ? "method" : "function", exported, pyDocstring(node), node) });
  } else {
    out.push({ ...make(outer, source, name, prefix, "class", exported, pyDocstring(node), node) });
    const body = node.childForFieldName("body");
    for (const m of nodes(body?.namedChildren ?? [])) pyMember(m, source, prefix ? `${prefix}.${name}` : name, out);
  }
}

function pyMember(n: Node, source: string, prefix: string, out: ExtractedSymbol[]) {
  if (n.type === "decorated_definition") {
    const def = n.childForFieldName("definition");
    if (def && (def.type === "function_definition" || def.type === "class_definition")) pyDefinition(def, source, prefix, out, n);
  } else if (n.type === "function_definition" || n.type === "class_definition") {
    pyDefinition(n, source, prefix, out, null);
  }
}

function dottedText(n: Node): string {
  return n.text.replace(/\s+/g, "");
}

function pyImports(root: Node): ExtractedImport[] {
  const out: ExtractedImport[] = [];
  const visit = (n: Node) => {
    if (n.type === "import_statement") {
      for (const c of nodes(n.namedChildren)) {
        const target = c.type === "aliased_import" ? c.childForFieldName("name") : c;
        if (target && target.type === "dotted_name") out.push({ specifier: dottedText(target), line: n.startPosition.row + 1, names: [] });
      }
    } else if (n.type === "import_from_statement") {
      const mod = n.childForFieldName("module_name");
      if (!mod) return;
      const names: string[] = [];
      for (const c of nodes(n.namedChildren)) {
        if (c.startIndex === mod.startIndex) continue;
        if (c.type === "dotted_name") names.push(dottedText(c));
        else if (c.type === "aliased_import") {
          const nm = c.childForFieldName("name");
          if (nm) names.push(dottedText(nm));
        }
      }
      out.push({ specifier: dottedText(mod), line: n.startPosition.row + 1, names });
    }
  };
  for (const n of nodes(root.namedChildren)) {
    visit(n);
    // imports inside `if TYPE_CHECKING:` / `try:` blocks at top level
    if (n.type === "if_statement" || n.type === "try_statement") {
      for (const d of nodes(n.descendantsOfType(["import_statement", "import_from_statement"]))) visit(d);
    }
  }
  return out;
}

function extractPython(root: Node, source: string): { symbols: ExtractedSymbol[]; imports: ExtractedImport[] } {
  const symbols: ExtractedSymbol[] = [];
  for (const n of nodes(root.namedChildren)) pyMember(n, source, "", symbols);
  return { symbols, imports: pyImports(root) };
}

// ---------------------------------------------------------------------------

export async function extract(lang: ParsedLanguage, source: string): Promise<ExtractResult> {
  const tree = await parse(lang, source);
  try {
    const root = tree.rootNode;
    const { symbols, imports } = familyOf(lang) === "python" ? extractPython(root, source) : extractTs(root, source);
    return { symbols, imports, hadErrors: root.hasError };
  } finally {
    tree.delete();
  }
}
