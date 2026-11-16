import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { BrainStatus } from "@app-brain/brain-protocol";
import { BrainClient } from "../client";
import type { ConnState } from "../format";

describe("BrainClient against the real brain-mcp", () => {
  let ws: string;
  before(() => {
    ws = mkdtempSync(path.join(tmpdir(), "brain-client-"));
    mkdirSync(path.join(ws, "src"));
    writeFileSync(path.join(ws, "src/a.ts"), "/** Adds numbers. */\nexport function addNumbers(a: number, b: number) { return a + b; }\n");
    writeFileSync(path.join(ws, "src/b.py"), "b = 2\n");
  });
  after(() => rmSync(ws, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

  const make = (events: { conn: ConnState; status: BrainStatus | null }[], serverPath?: string) =>
    new BrainClient({
      nodePath: process.execPath,
      serverPath: serverPath ?? require.resolve("@app-brain/brain-mcp/out/cli.js"),
      workspace: ws,
      outputDir: ".brain",
      log: () => {},
      onState: (conn, status) => events.push({ conn, status }),
    });

  it("connects, initialises, indexes and stops", async () => {
    const events: { conn: ConnState; status: BrainStatus | null }[] = [];
    const c = make(events);
    await c.start();
    assert.equal(events[0].conn, "connecting");
    assert.equal(c.current?.initialised, false);

    const init = await c.initialise();
    assert.equal(init.alreadyInitialised, false);
    assert.ok(existsSync(path.join(ws, ".brain/knowledge/index.md")));

    const r = await c.reindex();
    assert.equal(r.files, 2);
    await c.refresh();
    assert.equal(c.current?.initialised, true);
    assert.equal(c.current?.index.files, 2);
    assert.equal(c.current?.index.symbols, 1);

    const hits = await c.search("add numbers");
    assert.equal(hits[0].symbol, "addNumbers");
    assert.equal(hits[0].path, "src/a.ts");
    assert.equal(hits[0].lines, "2-2");

    // Documentation review round trip: the extension only sees and decides, never writes.
    const draftsSeen: string[][] = [];
    const reviewer = new BrainClient({
      nodePath: process.execPath, serverPath: require.resolve("@app-brain/brain-mcp/out/cli.js"), workspace: ws, outputDir: ".brain",
      log: () => {}, onState: () => {}, onPending: (items) => draftsSeen.push(items.map((i) => i.target)),
    });
    await reviewer.start();
    assert.deepEqual(draftsSeen.at(-1), []);
    assert.equal((await reviewer.validate()).conformant, true);
    await reviewer.stop();

    await c.stop();
    assert.equal(events.at(-1)?.conn, "disconnected");
  });

  it("reports failure when the server cannot start", async () => {
    const events: { conn: ConnState; status: BrainStatus | null }[] = [];
    const c = make(events, path.join(ws, "does-not-exist.js"));
    await c.start();
    assert.equal(events.at(-1)?.conn, "failed");
    await c.stop();
  });
});
