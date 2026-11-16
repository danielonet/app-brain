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
    writeFileSync(path.join(ws, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(ws, "src/b.py"), "b = 2\n");
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

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
