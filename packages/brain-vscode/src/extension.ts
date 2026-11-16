import * as path from "node:path";
import * as vscode from "vscode";
import type { BrainStatus } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { ConnState, mcpConfigSnippet, statusBarText } from "./format";

let client: BrainClient | undefined;

function resolveServerPath(): string {
  const configured = vscode.workspace.getConfiguration("brain").get<string>("server.path", "").trim();
  return configured || require.resolve("@app-brain/brain-mcp/out/cli.js");
}

export async function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return; // nothing to index without a folder

  const cfg = () => vscode.workspace.getConfiguration("brain");
  const out = vscode.window.createOutputChannel("App Brain");
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = "brain.showLogs";
  context.subscriptions.push(out, bar);
  bar.show();

  let promptedInit = false;
  const onState = (conn: ConnState, status: BrainStatus | null) => {
    const view = statusBarText(conn, status);
    bar.text = view.text;
    bar.tooltip = view.tooltip;
    bar.backgroundColor = view.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    bar.command = conn === "disconnected" ? "brain.start" : status && !status.initialised ? "brain.initialise" : "brain.showLogs";
    if (conn === "connected" && status && !status.initialised && !promptedInit) {
      promptedInit = true;
      void vscode.window
        .showInformationMessage("Create the .brain folder for this workspace?", "Initialise", "Not now")
        .then((choice) => (choice === "Initialise" ? vscode.commands.executeCommand("brain.initialise") : undefined));
    }
  };

  const make = () =>
    new BrainClient({
      nodePath: cfg().get<string>("server.nodePath", "node"),
      serverPath: resolveServerPath(),
      workspace: folder.uri.fsPath,
      outputDir: cfg().get<string>("outputDir", ".brain"),
      log: (l) => out.appendLine(l),
      onState,
    });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      out.appendLine(`${label} failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Brain: ${label} failed. ${(e as Error).message}`);
    }
  };

  client = make();

  context.subscriptions.push(
    vscode.commands.registerCommand("brain.start", () =>
      run("start", async () => {
        await client?.stop();
        client = make();
        await client.start();
      }),
    ),
    vscode.commands.registerCommand("brain.stop", () => client?.stop()),
    vscode.commands.registerCommand("brain.initialise", () =>
      run("initialise", async () => {
        const r = await client!.initialise();
        void vscode.window.showInformationMessage(
          r.alreadyInitialised ? "Brain is already initialised." : `Brain initialised (${r.created.length} files created).`,
        );
        await client!.refresh();
      }),
    ),
    vscode.commands.registerCommand("brain.reindex", () =>
      run("reindex", async () => {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Brain: indexing" }, () => client!.reindex());
        void vscode.window.setStatusBarMessage(`Brain: indexed ${r.files} files in ${r.durationMs} ms`, 4000);
      }),
    ),
    vscode.commands.registerCommand("brain.openOutputFolder", () => {
      const dir = vscode.Uri.file(path.join(folder.uri.fsPath, cfg().get<string>("outputDir", ".brain")));
      return vscode.commands.executeCommand("revealFileInOS", dir);
    }),
    vscode.commands.registerCommand("brain.showLogs", () => out.show(true)),
    vscode.commands.registerCommand("brain.copyMcpConfig", async () => {
      await vscode.env.clipboard.writeText(mcpConfigSnippet(resolveServerPath(), folder.uri.fsPath, cfg().get<string>("outputDir", ".brain")));
      void vscode.window.showInformationMessage("MCP config copied. Paste it into .mcp.json.");
    }),
  );

  // Let Copilot agent mode find the server. No admin token here: agents get the read-only tools only.
  if (cfg().get<boolean>("registerWithCopilot", true) && vscode.lm?.registerMcpServerDefinitionProvider) {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      changed,
      vscode.lm.registerMcpServerDefinitionProvider("brain.mcp", {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: () => [
          new vscode.McpStdioServerDefinition(
            "App Brain",
            cfg().get<string>("server.nodePath", "node"),
            [resolveServerPath(), "--workspace", folder.uri.fsPath, "--output-dir", cfg().get<string>("outputDir", ".brain")],
            {},
            "0.0.0",
          ),
        ],
      }),
    );
  }

  await client.start();
}

export async function deactivate() {
  await client?.stop();
}
