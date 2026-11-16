import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { BrainClient, ToolError } from "../client";
import { settingsHtml } from "../settingsHtml";
import { cleanDir } from "./cleanDir";

/* eslint-disable @typescript-eslint/no-explicit-any */
let chromium: any;
try {
  chromium = require("playwright").chromium;
} catch {
  /* tests below skip when no browser is available */
}

const MEDIA = path.resolve(__dirname, "..", "..", "media");

describe("settings webview, in a real browser, against the real server", { skip: !chromium && "playwright is not installed" }, () => {
  let browser: any;
  let ws: string;
  let page: any;
  let client: BrainClient;
  let schema: Record<string, unknown>;
  let htmlFile: string;
  let outDir: string;

  before(async () => {
    ws = mkdtempSync(path.join(tmpdir(), "brain-settings-"));
    mkdirSync(path.join(ws, "src"));
    writeFileSync(path.join(ws, "src/a.ts"), "export function a() {}\n");
    client = new BrainClient({
      nodePath: process.execPath, serverPath: require.resolve("@app-brain/brain-mcp/out/cli.js"),
      workspace: ws, outputDir: ".brain", log: () => {}, onState: () => {},
    });
    await client.start();
    await client.initialise();
    schema = await client.getConfigSchema();

    outDir = mkdtempSync(path.join(tmpdir(), "brain-settings-html-"));
    htmlFile = path.join(outDir, "settings.html");
    writeFileSync(htmlFile, settingsHtml({
      nonce: "testnonce", cspSource: "file:",
      scriptUri: "file://" + path.join(MEDIA, "settings.js"), styleUri: "file://" + path.join(MEDIA, "settings.css"),
    }).replace("<script nonce", '<script nonce'));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await client?.stop();
    cleanDir(ws);
    cleanDir(outDir);
  });

  /** Opens a fresh page, with a stub for VS Code's webview API that records posted messages. */
  async function open(opts: { config?: Record<string, unknown>; initialised?: boolean } = {}) {
    page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: Error) => pageErrors.push(e.message));
    page.on("console", (m: any) => m.type() === "error" && pageErrors.push(m.text()));
    await page.addInitScript(() => {
      (window as any).__posted = [];
      (window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => (window as any).__posted.push(m) });
    });
    await page.goto("file://" + htmlFile);
    const config = opts.config ?? (await client.getConfig());
    await page.evaluate(
      (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data })),
      { type: "init", schema, config, initialised: opts.initialised ?? true, configFile: ".brain/config.json" },
    );
    await page.waitForSelector("h1");
    return pageErrors;
  }
  const posted = (): Promise<any[]> => page.evaluate(() => (window as any).__posted);
  const send = (data: unknown) => page.evaluate((d: unknown) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const field = (label: string) => page.locator(".field", { has: page.locator(`label:text-is("${label}")`) });

  it("renders every setting from the server schema", async () => {
    const errors = await open();
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("h1").textContent(), "App Brain settings");
    assert.match(await page.locator(".sub code").textContent(), /\.brain\/config\.json/);

    const out = field("Output folder").locator("input");
    assert.equal(await out.inputValue(), ".brain");
    assert.equal(await out.isDisabled(), true, "outputDir is set in VS Code settings, not here");

    assert.deepEqual(await field("Granularity").locator("option").allTextContents(), ["symbol", "file", "module", "architecture-only"]);
    assert.equal(await field("Granularity").locator("select").inputValue(), "module");
    assert.equal(await field("Budget cap (USD)").locator("input").inputValue(), "");
    assert.equal(await field("Budget cap (USD)").locator("input").getAttribute("placeholder"), "No limit");
    assert.equal(await page.locator('label.check:has-text("Commit the knowledge bundle") input').isChecked(), true);
    assert.equal(await page.locator('label.check:has-text("Generate automatically") input').isChecked(), false);
    assert.match(await field("Include globs").locator(".help").textContent(), /One per line/);
    assert.equal(await page.locator("legend", { hasText: "Model prices" }).count(), 1);
    assert.equal(await page.locator("button", { hasText: "Add model" }).count(), 1);
    assert.equal(await page.locator("tbody tr").count(), 0);
  });

  it("tracks unsaved changes, and reverts them", async () => {
    await open();
    const save = page.locator("button", { hasText: /^Save$/ });
    assert.equal(await save.isDisabled(), true);
    await field("Granularity").locator("select").selectOption("file");
    assert.equal(await save.isDisabled(), false);
    assert.equal(await page.locator(".dirty").textContent(), "Unsaved changes");
    await page.locator("button", { hasText: "Revert" }).click();
    assert.equal(await field("Granularity").locator("select").inputValue(), "module");
    assert.equal(await save.isDisabled(), true);
    assert.equal(await page.locator(".dirty").textContent(), "");
  });

  it("saves through the server: what the form posts is exactly what lands in config.json", async () => {
    await open();
    await field("Exclude globs").locator("textarea").fill("**/gen/**\n  dist/**  \n\n");
    await field("Granularity").locator("select").selectOption("file");
    await field("Budget cap (USD)").locator("input").fill("5.5");
    await page.locator('label.check:has-text("Generate automatically") input').check();
    await page.locator("button", { hasText: "Add model" }).click();
    const row = page.locator("tbody tr").first();
    await row.locator("td").nth(0).locator("input").fill("my.model-1");
    await row.locator("td").nth(1).locator("input").fill("3");
    await row.locator("td").nth(2).locator("input").fill("15");
    await page.locator("button", { hasText: /^Save$/ }).click();

    const msg = (await posted()).find((m) => m.type === "save");
    assert.deepEqual(msg.config, {
      outputDir: ".brain", include: [], exclude: ["**/gen/**", "dist/**"], languages: [],
      docs: { granularity: "file", autoGenerate: true, maxCostUsd: 5.5 },
      commitKnowledge: true,
      pricing: { "my.model-1": { inputPerMtok: 3, outputPerMtok: 15 } },
    });
    assert.match(await page.locator(".banner").textContent(), /Saving/);
    assert.equal(await page.locator("button", { hasText: /^Save$/ }).isDisabled(), true);

    const saved = await client.setConfig(msg.config); // the real server validates and writes
    await send({ type: "saved", config: saved });
    assert.match(await page.locator(".banner").textContent(), /Saved\./);
    assert.equal(await page.locator(".dirty").textContent(), "");
    assert.deepEqual(JSON.parse(readFileSync(path.join(ws, ".brain/config.json"), "utf8")).pricing, { "my.model-1": { inputPerMtok: 3, outputPerMtok: 15 } });

    // a second page load shows what was saved
    await open();
    assert.equal(await field("Budget cap (USD)").locator("input").inputValue(), "5.5");
    assert.equal(await field("Exclude globs").locator("textarea").inputValue(), "**/gen/**\ndist/**");
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.equal(await page.locator("tbody tr input").first().inputValue(), "my.model-1");
  });

  it("shows the server's field errors next to the right field, even for model ids with dots", async () => {
    await open();
    await page.locator("button", { hasText: "Add model" }).click();
    const row = page.locator("tbody tr").first();
    await row.locator("td").nth(0).locator("input").fill("gpt-4.1");
    await row.locator("td").nth(1).locator("input").fill("-3"); // negative price: the server rejects it
    await row.locator("td").nth(2).locator("input").fill("10");
    await field("Granularity").locator("select").selectOption("file");
    await page.locator("button", { hasText: /^Save$/ }).click();
    const config = (await posted()).find((m) => m.type === "save").config;

    let details: unknown;
    try { await client.setConfig(config); assert.fail("server should reject a negative price"); } catch (e) {
      assert.ok(e instanceof ToolError);
      details = e.details;
    }
    assert.deepEqual((details as any[])[0].pathParts, ["pricing", "gpt-4.1", "inputPerMtok"]);
    await send({ type: "errors", errors: details });

    assert.match(await page.locator(".banner.error").textContent(), /Not saved: 1 problem/);
    const bad = row.locator("td").nth(1);
    assert.equal(await bad.locator(".cell.has-error, .has-error").count() > 0, true);
    assert.match(await bad.locator(".err").textContent(), /greater than or equal to 0/i);
    assert.equal(await row.locator("td").nth(2).locator(".has-error").count(), 0, "the neighbouring cell is fine");

    await row.locator("td").nth(1).locator("input").fill("3"); // fixing it clears the error
    assert.equal(await page.locator(".banner.error").count(), 0);
    assert.equal(await row.locator(".has-error").count(), 0);
  });

  it("is read-only until initialised, and offers to initialise", async () => {
    await open({ initialised: false });
    assert.equal(await page.locator("button", { hasText: /^Save$/ }).isDisabled(), true);
    await field("Granularity").locator("select").selectOption("file");
    assert.equal(await page.locator("button", { hasText: /^Save$/ }).isDisabled(), true, "still cannot save");
    await page.locator("button", { hasText: "Initialise" }).click();
    assert.ok((await posted()).some((m) => m.type === "initialise"));
  });

  it("resets to defaults without touching the output folder", async () => {
    await open();
    await field("Include globs").locator("textarea").fill("src/**");
    await field("Granularity").locator("select").selectOption("symbol");
    await page.locator("button", { hasText: "Reset to defaults" }).click();
    assert.equal(await field("Include globs").locator("textarea").inputValue(), "");
    assert.equal(await field("Granularity").locator("select").inputValue(), "module");
    assert.equal(await field("Output folder").locator("input").inputValue(), ".brain");
  });

  it("flags duplicate model ids", async () => {
    await open();
    for (let i = 0; i < 2; i++) {
      await page.locator("button", { hasText: "Add model" }).click();
      await page.locator("tbody tr").nth(i).locator("td").nth(0).locator("input").fill("same");
    }
    await field("Granularity").locator("select").selectOption("file");
    await page.locator("button", { hasText: /^Save$/ }).click();
    await send({ type: "errors", errors: [{ path: "x", pathParts: ["x"], message: "boom" }] });
    assert.match(await page.locator("tbody tr").nth(1).locator("td").first().locator(".err").textContent(), /Duplicate/);
  });

  it("treats config values as text, never as markup", async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    const errors = await open({ config: { ...(await client.getConfig()), exclude: [evil], pricing: { [evil]: { inputPerMtok: 1, outputPerMtok: 2 } } } });
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("#root img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
    assert.equal(await field("Exclude globs").locator("textarea").inputValue(), evil);
    assert.equal(await page.locator("tbody tr input").first().inputValue(), evil);
  });

  it("explains a load failure instead of staying blank", async () => {
    page = await browser.newPage();
    await page.addInitScript(() => { (window as any).__posted = []; (window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => (window as any).__posted.push(m) }); });
    await page.goto("file://" + htmlFile);
    assert.ok((await posted()).some((m) => m.type === "ready"), "asks the extension for data on load");
  });
});
