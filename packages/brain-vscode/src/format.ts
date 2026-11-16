import type { BrainStatus, UsageEntry, UsageSummary } from "@app-brain/brain-protocol";

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
  return {
    text: `$(book) Brain: ready · ${n} file${n === 1 ? "" : "s"} · ${sym} symbol${sym === 1 ? "" : "s"}`,
    tooltip: `Brain ${status.serverVersion}\n${sym} symbols, ${status.index.edges} import links\nOutput: ${status.outputDir}${langs ? `\n${langs}` : ""}`,
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
