import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AdminTools, AgentTools, OKF_VERSION, Resources } from "@app-brain/brain-protocol";
import { Indexer } from "../indexer";
import { parseConcept } from "../okf/format";
import { Knowledge } from "../okf/knowledge";
import { BrainStore } from "../store";
import { BrainWorkspace } from "../workspace";
import { FILES, connect, fixture, readJson, ready, tool } from "./helpers";

const MODEL = "test-model-1";
const summary = (extra = "") => ({
  target: "src/auth/session.ts",
  description: "Creates and looks up user sessions.",
  summary: `Handles sessions.${extra}\n\n- backed by the pool`,
  model: MODEL,
});

describe("documentation flow: draft, review, approve", () => {
  let ws: string;
  let agent: Client;
  let admin: Client;
  const p = (...parts: string[]) => path.join(ws, ".brain", ...parts);
  const readConcept = (file: string) => {
    const r = parseConcept(readFileSync(file, "utf8"));
    assert.ok(r.ok, `${file} must parse`);
    return r;
  };

  before(async () => {
    ws = fixture();
    admin = await connect(ws, { admin: true, clientName: "brain-vscode" });
    await ready(admin, 4);
    agent = await connect(ws, { clientName: "claude-code" });
    await ready(agent, 4);
  });
  after(async () => {
    await agent.close();
    await admin.close();
    rmSync(ws, { recursive: true, force: true });
  });

  it("ranks undocumented targets by how many files import them, before init, without writing anything", async () => {
    const r = (await tool(agent, AgentTools.listUndocumented, {})).body;
    assert.equal(r.total, 4);
    assert.equal(r.results[0].imported_by, 1);
    assert.ok(r.results.every((x: { reason: string }) => x.reason === "none"));
    const session = r.results.find((x: { target: string }) => x.target === "src/auth/session.ts");
    assert.deepEqual(session.symbols, ["SessionStore", "SessionStore.get", "createSession"]);
    assert.equal(existsSync(p()), false);
  });

  it("save_summary refuses until the workspace is initialised", async () => {
    const r = await tool(agent, AgentTools.saveSummary, summary());
    assert.equal(r.isError, true);
    assert.match(r.body.error, /Initialise/);
    assert.equal(existsSync(p()), false);
  });

  it("initialises", async () => {
    assert.equal((await tool(admin, AdminTools.init)).isError, false);
    const index = readFileSync(p("knowledge/index.md"), "utf8");
    assert.match(index, new RegExp(`okf_version: "?${OKF_VERSION}"?`));
  });

  it("rejects bad input without writing", async () => {
    const bad: Record<string, unknown>[] = [
      { ...summary(), target: "../../etc/passwd" },
      { ...summary(), target: "src/../../x.ts" },
      { ...summary(), target: "/etc/passwd" },
      { ...summary(), target: "does/not/exist.ts" },
      { ...summary(), target: "src/auth" }, // a directory with a single file is not a module
      { ...summary(), summary: "x".repeat(20_001) },
      { ...summary(), description: "y".repeat(301) },
      { ...summary(), description: "   " },
      { ...summary(), model: "" },
    ];
    for (const args of bad) assert.equal((await tool(agent, AgentTools.saveSummary, args)).isError, true, JSON.stringify(args).slice(0, 80));
    assert.deepEqual((await readJson(admin, Resources.pendingReview)), []);
    assert.equal(existsSync(p("drafts/files")), false);
  });

  it("saves a draft with OKF front matter, provenance and dependencies", async () => {
    const r = await tool(agent, AgentTools.saveSummary, { ...summary(), tags: ["auth"], tokens_in: 1200 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.body.status, "draft");
    assert.equal(r.body.draft, ".brain/drafts/files/src/auth/session.ts.md");
    assert.equal(existsSync(p("knowledge/files/src/auth/session.ts.md")), false, "a draft must not appear in the bundle");

    const { fm, body } = readConcept(p("drafts/files/src/auth/session.ts.md"));
    assert.equal(fm.type, "Brain File");
    assert.equal(fm.title, "src/auth/session.ts");
    assert.equal(fm.description, "Creates and looks up user sessions.");
    assert.equal(fm.status, "draft");
    assert.equal(fm.verified, undefined);
    assert.deepEqual(fm.tags, ["auth"]);
    const gen = fm.generated as { by: string; at: string };
    assert.equal(gen.by, `claude-code/${MODEL}`);
    assert.match(gen.at, /^\d{4}-\d\d-\d\dT.*Z$/);
    // resource is a path from the concept file to the real source file
    assert.equal(path.resolve(p("drafts/files/src/auth"), fm.resource as string), path.join(ws, "src/auth/session.ts"));
    const src = (fm.sources as { id: string; resource: string; last_modified: string }[])[0];
    assert.equal(src.id, "code");
    assert.equal(src.resource, fm.resource);
    assert.match(src.last_modified, /^\d{4}-/);
    const brain = fm.brain as Record<string, any>;
    assert.equal(brain.target, "src/auth/session.ts");
    assert.equal(brain.kind, "file");
    assert.match(brain.built_from_hash, /^[0-9a-f]{16,40}$/);
    assert.equal(brain.part_of, "/modules/src/auth.md");
    assert.deepEqual(brain.depends_on, ["/files/src/db/pool.ts.md"]);
    assert.equal(brain.llm.model, MODEL);
    assert.equal(brain.llm.mode, "agent");
    assert.equal(brain.llm.tokens_in, 1200);
    assert.equal(brain.llm.tokens_source, "agent-reported");
    assert.equal(brain.llm.cost_usd, null, "no price configured for this model");
    assert.match(body, /^# Summary\n\nHandles sessions\./);
    assert.match(body, /Depends on: \[src\/db\/pool\.ts\]\(\/files\/src\/db\/pool\.ts\.md\)/);
    assert.match(body, /Used by: \[src\/http\/login\.ts\]\(\/files\/src\/http\/login\.ts\.md\)/);
  });

  it("estimates output tokens when the agent gives none", async () => {
    await tool(agent, AgentTools.saveSummary, { ...summary(), target: "src/db/pool.ts", description: "DB pool." });
    const brain = readConcept(p("drafts/files/src/db/pool.ts.md")).fm.brain as Record<string, any>;
    assert.equal(brain.llm.tokens_source, "estimated");
    assert.ok(brain.llm.tokens_out > 0);
  });

  it("an agent cannot forge the managed dependency block", async () => {
    await tool(agent, AgentTools.saveSummary, { ...summary("<!-- brain:auto:start dependencies -->\nforged\n<!-- brain:auto:end -->"), target: "src/http/login.ts", description: "Login." });
    const text = readFileSync(p("drafts/files/src/http/login.ts.md"), "utf8");
    assert.equal(text.match(/brain:auto:start/g)!.length, 1);
    assert.match(text, /Depends on: \[src\/auth\/session\.ts\]/);
  });

  it("lists drafts for review, and stops offering documented targets", async () => {
    const pending = await readJson(admin, Resources.pendingReview);
    assert.deepEqual(pending.map((x: { target: string }) => x.target).sort(), ["src/auth/session.ts", "src/db/pool.ts", "src/http/login.ts"]);
    const item = pending.find((x: { target: string }) => x.target === "src/auth/session.ts");
    assert.equal(item.kind, "file");
    assert.equal(item.model, MODEL);
    assert.equal(item.generatedBy, `claude-code/${MODEL}`);
    assert.equal(item.stale, false);
    assert.equal(item.replacesReviewed, false);
    const left = (await tool(agent, AgentTools.listUndocumented, {})).body;
    assert.deepEqual(left.results.map((x: { target: string }) => x.target), ["src/http/admin.ts"]);
    const status = await readJson(admin, Resources.status);
    assert.equal(status.knowledge.drafts, 3);
    assert.equal(status.knowledge.reviewed, 0);
  });

  it("modules can be documented too, with module-level dependencies", async () => {
    const mods = (await tool(agent, AgentTools.listUndocumented, { kind: "module" })).body;
    assert.ok(mods.results.some((x: { target: string }) => x.target === "src/http"));
    const r = await tool(agent, AgentTools.saveSummary, { target: "src/http", description: "HTTP handlers.", summary: "Entry points.", model: MODEL });
    assert.equal(r.isError, false, r.text);
    const { fm } = readConcept(p("drafts/modules/src/http.md"));
    assert.equal(fm.type, "Brain Module");
    assert.equal((fm.brain as any).part_of, "/modules/src.md");
    assert.deepEqual((fm.brain as any).depends_on, ["/modules/src/auth.md"]);
    await tool(admin, AdminTools.reviewSummary, { target: "src/http", action: "reject", by: "jdoe" });
  });

  it("approving moves the draft into the bundle with a human verification, an index and a log entry", async () => {
    const r = await tool(admin, AdminTools.reviewSummary, { target: "src/auth/session.ts", action: "approve", by: "J. Doe" });
    assert.equal(r.isError, false, r.text);
    assert.equal(existsSync(p("drafts/files/src/auth/session.ts.md")), false);
    const { fm, body } = readConcept(p("knowledge/files/src/auth/session.ts.md"));
    assert.equal(fm.status, "stable");
    const v = fm.verified as { by: string; at: string };
    assert.equal(v.by, "human:J.-Doe");
    assert.match(v.at, /Z$/);
    assert.ok(body.includes("Handles sessions."));
    assert.equal((fm.brain as any).llm.model, MODEL, "brain data survives review");

    const index = readFileSync(p("knowledge/files/src/auth/index.md"), "utf8");
    assert.match(index, /\[src\/auth\/session\.ts\]\(\/files\/src\/auth\/session\.ts\.md\): Creates and looks up user sessions\./);
    const root = readFileSync(p("knowledge/index.md"), "utf8");
    assert.match(root, /okf_version/);
    assert.match(root, /\[files\/\]\(\/files\/index\.md\)/);
    assert.match(readFileSync(p("knowledge/log.md"), "utf8"), /\*\*Creation\*\*: file documentation for `src\/auth\/session\.ts` approved by J\.-Doe\./);

    const cov = await readJson(admin, Resources.coverage);
    assert.equal(cov.files.reviewed, 1);
    assert.equal(cov.files.drafts, 2);
    assert.equal(cov.files.total, 4);
  });

  it("the approved bundle validates as conformant OKF", async () => {
    const v = (await tool(admin, AdminTools.validate)).body;
    assert.equal(v.conformant, true);
    assert.equal(v.concepts, 1);
    assert.ok(!v.issues.some((i: { severity: string }) => i.severity === "error"));
    // its links to not-yet-documented neighbours are reported as information, not errors
    assert.ok(v.issues.some((i: { code: string }) => i.code === "broken-link"));
  });

  it("rejecting deletes the draft and records feedback", async () => {
    const r = await tool(admin, AdminTools.reviewSummary, { target: "src/db/pool.ts", action: "reject", by: "jdoe", note: "Too vague." });
    assert.equal(r.isError, false);
    assert.equal(existsSync(p("drafts/files/src/db/pool.ts.md")), false);
    assert.equal(existsSync(p("knowledge/files/src/db/pool.ts.md")), false);
    const line = JSON.parse(readFileSync(p("feedback/feedback.jsonl"), "utf8").trim().split("\n").at(-1)!);
    assert.equal(line.action, "reject");
    assert.equal(line.note, "Too vague.");
    assert.equal(line.model, MODEL);
    // and it is offered again
    const again = (await tool(agent, AgentTools.listUndocumented, {})).body.results.map((x: { target: string }) => x.target);
    assert.ok(again.includes("src/db/pool.ts"));
  });

  it("review errors are clean", async () => {
    assert.equal((await tool(admin, AdminTools.reviewSummary, { target: "src/db/pool.ts", action: "approve", by: "x" })).isError, true); // no draft any more
    assert.equal((await tool(admin, AdminTools.reviewSummary, { target: "../x", action: "approve", by: "x" })).isError, true);
    assert.equal((await tool(admin, AdminTools.reviewSummary, { target: "src/http/login.ts", action: "approve", by: "  " })).isError, true);
    assert.equal(existsSync(p("knowledge/files/src/http/login.ts.md")), false);
  });

  it("agents cannot review their own drafts", async () => {
    const r = await tool(agent, AdminTools.reviewSummary, { target: "src/http/login.ts", action: "approve", by: "claude" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /Admin tools require/);
    assert.ok(existsSync(p("drafts/files/src/http/login.ts.md")));
  });

  it("a human edit replaces the body and keeps the managed block current", async () => {
    const r = await tool(admin, AdminTools.reviewSummary, { target: "src/http/login.ts", action: "approve", by: "jdoe", body: "# Summary\n\nEdited by a person.\n" });
    assert.equal(r.isError, false, r.text);
    const text = readFileSync(p("knowledge/files/src/http/login.ts.md"), "utf8");
    assert.match(text, /Edited by a person\./);
    assert.doesNotMatch(text, /Handles sessions/);
    assert.match(text, /Depends on: \[src\/auth\/session\.ts\]/);
    assert.equal(JSON.parse(readFileSync(p("feedback/feedback.jsonl"), "utf8").trim().split("\n").at(-1)!).action, "approve-edited");
  });

  it("code changes make a reviewed doc stale, offer it again, and a re-approval logs an Update", async () => {
    writeFileSync(path.join(ws, "src/auth/session.ts"), FILES["src/auth/session.ts"] + "export function revoke(id: string) {}\n");
    await tool(admin, AdminTools.reindex);
    const cov = await readJson(admin, Resources.coverage);
    assert.equal(cov.files.stale, 1);
    assert.equal((await readJson(admin, Resources.status)).knowledge.stale, 1);
    // (the agent's own server process has no watcher in tests, so ask the process that re-indexed)
    const offered = (await tool(admin, AgentTools.listUndocumented, {})).body.results.find((x: { target: string }) => x.target === "src/auth/session.ts");
    assert.equal(offered.reason, "stale");

    await tool(admin, AgentTools.saveSummary, { ...summary(" Now with revoke."), description: "Sessions, with revoke." });
    const pending = (await readJson(admin, Resources.pendingReview)).find((x: { target: string }) => x.target === "src/auth/session.ts");
    assert.equal(pending.replacesReviewed, true);
    assert.equal(pending.stale, false);
    // the reviewed doc stays in place until the new one is approved
    assert.match(readFileSync(p("knowledge/files/src/auth/session.ts.md"), "utf8"), /^---[\s\S]*Handles sessions\.\n/);

    await tool(admin, AdminTools.reviewSummary, { target: "src/auth/session.ts", action: "approve", by: "jdoe" });
    assert.match(readFileSync(p("knowledge/log.md"), "utf8"), /\*\*Update\*\*: file documentation for `src\/auth\/session\.ts`/);
    assert.equal((await readJson(admin, Resources.coverage)).files.stale, 0);
  });

  it("validate flags non-conformant files, orphans and cycles; a person can fix them", async () => {
    const k = (f: string) => p("knowledge", f);
    mkdirSync(k("notes"), { recursive: true });
    writeFileSync(k("notes/no-front-matter.md"), "# Just a note\n");
    writeFileSync(k("notes/no-type.md"), "---\ntitle: Missing type\n---\n\nbody\n");
    writeFileSync(k("notes/broken-yaml.md"), "---\ntype: [oops\n---\n\nbody\n");
    mkdirSync(k("modules"), { recursive: true });
    writeFileSync(k("modules/a.md"), "---\ntype: Brain Module\nbrain:\n  depends_on: [/modules/b.md]\n---\n\nA\n");
    writeFileSync(k("modules/b.md"), "---\ntype: Brain Module\nbrain:\n  depends_on: [/modules/a.md]\n---\n\nB\n");
    writeFileSync(k("files/stale-ref.md"), "---\ntype: Brain File\nbrain:\n  depends_on: [/files/src/gone.ts.md]\n---\n\nC\n");
    mkdirSync(k("files/sub"), { recursive: true });
    writeFileSync(k("files/sub/index.md"), "---\ntype: Nope\n---\n\nhand-written index with front matter\n");

    const v = (await tool(admin, AdminTools.validate)).body;
    const has = (code: string, file: string, severity?: string) =>
      v.issues.some((i: { code: string; file: string; severity: string }) => i.code === code && i.file === file && (!severity || i.severity === severity));
    assert.equal(v.conformant, false);
    assert.ok(has("no-frontmatter", "notes/no-front-matter.md", "error"));
    assert.ok(has("missing-type", "notes/no-type.md", "error"));
    assert.ok(has("bad-frontmatter", "notes/broken-yaml.md", "error"));
    assert.ok(has("cycle", "modules/a.md", "warning"));
    assert.ok(has("orphan", "notes/no-type.md", "info"));
    assert.ok(has("depends-on-missing", "files/stale-ref.md", "warning"));
    assert.ok(has("index-frontmatter", "files/sub/index.md", "warning"));

    for (const f of ["notes/no-front-matter.md", "notes/no-type.md", "notes/broken-yaml.md"]) rmSync(k(f));
    assert.equal((await tool(admin, AdminTools.validate)).body.conformant, true);
  });

  it("regenerating indexes never overwrites a hand-written index", async () => {
    writeFileSync(p("knowledge/files/src/index.md"), "# Hand written\n\nKeep me.\n");
    await tool(agent, AgentTools.saveSummary, { target: "src/db/pool.ts", description: "DB pool.", summary: "Pool.", model: MODEL });
    await tool(admin, AdminTools.reviewSummary, { target: "src/db/pool.ts", action: "approve", by: "jdoe" });
    assert.equal(readFileSync(p("knowledge/files/src/index.md"), "utf8"), "# Hand written\n\nKeep me.\n");
  });
});

describe("init keeps the index (no rebuild gap)", () => {
  let ws: string;
  before(() => { ws = fixture(); });
  after(() => rmSync(ws, { recursive: true, force: true }));

  it("a summary saved straight after init sees the full dependency graph", async () => {
    const c = await connect(ws, { admin: true, clientName: "brain-vscode" });
    try {
      await ready(c, 4);
      await tool(c, AdminTools.init);
      // no waiting: the in-memory index must have been carried to disk, not rebuilt
      const r = await tool(c, AgentTools.saveSummary, { ...summary(), target: "src/auth/session.ts" });
      assert.equal(r.isError, false, r.text);
      const draft = parseConcept(readFileSync(path.join(ws, ".brain/drafts/files/src/auth/session.ts.md"), "utf8"));
      assert.ok(draft.ok);
      assert.deepEqual((draft.fm.brain as any).depends_on, ["/files/src/db/pool.ts.md"]);
      assert.match(draft.body, /Used by: \[src\/http\/login\.ts\]/);
      assert.ok(existsSync(path.join(ws, ".brain/.cache/brain.db")));
    } finally { await c.close(); }
  });
});

describe("approval never recomputes dependencies from a partial index", () => {
  it("keeps the draft's dependencies while the index is not ready, refreshes them once it is", async () => {
    const root = fixture();
    try {
      const ws = new BrainWorkspace(root);
      await ws.init();
      const store = BrainStore.open(":memory:");
      await new Indexer(ws, store).run();
      const make = (ready: () => boolean) => new Knowledge(ws, () => store, () => {}, ready);

      const save = (k: InstanceType<typeof Knowledge>) =>
        k.saveSummary({ target: "src/auth/session.ts", description: "d", summary: "s", model: "m", client: "c" });
      const depsOf = (area: "drafts" | "knowledge") => {
        const r = parseConcept(readFileSync(path.join(root, ".brain", area, "files/src/auth/session.ts.md"), "utf8"));
        assert.ok(r.ok);
        return (r.fm.brain as any).depends_on as string[];
      };

      await save(make(() => true));
      assert.deepEqual(depsOf("drafts"), ["/files/src/db/pool.ts.md"]);

      store.removeFile("src/db/pool.ts"); // simulate an index that is mid-rebuild
      await make(() => false).review({ target: "src/auth/session.ts", action: "approve", by: "t" });
      assert.deepEqual(depsOf("knowledge"), ["/files/src/db/pool.ts.md"], "kept, not wiped");

      await save(make(() => true)); // the file is gone from the index now
      await make(() => true).review({ target: "src/auth/session.ts", action: "approve", by: "t" });
      assert.deepEqual(depsOf("knowledge"), [], "refreshed when the index is ready");
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
