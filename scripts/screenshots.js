#!/usr/bin/env node
/*
 * Regenerates the screenshots in docs/screenshots from a demo workspace.
 *
 *   npm run build && node scripts/screenshots.js
 *
 * Needs Playwright with Chromium (`npm install --no-save playwright && npx playwright install chromium`).
 *
 * The demo workspace is a copy of this repository's own source (without tests), indexed by the real server. A few
 * documents are written and reviewed through the real tools so the graph and the cost report have something to show;
 * the document text, token counts and prices are made up for the demo. The Claude Code section is built from invented
 * log lines in a temporary folder, never from your own logs. The Review Queue and status bar are VS Code's own
 * interface, which a browser cannot draw, so they are not here.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const out = (...p) => path.join(ROOT, "packages", ...p);
const { chromium } = require("playwright");
const { Client } = require(path.join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js"));
const { StdioClientTransport, getDefaultEnvironment } = require(path.join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js"));
const { costHtml } = require(out("brain-vscode/out/costHtml.js"));
const { graphHtml } = require(out("brain-vscode/out/graphHtml.js"));
const { settingsHtml } = require(out("brain-vscode/out/settingsHtml.js"));
const { collectProviderUsage } = require(out("brain-vscode/out/providerUsage/index.js"));

const MEDIA = out("brain-vscode/media") + path.sep;
const TOKEN = "demo-admin-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function copySource(dest) {
  for (const pkg of fs.readdirSync(out())) {
    const src = out(pkg, "src");
    if (!fs.existsSync(src)) continue;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "test") continue;
        const from = path.join(dir, e.name), to = path.join(dest, "packages", pkg, path.relative(path.join(ROOT, "packages", pkg), from));
        if (e.isDirectory()) walk(from);
        else if (e.name.endsWith(".ts")) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
      }
    })(src);
  }
  execFileSync("git", ["init", "-q"], { cwd: dest });
}

async function connect(ws, admin) {
  const c = new Client({ name: admin ? "brain-vscode" : "claude-code", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [out("brain-mcp/out/cli.js"), "--workspace", ws, "--no-proxy", "--no-watch"], env: { ...getDefaultEnvironment(), BRAIN_ADMIN_TOKEN: TOKEN }, stderr: "ignore" }));
  if (admin) await c.callTool({ name: "brain_admin_hello", arguments: { adminToken: TOKEN } });
  return c;
}
const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const t = r.content[0].text; try { return JSON.parse(t); } catch { return t; } };
const resource = async (c, uri) => JSON.parse((await c.readResource({ uri })).contents[0].text);

/** What a file is for, from the first sentence of its leading comment when it has one. */
function blurb(ws, target) {
  const text = fs.readFileSync(path.join(ws, target), "utf8");
  const m = text.match(/\/\*\*?\s*([\s\S]*?)\*\//) || text.match(/^\s*\/\/\s*(.+)$/m);
  const first = m ? m[1].replace(/^\s*\*\s?/gm, "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ") : "";
  return (first || `Part of ${path.dirname(target)}.`).slice(0, 220);
}

async function demoWorkspace() {
  const ws = tmp("brain-shots-ws-");
  copySource(ws);
  const admin = await connect(ws, true);
  for (let i = 0; i < 200; i++) { const st = await resource(admin, "brain://status"); if (st.state === "idle" && st.index.files > 40) break; await sleep(100); }
  await call(admin, "brain_admin_init");
  const cfg = await call(admin, "brain_admin_get_config");
  await call(admin, "brain_admin_set_config", { config: { ...cfg, pricing: {
    "claude-sonnet-5-5": { inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 0.3 }, "claude-opus-5-5": { inputPerMtok: 5, outputPerMtok: 25, cachedPerMtok: 0.5 }, "gpt-4.1": { inputPerMtok: 2, outputPerMtok: 8 },
  }, docs: { ...cfg.docs, maxCostUsd: 10 } } });
  const agent = await connect(ws, false);
  for (let i = 0; i < 200; i++) { const st = await resource(agent, "brain://status"); if (st.state === "idle" && st.index.files > 40) break; await sleep(100); }
  const listed = await call(agent, "list_undocumented", { limit: 50 });
  if (!listed.results) throw new Error("list_undocumented: " + JSON.stringify(listed).slice(0, 300));
  const undoc = listed.results.filter((r) => r.kind === "file");
  const plan = [["claude-sonnet-5-5", 0.55], ["claude-opus-5-5", 0.25], ["gpt-4.1", 0.2]];
  const saved = [];
  for (let i = 0; i < Math.min(34, undoc.length); i++) {
    const target = undoc[i].target;
    const model = plan[i % 10 < 5 ? 0 : i % 10 < 8 ? 1 : 2][0];
    const tIn = 30000 + ((i * 7919) % 90000), tOut = 700 + ((i * 313) % 2100);
    await call(agent, "save_summary", { target, description: blurb(ws, target), summary: `${blurb(ws, target)}\n\n(Demo documentation written for the screenshots.)`, model, tokens_in: i % 6 === 5 ? undefined : tIn, tokens_out: tOut });
    saved.push(target);
  }
  // review: most approved, a few rejected and redone, some left waiting
  const approve = saved.slice(0, 22), reject = saved.slice(22, 26);
  await call(admin, "brain_admin_review_many", { targets: approve, action: "approve", by: "demo" });
  await call(admin, "brain_admin_review_many", { targets: reject, action: "reject", by: "demo", note: "Too vague" });
  for (const t of reject.slice(0, 2)) await call(agent, "save_summary", { target: t, description: blurb(ws, t), summary: "A second, more specific attempt (demo).", model: "claude-opus-5-5", tokens_in: 52000, tokens_out: 1500 });
  // a few module overviews too, so the module graph has documents to show: three approved, one waiting
  const mods = listed.results.filter((r) => r.kind === "module").slice(0, 4).map((r) => r.target);
  for (const t of mods) await call(agent, "save_summary", { target: t, description: `Overview of ${t} (demo).`, summary: `How ${t} is organised and what it is for.\n\n(Demo documentation written for the screenshots.)`, model: "claude-sonnet-5-5", tokens_in: 80000, tokens_out: 2000 });
  await call(admin, "brain_admin_review_many", { targets: mods.slice(0, 3), action: "approve", by: "demo" });
  // make one reviewed document stale by changing its code afterwards
  fs.appendFileSync(path.join(ws, approve[3]), "\n// changed after review\nexport const demoChange = 1;\n");
  await call(admin, "brain_admin_reindex");
  await agent.close();
  spreadOverDays(ws);
  return { ws, admin };
}

/** The demo history is written in seconds; spread the calls over two weeks so the by-day chart reads like a real one. */
function spreadOverDays(ws) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(ws, ".brain", ".cache", "brain.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const rows = db.prepare("SELECT id FROM llm_call ORDER BY id").all();
  const upd = db.prepare("UPDATE llm_call SET ts = ? WHERE id = ?");
  const weights = [1, 2, 4, 3, 6, 2, 0, 1, 5, 7, 3, 4, 2, 6];
  const slots = weights.flatMap((w, day) => Array(w).fill(day));
  rows.forEach((r, i) => upd.run(new Date(Date.UTC(2026, 10, 17 - 13 + slots[i % slots.length], 9 + (i % 8), (i * 7) % 60)).toISOString(), r.id));
  db.close();
}

async function shoot(browser, html, opts, send, file, shootOpts = {}) {
  const dir = tmp("brain-shots-html-"); const f = path.join(dir, "p.html"); fs.writeFileSync(f, html);
  const p = await browser.newPage({ viewport: opts.viewport, colorScheme: opts.scheme || "light", deviceScaleFactor: 1 });
  await p.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
  await p.goto("file://" + f);
  for (const m of send) await p.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), m);
  if (opts.after) await opts.after(p);
  const target = shootOpts.selector ? p.locator(shootOpts.selector) : p;
  await target.screenshot({ path: path.join(OUT, file), ...(shootOpts.selector ? {} : { fullPage: shootOpts.fullPage !== false }) });
  await p.close();
  console.log("wrote", file);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { ws, admin } = await demoWorkspace();
  const browser = await chromium.launch();
  const page = (mod, over = {}) => ({ nonce: "n", cspSource: "file:", scriptUri: "file://" + MEDIA + mod + ".js", styleUri: "file://" + MEDIA + mod + ".css", ...over });

  // ---- dependency graph, from the real index and the documents above
  for (const [level, name] of [["module", "graph-modules.png"], ["file", "graph-files.png"]]) {
    const graph = await call(admin, "get_graph", { level, limit: 90 });
    await shoot(browser, graphHtml(page("graph")), { viewport: { width: 1240, height: 780 }, after: async (p) => {
      const n = p.locator(".node").nth(level === "module" ? 1 : 3); await n.click().catch(() => {});
    } }, [{ type: "graph", graph, depth: 1 }], name, { fullPage: false });
  }

  // ---- cost and models, from the real report of the demo history
  const cost = await resource(admin, "brain://cost/summary");
  for (const scheme of ["light", "dark"]) {
    await shoot(browser, costHtml(page("cost")), { viewport: { width: 1000, height: 1280 }, scheme }, [{ type: "cost", summary: cost }], `cost-${scheme}.png`, { fullPage: false });
  }

  // ---- provider usage, from invented Claude Code logs
  const home = tmp("brain-shots-home-");
  const dir = path.join(home, ".claude", "projects", "-demo-app"); fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let d = 0; d < 12; d++) for (let k = 0; k < 6 + (d * 5) % 9; k++) {
    const day = new Date(Date.UTC(2026, 10, 1 + d)).toISOString().slice(0, 10); const model = k % 4 === 3 ? "claude-opus-5-5" : "claude-sonnet-5-5";
    lines.push(JSON.stringify({ type: "assistant", uuid: `u${d}-${k}`, cwd: "/demo/app", timestamp: `${day}T1${k % 10}:00:00.000Z`, message: { id: `m${d}-${k}`, model, content: [], usage: { input_tokens: 40 + k, output_tokens: 600 + k * 130 + d * 40, cache_read_input_tokens: 90000 + d * 6000 + k * 2000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 8000 + k * 500 } } } }));
  }
  fs.writeFileSync(path.join(dir, "session.jsonl"), lines.join("\n") + "\n");
  const usage = await collectProviderUsage({ workspace: "/demo/app", home, env: {}, now: new Date(Date.UTC(2026, 10, 13, 12)), pricing: cfgPricing(), settings: { claudeCodeLogs: true, anthropicAdmin: false, lookbackDays: 30 }, adminKey: undefined });
  usage.claudeCode.source = "~/.claude/projects"; // the demo logs sit in a temporary folder; show where real ones live
  await shoot(browser, costHtml(page("cost")), { viewport: { width: 1000, height: 900 } }, [{ type: "error", message: "" }, { type: "usage", usage }], "cost-provider-usage.png", { selector: "#providers" });

  // ---- settings
  const schema = await call(admin, "brain_admin_get_config_schema");
  const config = await call(admin, "brain_admin_get_config");
  await shoot(browser, settingsHtml(page("settings")), { viewport: { width: 900, height: 1200 } }, [{ type: "init", schema, config, initialised: true, configFile: ".brain/config.json" }], "settings.png", { fullPage: false });

  await browser.close();
  await admin.close();
  for (const d of [ws, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
})().catch((e) => { console.error(e); process.exit(1); });

function cfgPricing() {
  return { "claude-sonnet-5-5": { inputPerMtok: 3, outputPerMtok: 15, cachedPerMtok: 0.3 }, "claude-opus-5-5": { inputPerMtok: 5, outputPerMtok: 25, cachedPerMtok: 0.5 } };
}
