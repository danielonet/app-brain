import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { extract } from "../parse/extract";
import { queryTokens, splitWords } from "../store";

const byName = (r: Awaited<ReturnType<typeof extract>>, q: string) => {
  const s = r.symbols.find((x) => x.qualifiedName === q);
  assert.ok(s, `symbol ${q} not found in ${r.symbols.map((x) => x.qualifiedName).join(", ")}`);
  return s;
};

describe("TypeScript extraction", () => {
  const src = `
import { pool } from "./db/pool";
import type { User } from "../types.js";
export * from "./reexported";
import React from "react";

/**
 * Loads a user.
 * Returns null when missing.
 */
export async function getUserById(id: string, opts?: Options): Promise<User | null> {
  return null;
}

// Store of sessions.
// Backed by memory.
export class SessionStore<T> extends Base {
  private items = new Map<string, T>();
  /** Fetch one. */
  get(id: string): T | undefined { return this.items.get(id); }
  handler = async (x: number) => x + 1;
  static create(): SessionStore<any> { return new SessionStore(); }
}

export interface Options { verbose: boolean }
export type Id = string | number;
export enum Color { Red, Green }
export const MAX = 5;
const helper = (a: number) => a * 2;
const internalValue = 3;
function plain() {}
`;
  it("finds symbols with kind, lines, signature and export flag", async () => {
    const r = await extract("typescript", src);
    const f = byName(r, "getUserById");
    assert.equal(f.kind, "function");
    assert.equal(f.exported, true);
    assert.equal(f.signature, "async function getUserById(id: string, opts?: Options): Promise<User | null>");
    assert.ok(f.startLine < f.endLine);
    assert.equal(byName(r, "SessionStore").kind, "class");
    assert.equal(byName(r, "SessionStore.get").kind, "method");
    assert.equal(byName(r, "SessionStore.create").kind, "method");
    assert.equal(byName(r, "SessionStore.handler").kind, "method"); // arrow-function field
    assert.equal(byName(r, "Options").kind, "interface");
    assert.equal(byName(r, "Id").kind, "type");
    assert.equal(byName(r, "Color").kind, "enum");
    assert.equal(byName(r, "MAX").kind, "variable");
    assert.equal(byName(r, "helper").kind, "function");
    assert.equal(byName(r, "helper").exported, false);
    assert.equal(byName(r, "plain").exported, false);
  });
  it("skips non-exported plain constants", async () => {
    const r = await extract("typescript", src);
    assert.ok(!r.symbols.some((s) => s.name === "internalValue"));
  });
  it("keeps JSDoc and line comments as docstrings", async () => {
    const r = await extract("typescript", src);
    assert.equal(byName(r, "getUserById").docstring, "Loads a user.\nReturns null when missing.");
    assert.equal(byName(r, "SessionStore").docstring, "Store of sessions.\nBacked by memory.");
    assert.equal(byName(r, "SessionStore.get").docstring, "Fetch one.");
    assert.equal(byName(r, "plain").docstring, null);
  });
  it("collects import and re-export specifiers, not other statements", async () => {
    const r = await extract("typescript", src);
    assert.deepEqual(r.imports.map((i) => i.specifier), ["./db/pool", "../types.js", "./reexported", "react"]);
  });
  it("hashes the body: same code same hash, changed code different hash", async () => {
    const a = await extract("typescript", "export function f() { return 1; }");
    const b = await extract("typescript", "export   function f()  {\n  return 1;\n}");
    const c = await extract("typescript", "export function f() { return 2; }");
    assert.equal(a.symbols[0].bodyHash, b.symbols[0].bodyHash);
    assert.notEqual(a.symbols[0].bodyHash, c.symbols[0].bodyHash);
  });
  it("is tolerant of half-written code", async () => {
    const r = await extract("typescript", "export function ok() { return 1; }\nexport function broken(a, {\n");
    assert.equal(r.hadErrors, true);
    assert.ok(r.symbols.some((s) => s.name === "ok"));
  });
  it("parses TSX and JavaScript", async () => {
    const t = await extract("tsx", "export function App(): JSX.Element { return <div/>; }");
    assert.equal(t.symbols[0].name, "App");
    const j = await extract("javascript", "export function a() {}\nclass B { m() {} }");
    assert.deepEqual(j.symbols.map((s) => s.qualifiedName), ["a", "B", "B.m"]);
  });
});

describe("Python extraction", () => {
  const src = `
import os
import a.b.c as abc
from . import sibling
from .models import User, Group as G
from ..pkg.util import helper
from pkg import mod

class Repo(Base):
    """Stores users.

    Longer description.
    """
    def get(self, id: int) -> "User":
        '''Fetch a user.'''
        return None

    @staticmethod
    def make() -> "Repo":
        return Repo()

    async def load(self):
        pass

    def _private(self): pass

def top_level(a, b=2):
    """Does a thing."""

@decorator(arg)
def decorated(): pass

async def fetch_all(): pass
`;
  it("finds classes, methods, functions, decorators, async", async () => {
    const r = await extract("python", src);
    assert.equal(byName(r, "Repo").kind, "class");
    assert.equal(byName(r, "Repo.get").kind, "method");
    assert.equal(byName(r, "Repo.make").kind, "method");
    assert.equal(byName(r, "Repo.load").signature, "async def load(self)");
    assert.equal(byName(r, "top_level").signature, "def top_level(a, b=2)");
    assert.equal(byName(r, "decorated").kind, "function");
    assert.equal(byName(r, "fetch_all").kind, "function");
    assert.equal(byName(r, "Repo._private").exported, false);
    assert.equal(byName(r, "Repo").exported, true);
  });
  it("reads and dedents docstrings", async () => {
    const r = await extract("python", src);
    assert.equal(byName(r, "Repo").docstring, "Stores users.\n\nLonger description.");
    assert.equal(byName(r, "Repo.get").docstring, "Fetch a user.");
    assert.equal(byName(r, "top_level").docstring, "Does a thing.");
    assert.equal(byName(r, "Repo.load").docstring, null);
  });
  it("collects imports with names", async () => {
    const r = await extract("python", src);
    assert.deepEqual(
      r.imports.map((i) => [i.specifier, i.names]),
      [["os", []], ["a.b.c", []], [".", ["sibling"]], [".models", ["User", "Group"]], ["..pkg.util", ["helper"]], ["pkg", ["mod"]]],
    );
  });
});

describe("search tokenisation", () => {
  it("splits identifiers", () => {
    assert.equal(splitWords("getUserByID"), "get user by id");
    assert.equal(splitWords("SessionStore.get_item"), "session store get item");
    assert.equal(splitWords("HTTPServer"), "http server");
  });
  it("drops stopwords and dedupes", () => {
    assert.deepEqual(queryTokens("how does the user session get the user"), ["user", "session", "get"]);
  });
});
