import type { BrainStatus } from "@app-brain/brain-protocol";

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
  const langs = Object.entries(status.index.byLanguage)
    .sort((a, b) => b[1] - a[1])
    .map(([l, c]) => `${l}: ${c}`)
    .join(", ");
  return {
    text: `$(book) Brain: ready · ${n} file${n === 1 ? "" : "s"}`,
    tooltip: `Brain ${status.serverVersion}\nOutput: ${status.outputDir}${langs ? `\n${langs}` : ""}`,
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
