import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GraphLevel } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { graphHtml } from "./graphHtml";

interface LoadArgs {
  level: GraphLevel;
  root: string | null;
  depth: number;
}

/**
 * The dependency graph view. All data comes from the server's `get_graph`; this class only
 * relays it to the webview and opens files. Nothing about the code is computed here.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private last: LoadArgs = { level: "module", root: null, depth: 1 };

  static show(extensionUri: vscode.Uri, getClient: () => BrainClient | undefined, workspaceRoot: string) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("brain.graph", "Brain: Dependency Graph", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    GraphPanel.current = new GraphPanel(panel, extensionUri, getClient, workspaceRoot);
  }

  /** Called when the index or docs changed, so an open graph does not go stale. */
  static refreshIfOpen() {
    void GraphPanel.current?.load(GraphPanel.current.last);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly getClient: () => BrainClient | undefined,
    private readonly workspaceRoot: string,
  ) {
    const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f)).toString();
    panel.webview.html = graphHtml({
      nonce: randomBytes(16).toString("base64"),
      cspSource: panel.webview.cspSource,
      scriptUri: media("graph.js"),
      styleUri: media("graph.css"),
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => {
        GraphPanel.current = undefined;
        for (const d of this.disposables) d.dispose();
      }),
    );
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async load(args: LoadArgs) {
    this.last = args;
    const client = this.getClient();
    if (!client) {
      this.post({ type: "error", message: "The brain server is not running. Use “Brain: Start Server”." });
      return;
    }
    try {
      const graph = await client.getGraph({ level: args.level, root: args.root, depth: args.depth });
      this.post({ type: "graph", graph, depth: args.depth });
    } catch (e) {
      this.post({ type: "error", message: `Could not load the graph: ${(e as Error).message}` });
    }
  }

  private async onMessage(m: { type?: string; level?: GraphLevel; root?: string | null; depth?: number; path?: string }) {
    switch (m?.type) {
      case "ready":
        return this.load(this.last);
      case "refresh":
        return this.load(this.last);
      case "load":
        return this.load({
          level: m.level === "file" ? "file" : "module",
          root: typeof m.root === "string" ? m.root : null,
          depth: Number.isInteger(m.depth) ? Math.max(0, Math.min(3, m.depth as number)) : 1,
        });
      case "open": {
        // The path came from the server's graph, but never trust a webview: keep it inside the workspace.
        if (typeof m.path !== "string") return;
        const abs = path.resolve(this.workspaceRoot, m.path);
        if (!abs.startsWith(path.resolve(this.workspaceRoot) + path.sep)) return;
        await vscode.window.showTextDocument(vscode.Uri.file(abs), { viewColumn: vscode.ViewColumn.Beside });
      }
    }
  }
}
