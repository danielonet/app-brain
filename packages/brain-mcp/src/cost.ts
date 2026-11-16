import * as path from "node:path";
import type { BrainConfig, CostCall, CostSummary } from "@app-brain/brain-protocol";
import type { LlmCallRow } from "./store";

type Price = BrainConfig["pricing"][string];

/**
 * Cost of one call. A recorded cost wins. A call made before its model had a price is priced now,
 * from today's table, but only when both token counts are known: a guess would be worse than "unknown".
 */
function effectiveCost(r: LlmCallRow, pricing: BrainConfig["pricing"]): { usd: number | null; source: CostCall["costSource"] } {
  if (r.cost_usd !== null) return { usd: r.cost_usd, source: "recorded" };
  const price: Price | undefined = pricing[r.model];
  if (price && r.input_tokens !== null && r.output_tokens !== null) {
    return { usd: (r.input_tokens * price.inputPerMtok + r.output_tokens * price.outputPerMtok) / 1e6, source: "current-prices" };
  }
  return { usd: null, source: null };
}

const dayOf = (ts: string) => ts.slice(0, 10);
const moduleOf = (r: LlmCallRow) => (r.kind === "module" ? r.target : path.posix.dirname(r.target));
const round = (n: number) => Math.round(n * 1e6) / 1e6; // keeps float noise out of the report

export function summarize(rows: LlmCallRow[], config: Pick<BrainConfig, "pricing" | "docs">, now: Date = new Date()): CostSummary {
  const calls = rows.map((r) => ({ r, c: effectiveCost(r, config.pricing) }));
  const spend = round(calls.reduce((n, { c }) => n + (c.usd ?? 0), 0));
  const approved = rows.filter((r) => r.outcome === "approved").length;
  const rejected = rows.filter((r) => r.outcome === "rejected").length;
  const targets = new Set(rows.map((r) => `${r.kind}:${r.target}`));

  const group = <K extends string>(key: (r: LlmCallRow) => string, field: K) => {
    const m = new Map<string, { calls: number; tokensOut: number; costUsd: number }>();
    for (const { r, c } of calls) {
      const k = key(r);
      const g = m.get(k) ?? m.set(k, { calls: 0, tokensOut: 0, costUsd: 0 }).get(k)!;
      g.calls++;
      g.tokensOut += r.output_tokens ?? 0;
      g.costUsd += c.usd ?? 0;
    }
    return [...m].map(([k, g]) => ({ [field]: k, calls: g.calls, tokensOut: g.tokensOut, costUsd: round(g.costUsd) }) as { calls: number; tokensOut: number; costUsd: number } & Record<K, string>);
  };

  const byModel = group((r) => r.model, "model").map((m) => {
    const mine = rows.filter((r) => r.model === m.model);
    const priced = calls.filter(({ r }) => r.model === m.model).every(({ c }) => c.usd !== null);
    return {
      ...m,
      approved: mine.filter((r) => r.outcome === "approved").length,
      rejected: mine.filter((r) => r.outcome === "rejected").length,
      pending: mine.filter((r) => r.outcome === "generated").length,
      tokensIn: mine.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
      priced,
      estimatedShare: mine.filter((r) => r.tokens_source === "estimated").length / mine.length,
    };
  }).sort((a, b) => b.costUsd - a.costUsd || b.tokensOut - a.tokensOut || a.model.localeCompare(b.model));

  const cap = config.docs.maxCostUsd;
  const ratio = cap && cap > 0 ? spend / cap : null;
  const unpricedModels = [...new Set(rows.filter((r) => effectiveCost(r, config.pricing).usd === null && !config.pricing[r.model]).map((r) => r.model))].sort();

  return {
    generatedAt: now.toISOString(),
    totals: {
      calls: rows.length,
      targets: targets.size,
      approved,
      rejected,
      pending: rows.filter((r) => r.outcome === "generated").length,
      regenerations: rows.length - targets.size,
      tokensIn: rows.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
      callsWithoutInputTokens: rows.filter((r) => r.input_tokens === null).length,
      tokensOut: rows.reduce((n, r) => n + (r.output_tokens ?? 0), 0),
      spendUsd: spend,
      costPerApprovedUsd: approved > 0 ? round(spend / approved) : null,
      rejectionRate: approved + rejected > 0 ? rejected / (approved + rejected) : null,
    },
    tokensSource: {
      "provider-reported": rows.filter((r) => r.tokens_source === "provider-reported").length,
      "agent-reported": rows.filter((r) => r.tokens_source === "agent-reported").length,
      estimated: rows.filter((r) => r.tokens_source === "estimated").length,
    },
    complete: calls.every(({ c }) => c.usd !== null),
    unpricedModels,
    budget: {
      capUsd: cap,
      spentUsd: spend,
      remainingUsd: cap === null ? null : round(Math.max(0, cap - spend)),
      state: ratio === null ? "none" : ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "near" : "ok",
    },
    byDay: group((r) => dayOf(r.ts), "day").sort((a, b) => a.day.localeCompare(b.day)),
    byModel,
    byMode: group((r) => r.mode, "mode").sort((a, b) => b.calls - a.calls || a.mode.localeCompare(b.mode)),
    byModule: group(moduleOf, "module").sort((a, b) => b.costUsd - a.costUsd || b.tokensOut - a.tokensOut || a.module.localeCompare(b.module)),
    recent: calls.slice(-50).reverse().map(({ r, c }) => ({
      id: r.id, ts: r.ts, target: r.target, kind: r.kind, model: r.model, mode: r.mode,
      tokensIn: r.input_tokens, tokensOut: r.output_tokens, tokensSource: r.tokens_source,
      costUsd: c.usd, costSource: c.source, outcome: r.outcome,
    })),
  };
}

// ---------------------------------------------------------------------------
// Export. Models and targets come from agents, so they are untrusted text.
// ---------------------------------------------------------------------------

/**
 * One CSV cell. Quoted, with embedded quotes doubled; and a leading `= + - @ tab CR` is neutralised
 * with an apostrophe, because spreadsheets run such cells as formulas (CSV injection).
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: LlmCallRow[], pricing: BrainConfig["pricing"]): string {
  const head = ["ts", "target", "kind", "model", "mode", "tokens_in", "tokens_out", "tokens_source", "cost_usd", "cost_source", "outcome"];
  const lines = [head.join(",")];
  for (const r of rows) {
    const c = effectiveCost(r, pricing);
    lines.push([r.ts, r.target, r.kind, r.model, r.mode, r.input_tokens, r.output_tokens, r.tokens_source, c.usd, c.source, r.outcome].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Escapes text for a Markdown table cell. */
export const mdCell = (s: string) => s.replace(/[\\`*_{}[\]<>|]/g, "\\$&").replace(/\s+/g, " ").trim();

const usd = (n: number | null) => (n === null ? "unknown" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);

export function toMarkdown(s: CostSummary): string {
  const t = s.totals;
  const out: string[] = [
    "# LLM cost report", "",
    `Generated ${s.generatedAt}. ${s.complete ? "All calls are priced." : "**Incomplete:** some calls could not be priced, so the real total is higher."}`, "",
    "## Summary", "",
    "| | |", "|---|---|",
    `| Calls | ${t.calls} |`,
    `| Documents approved / rejected / waiting | ${t.approved} / ${t.rejected} / ${t.pending} |`,
    `| Regenerations | ${t.regenerations} |`,
    `| Known spend | ${usd(t.spendUsd)} |`,
    `| Cost per approved doc | ${usd(t.costPerApprovedUsd)} |`,
    `| Rejection rate | ${pct(t.rejectionRate)} |`,
    `| Tokens in (known) / out | ${t.tokensIn} / ${t.tokensOut} |`,
    `| Calls without input tokens | ${t.callsWithoutInputTokens} |`,
    `| Token counts exact / reported by agent / estimated | ${s.tokensSource["provider-reported"]} / ${s.tokensSource["agent-reported"]} / ${s.tokensSource.estimated} |`,
  ];
  if (s.budget.capUsd !== null) out.push(`| Budget | ${usd(s.budget.spentUsd)} of ${usd(s.budget.capUsd)} (${s.budget.state}) |`);
  if (s.unpricedModels.length) out.push("", `No price set for: ${s.unpricedModels.map((m) => mdCell(m)).join(", ")}.`);
  out.push("", "## By model", "", "| Model | Calls | Approved | Rejected | Tokens out | Cost | Estimated tokens |", "|---|---|---|---|---|---|---|");
  for (const m of s.byModel) out.push(`| ${mdCell(m.model)} | ${m.calls} | ${m.approved} | ${m.rejected} | ${m.tokensOut} | ${m.priced ? usd(m.costUsd) : usd(m.costUsd) + "+ (partly unpriced)"} | ${pct(m.estimatedShare)} |`);
  out.push("", "## By day", "", "| Day | Calls | Tokens out | Cost |", "|---|---|---|---|");
  for (const d of s.byDay) out.push(`| ${d.day} | ${d.calls} | ${d.tokensOut} | ${usd(d.costUsd)} |`);
  out.push("", "## By module", "", "| Module | Calls | Tokens out | Cost |", "|---|---|---|---|");
  for (const m of s.byModule) out.push(`| ${mdCell(m.module)} | ${m.calls} | ${m.tokensOut} | ${usd(m.costUsd)} |`);
  return out.join("\n") + "\n";
}
