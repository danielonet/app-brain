import type { DocStatusItem, UsageSummary } from "@app-brain/brain-protocol";

/** Pure (no `vscode` import) so what the coverage view, the CodeLens and the connection check say is tested. */

export type Status = DocStatusItem["status"];
const ORDER: Status[] = ["stale", "draft", "none", "reviewed"];
const LABEL: Record<Status, string> = { stale: "Stale: code changed since review", draft: "Drafts waiting for review", none: "No documentation", reviewed: "Reviewed" };
const ICON: Record<Status, string> = { stale: "warning", draft: "note", none: "circle-slash", reviewed: "pass" };
export const statusIcon = (s: Status) => ICON[s];

export interface CoverageGroup { status: Status; label: string; items: DocStatusItem[] }

/** Needs-attention first, reviewed last. Modules before files, then by path. Empty groups are left out. */
export function coverageGroups(items: DocStatusItem[]): CoverageGroup[] {
  return ORDER.map((status) => ({
    status, label: LABEL[status],
    items: items.filter((i) => i.status === status).sort((a, b) => (a.kind === b.kind ? a.target.localeCompare(b.target) : a.kind === "module" ? -1 : 1)),
  })).filter((g) => g.items.length > 0);
}

/** One line for the top of the view: how much of the code a person has reviewed documentation for. */
export function coverageSummary(items: DocStatusItem[]): string {
  if (items.length === 0) return "Nothing to document yet. Run Brain: Reindex Workspace.";
  const reviewed = items.filter((i) => i.status === "reviewed").length;
  const stale = items.filter((i) => i.status === "stale").length;
  return `${reviewed} of ${items.length} reviewed (${Math.round((reviewed / items.length) * 100)}%)` + (stale ? `, ${stale} stale` : "");
}

export interface Lens { title: string; tooltip: string; command: "openDoc" | "generate" }

/**
 * What to show above a file: only when there is something for a person to do. A reviewed, current doc says nothing,
 * so a well-documented codebase is not covered in noise.
 */
export function lensFor(item: DocStatusItem | undefined): Lens | null {
  if (!item || item.kind !== "file") return null;
  switch (item.status) {
    case "stale": return { title: "$(warning) Brain doc is stale", tooltip: "This file changed after its documentation was reviewed. Open the doc.", command: "openDoc" };
    case "draft": return { title: "$(note) Brain draft waiting for review", tooltip: "A generated doc for this file has not been reviewed yet.", command: "openDoc" };
    case "none": return { title: "$(circle-slash) No Brain doc", tooltip: "Nothing documents this file yet. Run Brain: Generate Docs.", command: "generate" };
    default: return null;
  }
}

export interface ConnectionReport {
  level: "ok" | "none";
  title: string;
  lines: string[];
}

/**
 * Whether an agent is actually using the brain. Connected means a session is open right now (the extension's own is not
 * an agent); used means it made a call. The two differ: an agent can be configured and never ask.
 */
export function connectionReport(clients: { name: string | null; admin: boolean }[], usage: UsageSummary | null): ConnectionReport {
  const agents = clients.filter((c) => !c.admin).map((c) => c.name ?? "an unnamed client");
  const used = usage ? Object.entries(usage.byClient).sort((a, b) => b[1] - a[1]) : [];
  const lines: string[] = [];
  if (agents.length) lines.push(`Connected now: ${[...new Set(agents)].join(", ")}.`);
  if (used.length) lines.push(`Has called the brain: ${used.map(([n, c]) => `${n} (${c} ${c === 1 ? "call" : "calls"})`).join(", ")}.`);
  const last = usage?.recent[0];
  if (last) lines.push(`Latest call: ${last.tool} by ${last.client ?? "an unnamed client"} at ${last.ts.replace("T", " ").slice(0, 19)}.`);
  if (agents.length || used.length) return { level: "ok", title: "An agent is connected to the brain.", lines };
  return { level: "none", title: "No agent has connected yet.", lines: ["Claude Code, Cursor and Copilot reach the brain through an MCP entry in their config. Copy one for Claude Code, or open Copilot agent mode: the extension registers the server there by itself."] };
}
