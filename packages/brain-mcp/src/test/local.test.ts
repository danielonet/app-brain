import { strict as assert } from "node:assert";
import * as net from "node:net";
import { rmSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { AdminTools, MIN_CONTEXT_TOKENS, Resources } from "@app-brain/brain-protocol";
import { classifyHost, guessServer, reachWarning } from "../llm/host";
import { listLlmModels, modelListed, testLlm } from "../llm/diagnose";
import { llmFromEnv } from "../llm/factory";
import { OpenAiCompatProvider } from "../llm/openai";
import { LlmError } from "../llm/types";
import { MAX_SOURCE_CHARS, SYSTEM_PROMPT, estimateTokens, filePrompt, modulePrompt, variableBudgetChars } from "../generate/prompts";
import { parseConcept } from "../okf/format";
import { docFor, openAiOk, startFakeLlm, userText, Handler } from "./fakeLlm";
import { connect, fixture, readJson, ready, tool } from "./helpers";

const server = { getClientCapabilities: () => undefined } as never;

describe("who can see what is sent", () => {
  it("classifies hosts into this machine, your network and the internet", () => {
    const reach = (u: string) => classifyHost(u)?.reach;
    for (const u of ["http://localhost:11434/v1", "http://127.0.0.1:1234", "http://127.5.5.5/v1", "http://[::1]:8080/v1", "http://foo.localhost/v1"]) assert.equal(reach(u), "this-machine", u);
    for (const u of ["http://10.0.0.5:8080", "http://192.168.1.20/v1", "http://172.16.0.1/v1", "http://172.31.255.1/v1", "http://169.254.1.1/v1", "http://100.64.0.1/v1", "http://gpu-box:8080/v1", "http://gpu.local/v1", "http://llm.internal/v1", "http://[fd12::1]/v1"]) assert.equal(reach(u), "local-network", u);
    for (const u of ["https://api.openai.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://172.15.0.1/v1", "http://192.169.0.1/v1", "https://my-llm.example.com/v1", "http://[2001:db8::1]/v1", "http://100.128.0.1/v1"]) assert.equal(reach(u), "internet", u);
    assert.equal(classifyHost("not a url"), null);
  });
  it("does not let a name that merely contains 'localhost' or a private prefix pass", () => {
    for (const u of ["http://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://10.0.0.5.evil.com/v1", "http://evil.com/localhost"]) assert.equal(classifyHost(u)?.reach, "internet", u);
  });
  it("says so honestly, including when it is not encrypted", () => {
    assert.deepEqual(reachWarning("http://localhost:11434/v1"), { text: "Runs on this machine; nothing leaves it.", reach: "this-machine" });
    assert.equal(reachWarning("http://gpu-box:8080/v1").text, "Sends your source code to gpu-box on your network, unencrypted.");
    assert.equal(reachWarning("https://gpu-box:8080/v1").text, "Sends your source code to gpu-box on your network.");
    assert.equal(reachWarning("https://api.example.com/v1").text, "Sends your source code over the internet to api.example.com. This is not a local model.");
    assert.match(reachWarning("http://api.example.com/v1").text, /UNENCRYPTED/);
    assert.match(reachWarning("nonsense").text, /not a valid URL/);
  });
  it("recognises the common servers by their port", () => {
    assert.deepEqual(["http://localhost:11434/v1", "http://localhost:1234/v1", "http://localhost:8080/v1", "http://localhost:9999/v1", "garbage"].map(guessServer), ["ollama", "lm-studio", "llama-cpp", null, null]);
  });
});

describe("the local provider", () => {
  const make = (baseUrl: string, o = {}) => new OpenAiCompatProvider({ baseUrl, model: "m", ...o });
  it("is free on this machine or your network, and not free on the internet", () => {
    assert.equal(make("http://localhost:11434/v1").free, true);
    assert.equal(make("http://192.168.1.5:8080/v1").free, true);
    assert.equal(make("https://api.example.com/v1").free, false, "someone's paid service is not free just because it was configured as local");
  });
  it("carries its limits, with sensible defaults", () => {
    assert.deepEqual(make("http://localhost:1/v1").limits, { contextTokens: null, maxOutputTokens: 1500 });
    assert.deepEqual(make("http://localhost:1/v1", { contextTokens: 8192, maxOutputTokens: 700 }).limits, { contextTokens: 8192, maxOutputTokens: 700 });
  });
  it("reads limits from the environment, defaulting the window to a size that is usually safe", () => {
    const p = (env: Record<string, string>) => llmFromEnv({ BRAIN_LLM_MODE: "local", BRAIN_LLM_MODEL: "m", ...env }, server).provider!;
    assert.deepEqual(p({}).limits, { contextTokens: 8192, maxOutputTokens: 1500 });
    assert.deepEqual(p({ BRAIN_LLM_CONTEXT_TOKENS: "4096", BRAIN_LLM_MAX_OUTPUT_TOKENS: "800" }).limits, { contextTokens: 4096, maxOutputTokens: 800 });
    assert.deepEqual(p({ BRAIN_LLM_CONTEXT_TOKENS: "junk", BRAIN_LLM_MAX_OUTPUT_TOKENS: "-5" }).limits, { contextTokens: 8192, maxOutputTokens: 1500 }, "nonsense falls back, it is not trusted");
    assert.equal(llmFromEnv({ BRAIN_LLM_MODE: "api-key", BRAIN_LLM_API_KEY: "k" }, server).provider!.limits.contextTokens, null, "Claude has room");
  });

  describe("listing models", () => {
    let fake: Awaited<ReturnType<typeof startFakeLlm>>;
    before(async () => { fake = await startFakeLlm(() => ({ json: {} })); });
    after(() => fake.close());
    it("reads the OpenAI shape, and Ollama's own", async () => {
      fake.setHandler(() => ({ json: { object: "list", data: [{ id: "llama3.1:latest" }, { id: "qwen2.5-coder:7b" }, { id: 42 }] } }));
      assert.deepEqual(await make(fake.url + "/v1").listModels(), ["llama3.1:latest", "qwen2.5-coder:7b"]);
      fake.setHandler(() => ({ json: { models: [{ name: "mistral:7b" }, { model: "phi3:mini" }] } }));
      assert.deepEqual(await make(fake.url + "/v1").listModels(), ["mistral:7b", "phi3:mini"]);
      fake.setHandler(() => ({ json: { data: [{ id: "b" }, { id: "a" }, { id: "a" }] } }));
      assert.deepEqual(await make(fake.url + "/v1").listModels(), ["a", "b"], "sorted, no duplicates");
    });
    it("sends the key only when there is one, and reports what went wrong", async () => {
      fake.requests.length = 0;
      await make(fake.url + "/v1", { apiKey: "k-123" }).listModels();
      assert.equal(fake.requests[0].headers.authorization, "Bearer k-123");
      fake.requests.length = 0;
      await make(fake.url + "/v1").listModels();
      assert.equal(fake.requests[0].headers.authorization, undefined);
      fake.setHandler(() => ({ status: 401, json: {} }));
      assert.equal(((await make(fake.url + "/v1").listModels().then(() => null, (e: LlmError) => e))!).kind, "auth");
      assert.equal(((await make("http://127.0.0.1:1/v1").listModels().then(() => null, (e: LlmError) => e))!).kind, "network");
    });
    it("matches Ollama's :latest naming", () => {
      assert.equal(modelListed("llama3.1", ["llama3.1:latest"]), true);
      assert.equal(modelListed("llama3.1", ["llama3.1:8b"]), true);
      assert.equal(modelListed("llama3.1:8b", ["llama3.1:8b"]), true);
      assert.equal(modelListed("llama3", ["llama3.1:latest"]), false, "llama3 is not llama3.1");
      assert.equal(modelListed("gpt", ["gpt-4o"]), false);
    });
    it("lists only for a local server", async () => {
      await assert.rejects(listLlmModels(llmFromEnv({ BRAIN_LLM_MODE: "api-key", BRAIN_LLM_API_KEY: "k" }, server)), /only available for a local server/);
      await assert.rejects(listLlmModels(llmFromEnv({}, server)), /Server-side generation is off/);
    });
  });
});

describe("sizing prompts to the model's window", () => {
  const ctx = { path: "src/a.ts", language: "typescript", source: "const x = 1;\n".repeat(20000), symbols: [], imports: [], usedBy: [], feedback: [] };
  it("gives the whole default budget when the window is large or unknown", () => {
    assert.equal(variableBudgetChars(500, undefined), MAX_SOURCE_CHARS);
    assert.equal(variableBudgetChars(500, { contextTokens: null, maxOutputTokens: 8000 }), MAX_SOURCE_CHARS);
    assert.equal(variableBudgetChars(500, { contextTokens: 1_000_000, maxOutputTokens: 8000 }), MAX_SOURCE_CHARS, "never more than the cap");
  });
  it("leaves room for the answer, the fixed part and some slack, and never goes negative", () => {
    const b = variableBudgetChars(600, { contextTokens: 8192, maxOutputTokens: 1500 });
    const tokens = 8192 - 1500 - 600 - 300;
    assert.equal(b, Math.floor((tokens * 3.5) / 1.15));
    assert.equal(variableBudgetChars(5000, { contextTokens: 2048, maxOutputTokens: 1500 }), 0);
  });
  it("cuts a long file to fit, says so, and a full prompt really fits the window", () => {
    const limits = { contextTokens: 8192, maxOutputTokens: 1500 };
    const p = filePrompt(ctx, limits);
    assert.equal(p.truncated, true);
    assert.equal(p.fits, true);
    assert.match(p.user, /characters omitted from the middle/);
    const tokens = estimateTokens(p.system) + estimateTokens(p.user);
    assert.ok(tokens + limits.maxOutputTokens < limits.contextTokens, `${tokens} prompt + ${limits.maxOutputTokens} answer must fit ${limits.contextTokens}`);
    assert.ok(tokens + limits.maxOutputTokens > limits.contextTokens * 0.7, "and it uses the room it has instead of cutting needlessly");
    const bigger = filePrompt(ctx, { contextTokens: 32768, maxOutputTokens: 1500 });
    assert.ok(bigger.user.length > p.user.length * 2, "a bigger window gets more of the file");
    assert.equal(filePrompt({ ...ctx, source: "const x = 1;\n" }, limits).truncated, false, "a short file is sent whole");
  });
  it("sends nothing when no code would fit, so the target is skipped instead of cut to nothing", () => {
    const p = filePrompt(ctx, { contextTokens: 2048, maxOutputTokens: 1500 });
    assert.equal(p.fits, false);
    assert.equal(filePrompt({ ...ctx, source: "x" }, { contextTokens: 2600, maxOutputTokens: 1500 }).fits, true, "a tiny file needs hardly any room");
    assert.equal(filePrompt({ ...ctx, source: "x" }, { contextTokens: 2048, maxOutputTokens: 1500 }).fits, false, "but with no room at all, nothing fits");
  });
  it("trims long file lists in a module prompt, and says how many", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ path: `src/m/file${i}.ts`, description: "Does a fairly ordinary thing that takes a sentence." }));
    const c = { path: "src/m", files, submodules: [{ path: "src/m/sub", description: "Sub." }], dependsOn: [], usedBy: [], feedback: [] };
    const small = modulePrompt(c, { contextTokens: 4096, maxOutputTokens: 1000 });
    assert.equal(small.truncated, true);
    assert.match(small.user, /\(and \d+ more not shown: it would not fit the model's context window\)/);
    assert.ok(estimateTokens(small.system) + estimateTokens(small.user) + 1000 < 4096);
    assert.match(small.user, /src\/m\/sub: Sub\./, "submodules still get a share");
    assert.equal(modulePrompt(c).truncated, false, "no limits, no trimming");
    assert.equal(modulePrompt({ ...c, files: files.slice(0, 3) }, { contextTokens: 4096, maxOutputTokens: 1000 }).truncated, false);
    assert.equal(modulePrompt(c, { contextTokens: 1200, maxOutputTokens: 1000 }).fits, false);
  });
  it("keeps the system prompt in the fixed part, so a tiny window leaves visibly little", () => {
    assert.ok(estimateTokens(SYSTEM_PROMPT) > 150);
  });
});

describe("testing the connection", () => {
  let fake: Awaited<ReturnType<typeof startFakeLlm>>;
  before(async () => { fake = await startFakeLlm(() => ({ json: {} })); });
  after(() => fake.close());
  const route = (models: string[] | "down" | 404, chat: Parameters<typeof openAiOk>[1] & { text?: string; status?: number } = {}): Handler => (r) => {
    if (r.path.endsWith("/models")) return models === "down" ? { status: 500, json: {} } : models === 404 ? { status: 404, json: {} } : { json: { data: models.map((id) => ({ id })) } };
    if (chat.status) return { status: chat.status, json: { error: "x" } };
    return { json: openAiOk(chat.text ?? "ready", chat) };
  };
  const setup = (o: Record<string, string> = {}, url = fake.url + "/v1") => llmFromEnv({ BRAIN_LLM_MODE: "local", BRAIN_LLM_MODEL: "llama3.1", BRAIN_LLM_BASE_URL: url, ...o }, server);

  it("passes when the server has the model and answers", async () => {
    fake.setHandler(route(["llama3.1:latest", "qwen:7b"]));
    const r = await testLlm(setup());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.mode, r.model, r.answeredBy, r.reply, r.modelFound], ["local", "llama3.1", "llama-test", "ready", true]);
    assert.deepEqual(r.modelsAvailable, ["llama3.1:latest", "qwen:7b"]);
    assert.deepEqual([r.reach, r.endpoint, r.contextTokens], ["this-machine", fake.url + "/v1", 8192]);
    assert.ok(r.latencyMs! >= 0 && r.inputTokens === 800 && r.tokensSource === "provider-reported");
    assert.deepEqual(r.problems, []);
  });
  it("names the models that are there when the one asked for is not", async () => {
    fake.setHandler(route(["qwen:7b", "mistral:7b"]));
    const r = await testLlm(setup());
    assert.equal(r.ok, false);
    assert.equal(r.modelFound, false);
    assert.match(r.problems[0], /does not have a model called “llama3.1”/);
    assert.match(r.hints.join(" "), /It has: mistral:7b, qwen:7b\. Run “Brain: Choose Local Model”/);
  });
  it("tells you when the server has no models at all", async () => {
    fake.setHandler(route([]));
    const r = await testLlm(setup());
    assert.match(r.hints.join(" "), /lists no models/);
  });
  it("carries on when the server has no model listing but does answer", async () => {
    fake.setHandler(route(404));
    const r = await testLlm(setup());
    assert.equal(r.ok, true);
    assert.equal(r.modelsAvailable, null);
    assert.match(r.hints.join(" "), /did not list its models/);
  });
  it("explains a server that is not running, with a hint for the one it looks like", async function (t) {
    const free = (port: number) => new Promise<boolean>((resolve) => { const s = net.createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true))); });
    if (!(await free(11434))) return t.skip("port 11434 is in use here");
    const r = await testLlm(setup({}, "http://127.0.0.1:11434/v1"));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /Could not reach http:\/\/127\.0\.0\.1:11434\/v1/);
    assert.match(r.hints.join(" "), /Is Ollama running\? Start it with `ollama serve`/);
    const generic = await testLlm(setup({}, "http://127.0.0.1:1/v1"));
    assert.match(generic.hints.join(" "), /“brain\.llm\.baseUrl” is its OpenAI-compatible URL/);
  });
  it("reports a server error from the request itself, and a model that answered with nothing", async () => {
    fake.setHandler(route(["llama3.1"], { status: 500 }));
    assert.equal((await testLlm(setup())).ok, false);
    fake.setHandler(route(["llama3.1"], { text: "   " }));
    const empty = await testLlm(setup());
    assert.match(empty.problems.join(), /answered with nothing/);
    fake.setHandler(route(["llama3.1"], { finish: "length", text: "" }));
    const len = await testLlm(setup());
    assert.equal(len.ok, true, "running out of a tiny allowance is not a broken connection");
    assert.match(len.hints.join(), /connection works/);
    fake.setHandler(route(["llama3.1"], { finish: "content_filter" }));
    assert.match((await testLlm(setup())).problems.join(), /declined/);
  });
  it("warns about a small window and about a URL that is not on this machine", async () => {
    fake.setHandler(route(["llama3.1"]));
    const small = await testLlm(setup({ BRAIN_LLM_CONTEXT_TOKENS: "2048" }));
    assert.match(small.hints.join(), /context window is set to 2048 tokens.*OLLAMA_CONTEXT_LENGTH/);
    const remote = await testLlm(setup({}, "https://llm.invalid/v1"));
    assert.equal(remote.reach, "internet");
    assert.match(remote.hints.join(" "), /on the internet, so this is not a local model/);
    const lan = await testLlm(setup({}, "http://10.255.255.1:9/v1"));
    assert.match(lan.hints.join(" "), /on your network, not this machine/);
  });
  it("answers plainly when nothing is configured", async () => {
    const r = await testLlm(llmFromEnv({}, server));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /Server-side generation is off/);
  });
});

describe("local generation on a server that can only take so much", () => {
  const BIG = Array.from({ length: 4000 }, (_, i) => `export const value${i} = ${i}; // padding to make this file long`).join("\n");
  async function local(o: { ctx?: string; out?: string; url?: string; handler?: Handler; extra?: Record<string, string> } = {}) {
    const fake = await startFakeLlm(o.handler ?? ((r) => (r.path.endsWith("/models") ? { json: { data: [{ id: "llama-test" }] } } : { json: openAiOk(docFor(r), { in: 700, out: 120 }) })));
    const ws = fixture(o.extra);
    const env: Record<string, string> = { BRAIN_LLM_MODE: "local", BRAIN_LLM_MODEL: "llama-test", BRAIN_LLM_BASE_URL: o.url ?? fake.url + "/v1" };
    if (o.ctx) env.BRAIN_LLM_CONTEXT_TOKENS = o.ctx;
    if (o.out) env.BRAIN_LLM_MAX_OUTPUT_TOKENS = o.out;
    const admin = await connect(ws, { admin: true, clientName: "brain-vscode", env });
    await ready(admin, 4 + Object.keys(o.extra ?? {}).length);
    await tool(admin, AdminTools.init);
    const job = async () => { for (let i = 0; i < 300; i++) { const s = await readJson(admin, Resources.generation); if (["done", "stopped", "failed"].includes(s.state)) return s; await new Promise((r) => setTimeout(r, 50)); } throw new Error("job never finished"); };
    return { fake, ws, admin, job, close: async () => { await admin.close(); await fake.close(); rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } };
  }

  it("blocks a window that is too small to document anything, and says what to change", async () => {
    const s = await local({ ctx: "1000" });
    try {
      const e = (await tool(s.admin, AdminTools.estimateGeneration)).body;
      assert.equal(e.canStart, false);
      assert.match(e.blocked, new RegExp(`context window is set to 1000 tokens.*at least ${MIN_CONTEXT_TOKENS}`));
      assert.match(e.blocked, /brain\.llm\.local\.contextTokens/);
      assert.equal((await tool(s.admin, AdminTools.generateDocs, { confirm: true })).isError, true);
      assert.equal(s.fake.requests.length, 0);
    } finally { await s.close(); }
  });

  it("skips what cannot fit instead of sending half a thought, and cuts the rest to fit, saying so", async () => {
    const s = await local({ ctx: "4096", out: "1500", extra: { "src/big.ts": BIG } });
    try {
      const e = (await tool(s.admin, AdminTools.estimateGeneration, { kind: "file" })).body;
      assert.ok(e.canStart, e.blocked);
      assert.ok(e.warnings.some((w: string) => /will be written from partial input/.test(w)), e.warnings.join("|"));
      assert.ok(e.warnings.some((w: string) => /sized for a 4096-token context window.*cut prompts off silently/.test(w)));
      assert.ok(e.warnings.some((w: string) => /Runs on this machine/.test(w)));
      await tool(s.admin, AdminTools.generateDocs, { confirm: true, kind: "file" });
      const job = await s.job();
      assert.equal(job.state, "done");
      const big = job.results.find((r: any) => r.target === "src/big.ts");
      assert.equal(big.outcome, "drafted");
      assert.match(big.message, /partial input/);
      const prompt = userText(s.fake.requests.find((r) => /File: src\/big\.ts/.test(userText(r)))!);
      assert.ok(estimateTokens(SYSTEM_PROMPT) + estimateTokens(prompt) + 1500 < 4096, "the real prompt fits the window the person said they have");
      assert.equal(s.fake.requests.filter((r) => r.body?.max_tokens).every((r) => r.body.max_tokens === 1500), true, "and asks for no more than the configured answer length");
      const fm = parseConcept(readFileSync(path.join(s.ws, ".brain/drafts/files/src/big.ts.md"), "utf8"));
      assert.ok(fm.ok);
      assert.equal((fm.fm.brain as any).input_truncated, true);
    } finally { await s.close(); }
  });

  it("skips a file whose code leaves no room at all, without calling the model for it", async () => {
    const s = await local({ ctx: "2200", out: "1500", extra: { "src/big.ts": BIG } });
    try {
      await tool(s.admin, AdminTools.generateDocs, { confirm: true, under: "src/big.ts" }).then(async (r) => assert.equal(r.isError, true, "a lone target that does not fit blocks the job"));
      const e = (await tool(s.admin, AdminTools.estimateGeneration, { under: "src/big.ts" })).body;
      assert.match(e.blocked, /None of the 1 targets fit the model's 2200-token context window/);
      assert.equal(s.fake.requests.filter((r) => !r.path.endsWith("/models")).length, 0);
    } finally { await s.close(); }
  });

  it("warns when part of a job will be skipped, and skips exactly those", async () => {
    const s = await local({ ctx: "2500", out: "1500", extra: { "src/big.ts": BIG } }); // room for a short file's code, not for a long one's
    try {
      const e = (await tool(s.admin, AdminTools.estimateGeneration, { kind: "file" })).body;
      assert.ok(e.warnings.some((w: string) => /1 target will be skipped/.test(w)), e.warnings.join("|"));
      assert.equal(e.targets.some((t: any) => t.target === "src/big.ts"), false, "skipped targets are not in the plan");
      await tool(s.admin, AdminTools.generateDocs, { confirm: true, kind: "file" });
      const job = await s.job();
      const big = job.results.find((r: any) => r.target === "src/big.ts");
      assert.equal(big.outcome, "skipped", "reported, with the reason, not silently dropped");
      assert.match(big.message, /Too big for the model's 2500-token context window, so it was not sent/);
      assert.equal(s.fake.requests.some((r) => /File: src\/big\.ts/.test(userText(r))), false, "and never sent to the model");
      assert.equal(job.drafted, 4, "the files that fit were written");
    } finally { await s.close(); }
  });

  it("is honest about a 'local' URL that is on the network or the internet, and does not call it free", async () => {
    const lan = await local({ url: "http://10.1.2.3:1234/v1" });
    try {
      const e = (await tool(lan.admin, AdminTools.estimateGeneration)).body;
      assert.ok(e.warnings.some((w: string) => /Sends your source code to 10\.1\.2\.3 on your network, unencrypted/.test(w)), e.warnings.join("|"));
      assert.deepEqual(e.totals.costUsd, { low: 0, high: 0 }, "a server on your own network costs no money");
    } finally { await lan.close(); }

    const web = await local({ url: "https://api.some-llm-host.example/v1" });
    try {
      const e = (await tool(web.admin, AdminTools.estimateGeneration)).body;
      assert.ok(e.warnings.some((w: string) => /over the internet to api\.some-llm-host\.example\. This is not a local model/.test(w)));
      assert.equal(e.totals.costUsd, null, "a service on the internet is not free: no price, no cost known");
      assert.ok(e.warnings.some((w: string) => /has no price set/.test(w)));
      const cfg = (await tool(web.admin, AdminTools.getConfig)).body;
      await tool(web.admin, AdminTools.setConfig, { config: { ...cfg, docs: { ...cfg.docs, maxCostUsd: 5 } } });
      const capped = (await tool(web.admin, AdminTools.estimateGeneration)).body;
      assert.equal(capped.canStart, false);
      assert.match(capped.blocked, /cap cannot be enforced/, "a budget cap needs a price for anything that is not free");
    } finally { await web.close(); }
  });

  it("tests the connection and lists models through the server, for the extension only", async () => {
    const s = await local();
    const agent = await connect(s.ws, { clientName: "claude-code" });
    try {
      const t = (await tool(s.admin, AdminTools.testLlm)).body;
      assert.equal(t.ok, true, JSON.stringify(t));
      assert.deepEqual(t.modelsAvailable, ["llama-test"]);
      const l = (await tool(s.admin, AdminTools.listLlmModels)).body;
      assert.deepEqual([l.models, l.current, l.endpoint], [["llama-test"], "llama-test", s.fake.url + "/v1"]);
      assert.equal((await tool(agent, AdminTools.testLlm)).isError, true, "an agent cannot probe the LLM");
      assert.equal((await tool(agent, AdminTools.listLlmModels)).isError, true);
      assert.ok(!JSON.stringify(t).includes("authorization"));
    } finally { await agent.close(); await s.close(); }
    void existsSync;
  });
});
