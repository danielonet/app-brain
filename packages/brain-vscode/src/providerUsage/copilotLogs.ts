import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { CopilotUsage } from "@app-brain/brain-protocol";
import { Pricing, TokenCounts, buildBlock, emptyBlock, zeroCounts } from "./shared";

/**
 * Usage of GitHub Copilot Chat in this workspace, read from the session files VS Code keeps beside the workspace's other state
 * (`<workspaceStorage>/<id>/chatSessions/*.jsonl`).
 *
 * Each file is a change log: a snapshot, then "set this field" and "add these requests" lines. Replaying it gives every
 * request with the model that answered, the tokens and Copilot's own credit figure. Only those numbers, the model and the time are
 * read. What was typed or answered is never looked at, kept or sent anywhere. The files are read, never changed.
 *
 * What the numbers are, found by reading real files:
 *  - `completionTokens` is the whole request's output, summed over every model round of an agent turn.
 *  - `promptTokens` is the size of the LAST round's prompt only. An agent turn sends its context once per tool round, so the real
 *    input is higher. Input is therefore a lower bound, and the card says so.
 *  - `copilotCredits` is Copilot's own measure of the request. It is not converted to dollars here: its price is not in the logs.
 */

export interface CopilotRequest {
  model: string;
  day: string; // UTC
  counts: TokenCounts;
  credits: number | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Replays a session's change log into its requests. Unknown or malformed lines are skipped, not fatal. */
export function replaySession(lines: Iterable<string>): Record<string, any>[] {
  let requests: Record<string, any>[] = [];
  for (const line of lines) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o)) continue;
    const k = o.k;
    if (o.kind === 0 && isObj(o.v) && Array.isArray(o.v.requests)) requests = o.v.requests.filter(isObj);
    else if (o.kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === "requests" && Array.isArray(o.v)) {
      const add = o.v.filter(isObj);
      const at = Number.isInteger(o.i) && o.i >= 0 && o.i <= requests.length ? o.i : requests.length;
      requests.splice(at, 0, ...add);
    } else if (o.kind === 1 && Array.isArray(k) && k.length === 3 && k[0] === "requests" && Number.isInteger(k[1]) && typeof k[2] === "string") {
      const r = requests[k[1]];
      if (r && !["__proto__", "constructor", "prototype"].includes(k[2])) r[k[2]] = o.v;
    }
  }
  return requests;
}

/** One request's usage, or null when it carries none (a request that never got an answer). */
export function requestUsage(r: Record<string, any>): CopilotRequest | null {
  const meta = isObj(r.result?.metadata) ? r.result.metadata : {};
  const prompt = num(r.promptTokens ?? meta.promptTokens);
  const output = num(r.completionTokens ?? meta.outputTokens);
  const credits = typeof r.copilotCredits === "number" && Number.isFinite(r.copilotCredits) && r.copilotCredits >= 0 ? r.copilotCredits : null;
  if (!prompt && !output && credits === null) return null;
  const ts = typeof r.timestamp === "number" && Number.isFinite(r.timestamp) ? r.timestamp : NaN;
  if (Number.isNaN(ts)) return null;
  const model = [meta.resolvedModel, r.modelId].find((m) => typeof m === "string" && m) as string | undefined;
  return {
    model: (model ?? "unknown").replace(/^copilot\//, ""),
    day: new Date(ts).toISOString().slice(0, 10),
    counts: { ...zeroCounts(), messages: 1, input: prompt, output },
    credits,
  };
}

interface FileEntry { mtimeMs: number; size: number; requests: CopilotRequest[] }
const fileCache = new Map<string, FileEntry>(); // a session that has not changed is not read again

async function readSession(file: string): Promise<CopilotRequest[]> {
  const st = await fs.stat(file);
  const had = fileCache.get(file);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had.requests;
  const lines: string[] = [];
  for await (const line of readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) lines.push(line);
  const requests = replaySession(lines).map(requestUsage).filter((r): r is CopilotRequest => r !== null);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, requests });
  return requests;
}

export interface CopilotReadOptions {
  /** This workspace's `chatSessions` folder. Undefined when the editor has no per-workspace storage. */
  dir: string | undefined;
  pricing: Pricing;
  lookbackDays: number;
  now?: Date;
}

export async function readCopilotUsage(o: CopilotReadOptions): Promise<CopilotUsage> {
  const now = o.now ?? new Date();
  const none = (message: string, source: string | null = o.dir ?? null): CopilotUsage => ({ ...emptyBlock("none", message), source, sessions: 0, credits: null });
  if (!o.dir) return none("This editor window has no workspace storage, so there are no Copilot Chat sessions to read.", null);
  let files: string[];
  try { files = (await fs.readdir(o.dir)).filter((f) => f.endsWith(".jsonl")); } catch { return none("Copilot Chat has not been used in this workspace on this machine."); }

  const since = now.getTime() - o.lookbackDays * 86_400_000;
  const from = new Date(since).toISOString().slice(0, 10);
  const grouped = new Map<string, { day: string; model: string; counts: TokenCounts }>();
  let sessions = 0, requests = 0, credits = 0, anyCredits = false;
  try {
    for (const f of files) {
      const file = path.join(o.dir, f);
      if ((await fs.stat(file)).mtimeMs < since) continue; // untouched for longer than the window
      const inWindow = (await readSession(file)).filter((r) => r.day >= from);
      if (inWindow.length) sessions++;
      for (const r of inWindow) {
        requests++;
        if (r.credits !== null) { credits += r.credits; anyCredits = true; }
        const k = `${r.day}\u0000${r.model}`;
        const g = grouped.get(k) ?? grouped.set(k, { day: r.day, model: r.model, counts: zeroCounts() }).get(k)!;
        g.counts.messages += 1; g.counts.input += r.counts.input; g.counts.output += r.counts.output;
      }
    }
  } catch (e) {
    return { ...emptyBlock("error", `Could not read the Copilot Chat sessions: ${(e as Error).message}`), source: o.dir, sessions: 0, credits: null };
  }
  if (requests === 0) return none(`No Copilot Chat usage in this workspace in the last ${o.lookbackDays} days.`);
  const block = buildBlock(
    "ok",
    "From Copilot Chat's local sessions. Output is complete. Input is a lower bound: the log keeps only the last round of each agent turn, which resends its context at every tool call. Credits are Copilot's own measure, not dollars; cost shows only for models with a price in your table.",
    [...grouped.values()], o.pricing,
  );
  return { ...block, source: o.dir, sessions, credits: anyCredits ? Math.round(credits * 1e4) / 1e4 : null };
}

/** For tests. */
export const _clearCopilotCache = () => fileCache.clear();
