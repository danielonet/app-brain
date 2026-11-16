import { promises as fs } from "node:fs";
import * as path from "node:path";
import { OKF_VERSION } from "@app-brain/brain-protocol";
import {
  FrontMatter, GENERATED_MARKER, IndexEntry, RESERVED, addLogEntry, isGeneratedIndex, isNonEmptyString, parseConcept, renderIndex, serializeConcept,
} from "./format";
import type { BrainWorkspace } from "../workspace";

export type Area = "knowledge" | "drafts";

export interface ConceptFile {
  /** Path inside the area, posix, with `.md`: `files/src/a.ts.md`. */
  conceptPath: string;
  fm: FrontMatter;
  body: string;
}

export interface BrokenFile {
  conceptPath: string;
  reason: "none" | "invalid";
  message: string;
}

/** Atomic write: a reader never sees half a file. */
async function writeAtomic(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

/**
 * File operations on the OKF bundle (`knowledge/`) and its unreviewed twin (`drafts/`).
 * Only paths built from validated concept paths ever reach the disk.
 */
export class Bundle {
  constructor(private readonly ws: BrainWorkspace) {}

  dir(area: Area): string {
    return this.ws.abs(area);
  }

  /** Rejects anything that is not a plain relative `.md` path inside the area. */
  private safe(area: Area, conceptPath: string): string {
    const norm = path.posix.normalize(conceptPath);
    if (norm.startsWith("..") || norm.startsWith("/") || !norm.endsWith(".md") || norm.includes("\0")) {
      throw new Error(`Invalid concept path: ${conceptPath}`);
    }
    const abs = path.join(this.dir(area), ...norm.split("/"));
    if (!abs.startsWith(this.dir(area) + path.sep)) throw new Error(`Invalid concept path: ${conceptPath}`);
    return abs;
  }

  /** Workspace-relative path, for display. */
  rel(area: Area, conceptPath: string): string {
    return path.relative(this.ws.root, this.safe(area, conceptPath)).split(path.sep).join("/");
  }

  async exists(area: Area, conceptPath: string): Promise<boolean> {
    try {
      await fs.access(this.safe(area, conceptPath));
      return true;
    } catch {
      return false;
    }
  }

  /** All `.md` paths in an area, including reserved files. */
  async allMarkdown(area: Area): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + e.name + "/");
        else if (e.isFile() && e.name.endsWith(".md")) out.push(prefix + e.name);
      }
    };
    await walk(this.dir(area), "");
    return out.sort();
  }

  /** Concept files (reserved names excluded). Files that fail to parse are returned in `broken`. */
  async list(area: Area): Promise<{ concepts: ConceptFile[]; broken: BrokenFile[] }> {
    const concepts: ConceptFile[] = [];
    const broken: BrokenFile[] = [];
    for (const conceptPath of await this.allMarkdown(area)) {
      if (RESERVED.has(path.posix.basename(conceptPath))) continue;
      const r = await this.read(area, conceptPath);
      if ("fm" in r) concepts.push(r);
      else broken.push(r);
    }
    return { concepts, broken };
  }

  async read(area: Area, conceptPath: string): Promise<ConceptFile | BrokenFile> {
    const text = await fs.readFile(this.safe(area, conceptPath), "utf8");
    const parsed = parseConcept(text);
    if (!parsed.ok) return { conceptPath, reason: parsed.reason, message: parsed.message };
    return { conceptPath, fm: parsed.fm, body: parsed.body };
  }

  async readText(area: Area, conceptPath: string): Promise<string> {
    return fs.readFile(this.safe(area, conceptPath), "utf8");
  }

  async write(area: Area, conceptPath: string, fm: FrontMatter, body: string): Promise<void> {
    await writeAtomic(this.safe(area, conceptPath), serializeConcept(fm, body));
  }

  async remove(area: Area, conceptPath: string): Promise<void> {
    await fs.rm(this.safe(area, conceptPath), { force: true });
  }

  // ---- index.md and log.md -----------------------------------------------------

  /**
   * Regenerates `index.md` in every directory that holds concepts (OKF §7). A hand-written
   * index (no generated marker) is left alone; the root index keeps its `okf_version`.
   */
  async regenerateIndexes(): Promise<void> {
    const { concepts } = await this.list("knowledge");
    const dirs = new Map<string, { concepts: ConceptFile[]; subdirs: Set<string> }>();
    const ensure = (d: string) => dirs.get(d) ?? (dirs.set(d, { concepts: [], subdirs: new Set() }), dirs.get(d)!);
    ensure("");
    for (const c of concepts) {
      const d = path.posix.dirname(c.conceptPath) === "." ? "" : path.posix.dirname(c.conceptPath);
      ensure(d).concepts.push(c);
      // register every ancestor so subdirectories are linked from their parent
      let child = d;
      while (child) {
        const parent = path.posix.dirname(child) === "." ? "" : path.posix.dirname(child);
        ensure(parent).subdirs.add(child);
        child = parent;
      }
    }
    for (const [d, info] of dirs) {
      const indexPath = (d ? d + "/" : "") + "index.md";
      let existing = "";
      try { existing = await this.readText("knowledge", indexPath); } catch { /* new */ }
      if (existing && !isGeneratedIndex(existing) && d !== "") continue; // human-owned
      if (d === "" && existing && !isGeneratedIndex(existing)) {
        // The root index written by `init` has no marker yet; adopt it, keeping okf_version.
        const p = parseConcept(existing);
        if (p.ok && Object.keys(p.fm).some((k) => k !== "okf_version")) continue; // customised: leave alone
      }
      const entries: IndexEntry[] = [];
      for (const sub of [...info.subdirs].filter((s) => (path.posix.dirname(s) === "." ? "" : path.posix.dirname(s)) === d).sort()) {
        entries.push({ title: `${path.posix.basename(sub)}/`, link: `/${sub}/index.md`, description: "" });
      }
      for (const c of info.concepts.sort((a, b) => a.conceptPath.localeCompare(b.conceptPath))) {
        entries.push({
          title: isNonEmptyString(c.fm.title) ? c.fm.title : c.conceptPath.replace(/\.md$/, ""),
          link: `/${c.conceptPath}`,
          description: isNonEmptyString(c.fm.description) ? c.fm.description : "",
        });
      }
      const heading = d === "" ? "Knowledge" : path.posix.basename(d);
      const text = renderIndex(heading, entries, d === "" ? { okf_version: OKF_VERSION } : undefined);
      if (text !== existing) await writeAtomic(this.safe("knowledge", indexPath), text);
    }
  }

  async log(label: string, message: string): Promise<void> {
    const file = this.safe("knowledge", "log.md");
    let current = "# Log\n";
    try { current = await fs.readFile(file, "utf8"); } catch { /* first entry */ }
    await writeAtomic(file, addLogEntry(current, label, message));
  }

  /** Reviews are recorded so rejected text and human notes can steer the next generation. */
  async appendFeedback(entry: Record<string, unknown>): Promise<void> {
    const file = this.ws.abs("feedback", "feedback.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
}

export { GENERATED_MARKER };
