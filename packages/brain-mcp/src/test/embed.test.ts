import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { OpenAiEmbeddings, EmbeddingError } from "../embed/provider";
import { EmbeddingService, search, symbolText } from "../embed/service";
import { BrainStore } from "../store";
import { startFakeLlm, type Recorded } from "./fakeLlm";

// A tiny "model": words in the same family share a dimension, so "sign in" lands next to "login" without sharing a letter.
const FAMILIES = [["login", "signin", "authenticate", "credentials", "session"], ["pay", "payment", "charge", "invoice", "billing", "money"], ["delete", "remove", "erase", "purge"], ["email", "mail", "message", "send"]];
const DIM = FAMILIES.length + 1;
const embedText = (t: string) => {
  const v = new Array(DIM).fill(0);
  const words = t.toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z]+/).filter(Boolean);
  for (const w of words) { const f = FAMILIES.findIndex((fam) => fam.some((x) => w.includes(x))); v[f < 0 ? DIM - 1 : f] += f < 0 ? 0.01 : 1; } // words the "model" does not know barely count
  return v;
};
const ok = (r: Recorded) => ({ json: { data: (r.body.input as string[]).map((t, index) => ({ index, embedding: embedText(t.replace(/sign in/gi, "signin")) })) } });

const sym = (name: string, doc: string, kind: "function" | "class" = "function") => ({
  name, qualifiedName: name, kind, startLine: 1, endLine: 2, signature: `function ${name}()`, docstring: doc, bodyHash: name, exported: true,
});

function store() {
  const s = BrainStore.open(":memory:");
  s.putFile({ path: "src/auth.ts", lang: "typescript", size: 1, mtimeMs: 1, hash: "a", parsed: true, hadErrors: false }, [sym("verifyCredentials", "Check a password and start a session."), sym("renderPage", "Draws the page.")], []);
  s.putFile({ path: "src/billing.ts", lang: "typescript", size: 1, mtimeMs: 1, hash: "b", parsed: true, hadErrors: false }, [sym("chargeCard", "Bill the customer money."), sym("purgeUser", "Erase a user for good.")], []);
  return s;
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), "timed out"); };

describe("the embeddings client", () => {
  let fake: Awaited<ReturnType<typeof startFakeLlm>>;
  before(async () => { fake = await startFakeLlm(ok); });
  after(() => fake.close());

  it("returns one unit vector per text, in order, sending only the texts", async () => {
    const e = new OpenAiEmbeddings({ baseUrl: fake.url + "/v1", model: "m" });
    const [a, b] = await e.embed(["login", "money"]);
    assert.equal(fake.requests.at(-1)!.path, "/v1/embeddings");
    assert.deepEqual(fake.requests.at(-1)!.body, { model: "m", input: ["login", "money"] });
    assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-6);
    assert.ok(a[0] > 0.99 && b[1] > 0.99);
  });
  it("splits large requests into batches", async () => {
    const before = fake.requests.length;
    const out = await new OpenAiEmbeddings({ baseUrl: fake.url + "/v1", model: "m" }).embed(Array.from({ length: 70 }, (_, i) => `t${i}`));
    assert.equal(out.length, 70);
    assert.equal(fake.requests.length - before, 3);
  });
  it("explains what is wrong in words to act on", async () => {
    const e = (url: string, h?: any) => { fake.setHandler(h ?? ok); return new OpenAiEmbeddings({ baseUrl: url, model: "m" }); };
    await assert.rejects(e("http://127.0.0.1:1/v1").embed(["x"]), (err: EmbeddingError) => err.kind === "network" && /Could not reach/.test(err.message));
    await assert.rejects(e(fake.url + "/v1", () => ({ status: 404, json: { error: "model not found, try pulling it" } })).embed(["x"]), (err: EmbeddingError) => err.kind === "model" && /Pull or load/.test(err.message));
    await assert.rejects(e(fake.url + "/v1", () => ({ status: 401, json: {} })).embed(["x"]), (err: EmbeddingError) => err.kind === "auth");
    await assert.rejects(e(fake.url + "/v1", () => ({ json: { data: [] } })).embed(["x"]), (err: EmbeddingError) => err.kind === "bad_response");
    await assert.rejects(e(fake.url + "/v1", () => ({ json: { data: [{ index: 0, embedding: ["a"] }] } })).embed(["x"]), (err: EmbeddingError) => err.kind === "bad_response");
    fake.setHandler(ok);
  });
});

describe("what is embedded about a symbol", () => {
  it("is its name, signature, doc comment and path, never a body, and is bounded", () => {
    const t = symbolText({ kind: "function", qualified_name: "a.b", signature: "function b()", docstring: "x".repeat(5000), path: "src/a.ts" });
    assert.ok(t.startsWith("function a.b\nfunction b()"));
    assert.ok(t.length <= 1200);
  });
});

describe("meaning-based search", () => {
  let fake: Awaited<ReturnType<typeof startFakeLlm>>;
  before(async () => { fake = await startFakeLlm(ok); });
  after(() => fake.close());
  const cfg = () => ({ model: "m", baseUrl: fake.url + "/v1" });

  it("is off until configured: results are keyword results and say nothing is wrong", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    const r = await search(s, svc, "verifyCredentials", { limit: 5, offset: 0, mode: "auto" });
    assert.equal(r.mode, "keyword");
    assert.equal(r.note, undefined);
    assert.equal(svc.current.state, "off");
    assert.match((await search(s, svc, "x", { limit: 5, offset: 0, mode: "semantic" })).note!, /not ready/);
  });

  it("computes vectors in the background and finds what keywords cannot", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure(cfg());
    await until(() => svc.current.state === "ready");
    assert.deepEqual([svc.current.done, svc.current.total], [4, 4]);
    // "sign in" shares no word with verifyCredentials or its doc comment
    assert.equal(s.search("sign in", { limit: 5, offset: 0 }).total, 0);
    const r = await search(s, svc, "sign in", { limit: 5, offset: 0, mode: "auto" });
    assert.equal(r.mode, "hybrid");
    assert.equal(r.hits[0].name, "verifyCredentials");
    assert.equal((await search(s, svc, "take payment from a customer", { limit: 3, offset: 0, mode: "semantic" })).hits[0].name, "chargeCard");
  });

  it("keeps a keyword match on top when both lists agree, and respects kind and paging", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure(cfg());
    await until(() => svc.current.state === "ready");
    const r = await search(s, svc, "chargeCard money", { limit: 1, offset: 0, mode: "auto" });
    assert.equal(r.hits[0].name, "chargeCard");
    assert.ok(r.total > 1);
    const page2 = await search(s, svc, "chargeCard money", { limit: 1, offset: 1, mode: "auto" });
    assert.notEqual(page2.hits[0].name, "chargeCard");
    assert.equal((await search(s, svc, "sign in", { kind: "class", limit: 5, offset: 0, mode: "auto" })).hits.length, 0);
  });

  it("only embeds what changed after a re-index, reusing vectors for unchanged text", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure(cfg());
    await until(() => svc.current.state === "ready");
    const sent = () => fake.requests.filter((r) => r.path === "/v1/embeddings").reduce((n, r) => n + r.body.input.length, 0);
    const before = sent();
    // the file is parsed again with one new symbol: its old symbols get new ids, so their vectors must come from the cache
    s.putFile({ path: "src/billing.ts", lang: "typescript", size: 2, mtimeMs: 2, hash: "b2", parsed: true, hadErrors: false }, [sym("chargeCard", "Bill the customer money."), sym("purgeUser", "Erase a user for good."), sym("sendReceipt", "Email a receipt message.")], []);
    await svc.sync();
    await until(() => svc.current.state === "ready" && svc.current.done === 5);
    assert.equal(sent() - before, 1, "only the new symbol went to the model");
  });

  it("falls back to keywords, and says so, when the embedding server is down", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure(cfg());
    await until(() => svc.current.state === "ready");
    fake.setHandler(() => ({ status: 500, json: {} }));
    const r = await search(s, svc, "verifyCredentials", { limit: 5, offset: 0, mode: "auto" });
    assert.equal(r.mode, "keyword");
    assert.match(r.note!, /Semantic search failed/);
    assert.equal(r.hits[0].name, "verifyCredentials");
    fake.setHandler(ok);
  });

  it("reports an unreachable or wrong server as an error state with the reason", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure({ model: "m", baseUrl: "http://127.0.0.1:1/v1" });
    await until(() => svc.current.state === "error");
    assert.match(svc.current.message, /Could not reach/);
    assert.equal(svc.ready, false);
  });

  it("switching models starts over, and turning it off clears the status", async () => {
    const s = store();
    const svc = new EmbeddingService(() => s);
    svc.configure(cfg());
    await until(() => svc.current.state === "ready");
    svc.configure({ ...cfg(), model: "other" });
    await until(() => svc.current.state === "ready" && svc.current.model === "other");
    assert.equal(s.vectorCounts("m").have, 0, "vectors of the old model are removed once the new one is complete");
    assert.equal(svc.configure(null).state, "off");
  });
});
