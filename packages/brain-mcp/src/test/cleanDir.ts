import { rmSync } from "node:fs";

/**
 * Removes a temp folder after a test. On Windows a server that is still shutting down keeps its database and the
 * folder itself open for a moment, so this retries, and gives up quietly there (the OS clears temp folders later).
 * Anywhere else a failure to clean up is a real problem and still throws.
 */
export function cleanDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) return;
    throw e;
  }
}
