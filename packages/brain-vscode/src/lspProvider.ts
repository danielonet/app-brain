import * as vscode from "vscode";
import type { CodeSymbol, LanguageFacts } from "./lspBridge";

const CALLABLE = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
const TYPE = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Struct]);

/** VS Code's own language-provider commands: whatever language server the person has installed answers, or nothing does. */
export const editorLanguageFacts: LanguageFacts = {
  async symbols(file) {
    const uri = vscode.Uri.file(file);
    const found = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", uri);
    const out: CodeSymbol[] = [];
    const visit = (s: vscode.DocumentSymbol | vscode.SymbolInformation) => {
      const pos = "selectionRange" in s ? s.selectionRange.start : s.location.range.start;
      if (CALLABLE.has(s.kind)) out.push({ kind: "callable", line: pos.line, character: pos.character });
      else if (TYPE.has(s.kind)) out.push({ kind: "type", line: pos.line, character: pos.character });
      if ("children" in s) s.children.forEach(visit);
    };
    (found ?? []).forEach(visit);
    return out;
  },

  async callees(file, sym) {
    const uri = vscode.Uri.file(file);
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", uri, new vscode.Position(sym.line, sym.character));
    const files = new Set<string>();
    for (const item of items ?? []) {
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", item);
      for (const c of calls ?? []) if (c.to.uri.scheme === "file") files.add(c.to.uri.fsPath);
    }
    return [...files];
  },

  async supertypes(file, sym) {
    const uri = vscode.Uri.file(file);
    const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.prepareTypeHierarchy", uri, new vscode.Position(sym.line, sym.character));
    const files = new Set<string>();
    for (const item of items ?? []) {
      const parents = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>("vscode.provideSupertypes", item);
      for (const p of parents ?? []) if (p.uri.scheme === "file") files.add(p.uri.fsPath);
    }
    return [...files];
  },
};
