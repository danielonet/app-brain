import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { EmbeddingStatus } from "@app-brain/brain-protocol";
import { embeddingsInput, searchReport } from "../searchStatus";

const st = (o: Partial<EmbeddingStatus>): EmbeddingStatus => ({ state: "off", model: null, endpoint: null, done: 0, total: 0, message: "", ...o });

describe("semantic search settings", () => {
  it("sends trimmed values; an empty model means off", () => {
    assert.deepEqual(embeddingsInput({ model: "  nomic-embed-text ", baseUrl: " " }), { model: "nomic-embed-text", baseUrl: "" });
    assert.equal(embeddingsInput({ model: "", baseUrl: "http://x/v1" }).model, "");
  });
});

describe("what the extension says about semantic search", () => {
  it("tells a person with it off how to turn it on, and that search still works", () => {
    const r = searchReport(st({ state: "off" }));
    assert.equal(r.level, "off");
    assert.match(r.text, /brain\.search\.embeddings\.model/);
    assert.match(r.text, /names and words/);
  });
  it("shows progress while building and the model when ready", () => {
    assert.match(searchReport(st({ state: "building", model: "m", done: 40, total: 100 })).text, /40 of 100 symbols/);
    const ok = searchReport(st({ state: "ready", model: "m", endpoint: "http://localhost:11434/v1", done: 100, total: 100 }));
    assert.equal(ok.level, "ok");
    assert.match(ok.text, /100 symbols searchable by meaning with m/);
  });
  it("carries the server's reason when it fails, and copes with an older server", () => {
    assert.match(searchReport(st({ state: "error", message: "Could not reach http://x" })).text, /Could not reach http:\/\/x/);
    assert.equal(searchReport(undefined).level, "off");
  });
});
