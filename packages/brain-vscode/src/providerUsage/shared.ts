import type { BrainConfig, ProviderUsageBlock, UsageByDay, UsageByModel, UsageTotals } from "@app-brain/brain-protocol";

export type Pricing = BrainConfig["pricing"];

/** What one group of calls used, split the way providers bill it. */
export interface TokenCounts {
  messages: number;
  input: number; // not served from the cache
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

export const zeroCounts = (): TokenCounts => ({ messages: 0, input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });

export function addCounts(into: TokenCounts, c: Partial<TokenCounts>): void {
  into.messages += c.messages ?? 0;
  into.input += c.input ?? 0;
  into.cacheRead += c.cacheRead ?? 0;
  into.cacheWrite5m += c.cacheWrite5m ?? 0;
  into.cacheWrite1h += c.cacheWrite1h ?? 0;
  into.output += c.output ?? 0;
}

export const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Dollars for a group of calls at the user's prices, or null when the model has no price.
 * Anthropic's published rates relative to the input price are used where the table has no number:
 * a cache read costs 0.1x, a 5 minute cache write 1.25x, a 1 hour cache write 2x.
 */
export function priceCounts(price: Pricing[string] | undefined, c: TokenCounts): number | null {
  if (!price) return null;
  const read = price.cachedPerMtok ?? price.inputPerMtok * 0.1;
  const write5m = price.cacheWritePerMtok ?? price.inputPerMtok * 1.25;
  const write1h = price.cacheWritePerMtok ?? price.inputPerMtok * 2;
  return round((c.input * price.inputPerMtok + c.cacheRead * read + c.cacheWrite5m * write5m + c.cacheWrite1h * write1h + c.output * price.outputPerMtok) / 1e6);
}

const toTotals = (c: TokenCounts, costUsd: number | null): UsageTotals => ({
  messages: c.messages, inputTokens: c.input, cacheReadTokens: c.cacheRead, cacheWriteTokens: c.cacheWrite5m + c.cacheWrite1h, outputTokens: c.output, costUsd,
});

export const emptyBlock = (state: ProviderUsageBlock["state"], message: string): ProviderUsageBlock => ({
  state, message, from: null, to: null, totals: toTotals(zeroCounts(), 0), byModel: [], byDay: [], complete: true, unpricedModels: [],
});

/**
 * Builds the report blocks from counts per (day, model). Cost comes from `billed` (a dollar amount by day and model, when the
 * provider reported one) or else from the price table. A model without a price makes the total a lower bound, and says so.
 */
export function buildBlock(
  state: ProviderUsageBlock["state"],
  message: string,
  rows: { day: string; model: string; counts: TokenCounts }[],
  pricing: Pricing,
  billed?: Map<string, number>,
): ProviderUsageBlock {
  const costOf = (r: { day: string; model: string; counts: TokenCounts }): number | null => {
    // Billed dollars are authoritative when the provider gave them: a day or model with none was not charged. Never a mix.
    if (billed) return billed.get(billedKey(r.day, r.model)) ?? 0;
    return priceCounts(pricing[r.model], r.counts);
  };
  const byModel = new Map<string, { counts: TokenCounts; cost: number; priced: boolean }>();
  const byDay = new Map<string, { counts: TokenCounts; cost: number }>();
  const unpriced = new Set<string>();
  const all = zeroCounts();
  let total = 0;

  for (const r of rows) {
    const cost = costOf(r);
    if (cost === null) unpriced.add(r.model); else total += cost;
    const m = byModel.get(r.model) ?? byModel.set(r.model, { counts: zeroCounts(), cost: 0, priced: false }).get(r.model)!;
    addCounts(m.counts, r.counts); m.cost += cost ?? 0; m.priced ||= cost !== null;
    const d = byDay.get(r.day) ?? byDay.set(r.day, { counts: zeroCounts(), cost: 0 }).get(r.day)!;
    addCounts(d.counts, r.counts); d.cost += cost ?? 0; // a day with an unpriced part keeps what is known: a lower bound
    addCounts(all, r.counts);
  }

  const days = rows.map((r) => r.day).sort();
  return {
    state, message, from: days[0] ?? null, to: days[days.length - 1] ?? null,
    totals: toTotals(all, round(total)),
    byModel: [...byModel].map(([model, m]): UsageByModel => ({ model, ...toTotals(m.counts, m.priced ? round(m.cost) : null) }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.outputTokens - a.outputTokens || a.model.localeCompare(b.model)),
    byDay: [...byDay].map(([day, d]): UsageByDay => ({ day, ...toTotals(d.counts, round(d.cost)) })).sort((a, b) => a.day.localeCompare(b.day)),
    complete: unpriced.size === 0,
    unpricedModels: [...unpriced].sort(),
  };
}

export const billedKey = (day: string, model: string) => `${day}\u0000${model}`;
