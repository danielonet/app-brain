import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AdminTools, AgentTools, CostSummary, ENV_ADMIN_TOKEN, Resources } from "@app-brain/brain-protocol";
import { costHtml } from "../costHtml";
import type { ProviderUsage } from "@app-brain/brain-protocol";
import { collectProviderUsage } from "../providerUsage";
import { cleanDir } from "./cleanDir";

/* eslint-disable @typescript-eslint/no-explicit-any */
let chromium: any;
try { chromium = require("playwright").chromium; } catch { /* skip without a browser */ }

const MEDIA = path.resolve(__dirname, "..", "..", "media");
const CLI = require.resolve("@app-brain/brain-mcp/out/cli.js");
const FILES: Record<string, string> = {
  "src/auth/session.ts": `import { pool } from "../db/pool";\nexport class SessionStore { get() { return pool; } }\n`,
  "src/db/pool.ts": `export const pool = {};\nexport function connect() { return pool; }\n`,
  "src/http/login.ts": `import { pool } from "../db/pool";\nexport function login() { return pool; }\n`,
};

/** A summary with only what a test cares about; the rest is filled with valid empties. */
function summary(over: Partial<CostSummary> = {}): CostSummary {
  return {
    generatedAt: "2026-11-16T12:00:00.000Z",
    totals: { calls: 0, targets: 0, approved: 0, rejected: 0, pending: 0, regenerations: 0, tokensIn: 0, callsWithoutInputTokens: 0, tokensOut: 0, spendUsd: 0, costPerApprovedUsd: null, rejectionRate: null },
    tokensSource: { "provider-reported": 0, "agent-reported": 0, estimated: 0 },
    complete: true, unpricedModels: [], budget: { capUsd: null, spentUsd: 0, remainingUsd: null, state: "none" },
    byDay: [], byModel: [], byMode: [], byModule: [], recent: [], ...over,
  };
}

describe("cost view, in a real browser", { skip: !chromium && "playwright is not installed" }, () => {
  let browser: any, page: any, ws: string, mcp: Client, outDir: string, htmlFile: string, real: CostSummary;
  const TOKEN = "t";

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(Boolean(r.isError), false, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  before(async () => {
    ws = mkdtempSync(path.join(tmpdir(), "brain-cost-"));
    for (const [rel, body] of Object.entries(FILES)) { mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); writeFileSync(path.join(ws, rel), body); }
    execFileSync("git", ["init", "-q"], { cwd: ws });
    mcp = new Client({ name: "brain-vscode", version: "1" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "--workspace", ws, "--no-watch"], env: { ...getDefaultEnvironment(), [ENV_ADMIN_TOKEN]: TOKEN }, stderr: "ignore" }));
    await call(AdminTools.hello, { adminToken: TOKEN });
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse(((await mcp.readResource({ uri: Resources.status })).contents[0] as any).text);
      if (st.state === "idle" && st.index.files >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await call(AdminTools.init);
    // real documentation history: two models, one priced, one rejected and redone, a budget
    const cfg = await call(AdminTools.getConfig);
    const save = (target: string, model: string, extra = {}) => call(AgentTools.saveSummary, { target, description: "d", summary: "A summary with enough words to have a token count.", model, ...extra });
    await save("src/db/pool.ts", "model-a", { tokens_in: 100_000, tokens_out: 5_000 }); // made before model-a had a price
    await call(AdminTools.setConfig, { config: { ...cfg, pricing: { "model-a": { inputPerMtok: 3, outputPerMtok: 15 } }, docs: { ...cfg.docs, maxCostUsd: 1 } } });
    await call(AdminTools.reviewSummary, { target: "src/db/pool.ts", action: "approve", by: "jdoe" });
    await save("src/auth/session.ts", "model-a", { tokens_in: 90_000, tokens_out: 4_000 });
    await call(AdminTools.reviewSummary, { target: "src/auth/session.ts", action: "reject", by: "jdoe" });
    await save("src/auth/session.ts", "model-a", { tokens_in: 95_000, tokens_out: 4_500 });
    await save("src/http/login.ts", "model-b"); // no price, no tokens from the agent: estimated
    real = JSON.parse(((await mcp.readResource({ uri: Resources.costSummary })).contents[0] as any).text);

    outDir = mkdtempSync(path.join(tmpdir(), "brain-cost-html-"));
    htmlFile = path.join(outDir, "cost.html");
    writeFileSync(htmlFile, costHtml({ nonce: "n", cspSource: "file:", scriptUri: "file://" + path.join(MEDIA, "cost.js"), styleUri: "file://" + path.join(MEDIA, "cost.css") }));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await mcp?.close();
    cleanDir(ws);
    cleanDir(outDir);
  });

  async function open(data: CostSummary, opts: { width?: number; dark?: boolean } = {}) {
    page = await browser.newPage({ viewport: { width: opts.width ?? 1100, height: 900 }, colorScheme: opts.dark ? "dark" : "light" });
    page.setDefaultTimeout(4000);
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(() => { (window as any).__posted = []; (window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => (window as any).__posted.push(m) }); });
    await page.goto("file://" + htmlFile);
    await send({ type: "cost", summary: data });
    return errors;
  }
  const send = (data: unknown) => page.evaluate((d: unknown) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (): Promise<any[]> => page.evaluate(() => (window as any).__posted);
  const text = (sel: string) => page.locator(sel).first().textContent();

  it("formats money, counts and ticks sensibly", async () => {
    await open(summary());
    const f = await page.evaluate(() => {
      const c = (window as any).brainCost;
      return { usd: [0, 0.004, 0.5, 12.345, 12345, null].map(c.usd), n: [0, 999, 1000, 9000, 12_345, 52_000, 123_456, 2_500_000, 25_000_000].map(c.compact), pct: [0, 0.333, 1, null].map(c.pct), ticks: [c.niceTicks(0), c.niceTicks(0.9), c.niceTicks(7), c.niceTicks(130)] };
    });
    assert.deepEqual(f.usd, ["$0.00", "<$0.01", "$0.50", "$12.35", "$12.3K", "unknown"]);
    assert.deepEqual(f.n, ["0", "999", "1K", "9K", "12.3K", "52K", "123K", "2.5M", "25M"], "no trailing .0, and 9000 is not printed in full beside 52K");
    assert.deepEqual(f.pct, ["0%", "33%", "100%", "n/a"]);
    assert.deepEqual(f.ticks[0], [0, 1]);
    assert.deepEqual(f.ticks[1], [0, 0.5, 1], "round numbers, never 0.225");
    assert.deepEqual(f.ticks[2], [0, 2, 4, 6, 8]);
    assert.deepEqual(f.ticks[3], [0, 50, 100, 150]);
  });

  it("explains an empty state instead of showing empty charts", async () => {
    const errors = await open(summary());
    assert.deepEqual(errors, []);
    assert.match(await text("#empty"), /No documentation has been generated yet/);
    assert.equal(await page.locator("svg.chart").count(), 0);
    await page.locator("#empty button").click();
    assert.ok((await posted()).some((m) => m.type === "openSettings"));
  });

  it("shows exactly what the real server computed", async () => {
    const errors = await open(real);
    assert.deepEqual(errors, []);
    const t = real.totals;
    assert.equal(await text("#k-calls"), String(t.calls));
    assert.equal(await text("#k-approved"), String(t.approved));
    assert.equal(await text("#k-regen"), String(t.regenerations));
    assert.equal(await text("#k-rej"), `${Math.round((t.rejectionRate ?? 0) * 100)}%`);
    assert.equal(await text("#hero"), await page.evaluate((n: number) => (window as any).brainCost.usd(n), t.spendUsd));
    // 100K in x $3 + 5K out x $15 = $0.375 ; 90K + 4K = $0.33 ; 95K + 4.5K = $0.3525
    assert.equal(t.spendUsd, 1.0575);
    assert.equal(await text("#hero"), "$1.06");
    assert.equal(await text("#k-cpd"), "$1.06", "all spend over the one approved doc");
    assert.equal(await text(".hero-label"), "Known spend", "model-b could not be priced, so this is a lower bound");
  });

  it("says the total is a lower bound, and why, before showing any number", async () => {
    await open(real);
    const notice = page.locator(".notice[role=status]");
    assert.match(await notice.textContent(), /These totals are a lower bound/);
    assert.match(await notice.textContent(), /No price is set for: model-b/);
    assert.match(await notice.textContent(), /1 call has no input-token count/);
    await notice.locator("button.link").click();
    assert.ok((await posted()).some((m) => m.type === "openSettings"));
    const order = await page.evaluate(() => [...document.querySelectorAll("#root > *")].map((e) => e.className || e.id));
    assert.equal(order[0], "notice", "the caveat comes first");
    await open({ ...real, complete: true, unpricedModels: [], totals: { ...real.totals, callsWithoutInputTokens: 0 } });
    assert.equal(await page.locator(".notice[role=status]").count(), 0);
    assert.equal(await text(".hero-label"), "Spend");
  });

  it("budget: icon and label carry the state, not just colour", async () => {
    for (const [spent, state, icon, label] of [[0.2, "ok", "✓", "Within budget"], [0.85, "near", "⚠", "Near the budget"], [1.4, "exceeded", "✕", "Over budget"]] as const) {
      await open(summary({ totals: { ...summary().totals, calls: 1, spendUsd: spent }, budget: { capUsd: 1, spentUsd: spent, remainingUsd: Math.max(0, 1 - spent), state }, byDay: [{ day: "2026-11-16", calls: 1, tokensOut: 1, costUsd: spent }] }));
      const sec = page.locator("#budget");
      assert.match(await sec.locator(".meter-label").textContent(), new RegExp(`^${icon}${label}`));
      assert.equal(await sec.locator(".meter").getAttribute("aria-valuenow"), String(spent));
      assert.equal(await sec.locator(".meter").getAttribute("role"), "meter");
      assert.ok((await sec.locator(".meter").getAttribute("class"))!.includes(state));
      const w = parseFloat(await sec.locator(".meter > i").evaluate((e: HTMLElement) => e.style.width));
      assert.ok(Math.abs(w - Math.min(100, spent * 100)) < 0.2, `fill ${w}% for ${spent}`);
      await page.close();
    }
    await open(real);
    assert.match(await text("#budget .meter-label"), /\$1\.06 of \$1\.00/, "the real run overspent its $1 cap");
    assert.match(await text("#budget .meter-label"), /Over budget/);
    assert.match(await text("#budget .meter-label"), /cannot stop an agent that writes docs by itself/, "does not claim to control agents it does not control");
    await open(summary({ totals: { ...summary().totals, calls: 1 } }));
    assert.equal(await page.locator("#budget").count(), 0, "no cap, no meter");
  });

  it("columns: one value label, bars no thicker than 24px, a value for every day on hover and focus, and a table", async () => {
    const days = Array.from({ length: 12 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, calls: i + 1, tokensOut: 100 * (i + 1), costUsd: (i === 5 ? 1.5 : 0.1 * (i % 3)) }));
    await open(summary({ totals: { ...summary().totals, calls: 78, spendUsd: 3 }, byDay: days }));
    assert.equal(await page.locator("#by-day .col").count(), 12);
    assert.equal(await page.locator("#by-day text.value").count(), 1, "label the maximum only, never every bar");
    assert.equal(await text("#by-day text.value"), "$1.50");
    const widths = await page.locator("#by-day .bar").evaluateAll((els: SVGGraphicsElement[]) => els.map((e) => e.getBBox().width));
    assert.ok(widths.length > 0 && widths.every((w: number) => w <= 24.01), `bar widths ${widths}`);
    const ticks = await page.locator("#by-day text.xl").count();
    assert.ok(ticks <= 8, `${ticks} x labels would collide`);
    // tooltip on hover, and the same on keyboard focus
    const col = page.locator("#by-day .col").nth(5);
    await col.hover();
    assert.match(await text("#tip"), /\$1\.50/);
    assert.match(await text("#tip"), /2026-11-06/);
    await page.mouse.move(2, 2);
    assert.equal(await page.locator("#tip").isHidden(), true);
    await page.locator("#by-day .col").nth(2).focus();
    assert.equal(await page.locator("#tip").isVisible(), true);
    assert.match(await page.locator("#by-day .col").nth(2).getAttribute("aria-label"), /^2026-11-03: \$0\.20/);
    // every value is reachable without a tooltip
    await page.locator("#by-day summary").click();
    assert.equal(await page.locator("#by-day tbody tr").count(), 12);
  });

  it("models are ranked, with the table carrying detail and a flag for the unpriced", async () => {
    await open(real);
    const names = await page.locator("#by-model .rows .name").allTextContents();
    assert.deepEqual(names, ["model-a", "model-b"], "ranked by the chosen measure, biggest first");
    assert.equal(await page.locator("#by-model .rows .val").first().textContent(), "$1.06");
    const rows = await page.locator("#by-model table tbody tr").evaluateAll((trs: Element[]) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepEqual(rows[0], ["model-a", "3", "1", "1", "13.5K", "$1.06", "0%"].map((v, i) => (i === 6 ? rows[0][6] : v)));
    assert.deepEqual(rows[1].slice(0, 3), ["model-b", "1", "0"]);
    assert.equal(rows[1][5], "$0.00+", "a plus: unpriced calls are not in this number");
    assert.equal(rows[1][6], "100%", "model-b's tokens are all estimated");
    assert.ok(((await page.locator("#by-model td.flag").count()) >= 1), "unpriced rows are flagged with an icon, not only a colour");
  });

  it("the measure toggle rescopes every chart and keeps the rest of the page", async () => {
    await open(real);
    assert.equal(await text("#by-day h2"), "Cost by day");
    await page.locator('button[data-metric="tokens"]').click();
    assert.equal(await text("#by-day h2"), "Output tokens by day");
    assert.equal(await text("#by-model h2"), "Output tokens by model");
    assert.equal(await text("#by-module h2"), "Output tokens by module");
    assert.equal(await page.locator('button[data-metric="tokens"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('button[data-metric="cost"]').getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#by-model .rows .val").first().textContent(), "13.5K");
    await page.locator('button[data-metric="calls"]').click();
    assert.equal(await page.locator("#by-model .rows .val").first().textContent(), "3");
    assert.equal(await text("#hero"), "$1.06", "the headline does not change with the measure");
    await page.locator('button[data-metric="cost"]').click();
    assert.match(await text("#toolbar"), /Unpriced calls count as \$0 here/);
  });

  it("modules are ranked bars, capped at ten with a note", async () => {
    const mods = Array.from({ length: 14 }, (_, i) => ({ module: `src/m${i}`, calls: 1, tokensOut: 10 * (i + 1), costUsd: 0.01 * (i + 1) }));
    await open(summary({ totals: { ...summary().totals, calls: 14 }, byModule: mods }));
    assert.equal(await page.locator("#by-module .rows .name").count(), 10);
    assert.equal(await text("#by-module .rows .name"), "src/m13");
    assert.match(await text("#by-module .sub"), /ten largest of 14/);
    const widths = await page.locator("#by-module .rows .b").evaluateAll((els: HTMLElement[]) => els.map((e) => e.getBoundingClientRect().width));
    assert.deepEqual([...widths].sort((a: number, b: number) => b - a), widths, "bars shrink down the ranking");
    assert.ok(Math.abs(widths[0] / widths[9] - 14 / 5) < 0.1, `bar length is proportional to the value: ${widths[0] / widths[9]}`);
  });

  it("the exactness bar: parts in proportion, zero parts drawn as nothing, shares printed only where they fit", async () => {
    await open(summary({ totals: { ...summary().totals, calls: 10 }, tokensSource: { "provider-reported": 0, "agent-reported": 8, estimated: 2 } }));
    const parts = await page.locator("#exactness .part").evaluateAll((els: HTMLElement[]) => els.map((e) => [e.textContent, Math.round(e.getBoundingClientRect().width)]));
    assert.equal(parts.length, 2, "the zero part draws nothing");
    assert.equal(parts[0][0], "80%");
    assert.equal(parts[1][0], "20%");
    assert.ok(Math.abs((parts[0][1] as number) / (parts[1][1] as number) - 4) < 0.3);
    assert.match(await text("#exactness .legend"), /Provider-reported \(exact\): 0.*Reported by the agent: 8.*Estimated from text: 2/);
    assert.match(await page.locator("#exactness .segbar").getAttribute("aria-label"), /Reported by the agent: 8 \(80%\)/);
    await open(summary({ totals: { ...summary().totals, calls: 50 }, tokensSource: { "provider-reported": 1, "agent-reported": 48, estimated: 1 } }));
    assert.deepEqual(await page.locator("#exactness .part").allTextContents(), ["", "96%", ""], "slivers print nothing; the legend and tooltip carry them");
  });

  it("recent calls: estimates and re-priced costs are marked, outcomes carry an icon", async () => {
    await open(real);
    const rows: (string | null)[][] = await page.locator("#recent tbody tr").evaluateAll((trs: Element[]) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.equal(rows.length, 4);
    assert.equal(rows[0][1], "src/http/login.ts", "newest first");
    assert.match(rows[0][4] as string, /^~/, "an estimated count shows a tilde");
    assert.equal(rows[0][3], "unknown");
    assert.equal(rows[0][5], "unknown");
    assert.ok(rows.some((r: (string | null)[]) => String(r[5]).endsWith(" *")), "a cost computed from today's prices says so");
    assert.equal(await page.locator("#recent td.ok").count(), 1);
    assert.equal(await page.locator("#recent td.bad").count(), 1);
  });

  it("buttons ask the extension, they do not compute", async () => {
    await open(real);
    await page.locator("#refresh").click();
    await page.locator("#export").click();
    await page.locator("#settings").click();
    assert.deepEqual((await posted()).map((m) => m.type).filter((t) => t !== "ready"), ["refresh", "export", "openSettings"]);
  });

  it("model and file names are text, never markup", async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    const errors = await open(summary({
      totals: { ...summary().totals, calls: 1, spendUsd: 1 },
      byModel: [{ model: evil, calls: 1, tokensOut: 1, costUsd: 1, approved: 0, rejected: 0, pending: 1, tokensIn: 1, priced: true, estimatedShare: 0 }],
      byModule: [{ module: evil, calls: 1, tokensOut: 1, costUsd: 1 }], unpricedModels: [evil], complete: false,
      recent: [{ id: 1, ts: "2026-11-16T10:00:00.000Z", target: evil, kind: "file", model: evil, mode: "agent", tokensIn: 1, tokensOut: 1, tokensSource: "estimated", costUsd: 1, costSource: "recorded", outcome: "generated" }],
    }));
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("main img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
    assert.ok((await page.locator("body").textContent()).includes(evil));
    await page.locator("#by-model .barwrap").first().hover();
    assert.equal(await page.locator("#tip img").count(), 0);
  });

  it("works in light and dark, with the validated palette, and never scrolls sideways", async () => {
    await open(real, { dark: false });
    const light = await page.locator("#by-day .bar").first().evaluate((e: Element) => getComputedStyle(e).fill).catch(() => null);
    const seg = async () => page.locator("#exactness .legend .sw").first().evaluate((e: HTMLElement) => getComputedStyle(e).backgroundColor);
    assert.equal(await seg(), "rgb(42, 120, 214)", "categorical slot 1, light step");
    await page.close();
    await open(real, { dark: true });
    assert.equal(await seg(), "rgb(57, 135, 229)", "the dark step of the same hue, not an automatic flip");
    void light;
    await page.close();
    for (const width of [1100, 600, 360]) {
      await open(real, { width });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 1, `page scrolls sideways by ${over}px at ${width}px wide`);
      await page.close();
    }
  });

  it("keeps text readable in both modes even without VS Code's theme variables", async () => {
    const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    for (const dark of [false, true]) {
      await open(real, { dark });
      for (const sel of ["h1", "#hero", ".rows .val", "#by-model td", "#recent td", ".sub"]) {
        const [fg, bg] = await page.locator(sel).first().evaluate((e: Element) => [getComputedStyle(e).color, getComputedStyle(document.body).backgroundColor]);
        const gap = Math.abs(lum(fg) - lum(bg));
        assert.ok(gap > (sel === ".sub" ? 0.35 : 0.6), `${sel} is ${fg} on ${bg} in ${dark ? "dark" : "light"} mode`);
      }
      const grid = await page.locator("#by-day line.grid").first().evaluate((e: Element) => getComputedStyle(e).stroke);
      assert.ok(Math.abs(lum(grid) - lum(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))) < 0.25, "gridlines recede in " + (dark ? "dark" : "light"));
      await page.close();
    }
  });

  it("draws no bar for a zero value", async () => {
    await open(summary({ totals: { ...summary().totals, calls: 2 }, byModel: [
      { model: "paid", calls: 1, tokensOut: 5, costUsd: 2, approved: 0, rejected: 0, pending: 1, tokensIn: 1, priced: true, estimatedShare: 0 },
      { model: "free", calls: 1, tokensOut: 5, costUsd: 0, approved: 0, rejected: 0, pending: 1, tokensIn: 1, priced: true, estimatedShare: 0 }] }));
    assert.equal(await page.locator("#by-model .rows .b").count(), 1);
    assert.equal(await page.locator("#by-model .rows .val").nth(1).textContent(), "$0.00", "the value is still printed");
  });

  it("does not print dollar amounts where nothing is known: all-unpriced history reads as unknown, not as free", async () => {
    await open(summary({
      totals: { ...summary().totals, calls: 2, tokensOut: 50, callsWithoutInputTokens: 2 }, complete: false, unpricedModels: ["x"],
      byModel: [{ model: "x", calls: 2, tokensOut: 50, costUsd: 0, approved: 0, rejected: 0, pending: 2, tokensIn: 0, priced: false, estimatedShare: 1 }],
      recent: [{ id: 1, ts: "2026-11-16T10:00:00.000Z", target: "a.ts", kind: "file", model: "x", mode: "agent", tokensIn: null, tokensOut: 25, tokensSource: "estimated", costUsd: null, costSource: null, outcome: "generated" }],
    }));
    assert.equal(await text(".hero-label"), "Known spend");
    assert.match(await text(".notice[role=status]"), /lower bound/);
    assert.equal(await text("#k-cpd"), "unknown");
  });

  // ---- what the providers report ---------------------------------------------------------------------------
  const WS_PATH = "/home/dev/app";
  const logLine = (id: string, day: string, model: string, o: number) => JSON.stringify({ type: "assistant", uuid: id, cwd: WS_PATH, timestamp: `${day}T10:00:00.000Z`, message: { id, model, content: [], usage: { input_tokens: 1000, output_tokens: o, cache_read_input_tokens: 500_000, cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 } } } });

  /** Provider usage built by the real readers: Claude Code logs on disk, and the Admin API through a fake network. */
  async function providerUsage(over: { priced?: boolean; adminKey?: string | undefined; enableOrg?: boolean; claudeCode?: boolean } = {}): Promise<ProviderUsage> {
    const home = mkdtempSync(path.join(tmpdir(), "brain-prov-"));
    const dir = path.join(home, ".claude", "projects", WS_PATH.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "s.jsonl"), [logLine("a", "2026-11-10", "claude-sonnet-5-5", 100_000), logLine("b", "2026-11-11", "claude-sonnet-5-5", 300_000), logLine("c", "2026-11-11", "claude-new-9", 50_000)].join("\n") + "\n");
    const fetch = async (url: string) => {
      const body = url.includes("cost_report")
        ? { data: [{ starting_at: "2026-11-10T00:00:00Z", results: [{ currency: "USD", amount: "250", model: "claude-sonnet-5-5" }] }], has_more: false }
        : { data: [{ starting_at: "2026-11-10T00:00:00Z", results: [{ model: "claude-sonnet-5-5", uncached_input_tokens: 2_000_000, output_tokens: 400_000, cache_read_input_tokens: 0 }] }], has_more: false };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    try {
      return await collectProviderUsage({
        workspace: WS_PATH, home, env: {}, now: new Date("2026-11-12T12:00:00Z"), fetch,
        pricing: over.priced === false ? {} : { "claude-sonnet-5-5": { inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 0.3 }, "claude-new-9": { inputPerMtok: 3, outputPerMtok: 15 } },
        settings: { claudeCodeLogs: over.claudeCode !== false, anthropicAdmin: over.enableOrg ?? true, lookbackDays: 30 },
        adminKey: "adminKey" in over ? over.adminKey : "sk-ant-admin01-TESTKEYTESTKEY",
      });
    } finally { cleanDir(home); }
  }

  it("says the providers' numbers are separate from the brain's own cost, and shows a loading line until they arrive", async () => {
    await open(real);
    assert.match(await text("#providers .sub"), /never added to it/);
    assert.match(await text("#usage-loading"), /Reading provider usage/);
    await send({ type: "usage", usage: await providerUsage() });
    assert.equal(await page.locator("#usage-loading").count(), 0);
    assert.equal(await text("#hero"), "$1.06", "the brain's own spend is untouched by the provider numbers");
  });

  it("shows Claude Code's usage in this workspace exactly as read from the logs", async () => {
    const usage = await providerUsage();
    const errors = await open(real);
    await send({ type: "usage", usage });
    assert.deepEqual(errors, []);
    const t = usage.claudeCode.totals;
    assert.equal(t.messages, 3);
    assert.equal(await text("#claude-code-messages"), "3");
    assert.equal(await text("#claude-code-out"), await page.evaluate((n: number) => (window as any).brainCost.compact(n), t.outputTokens));
    assert.equal(await text("#claude-code-cost"), await page.evaluate((n: number | null) => (window as any).brainCost.usd(n), t.costUsd));
    assert.equal(await page.locator("#claude-code svg.chart").count(), 1);
    assert.equal(await page.locator("#claude-code .rows .name").count(), usage.claudeCode.byModel.length);
    assert.match(await text("#claude-code .sub"), /Only this repository/);
  });

  it("calls the Claude Code cost a lower bound when a model has no price", async () => {
    await open(real);
    await send({ type: "usage", usage: await providerUsage({ priced: false }) });
    assert.match(await text("#claude-code .notice"), /lower bound/);
    assert.match(await text("#claude-code .notice"), /claude-sonnet-5-5/);
    assert.equal(await text("#claude-code .tile .l"), "Known cost");
    await page.locator("#claude-code .notice button").click();
    assert.ok((await posted()).some((m) => m.type === "openSettings"));
  });

  it("shows the Anthropic organisation as the whole organisation, with the cost Anthropic billed", async () => {
    const usage = await providerUsage();
    await open(real);
    await send({ type: "usage", usage });
    assert.match(await text("#anthropic-org .sub"), /whole organisation/);
    assert.equal(await text("#anthropic-org-cost"), "$2.50", "250 cents, as the cost report gave it");
    assert.match(await text("#anthropic-org-note"), /what Anthropic billed/);
    assert.equal(await text("#anthropic-org-out"), "400K");
  });

  it("offers to turn a source on when it is off, and never shows an empty chart for it", async () => {
    await open(real);
    await send({ type: "usage", usage: await providerUsage({ claudeCode: false, adminKey: undefined }) });
    assert.match(await text("#claude-code-state"), /turned off/);
    assert.match(await text("#anthropic-org-state"), /No Anthropic Admin API key/);
    assert.equal(await page.locator("#providers svg.chart").count(), 0);
    await page.locator("#claude-code-state button").click();
    await page.locator("#anthropic-org-state button").click();
    const msgs = (await posted()).map((m) => m.type);
    assert.ok(msgs.includes("openUsageSettings") && msgs.includes("setAnthropicKey"));
  });

  it("shows a failure as an alert, in words, without the key", async () => {
    await open(real);
    const usage = await providerUsage();
    usage.anthropicOrg = { ...usage.anthropicOrg, state: "error", message: "Anthropic refused the key. It must be an Admin API key.", totals: { ...usage.anthropicOrg.totals }, byModel: [], byDay: [] };
    await send({ type: "usage", usage });
    assert.equal(await page.locator("#anthropic-org-state").getAttribute("role"), "alert");
    assert.ok(!(await page.content()).includes("TESTKEY"));
    assert.equal(await page.locator("#claude-code svg.chart").count(), 1, "the other source is not hidden by it");
  });

  it("follows the measure toggle for the provider charts too", async () => {
    await open(real);
    await send({ type: "usage", usage: await providerUsage() });
    await page.locator("#toolbar button[data-metric=calls]").click();
    assert.match(await text("#claude-code h3"), /Calls by day/);
    assert.equal(await page.locator("#anthropic-org h3").first().textContent(), "Calls by day");
  });

  it("still shows provider usage when the brain server cannot be reached", async () => {
    await open(real);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "error", message: "The brain server is not running." } })));
    await send({ type: "usage", usage: await providerUsage() });
    assert.equal(await page.locator("#claude-code").count(), 1);
  });

  it("does not scroll sideways on a narrow screen with provider usage", async () => {
    await open(real, { width: 360 });
    await send({ type: "usage", usage: await providerUsage() });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  });
});
