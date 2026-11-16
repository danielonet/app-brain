import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BrainStatus, PendingItem, UsageSummary } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { CostPanel } from "./costPanel";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { ActivityItem, ConnState, ReviewRow, activityItems, flashText, mcpConfigSnippet, reviewRows, statusBarText, validationReport, validationSummary } from "./format";

let client: BrainClient | undefined;

class ActivityProvider implements vscode.TreeDataProvider<ActivityItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: ActivityItem[] = activityItems(null);

  update(usage: UsageSummary | null) {
    this.items = activityItems(usage);
    this.changed.fire();
  }
  getChildren(): ActivityItem[] {
    return this.items;
  }
  getTreeItem(i: ActivityItem): vscode.TreeItem {
    const t = new vscode.TreeItem(i.label);
    t.description = i.description;
    t.tooltip = i.tooltip;
    if (i.error) t.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
    return t;
  }
}

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

  const activity = new ActivityProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("brain.activity", activity));

  // Level 1 of "did the agent use the brain": show it the moment a tool is called.
  let lastSeenCall = -1;
  let flashTimer: NodeJS.Timeout | undefined;
  const onUsage = (usage: UsageSummary) => {
    activity.update(usage);
    const newest = usage.recent[0];
    if (!newest) return;
    if (lastSeenCall >= 0 && newest.id > lastSeenCall) {
      bar.text = flashText(newest);
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => onState(lastConn, client?.current ?? null), 4000);
    }
    lastSeenCall = newest.id;
  };

  const review = new ReviewProvider();
  let pending: PendingItem[] = [];
  const reviewView = vscode.window.createTreeView("brain.review", { treeDataProvider: review });
  context.subscriptions.push(reviewView);
  const onPending = (items: PendingItem[]) => {
    pending = items;
    review.update(items);
    reviewView.badge = items.length ? { value: items.length, tooltip: `${items.length} generated doc${items.length === 1 ? "" : "s"} to review` } : undefined;
  };

  let lastConn: ConnState = "connecting";
  let promptedInit = false;
  let lastIndexedAt: string | null = null;
  let lastDocs = "";
  const onState = (conn: ConnState, status: BrainStatus | null) => {
    lastConn = conn;
    if (status && status.state === "idle") {
      const docs = JSON.stringify(status.knowledge);
      if (status.index.lastIndexedAt !== lastIndexedAt || docs !== lastDocs) {
        const first = lastIndexedAt === null;
        lastIndexedAt = status.index.lastIndexedAt;
        lastDocs = docs;
        if (!first) GraphPanel.refreshIfOpen();
      }
    }
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
      onUsage,
      onPending,
      onCost: () => CostPanel.refreshIfOpen(),
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
    vscode.commands.registerCommand("brain.review.open", async (row: ReviewRow) => {
      const item = pending.find((p) => p.target === row?.target);
      if (!item) return;
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, item.draftFile)));
    }),
    vscode.commands.registerCommand("brain.review.approve", (row: ReviewRow) =>
      run("approve", async () => {
        const item = pending.find((p) => p.target === row?.target);
        if (!item) return;
        if (item.stale) {
          const ok = await vscode.window.showWarningMessage(`The code in ${item.target} changed after this doc was written. Approve anyway?`, { modal: true }, "Approve anyway");
          if (ok !== "Approve anyway") return;
        }
        // Save edits made to the draft in the editor first: the server approves what is on disk.
        await vscode.workspace.saveAll(false);
        await client!.review(item.target, "approve", await reviewer(folder.uri.fsPath));
        await client!.refresh();
      }),
    ),
    vscode.commands.registerCommand("brain.review.reject", (row: ReviewRow) =>
      run("reject", async () => {
        const item = pending.find((p) => p.target === row?.target);
        if (!item) return;
        const note = await vscode.window.showInputBox({ prompt: `Why reject the doc for ${item.target}? (optional; the next attempt can use it)`, placeHolder: "Too vague, missed the retry logic…" });
        if (note === undefined) return; // cancelled
        await client!.review(item.target, "reject", await reviewer(folder.uri.fsPath), note);
        await client!.refresh();
      }),
    ),
    vscode.commands.registerCommand("brain.validate", () =>
      run("validate", async () => {
        const result = await client!.validate();
        for (const line of validationReport(result)) out.appendLine(line);
        out.show(true);
        void vscode.window.showInformationMessage(`Brain: ${validationSummary(result)}`);
      }),
    ),
    vscode.commands.registerCommand("brain.openSettings", () =>
      SettingsPanel.show(context.extensionUri, () => client, path.posix.join(cfg().get<string>("outputDir", ".brain"), "config.json")),
    ),
    vscode.commands.registerCommand("brain.showCost", () => CostPanel.show(context.extensionUri, () => client, folder.uri.fsPath)),
    vscode.commands.registerCommand("brain.exportCostReport", () =>
      run("export cost report", async () => {
        const r = await client!.exportCostReport();
        const pick = await vscode.window.showInformationMessage(`Cost report written: ${r.calls} call${r.calls === 1 ? "" : "s"} (${r.markdown}).`, "Open report");
        if (pick === "Open report") await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, r.markdown)));
      }),
    ),
    vscode.commands.registerCommand("brain.showGraph", () => GraphPanel.show(context.extensionUri, () => client, folder.uri.fsPath)),
    vscode.commands.registerCommand("brain.exportGraph", () =>
      run("export graph", async () => {
        const r = await client!.exportGraph();
        const open = await vscode.window.showInformationMessage(`Graph exported: ${r.nodes} nodes, ${r.edges} dependencies (${r.file}).`, "Open");
        if (open === "Open") await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, r.file)));
      }),
    ),
    vscode.commands.registerCommand("brain.search", () => searchSymbols(() => client, folder.uri.fsPath)),
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

class ReviewProvider implements vscode.TreeDataProvider<ReviewRow> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private rows: ReviewRow[] = [];
  update(items: PendingItem[]) {
    this.rows = reviewRows(items);
    this.changed.fire();
  }
  getChildren(): ReviewRow[] {
    return this.rows;
  }
  getTreeItem(r: ReviewRow): vscode.TreeItem {
    const t = new vscode.TreeItem(r.label);
    t.description = r.description;
    t.tooltip = r.tooltip;
    t.contextValue = "draft";
    t.iconPath = new vscode.ThemeIcon(r.stale ? "warning" : "note");
    t.command = { command: "brain.review.open", title: "Open Draft", arguments: [r] };
    return t;
  }
}

/** Who is reviewing: the git user, else the OS user. Recorded as `human:<name>` in the doc. */
function reviewer(cwd: string): Promise<string> {
  return new Promise((resolve) =>
    execFile("git", ["config", "user.name"], { cwd }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim() : os.userInfo().username)),
  );
}

/** Quick pick over `search_code`: the same index agents use, so you can see what they would find. */
async function searchSymbols(getClient: () => BrainClient | undefined, root: string) {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { path: string; line: number }>();
  qp.placeholder = "Search symbols: a name, or what it does (e.g. “user by id”)";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let timer: NodeJS.Timeout | undefined;
  let seq = 0;
  qp.onDidChangeValue((value) => {
    if (timer) clearTimeout(timer);
    if (!value.trim()) {
      qp.items = [];
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++seq;
      qp.busy = true;
      try {
        const hits = (await getClient()?.search(value)) ?? [];
        if (mine !== seq) return; // a newer keystroke is already in flight
        qp.items = hits.map((h) => ({
          label: `$(symbol-${h.kind === "class" ? "class" : h.kind === "interface" ? "interface" : h.kind === "method" ? "method" : "function"}) ${h.symbol}`,
          description: `${h.path}:${h.lines.split("-")[0]}`,
          detail: h.signature,
          path: h.path,
          line: Number(h.lines.split("-")[0]),
          alwaysShow: true,
        }));
      } catch (e) {
        void vscode.window.showErrorMessage(`Brain search failed: ${(e as Error).message}`);
      } finally {
        if (mine === seq) qp.busy = false;
      }
    }, 150);
  });
  qp.onDidAccept(async () => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, pick.path)));
    const pos = new vscode.Position(Math.max(0, pick.line - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

export async function deactivate() {
  await client?.stop();
}
