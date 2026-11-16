import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ImportResolver } from "../resolve";

const imp = (specifier: string, names: string[] = []) => ({ specifier, line: 1, names });

describe("TypeScript import resolution", () => {
  const r = new ImportResolver([
    "src/a.ts", "src/b.ts", "src/util/index.ts", "src/legacy.js", "src/ui/Button.tsx", "src/esm/mod.mts", "lib/x.ts",
  ]);
  it("resolves relative files, extensions and index files", () => {
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./b")), [{ to: "src/b.ts", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./util")), [{ to: "src/util/index.ts", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./legacy")), [{ to: "src/legacy.js", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("src/util/index.ts", "ts", imp("../ui/Button")), [{ to: "src/ui/Button.tsx", confidence: "resolved" }]);
  });
  it("maps ESM-style .js specifiers to TypeScript sources", () => {
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./b.js")), [{ to: "src/b.ts", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./esm/mod.mjs")), [{ to: "src/esm/mod.mts", confidence: "resolved" }]);
  });
  it("ignores packages, missing files and self imports", () => {
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("react")), []);
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./nope")), []);
    assert.deepEqual(r.resolve("src/a.ts", "ts", imp("./a")), []);
  });
});

describe("Python import resolution", () => {
  const r = new ImportResolver([
    "app/__init__.py", "app/main.py", "app/models.py", "app/db/__init__.py", "app/db/pool.py",
    "tools/util.py", "other/util.py", "app/sub/helper.py",
  ]);
  it("resolves relative imports exactly", () => {
    assert.deepEqual(r.resolve("app/main.py", "python", imp(".models", ["User"])), [{ to: "app/models.py", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("app/db/pool.py", "python", imp("..models")), [{ to: "app/models.py", confidence: "resolved" }]);
    const dotOnly = r.resolve("app/main.py", "python", imp(".", ["models", "missing"]));
    assert.deepEqual(dotOnly.map((x) => x.to).sort(), ["app/__init__.py", "app/models.py"]);
  });
  it("resolves absolute imports by path suffix, packages via __init__", () => {
    assert.deepEqual(r.resolve("app/main.py", "python", imp("app.db.pool")), [{ to: "app/db/pool.py", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("app/main.py", "python", imp("app.db")), [{ to: "app/db/__init__.py", confidence: "resolved" }]);
    assert.deepEqual(r.resolve("tools/util.py", "python", imp("app.db", ["pool"])).map((x) => x.to).sort(), ["app/db/__init__.py", "app/db/pool.py"]);
  });
  it("marks ambiguous matches as guesses and ignores the standard library", () => {
    const hits = r.resolve("app/main.py", "python", imp("util"));
    assert.deepEqual(hits.map((x) => x.to).sort(), ["other/util.py", "tools/util.py"]);
    assert.ok(hits.every((h) => h.confidence === "guess"));
    assert.deepEqual(r.resolve("app/main.py", "python", imp("os.path")), []);
  });
});
