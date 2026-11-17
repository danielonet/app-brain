import * as vscode from "vscode";
import { SamplingParams, promptFromSampling, pickModel } from "./lmSampling";

export interface SamplingResult {
  model: string;
  role: "assistant";
  content: { type: "text"; text: string };
  stopReason: "endTurn";
  _meta: { usage: { inputTokens: number; outputTokens: number } };
}

/**
 * Answers the server's `sampling/createMessage` with the editor's own language model (Copilot and others).
 * VS Code shows its consent prompt the first time. Token counts are measured with the model's own
 * tokenizer and sent back in `_meta.usage`, so the cost report can say who measured them.
 */
export async function sampleWithEditorModel(params: SamplingParams, signal: AbortSignal): Promise<SamplingResult> {
  const { text: prompt, hint } = promptFromSampling(params);
  const all = await vscode.lm.selectChatModels();
  const model = pickModel(all, hint);
  if (!model) {
    throw new Error(
      all.length === 0
        ? "No VS Code language model is available. Sign in to a provider such as GitHub Copilot, or set “brain.llm.mode” to “local” in Settings to use a model on your machine."
        : `No editor model matches “${hint}”. Available: ${all.map((m) => m.id).join(", ")}.`,
    );
  }
  const cts = new vscode.CancellationTokenSource();
  const onAbort = () => cts.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: "App Brain writes documentation drafts for your code. You review each one before it is kept." },
      cts.token,
    );
    let text = "";
    for await (const chunk of response.text) text += chunk;
    const [inputTokens, outputTokens] = await Promise.all([model.countTokens(prompt), model.countTokens(text)]);
    return { model: model.id, role: "assistant", content: { type: "text", text }, stopReason: "endTurn", _meta: { usage: { inputTokens, outputTokens } } };
  } catch (e) {
    if (e instanceof vscode.LanguageModelError) {
      const why: Record<string, string> = {
        NoPermissions: "You did not allow App Brain to use the editor's language model. Run “Brain: Generate Docs” again and allow it.",
        Blocked: "The editor's model blocked this request.",
        NotFound: "The editor's model is not available any more.",
      };
      throw new Error(why[e.code] ?? e.message);
    }
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    cts.dispose();
  }
}
