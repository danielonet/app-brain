import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BrainStatus } from "@app-brain/brain-protocol";
import { activityItems, describeArgs, flashText, mcpConfigSnippet, statusBarText } from "../format";

const base: BrainStatus = {
  state: "idle", initialised: true, workspace: "/w", outputDir: "/w/.brain", serverVersion: "0.0.0",
  protocolVersion: "0.1", startedAt: "", index: { files: 3, symbols: 12, edges: 4, byLanguage: { typescript: 2, python: 1 }, lastIndexedAt: null }, message: null,
};

describe("statusBarText", () => {
  it("ready", () => {
    const v = statusBarText("connected", base);
    assert.equal(v.text, "$(book) Brain: ready · 3 files · 12 symbols");
    assert.match(v.tooltip, /4 import links/);
    assert.match(v.tooltip, /typescript: 2, python: 1/);
  });
  it("singular", () => assert.match(statusBarText("connected", { ...base, index: { ...base.index, files: 1, symbols: 1 } }).text, /1 file · 1 symbol$/));
  it("not initialised", () => assert.match(statusBarText("connected", { ...base, initialised: false }).text, /not initialised/));
  it("indexing", () => assert.match(statusBarText("connected", { ...base, state: "indexing", message: "Scanning files" }).text, /Scanning files/));
  it("error states are flagged", () => {
    assert.ok(statusBarText("failed", null).error);
    assert.ok(statusBarText("connected", { ...base, state: "error", message: "boom" }).error);
  });
  it("stopped and starting", () => {
    assert.match(statusBarText("disconnected", null).text, /stopped/);
    assert.match(statusBarText("connecting", null).text, /starting/);
  });
});

describe("mcpConfigSnippet", () => {
  it("has no admin token", () => {
    const s = mcpConfigSnippet("/x/cli.js", "/w", ".brain");
    assert.ok(!/token/i.test(s));
    assert.deepEqual(JSON.parse(s).mcpServers.brain.args, ["/x/cli.js", "--workspace", "/w", "--output-dir", ".brain"]);
  });
});

describe("agent activity", () => {
  const entry = (over = {}) => ({ id: 1, ts: "2026-11-16T10:00:00.000Z", client: "claude-code", tool: "search_code", args: '{"query":"user by id","limit":10}', resultTokens: 340, latencyMs: 12.4, isError: false, ...over });

  it("describes arguments, surviving truncated JSON", () => {
    assert.equal(describeArgs('{"query":"user by id"}'), '"user by id"');
    assert.equal(describeArgs('{"name":"SessionStore.get"}'), '"SessionStore.get"');
    assert.equal(describeArgs('{"path":"src/a.ts","depth":2}'), '"src/a.ts"');
    assert.equal(describeArgs('{"query":"cut off'), "");
    assert.equal(describeArgs("{}"), "");
  });
  it("flashes who called what", () => assert.equal(flashText(entry()), "$(eye) Brain ◉ claude-code · search_code"));
  it("explains how to connect when nothing has called yet", () => {
    const items = activityItems({ total: 0, byClient: {}, byTool: {}, recent: [] });
    assert.equal(items.length, 1);
    assert.match(items[0].label, /No agent has used the brain/);
    assert.equal(activityItems(null).length, 1);
  });
  it("summarises then lists calls, flagging failures", () => {
    const items = activityItems({
      total: 2, byClient: { "claude-code": 1, copilot: 1 }, byTool: { search_code: 2 },
      recent: [entry({ id: 2, isError: true, client: "copilot" }), entry()],
    });
    assert.equal(items[0].label, "2 calls");
    assert.equal(items[0].description, "claude-code: 1, copilot: 1");
    assert.equal(items[1].label, 'search_code "user by id"');
    assert.equal(items[1].description, "copilot · 12 ms · ~340 tok");
    assert.ok(items[1].error && !items[2].error);
  });
});
