import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readDaemonInfo, runtimeDir, workspaceKey, type BrainStatus, type GenerationScope, type GenerationState, type PendingItem, type UsageSummary } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { CostPanel } from "./costPanel";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { ActivityItem, ConnState, ReviewRow, activityItems, estimateDetail, estimateTitle, flashText, generationBarText, generationProblems, generationProgress, generationSummary, llmTestSummary, mcpConfigSnippet, reviewRows, statusBarText, validationReport, validationSummary } from "./format";
import { resolveAutoMode } from "./agentDetect";
import { daemonLlm, llmEnv, localProblems, validateApiKey } from "./llmEnv";
import { ensureDaemon, stopDaemon } from "./daemonManager";
import { sampleWithEditorModel } from "./lmBridge";

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

  let warnedNoAgent = false;
  const API_KEY = "brain.llm.apiKey";
  const llmSettings = () => ({
    mode: cfg().get<string>("llm.mode", "auto"),
    model: cfg().get<string>("llm.model", ""),
    baseUrl: cfg().get<string>("llm.baseUrl", ""),
    effort: cfg().get<string>("llm.effort", ""),
    preset: cfg().get<string>("llm.local.preset", "ollama"),
    contextTokens: cfg().get<number>("llm.local.contextTokens", 8192),
    maxOutputTokens: cfg().get<number>("llm.local.maxOutputTokens", 1500),
    timeoutSeconds: cfg().get<number>("llm.local.timeoutSeconds", 600),
  });

  // Generation progress: the status bar shows it, and a running "Generate Docs" command waits on it.
  let generation: GenerationState | null = null;
  const generationWaiters = new Set<(g: GenerationState) => void>();
  const onGeneration = (g: GenerationState) => {
    generation = g;
    const text = generationBarText(g);
    if (text) bar.text = text;
    else onState(lastConn, client?.current ?? null);
    if (g.state !== "running" && g.state !== "cancelling") for (const w of generationWaiters) w(g);
    for (const w of progressWatchers) w(g);
  };
  const progressWatchers = new Set<(g: GenerationState) => void>();

  /** One admin token per workspace, kept in secret storage: it is never written to a file an agent could read. */
  const getAdminToken = async () => {
    const k = `brain.admin.${workspaceKey(folder.uri.fsPath)}`;
    let t = await context.secrets.get(k);
    if (!t) {
      t = randomBytes(32).toString("base64url");
      await context.secrets.store(k, t);
    }
    return t;
  };

  /** "auto" becomes a concrete mode here, so the server only ever sees one it knows. */
  const resolveSettings = async () => {
    const configured = llmSettings();
    if (configured.mode !== "auto") return { settings: configured, auto: null };
    const auto = resolveAutoMode({
      lmModels: (await vscode.lm.selectChatModels()).length,
      appName: vscode.env.appName,
      extensionIds: vscode.extensions.all.map((x) => x.id),
    });
    out.appendLine(`auto: ${auto.mode}, ${auto.reason}`);
    return { settings: { ...configured, mode: auto.mode }, auto };
  };

  const make = async () => {
    const { settings, auto } = await resolveSettings();
    if (auto && auto.mode === "agent" && auto.agents.length === 0 && !warnedNoAgent) {
      warnedNoAgent = true;
      void vscode.window
        .showInformationMessage("App Brain found no AI agent in this editor. To write docs with a model on your machine, choose Local in the LLM settings.", "Open LLM settings")
        .then((pick) => (pick ? vscode.commands.executeCommand("workbench.action.openSettings", "brain.llm.mode") : undefined));
    }
    // The key lives in VS Code's secret storage. An ANTHROPIC_API_KEY in the environment is a fallback for api-key mode only.
    const key = (await context.secrets.get(API_KEY)) ?? (settings.mode === "api-key" ? process.env.ANTHROPIC_API_KEY : undefined);
    const adminToken = await getAdminToken();
    const useDaemon = cfg().get<string>("server.transport", "http") === "http";
    return new BrainClient({
      adminToken,
      // The shared daemon by default. If it cannot start, a private server keeps the extension working, and we say why.
      transport: useDaemon
        ? async () => {
            try {
              const h = await ensureDaemon({
                nodePath: cfg().get<string>("server.nodePath", "node"), serverPath: resolveServerPath(), workspace: folder.uri.fsPath,
                outputDir: cfg().get<string>("outputDir", ".brain"), adminToken, llm: daemonLlm(settings, key), log: (l) => out.appendLine(l),
              });
              return { kind: "http" as const, url: h.info.url, agentToken: h.info.agentToken };
            } catch (e) {
              out.appendLine(`shared server unavailable: ${(e as Error).message}`);
              void vscode.window.showWarningMessage(`Brain: could not start the shared server, so this window uses a private one. ${(e as Error).message.split("\n")[0]}`);
              return { kind: "stdio" as const };
            }
          }
        : undefined,
      onAdminRefused: async () => {
        // A daemon started by something else does not know this editor's admin token: replace it.
        const info = await readDaemonInfo(runtimeDir(folder.uri.fsPath));
        if (!info) return false;
        out.appendLine("the running server was started without this editor's credentials; restarting it");
        await stopDaemon(info, undefined, (l) => out.appendLine(l));
        return true;
      },
      env: llmEnv(settings, key),
      sample: settings.mode === "vscode-lm" ? (params, signal) => sampleWithEditorModel(params, signal) : undefined,
      onGeneration,
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
  };

  /** Choose a scope, show the estimate, ask, then run the job with a progress notification the person can cancel. */
  const generateDocs = async () => {
    const c = client;
    if (!c?.current) throw new Error("The brain server is not running.");
    if (!c.current.initialised) {
      const pick = await vscode.window.showInformationMessage("Initialise the .brain folder first.", "Initialise");
      if (pick === "Initialise") await vscode.commands.executeCommand("brain.initialise");
      return;
    }
    if (!c.current.llm.ready) {
      const pick = await vscode.window.showWarningMessage(c.current.llm.problem ?? "The server cannot generate docs yet.", "Open settings", ...(c.current.llm.mode === "api-key" ? ["Set API key"] : []));
      if (pick === "Open settings") await vscode.commands.executeCommand("workbench.action.openSettings", "brain.llm");
      if (pick === "Set API key") await vscode.commands.executeCommand("brain.setApiKey");
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Everything without a current doc", description: "files and modules", scope: {} as Partial<GenerationScope> },
        { label: "Files only", scope: { kind: "file" } as Partial<GenerationScope> },
        { label: "Modules only", description: "needs file docs first for the best result", scope: { kind: "module" } as Partial<GenerationScope> },
        { label: "One folder…", scope: null },
      ],
      { title: "Generate docs", placeHolder: "What should the server write docs for?" },
    );
    if (!choice) return;
    let scope: Partial<GenerationScope>;
    if (choice.scope === null) {
      const rel = vscode.window.activeTextEditor ? path.posix.dirname(vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false).replace(/\\/g, "/")) : "";
      const under = await vscode.window.showInputBox({ prompt: "Folder, relative to the workspace root", value: rel === "." ? "" : rel });
      if (under === undefined) return;
      scope = { under: under.trim() || "." };
    } else scope = choice.scope;

    const estimate = await c.estimateGeneration(scope);
    if (!estimate.canStart) {
      const pick = await vscode.window.showWarningMessage(estimate.blocked ?? "Generation cannot start.", ...(/price|cap|budget/i.test(estimate.blocked ?? "") ? ["Model prices and budget…"] : []));
      if (pick) await vscode.commands.executeCommand("brain.openSettings");
      return;
    }
    const go = await vscode.window.showInformationMessage(estimateTitle(estimate), { modal: true, detail: estimateDetail(estimate) }, "Generate");
    if (go !== "Generate") return;

    await c.generateDocs(scope);
    const finished = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Brain: writing docs", cancellable: true },
      (progress, token) =>
        new Promise<GenerationState>((resolve) => {
          let last = 0;
          const watcher = (g: GenerationState) => {
            progress.report({ message: generationProgress(g), increment: g.total ? ((g.done - last) / g.total) * 100 : 0 });
            last = g.done;
          };
          progressWatchers.add(watcher);
          const waiter = (g: GenerationState) => {
            progressWatchers.delete(watcher);
            generationWaiters.delete(waiter);
            resolve(g);
          };
          generationWaiters.add(waiter);
          token.onCancellationRequested(() => void c.cancelGeneration());
          if (generation && generation.state !== "running" && generation.state !== "cancelling") waiter(generation);
        }),
    );
    for (const line of generationProblems(finished)) out.appendLine(line);
    const summary = generationSummary(finished);
    const show = summary.level === "error" ? vscode.window.showErrorMessage : summary.level === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await show(summary.text, "Review drafts");
    if (pick === "Review drafts") await vscode.commands.executeCommand("brain.review.focus");
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      out.appendLine(`${label} failed: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(`Brain: ${label} failed. ${(e as Error).message}`);
    }
  };

  client = await make();

  /** Starts a fresh server, e.g. after the LLM settings or the key changed. */
  const restart = async () => {
    await client?.stop();
    client = await make();
    await client.start();
  };
  context.subscriptions.push(
    // Sign in to Copilot after start-up and "auto" switches to it. Only restart when the answer actually changed.
    vscode.lm.onDidChangeChatModels(async () => {
      if (llmSettings().mode !== "auto") return;
      const want = (await resolveSettings()).settings.mode;
      if (want !== client?.current?.llm.mode && !(want === "agent" && client?.current?.llm.mode === undefined)) {
        await restart().catch((err) => out.appendLine(`restart failed: ${(err as Error).message}`));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("brain.llm") || e.affectsConfiguration("brain.server.transport")) void restart().catch((err) => out.appendLine(`restart failed: ${(err as Error).message}`));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("brain.start", () =>
      run("start", async () => {
        await restart();
      }),
    ),
    vscode.commands.registerCommand("brain.stop", () => client?.stop({ shutdownIfAlone: true })),
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
    vscode.commands.registerCommand("brain.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "LLM API key",
        prompt: "Paste your API key. It is stored in VS Code's secret storage and given only to the local brain server.",
        password: true,
        ignoreFocusOut: true,
        validateInput: validateApiKey,
      });
      if (key === undefined) return;
      await context.secrets.store(API_KEY, key.trim());
      void vscode.window.showInformationMessage("API key saved. Set “brain.llm.mode” to “api-key” to use it.");
      await restart();
    }),
    vscode.commands.registerCommand("brain.clearApiKey", async () => {
      await context.secrets.delete(API_KEY);
      void vscode.window.showInformationMessage("API key removed.");
      await restart();
    }),
    vscode.commands.registerCommand("brain.testLlm", () =>
      run("test the LLM", async () => {
        const problems = localProblems(llmSettings());
        if (problems.length) {
          out.appendLine(problems.map((p) => `LLM settings: ${p}`).join("\n"));
          const pick = await vscode.window.showWarningMessage(problems[0], "Open settings");
          if (pick) await vscode.commands.executeCommand("workbench.action.openSettings", "brain.llm");
          return;
        }
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Brain: testing the LLM" }, () => client!.testLlm());
        const summary = llmTestSummary(result);
        for (const line of summary.lines) out.appendLine(line);
        const show = summary.level === "error" ? vscode.window.showErrorMessage : summary.level === "warning" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        const pick = await show(summary.text, "Show details", ...(summary.level === "error" ? ["Open settings"] : []));
        if (pick === "Show details") out.show(true);
        if (pick === "Open settings") await vscode.commands.executeCommand("workbench.action.openSettings", "brain.llm");
      }),
    ),
    vscode.commands.registerCommand("brain.chooseLocalModel", () =>
      run("choose a local model", async () => {
        if (llmSettings().mode !== "local") {
          const pick = await vscode.window.showInformationMessage("Local mode is not selected. Use a model on your own machine?", "Use local mode");
          if (pick !== "Use local mode") return;
          await cfg().update("llm.mode", "local", vscode.ConfigurationTarget.Global);
          // Changing the mode restarts the server (and the shared daemon, if its settings differ). Wait until it is back in local mode.
          for (let i = 0; i < 75 && client?.current?.llm.mode !== "local"; i++) await new Promise((r) => setTimeout(r, 200));
        }
        const listing = await client!.listLlmModels();
        if (listing.models.length === 0) {
          void vscode.window.showWarningMessage(`${listing.endpoint} lists no models. Pull or load one in your server first.`);
          return;
        }
        const pick = await vscode.window.showQuickPick(
          listing.models.map((m) => ({ label: m, description: m === listing.current ? "current" : undefined })),
          { title: `Models on ${listing.endpoint}`, placeHolder: "Pick the model that writes your docs" },
        );
        if (!pick) return;
        await cfg().update("llm.model", pick.label, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(`Using ${pick.label}. Run “Brain: Test LLM Connection” to check it.`);
      }),
    ),
    vscode.commands.registerCommand("brain.generateDocs", () => run("generate docs", () => generateDocs())),
    vscode.commands.registerCommand("brain.cancelGeneration", () => run("cancel", async () => void (await client?.cancelGeneration()))),
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
    execFile("git", ["config", "user.name"], { cwd, windowsHide: true }, (err, stdout) => resolve(!err && stdout.trim() ? stdout.trim() : os.userInfo().username)),
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
  // Leave the shared server running if agents or another window are using it; stop it if we were its only client.
  await client?.stop({ shutdownIfAlone: true });
}
