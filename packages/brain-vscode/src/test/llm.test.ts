import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Estimate, GenerationState } from "@app-brain/brain-protocol";
import { BrainClient } from "../client";
import { estimateDetail, estimateTitle, generationBarText, generationProblems, generationProgress, generationSummary, statusBarText } from "../format";
import { llmEnv, validateApiKey } from "../llmEnv";
import { pickModel, promptFromSampling } from "../lmSampling";
import { cleanDir } from "./cleanDir";

// The fake API lives with the server's tests; this test drives the extension's own client against the real server.
const { startFakeLlm, anthropicOk, docFor } = require("@app-brain/brain-mcp/out/test/fakeLlm.js");

const root = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const settings = (o = {}) => ({ mode: "agent", model: "", baseUrl: "", effort: "", ...o });

describe("what reaches the server, and what does not", () => {
  it("passes nothing in agent mode, so an agent-only setup never sees a key", () => {
    assert.deepEqual(llmEnv(settings(), "sk-secret"), {});
    assert.deepEqual(llmEnv(settings({ mode: "nonsense" }), "sk-secret"), {}, "an unknown mode falls back to off");
  });
  it("gives the key only to modes that can use one", () => {
    assert.deepEqual(llmEnv(settings({ mode: "api-key", model: " claude-sonnet-5-5 ", effort: "low" }), " sk-abc "), {
      BRAIN_LLM_MODE: "api-key", BRAIN_LLM_MODEL: "claude-sonnet-5-5", BRAIN_LLM_API_KEY: "sk-abc", BRAIN_LLM_EFFORT: "low",
    });
    assert.deepEqual(llmEnv(settings({ mode: "local", model: "llama3.1", baseUrl: "http://localhost:1234/v1" }), undefined), {
      BRAIN_LLM_MODE: "local", BRAIN_LLM_MODEL: "llama3.1", BRAIN_LLM_BASE_URL: "http://localhost:1234/v1",
    });
    const editor = llmEnv(settings({ mode: "vscode-lm", model: "gpt-4o" }), "sk-abc");
    assert.deepEqual(editor, { BRAIN_LLM_MODE: "vscode-lm", BRAIN_LLM_MODEL: "gpt-4o" });
    assert.ok(!JSON.stringify(editor).includes("sk-abc"), "the editor's model needs no key, so none is sent");
  });
  it("omits what is empty, and effort outside api-key mode, where it would be rejected or ignored", () => {
    assert.deepEqual(llmEnv(settings({ mode: "api-key" }), undefined), { BRAIN_LLM_MODE: "api-key" });
    assert.equal(llmEnv(settings({ mode: "local", model: "m", effort: "high" }), undefined).BRAIN_LLM_EFFORT, undefined);
  });
  it("checks a key before storing it, without ever repeating it", () => {
    assert.equal(validateApiKey("sk-ant-api03-abcdef"), undefined);
    for (const bad of ["", "   ", "sk-abc def", "sk-abc\ndef", "x".repeat(600)]) {
      const msg = validateApiKey(bad);
      assert.ok(msg, JSON.stringify(bad));
      assert.ok(!msg!.includes("abc"), "the message never quotes the input");
    }
  });
  it("never puts the key on the server's command line, where `ps` would show it", () => {
    const src = readFileSync(path.join(root, "src", "client.ts"), "utf8");
    const args = /args:\s*\[([^\]]*)\]/.exec(src)![1];
    assert.ok(!/key|secret|token/i.test(args), `the spawn arguments are: ${args}`);
    assert.match(src, /env: \{ \.\.\.getDefaultEnvironment\(\), \.\.\.\(this\.opts\.env \?\? \{\}\)/);
    const ext = readFileSync(path.join(root, "src", "extension.ts"), "utf8");
    assert.ok(!/appendLine\([^)]*(key|secret)/i.test(ext.replace(/validateApiKey|API_KEY|apiKey/g, "")), "the key is never logged");
  });
});

describe("the settings offered to the user", () => {
  const props = manifest.contributes.configuration.properties;
  it("defaults to auto, which detects the editor's model or agent", () => {
    assert.equal(props["brain.llm.mode"].default, "auto");
    assert.deepEqual(props["brain.llm.mode"].enum, ["auto", "agent", "vscode-lm", "api-key", "local"]);
    assert.equal(props["brain.llm.mode"].enumDescriptions.length, 5, "every choice is explained, including what leaves the machine");
    assert.match(props["brain.llm.mode"].enumDescriptions[2], /Automatically uses the first language model available through VS Code/);
    assert.match(props["brain.llm.mode"].markdownDescription, /choose \*\*local\*\*/i);
    assert.match(props["brain.llm.mode"].enumDescriptions[3], /source code is sent to Anthropic/);
    assert.match(props["brain.llm.mode"].enumDescriptions[4], /only if the URL is local/);
    assert.equal(props["brain.llm.model"].default, "");
    assert.equal(props["brain.llm.baseUrl"].default, "");
  });
  it("defaults to the shared server and offers the private one as the alternative", () => {
    assert.equal(props["brain.server.transport"].default, "http");
    assert.deepEqual(props["brain.server.transport"].enum, ["http", "stdio"]);
    assert.equal(props["brain.server.transport"].enumDescriptions.length, 2);
  });
  it("offers only efforts the server accepts", () => {
    assert.deepEqual(props["brain.llm.effort"].enum, ["", "low", "medium", "high", "xhigh", "max"]);
  });
  it("has no setting that holds a key: that lives in secret storage", () => {
    const COUNTS = new Set(["brain.llm.local.contextTokens", "brain.llm.local.maxOutputTokens"]); // token *counts*, not credentials
    for (const k of Object.keys(props)) {
      if (COUNTS.has(k)) { assert.equal(props[k].type, "integer", `${k} must stay a number`); continue; }
      assert.ok(!/key|secret|token|password/i.test(k), `${k} looks like it holds a secret`);
    }
  });
});

describe("answering the server with the editor's model", () => {
  it("puts the system prompt first, since VS Code's model API has no system role", () => {
    const r = promptFromSampling({
      systemPrompt: "RULES", messages: [{ role: "user", content: { type: "text", text: "CODE" } }, { role: "user", content: [{ type: "text", text: "MORE" }, { type: "image" }] }],
      modelPreferences: { hints: [{}, { name: "gpt-4o" }] },
    });
    assert.deepEqual(r, { text: "RULES\n\nCODE\n\nMORE", hint: "gpt-4o" });
    assert.deepEqual(promptFromSampling({ messages: [] }), { text: "", hint: null });
  });
  const models = [
    { id: "copilot-gpt-4o", name: "GPT 4o", family: "gpt-4o", vendor: "copilot" },
    { id: "copilot-claude-sonnet", name: "Claude Sonnet", family: "claude-sonnet", vendor: "copilot" },
  ];
  it("picks by id, family, name or a part of any, and falls back to the first only when nothing was asked for", () => {
    assert.equal(pickModel(models, null)!.id, "copilot-gpt-4o");
    assert.equal(pickModel(models, "claude-sonnet")!.id, "copilot-claude-sonnet");
    assert.equal(pickModel(models, "COPILOT-GPT-4O")!.id, "copilot-gpt-4o", "case-insensitive, id first");
    assert.equal(pickModel(models, "Claude Sonnet")!.id, "copilot-claude-sonnet");
    assert.equal(pickModel(models, "sonnet")!.id, "copilot-claude-sonnet");
    assert.equal(pickModel(models, "gemini"), null, "a model that was asked for and is missing is an error, not a silent substitute");
    assert.equal(pickModel([], null), null);
  });
});

describe("what the person is told", () => {
  const est = (o: Partial<Estimate> = {}): Estimate => ({
    mode: "api-key", model: "claude-sonnet-5-5",
    targets: [], totals: { targets: 40, inputTokens: 612_000, outputTokens: 24_000, costUsd: { low: 1.8, high: 3.456 } }, tokensAreEstimates: true,
    budget: { capUsd: null, spentUsd: 0, remainingUsd: null }, warnings: [], canStart: true, blocked: null, ...o,
  });
  it("states the estimate as an estimate, with a range, and what happens to the result", () => {
    const d = estimateDetail(est({ warnings: ["Source code is sent to Anthropic's API."] }));
    assert.match(d, /40 files and modules, about 612K tokens in and 24K\+ out \(estimates\)/);
    assert.match(d, /Cost: about \$1\.80 to \$3\.46 with claude-sonnet-5-5 \(an estimate; reasoning models can use more\)/);
    assert.match(d, /Source code is sent to Anthropic's API\./);
    assert.match(d, /Every result is a draft that you review/);
    assert.equal(estimateTitle(est()), "Write 40 docs with claude-sonnet-5-5 (about $1.80 to $3.46)?");
  });
  it("says so plainly when the cost is unknown, free, or capped", () => {
    assert.match(estimateDetail(est({ totals: { targets: 3, inputTokens: 100, outputTokens: 10, costUsd: null } })), /Cost: unknown\. claude-sonnet-5-5 has no price set\./);
    const free = estimateDetail(est({ mode: "local", model: "llama3", totals: { targets: 1, inputTokens: 100, outputTokens: 10, costUsd: { low: 0, high: 0 } } }));
    assert.match(free, /Cost: nothing \(a local model\)\./);
    assert.equal(estimateTitle(est({ totals: { targets: 1, inputTokens: 1, outputTokens: 1, costUsd: { low: 0, high: 0 } } })), "Write 1 doc with claude-sonnet-5-5?");
    assert.match(estimateDetail(est({ budget: { capUsd: 5, spentUsd: 1.25, remainingUsd: 3.75 } })), /Budget: \$1\.25 spent of \$5\.00\. It stops before a document could go over\./);
    assert.match(estimateDetail(est({ totals: { targets: 1, inputTokens: 1e6, outputTokens: 1000, costUsd: { low: 120, high: 340 } } })), /\$120 to \$340/);
  });

  const job = (o: Partial<GenerationState> = {}): GenerationState => ({
    state: "running", jobId: "j", startedAt: "", finishedAt: null, model: "m", total: 40, done: 12, drafted: 12, failed: 0, current: "src/a.ts",
    spendUsd: 0.42, tokensIn: 1, tokensOut: 1, stopReason: null, message: null, results: [], ...o,
  });
  it("shows progress in the status bar only while something is running", () => {
    assert.equal(generationBarText(job()), "$(sync~spin) Brain: generating 12/40");
    assert.equal(generationBarText(job({ state: "cancelling" })), "$(sync~spin) Brain: cancelling");
    for (const state of ["idle", "done", "stopped", "failed"] as const) assert.equal(generationBarText(job({ state })), null);
    assert.equal(generationProgress(job()), "12/40 · src/a.ts · $0.42");
    assert.equal(generationProgress(job({ current: null, spendUsd: 0 })), "12/40");
  });
  it("ends with a message that matches what happened, at the right volume", () => {
    assert.deepEqual(generationSummary(job({ state: "done", done: 40, drafted: 40 })), { text: "Wrote 40 drafts for $0.42. Review them in the Review Queue.", level: "info" });
    assert.deepEqual(generationSummary(job({ state: "done", drafted: 38, failed: 2 })), { text: "Wrote 38 drafts for $0.42. 2 had problems: see the App Brain output.", level: "warning" });
    assert.equal(generationSummary(job({ state: "stopped", stopReason: "cancelled", drafted: 1, spendUsd: 0 })).text, "Cancelled. Wrote 1 draft.");
    const budget = generationSummary(job({ state: "stopped", stopReason: "budget", message: "Stopped before x: too dear." }));
    assert.deepEqual([budget.level, budget.text.startsWith("Stopped before x: too dear.")], ["warning", true]);
    assert.deepEqual(generationSummary(job({ state: "stopped", stopReason: "auth", message: "The API key was rejected (401)." })), { text: "The API key was rejected (401).", level: "error" });
    assert.equal(generationSummary(job({ state: "failed", message: "Generation failed: boom" })).level, "error");
  });
  it("lists only the problems for the output channel", () => {
    const r = (outcome: any, target: string, message: string | null) => ({ target, kind: "file" as const, outcome, message, costUsd: null, tokensIn: null, tokensOut: null });
    assert.deepEqual(generationProblems(job({ results: [r("drafted", "a.ts", null), r("refused", "b.ts", "declined"), r("error", "c.ts", "timed out")] })), ["REFUSED   b.ts: declined", "ERROR     c.ts: timed out"]);
  });
  it("shows in the status tooltip whether the server can write docs, and why not", () => {
    const base = { server: { pid: 1, transport: "stdio", clients: [] }, state: "idle", initialised: true, workspace: "/w", outputDir: "/w/.brain", serverVersion: "0", protocolVersion: "0.2", startedAt: "", knowledge: { reviewed: 0, drafts: 0, stale: 0 }, cost: { calls: 0, spendUsd: 0, complete: true }, index: { files: 1, symbols: 1, edges: 0, byLanguage: {}, lastIndexedAt: null }, message: null } as const;
    const tip = (llm: any) => statusBarText("connected", { ...base, llm } as never).tooltip;
    assert.ok(!tip({ mode: "agent", model: null, ready: false, problem: "off" }).includes("Doc generation"), "quiet when it is off");
    assert.match(tip({ mode: "api-key", model: "claude-opus-5-5", ready: true, problem: null }), /Doc generation: ready \(api-key, claude-opus-5-5\)/);
    assert.match(tip({ mode: "api-key", model: "x", ready: false, problem: "No API key." }), /Doc generation: not ready\. No API key\./);
  });
});

describe("the extension's client drives generation on the real server", () => {
  let ws: string;
  let fake: any;
  before(async () => {
    ws = mkdtempSync(path.join(tmpdir(), "brain-ext-gen-"));
    for (const [rel, body] of Object.entries({
      "src/a.ts": "import { b } from './b';\n/** Does a. */\nexport function a() { return b(); }\n",
      "src/b.ts": "export function b() { return 1; }\nexport function c() { return 2; }\n",
    })) { mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); writeFileSync(path.join(ws, rel), body); }
    execFileSync("git", ["init", "-q"], { cwd: ws });
    fake = await startFakeLlm((r: any) => ({ json: anthropicOk(docFor(r), { in: 1000, out: 200 }) }));
  });
  after(async () => { await fake.close(); cleanDir(ws); });

  const client = (extra: Partial<ConstructorParameters<typeof BrainClient>[0]> = {}, seen: GenerationState[] = []) => new BrainClient({
    nodePath: process.execPath, serverPath: require.resolve("@app-brain/brain-mcp/out/cli.js"), workspace: ws, outputDir: ".brain",
    log: () => {}, onState: () => {}, onGeneration: (g) => seen.push(g), ...extra,
  });
  const idle = async (c: BrainClient) => { for (let i = 0; i < 100; i++) { await c.refresh(); if (c.current?.state === "idle" && c.current.index.files >= 2) return; await new Promise((r) => setTimeout(r, 50)); } };

  it("reports the LLM the server was given, then estimates, generates with progress, and keeps the key off the wire", async () => {
    const seen: GenerationState[] = [];
    const key = "sk-ant-api03-EXTENSIONTESTKEY0123456789";
    const c = client({ env: llmEnv(settings({ mode: "api-key", model: "test-model" }), key), }, seen);
    // the fake API is reached through the base URL setting, like a gateway
    (c as any).opts.env.BRAIN_LLM_BASE_URL = fake.url;
    await c.start();
    try {
      await idle(c);
      await c.initialise();
      await c.refresh();
      assert.deepEqual([c.current!.llm.mode, c.current!.llm.ready, c.current!.llm.model], ["api-key", true, "test-model"]);
      assert.ok(!JSON.stringify(c.current).includes(key), "status never carries the key");

      const e = await c.estimateGeneration({ kind: "file" });
      assert.deepEqual([e.canStart, e.totals.targets, e.tokensAreEstimates], [true, 2, true]);
      assert.equal(fake.requests.length, 0, "estimating costs nothing");

      const started = await c.generateDocs({ kind: "file" });
      assert.equal(started.state, "running");
      for (let i = 0; i < 200 && !seen.some((g) => g.state === "done"); i++) await new Promise((r) => setTimeout(r, 50));
      const done = seen.find((g) => g.state === "done")!;
      assert.deepEqual([done.total, done.drafted, done.failed], [2, 2, 0]);
      assert.ok(seen.some((g) => g.state === "running" && g.done === 1), "progress arrived while it ran");
      assert.ok(fake.requests.every((r: any) => r.headers.authorization === `Bearer ${key}`));
      assert.ok(existsSync(path.join(ws, ".brain/drafts/files/src/a.ts.md")));
      assert.ok(existsSync(path.join(ws, ".brain/drafts/files/src/b.ts.md")));
      const summary = await c.getCostSummary();
      assert.equal(summary.tokensSource["provider-reported"], 2);
    } finally { await c.stop(); }
  });

  it("answers the server's prompts with a sampling handler, and declares that it can only when it has one", async () => {
    cleanDir(path.join(ws, ".brain", "drafts")); // the previous test left drafts behind
    const asked: any[] = [];
    const c = client({
      env: llmEnv(settings({ mode: "vscode-lm", model: "editor-model" }), undefined),
      sample: async (params) => {
        asked.push(params);
        return { model: "editor-model-1", role: "assistant", content: { type: "text", text: "DESCRIPTION: Done by the editor.\n\n## Overview\n\nWritten by the editor's own model, in enough words to keep." }, stopReason: "endTurn", _meta: { usage: { inputTokens: 500, outputTokens: 60 } } };
      },
    });
    await c.start();
    try {
      await idle(c);
      assert.equal(c.current!.llm.ready, true, "the server saw that this client can run prompts");
      assert.equal(c.current!.llm.mode, "vscode-lm");
      await c.generateDocs({ under: "src/b.ts" });
      for (let i = 0; i < 100 && asked.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(asked.length, 1);
      assert.match(asked[0].messages[0].content.text, /export function b\(\)/);
      assert.equal(asked[0].includeContext, "none");
    } finally { await c.stop(); }

    const noSampling = client({ env: llmEnv(settings({ mode: "vscode-lm" }), undefined) });
    await noSampling.start();
    try {
      await idle(noSampling);
      assert.equal(noSampling.current!.llm.ready, false);
      assert.match(noSampling.current!.llm.problem!, /cannot run prompts/);
    } finally { await noSampling.stop(); }
  });
});
