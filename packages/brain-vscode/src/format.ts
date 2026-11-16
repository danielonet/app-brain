import type { BrainStatus, PendingItem, UsageEntry, UsageSummary, ValidationResult } from "@app-brain/brain-protocol";

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
      `Output: ${status.outputDir}${langs ? `\n${langs}` : ""}`,
    error: false,
  };
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
