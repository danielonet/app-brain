import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { _clearCopilotCache, readCopilotUsage, replaySession, requestUsage } from "../providerUsage/copilotLogs";
import { collectProviderUsage } from "../providerUsage";
import { cleanDir } from "./cleanDir";

// A session file shaped like the ones Copilot Chat writes (checked against real files): a snapshot, "add requests" lines, and
// "set this field" lines. The text in it is made up; only the structure and number fields are real.
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0); // 2026-11-10
const T1 = Date.UTC(2026, 10, 12, 12, 0, 0); // 2026-11-12
const session = (extra: object[] = []) => [
  { kind: 0, v: { version: 3, requests: [], inputState: { inputText: "SECRET PROMPT" } } },
  { kind: 2, k: ["requests"], v: [{ requestId: "a", timestamp: T0, modelId: "copilot/auto", message: { text: "SECRET PROMPT" } }] },
  { kind: 1, k: ["requests", 0, "promptTokens"], v: 30000 },
  { kind: 1, k: ["requests", 0, "completionTokens"], v: 1200 },
  { kind: 1, k: ["requests", 0, "copilotCredits"], v: 1.5 },
  { kind: 1, k: ["requests", 0, "promptTokens"], v: 52000 }, // a later round replaces the earlier value
  { kind: 1, k: ["requests", 0, "completionTokens"], v: 13000 },
  { kind: 1, k: ["requests", 0, "copilotCredits"], v: 4.25 },
  { kind: 1, k: ["requests", 0, "result"], v: { metadata: { resolvedModel: "gpt-test", promptTokens: 52000, outputTokens: 281 } } },
  { kind: 2, k: ["requests"], v: [{ requestId: "b", timestamp: T1, modelId: "copilot/auto" }] },
  { kind: 1, k: ["requests", 1, "promptTokens"], v: 1000 },
  { kind: 1, k: ["requests", 1, "completionTokens"], v: 100 },
  { kind: 2, k: ["requests"], v: [{ requestId: "c", timestamp: T1, modelId: "copilot/auto" }] }, // never answered
  ...extra,
].map((o) => JSON.stringify(o)).join("\n") + "\n";

describe("Copilot Chat session files", () => {
  it("replays the change log: the last value of a field wins, new requests are added", () => {
    const reqs = replaySession(session().split("\n"));
    assert.equal(reqs.length, 3);
    assert.equal(reqs[0].promptTokens, 52000);
    assert.equal(reqs[0].completionTokens, 13000);
    assert.equal(reqs[0].copilotCredits, 4.25);
  });
  it("takes the answering model from the result, else the picker's id, and ignores unanswered requests", () => {
    const [a, b, c] = replaySession(session().split("\n")).map(requestUsage);
    assert.equal(a!.model, "gpt-test");
    assert.deepEqual([a!.counts.input, a!.counts.output, a!.credits, a!.day], [52000, 13000, 4.25, "2026-11-10"]);
    assert.equal(b!.model, "auto");
    assert.equal(b!.credits, null);
    assert.equal(c, null);
  });
  it("skips garbage lines and cannot be made to write to a prototype", () => {
    const lines = ["not json", "[]", "null", JSON.stringify({ kind: 1, k: ["requests", 0, "__proto__"], v: { polluted: 1 } }), ...session().split("\n")];
    assert.equal(replaySession(lines).length, 3);
    assert.equal(({} as any).polluted, undefined);
  });
  it("inserts at the index a line names", () => {
    const lines = [JSON.stringify({ kind: 0, v: { requests: [{ requestId: "x" }, { requestId: "z" }] } }), JSON.stringify({ kind: 2, k: ["requests"], i: 1, v: [{ requestId: "y" }] })];
    assert.deepEqual(replaySession(lines).map((r) => r.requestId), ["x", "y", "z"]);
  });
});

describe("Copilot usage in the cost view", () => {
  let dir: string, base: string;
  before(() => { base = mkdtempSync(path.join(tmpdir(), "brain-copilot-")); });
  after(() => cleanDir(base));
  beforeEach(() => { _clearCopilotCache(); dir = path.join(base, String(Math.random()).slice(2)); mkdirSync(dir); });
  const now = new Date(Date.UTC(2026, 10, 15));

  it("totals tokens, credits, days and models, and prices only models that have a price", async () => {
    writeFileSync(path.join(dir, "s.jsonl"), session());
    const r = await readCopilotUsage({ dir, pricing: { "gpt-test": { inputPerMtok: 1, outputPerMtok: 10 } }, lookbackDays: 30, now });
    assert.equal(r.state, "ok");
    assert.deepEqual([r.sessions, r.totals.messages, r.totals.inputTokens, r.totals.outputTokens], [1, 2, 53000, 13100]);
    assert.equal(r.credits, 4.25);
    assert.deepEqual(r.byDay.map((d) => d.day), ["2026-11-10", "2026-11-12"]);
    assert.equal(r.byModel.find((m) => m.model === "gpt-test")!.costUsd, (52000 * 1 + 13000 * 10) / 1e6);
    assert.equal(r.byModel.find((m) => m.model === "auto")!.costUsd, null);
    assert.equal(r.complete, false, "the unpriced model makes the cost a lower bound");
    assert.deepEqual(r.unpricedModels, ["auto"]);
    assert.match(r.message, /lower bound/);
  });
  it("leaves out requests older than the window", async () => {
    writeFileSync(path.join(dir, "s.jsonl"), session());
    const r = await readCopilotUsage({ dir, pricing: {}, lookbackDays: 4, now }); // since 2026-11-11
    assert.equal(r.totals.messages, 1);
    assert.equal(r.credits, null, "the credits belonged to the older request");
  });
  it("skips a file untouched for longer than the window", async () => {
    const f = path.join(dir, "old.jsonl");
    writeFileSync(f, session());
    utimesSync(f, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
    assert.equal((await readCopilotUsage({ dir, pricing: {}, lookbackDays: 30, now })).state, "none");
  });
  it("says so, rather than failing, when there is nothing to read", async () => {
    assert.equal((await readCopilotUsage({ dir: undefined, pricing: {}, lookbackDays: 30, now })).state, "none");
    assert.match((await readCopilotUsage({ dir: path.join(base, "missing"), pricing: {}, lookbackDays: 30, now })).message, /has not been used/);
    assert.equal((await readCopilotUsage({ dir, pricing: {}, lookbackDays: 30, now })).state, "none");
  });
  it("never keeps what was typed or answered", async () => {
    writeFileSync(path.join(dir, "s.jsonl"), session());
    const r = await readCopilotUsage({ dir, pricing: {}, lookbackDays: 30, now });
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  });
  it("is part of the provider report, and the setting turns it off", async () => {
    writeFileSync(path.join(dir, "s.jsonl"), session());
    const base2 = { workspace: dir, pricing: {}, adminKey: undefined, copilotSessionsDir: dir, now, home: dir, env: { CLAUDE_CONFIG_DIR: dir } };
    const on = await collectProviderUsage({ ...base2, settings: { claudeCodeLogs: false, anthropicAdmin: false, lookbackDays: 30 } });
    assert.equal(on.copilot.state, "ok");
    const off = await collectProviderUsage({ ...base2, settings: { claudeCodeLogs: false, copilotLogs: false, anthropicAdmin: false, lookbackDays: 30 } });
    assert.equal(off.copilot.state, "off");
  });
});
