import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BrainStatus } from "@app-brain/brain-protocol";
import { mcpConfigSnippet, statusBarText } from "../format";

const base: BrainStatus = {
  state: "idle", initialised: true, workspace: "/w", outputDir: "/w/.brain", serverVersion: "0.0.0",
  protocolVersion: "0.1", startedAt: "", index: { files: 3, byLanguage: { typescript: 2, python: 1 }, lastIndexedAt: null }, message: null,
};

describe("statusBarText", () => {
  it("ready", () => {
    const v = statusBarText("connected", base);
    assert.equal(v.text, "$(book) Brain: ready · 3 files");
    assert.match(v.tooltip, /typescript: 2, python: 1/);
  });
  it("singular", () => assert.match(statusBarText("connected", { ...base, index: { ...base.index, files: 1 } }).text, /1 file$/));
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
