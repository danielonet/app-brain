/** Pure (no `vscode` import) so the detection rules are tested. */
export interface EditorFacts {
  /** How many chat models `vscode.lm.selectChatModels()` returned. */
  lmModels: number;
  /** `vscode.env.appName`, for example "Visual Studio Code" or "Cursor". */
  appName: string;
  /** Ids of installed extensions, any case. */
  extensionIds: string[];
}

export interface AutoChoice {
  /** The concrete mode to run: never "auto". */
  mode: "vscode-lm" | "agent";
  /** Agents found in this editor, by name, for the status text. */
  agents: string[];
  /** Why this was chosen, in words for the log and the status. */
  reason: string;
}

const AGENT_EXTENSIONS: { name: string; ids: string[] }[] = [
  { name: "Claude Code", ids: ["anthropic.claude-code"] },
  { name: "GitHub Copilot", ids: ["github.copilot-chat", "github.copilot"] },
];

export function detectAgents(f: EditorFacts): string[] {
  const have = new Set(f.extensionIds.map((i) => i.toLowerCase()));
  const found = AGENT_EXTENSIONS.filter((a) => a.ids.some((i) => have.has(i))).map((a) => a.name);
  if (/cursor/i.test(f.appName)) found.push("Cursor");
  return found;
}

/**
 * "auto" picks who writes docs without asking the person to configure anything:
 * an editor language model if one is available (Copilot and other providers), otherwise the connected agent
 * (Claude Code, Cursor, Copilot agent mode), which writes docs through save_summary. Local and API-key modes
 * are never chosen here: they send code to a server the person has to name.
 */
export function resolveAutoMode(f: EditorFacts): AutoChoice {
  const agents = detectAgents(f);
  if (f.lmModels > 0) return { mode: "vscode-lm", agents, reason: `using the editor's language model (${f.lmModels} available)` };
  return {
    mode: "agent",
    agents,
    reason: agents.length
      ? `no editor language model; ${agents.join(", ")} writes docs through the MCP connection`
      : "no editor language model and no agent found; open the LLM settings to choose a local model",
  };
}
