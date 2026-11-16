import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Graph } from "@app-brain/brain-protocol";
import { BrainClient } from "../client";
import { graphHtml } from "../graphHtml";

/* eslint-disable @typescript-eslint/no-explicit-any */
let chromium: any;
try {
  chromium = require("playwright").chromium;
} catch {
  /* tests skip without a browser */
}

const MEDIA = path.resolve(__dirname, "..", "..", "media");
const FILES: Record<string, string> = {
  "src/a/x.ts": `import { y } from "../b/y";\nexport function x() { return y; }\n`,
  "src/b/y.ts": `import { x } from "../a/x";\nexport const y = 1;\nexport function useX() { return x; }\n`,
  "src/db/pool.ts": `export const pool = {};\nexport function connect() { return pool; }\n`,
  "src/auth/session.ts": `import { pool } from "../db/pool";\nexport class SessionStore { get() { return pool; } }\nexport function createSession() { return new SessionStore(); }\n`,
  "src/http/login.ts": `import { createSession } from "../auth/session";\nexport function loginHandler() { return createSession(); }\n`,
  "src/http/admin.ts": `import { loginHandler } from "./login";\nexport function adminHandler() { return loginHandler(); }\n`,
};

describe("dependency graph webview, in a real browser, with real graph data", { skip: !chromium && "playwright is not installed" }, () => {
  let browser: any;
  let ws: string;
  let page: any;
  let client: BrainClient;
  let moduleGraph: Graph;
  let fileGraph: Graph;
  let htmlFile: string;
  let outDir: string;

  before(async () => {
    ws = mkdtempSync(path.join(tmpdir(), "brain-graph-"));
    for (const [rel, body] of Object.entries(FILES)) {
      mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      writeFileSync(path.join(ws, rel), body);
    }
    execFileSync("git", ["init", "-q"], { cwd: ws });
    client = new BrainClient({
      nodePath: process.execPath, serverPath: require.resolve("@app-brain/brain-mcp/out/cli.js"),
      workspace: ws, outputDir: ".brain", log: () => {}, onState: () => {},
    });
    await client.start();
    for (let i = 0; i < 100 && (client.current?.index.files ?? 0) < 6; i++) { await new Promise((r) => setTimeout(r, 50)); await client.refresh(); }
    moduleGraph = await client.getGraph({ level: "module" });
    fileGraph = await client.getGraph({ level: "file" });

    outDir = mkdtempSync(path.join(tmpdir(), "brain-graph-html-"));
    htmlFile = path.join(outDir, "graph.html");
    writeFileSync(htmlFile, graphHtml({ nonce: "n", cspSource: "file:", scriptUri: "file://" + path.join(MEDIA, "graph.js"), styleUri: "file://" + path.join(MEDIA, "graph.css") }));
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await client?.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  async function open(graph: Graph, size = { width: 1200, height: 800 }) {
    page = await browser.newPage({ viewport: size });
    page.setDefaultTimeout(4000); // fail fast, with the selector that was missing
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(() => {
      (window as any).__posted = [];
      (window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => (window as any).__posted.push(m) });
    });
    await page.goto("file://" + htmlFile);
    await send({ type: "graph", graph, depth: 1 });
    return errors;
  }
  const send = (data: unknown) => page.evaluate((d: unknown) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (): Promise<any[]> => page.evaluate(() => (window as any).__posted);
  const node = (id: string) => page.locator(`.node[aria-label^="${id}:"]`);
  const lastPosted = async (type: string) => (await posted()).filter((m) => m.type === type).at(-1);

  it("renders modules, dependencies and the circular dependency from the server's graph", async () => {
    const errors = await open(moduleGraph);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator(".node").count(), 5);
    assert.equal(await page.locator(".edge").count(), 4);
    assert.equal(await page.locator(".edge.cycle").count(), 2, "a ↔ b");
    assert.equal(await page.locator(".node.cyc").count(), 2);
    assert.equal(await page.locator("#count").textContent(), "5 modules, 4 dependencies");
    assert.match(await page.locator("#health").textContent(), /1 circular dependency between modules/);
    assert.match(await page.locator("#health").textContent(), /src\/a ↔ src\/b/);
    assert.equal(await page.locator("#lvl-module").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#focus-chip").isHidden(), true);
    // the legend explains every encoding, so colour is never the only channel
    const legend = await page.locator("#legend").textContent();
    for (const t of ["No documentation", "Draft", "Reviewed", "circular dependency", "uncertain match", "Size"]) assert.match(legend, new RegExp(t));
  });

  it("lays nodes out finitely, inside the view, without stacking them", async () => {
    await open(moduleGraph);
    const boxes = await page.locator(".node .body").evaluateAll((els: Element[]) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
    const canvas = await page.locator("#svg").boundingBox();
    for (const b of boxes) {
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      assert.ok(b.x > canvas.x && b.x < canvas.x + canvas.width && b.y > canvas.y && b.y < canvas.y + canvas.height, "fit puts every node in view");
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(Math.hypot(boxes[i].x - boxes[j].x, boxes[i].y - boxes[j].y) > 20, `nodes ${i} and ${j} overlap`);
    }
  });

  it("keeps unrelated parts of the graph together, so the fitted view stays readable", async () => {
    await open(moduleGraph);
    type P = { x: number; y: number };
    const run = (nodes: unknown[], edges: unknown[]) => page.evaluate(([n, e]: any) => [...(window as any).brainGraphLayout(n, e, { spacing: 100 }).values()], [nodes, edges]) as Promise<P[]>;
    // 3 separate pairs, 1 triangle and 8 isolated nodes: before the fix these drifted apart
    const ids = Array.from({ length: 17 }, (_, i) => ({ id: "n" + i }));
    const e = (a: number, b: number) => ({ from: "n" + a, to: "n" + b, weight: 1 });
    const pts = await run(ids, [e(0, 1), e(2, 3), e(4, 5), e(6, 7), e(7, 8), e(8, 6)]);
    assert.equal(pts.length, 17);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.ok(w * h < 17 * 100 * 100 * 6, `17 nodes spread over ${Math.round(w)}x${Math.round(h)}`);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 30, `nodes ${i},${j} overlap`);
    // deterministic: the same input gives the same picture
    assert.deepEqual(await run(ids, [e(0, 1), e(2, 3), e(4, 5), e(6, 7), e(7, 8), e(8, 6)]), pts);
    // degenerate inputs
    assert.deepEqual(await run([], []), []);
    assert.equal((await run([{ id: "solo" }], [])).length, 1);
    assert.equal((await run([{ id: "a" }, { id: "b" }], [{ from: "a", to: "zzz", weight: 1 }, { from: "a", to: "a", weight: 1 }])).length, 2, "edges to unknown nodes and self loops are ignored");
  });

  it("selecting a node shows what it depends on and what uses it", async () => {
    await open(moduleGraph);
    await node("src/auth").click();
    const d = await page.locator("#details").textContent();
    assert.match(d, /src\/auth/);
    assert.match(d, /module \(1 file\)/);
    assert.match(d, /No documentation yet/);
    assert.ok(!/null|undefined/.test(d), "no stray values in the panel");
    assert.deepEqual(await page.locator("#details ul").nth(0).locator("button").allTextContents(), ["src/db"], "depends on");
    assert.deepEqual(await page.locator("#details ul").nth(1).locator("button").allTextContents(), ["src/http"], "used by");
    // navigating through the lists
    await page.locator("#details ul").nth(0).locator("button", { hasText: "src/db" }).click();
    assert.match(await page.locator("#details").textContent(), /^Selectedsrc\/db/);
    assert.equal(await page.locator(".node.sel").count(), 1);
    // click empty canvas to clear
    await page.locator("#svg").click({ position: { x: 5, y: 5 } });
    assert.equal(await page.locator(".node.sel").count(), 0);
    assert.match(await page.locator("#details").textContent(), /Click a node/);
  });

  it("names the circular partner of a node in a cycle", async () => {
    await open(moduleGraph);
    await node("src/a").click();
    assert.match(await page.locator("#details .bad").textContent(), /Circular dependency with: src\/b/);
  });

  it("is operable from the keyboard", async () => {
    await open(moduleGraph);
    const first = page.locator(".node").first();
    await first.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".node.sel").count(), 1);
    assert.equal(await first.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".node.sel").count(), 0);
    // every node is reachable and announces its meaning
    assert.equal(await page.locator('.node[tabindex="0"][role="button"]').count(), 5);
    assert.match(await node("src/a").getAttribute("aria-label"), /src\/a: module, No documentation yet, imported by 1, in a circular dependency/);
    // the side list is a keyboard-friendly alternative to the canvas
    await page.locator("#list button", { hasText: "src/db" }).click();
    assert.equal(await page.locator(".node.sel").count(), 1);
  });

  it("switches level and focuses through the extension, never by computing anything itself", async () => {
    await open(moduleGraph);
    await page.locator("#lvl-file").click();
    assert.deepEqual(await lastPosted("load"), { type: "load", level: "file", root: null, depth: 1 });

    await send({ type: "graph", graph: fileGraph, depth: 1 });
    assert.equal(await page.locator(".node").count(), 6);
    assert.equal(await page.locator(".edge").count(), 5);
    assert.equal(await page.locator("#lvl-file").getAttribute("aria-pressed"), "true");

    await node("src/auth/session.ts").click();
    await page.locator("#focus").click();
    assert.deepEqual(await lastPosted("load"), { type: "load", level: "file", root: "src/auth/session.ts", depth: 1 });

    const focused = await client.getGraph({ level: "file", root: "src/auth/session.ts", depth: 1 });
    await send({ type: "graph", graph: focused, depth: 1 });
    assert.equal(await page.locator("#focus-chip").textContent(), "Focused on src/auth/session.ts✕");
    assert.equal(await page.locator("#depth-label").isVisible(), true);
    await page.locator("#depth").selectOption("2");
    assert.deepEqual(await lastPosted("load"), { type: "load", level: "file", root: "src/auth/session.ts", depth: 2 });
    await page.locator("#unfocus").click();
    assert.deepEqual(await lastPosted("load"), { type: "load", level: "file", root: null, depth: 2 });
  });

  it("opens a file, only for file nodes", async () => {
    await open(fileGraph);
    await node("src/http/login.ts").click();
    await page.locator("#open").click();
    assert.deepEqual(await lastPosted("open"), { type: "open", path: "src/http/login.ts" });
    await page.close();
    await open(moduleGraph);
    await node("src/http").click();
    assert.equal(await page.locator("#open").count(), 0, "a module is not a file");
  });

  it("highlights everything that depends on a node, through others", async () => {
    await open(fileGraph);
    await node("src/db/pool.ts").click();
    await page.locator("#deps").click();
    assert.match(await page.locator("#details").textContent(), /3 dependents in this view/);
    const lit = await page.locator(".node:not(.dim)").evaluateAll((els: Element[]) => els.map((e) => e.getAttribute("aria-label")!.split(":")[0]).sort());
    assert.deepEqual(lit, ["src/auth/session.ts", "src/db/pool.ts", "src/http/admin.ts", "src/http/login.ts"]);
    assert.equal(await page.locator(".node.dim").count(), 2, "x and y are unrelated");
    await page.locator("#deps").click();
    assert.equal(await page.locator(".node.dim").count(), 0);
  });

  it("filters by name and says how many match", async () => {
    await open(fileGraph);
    await page.locator("#filter").fill("http");
    assert.equal(await page.locator("#count").textContent(), "2 of 6 match");
    assert.equal(await page.locator(".node:not(.dim)").count(), 2);
    await page.locator("#filter").fill("");
    assert.equal(await page.locator("#count").textContent(), "6 files, 5 dependencies");
    assert.equal(await page.locator(".node.dim").count(), 0);
  });

  it("zooms with the wheel, pans by dragging, and fits again", async () => {
    await open(moduleGraph);
    const t0 = await page.locator("#viewport").getAttribute("transform");
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -300);
    const t1 = await page.locator("#viewport").getAttribute("transform");
    assert.notEqual(t1, t0);
    assert.ok(Number(/scale\(([\d.]+)\)/.exec(t1)![1]) > Number(/scale\(([\d.]+)\)/.exec(t0)![1]), "wheel up zooms in");
    await page.mouse.move(20, 200);
    await page.mouse.down();
    await page.mouse.move(120, 260, { steps: 4 });
    await page.mouse.up();
    assert.notEqual(await page.locator("#viewport").getAttribute("transform"), t1);
    await page.locator("#fit").click();
    assert.equal(await page.locator("#viewport").getAttribute("transform"), t0, "fit restores the initial view");
  });

  it("encodes documentation status and trust in more than colour", async () => {
    const g: Graph = {
      ...moduleGraph,
      nodes: moduleGraph.nodes.map((n, i) => ({
        ...n,
        files: 4,
        ...[{ doc: "none", trust: null }, { doc: "draft", trust: null }, { doc: "reviewed", trust: "human-reviewed" }, { doc: "reviewed", trust: "machine-confirmed" }, { doc: "stale", trust: "human-reviewed" }][i],
      })) as Graph["nodes"],
    };
    await open(g);
    assert.equal(await page.locator(".node.none").count(), 1);
    assert.equal(await page.locator(".node.draft").count(), 1);
    assert.equal(await page.locator(".node.reviewed").count(), 2);
    assert.equal(await page.locator(".node.stale").count(), 1);
    assert.equal(await page.locator(".node.human-reviewed").count(), 2);
    assert.equal(await page.locator(".node.machine-confirmed").count(), 1);
    assert.equal(await page.locator(".node.reviewed .glyph").first().textContent(), "✓");
    assert.equal(await page.locator(".node.stale .glyph").textContent(), "!");
    assert.match(await page.locator(".node.stale").getAttribute("aria-label"), /out of date, human-reviewed/);
    await page.locator(".node.stale").click();
    assert.match(await page.locator("#details .warn").textContent(), /out of date \(human-reviewed\)/);
    // the rings are visible only for reviewed-by-person and tool-confirmed nodes
    const ring = (sel: string) => page.locator(`${sel} .ring`).first().evaluate((e: Element) => getComputedStyle(e).display);
    assert.equal(await ring(".node.human-reviewed"), "inline");
    assert.equal(await ring(".node.none"), "none");
  });

  it("says when the view is truncated, and when there is nothing", async () => {
    await open({ ...moduleGraph, truncated: true, totals: { nodes: 40, edges: 90 } });
    assert.match(await page.locator("#notice").textContent(), /most connected of 40/);
    assert.equal(await page.locator("#count").textContent(), "Showing 5 of 40 modules");
    await page.close();
    await open({ level: "module", root: null, nodes: [], edges: [], cycles: [], totals: { nodes: 0, edges: 0 }, truncated: false });
    assert.match(await page.locator("#empty").textContent(), /Nothing is indexed yet/);
    assert.equal(await page.locator("#empty").isVisible(), true);
    await send({ type: "error", message: "The brain server is not running." });
    assert.match(await page.locator("#error").textContent(), /not running/);
  });

  it("treats names from the repository as text, never as markup", async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    const g: Graph = { ...moduleGraph, nodes: [{ ...moduleGraph.nodes[0], id: evil }, moduleGraph.nodes[1]], edges: [{ from: evil, to: moduleGraph.nodes[1].id, weight: 1, confidence: "resolved", cycle: false }], cycles: [[evil, "b"]] };
    const errors = await open(g);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("#app img").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
    await page.locator("#list button").first().click();
    assert.equal(await page.locator("#app img").count(), 0);
    assert.ok((await page.locator("body").textContent()).includes(evil), "shown as literal text");
  });

  it("copes with a large graph: lays out and stays responsive", async () => {
    const n = 300;
    const nodes = Array.from({ length: n }, (_, i) => ({ ...fileGraph.nodes[0], id: `src/m${i % 20}/f${i}.ts`, importedBy: i % 7, imports: i % 5, doc: "none" as const, trust: null }));
    const edges = Array.from({ length: 450 }, (_, i) => ({ from: nodes[i % n].id, to: nodes[(i * 7 + 3) % n].id, weight: 1, confidence: "resolved" as const, cycle: false })).filter((e) => e.from !== e.to);
    const t0 = Date.now();
    await open({ ...fileGraph, nodes, edges, totals: { nodes: n, edges: edges.length } });
    const ms = Date.now() - t0;
    assert.equal(await page.locator(".node").count(), n);
    assert.ok(ms < 8000, `300 nodes took ${ms} ms to lay out`);
    await node("src/m3/f3.ts").click();
    assert.equal(await page.locator(".node.sel").count(), 1);
  });
});
