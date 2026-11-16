import type { LlmTestResult } from "@app-brain/brain-protocol";
import type { LlmSetup } from "./factory";
import { classifyHost, guessServer } from "./host";
import { OpenAiCompatProvider } from "./openai";
import { LlmError } from "./types";

const empty = (setup: LlmSetup): LlmTestResult => ({
  ok: false, mode: setup.mode, model: setup.model, answeredBy: null, endpoint: null, reach: null, latencyMs: null,
  inputTokens: null, outputTokens: null, tokensSource: null, reply: null, modelsAvailable: null, modelFound: null,
  contextTokens: setup.provider?.limits.contextTokens ?? null, problems: [], hints: [],
});

/** Ollama lists `llama3.1:latest` for a model people configure as `llama3.1`. */
export const modelListed = (wanted: string, available: string[]) =>
  available.some((id) => id === wanted || id === `${wanted}:latest` || id.startsWith(`${wanted}:`));

const SERVER_HINT: Record<string, string> = {
  ollama: "Is Ollama running? Start it with `ollama serve`, then check the URL.",
  "lm-studio": "Is LM Studio's local server running? Start it from the Developer tab, and load a model.",
  "llama-cpp": "Is `llama-server` running? Check the port it was started with.",
};

/**
 * Tries the configured LLM with a tiny request and explains what it found. Costs nothing for a local model and a fraction
 * of a cent for a paid API. A failure comes back as problems and hints, not as an exception: that is the answer.
 */
export async function testLlm(setup: LlmSetup, signal?: AbortSignal): Promise<LlmTestResult> {
  const r = empty(setup);
  const p = setup.provider;
  if (!p) {
    r.problems.push(setup.problem ?? "The LLM is not configured.");
    return r;
  }
  const finish = (): LlmTestResult => {
    const ctx = p.limits.contextTokens;
    if (ctx !== null && ctx < 4096) r.hints.push(`The context window is set to ${ctx} tokens, so long files will be cut. Raise it in your server and in “brain.llm.local.contextTokens”. (Ollama: OLLAMA_CONTEXT_LENGTH, or \`PARAMETER num_ctx\` in a Modelfile.)`);
    if (r.reach && r.reach !== "this-machine" && setup.mode === "local") r.hints.push(r.reach === "internet" ? "This URL is on the internet, so this is not a local model: your code would leave your network." : "This URL is on your network, not this machine.");
    r.ok = r.problems.length === 0;
    return r;
  };
  r.endpoint = p.endpoint;
  r.reach = p.endpoint ? (classifyHost(p.endpoint)?.reach ?? null) : null;
  const kind = p.endpoint ? guessServer(p.endpoint) : null;
  const unreachable = (message: string) => {
    r.problems.push(message);
    if (kind) r.hints.push(SERVER_HINT[kind]);
    else if (setup.mode === "local") r.hints.push("Check that the server is running and that “brain.llm.baseUrl” is its OpenAI-compatible URL (it usually ends in /v1).");
  };

  if (p instanceof OpenAiCompatProvider) {
    try {
      r.modelsAvailable = await p.listModels(signal);
      r.modelFound = p.model ? modelListed(p.model, r.modelsAvailable) : null;
      if (r.modelsAvailable.length === 0) r.hints.push("The server lists no models. Load or pull one first.");
      else if (r.modelFound === false) {
        r.problems.push(`The server does not have a model called “${p.model}”.`);
        r.hints.push(`It has: ${r.modelsAvailable.slice(0, 12).join(", ")}${r.modelsAvailable.length > 12 ? ", …" : ""}. Run “Brain: Choose Local Model” to pick one.`);
        if (kind === "ollama") r.hints.push(`To get it: \`ollama pull ${p.model}\`.`);
      }
    } catch (e) {
      if (e instanceof LlmError && (e.kind === "network" || e.kind === "timeout")) {
        unreachable(e.message);
        return finish(); // nothing will answer the real request either
      }
      r.hints.push(`The server did not list its models (${(e as Error).message}); trying a request anyway.`);
    }
  }

  const t0 = Date.now();
  try {
    const res = await p.generate({ system: "You are testing a connection. Answer as briefly as possible.", user: "Reply with the single word: ready", maxTokens: Math.min(256, p.limits.maxOutputTokens), signal });
    r.latencyMs = Date.now() - t0;
    r.answeredBy = res.model;
    r.inputTokens = res.inputTokens;
    r.outputTokens = res.outputTokens;
    r.tokensSource = res.tokensSource;
    r.reply = res.text.trim().slice(0, 80) || null;
    if (res.stopReason === "refusal") r.problems.push("The model declined the test request.");
    else if (res.stopReason === "max_tokens" && !r.reply) r.hints.push("It answered but spent its whole (tiny) allowance on thinking. The connection works; documents get a larger allowance.");
    else if (!r.reply) r.problems.push("The model answered with nothing.");
    if (setup.mode === "local" && r.latencyMs > 30_000) r.hints.push(`That took ${Math.round(r.latencyMs / 1000)}s for one word. Writing a document will be slow; a smaller model may suit better.`);
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError((e as Error).message, "unknown");
    if (err.kind === "network" || err.kind === "timeout") unreachable(err.message);
    else r.problems.push(err.message);
    if (err.kind === "bad_request" && err.status === 404 && kind === "ollama") r.hints.push("Ollama answers 404 for a model it has not pulled.");
  }

  return finish();
}

/** The models a local server offers, for the picker. */
export async function listLlmModels(setup: LlmSetup, signal?: AbortSignal): Promise<{ models: string[]; endpoint: string; current: string | null }> {
  const p = setup.provider;
  if (!(p instanceof OpenAiCompatProvider)) throw new Error(setup.provider ? "Listing models is only available for a local server (mode “local”)." : (setup.problem ?? "The LLM is not configured."));
  return { models: await p.listModels(signal), endpoint: p.baseUrl, current: p.model };
}
