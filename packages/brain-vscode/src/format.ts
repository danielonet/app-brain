import type { BrainStatus, Estimate, LlmTestResult, GenerationState, PendingItem, UsageEntry, UsageSummary, ValidationResult } from "@app-brain/brain-protocol";

/** Pure formatting, kept free of the `vscode` module so it can be unit-tested. */
export type ConnState = "disconnected" | "connecting" | "connected" | "failed";

export function statusBarText(conn: ConnState, status: BrainStatus | null): { text: string; tooltip: string; error: boolean } {
  switch (conn) {
    case "connecting":
      return { text: "$(sync~spin) Brain: starting", tooltip: "Starting the brain server", error: false };
    case "failed":
      return { text: "$(error) Brain: server error", tooltip: "The brain server stopped. Click for logs.", error: true };
    case "disconnected":
      return { text: "$(circle-slash) Brain: stopped", tooltip: "Click to start the brain server", error: false };
  }
  if (!status) return { text: "$(book) Brain", tooltip: "Connected", error: false };
  if (!status.initialised) {
    return { text: "$(book) Brain: not initialised", tooltip: "Run “Brain: Initialise” to create the .brain folder", error: false };
  }
  if (status.state === "error") {
    return { text: "$(error) Brain: error", tooltip: status.message ?? "The server reported an error", error: true };
  }
  if (status.state === "indexing" || status.state === "starting") {
    return { text: `$(sync~spin) Brain: ${status.message ?? "indexing"}`, tooltip: "Indexing the workspace", error: false };
  }
  const n = status.index.files;
  const sym = status.index.symbols;
  const langs = Object.entries(status.index.byLanguage)
    .sort((a, b) => b[1] - a[1])
    .map(([l, c]) => `${l}: ${c}`)
    .join(", ");
  const k = status.knowledge;
  const review = k.drafts > 0 ? ` · ${k.drafts} to review` : "";
  return {
    text: `$(book) Brain: ready · ${n} file${n === 1 ? "" : "s"} · ${sym} symbol${sym === 1 ? "" : "s"}${review}`,
    tooltip:
      `Brain ${status.serverVersion}\n${sym} symbols, ${status.index.edges} import links\n` +
      `Docs: ${k.reviewed} reviewed, ${k.drafts} awaiting review, ${k.stale} stale\n` +
      serverLine(status) +
      (status.llm.mode === "agent" ? "" : `Doc generation: ${status.llm.ready ? `ready (${status.llm.mode}, ${status.llm.model ?? "default model"})` : `not ready. ${status.llm.problem ?? ""}`}\n`) +
      (status.cost.calls > 0 ? `LLM spend: ${spend(status.cost.spendUsd)}${status.cost.complete ? "" : " or more (some calls could not be priced)"} over ${status.cost.calls} call${status.cost.calls === 1 ? "" : "s"}\n` : "") +
      `Output: ${status.outputDir}${langs ? `\n${langs}` : ""}`,
    error: false,
  };
}

const spend = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** Which server this is, and who else is using it: the shared daemon is the point of having one. */
export function serverLine(status: BrainStatus): string {
  const others = status.server.clients.filter((c) => !(c.admin && c.name === "brain-vscode"));
  const who = others.length ? ` Also connected: ${[...new Set(others.map((c) => c.name ?? "unknown"))].join(", ")}.` : "";
  return status.server.transport === "http" ? `Server: shared (pid ${status.server.pid}).${who}\n` : `Server: private to this window (pid ${status.server.pid}).\n`;
}

/** Snippet for `.mcp.json` (Claude Code, Cursor). No admin token: agents get the read-only tools. */
export function mcpConfigSnippet(serverPath: string, workspace: string, outputDir: string): string {
  return JSON.stringify(
    { mcpServers: { brain: { command: "node", args: [serverPath, "--workspace", workspace, "--output-dir", outputDir] } } },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Agent activity (PLAN-VSCODE-EXTENSION.md §4.4, level 1: "the agent called the brain")
// ---------------------------------------------------------------------------

/** One-line, human-readable form of a call's arguments: `"user by id"`, or the file path. */
export function describeArgs(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    const main = a.query ?? a.name ?? a.path;
    return typeof main === "string" ? `"${main}"` : "";
  } catch {
    return ""; // truncated JSON in the log
  }
}

export function flashText(e: UsageEntry): string {
  return `$(eye) Brain ◉ ${e.client} · ${e.tool}`;
}

export interface ActivityItem {
  label: string;
  description: string;
  tooltip: string;
  error: boolean;
}

/** Rows for the Agent Activity view. The first row summarises, the rest are calls, newest first. */
export function activityItems(u: UsageSummary | null): ActivityItem[] {
  if (!u || u.total === 0) {
    return [{
      label: "No agent has used the brain yet",
      description: "",
      tooltip: "Use “Brain: Copy MCP Config” to connect Claude Code or Cursor. Copilot agent mode is registered automatically.",
      error: false,
    }];
  }
  const clients = Object.entries(u.byClient).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join(", ");
  const items: ActivityItem[] = [{ label: `${u.total} call${u.total === 1 ? "" : "s"}`, description: clients, tooltip: "Calls agents made to the brain tools (last 30 days)", error: false }];
  for (const e of u.recent) {
    const args = describeArgs(e.args);
    items.push({
      label: `${e.tool}${args ? " " + args : ""}`,
      description: `${e.client} · ${Math.round(e.latencyMs)} ms · ~${e.resultTokens} tok`,
      tooltip: `${e.ts}\n${e.client}\n${e.tool} ${e.args}\n~${e.resultTokens} tokens returned${e.isError ? "\nFAILED" : ""}`,
      error: e.isError,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Review queue and validation
// ---------------------------------------------------------------------------

export interface ReviewRow {
  target: string;
  label: string;
  description: string;
  tooltip: string;
  stale: boolean;
}

/** Rows for the Review Queue view. The server sorts newest first. */
export function reviewRows(items: PendingItem[]): ReviewRow[] {
  return items.map((i) => {
    const flags = [i.stale ? "code changed since" : "", i.replacesReviewed ? "replaces reviewed doc" : ""].filter(Boolean);
    return {
      target: i.target,
      label: i.target,
      description: [i.kind, i.model ?? i.generatedBy, ...flags].join(" · "),
      tooltip: `${i.description}\n\nWritten by ${i.generatedBy}${i.generatedAt ? ` at ${i.generatedAt}` : ""}\n${i.draftFile}${i.stale ? "\n\nThe code changed after this draft was written." : ""}`,
      stale: i.stale,
    };
  });
}

// ---------------------------------------------------------------------------
// Approving many drafts at once
// ---------------------------------------------------------------------------

export type BulkScopeId = "fresh" | "all" | "folders" | "pick";
export interface BulkScope {
  id: BulkScopeId;
  label: string;
  description: string;
  /** What this choice approves; for "folders" and "pick" the person narrows it down next. */
  items: PendingItem[];
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** A draft that adds a new doc for code that has not changed since: the safe kind to approve together. */
export const isPlainDraft = (i: PendingItem) => !i.stale && !i.replacesReviewed;

/**
 * The ways to approve a lot of drafts, safest first. The first one leaves out drafts whose code changed since they were
 * written and drafts that would replace a doc someone already reviewed, because those are the ones worth a look.
 */
export function bulkScopes(items: PendingItem[]): BulkScope[] {
  const plain = items.filter(isPlainDraft);
  const out: BulkScope[] = [];
  if (plain.length) out.push({ id: "fresh", label: `All new drafts for unchanged code (${plain.length})`, description: items.length === plain.length ? "" : `leaves out ${plural(items.length - plain.length, "draft")} to look at`, items: plain });
  out.push({ id: "folders", label: "Choose folders…", description: "approve everything in the folders you tick", items });
  out.push({ id: "pick", label: "Choose drafts…", description: "tick them one by one", items });
  if (items.length !== plain.length) out.push({ id: "all", label: `Everything (${items.length})`, description: `including ${plural(items.length - plain.length, "draft")} whose code changed or that replace a reviewed doc`, items });
  return out;
}

export interface FolderGroup {
  folder: string;
  items: PendingItem[];
}

/** Drafts grouped by the folder of the code they describe, largest first. A module's own doc sits in its own folder's group. */
export function folderGroups(items: PendingItem[]): FolderGroup[] {
  const groups = new Map<string, PendingItem[]>();
  for (const i of items) {
    const parts = i.target.split("/");
    const folder = i.kind === "module" ? i.target : parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    (groups.get(folder) ?? groups.set(folder, []).get(folder)!).push(i);
  }
  return [...groups].map(([folder, list]) => ({ folder, items: list })).sort((a, b) => b.items.length - a.items.length || a.folder.localeCompare(b.folder));
}

/** What the person is asked before approving many at once: what it means, and what is different about some of them. */
export function bulkConfirmation(items: PendingItem[], by: string): { message: string; detail: string; button: string } {
  const stale = items.filter((i) => i.stale).length;
  const replaces = items.filter((i) => i.replacesReviewed).length;
  const lines = [
    `This records ${plural(items.length, "generated document")} as reviewed by ${by}.`,
    "Each one is marked approved_in_bulk in its front matter, so it can be told apart from one you read.",
  ];
  if (stale) lines.push(`${plural(stale, "draft")} describe code that changed after they were written.`);
  if (replaces) lines.push(`${plural(replaces, "draft")} replace a document someone already reviewed.`);
  lines.push("Open a few first if you have not read any.");
  return { message: `Approve ${plural(items.length, "draft")}?`, detail: lines.join("\n"), button: `Approve ${items.length}` };
}

export function bulkResultMessage(action: "approve" | "reject", done: number, failed: { target: string; error: string }[]): string {
  const verb = action === "approve" ? "Approved" : "Rejected";
  return failed.length ? `${verb} ${done}; ${failed.length} could not be ${action === "approve" ? "approved" : "rejected"} (see the Brain output).` : `${verb} ${plural(done, "draft")}.`;
}

/** Plain-text report for the output channel, errors first. */
export function validationReport(r: ValidationResult): string[] {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const lines = [`Knowledge bundle: ${r.concepts} concept${r.concepts === 1 ? "" : "s"}, ${r.conformant ? "conformant OKF" : "NOT conformant OKF"}`];
  const sorted = [...r.issues].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));
  for (const i of sorted) lines.push(`  ${i.severity.toUpperCase().padEnd(7)} ${i.file}: ${i.message}`);
  if (r.issues.length === 0) lines.push("  No issues.");
  return lines;
}

export function validationSummary(r: ValidationResult): string {
  const n = (s: string) => r.issues.filter((i) => i.severity === s).length;
  return `${r.conformant ? "Conformant" : "Not conformant"}: ${n("error")} errors, ${n("warning")} warnings, ${n("info")} notes`;
}

// ---------------------------------------------------------------------------
// Server-side doc generation: what the person sees before, during and after
// ---------------------------------------------------------------------------

const dollars = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? "<$0.01" : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K` : String(n));

/** The text of the confirmation dialog: every number labelled an estimate, and what happens to the result. */
export function estimateDetail(e: Estimate): string {
  const t = e.totals;
  const lines = [
    `${t.targets} file${t.targets === 1 ? "" : "s"} and module${t.targets === 1 ? "" : "s"}, about ${tokens(t.inputTokens)} tokens in and ${tokens(t.outputTokens)}+ out (estimates).`,
    t.costUsd === null
      ? `Cost: unknown. ${e.model ?? "This model"} has no price set.`
      : t.costUsd.high === 0
        ? "Cost: nothing (a local model)."
        : `Cost: about ${dollars(t.costUsd.low)} to ${dollars(t.costUsd.high)} with ${e.model} (an estimate; reasoning models can use more).`,
  ];
  if (e.budget.capUsd !== null) lines.push(`Budget: ${dollars(e.budget.spentUsd)} spent of ${dollars(e.budget.capUsd)}. It stops before a document could go over.`);
  for (const w of e.warnings) lines.push(w);
  lines.push("Every result is a draft that you review before it is kept.");
  return lines.join("\n\n");
}

export const estimateTitle = (e: Estimate) =>
  `Write ${e.totals.targets} doc${e.totals.targets === 1 ? "" : "s"} with ${e.model ?? e.mode}${e.totals.costUsd && e.totals.costUsd.high > 0 ? ` (about ${dollars(e.totals.costUsd.low)} to ${dollars(e.totals.costUsd.high)})` : ""}?`;

export function generationBarText(g: GenerationState): string | null {
  if (g.state !== "running" && g.state !== "cancelling") return null;
  return g.state === "cancelling" ? "$(sync~spin) Brain: cancelling" : `$(sync~spin) Brain: generating ${g.done}/${g.total}`;
}

export function generationProgress(g: GenerationState): string {
  const cost = g.spendUsd > 0 ? ` · ${dollars(g.spendUsd)}` : "";
  return `${g.done}/${g.total}${g.current ? ` · ${g.current}` : ""}${cost}`;
}

/** The message shown when a job ends, and how loudly to say it. */
export function generationSummary(g: GenerationState): { text: string; level: "info" | "warning" | "error" } {
  const money = g.spendUsd > 0 ? ` for ${dollars(g.spendUsd)}` : "";
  const wrote = `Wrote ${g.drafted} draft${g.drafted === 1 ? "" : "s"}${money}.`;
  if (g.state === "done") {
    return g.failed ? { text: `${wrote} ${g.failed} had problems: see the App Brain output.`, level: "warning" } : { text: `${wrote} Review them in the Review Queue.`, level: "info" };
  }
  if (g.stopReason === "cancelled") return { text: `Cancelled. ${wrote}`, level: "info" };
  if (g.stopReason === "budget") return { text: `${g.message ?? "Stopped at the budget."} ${wrote}`, level: "warning" };
  if (g.stopReason === "auth") return { text: g.message ?? "The API key was rejected.", level: "error" };
  return { text: `${g.message ?? "Stopped."} ${wrote}`, level: "error" };
}

/** One line per problem, for the output channel. */
export function generationProblems(g: GenerationState): string[] {
  return g.results.filter((r) => r.outcome !== "drafted").map((r) => `${r.outcome.toUpperCase().padEnd(9)} ${r.target}: ${r.message ?? ""}`);
}

// ---------------------------------------------------------------------------
// Testing the LLM connection
// ---------------------------------------------------------------------------

const REACH_TEXT = { "this-machine": "on this machine", "local-network": "on your network", internet: "on the internet" } as const;

/** What to tell the person after "Test LLM Connection": a headline, how loud, and the full story for the output channel. */
export function llmTestSummary(r: LlmTestResult): { text: string; level: "info" | "warning" | "error"; lines: string[] } {
  const where = r.reach ? ` ${REACH_TEXT[r.reach]}` : "";
  const lines = [
    `LLM test (${r.mode}${r.model ? `, ${r.model}` : ""}${r.endpoint ? `, ${r.endpoint}` : ""})`,
    ...(r.reach ? [`  Your code goes to a server ${REACH_TEXT[r.reach]}.`] : []),
    ...(r.latencyMs !== null ? [`  Answered in ${(r.latencyMs / 1000).toFixed(1)}s${r.answeredBy ? ` by ${r.answeredBy}` : ""}${r.reply ? `: “${r.reply}”` : ""}.`] : []),
    ...(r.inputTokens !== null ? [`  Tokens: ${r.inputTokens} in, ${r.outputTokens ?? "?"} out (${r.tokensSource?.replace("-", " ") ?? "unknown source"}).`] : []),
    ...(r.contextTokens !== null ? [`  Prompts are sized for a ${r.contextTokens}-token context window.`] : []),
    ...(r.modelsAvailable ? [`  Models on the server: ${r.modelsAvailable.length ? r.modelsAvailable.join(", ") : "none"}.`] : []),
    ...r.problems.map((p) => `  PROBLEM: ${p}`),
    ...r.hints.map((h) => `  Hint: ${h}`),
  ];
  if (!r.ok) return { text: `The LLM is not working${where}. ${r.problems[0] ?? ""} ${r.hints[0] ?? ""}`.replace(/\s+/g, " ").trim(), level: "error", lines };
  if (r.hints.length) return { text: `The LLM works${where} (${(((r.latencyMs ?? 0) / 1000)).toFixed(1)}s), with a note: ${r.hints[0]}`, level: "warning", lines };
  return { text: `The LLM works${where}: ${r.answeredBy ?? r.model ?? "ok"} answered in ${(((r.latencyMs ?? 0) / 1000)).toFixed(1)}s.`, level: "info", lines };
}
