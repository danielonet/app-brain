import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  Estimate, GENERATION_OUTCOMES, GenerationScope, GenerationScopeSchema, GenerationState, GenerationStateSchema,
} from "@app-brain/brain-protocol";
import { callCost, summarize } from "../cost";
import { LlmError } from "../llm/types";
import type { LlmSetup } from "../llm/factory";
import { redactSecrets } from "../llm/redact";
import type { Target } from "../okf/knowledge";
import { Knowledge } from "../okf/knowledge";
import type { BrainStore } from "../store";
import type { BrainWorkspace } from "../workspace";
import { BuiltPrompt, FileContext, ModuleContext, estimateTokens, filePrompt, modulePrompt, parseOutput } from "./prompts";

/** Output a doc is expected to need, before any reasoning the model adds. */
const ASSUMED_OUTPUT = { file: 500, module: 800 } as const;
/** What the high end of an estimate allows for: reasoning models spend tokens thinking before they write. */
const HIGH_OUTPUT = { file: 3000, module: 4000 } as const;
/** The largest answer we ask for. Also the hard ceiling the budget guard prices every call at. */
const MAX_OUTPUT_TOKENS = { "api-key": 8000, "vscode-lm": 4000, local: 4000 } as const;
/** Token counts are estimated from characters; real tokenizers can run higher, so the guard allows for it. */
const INPUT_SAFETY = 1.25;
const MAX_CONSECUTIVE_FAILURES = 3;
const KEEP_RESULTS = 200;
const REASON_LABEL = { none: "none", stale: "stale", "draft-outdated": "draft-outdated" } as const;

type Item = { target: Target; reason: "none" | "stale" | "draft-outdated" };
type Built = BuiltPrompt & { inputTokens: number; redactions: number };

export interface GeneratorDeps {
  ws: BrainWorkspace;
  store: () => BrainStore;
  knowledge: Knowledge;
  /** Re-evaluated on every use: whether the editor can answer prompts depends on who is connected. */
  llm: () => LlmSetup;
  onChange: () => void;
  log?: (line: string) => void;
}

const emptyState = (): GenerationState => ({
  state: "idle", jobId: null, startedAt: null, finishedAt: null, model: null, total: 0, done: 0, drafted: 0, failed: 0, current: null,
  spendUsd: 0, tokensIn: 0, tokensOut: 0, stopReason: null, message: null, results: [],
});

/**
 * Writes documentation drafts by calling an LLM from the server. Everything it makes is an unreviewed draft,
 * exactly like an agent's `save_summary`: a person still approves it. Sequential on purpose: a budget cap
 * means nothing if several calls are in flight, and local models and rate limits prefer one at a time.
 */
export class Generator {
  private current: GenerationState = emptyState();
  private abort: AbortController | null = null;

  constructor(private readonly d: GeneratorDeps) {}

  get state(): GenerationState {
    return this.current;
  }

  // ---- prompts ---------------------------------------------------------------------------------------------

  private async build(item: Item): Promise<Built> {
    const store = this.d.store();
    const t = item.target;
    const feedback = await this.d.knowledge.feedbackFor(t.target);
    let built: BuiltPrompt;
    let redactions = 0;

    if (t.kind === "file") {
      const raw = await fs.readFile(path.join(this.d.ws.root, ...t.target.split("/")), "utf8");
      const clean = redactSecrets(raw);
      redactions = clean.redactions;
      const imports = await Promise.all(
        [...new Set(store.neighbours(t.target, "out").map((e) => e.to))].slice(0, 12).map(async (p) => ({ path: p, description: await this.d.knowledge.describe("file", p) })),
      );
      const ctx: FileContext = {
        path: t.target,
        language: store.graphFiles().find((f) => f.path === t.target)?.lang ?? "unknown",
        source: clean.text,
        symbols: store.symbolDetails(t.target, 80).map((s) => ({ name: s.qualified_name, kind: s.kind, signature: redactSecrets(s.signature).text, doc: s.docstring ? redactSecrets(s.docstring).text : null })),
        imports,
        usedBy: [...new Set(store.neighbours(t.target, "in").map((e) => e.from))].slice(0, 12),
        feedback,
      };
      built = filePrompt(ctx);
    } else {
      const under = store.filesUnder(t.target === "." ? "" : t.target).map((f) => f.path);
      const direct = under.filter((p) => path.posix.dirname(p) === (t.target === "." ? "." : t.target));
      const subdirs = [...new Set(under.map((p) => p.slice(t.target === "." ? 0 : t.target.length + 1).split("/")).filter((s) => s.length > 1).map((s) => s[0]))];
      const dep = this.d.knowledge.dependencyTargets(t);
      const ctx: ModuleContext = {
        path: t.target,
        files: await Promise.all(direct.slice(0, 40).map(async (p) => ({ path: p, description: await this.d.knowledge.describe("file", p) }))),
        submodules: await Promise.all(subdirs.slice(0, 30).map(async (s) => {
          const sub = t.target === "." ? s : `${t.target}/${s}`;
          return { path: sub, description: await this.d.knowledge.describe("module", sub) };
        })),
        dependsOn: dep.dependsOn, usedBy: dep.usedBy, feedback,
      };
      built = modulePrompt(ctx);
    }
    return { ...built, inputTokens: estimateTokens(built.system) + estimateTokens(built.user), redactions };
  }

  // ---- estimate --------------------------------------------------------------------------------------------

  /** What a job would read and cost. Calls no model; every number is labelled an estimate. */
  async estimate(scopeIn: Partial<GenerationScope> = {}): Promise<Estimate> {
    const scope = GenerationScopeSchema.parse(scopeIn);
    const setup = this.d.llm();
    const config = await this.d.ws.readConfig();
    const items = await this.d.knowledge.plan(scope);
    const model = setup.model;
    const rows: Estimate["targets"] = [];
    let inTotal = 0, outTotal = 0, lowUsd = 0, highUsd = 0;
    for (const item of items) {
      const b = await this.build(item).catch(() => null);
      if (!b) continue; // the file vanished since the last scan; the next index run settles it
      const out = ASSUMED_OUTPUT[item.target.kind];
      inTotal += b.inputTokens;
      outTotal += out;
      lowUsd += this.usd(config.pricing, model, setup.mode, b.inputTokens, out) ?? 0;
      highUsd += this.usd(config.pricing, model, setup.mode, Math.ceil(b.inputTokens * INPUT_SAFETY), HIGH_OUTPUT[item.target.kind]) ?? 0;
      if (rows.length < KEEP_RESULTS) rows.push({ target: item.target.target, kind: item.target.kind, reason: REASON_LABEL[item.reason], inputTokens: b.inputTokens, outputTokens: out });
    }
    const spent = summarize(this.d.store().llmCallRows(), config).totals.spendUsd;
    const cap = config.docs.maxCostUsd;
    const priced = this.priced(config.pricing, model, setup.mode);

    const warnings: string[] = [];
    let blocked: string | null = setup.provider ? null : setup.problem;
    if (!blocked && rows.length === 0) blocked = "Nothing to generate: every file and module already has a current doc or a draft.";
    if (!blocked && cap !== null && !priced) blocked = `A budget cap of $${cap} is set, but ${model ?? "this model"} has no price, so the cap cannot be enforced. Set its price in “Model prices and budget”, or clear the cap.`;
    if (!blocked && cap !== null && spent >= cap) blocked = `The budget cap ($${cap.toFixed(2)}) is already reached ($${spent.toFixed(2)} spent).`;
    if (!priced && setup.provider) warnings.push(`${model ?? "This model"} has no price set, so the cost is unknown. Set it under “Model prices and budget” to see dollars.`);
    if (setup.mode === "vscode-lm") warnings.push("Uses your editor's language model. Token counts will be estimates, and VS Code may ask for your consent first.");
    if (setup.mode === "api-key") warnings.push("Source code is sent to Anthropic's API. Secrets that look like keys are removed first, but check the files you are about to send.");
    if (setup.mode === "local") warnings.push("Runs on your local model; nothing leaves this machine.");
    if (cap !== null && priced && highUsd > Math.max(0, cap - spent)) warnings.push(`The estimate may exceed the remaining budget ($${Math.max(0, cap - spent).toFixed(2)}); the job will stop before any document could go over the cap.`);

    return {
      mode: setup.mode, model, targets: rows,
      totals: { targets: items.length, inputTokens: inTotal, outputTokens: outTotal, costUsd: priced ? { low: round(lowUsd), high: round(highUsd) } : null },
      tokensAreEstimates: true,
      budget: { capUsd: cap, spentUsd: spent, remainingUsd: cap === null ? null : Math.max(0, round(cap - spent)) },
      warnings, canStart: blocked === null, blocked,
    };
  }

  private priced(pricing: Record<string, unknown>, model: string | null, mode: string) {
    return mode === "local" || (model !== null && Boolean(pricing[model]));
  }
  private usd(pricing: Parameters<typeof callCost>[0], model: string | null, mode: string, inTok: number, outTok: number): number | null {
    if (mode === "local") return 0;
    return model ? callCost(pricing, model, { inputTokens: inTok, outputTokens: outTok }) : null;
  }

  // ---- the job ---------------------------------------------------------------------------------------------

  /** Starts a job and returns at once; progress is in `state`. Only one job runs at a time. */
  async start(scopeIn: Partial<GenerationScope> = {}): Promise<GenerationState> {
    if (this.current.state === "running" || this.current.state === "cancelling") throw new Error("A generation job is already running. Cancel it first, or wait for it to finish.");
    const est = await this.estimate(scopeIn);
    if (!est.canStart) throw new Error(est.blocked ?? "Generation cannot start.");
    const scope = GenerationScopeSchema.parse(scopeIn);
    const items = await this.d.knowledge.plan(scope);
    this.abort = new AbortController();
    this.current = {
      ...emptyState(), state: "running", jobId: randomUUID(), startedAt: new Date().toISOString(), model: est.model, total: items.length,
    };
    this.d.onChange();
    void this.run(items, this.abort.signal).catch((e) => {
      this.d.log?.(`generation crashed: ${(e as Error).stack ?? e}`);
      this.finish("failed", null, `Generation failed: ${(e as Error).message}`);
    });
    return this.current;
  }

  cancel(): GenerationState {
    if (this.current.state === "running") {
      this.current = { ...this.current, state: "cancelling" };
      this.abort?.abort();
      this.d.onChange();
    }
    return this.current;
  }

  private finish(state: "done" | "stopped" | "failed", stopReason: GenerationState["stopReason"], message: string | null) {
    this.current = { ...this.current, state, stopReason, message, current: null, finishedAt: new Date().toISOString() };
    this.abort = null;
    this.d.onChange();
  }

  private record(target: Target, outcome: (typeof GENERATION_OUTCOMES)[number], message: string | null, usage: { costUsd?: number | null; tokensIn?: number | null; tokensOut?: number | null } = {}) {
    const s = this.current;
    this.current = {
      ...s, done: s.done + 1,
      drafted: s.drafted + (outcome === "drafted" ? 1 : 0),
      failed: s.failed + (outcome === "drafted" || outcome === "skipped" ? 0 : 1),
      spendUsd: round(s.spendUsd + (usage.costUsd ?? 0)),
      tokensIn: s.tokensIn + (usage.tokensIn ?? 0), tokensOut: s.tokensOut + (usage.tokensOut ?? 0),
      results: [...s.results, { target: target.target, kind: target.kind, outcome, message, costUsd: usage.costUsd ?? null, tokensIn: usage.tokensIn ?? null, tokensOut: usage.tokensOut ?? null }].slice(-KEEP_RESULTS),
    };
    this.d.onChange();
  }

  private async run(items: Item[], signal: AbortSignal) {
    let failures = 0;
    for (const item of items) {
      if (signal.aborted) return this.finish("stopped", "cancelled", "Cancelled. Drafts already written are kept.");
      const setup = this.d.llm();
      const provider = setup.provider;
      if (!provider) return this.finish("stopped", "provider", setup.problem ?? "The LLM is no longer available.");
      const config = await this.d.ws.readConfig();
      const t = item.target;

      let built: Built;
      try {
        built = await this.build(item);
      } catch (e) {
        this.record(t, "skipped", `Could not read it: ${(e as Error).message}`);
        continue;
      }

      // Budget: price this call at its worst case (every token it may be asked to write), and stop rather than risk going over.
      const cap = config.docs.maxCostUsd;
      if (cap !== null) {
        const spent = summarize(this.d.store().llmCallRows(), config).totals.spendUsd;
        const worst = this.usd(config.pricing, provider.model, provider.mode, Math.ceil(built.inputTokens * INPUT_SAFETY), MAX_OUTPUT_TOKENS[provider.mode]) ?? 0;
        if (spent + worst > cap) {
          return this.finish("stopped", "budget", `Stopped before ${t.target}: it could cost up to $${worst.toFixed(2)} and only $${Math.max(0, cap - spent).toFixed(2)} of the $${cap.toFixed(2)} budget is left.`);
        }
      }

      this.current = { ...this.current, current: t.target };
      this.d.onChange();

      let res;
      try {
        res = await provider.generate({ system: built.system, user: built.user, maxTokens: MAX_OUTPUT_TOKENS[provider.mode], signal });
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError((e as Error).message, "unknown");
        if (err.kind === "cancelled" || signal.aborted) return this.finish("stopped", "cancelled", "Cancelled. Drafts already written are kept.");
        if (err.kind === "auth") {
          this.record(t, "error", err.message);
          return this.finish("stopped", "auth", err.message);
        }
        if (err.kind === "unsupported") {
          this.record(t, "error", err.message);
          return this.finish("stopped", "provider", err.message);
        }
        this.record(t, "error", err.message);
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return this.finish("stopped", "errors", `Stopped after ${failures} failures in a row. The last one: ${err.message}`);
        continue;
      }
      failures = 0;

      const usage = { inputTokens: res.inputTokens, outputTokens: res.outputTokens, cachedTokens: res.cachedTokens };
      const cost = provider.mode === "local" ? 0 : callCost(config.pricing, res.model, usage) ?? callCost(config.pricing, provider.model ?? res.model, usage);
      // A call that produced nothing usable still cost tokens: it goes in the cost record, marked as an error.
      const logFailed = () => this.d.store().logLlmCall({
        target: t.target, kind: t.kind, provider: provider.provider, model: res.model, mode: provider.mode,
        inputTokens: res.inputTokens, outputTokens: res.outputTokens, cachedTokens: res.cachedTokens, tokensSource: res.tokensSource,
        costUsd: cost, costSource: cost === null ? null : provider.mode === "local" ? "local" : "price-table", outcome: "error",
      });
      const spendInfo = { costUsd: cost, tokensIn: res.inputTokens, tokensOut: res.outputTokens };

      if (res.stopReason === "refusal") {
        logFailed();
        this.record(t, "refused", "The model declined to answer this one (its safety classifiers). Nothing was saved; try another model or write it by hand.", spendInfo);
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return this.finish("stopped", "errors", `Stopped after ${failures} failures in a row.`);
        continue;
      }
      if (res.stopReason === "max_tokens") {
        logFailed();
        this.record(t, "truncated", "The answer was cut off at the output limit, so it was not saved.", spendInfo);
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return this.finish("stopped", "errors", `Stopped after ${failures} failures in a row.`);
        continue;
      }
      const parsed = parseOutput(res.text);
      if (!parsed) {
        logFailed();
        this.record(t, "error", "The model's answer was empty or not usable, so it was not saved.", spendInfo);
        if (++failures >= MAX_CONSECUTIVE_FAILURES) return this.finish("stopped", "errors", `Stopped after ${failures} failures in a row.`);
        continue;
      }

      try {
        const saved = await this.d.knowledge.saveSummary({
          target: t.target, kind: t.kind, description: parsed.description, summary: parsed.body, model: res.model, client: "brain-mcp",
          generation: { mode: provider.mode, provider: provider.provider, tokensIn: res.inputTokens, tokensOut: res.outputTokens, cachedTokens: res.cachedTokens, tokensSource: res.tokensSource, inputTruncated: built.truncated, redactions: built.redactions },
        });
        this.record(t, "drafted", built.truncated ? "Drafted, from a source file that was too long and had its middle cut." : null, { ...spendInfo, costUsd: saved.costUsd });
      } catch (e) {
        logFailed();
        this.record(t, "error", `Could not save the draft: ${(e as Error).message}`, spendInfo);
      }
    }
    const s = this.current;
    this.finish("done", null, s.failed ? `Finished with ${s.failed} problem${s.failed === 1 ? "" : "s"}.` : "Finished.");
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
void GenerationStateSchema;
