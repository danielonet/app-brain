/**
 * Pure OKF (Open Knowledge Format v0.2) helpers: front matter, links, the
 * auto-maintained dependency block, generated indexes and the log.
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */
import * as path from "node:path";
import * as YAML from "yaml";

export type FrontMatter = Record<string, unknown>;

/** `index.md` and `log.md` are reserved at every level and are never concepts (OKF §1). */
export const RESERVED = new Set(["index.md", "log.md"]);
export const GENERATED_MARKER = "<!-- brain:generated -->";

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

export type Parsed = { ok: true; fm: FrontMatter; body: string } | { ok: false; reason: "none" | "invalid"; message: string };

export function parseConcept(text: string): Parsed {
  const t = text.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  if (!t.startsWith("---\n")) return { ok: false, reason: "none", message: "No YAML front matter block." };
  const end = t.indexOf("\n---", 3);
  if (end < 0 || !/^\n---[ \t]*(\n|$)/.test(t.slice(end))) return { ok: false, reason: "invalid", message: "Front matter block is not closed with ---." };
  let data: unknown;
  try {
    data = YAML.parse(end > 4 ? t.slice(4, end) : "");
  } catch (e) {
    return { ok: false, reason: "invalid", message: `Front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "invalid", message: "Front matter must be a YAML mapping." };
  const after = t.slice(end + 4).replace(/^[ \t]*\n/, "");
  return { ok: true, fm: data as FrontMatter, body: after.replace(/^\n+/, "") };
}

export function serializeConcept(fm: FrontMatter, body: string): string {
  const yaml = YAML.stringify(fm, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "").trimEnd()}\n`;
}

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Reads `a.b.c` from nested objects. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Bundle-absolute link to a concept file: `files/src/a.ts.md` -> `/files/src/a.ts.md`. */
export const linkTo = (conceptPath: string) => "/" + conceptPath;

const FENCE = /^(```|~~~)/;
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Markdown links in `body` that point at other `.md` files in the bundle, resolved to
 * bundle-relative paths. External URLs and pure anchors are skipped. Code fences are skipped.
 */
export function bundleLinks(body: string, fromConceptPath: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(LINK)) {
      let target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      target = target.split("#")[0].split("?")[0];
      if (!target.endsWith(".md")) continue;
      const resolved = target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(fromConceptPath), target);
      out.push(path.posix.normalize(resolved));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-maintained dependency block (text outside the markers is human-owned)
// ---------------------------------------------------------------------------

const AUTO_START = "<!-- brain:auto:start dependencies -->";
const AUTO_END = "<!-- brain:auto:end -->";
const AUTO_RE = /<!-- brain:auto:start dependencies -->[\s\S]*?<!-- brain:auto:end -->\n?/;

/** Removes any auto markers from untrusted text so an author cannot forge the managed block. */
export function stripAutoMarkers(text: string): string {
  return text.replace(/<!--\s*brain:auto:(start|end)[^>]*-->/g, "");
}

export function dependencyBlock(dependsOn: string[], usedBy: string[]): string {
  const item = (conceptPath: string) => `[${conceptPath.replace(/\.md$/, "").replace(/^(files|modules)\//, "")}](${linkTo(conceptPath)})`;
  const lines = [AUTO_START, "# Dependencies", ""];
  lines.push(dependsOn.length ? `- Depends on: ${dependsOn.map(item).join(", ")}` : "- Depends on: nothing in this repository");
  lines.push(usedBy.length ? `- Used by: ${usedBy.map(item).join(", ")}` : "- Used by: nothing in this repository");
  lines.push(AUTO_END);
  return lines.join("\n") + "\n";
}

/** Replaces the managed block, or appends it when the body has none. */
export function withDependencyBlock(body: string, block: string): string {
  return AUTO_RE.test(body) ? body.replace(AUTO_RE, block) : body.trimEnd() + "\n\n" + block;
}

// ---------------------------------------------------------------------------
// Generated index.md (OKF §7) and log.md (OKF §8)
// ---------------------------------------------------------------------------

export interface IndexEntry {
  title: string;
  link: string; // bundle-absolute
  description: string;
}

export function renderIndex(heading: string, entries: IndexEntry[], rootFrontMatter?: FrontMatter): string {
  const lines = [GENERATED_MARKER, `# ${heading}`, ""];
  for (const e of entries) lines.push(`- [${e.title}](${e.link})${e.description ? `: ${e.description}` : ""}`);
  const body = lines.join("\n") + "\n";
  return rootFrontMatter ? `---\n${YAML.stringify(rootFrontMatter).trimEnd()}\n---\n\n${body}` : body;
}

export const isGeneratedIndex = (text: string) => text.includes(GENERATED_MARKER);

/** Adds `- **label**: message` under today's date heading (newest first). */
export function addLogEntry(log: string, label: string, message: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const entry = `- **${label}**: ${message}`;
  const text = log.replace(/\r\n/g, "\n");
  const dayHeading = new RegExp(`^## ${day}\\n\\n`, "m");
  if (dayHeading.test(text)) return text.replace(dayHeading, (m) => m + entry + "\n");
  const m = text.match(/^# Log\n+/);
  const head = m ? m[0] : "# Log\n\n";
  const rest = m ? text.slice(m[0].length) : text;
  return `${head}## ${day}\n\n${entry}\n\n${rest}`.trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/** Strongly connected components with more than one member (Tarjan). */
export function cycles(edges: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
