import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  addLogEntry, bundleLinks, cycles, dependencyBlock, encodeLinkPath, getPath, hasLegacyLinks, parseConcept, relativeLink, renderIndex, serializeConcept, stripAutoMarkers, withDependencyBlock,
} from "../okf/format";

describe("front matter", () => {
  it("round-trips and keeps unknown keys, nested data and ISO timestamps as strings", () => {
    const fm = {
      type: "Brain File", title: "src/a.ts", tags: ["x", "y"], custom_team_key: { owner: "platform" },
      generated: { by: "claude-code/model-x", at: "2026-11-16T10:00:00.000Z" },
      brain: { depends_on: ["/files/src/b.ts.md"], llm: { tokens_in: null } },
    };
    const text = serializeConcept(fm, "# Summary\n\nHello.");
    const p = parseConcept(text);
    assert.ok(p.ok);
    assert.deepEqual(p.fm, fm);
    assert.equal(p.body, "# Summary\n\nHello.\n");
    assert.equal(typeof (p.fm.generated as { at: unknown }).at, "string");
  });
  it("quotes values that would break YAML", () => {
    const tricky = { type: "Note", title: "a: b # c", description: "line1\nline2", tags: ["--", "yes", "null", "1.0"] };
    const p = parseConcept(serializeConcept(tricky, "x"));
    assert.ok(p.ok);
    assert.deepEqual(p.fm, tricky);
  });
  it("reports missing and broken front matter", () => {
    assert.deepEqual(parseConcept("# just markdown").ok, false);
    const unclosed = parseConcept("---\ntype: A\n# no end");
    assert.ok(!unclosed.ok && unclosed.reason === "invalid");
    const badYaml = parseConcept("---\ntype: [unclosed\n---\n\nbody");
    assert.ok(!badYaml.ok && badYaml.reason === "invalid");
    const list = parseConcept("---\n- a\n- b\n---\n\nbody");
    assert.ok(!list.ok && /mapping/.test(list.message));
  });
  it("accepts CRLF and an empty block", () => {
    assert.ok(parseConcept("---\r\ntype: A\r\n---\r\n\r\nbody\r\n").ok);
    const empty = parseConcept("---\n---\n\nbody");
    assert.ok(empty.ok && Object.keys(empty.fm).length === 0);
  });
  it("reads nested paths safely", () => {
    assert.equal(getPath({ brain: { llm: { model: "m" } } }, "brain.llm.model"), "m");
    assert.equal(getPath({ brain: null }, "brain.llm.model"), undefined);
    assert.equal(getPath({}, "a.b"), undefined);
  });
});

describe("links", () => {
  const body = [
    "See [session](/files/src/a.ts.md) and [sibling](./b.md#part) and [up](../c.md).",
    "External [site](https://x.dev/y.md) and [mail](mailto:a@b.c) and [anchor](#top) and [image](pic.png).",
    "```",
    "[in code](/files/ignored.md)",
    "```",
  ].join("\n");
  it("resolves bundle-absolute and relative links, skipping external, anchors, non-md and code fences", () => {
    assert.deepEqual(bundleLinks(body, "files/src/x.md"), ["files/src/a.ts.md", "files/src/b.md", "files/c.md"]);
  });
});

describe("links that open from an editor", () => {
  it("are relative to the file that holds them, at any depth", () => {
    assert.equal(relativeLink("files/src/a.ts.md", "files/src/b.ts.md"), "./b.ts.md");
    assert.equal(relativeLink("files/src/auth/session.ts.md", "files/src/db/pool.ts.md"), "../db/pool.ts.md");
    assert.equal(relativeLink("modules/src.md", "files/src/a.ts.md"), "../files/src/a.ts.md");
    assert.equal(relativeLink("index.md", "files/index.md"), "./files/index.md");
    assert.equal(relativeLink("drafts/files/src/a.ts.md", "knowledge/files/src/b.ts.md"), "../../../knowledge/files/src/b.ts.md");
  });

  it("encode what would break a Markdown link, and resolve back to the same concept", () => {
    assert.equal(encodeLinkPath("a b/c(1)/d.md"), "a%20b/c%281%29/d.md");
    const odd = "files/src/my file (copy)/x [1].ts.md";
    const link = relativeLink("files/src/a.ts.md", odd);
    assert.doesNotMatch(link, /[ ()\[\]]/);
    assert.deepEqual(bundleLinks(`[x](${link})`, "files/src/a.ts.md"), [odd]);
  });

  it("are what the dependency block now writes, from the bundle or from a draft", () => {
    const inBundle = dependencyBlock(["files/src/db/pool.ts.md"], ["modules/src/http.md"], { conceptPath: "files/src/auth/session.ts.md", in: "knowledge" });
    assert.match(inBundle, /Depends on: \[src\/db\/pool\.ts\]\(\.\.\/db\/pool\.ts\.md\)/);
    assert.match(inBundle, /Used by: \[src\/http\]\(\.\.\/\.\.\/\.\.\/modules\/src\/http\.md\)/);
    const inDrafts = dependencyBlock(["files/src/db/pool.ts.md"], [], { conceptPath: "files/src/auth/session.ts.md", in: "drafts" });
    assert.match(inDrafts, /\(\.\.\/\.\.\/\.\.\/\.\.\/knowledge\/files\/src\/db\/pool\.ts\.md\)/);
    assert.deepEqual(bundleLinks(inBundle, "files/src/auth/session.ts.md"), ["files/src/db/pool.ts.md", "modules/src/http.md"], "the validator follows them to the same files");
  });

  it("tells old bundle-absolute dependency links from new ones, and only inside the managed block", () => {
    const legacy = "# Summary\n\nSee [x](/files/a.md).\n\n<!-- brain:auto:start dependencies -->\n# Dependencies\n\n- Depends on: [b](/files/b.ts.md)\n<!-- brain:auto:end -->\n";
    assert.equal(hasLegacyLinks(legacy), true);
    assert.equal(hasLegacyLinks(legacy.replace("(/files/b.ts.md)", "(./b.ts.md)")), false, "a human's own absolute link outside the block is not ours to touch");
    assert.equal(hasLegacyLinks("# Summary\n\n[x](/files/a.md)\n"), false);
  });
});

describe("dependency block", () => {
  it("is added once and replaced in place, leaving human text alone", () => {
    const here = { conceptPath: "files/src/a.ts.md", in: "knowledge" as const };
    const first = withDependencyBlock("# Summary\n\nHuman text.\n", dependencyBlock(["files/src/b.ts.md"], [], here));
    assert.match(first, /Depends on: \[src\/b\.ts\]\(\.\/b\.ts\.md\)/);
    assert.match(first, /Used by: nothing/);
    const second = withDependencyBlock(first, dependencyBlock([], ["modules/src/http.md"], here));
    assert.equal(second.match(/brain:auto:start/g)!.length, 1);
    assert.match(second, /Human text\./);
    assert.match(second, /Used by: \[src\/http\]/);
    assert.doesNotMatch(second, /src\/b\.ts/);
  });
  it("strips forged markers from authored text", () => {
    const forged = "text <!-- brain:auto:start dependencies --> evil <!--brain:auto:end -->";
    assert.equal(stripAutoMarkers(forged), "text  evil ");
  });
});

describe("index and log", () => {
  it("renders a generated index with optional root front matter", () => {
    const root = renderIndex("Knowledge", [{ title: "a", link: "/files/a.md", description: "About a." }], { okf_version: "0.2" });
    assert.match(root, /^---\nokf_version: "?0\.2"?\n---/);
    assert.match(root, /- \[a\]\(\/files\/a\.md\): About a\./);
    assert.ok(!renderIndex("x", []).startsWith("---"));
  });
  it("adds log entries newest first, grouped by date", () => {
    const d1 = new Date("2026-11-16T10:00:00Z");
    const d2 = new Date("2026-11-17T10:00:00Z");
    let log = "# Log\n\n## 2026-11-15\n\n- **Creation**: init.\n";
    log = addLogEntry(log, "Creation", "one", d1);
    log = addLogEntry(log, "Update", "two", d1);
    log = addLogEntry(log, "Update", "three", d2);
    assert.equal(log, "# Log\n\n## 2026-11-17\n\n- **Update**: three\n\n## 2026-11-16\n\n- **Update**: two\n- **Creation**: one\n\n## 2026-11-15\n\n- **Creation**: init.\n");
  });
});

describe("cycle detection", () => {
  it("finds mutual dependencies and ignores acyclic edges and self references", () => {
    const edges = new Map([["a", ["b"]], ["b", ["a", "c"]], ["c", []], ["d", ["e"]], ["e", ["f"]], ["f", ["d"]], ["g", ["g2"]]]);
    assert.deepEqual(cycles(edges), [["a", "b"], ["d", "e", "f"]]);
  });
});
