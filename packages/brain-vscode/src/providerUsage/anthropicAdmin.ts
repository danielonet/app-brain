import type { AnthropicOrgUsage } from "@app-brain/brain-protocol";
import { Pricing, TokenCounts, billedKey, buildBlock, emptyBlock, round, zeroCounts } from "./shared";

/**
 * What the Anthropic organisation behind an Admin API key used, from the (legacy) Usage and Cost Admin API:
 *   GET /v1/organizations/usage_report/messages   tokens by day and model
 *   GET /v1/organizations/cost_report             dollars by day and model (grouped by description)
 * Needs an Admin API key (sk-ant-admin...) from a Claude Console organisation; individual accounts have none.
 *
 * This is the whole organisation, not this repository: nothing here can say which calls were about this code.
 * The key is sent only to api.anthropic.com, in a header, and is never put in a message, a log or an error.
 */

export const ADMIN_API_BASE = "https://api.anthropic.com";
const VERSION = "2026-10-21";
const MAX_PAGES = 10;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface Page { data?: { starting_at?: string; results?: Record<string, unknown>[] }[]; has_more?: boolean; next_page?: string | null }

function explain(status: number): string {
  if (status === 401 || status === 403) return "Anthropic refused the key. It must be an Admin API key (starts with sk-ant-admin) from a Claude Console organisation; a normal API key, a claude.ai Team plan or a personal account cannot read usage.";
  if (status === 404) return "Anthropic's usage endpoint was not found for this key or organisation.";
  if (status === 429) return "Anthropic is rate limiting usage requests. Try again in a minute.";
  if (status >= 500) return `Anthropic's usage service failed (HTTP ${status}). Try again later.`;
  return `Anthropic answered HTTP ${status}.`;
}

async function pages(f: FetchLike, key: string, base: string, endpoint: string, params: URLSearchParams): Promise<Page["data"] & object[]> {
  const out: NonNullable<Page["data"]> = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams(params);
    if (page) q.set("page", page);
    let res;
    try {
      res = await f(`${base}/v1/organizations/${endpoint}?${q}`, {
        headers: { "x-api-key": key, "anthropic-version": VERSION, "user-agent": "app-brain-vscode", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      // The message of a network error never contains the key (it is in a header), but say only what happened.
      throw new AdminApiError(`Could not reach Anthropic: ${(e as Error).name === "TimeoutError" ? "the request timed out" : (e as Error).message}`, 0);
    }
    if (!res.ok) throw new AdminApiError(explain(res.status), res.status);
    const body = (await res.json()) as Page;
    out.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) return out;
    page = body.next_page;
  }
  return out;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const day = (b: { starting_at?: string }) => (b.starting_at ?? "").slice(0, 10);

export interface FetchOptions {
  key: string;
  lookbackDays: number;
  pricing: Pricing;
  fetch?: FetchLike;
  now?: Date;
  baseUrl?: string;
}

export async function fetchAnthropicOrgUsage(o: FetchOptions): Promise<AnthropicOrgUsage> {
  const f = o.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const base = o.baseUrl ?? ADMIN_API_BASE;
  const now = o.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (o.lookbackDays - 1)));
  const common = () => new URLSearchParams({ starting_at: start.toISOString(), ending_at: now.toISOString(), limit: "31" });
  try {
    const usageParams = common(); usageParams.set("bucket_width", "1d"); usageParams.append("group_by[]", "model");
    const usage = await pages(f, o.key, base, "usage_report/messages", usageParams);

    const rows = new Map<string, { day: string; model: string; counts: TokenCounts }>();
    for (const bucket of usage) {
      for (const r of bucket.results ?? []) {
        const model = typeof r.model === "string" && r.model ? r.model : "(unknown model)";
        const d = day(bucket);
        const g = rows.get(billedKey(d, model)) ?? rows.set(billedKey(d, model), { day: d, model, counts: zeroCounts() }).get(billedKey(d, model))!;
        const cc = (r.cache_creation ?? {}) as Record<string, unknown>;
        g.counts.messages += 0; // the API reports tokens, not message counts
        g.counts.input += n(r.uncached_input_tokens);
        g.counts.cacheRead += n(r.cache_read_input_tokens);
        g.counts.cacheWrite5m += n(cc.ephemeral_5m_input_tokens);
        g.counts.cacheWrite1h += n(cc.ephemeral_1h_input_tokens);
        g.counts.output += n(r.output_tokens);
      }
    }

    // Dollars Anthropic billed, by day and model. If this fails (some credentials can read usage but not cost) the price table is used instead.
    let billed: Map<string, number> | undefined;
    let note = "";
    try {
      const costParams = common(); costParams.append("group_by[]", "description");
      const cost = await pages(f, o.key, base, "cost_report", costParams);
      billed = new Map();
      for (const bucket of cost) {
        for (const r of bucket.results ?? []) {
          if (r.currency && r.currency !== "USD") continue;
          const amount = Number(r.amount);
          if (!Number.isFinite(amount)) continue;
          const model = typeof r.model === "string" && r.model ? r.model : "(other costs)"; // web search, code execution
          const k = billedKey(day(bucket), model);
          billed.set(k, round((billed.get(k) ?? 0) + amount / 100)); // cents, as a decimal string
          if (!rows.has(k)) rows.set(k, { day: day(bucket), model, counts: zeroCounts() });
        }
      }
    } catch (e) {
      if (e instanceof AdminApiError && (e.status === 401 || e.status === 403 || e.status === 404)) { billed = undefined; note = " The cost report was not available to this key, so cost is worked out from your price table."; }
      else throw e;
    }

    const list = [...rows.values()];
    if (list.length === 0) return { ...emptyBlock("none", `Your Anthropic organisation used nothing in the last ${o.lookbackDays} days.`), costIsBilled: false };
    const block = buildBlock("ok", `The whole organisation behind this key, not just this repository.${billed ? " Cost is what Anthropic billed (Priority Tier usage is not in its cost report)." : ""}${note}`, list, o.pricing, billed);
    return { ...block, costIsBilled: billed !== undefined };
  } catch (e) {
    const message = e instanceof AdminApiError ? e.message : `Could not read Anthropic usage: ${(e as Error).message}`;
    return { ...emptyBlock("error", message), costIsBilled: false };
  }
}
