import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fetchAnthropicOrgUsage, FetchLike } from "../providerUsage/anthropicAdmin";
import { _clearCache, encodeProjectDir, insideWorkspace, parseLogLines, readClaudeCodeUsage } from "../providerUsage/claudeCodeLogs";
import { _clearOrgCache, collectProviderUsage } from "../providerUsage";
import { priceCounts, zeroCounts } from "../providerUsage/shared";
import { cleanDir } from "./cleanDir";

const WS = "/home/dev/app";
const PRICES = { "claude-sonnet-5-5": { inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 0.3 } };

function line(o: { id: string; model?: string; ts?: string; cwd?: string; input?: number; output?: number; read?: number; w5?: number; w1?: number; type?: string; text?: string }): string {
  return JSON.stringify({
    type: o.type ?? "assistant", uuid: "u-" + o.id, cwd: o.cwd ?? WS, timestamp: o.ts ?? "2026-11-10T10:00:00.000Z",
    message: {
      id: o.id, role: "assistant", model: o.model ?? "claude-sonnet-5-5", content: [{ type: "text", text: o.text ?? "SECRET ANSWER TEXT" }],
      usage: { input_tokens: o.input ?? 10, output_tokens: o.output ?? 100, cache_read_input_tokens: o.read ?? 1000, cache_creation: { ephemeral_5m_input_tokens: o.w5 ?? 0, ephemeral_1h_input_tokens: o.w1 ?? 0 } },
    },
  });
}

describe("Claude Code logs", () => {
  it("names a project folder the way Claude Code does", () => {
    assert.equal(encodeProjectDir("/home/user/app-brain"), "-home-user-app-brain");
    assert.equal(encodeProjectDir("C:\\Users\\a b\\proj"), "C--Users-a-b-proj");
  });

  it("matches the workspace and what is inside it, not a sibling that shares a prefix", () => {
    assert.equal(insideWorkspace("/home/dev/app", WS), true);
    assert.equal(insideWorkspace("/home/dev/app/packages/x", WS), true);
    assert.equal(insideWorkspace("/home/dev/app-2", WS), false);
    assert.equal(insideWorkspace("/home/dev/application", WS), false);
    assert.equal(insideWorkspace(undefined, WS), false);
    assert.equal(insideWorkspace("C:\\Dev\\App\\src", "c:/dev/app"), true);
  });

  it("counts an answer once, however many lines repeat it, keeping the complete one", () => {
    const found = parseLogLines([
      line({ id: "m1", output: 5 }), line({ id: "m1", output: 175 }), line({ id: "m1", output: 175 }),
      line({ id: "m2", output: 40, w5: 200, w1: 300 }),
    ], WS);
    assert.equal(found.size, 2);
    assert.equal(found.get("m1")!.counts.output, 175);
    assert.deepEqual(found.get("m2")!.counts, { messages: 1, input: 10, cacheRead: 1000, cacheWrite5m: 200, cacheWrite1h: 300, output: 40 });
  });

  it("skips what is not this workspace's usage, and survives damaged lines", () => {
    const found = parseLogLines([
      "not json at all", "{", "", line({ id: "other", cwd: "/home/dev/other" }), line({ id: "syn", model: "<synthetic>" }),
      line({ id: "user", type: "user" }), JSON.stringify({ type: "assistant", cwd: WS, message: { id: "nou", model: "m" } }),
      line({ id: "badtime", ts: "yesterday" }), line({ id: "ok" }),
    ], WS);
    assert.deepEqual([...found.keys()], ["ok"]);
  });

  it("keeps no text from the conversation", () => {
    const found = parseLogLines([line({ id: "m", text: "my password is hunter2" })], WS);
    assert.ok(!JSON.stringify([...found.values()]).includes("hunter2"));
  });

  it("prices cache reads and writes with Anthropic's ratios unless the table says otherwise", () => {
    const c = { ...zeroCounts(), input: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, output: 1e6 };
    assert.equal(priceCounts({ inputPerMtok: 3, outputPerMtok: 15 }, c), 3 + 0.3 + 3.75 + 6 + 15);
    assert.equal(priceCounts({ inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 1, cacheWritePerMtok: 4 }, c), 3 + 1 + 4 + 4 + 15);
    assert.equal(priceCounts(undefined, c), null);
  });
});

describe("reading Claude Code usage for a workspace", () => {
  function setup(files: Record<string, { lines: string[]; ageDays?: number }>) {
    const home = mkdtempSync(path.join(tmpdir(), "brain-cc-"));
    for (const [rel, f] of Object.entries(files)) {
      const file = path.join(home, ".claude", "projects", rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, f.lines.join("\n") + "\n");
      if (f.ageDays) { const t = new Date(Date.now() - f.ageDays * 86_400_000); utimesSync(file, t, t); }
    }
    return home;
  }
  const NOW = new Date("2026-11-12T12:00:00Z");
  const read = (home: string, pricing: any = PRICES, days = 30) => readClaudeCodeUsage({ workspace: WS, pricing, lookbackDays: days, home, env: {}, now: NOW });

  it("adds up this workspace's sessions by model and day, and prices them", async () => {
    _clearCache();
    const dir = encodeProjectDir(WS);
    const home = setup({
      [`${dir}/s1.jsonl`]: { lines: [line({ id: "a", output: 1_000_000, input: 1_000_000, read: 0 }), line({ id: "b", ts: "2026-11-11T09:00:00Z", output: 0, input: 0, read: 1_000_000 })] },
      [`${dir}/s2.jsonl`]: { lines: [line({ id: "a", output: 1_000_000, input: 1_000_000, read: 0 })] }, // a resumed session repeating "a"
      [`${dir}-2/s3.jsonl`]: { lines: [line({ id: "elsewhere", cwd: "/home/dev/app-2" })] }, // folder shares the prefix; its cwd says it is another project
    });
    try {
      const u = await read(home);
      assert.equal(u.state, "ok");
      assert.equal(u.totals.messages, 2);
      assert.equal(u.totals.outputTokens, 1_000_000);
      assert.equal(u.totals.costUsd, 3 + 15 + 0.3);
      assert.equal(u.complete, true);
      assert.deepEqual(u.byDay.map((d) => d.day), ["2026-11-10", "2026-11-11"]);
      assert.equal(u.byModel[0].model, "claude-sonnet-5-5");
      assert.equal(u.sessions, 2);
    } finally { cleanDir(home); }
  });

  it("calls the total a lower bound when a model has no price, instead of guessing", async () => {
    _clearCache();
    const home = setup({ [`${encodeProjectDir(WS)}/s.jsonl`]: { lines: [line({ id: "a", model: "claude-new-9" })] } });
    try {
      const u = await read(home);
      assert.equal(u.complete, false);
      assert.deepEqual(u.unpricedModels, ["claude-new-9"]);
      assert.equal(u.byModel[0].costUsd, null);
    } finally { cleanDir(home); }
  });

  it("ignores logs untouched for longer than the window, and says when there is nothing", async () => {
    _clearCache();
    const home = setup({ [`${encodeProjectDir(WS)}/old.jsonl`]: { lines: [line({ id: "a", ts: "2026-09-01T00:00:00Z" })], ageDays: 70 } });
    try {
      const u = await read(home);
      assert.equal(u.state, "none");
      assert.match(u.message, /last 30 days/);
    } finally { cleanDir(home); }
  });

  it("says plainly when Claude Code was never used here, or is not installed", async () => {
    _clearCache();
    const home = setup({ "-some-other-project/s.jsonl": { lines: [line({ id: "a" })] } });
    const empty = mkdtempSync(path.join(tmpdir(), "brain-cc-empty-"));
    try {
      assert.match((await read(home)).message, /has not been used in this workspace/);
      const none = await read(empty);
      assert.equal(none.state, "none");
      assert.match(none.message, /No Claude Code logs/);
    } finally { cleanDir(home); cleanDir(empty); }
  });
});

// ---- Anthropic Admin API ----------------------------------------------------------------------------------

const KEY = "sk-ant-admin01-SECRETSECRETSECRET";
const usageBucket = (day: string, results: object[]) => ({ starting_at: `${day}T00:00:00Z`, ending_at: `${day}T23:59:59Z`, results });

function fakeFetch(routes: Record<string, (q: URLSearchParams, headers: Record<string, string>) => { status?: number; body?: unknown } | Error>, seen: string[] = []): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    seen.push(u.pathname + "?" + u.searchParams);
    const route = routes[u.pathname.replace("/v1/organizations/", "")];
    if (!route) throw new Error("unexpected " + u.pathname);
    const r = route(u.searchParams, init.headers);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
}

describe("Anthropic Admin API", () => {
  const NOW = new Date("2026-11-12T12:00:00Z");
  const usage = (q: URLSearchParams) => q.get("page") ? { body: { data: [usageBucket("2026-11-11", [{ model: "claude-sonnet-5-5", uncached_input_tokens: 500_000, output_tokens: 100_000 }])], has_more: false } }
    : { body: { data: [usageBucket("2026-11-10", [{ model: "claude-sonnet-5-5", uncached_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 200_000 }])], has_more: true, next_page: "page_2" } };

  it("sends the key in a header only, reads every page, and takes dollars from the cost report in cents", async () => {
    const seen: string[] = [];
    let headers: Record<string, string> = {};
    const f = fakeFetch({
      "usage_report/messages": (q, h) => { headers = h; return usage(q); },
      cost_report: () => ({ body: { data: [{ starting_at: "2026-11-10T00:00:00Z", results: [
        { currency: "USD", amount: "123.5", model: "claude-sonnet-5-5", cost_type: "tokens" },
        { currency: "USD", amount: "10", model: null, cost_type: "web_search" },
      ] }], has_more: false } }),
    }, seen);
    const u = await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, fetch: f, now: NOW });
    assert.equal(headers["x-api-key"], KEY);
    assert.ok(seen.every((s) => !s.includes("SECRET")), "the key is never in a URL");
    assert.equal(seen.filter((s) => s.startsWith("/v1/organizations/usage_report")).length, 2, "followed next_page");
    assert.equal(u.state, "ok");
    assert.equal(u.costIsBilled, true);
    assert.equal(u.totals.outputTokens, 300_000);
    assert.equal(u.totals.cacheReadTokens, 2_000_000);
    assert.equal(u.totals.costUsd, 1.335, "billed dollars only: the day without a charge is $0, not a price-table guess");
    const other = u.byModel.find((m) => m.model === "(other costs)");
    assert.ok(other && other.costUsd === 0.1 && other.outputTokens === 0, "non-token costs are shown, not dropped");
    assert.ok(!JSON.stringify(u).includes("SECRET"));
  });

  it("falls back to the price table, and says so, when the key can read usage but not cost", async () => {
    const f = fakeFetch({ "usage_report/messages": () => ({ body: { data: [usageBucket("2026-11-10", [{ model: "claude-sonnet-5-5", uncached_input_tokens: 1_000_000, output_tokens: 1_000_000 }])], has_more: false } }), cost_report: () => ({ status: 403, body: {} }) });
    const u = await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, fetch: f, now: NOW });
    assert.equal(u.state, "ok");
    assert.equal(u.costIsBilled, false);
    assert.equal(u.totals.costUsd, 18);
    assert.match(u.message, /price table/);
  });

  it("explains a refused key without repeating it", async () => {
    const f = fakeFetch({ "usage_report/messages": () => ({ status: 401, body: { error: { message: `invalid key ${KEY}` } } }) });
    const u = await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, fetch: f, now: NOW });
    assert.equal(u.state, "error");
    assert.match(u.message, /Admin API key/);
    assert.ok(!u.message.includes("SECRET"));
  });

  it("reports a network failure plainly, and an empty organisation as none", async () => {
    const down = await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, now: NOW, fetch: fakeFetch({ "usage_report/messages": () => new Error("getaddrinfo ENOTFOUND") }) });
    assert.equal(down.state, "error");
    assert.match(down.message, /Could not reach Anthropic/);
    const empty = await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, now: NOW, fetch: fakeFetch({ "usage_report/messages": () => ({ body: { data: [usageBucket("2026-11-10", [])], has_more: false } }), cost_report: () => ({ body: { data: [], has_more: false } }) }) });
    assert.equal(empty.state, "none");
  });

  it("asks for daily buckets grouped by model over the chosen window", async () => {
    const seen: string[] = [];
    await fetchAnthropicOrgUsage({ key: KEY, lookbackDays: 7, pricing: PRICES, now: NOW, fetch: fakeFetch({ "usage_report/messages": () => ({ body: { data: [], has_more: false } }), cost_report: () => ({ body: { data: [], has_more: false } }) }, seen) });
    const q = new URLSearchParams(seen[0].split("?")[1]);
    assert.equal(q.get("bucket_width"), "1d");
    assert.deepEqual(q.getAll("group_by[]"), ["model"]);
    assert.equal(q.get("starting_at"), "2026-11-06T00:00:00.000Z");
  });
});

describe("collecting provider usage", () => {
  const base = { workspace: WS, pricing: PRICES, env: {}, home: "/nonexistent", now: new Date("2026-11-12T12:00:00Z") };

  it("leaves a source off until it is turned on, and without a key says what to do", async () => {
    _clearOrgCache();
    const off = await collectProviderUsage({ ...base, settings: { claudeCodeLogs: false, anthropicAdmin: false, lookbackDays: 30 }, adminKey: undefined });
    assert.equal(off.claudeCode.state, "off");
    assert.equal(off.anthropicOrg.state, "off");
    const noKey = await collectProviderUsage({ ...base, settings: { claudeCodeLogs: false, anthropicAdmin: true, lookbackDays: 30 }, adminKey: undefined });
    assert.match(noKey.anthropicOrg.message, /Set Anthropic Admin Key/);
  });

  it("keeps one source failing from hiding the other, and polls Anthropic at most once a minute", async () => {
    _clearOrgCache();
    let calls = 0;
    const f = fakeFetch({ "usage_report/messages": () => { calls++; return { body: { data: [usageBucket("2026-11-10", [{ model: "claude-sonnet-5-5", output_tokens: 10 }])], has_more: false } }; }, cost_report: () => ({ body: { data: [], has_more: false } }) });
    const settings = { claudeCodeLogs: true, anthropicAdmin: true, lookbackDays: 30 };
    const a = await collectProviderUsage({ ...base, settings, adminKey: KEY, fetch: f });
    const b = await collectProviderUsage({ ...base, settings, adminKey: KEY, fetch: f, now: new Date("2026-11-12T12:00:30Z") });
    assert.equal(a.claudeCode.state, "none");
    assert.equal(a.anthropicOrg.state, "ok");
    assert.equal(calls, 1, "second call within a minute came from the cache");
    assert.equal(b.anthropicOrg.totals.outputTokens, 10);
    await collectProviderUsage({ ...base, settings, adminKey: KEY, fetch: f, now: new Date("2026-11-12T12:02:00Z") });
    assert.equal(calls, 2);
  });
});
