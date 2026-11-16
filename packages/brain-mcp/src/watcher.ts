import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { ALWAYS_SKIP_DIRS, isSecretFile } from "./scan";

export interface WatchOptions {
  root: string;
  /** First segment of the output dir, e.g. ".brain". Changes inside it never trigger indexing. */
  outputDirName: string;
  debounceMs?: number;
  onChange: () => void;
  onError?: (e: Error) => void;
}

/**
 * Debounced recursive watcher. It only says "something relevant changed"; the
 * indexer decides what, using mtime and hashes. Events inside ignored folders
 * and secret files are dropped so editing them costs nothing.
 */
export function watchWorkspace(opts: WatchOptions): { close(): void } {
  let timer: NodeJS.Timeout | null = null;
  const skip = new Set([...ALWAYS_SKIP_DIRS, opts.outputDirName]);
  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(opts.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(path.sep);
      if (rel.some((seg) => skip.has(seg))) return;
      if (isSecretFile(rel.join("/"))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        opts.onChange();
      }, opts.debounceMs ?? 400);
    });
    watcher.on("error", (e) => opts.onError?.(e));
  } catch (e) {
    opts.onError?.(e as Error); // e.g. inotify limit reached: the server still works, just without live updates
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
