/**
 * Pure helpers for answering the server's sampling requests with VS Code's language models. The parts that
 * need `vscode` are in `lmBridge.ts`; these decide what to ask and which model to ask.
 */
export interface SamplingParams {
  systemPrompt?: string;
  messages: { role: string; content: { type: string; text?: string } | { type: string; text?: string }[] }[];
  maxTokens?: number;
  modelPreferences?: { hints?: { name?: string }[] };
}

/** VS Code's language-model API has no system role, so the system prompt leads the user message. */
export function promptFromSampling(p: SamplingParams): { text: string; hint: string | null } {
  const parts: string[] = [];
  if (p.systemPrompt?.trim()) parts.push(p.systemPrompt.trim());
  for (const m of p.messages) {
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    for (const b of blocks) if (b.type === "text" && b.text) parts.push(b.text);
  }
  return { text: parts.join("\n\n"), hint: p.modelPreferences?.hints?.find((h) => h.name)?.name ?? null };
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
}

/** The model the person asked for (by id, family or name), or else the first one on offer. */
export function pickModel<T extends ModelInfo>(models: T[], hint: string | null): T | null {
  if (models.length === 0) return null;
  if (!hint) return models[0];
  const h = hint.toLowerCase();
  return (
    models.find((m) => m.id.toLowerCase() === h) ??
    models.find((m) => m.family.toLowerCase() === h) ??
    models.find((m) => m.name.toLowerCase() === h) ??
    models.find((m) => [m.id, m.family, m.name].some((x) => x.toLowerCase().includes(h))) ??
    null
  );
}
