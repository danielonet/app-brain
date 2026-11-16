import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AdminTools, AgentTools, CostSummarySchema, Resources, defaultConfig } from "@app-brain/brain-protocol";
import { csvCell, mdCell, summarize, toCsv, toMarkdown } from "../cost";
import type { LlmCallRow } from "../store";
import { connect, fixture, readJson, ready, tool } from "./helpers";

let nextId = 1;
const row = (o: Partial<LlmCallRow> = {}): LlmCallRow => ({
  id: nextId++, ts: "2026-11-16T10:00:00.000Z", target: "src/a.ts", kind: "file", provider: null, model: "m1", mode: "agent",
  input_tokens: 1000, output_tokens: 200, cached_tokens: null, tokens_source: "agent-reported", cost_usd: 0.01, cost_source: "price-table",
  outcome: "generated", ...o,
});
const cfg = (pricing = {}, maxCostUsd: number | null = null) => ({ pricing, docs: { ...defaultConfig().docs, maxCostUsd } });

describe("cost summary", () => {
  it("handles no calls at all", () => {
    const s = summarize([], cfg());
    assert.equal(s.totals.calls, 0);
    assert.equal(s.totals.spendUsd, 0);
    assert.equal(s.totals.costPerApprovedUsd, null);
    assert.equal(s.totals.rejectionRate, null);
    assert.equal(s.complete, true);
    assert.deepEqual([s.byDay, s.byModel, s.byModule, s.recent], [[], [], [], []]);
    assert.equal(s.budget.state, "none");
    CostSummarySchema.parse(s);
  });

  it("adds up spend, tokens, outcomes and regenerations", () => {
    const s = summarize([
      row({ outcome: "approved", cost_usd: 0.02 }),
      row({ outcome: "rejected", cost_usd: 0.03 }),               // same target again: a regeneration
      row({ target: "src/b.ts", outcome: "approved", cost_usd: 0.05, output_tokens: 300 }),
      row({ target: "src/c.ts", outcome: "generated", cost_usd: 0.1 }),
    ], cfg());
    const t = s.totals;
    assert.deepEqual([t.calls, t.targets, t.approved, t.rejected, t.pending, t.regenerations], [4, 3, 2, 1, 1, 1]);
    assert.equal(t.spendUsd, 0.2);
    assert.equal(t.tokensIn, 4000);
    assert.equal(t.tokensOut, 900);
    assert.equal(t.costPerApprovedUsd, 0.1, "all spend, including the rejected try, over approved docs");
    assert.equal(t.rejectionRate, 1 / 3);
    CostSummarySchema.parse(s);
  });

  it("keeps float noise out of money", () => {
    const s = summarize([0.1, 0.2, 0.3].map((c) => row({ cost_usd: c })), cfg());
    assert.equal(s.totals.spendUsd, 0.6);
  });

  it("uses recorded costs, prices old calls from today's table only when it can be sure, and says what is unknown", () => {
    const pricing = { m1: { inputPerMtok: 3, outputPerMtok: 15 } };
    const s = summarize([
      row({ cost_usd: 0.5 }),                                                                              // recorded wins over the table
      row({ cost_usd: null, input_tokens: 1_000_000, output_tokens: 100_000 }),                           // priced now: 3 + 1.5
      row({ cost_usd: null, input_tokens: null, output_tokens: 100 }),                                    // price exists, input unknown: not guessed
      row({ cost_usd: null, model: "mystery", input_tokens: 1, output_tokens: 1 }),                       // no price
    ], cfg(pricing));
    assert.equal(s.totals.spendUsd, 5);
    assert.equal(s.complete, false);
    assert.deepEqual(s.unpricedModels, ["mystery"]);
    assert.equal(s.totals.callsWithoutInputTokens, 1);
    assert.deepEqual(s.recent.map((c) => [c.costUsd, c.costSource]), [[null, null], [null, null], [4.5, "current-prices"], [0.5, "recorded"]], "newest first");
    const m1 = s.byModel.find((m) => m.model === "m1")!;
    assert.equal(m1.priced, false, "one call of m1 cannot be priced");
    assert.equal(s.byModel.find((m) => m.model === "mystery")!.priced, false);
  });

  it("reports how much of the token data is exact versus estimated", () => {
    const s = summarize([
      row({ tokens_source: "provider-reported" }), row({ tokens_source: "provider-reported" }),
      row({ tokens_source: "agent-reported" }), row({ tokens_source: "estimated", model: "m2" }),
    ], cfg());
    assert.deepEqual(s.tokensSource, { "provider-reported": 2, "agent-reported": 1, estimated: 1 });
    assert.equal(s.byModel.find((m) => m.model === "m1")!.estimatedShare, 0);
    assert.equal(s.byModel.find((m) => m.model === "m2")!.estimatedShare, 1);
  });

  it("groups by day (UTC), model, mode and module, biggest first", () => {
    const s = summarize([
      row({ ts: "2026-11-15T23:59:59.000Z", cost_usd: 0.01 }),
      row({ ts: "2026-11-16T00:00:01.000Z", cost_usd: 0.02, target: "src/auth/x.ts" }),
      row({ ts: "2026-11-16T09:00:00.000Z", cost_usd: 0.04, target: "src/auth/y.ts", model: "m2", mode: "api-key" }),
      row({ ts: "2026-11-16T09:00:00.000Z", cost_usd: 0.03, target: "src/db", kind: "module" }),
    ], cfg());
    assert.deepEqual(s.byDay.map((d) => [d.day, d.calls, d.costUsd]), [["2026-11-15", 1, 0.01], ["2026-11-16", 3, 0.09]]);
    assert.deepEqual(s.byModel.map((m) => [m.model, m.costUsd]), [["m1", 0.06], ["m2", 0.04]]);
    assert.deepEqual(s.byMode.map((m) => [m.mode, m.calls]), [["agent", 3], ["api-key", 1]]);
    assert.deepEqual(s.byModule.map((m) => [m.module, m.costUsd]), [["src/auth", 0.06], ["src/db", 0.03], ["src", 0.01]]);
  });

  it("tracks the budget: ok, near at 80%, exceeded at the cap", () => {
    const at = (spend: number, cap: number | null) => summarize([row({ cost_usd: spend })], cfg({}, cap)).budget;
    assert.deepEqual(at(1, null), { capUsd: null, spentUsd: 1, remainingUsd: null, state: "none" });
    assert.equal(at(7.9, 10).state, "ok");
    assert.equal(at(8, 10).state, "near");
    assert.equal(at(9.99, 10).state, "near");
    assert.deepEqual(at(10, 10), { capUsd: 10, spentUsd: 10, remainingUsd: 0, state: "exceeded" });
    assert.equal(at(12, 10).remainingUsd, 0, "never negative");
    assert.equal(at(1, 0).state, "none", "a zero cap is treated as no cap, not as instantly exceeded");
  });

  it("caps the recent list at 50 and keeps model names as plain strings", () => {
    const s = summarize(Array.from({ length: 80 }, () => row()), cfg());
    assert.equal(s.recent.length, 50);
    assert.equal(s.totals.calls, 80);
    assert.equal(summarize([row({ model: '<img onerror="x">' })], cfg()).byModel[0].model, '<img onerror="x">');
  });
});

describe("report export is safe to open", () => {
  it("neutralises spreadsheet formulas in untrusted text (CSV injection)", () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
      const cell = csvCell(evil);
      assert.ok(cell.startsWith(`"'`), `${JSON.stringify(evil)} -> ${cell}`);
    }
    assert.equal(csvCell("src/a.ts"), '"src/a.ts"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(0.5), "0.5");
    assert.equal(csvCell("a,b\nc"), '"a,b\nc"', "commas and newlines stay inside the quotes");
  });

  it("writes one CSV line per call with the cost it would show", () => {
    const csv = toCsv([row({ model: "=1+1", cost_usd: null, input_tokens: 1_000_000, output_tokens: 0 })], { "=1+1": { inputPerMtok: 2, outputPerMtok: 0 } });
    const [head, line] = csv.trim().split("\n");
    assert.equal(head, "ts,target,kind,model,mode,tokens_in,tokens_out,tokens_source,cost_usd,cost_source,outcome");
    assert.match(line, /,"'=1\+1",/);
    assert.match(line, /,2,"current-prices","generated"$/);
  });

  it("escapes Markdown in tables so a model name cannot break or inject", () => {
    assert.equal(mdCell("a|b `c` <x> *y*\n"), "a\\|b \\`c\\` \\<x\\> \\*y\\*");
    const md = toMarkdown(summarize([row({ model: "evil|<script>" })], cfg()));
    assert.ok(md.includes("evil\\|\\<script\\>"));
    assert.ok(!md.includes("<script>"));
  });

  it("says plainly when the numbers are incomplete", () => {
    const md = toMarkdown(summarize([row({ cost_usd: null, model: "x" })], cfg()));
    assert.match(md, /\*\*Incomplete:\*\*/);
    assert.match(md, /No price set for: x\./);
    assert.match(md, /unknown/);
    assert.match(toMarkdown(summarize([row()], cfg())), /All calls are priced\./);
  });
});

describe("cost over MCP", () => {
  let ws: string;
  let admin: Client;
  const p = (...parts: string[]) => path.join(ws, ".brain", ...parts);
  const save = (target: string, extra: Record<string, unknown> = {}) =>
    tool(admin, AgentTools.saveSummary, { target, description: "d", summary: "A summary that is long enough to count some tokens.", model: "priced-model", ...extra });

  before(async () => {
    ws = fixture();
    admin = await connect(ws, { admin: true, clientName: "brain-vscode" });
    await ready(admin, 4);
    await tool(admin, AdminTools.init);
  });
  after(async () => {
    await admin.close();
    rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it("starts empty, and the status carries a running total", async () => {
    const s = await readJson(admin, Resources.costSummary);
    assert.equal(s.totals.calls, 0);
    assert.deepEqual((await readJson(admin, Resources.status)).cost, { calls: 0, spendUsd: 0, complete: true });
  });

  it("an unpriced call is counted but not charged, and the total says it is incomplete", async () => {
    await save("src/db/pool.ts", { tokens_in: 1_000_000, tokens_out: 100_000 });
    const s = await readJson(admin, Resources.costSummary);
    CostSummarySchema.parse(s);
    assert.equal(s.totals.calls, 1);
    assert.equal(s.totals.spendUsd, 0);
    assert.equal(s.complete, false);
    assert.deepEqual(s.unpricedModels, ["priced-model"]);
    assert.equal(s.recent[0].tokensSource, "agent-reported");
    assert.equal((await readJson(admin, Resources.status)).cost.complete, false);
  });

  it("setting a price afterwards prices the old call from today's table", async () => {
    const cfgNow = (await tool(admin, AdminTools.getConfig)).body;
    const r = await tool(admin, AdminTools.setConfig, { config: { ...cfgNow, pricing: { "priced-model": { inputPerMtok: 3, outputPerMtok: 15 } }, docs: { ...cfgNow.docs, maxCostUsd: 5 } } });
    assert.equal(r.isError, false, r.text);
    const s = await readJson(admin, Resources.costSummary);
    assert.equal(s.totals.spendUsd, 4.5); // 1M in x $3 + 100K out x $15
    assert.equal(s.complete, true);
    assert.equal(s.recent[0].costSource, "current-prices");
    assert.deepEqual(s.budget, { capUsd: 5, spentUsd: 4.5, remainingUsd: 0.5, state: "near" });
  });

  it("a call made with a price on file records its own cost, which a later price change does not rewrite", async () => {
    await save("src/auth/session.ts", { tokens_in: 1_000_000, tokens_out: 0 });
    const cfgNow = (await tool(admin, AdminTools.getConfig)).body;
    await tool(admin, AdminTools.setConfig, { config: { ...cfgNow, pricing: { "priced-model": { inputPerMtok: 100, outputPerMtok: 100 } } } });
    const s = await readJson(admin, Resources.costSummary);
    const recorded = s.recent.find((c: any) => c.target === "src/auth/session.ts");
    assert.equal(recorded.costSource, "recorded");
    assert.equal(recorded.costUsd, 3, "what it cost when it ran");
    const old = s.recent.find((c: any) => c.target === "src/db/pool.ts");
    assert.equal(old.costSource, "current-prices", "calls without a recorded cost follow the table");
  });

  it("approval and rejection show up as outcomes, and feed the rejection rate", async () => {
    await tool(admin, AdminTools.reviewSummary, { target: "src/auth/session.ts", action: "approve", by: "jdoe" });
    await tool(admin, AdminTools.reviewSummary, { target: "src/db/pool.ts", action: "reject", by: "jdoe" });
    const s = await readJson(admin, Resources.costSummary);
    assert.deepEqual([s.totals.approved, s.totals.rejected, s.totals.pending], [1, 1, 0]);
    assert.equal(s.totals.rejectionRate, 0.5);
    assert.equal(s.byModel[0].approved, 1);
    assert.equal(s.byModel[0].rejected, 1);
    await save("src/db/pool.ts", { tokens_in: 10, tokens_out: 10 }); // try again after the rejection
    assert.equal((await readJson(admin, Resources.costSummary)).totals.regenerations, 1);
  });

  it("exports CSV and Markdown into .brain/reports, and a second export the same day overwrites", async () => {
    const r = (await tool(admin, AdminTools.exportCostReport)).body;
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(r.csv, `.brain/reports/cost-${day}.csv`);
    assert.equal(r.markdown, `.brain/reports/cost-${day}.md`);
    assert.equal(r.calls, 3);
    const csv = readFileSync(p("reports", `cost-${day}.csv`), "utf8").trim().split("\n");
    assert.equal(csv.length, 4);
    assert.match(readFileSync(p("reports", `cost-${day}.md`), "utf8"), /# LLM cost report/);
    await tool(admin, AdminTools.exportCostReport);
    assert.equal(readFileSync(p("reports", `cost-${day}.csv`), "utf8").trim().split("\n").length, 4);
    assert.ok(existsSync(p(".gitignore")) && /reports\//.test(readFileSync(p(".gitignore"), "utf8")), "reports are never committed by accident");
  });

  it("only the extension can export", async () => {
    const agent = await connect(ws, { clientName: "claude-code" });
    try {
      assert.equal((await tool(agent, AdminTools.exportCostReport)).isError, true);
    } finally { await agent.close(); }
  });
});
