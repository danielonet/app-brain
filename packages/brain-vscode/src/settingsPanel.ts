import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { BrainClient, ToolError } from "./client";
import { settingsHtml } from "./settingsHtml";

/**
 * The Settings webview: the extension's only form. It renders whatever schema the server
 * serves and saves through `brain_admin_set_config`; the server validates and the form
 * shows the field errors it returns. Nothing here knows what the settings mean.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, getClient: () => BrainClient | undefined, configFile: string) {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("brain.settings", "App Brain Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, getClient, configFile);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly getClient: () => BrainClient | undefined,
    private readonly configFile: string,
  ) {
    const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f)).toString();
    panel.webview.html = settingsHtml({
      nonce: randomBytes(16).toString("base64"),
      cspSource: panel.webview.cspSource,
      scriptUri: media("settings.js"),
      styleUri: media("settings.css"),
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private dispose() {
    SettingsPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async load() {
    const client = this.getClient();
    if (!client) {
      this.post({ type: "errors", errors: [], message: "The brain server is not running. Use “Brain: Start Server”." });
      return;
    }
    try {
      const [config, schema] = await Promise.all([client.getConfig(), client.getConfigSchema()]);
      this.post({ type: "init", schema, config, initialised: client.current?.initialised ?? false, configFile: this.configFile });
    } catch (e) {
      this.post({ type: "errors", errors: [], message: `Could not load settings: ${(e as Error).message}` });
    }
  }

  private async onMessage(m: { type?: string; config?: Record<string, unknown> }) {
    switch (m?.type) {
      case "ready":
        return this.load();
      case "openPersonalSettings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "brain.");
      case "initialise":
        await vscode.commands.executeCommand("brain.initialise");
        return this.load();
      case "save": {
        const client = this.getClient();
        if (!client || !m.config) return;
        try {
          this.post({ type: "saved", config: await client.setConfig(m.config) });
        } catch (e) {
          const details = e instanceof ToolError && Array.isArray(e.details) ? e.details : [];
          this.post({ type: "errors", errors: details, message: (e as Error).message });
        }
      }
    }
  }
}
