import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  Coverage, DocKind, PendingItem, ReviewResult, ValidationIssue, ValidationResult,
} from "@app-brain/brain-protocol";
import type { BrainStore } from "../store";
import type { BrainWorkspace } from "../workspace";
import { Bundle, ConceptFile } from "./bundle";
import {
  FrontMatter, bundleLinks, cycles, dependencyBlock, getPath, isNonEmptyString, linkTo, stripAutoMarkers, withDependencyBlock,
} from "./format";

export const SERVER_PRODUCER = "brain-mcp";
const MAX_SUMMARY = 20_000;
const MAX_DESCRIPTION = 300;

export interface Target {
  kind: DocKind;
  target: string; // repo-relative path; "." for the repo root module
  hash: string;
  symbols: number;
  importedBy: number;
  imports: number;
  files: number;
}

interface State {
  reviewed?: ConceptFile;
  draft?: ConceptFile;
  hash: string;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const iso = () => new Date().toISOString();

export function conceptPathFor(kind: DocKind, target: string): string {
  return kind === "file" ? `files/${target}.md` : `modules/${target === "." ? "_root" : target}.md`;
}

/** `src/auth/session.ts` -> `src/auth`; a top-level file -> `.`. */
const dirOf = (p: string) => path.posix.dirname(p);
const moduleConcept = (dir: string) => conceptPathFor("module", dir);

/** Normalises user-supplied targets and rejects anything outside the repo. */
export function cleanTarget(raw: string): string {
  let t = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!t) t = ".";
  const norm = path.posix.normalize(t);
  if (norm.startsWith("..") || norm.startsWith("/") || norm.includes("\0")) throw new Error(`Target must be a path inside the repository: ${raw}`);
  return norm;
}

const slug = (s: string) => s.trim().replace(/[^\w.@-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

export class Knowledge {
  readonly bundle: Bundle;

  constructor(
    private readonly ws: BrainWorkspace,
    private readonly store: () => BrainStore,
    private readonly changed: () => void,
    /** False while the index is being (re)built; dependencies must not be recomputed from a partial index. */
    private readonly indexReady: () => boolean = () => true,
  ) {
    this.bundle = new Bundle(ws);
  }

  // ---- what can be documented ------------------------------------------------

  /** Files with symbols, and the directories that contain at least two of them. */
  targets(): Target[] {
    const files = this.store().docFiles().filter((f) => f.symbols > 0);
    const out: Target[] = files.map((f) => ({
      kind: "file", target: f.path, hash: f.content_hash, symbols: f.symbols, importedBy: f.imported_by, imports: f.imports, files: 1,
    }));
    const dirs = new Map<string, typeof files>();
    for (const f of files) {
      let d = dirOf(f.path);
      for (;;) {
        (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(f);
        if (d === ".") break;
        d = dirOf(d);
      }
    }
    for (const [d, list] of dirs) {
      if (list.length < 2) continue;
      const under = new Set(list.map((f) => f.path));
      let importedBy = 0;
      for (const f of list) importedBy += this.store().neighbours(f.path, "in").filter((e) => !under.has(e.from)).length;
      out.push({
        kind: "module", target: d,
        hash: sha1(list.map((f) => `${f.path}:${f.content_hash}`).join("\n")),
        symbols: list.reduce((n, f) => n + f.symbols, 0), importedBy, imports: 0, files: list.length,
      });
    }
    return out;
  }

  /** Resolves a user-supplied target to a documentable thing, or explains why not. */
  resolve(rawTarget: string, kind?: DocKind): Target {
    const target = cleanTarget(rawTarget);
    const all = this.targets();
    const hit = all.find((t) => t.target === target && (!kind || t.kind === kind));
    if (hit) return hit;
    const store = this.store();
    if (store.hasFile(target)) throw new Error(`${target} has no symbols to document (not a supported language, or empty).`);
    throw new Error(`Unknown target: ${rawTarget}. Use a file path from list_undocumented or search_code, or a directory with at least two source files.`);
  }

  // ---- state of each target -------------------------------------------------------

  private async states(): Promise<{ states: Map<string, State>; targets: Target[]; drafts: ConceptFile[] }> {
    const targets = this.targets();
    const [k, d] = await Promise.all([this.bundle.list("knowledge"), this.bundle.list("drafts")]);
    const reviewed = new Map(k.concepts.map((c) => [c.conceptPath, c]));
    const draftMap = new Map(d.concepts.map((c) => [c.conceptPath, c]));
    const states = new Map<string, State>();
    for (const t of targets) {
      const cp = conceptPathFor(t.kind, t.target);
      states.set(`${t.kind}:${t.target}`, { reviewed: reviewed.get(cp), draft: draftMap.get(cp), hash: t.hash });
    }
    return { states, targets, drafts: d.concepts };
  }

  private static builtFrom(c?: ConceptFile): string | undefined {
    const h = c ? getPath(c.fm, "brain.built_from_hash") : undefined;
    return typeof h === "string" ? h : undefined;
  }

  async coverage(): Promise<Coverage> {
    const { states, targets } = await this.states();
    const empty = () => ({ total: 0, reviewed: 0, drafts: 0, stale: 0 });
    const out: Coverage = { files: empty(), modules: empty() };
    for (const t of targets) {
      const bucket = t.kind === "file" ? out.files : out.modules;
      const s = states.get(`${t.kind}:${t.target}`)!;
      bucket.total++;
      if (s.reviewed) {
        if (Knowledge.builtFrom(s.reviewed) === s.hash) bucket.reviewed++;
        else bucket.stale++;
      }
      if (s.draft) bucket.drafts++;
    }
    return out;
  }

  async pending(): Promise<PendingItem[]> {
    const { states, drafts } = await this.states();
    const hashByTarget = new Map<string, string>();
    for (const [key, s] of states) hashByTarget.set(key, s.hash);
    const reviewedPaths = new Set((await this.bundle.list("knowledge")).concepts.map((c) => c.conceptPath));
    const items: PendingItem[] = [];
    for (const d of drafts) {
      const target = getPath(d.fm, "brain.target");
      const kind = getPath(d.fm, "brain.kind");
      if (typeof target !== "string" || (kind !== "file" && kind !== "module")) continue;
      const gen = (d.fm.generated ?? {}) as { by?: unknown; at?: unknown };
      const current = hashByTarget.get(`${kind}:${target}`);
      items.push({
        target, kind, conceptPath: d.conceptPath, draftFile: this.bundle.rel("drafts", d.conceptPath),
        description: isNonEmptyString(d.fm.description) ? d.fm.description : "",
        generatedBy: typeof gen.by === "string" ? gen.by : "unknown",
        generatedAt: typeof gen.at === "string" ? gen.at : "",
        model: (getPath(d.fm, "brain.llm.model") as string | undefined) ?? null,
        stale: current !== undefined && Knowledge.builtFrom(d) !== current,
        replacesReviewed: reviewedPaths.has(d.conceptPath),
      });
    }
    return items.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }

  async counts(): Promise<{ reviewed: number; drafts: number; stale: number }> {
    const c = await this.coverage();
    return { reviewed: c.files.reviewed + c.modules.reviewed, drafts: c.files.drafts + c.modules.drafts, stale: c.files.stale + c.modules.stale };
  }

  // ---- list_undocumented -------------------------------------------------------------

  async listUndocumented(opts: { kind: DocKind; limit: number; offset: number }) {
    const { states, targets } = await this.states();
    const store = this.store();
    const rows = targets
      .filter((t) => t.kind === opts.kind)
      .map((t) => ({ t, s: states.get(`${t.kind}:${t.target}`)! }))
      .filter(({ t, s }) => {
        const reviewedFresh = s.reviewed && Knowledge.builtFrom(s.reviewed) === t.hash;
        const draftFresh = s.draft && Knowledge.builtFrom(s.draft) === t.hash;
        return !reviewedFresh && !draftFresh;
      })
      .sort((a, b) => b.t.importedBy - a.t.importedBy || b.t.symbols - a.t.symbols || a.t.target.localeCompare(b.t.target));
    const page = rows.slice(opts.offset, opts.offset + opts.limit).map(({ t, s }) => ({
      target: t.target,
      kind: t.kind,
      reason: s.reviewed ? "stale" : s.draft ? "draft-outdated" : "none",
      imported_by: t.importedBy,
      ...(t.kind === "file"
        ? { symbols: store.symbolsInFile(t.target, 8).map((x) => x.qualified_name), imports: t.imports }
        : { files: t.files }),
    }));
    const next = opts.offset + page.length;
    return { total: rows.length, results: page, ...(next < rows.length ? { next_offset: next } : {}) };
  }

  // ---- save_summary -------------------------------------------------------------------

  private dependencies(t: Target): { dependsOn: string[]; usedBy: string[] } {
    const store = this.store();
    const self = conceptPathFor(t.kind, t.target);
    if (t.kind === "file") {
      return {
        dependsOn: [...new Set(store.neighbours(t.target, "out").map((e) => conceptPathFor("file", e.to)))].sort(),
        usedBy: [...new Set(store.neighbours(t.target, "in").map((e) => conceptPathFor("file", e.from)))].sort(),
      };
    }
    const under = store.filesUnder(t.target === "." ? "" : t.target).map((f) => f.path);
    const inside = new Set(under);
    const dep = new Set<string>();
    const used = new Set<string>();
    for (const f of under) {
      for (const e of store.neighbours(f, "out")) if (!inside.has(e.to)) dep.add(moduleConcept(dirOf(e.to)));
      for (const e of store.neighbours(f, "in")) if (!inside.has(e.from)) used.add(moduleConcept(dirOf(e.from)));
    }
    dep.delete(self);
    used.delete(self);
    return { dependsOn: [...dep].sort(), usedBy: [...used].sort() };
  }

  async saveSummary(a: {
    target: string; kind?: DocKind; description: string; summary: string; model: string;
    tokensIn?: number; tokensOut?: number; tags?: string[]; client: string;
  }): Promise<{ target: string; kind: DocKind; draft: string; conceptPath: string }> {
    if (a.summary.length > MAX_SUMMARY) throw new Error(`Summary is too long (${a.summary.length} characters, max ${MAX_SUMMARY}). Summarise more tightly.`);
    const description = a.description.replace(/\s+/g, " ").trim();
    if (!description) throw new Error("description is required: one sentence saying what this code is for.");
    if (description.length > MAX_DESCRIPTION) throw new Error(`description must be one short sentence (max ${MAX_DESCRIPTION} characters).`);
    const model = a.model.trim();
    if (!model) throw new Error("model is required: the id of the model that wrote this summary, so cost and quality can be tracked.");

    const t = this.resolve(a.target, a.kind);
    const conceptPath = conceptPathFor(t.kind, t.target);
    const abs = t.target === "." ? this.ws.root : path.join(this.ws.root, ...t.target.split("/"));
    const conceptDirAbs = path.join(this.ws.abs("drafts"), ...path.posix.dirname(conceptPath).split("/"));
    const resource = path.relative(conceptDirAbs, abs).split(path.sep).join("/") || ".";
    const { dependsOn, usedBy } = this.dependencies(t);
    const partOf = t.target === "." ? undefined : linkTo(moduleConcept(dirOf(t.target)));

    const cfg = await this.ws.readConfig();
    const price = cfg.pricing[model];
    const tokensOut = a.tokensOut ?? Math.ceil(a.summary.length / 4);
    const tokensSource = a.tokensOut !== undefined || a.tokensIn !== undefined ? "agent-reported" : "estimated";
    const cost = price && a.tokensIn !== undefined ? (a.tokensIn * price.inputPerMtok + tokensOut * price.outputPerMtok) / 1e6 : null;

    let lastModified: string | undefined;
    if (t.kind === "file") lastModified = (await fs.stat(abs)).mtime.toISOString();

    const now = iso();
    const fm: FrontMatter = {
      type: t.kind === "file" ? "Brain File" : "Brain Module",
      title: t.target === "." ? "Repository root" : t.target,
      description,
      resource,
      ...(a.tags?.length ? { tags: a.tags.map((x) => x.trim()).filter(Boolean).slice(0, 10) } : {}),
      generated: { by: `${slug(a.client) || "agent"}/${slug(model) || "unknown"}`, at: now },
      status: "draft",
      sources: [{ id: "code", resource, ...(lastModified ? { last_modified: lastModified } : {}) }],
      brain: {
        target: t.target,
        kind: t.kind,
        built_from_hash: t.hash,
        ...(partOf ? { part_of: partOf } : {}),
        depends_on: dependsOn.map(linkTo),
        llm: {
          model,
          mode: "agent",
          tokens_in: a.tokensIn ?? null,
          tokens_out: tokensOut,
          cost_usd: cost,
          tokens_source: tokensSource,
        },
      },
    };
    const body = withDependencyBlock(`# Summary\n\n${stripAutoMarkers(a.summary).trim()}\n`, dependencyBlock(dependsOn, usedBy));
    await this.bundle.write("drafts", conceptPath, fm, body);

    this.store().logLlmCall({
      target: t.target, kind: t.kind, provider: null, model, mode: "agent",
      inputTokens: a.tokensIn ?? null, outputTokens: tokensOut, tokensSource,
      costUsd: cost, costSource: cost === null ? null : "price-table", outcome: "generated",
    });
    this.changed();
    return { target: t.target, kind: t.kind, draft: this.bundle.rel("drafts", conceptPath), conceptPath };
  }

  // ---- review ------------------------------------------------------------------------------

  async review(a: { target: string; action: "approve" | "reject"; by: string; note?: string; body?: string }): Promise<ReviewResult> {
    const by = slug(a.by);
    if (!by) throw new Error("`by` is required: who is making this decision.");
    const target = cleanTarget(a.target);
    // The draft knows its own kind; look it up instead of trusting the caller.
    const drafts = (await this.bundle.list("drafts")).concepts;
    const draft = drafts.find((d) => getPath(d.fm, "brain.target") === target);
    if (!draft) throw new Error(`No draft is waiting for ${target}.`);
    const kind = getPath(draft.fm, "brain.kind") as DocKind;
    const conceptPath = draft.conceptPath;
    const model = (getPath(draft.fm, "brain.llm.model") as string | undefined) ?? null;

    if (a.action === "reject") {
      await this.bundle.remove("drafts", conceptPath);
      await this.bundle.appendFeedback({ target, action: "reject", by, model, note: a.note ?? null, rejectedText: draft.body.slice(0, 4000) });
      this.store().setLlmOutcome(target, "rejected");
      this.changed();
      return { action: "reject", target, conceptPath };
    }

    const existed = await this.bundle.exists("knowledge", conceptPath);
    const edited = a.body !== undefined && a.body.trim() !== "";
    const fm: FrontMatter = { ...draft.fm, status: "stable", verified: { by: `human:${by}`, at: iso() } };

    // Dependencies come from the code as it is now, not as it was when the draft was written.
    const current = this.targets().find((t) => t.kind === kind && t.target === target);
    let body = edited ? stripAutoMarkers(a.body!) : draft.body;
    if (current && this.indexReady()) {
      const { dependsOn, usedBy } = this.dependencies(current);
      (fm.brain as Record<string, unknown>).depends_on = dependsOn.map(linkTo);
      body = withDependencyBlock(body, dependencyBlock(dependsOn, usedBy));
    }
    await this.bundle.write("knowledge", conceptPath, fm, body);
    await this.bundle.remove("drafts", conceptPath);
    await this.bundle.regenerateIndexes();
    await this.bundle.log(existed ? "Update" : "Creation", `${kind} documentation for \`${target}\` approved by ${by}${edited ? " (edited)" : ""}.`);
    if (edited || a.note) await this.bundle.appendFeedback({ target, action: edited ? "approve-edited" : "approve", by, model, note: a.note ?? null });
    this.store().setLlmOutcome(target, "approved");
    this.changed();
    return { action: "approve", target, conceptPath };
  }

  // ---- validate ----------------------------------------------------------------------------

  async validate(): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];
    const add = (severity: ValidationIssue["severity"], code: ValidationIssue["code"], file: string, message: string) =>
      issues.push({ severity, code, file, message });

    const { concepts, broken } = await this.bundle.list("knowledge");
    const all = await this.bundle.allMarkdown("knowledge");
    const existing = new Set(all);
    const conceptPaths = new Set(concepts.map((c) => c.conceptPath));

    // OKF §10: every non-reserved file parses and has a non-empty `type`.
    for (const b of broken) add("error", b.reason === "none" ? "no-frontmatter" : "bad-frontmatter", b.conceptPath, b.message);
    for (const c of concepts) {
      if (!isNonEmptyString(c.fm.type)) add("error", "missing-type", c.conceptPath, "Front matter has no non-empty `type` (the only required OKF key).");
    }
    // OKF §7: index files carry no front matter, except the root's okf_version.
    for (const p of all.filter((x) => path.posix.basename(x) === "index.md" && x !== "index.md")) {
      if (parseConcept0(await this.bundle.readText("knowledge", p))) add("warning", "index-frontmatter", p, "Only the root index.md may have front matter.");
    }

    // Links, orphans, dependency targets.
    const inbound = new Map<string, number>();
    for (const c of concepts) {
      for (const target of new Set(bundleLinks(c.body, c.conceptPath))) {
        if (!existing.has(target)) add("info", "broken-link", c.conceptPath, `Links to ${linkTo(target)}, which does not exist yet.`);
        else if (target !== c.conceptPath) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    for (const c of concepts) {
      if (!inbound.has(c.conceptPath)) add("info", "orphan", c.conceptPath, "No other concept links to this one.");
    }
    const store = this.store();
    for (const c of concepts) {
      const deps = getPath(c.fm, "brain.depends_on");
      if (!Array.isArray(deps)) continue;
      for (const d of deps) {
        const m = typeof d === "string" ? d.match(/^\/files\/(.+)\.md$/) : null;
        if (m && !store.hasFile(m[1])) add("warning", "depends-on-missing", c.conceptPath, `depends_on lists ${m[1]}, which is not in the index (deleted or renamed?).`);
      }
    }

    // Cycles over brain.depends_on: between modules is a design smell, between files is common.
    for (const [prefix, severity] of [["/modules/", "warning"], ["/files/", "info"]] as const) {
      const edges = new Map<string, string[]>();
      for (const c of concepts) {
        if (!conceptPaths.has(c.conceptPath) || !("/" + c.conceptPath).startsWith(prefix)) continue;
        const deps = getPath(c.fm, "brain.depends_on");
        edges.set(linkTo(c.conceptPath), Array.isArray(deps) ? deps.filter((d): d is string => typeof d === "string" && d.startsWith(prefix)) : []);
      }
      for (const comp of cycles(edges)) add(severity, "cycle", comp[0].slice(1), `Circular dependency: ${comp.join(" ↔ ")}`);
    }

    return { conformant: !issues.some((i) => i.severity === "error"), concepts: concepts.length, issues };
  }
}

/** True when the file starts with a front matter block. */
function parseConcept0(text: string): boolean {
  return text.replace(/\r\n/g, "\n").startsWith("---\n");
}
