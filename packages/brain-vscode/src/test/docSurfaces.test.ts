import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { DocStatusItem, UsageSummary } from "@app-brain/brain-protocol";
import { connectionReport, coverageGroups, coverageSummary, lensFor } from "../docSurfaces";

const item = (target: string, status: DocStatusItem["status"], kind: DocStatusItem["kind"] = "file"): DocStatusItem => ({ kind, target, status, docFile: status === "none" ? null : `.brain/${target}.md` });
const items = [item("src/z.ts", "reviewed"), item("src/a.ts", "stale"), item("src", "stale", "module"), item("src/b.ts", "none"), item("src/c.ts", "draft"), item("src/d.ts", "reviewed")];

describe("the coverage view", () => {
  it("puts what needs a person first and reviewed last, modules before files", () => {
    const g = coverageGroups(items);
    assert.deepEqual(g.map((x) => x.status), ["stale", "draft", "none", "reviewed"]);
    assert.deepEqual(g[0].items.map((i) => i.target), ["src", "src/a.ts"]);
  });
  it("leaves out empty groups", () => assert.deepEqual(coverageGroups([item("a.ts", "reviewed")]).map((g) => g.status), ["reviewed"]));
  it("summarises as a share of what is reviewed, and names the stale ones", () => {
    assert.equal(coverageSummary(items), "2 of 6 reviewed (33%), 2 stale");
    assert.equal(coverageSummary([item("a.ts", "reviewed")]), "1 of 1 reviewed (100%)");
    assert.match(coverageSummary([]), /Reindex/);
  });
});

describe("the CodeLens above a file", () => {
  it("speaks only when there is something to do", () => {
    assert.equal(lensFor(item("a.ts", "reviewed")), null, "a current doc is no noise");
    assert.equal(lensFor(undefined), null, "a file the brain does not know");
    assert.equal(lensFor(item("src", "stale", "module")), null, "modules have no file to put it on");
  });
  it("says what is wrong and where clicking goes", () => {
    assert.deepEqual([lensFor(item("a.ts", "stale"))!.command, lensFor(item("a.ts", "draft"))!.command, lensFor(item("a.ts", "none"))!.command], ["openDoc", "openDoc", "generate"]);
    assert.match(lensFor(item("a.ts", "stale"))!.title, /stale/);
  });
});

describe("Check Agent Connection", () => {
  const usage = (o: Partial<UsageSummary> = {}): UsageSummary => ({ total: 0, byClient: {}, byTool: {}, recent: [], ...o });
  it("does not count the extension itself as an agent", () => {
    const r = connectionReport([{ name: "brain-vscode", admin: true }], usage());
    assert.equal(r.level, "none");
    assert.match(r.lines[0], /MCP/);
  });
  it("says who is connected now and who has called", () => {
    const r = connectionReport(
      [{ name: "claude-code", admin: false }, { name: "brain-vscode", admin: true }],
      usage({ byClient: { "claude-code": 3, "github-copilot": 1 }, recent: [{ id: 4, ts: "2026-11-18T10:00:00.000Z", client: "claude-code", tool: "search_code", args: "{}", resultTokens: 1, latencyMs: 1, isError: false }] }),
    );
    assert.equal(r.level, "ok");
    assert.match(r.lines.join(" "), /Connected now: claude-code\./);
    assert.match(r.lines.join(" "), /claude-code \(3 calls\), github-copilot \(1 call\)/);
    assert.match(r.lines.join(" "), /search_code by claude-code at 2026-11-18 10:00:00/);
  });
  it("counts an agent that called earlier even if it is not connected now", () => {
    assert.equal(connectionReport([], usage({ byClient: { cursor: 2 } })).level, "ok");
  });
});
