import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readDaemonInfo, runtimeDir, workspaceKey, type BrainStatus, type DocStatusItem, type GenerationScope, type GenerationState, type PendingItem, type UsageSummary } from "@app-brain/brain-protocol";
import { BrainClient } from "./client";
import { CostPanel } from "./costPanel";
import { collectProviderUsage } from "./providerUsage";
import { GraphPanel } from "./graphPanel";
import { SettingsPanel } from "./settingsPanel";
import { ActivityItem, ConnState, ReviewRow, activityItems, bulkConfirmation, bulkResultMessage, bulkScopes, folderGroups, isPlainDraft, estimateDetail, estimateTitle, flashText, generationBarText, generationProblems, generationProgress, generationSummary, llmTestSummary, mcpConfigSnippet, reviewRows, statusBarText, validationReport, validationSummary } from "./format";
import { resolveAutoMode } from "./agentDetect";
import { coverageGroups, coverageSummary, connectionReport, lensFor, statusIcon, type CoverageGroup } from "./docSurfaces";
import { embeddingsInput, searchReport } from "./searchStatus";
import { EdgeBridge, SaveScheduler, relativeInside } from "./lspBridge";
import { editorLanguageFacts } from "./lspProvider";
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
  let lastUsage: UsageSummary | null = null;
  const onUsage = (usage: UsageSummary) => {
    lastUsage = usage;
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
  const reviewView = vscode.window.createTreeView("brain.review", { treeDataProvider: review, canSelectMany: true });
  context.subscriptions.push(reviewView);
  const onPending = (items: PendingItem[]) => {
    pending = items;
    review.update(items);
    reviewView.badge = items.length ? { value: items.length, tooltip: `${items.length} generated doc${items.length === 1 ? "" : "s"} to review` } : undefined;
  };

  // What every file's documentation looks like now: the coverage tree and the CodeLens read it.
  const coverage = new CoverageProvider();
  let docStatus: DocStatusItem[] = [];
  const lensChanged = new vscode.EventEmitter<void>();
  const coverageView = vscode.window.createTreeView("brain.coverage", { treeDataProvider: coverage });
  const onDocStatus = (items: DocStatusItem[]) => {
    docStatus = items;
    coverage.update(items);
    coverageView.description = coverageSummary(items).replace(/ \(.*$/, "").replace(/,.*$/, "");
    lensChanged.fire();
  };
  context.subscriptions.push(
    coverageView,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(doc) {
        if (!cfg().get<boolean>("codeLens.docStatus", true)) return [];
        const rel = relativeInside(folder.uri.fsPath, doc.uri.fsPath);
        const item = rel ? docStatus.find((d) => d.kind === "file" && d.target === rel) : undefined;
        const lens = lensFor(item);
        if (!lens) return [];
        return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: lens.title, tooltip: lens.tooltip, command: lens.command === "openDoc" ? "brain.openDocFile" : "brain.generateDocs", arguments: lens.command === "openDoc" ? [item!.docFile] : [] })];
      },
    }),
    vscode.languages.registerHoverProvider({ scheme: "file" }, {
      provideHover(doc, pos) {
        if (!cfg().get<boolean>("codeLens.docStatus", true) || pos.line !== 0) return undefined;
        const rel = relativeInside(folder.uri.fsPath, doc.uri.fsPath);
        const item = rel ? docStatus.find((d) => d.kind === "file" && d.target === rel) : undefined;
        return item && item.status !== "none" ? new vscode.Hover(`Brain: documentation is **${item.status}**.`) : undefined;
      },
    }),
  );

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
  const EDGE_EXTENSIONS = "ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs";
  const API_KEY = "brain.llm.apiKey";
  const ADMIN_KEY = "brain.usage.anthropicAdminKey";
  /** What the providers report (Claude Code's local logs, the Anthropic organisation), for the cost view. */
  const loadProviderUsage = async () => {
    let pricing = {};
    try { pricing = ((await client?.getConfig())?.pricing as object | undefined) ?? {}; } catch { /* no server: logs can still be priced from nothing, and say so */ }
    return collectProviderUsage({
      workspace: folder.uri.fsPath,
      pricing,
      settings: { claudeCodeLogs: cfg().get<boolean>("usage.claudeCodeLogs", true), copilotLogs: cfg().get<boolean>("usage.copilotLogs", true), anthropicAdmin: cfg().get<boolean>("usage.anthropicAdmin.enabled", false), lookbackDays: cfg().get<number>("usage.lookbackDays", 30) },
      adminKey: await context.secrets.get(ADMIN_KEY),
      // VS Code gives each workspace a storage folder; Copilot Chat's sessions sit beside the extensions' own folders in its parent.
      copilotSessionsDir: context.storageUri ? path.join(path.dirname(context.storageUri.fsPath), "chatSessions") : undefined,
    });
  };
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
      onDocStatus,
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

  /** The drafts a review command applies to: the ones selected in the tree when several are, otherwise the one clicked. */
  const reviewItems = (row: ReviewRow | undefined, selected: ReviewRow[] | undefined): PendingItem[] => {
    const rows = selected && selected.length > 1 ? selected : row ? [row] : [];
    return rows.map((r) => pending.find((p) => p.target === r.target)).filter((p): p is PendingItem => Boolean(p));
  };

  /** Many at once, in batches so there is progress to show and a way to stop. The server writes each draft on its own. */
  const BULK_BATCH = 100;
  const bulkReview = async (items: PendingItem[], action: "approve" | "reject", note?: string) => {
    const by = await reviewer(folder.uri.fsPath);
    await vscode.workspace.saveAll(false); // the server approves what is on disk
    let done = 0;
    const failed: { target: string; error: string }[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Brain: ${action === "approve" ? "approving" : "rejecting"} ${items.length} drafts`, cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < items.length; i += BULK_BATCH) {
          if (token.isCancellationRequested) break; // what was done stays done
          const r = await client!.reviewMany(items.slice(i, i + BULK_BATCH).map((x) => x.target), action, by, note);
          done += r.done;
          failed.push(...r.failed);
          progress.report({ increment: (100 * BULK_BATCH) / items.length, message: `${Math.min(i + BULK_BATCH, items.length)} of ${items.length}` });
        }
      },
    );
    await client!.refresh();
    for (const f of failed) out.appendLine(`${action} ${f.target}: ${f.error}`);
    const message = bulkResultMessage(action, done, failed);
    if (failed.length) void vscode.window.showWarningMessage(`Brain: ${message}`); else void vscode.window.showInformationMessage(`Brain: ${message}`);
  };

  const approveMany = async (items: PendingItem[]) => {
    const by = await reviewer(folder.uri.fsPath);
    const ask = bulkConfirmation(items, by);
    const ok = await vscode.window.showWarningMessage(ask.message, { modal: true, detail: ask.detail }, ask.button);
    if (ok !== ask.button) return;
    await bulkReview(items, "approve");
  };

  client = await make();

  // After a save, ask the language server again about that file (call and inheritance links), one file at a time.
  const edgeScheduler = new SaveScheduler(async (rel) => {
    const c = client;
    if (!c?.current?.initialised || !cfg().get<boolean>("edges.languageServer", true)) return;
    await new EdgeBridge(folder.uri.fsPath, editorLanguageFacts, c).analyse(rel);
  });
  context.subscriptions.push(
    { dispose: () => edgeScheduler.dispose() },
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const rel = doc.uri.scheme === "file" ? relativeInside(folder.uri.fsPath, doc.uri.fsPath) : null;
      if (rel && new RegExp(`\\.(${EDGE_EXTENSIONS.split(",").join("|")})$`).test(rel)) edgeScheduler.schedule(rel);
    }),
  );

  /** Tells the server which embedding model to use. Sent at every connect, never read from a file in the repository. */
  const pushEmbeddings = async () => {
    try { await client?.setEmbeddings(embeddingsInput({ model: cfg().get<string>("search.embeddings.model", ""), baseUrl: cfg().get<string>("search.embeddings.baseUrl", "") })); }
    catch (e) { out.appendLine(`could not set the embedding model: ${(e as Error).message}`); }
  };

  /** Starts a fresh server, e.g. after the LLM settings or the key changed. */
  const restart = async () => {
    await client?.stop();
    client = await make();
    await client.start();
    await pushEmbeddings();
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
      if (e.affectsConfiguration("brain.search.embeddings")) void pushEmbeddings();
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
    vscode.commands.registerCommand("brain.updateSemanticEdges", () =>
      run("update semantic edges", async () => {
        const c = client;
        if (!c?.current?.initialised) throw new Error("Initialise the .brain folder first.");
        const files = (await vscode.workspace.findFiles(`**/*.{${EDGE_EXTENSIONS}}`, "**/{node_modules,.git,.brain,dist,out,build,vendor,__pycache__}/**", 3000)).map((u) => relativeInside(folder.uri.fsPath, u.fsPath)).filter((r): r is string => r !== null);
        if (files.length === 0) { void vscode.window.showInformationMessage("Brain: no source files found."); return; }
        const bridge = new EdgeBridge(folder.uri.fsPath, editorLanguageFacts, c);
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Brain: asking your language servers how files relate", cancellable: true },
          (progress, token) => {
            let last = 0;
            return bridge.analyseMany(files, (done, total) => { progress.report({ message: `${done} of ${total}`, increment: ((done - last) / total) * 100 }); last = done; }, () => token.isCancellationRequested);
          },
        );
        void vscode.window.showInformationMessage(
          r.sent === 0
            ? "Brain: your language servers returned nothing. Open a file of that language, wait until its language support has started, and try again."
            : `Brain: stored ${r.edges} call and inheritance links from ${r.sent} files${r.empty ? ` (${r.empty} files had no answer yet)` : ""}.`,
        );
      }),
    ),
    vscode.commands.registerCommand("brain.openDocFile", async (docFile: string | null) => {
      if (docFile) await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, docFile)));
    }),
    vscode.commands.registerCommand("brain.openCoverageItem", async (item: DocStatusItem) => {
      if (item.docFile) await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, item.docFile)));
      else if (item.kind === "file") await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, item.target)));
      else await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path.join(folder.uri.fsPath, item.target)));
    }),
    vscode.commands.registerCommand("brain.checkAgentConnection", () =>
      run("check agent connection", async () => {
        const r = connectionReport(client?.current?.server.clients ?? [], lastUsage);
        const buttons = r.level === "none" ? ["Copy MCP config for Claude Code"] : [];
        const pick = await (r.level === "ok" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(`${r.title} ${r.lines.join(" ")}`, ...buttons);
        if (pick) await vscode.commands.executeCommand("brain.copyMcpConfig");
      }),
    ),
    vscode.commands.registerCommand("brain.checkSemanticSearch", () =>
      run("check semantic search", async () => {
        await pushEmbeddings();
        const r = searchReport(client?.current?.search?.embeddings);
        const pick = await (r.level === "error" || r.level === "off" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(r.text, ...(r.level === "off" || r.level === "error" ? ["Open settings"] : []));
        if (pick) await vscode.commands.executeCommand("workbench.action.openSettings", "brain.search.embeddings");
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
    vscode.commands.registerCommand("brain.review.approve", (row: ReviewRow, selected?: ReviewRow[]) =>
      run("approve", async () => {
        const chosen = reviewItems(row, selected);
        if (chosen.length > 1) return approveMany(chosen);
        const item = chosen[0];
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
    vscode.commands.registerCommand("brain.review.reject", (row: ReviewRow, selected?: ReviewRow[]) =>
      run("reject", async () => {
        const chosen = reviewItems(row, selected);
        const item = chosen[0];
        if (!item) return;
        const many = chosen.length > 1;
        const note = await vscode.window.showInputBox({ prompt: many ? `Why reject these ${chosen.length} docs? (optional; the next attempt can use it)` : `Why reject the doc for ${item.target}? (optional; the next attempt can use it)`, placeHolder: "Too vague, missed the retry logic…" });
        if (note === undefined) return; // cancelled
        if (many) return bulkReview(chosen, "reject", note);
        await client!.review(item.target, "reject", await reviewer(folder.uri.fsPath), note);
        await client!.refresh();
      }),
    ),
    vscode.commands.registerCommand("brain.review.approveMany", () =>
      run("approve many", async () => {
        if (pending.length === 0) return void vscode.window.showInformationMessage("Brain: no drafts are waiting for review.");
        const scope = await vscode.window.showQuickPick(
          bulkScopes(pending).map((s) => ({ label: s.label, description: s.description, scope: s })),
          { title: `Approve many of ${pending.length} drafts`, placeHolder: "Which drafts?" },
        );
        if (!scope) return;
        let chosen = scope.scope.items;
        if (scope.scope.id === "folders") {
          const groups = await vscode.window.showQuickPick(
            folderGroups(pending).map((g) => ({ label: g.folder, description: `${g.items.length} draft${g.items.length === 1 ? "" : "s"}`, group: g })),
            { title: "Approve everything in these folders", canPickMany: true, matchOnDescription: true },
          );
          if (!groups) return;
          chosen = groups.flatMap((g) => g.group.items);
        } else if (scope.scope.id === "pick") {
          const picks = await vscode.window.showQuickPick(
            pending.map((i) => ({ label: i.target, description: [i.kind, i.stale ? "code changed since" : "", i.replacesReviewed ? "replaces reviewed doc" : ""].filter(Boolean).join(" · "), picked: isPlainDraft(i), item: i })),
            { title: "Approve these drafts", canPickMany: true, matchOnDescription: true },
          );
          if (!picks) return;
          chosen = picks.map((p) => p.item);
        }
        if (chosen.length === 0) return;
        await approveMany(chosen);
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
    vscode.commands.registerCommand("brain.setAnthropicAdminKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Anthropic Admin API key",
        prompt: "Paste an Admin API key (starts with sk-ant-admin) from a Claude Console organisation. It is kept in VS Code's secret storage and sent only to api.anthropic.com, to read your organisation's usage.",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/^sk-ant-admin[A-Za-z0-9_-]{8,}$/.test(v.trim()) ? undefined : "That does not look like an Admin API key. They start with sk-ant-admin; a normal API key cannot read usage."),
      });
      if (key === undefined) return;
      await context.secrets.store(ADMIN_KEY, key.trim());
      await cfg().update("usage.anthropicAdmin.enabled", true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage("Anthropic Admin key saved. Open Brain: Show Cost & Models to see your organisation's usage.");
      CostPanel.refreshIfOpen();
    }),
    vscode.commands.registerCommand("brain.clearAnthropicAdminKey", async () => {
      await context.secrets.delete(ADMIN_KEY);
      void vscode.window.showInformationMessage("Anthropic Admin key removed.");
      CostPanel.refreshIfOpen();
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
    vscode.commands.registerCommand("brain.showCost", () => CostPanel.show(context.extensionUri, () => client, folder.uri.fsPath, loadProviderUsage)),
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
  await pushEmbeddings();
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

class CoverageProvider implements vscode.TreeDataProvider<CoverageGroup | DocStatusItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private groups: CoverageGroup[] = [];
  update(items: DocStatusItem[]) { this.groups = coverageGroups(items); this.changed.fire(); }
  getChildren(el?: CoverageGroup | DocStatusItem): (CoverageGroup | DocStatusItem)[] {
    if (!el) return this.groups;
    return "items" in el ? el.items : [];
  }
  getTreeItem(el: CoverageGroup | DocStatusItem): vscode.TreeItem {
    if ("items" in el) {
      const t = new vscode.TreeItem(el.label, el.status === "reviewed" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      t.description = String(el.items.length);
      t.iconPath = new vscode.ThemeIcon(statusIcon(el.status));
      return t;
    }
    const t = new vscode.TreeItem(el.target);
    t.description = el.kind;
    t.iconPath = new vscode.ThemeIcon(el.kind === "module" ? "folder" : "file");
    t.command = { command: "brain.openCoverageItem", title: "Open", arguments: [el] };
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
