import { createReadStream, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ClaudeCodeUsage } from "@app-brain/brain-protocol";
import { Pricing, TokenCounts, buildBlock, emptyBlock, zeroCounts } from "./shared";

/**
 * Usage of Claude Code in this workspace, read from the session logs Claude Code keeps on this machine
 * (`<config dir>/projects/<workspace path with non-alphanumerics as dashes>/*.jsonl`).
 *
 * Only usage numbers, the model, the time and the working directory are read. Nothing a person typed or Claude answered
 * is looked at, kept or sent anywhere. The logs are read, never changed.
 */

/** One answer from the model, as the log recorded it. */
export interface LogMessage {
  id: string;
  model: string;
  day: string; // UTC
  counts: TokenCounts;
}

/** Claude Code names a project's folder after its path: every character that is not a letter or digit becomes a dash. */
export const encodeProjectDir = (workspace: string) => workspace.replace(/[^A-Za-z0-9]/g, "-");

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
}

const norm = (p: string) => (process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/\\/g, "/")).replace(/\/+$/, "");

/** Whether `cwd` is the workspace or inside it. */
export function insideWorkspace(cwd: unknown, workspace: string): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  const c = norm(cwd), w = norm(workspace);
  return c === w || c.startsWith(w + "/");
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Reads the answers out of log lines. Claude Code writes one line per content block of an answer, each repeating the
 * answer's usage, and may copy answers into a resumed session; so an answer counts once, by its message id, with the
 * line that has the most output (the last, complete one).
 */
export function parseLogLines(lines: Iterable<string>, workspace: string, into: Map<string, LogMessage> = new Map()): Map<string, LogMessage> {
  for (const line of lines) {
    if (!line.includes('"usage"')) continue; // cheap skip: most lines are not answers
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "assistant" || !insideWorkspace(o.cwd, workspace)) continue;
    const m = o.message;
    const u = m?.usage;
    const model = typeof m?.model === "string" ? m.model : "";
    if (!u || !model || model.startsWith("<")) continue; // "<synthetic>": messages Claude Code wrote itself
    const ts = typeof o.timestamp === "string" ? o.timestamp : "";
    if (!/^\d{4}-\d{2}-\d{2}/.test(ts)) continue;
    const id = typeof m.id === "string" && m.id ? m.id : typeof o.uuid === "string" ? o.uuid : "";
    if (!id) continue;
    const cc = u.cache_creation;
    const write5m = cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
    const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
    const counts: TokenCounts = { messages: 1, input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h, output: num(u.output_tokens) };
    const had = into.get(id);
    if (!had || counts.output >= had.counts.output) into.set(id, { id, model, day: ts.slice(0, 10), counts });
  }
  return into;
}

interface FileEntry { mtimeMs: number; size: number; messages: LogMessage[] }
const fileCache = new Map<string, FileEntry>(); // a log that has not changed is not read again

async function readFileMessages(file: string, workspace: string): Promise<LogMessage[]> {
  const st = await fs.stat(file);
  const key = `${workspace}\u0000${file}`;
  const had = fileCache.get(key);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had.messages;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const found = new Map<string, LogMessage>();
  const lines: string[] = [];
  // Stream line by line: logs can be hundreds of megabytes.
  for await (const line of rl) { lines.push(line); if (lines.length >= 2000) { parseLogLines(lines, workspace, found); lines.length = 0; } }
  parseLogLines(lines, workspace, found);
  const messages = [...found.values()];
  fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, messages });
  return messages;
}

export interface ReadOptions {
  workspace: string;
  pricing: Pricing;
  lookbackDays: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: Date;
}

export async function readClaudeCodeUsage(o: ReadOptions): Promise<ClaudeCodeUsage> {
  const now = o.now ?? new Date();
  const root = path.join(claudeConfigDir(o.env, o.home), "projects");
  const none = (message: string, source: string | null = root): ClaudeCodeUsage => ({ ...emptyBlock("none", message), source, sessions: 0 });
  let dirs: string[];
  try {
    const prefix = encodeProjectDir(o.workspace);
    // The folder of the workspace itself, and of folders inside it (Claude Code may have been started in a subfolder).
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && (d.name === prefix || d.name.startsWith(prefix + "-"))).map((d) => path.join(root, d.name));
  } catch {
    return none("No Claude Code logs were found on this machine.", null);
  }
  if (dirs.length === 0) return none("Claude Code has not been used in this workspace on this machine.");

  const since = now.getTime() - o.lookbackDays * 86_400_000;
  const messages = new Map<string, LogMessage>();
  let sessions = 0;
  try {
    for (const dir of dirs) {
      for (const f of await fs.readdir(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const file = path.join(dir, f);
        if ((await fs.stat(file)).mtimeMs < since) continue; // untouched for longer than the window
        const found = await readFileMessages(file, o.workspace);
        if (found.length) sessions++;
        for (const m of found) { const had = messages.get(m.id); if (!had || m.counts.output >= had.counts.output) messages.set(m.id, m); }
      }
    }
  } catch (e) {
    return { ...emptyBlock("error", `Could not read the Claude Code logs: ${(e as Error).message}`), source: root, sessions: 0 };
  }

  const from = new Date(since).toISOString().slice(0, 10);
  const inWindow = [...messages.values()].filter((m) => m.day >= from);
  if (inWindow.length === 0) return none(`No Claude Code usage in this workspace in the last ${o.lookbackDays} days.`);

  const grouped = new Map<string, { day: string; model: string; counts: TokenCounts }>();
  for (const m of inWindow) {
    const k = `${m.day}\u0000${m.model}`;
    const g = grouped.get(k) ?? grouped.set(k, { day: m.day, model: m.model, counts: zeroCounts() }).get(k)!;
    const c = g.counts;
    c.messages += m.counts.messages; c.input += m.counts.input; c.cacheRead += m.counts.cacheRead;
    c.cacheWrite5m += m.counts.cacheWrite5m; c.cacheWrite1h += m.counts.cacheWrite1h; c.output += m.counts.output;
  }
  const block = buildBlock("ok", "Worked out from Claude Code's local logs at your price table: what the API would charge, not necessarily what you paid (a subscription is billed differently).", [...grouped.values()], o.pricing);
  return { ...block, source: root, sessions };
}

/** For tests. */
export const _clearCache = () => fileCache.clear();
