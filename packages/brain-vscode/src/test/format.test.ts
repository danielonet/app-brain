import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BrainStatus } from "@app-brain/brain-protocol";
import { activityItems, bulkConfirmation, bulkResultMessage, bulkScopes, describeArgs, folderGroups, isPlainDraft, flashText, mcpConfigSnippet, reviewRows, statusBarText, validationReport, validationSummary } from "../format";

const base: BrainStatus = {
  state: "idle", initialised: true, workspace: "/w", outputDir: "/w/.brain", serverVersion: "0.0.0",
  protocolVersion: "0.2", startedAt: "", knowledge: { reviewed: 2, drafts: 0, stale: 1 }, cost: { calls: 0, spendUsd: 0, complete: true }, llm: { mode: "agent", model: null, ready: false, problem: null }, server: { pid: 4242, transport: "stdio", clients: [] }, index: { files: 3, symbols: 12, edges: 4, byLanguage: { typescript: 2, python: 1 }, lastIndexedAt: null }, message: null,
};

describe("statusBarText", () => {
  it("ready", () => {
    const v = statusBarText("connected", base);
    assert.equal(v.text, "$(book) Brain: ready · 3 files · 12 symbols");
    assert.match(v.tooltip, /4 import links/);
    assert.match(v.tooltip, /typescript: 2, python: 1/);
  });
  it("shows how many docs await review, and the doc counts in the tooltip", () => {
    const v = statusBarText("connected", { ...base, knowledge: { reviewed: 2, drafts: 3, stale: 1 } });
    assert.match(v.text, / · 3 to review$/);
    assert.match(v.tooltip, /2 reviewed, 3 awaiting review, 1 stale/);
    assert.ok(!statusBarText("connected", base).text.includes("to review"));
  });
  it("shows the running spend, and says when it is a lower bound", () => {
    assert.ok(!statusBarText("connected", base).tooltip.includes("spend"), "nothing to show before any call");
    const calls = { ...base, cost: { calls: 3, spendUsd: 1.234, complete: true } };
    assert.match(statusBarText("connected", calls).tooltip, /LLM spend: \$1\.23 over 3 calls/);
    assert.match(statusBarText("connected", { ...calls, cost: { calls: 1, spendUsd: 0, complete: false } }).tooltip, /\$0\.00 or more \(some calls could not be priced\) over 1 call\n/);
    assert.match(statusBarText("connected", { ...calls, cost: { calls: 2, spendUsd: 0.004, complete: true } }).tooltip, /<\$0\.01/);
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

describe("review queue and validation", () => {
  const item = (over = {}) => ({
    target: "src/a.ts", kind: "file" as const, conceptPath: "files/src/a.ts.md", draftFile: ".brain/drafts/files/src/a.ts.md",
    description: "Does a.", generatedBy: "claude-code/m1", generatedAt: "2026-11-16T10:00:00Z", model: "m1", stale: false, replacesReviewed: false, ...over,
  });
  it("describes drafts and flags stale ones and replacements", () => {
    const [a, b] = reviewRows([item(), item({ target: "src/b.ts", stale: true, replacesReviewed: true, model: null })]);
    assert.equal(a.label, "src/a.ts");
    assert.equal(a.description, "file · m1");
    assert.ok(!a.stale);
    assert.equal(b.description, "file · claude-code/m1 · code changed since · replaces reviewed doc");
    assert.ok(b.stale);
    assert.match(b.tooltip, /code changed after this draft/);
    assert.deepEqual(reviewRows([]), []);
  });
  it("offers the safest bulk choice first, and leaves out drafts that deserve a look", () => {
    const items = [item(), item({ target: "src/b.ts" }), item({ target: "src/c.ts", stale: true }), item({ target: "src/d.ts", replacesReviewed: true })];
    assert.deepEqual(items.map(isPlainDraft), [true, true, false, false]);
    const scopes = bulkScopes(items);
    assert.deepEqual(scopes.map((s) => s.id), ["fresh", "folders", "pick", "all"]);
    assert.deepEqual(scopes[0].items.map((i) => i.target), ["src/a.ts", "src/b.ts"]);
    assert.match(scopes[0].label, /\(2\)/);
    assert.match(scopes[0].description, /leaves out 2 drafts/);
    assert.equal(scopes[3].items.length, 4);
    assert.match(scopes[3].description, /2 drafts whose code changed or that replace a reviewed doc/);
  });
  it("does not offer 'everything' as a second option when nothing is set apart", () => {
    assert.deepEqual(bulkScopes([item(), item({ target: "src/b.ts" })]).map((s) => s.id), ["fresh", "folders", "pick"]);
    assert.deepEqual(bulkScopes([]).map((s) => s.id), ["folders", "pick"]);
  });
  it("groups drafts by the folder of their code, largest first, with a module's doc in its own folder", () => {
    const groups = folderGroups([
      item({ target: "src/auth/a.ts" }), item({ target: "src/auth/b.ts" }), item({ target: "src/db/p.ts" }),
      item({ target: "src/auth", kind: "module" }), item({ target: "top.ts" }), item({ target: ".", kind: "module" }),
    ]);
    assert.deepEqual(groups.map((g) => [g.folder, g.items.length]), [["src/auth", 3], [".", 2], ["src/db", 1]]);
  });
  it("says what approving many means, and what is different about some of them", () => {
    const plain = bulkConfirmation([item(), item({ target: "src/b.ts" })], "jdoe");
    assert.equal(plain.message, "Approve 2 drafts?");
    assert.equal(plain.button, "Approve 2");
    assert.match(plain.detail, /reviewed by jdoe/);
    assert.match(plain.detail, /approved_in_bulk/);
    assert.doesNotMatch(plain.detail, /changed after|replace a document/);
    const mixed = bulkConfirmation([item({ stale: true }), item({ target: "b", replacesReviewed: true })], "jdoe");
    assert.match(mixed.detail, /1 draft describe code that changed/);
    assert.match(mixed.detail, /1 draft replace a document someone already reviewed/);
    assert.equal(bulkConfirmation([item()], "j").message, "Approve 1 draft?");
  });
  it("reports a bulk result in a line, and points at the output when some failed", () => {
    assert.equal(bulkResultMessage("approve", 214, []), "Approved 214 drafts.");
    assert.equal(bulkResultMessage("reject", 1, []), "Rejected 1 draft.");
    assert.match(bulkResultMessage("approve", 10, [{ target: "a", error: "x" }]), /Approved 10; 1 could not be approved \(see the Brain output\)/);
  });
  it("reports errors first", () => {
    const r = { conformant: false, concepts: 3, issues: [
      { severity: "info" as const, code: "orphan" as const, file: "z.md", message: "No inbound." },
      { severity: "error" as const, code: "missing-type" as const, file: "a.md", message: "No type." },
      { severity: "warning" as const, code: "cycle" as const, file: "m.md", message: "Loop." },
    ] };
    const lines = validationReport(r);
    assert.equal(lines[0], "Knowledge bundle: 3 concepts, NOT conformant OKF");
    assert.match(lines[1], /^ {2}ERROR {3}a\.md: No type\./);
    assert.match(lines[2], /WARNING m\.md/);
    assert.match(lines[3], /INFO {4}z\.md/);
    assert.equal(validationSummary(r), "Not conformant: 1 errors, 1 warnings, 1 notes");
    assert.deepEqual(validationReport({ conformant: true, concepts: 1, issues: [] }), ["Knowledge bundle: 1 concept, conformant OKF", "  No issues."]);
  });
});
