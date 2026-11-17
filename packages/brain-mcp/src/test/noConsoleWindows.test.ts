import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

/**
 * On Windows a child process started without `windowsHide: true` opens a console window, and the server and the
 * editor start processes often (git on every index, the daemon), so the user sees windows flash and vanish.
 * Every place that starts a process must say so; this fails the build if a new one forgets.
 */
const SRC_DIRS = [path.resolve(__dirname, "../../src"), path.resolve(__dirname, "../../../brain-vscode/src")];
// A start of a process: spawn(...), execFile(...), or the promisified alias execFileAsync(...). Not `.exec(` (regex, database).
const START = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execFileAsync|execAsync)\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "test" ? [] : sources(path.join(dir, e.name))) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
  );
}

describe("child processes", () => {
  it("never open a console window on Windows", () => {
    const missing: string[] = [];
    for (const file of SRC_DIRS.flatMap(sources)) {
      const text = readFileSync(file, "utf8");
      if (!/node:child_process/.test(text)) continue;
      const starts = [...text.matchAll(START)].length;
      const hidden = [...text.matchAll(/windowsHide:\s*true/g)].length;
      if (starts > hidden) missing.push(`${path.relative(process.cwd(), file)}: ${starts} process start(s), ${hidden} with windowsHide`);
    }
    assert.deepEqual(missing, [], "add windowsHide: true to these");
  });
});
