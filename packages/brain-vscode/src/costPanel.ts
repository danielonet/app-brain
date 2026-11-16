import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BrainClient } from "./client";
import { costHtml } from "./costHtml";

/** The cost report view. All numbers come from the server's `brain://cost/summary`; nothing is computed here. */
export class CostPanel {
  private static current: CostPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, getClient: () => BrainClient | undefined, workspaceRoot: string) {
    if (CostPanel.current) {
      CostPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("brain.cost", "Brain: Cost & Models", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    CostPanel.current = new CostPanel(panel, extensionUri, getClient, workspaceRoot);
  }

  /** Called when the server says cost data changed. */
  static refreshIfOpen() {
    void CostPanel.current?.load();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly getClient: () => BrainClient | undefined,
    private readonly workspaceRoot: string,
  ) {
    const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f)).toString();
    panel.webview.html = costHtml({
      nonce: randomBytes(16).toString("base64"),
      cspSource: panel.webview.cspSource,
      scriptUri: media("cost.js"),
      styleUri: media("cost.css"),
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => {
        CostPanel.current = undefined;
        for (const d of this.disposables) d.dispose();
      }),
    );
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async load() {
    const client = this.getClient();
    if (!client) return this.post({ type: "error", message: "The brain server is not running. Use “Brain: Start Server”." });
    try {
      this.post({ type: "cost", summary: await client.getCostSummary() });
    } catch (e) {
      this.post({ type: "error", message: `Could not load the cost report: ${(e as Error).message}` });
    }
  }

  private async onMessage(m: { type?: string }) {
    switch (m?.type) {
      case "ready":
      case "refresh":
        return this.load();
      case "openSettings":
        return void vscode.commands.executeCommand("brain.openSettings");
      case "export":
        return void vscode.commands.executeCommand("brain.exportCostReport");
    }
  }
}
