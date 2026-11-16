import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LlmTestResult } from "@app-brain/brain-protocol";
import { LOCAL_DEFAULT_CONTEXT_TOKENS, LOCAL_DEFAULT_MAX_OUTPUT_TOKENS, LOCAL_PRESETS, MIN_CONTEXT_TOKENS, llmFingerprint, pidAlive, readDaemonInfo, runtimeDir } from "@app-brain/brain-protocol";
import { ensureDaemon } from "../daemonManager";
import { llmTestSummary } from "../format";
import { daemonLlm, llmEnv, localBaseUrl, localProblems } from "../llmEnv";

const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
const props = manifest.contributes.configuration.properties;
const base = { mode: "local", model: "llama3.1", baseUrl: "", effort: "" };

describe("local LLM settings", () => {
  it("fills in the preset's usual address, and lets an explicit URL win", () => {
    assert.equal(localBaseUrl({ baseUrl: "", preset: "ollama" }), "http://localhost:11434/v1");
    assert.equal(localBaseUrl({ baseUrl: "", preset: "lm-studio" }), "http://localhost:1234/v1");
    assert.equal(localBaseUrl({ baseUrl: "", preset: "llama-cpp" }), "http://localhost:8080/v1");
    assert.equal(localBaseUrl({ baseUrl: "", preset: "custom" }), "", "custom has no usual address");
    assert.equal(localBaseUrl({ baseUrl: "", preset: undefined }), "http://localhost:11434/v1", "an old settings object defaults to Ollama");
    assert.equal(localBaseUrl({ baseUrl: " http://gpu-box:9000/v1 ", preset: "ollama" }), "http://gpu-box:9000/v1");
    assert.equal(localBaseUrl({ baseUrl: "", preset: "nonsense" }), "");
  });

  it("sends the window, the answer length and the timeout to a local server, and only to a local server", () => {
    const local = llmEnv({ ...base, preset: "lm-studio", contextTokens: 16384, maxOutputTokens: 900, timeoutSeconds: 120 }, undefined);
    assert.deepEqual(local, {
      BRAIN_LLM_MODE: "local", BRAIN_LLM_MODEL: "llama3.1", BRAIN_LLM_BASE_URL: "http://localhost:1234/v1",
      BRAIN_LLM_CONTEXT_TOKENS: "16384", BRAIN_LLM_MAX_OUTPUT_TOKENS: "900", BRAIN_LLM_TIMEOUT_MS: "120000",
    });
    for (const mode of ["api-key", "vscode-lm", "agent"]) {
      const env = llmEnv({ ...base, mode, preset: "lm-studio", contextTokens: 16384, maxOutputTokens: 900, timeoutSeconds: 120 }, "k");
      for (const k of ["BRAIN_LLM_CONTEXT_TOKENS", "BRAIN_LLM_MAX_OUTPUT_TOKENS", "BRAIN_LLM_TIMEOUT_MS"]) assert.equal(env[k], undefined, `${k} in ${mode} mode`);
    }
    assert.equal(llmEnv({ ...base, mode: "api-key", preset: "ollama" }, "k").BRAIN_LLM_BASE_URL, undefined, "a preset's address is for local mode only: api-key mode would send your key there");
  });

  it("leaves out zero, fractional and missing values instead of sending something the server would have to second-guess", () => {
    const env = llmEnv({ ...base, preset: "ollama", contextTokens: 0, maxOutputTokens: undefined, timeoutSeconds: 0 }, undefined);
    assert.deepEqual(Object.keys(env).sort(), ["BRAIN_LLM_BASE_URL", "BRAIN_LLM_MODE", "BRAIN_LLM_MODEL"]);
    assert.equal(llmEnv({ ...base, preset: "ollama", contextTokens: 8192.9 }, undefined).BRAIN_LLM_CONTEXT_TOKENS, "8192");
  });

  it("catches settings that would fail or quietly do badly, before anything is spent", () => {
    assert.deepEqual(localProblems({ ...base, preset: "ollama", contextTokens: 8192 }), []);
    assert.deepEqual(localProblems({ ...base, mode: "api-key" }), [], "only local mode is checked");
    assert.match(localProblems({ ...base, model: " ", preset: "ollama" })[0], /Set “brain\.llm\.model”.*Choose Local Model/);
    assert.match(localProblems({ ...base, preset: "custom" })[0], /custom.*needs “brain\.llm\.baseUrl”/);
    assert.match(localProblems({ ...base, preset: "custom", baseUrl: "not a url" })[0], /is not a valid URL/);
    assert.match(localProblems({ ...base, preset: "ollama", contextTokens: 1024 })[0], new RegExp(`too small.*at least ${MIN_CONTEXT_TOKENS}`));
    assert.equal(localProblems({ ...base, preset: "ollama", contextTokens: 0 }).length, 0, "zero means the default");
    assert.equal(localProblems({ ...base, model: "", preset: "custom", contextTokens: 100 }).length, 3, "all of them at once");
  });
});

describe("the settings offered", () => {
  it("lists exactly the presets the server knows, with the addresses it would use", () => {
    assert.deepEqual(props["brain.llm.local.preset"].enum, Object.keys(LOCAL_PRESETS));
    assert.equal(props["brain.llm.local.preset"].default, "ollama");
    assert.equal(props["brain.llm.local.preset"].enumDescriptions.length, Object.keys(LOCAL_PRESETS).length);
    for (const [key, p] of Object.entries(LOCAL_PRESETS)) {
      if (p.baseUrl) assert.ok(props["brain.llm.local.preset"].enumDescriptions[Object.keys(LOCAL_PRESETS).indexOf(key)].includes(p.baseUrl), `${key} description names ${p.baseUrl}`);
    }
  });
  it("defaults to the same numbers the server falls back to, so setting nothing and setting the default agree", () => {
    assert.equal(props["brain.llm.local.contextTokens"].default, LOCAL_DEFAULT_CONTEXT_TOKENS);
    assert.equal(props["brain.llm.local.maxOutputTokens"].default, LOCAL_DEFAULT_MAX_OUTPUT_TOKENS);
    assert.equal(props["brain.llm.local.timeoutSeconds"].default, 600);
    for (const k of ["contextTokens", "maxOutputTokens", "timeoutSeconds"]) assert.equal(props[`brain.llm.local.${k}`].type, "integer");
  });
  it("warns where the problem actually is: servers default to a small window of their own", () => {
    const d = props["brain.llm.local.contextTokens"].markdownDescription;
    assert.match(d, /Servers often default to a small window/);
    assert.match(d, /OLLAMA_CONTEXT_LENGTH/);
    assert.match(d, /cut prompts off without telling anyone/);
  });
  it("tells you what happens when the URL is not on your machine", () => {
    assert.match(props["brain.llm.baseUrl"].markdownDescription, /confirmation dialog says where your code will go/);
  });
  it("registers and contributes the two new commands", () => {
    const ids = manifest.contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(ids.includes("brain.testLlm") && ids.includes("brain.chooseLocalModel"));
  });
});

describe("handing local settings to the shared server", () => {
  const spaces: { ws: string; rt: string; pid?: number }[] = [];
  after(() => { for (const s of spaces) { if (s.pid) try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } rmSync(s.ws, { recursive: true, force: true }); rmSync(s.rt, { recursive: true, force: true }); } });

  it("fingerprints the window, so changing it replaces the daemon, and the two sides always agree", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "brain-local-ws-"));
    mkdirSync(path.join(ws, "src"));
    writeFileSync(path.join(ws, "src/a.ts"), "export function a() {}\n");
    execFileSync("git", ["init", "-q"], { cwd: ws });
    const rt = mkdtempSync(path.join(tmpdir(), "brain-local-rt-"));
    const space = { ws, rt } as { ws: string; rt: string; pid?: number };
    spaces.push(space);
    const env: NodeJS.ProcessEnv = { ...process.env, BRAIN_RUNTIME_DIR: rt };
    const opts = (ctx: number) => ({
      nodePath: process.execPath, serverPath: require.resolve("@app-brain/brain-mcp/out/cli.js"), workspace: ws, outputDir: ".brain",
      adminToken: "adm-local-0123456789abcdef0123456789abcdef", env, log: () => {}, startTimeoutMs: 20000,
      llm: daemonLlm({ ...base, preset: "ollama", contextTokens: ctx, maxOutputTokens: 1500, timeoutSeconds: 600 }, undefined),
    });

    const a = await ensureDaemon(opts(8192));
    space.pid = a.info.pid;
    assert.equal(a.info.llmFingerprint, llmFingerprint(a.info.agentToken, daemonLlm({ ...base, preset: "ollama", contextTokens: 8192, maxOutputTokens: 1500, timeoutSeconds: 600 }, undefined)), "what the daemon computed from its environment equals what the extension computes from settings");
    const same = await ensureDaemon(opts(8192));
    assert.deepEqual([same.spawned, same.info.pid], [false, a.info.pid]);

    const b = await ensureDaemon(opts(16384));
    space.pid = b.info.pid;
    assert.notEqual(b.info.pid, a.info.pid, "a different window is a different configuration");
    assert.equal(pidAlive(a.info.pid), false);
    assert.equal((await readDaemonInfo(runtimeDir(ws, env)))!.llmFingerprint, b.info.llmFingerprint);
    assert.notEqual(a.info.llmFingerprint, b.info.llmFingerprint);
  });
});

describe("what the person is told after a test", () => {
  const result = (o: Partial<LlmTestResult> = {}): LlmTestResult => ({
    ok: true, mode: "local", model: "llama3.1", answeredBy: "llama3.1:8b", endpoint: "http://localhost:11434/v1", reach: "this-machine", latencyMs: 1234,
    inputTokens: 31, outputTokens: 2, tokensSource: "provider-reported", reply: "ready", modelsAvailable: ["llama3.1:latest"], modelFound: true, contextTokens: 8192, problems: [], hints: [], ...o,
  });
  it("is quiet good news when all is well, and keeps the detail for the output channel", () => {
    const s = llmTestSummary(result());
    assert.deepEqual([s.level, s.text], ["info", "The LLM works on this machine: llama3.1:8b answered in 1.2s."]);
    const all = s.lines.join("\n");
    assert.match(all, /LLM test \(local, llama3\.1, http:\/\/localhost:11434\/v1\)/);
    assert.match(all, /Your code goes to a server on this machine\./);
    assert.match(all, /Answered in 1\.2s by llama3\.1:8b: “ready”\./);
    assert.match(all, /Tokens: 31 in, 2 out \(provider reported\)\./);
    assert.match(all, /sized for a 8192-token context window/);
    assert.match(all, /Models on the server: llama3\.1:latest\./);
  });
  it("leads with the problem and the first thing to try when it fails", () => {
    const s = llmTestSummary(result({ ok: false, latencyMs: null, answeredBy: null, reply: null, inputTokens: null, problems: ["Could not reach http://localhost:11434/v1: fetch failed."], hints: ["Is Ollama running? Start it with `ollama serve`, then check the URL."] }));
    assert.equal(s.level, "error");
    assert.equal(s.text, "The LLM is not working on this machine. Could not reach http://localhost:11434/v1: fetch failed. Is Ollama running? Start it with `ollama serve`, then check the URL.");
    assert.ok(s.lines.some((l) => l.startsWith("  PROBLEM: ")) && s.lines.some((l) => l.startsWith("  Hint: ")));
  });
  it("is a warning, not an error, when it works but there is something to know", () => {
    const s = llmTestSummary(result({ hints: ["The context window is set to 2048 tokens, so long files will be cut."] }));
    assert.equal(s.level, "warning");
    assert.match(s.text, /^The LLM works on this machine \(1\.2s\), with a note: The context window/);
  });
  it("says where your code goes when it is not this machine", () => {
    assert.match(llmTestSummary(result({ reach: "internet", ok: false, problems: ["x"] })).text, /not working on the internet/);
    assert.match(llmTestSummary(result({ reach: "local-network" })).text, /works on your network/);
    assert.match(llmTestSummary(result({ reach: "internet" })).lines.join("\n"), /Your code goes to a server on the internet\./);
    assert.doesNotMatch(llmTestSummary(result({ reach: null })).text, / on (this machine|your network|the internet)/);
  });
  it("copes with a result that has almost nothing in it", () => {
    const s = llmTestSummary(result({ ok: false, mode: "agent", model: null, endpoint: null, reach: null, latencyMs: null, answeredBy: null, reply: null, inputTokens: null, outputTokens: null, tokensSource: null, modelsAvailable: null, modelFound: null, contextTokens: null, problems: ["Server-side generation is off."], hints: [] }));
    assert.equal(s.level, "error");
    assert.equal(s.text, "The LLM is not working. Server-side generation is off.");
    assert.equal(s.lines[0], "LLM test (agent)");
  });
});
