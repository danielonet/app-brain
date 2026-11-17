import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ProviderUsage } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { costHtml } from "./costHtml";

/** The cost report view. All numbers come from the server's `brain://cost/summary`; nothing is computed here. */
export class CostPanel {
  private static current: CostPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, getClient: () => BrainClient | undefined, workspaceRoot: string, loadUsage: () => Promise<ProviderUsage>) {
    if (CostPanel.current) {
      CostPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("brain.cost", "Brain: Cost & Models", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    CostPanel.current = new CostPanel(panel, extensionUri, getClient, workspaceRoot, loadUsage);
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
    private readonly loadUsage: () => Promise<ProviderUsage>,
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
    // What the providers report comes after, and on its own: reading logs or calling Anthropic is slower and can fail without hiding the rest.
    try {
      this.post({ type: "usage", usage: await this.loadUsage() });
    } catch (e) {
      this.post({ type: "usageError", message: `Could not load provider usage: ${(e as Error).message}` });
    }
  }

  private async onMessage(m: { type?: string }) {
    switch (m?.type) {
      case "ready":
      case "refresh":
        return this.load();
      case "openSettings":
        return void vscode.commands.executeCommand("brain.openSettings");
      case "setAnthropicKey":
        return void vscode.commands.executeCommand("brain.setAnthropicAdminKey");
      case "openUsageSettings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "brain.usage");
      case "export":
        return void vscode.commands.executeCommand("brain.exportCostReport");
    }
  }
}
