import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".cs": "csharp", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp", ".swift": "swift", ".scala": "scala",
};

/** Directories never indexed, whatever the config says. */
const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules", ".brain", "dist", "out", "build", "target", "__pycache__", ".venv", "venv"]);

/**
 * Files that may contain secrets. Never indexed, never sent to an LLM, whatever
 * the include globs say (PLAN-VSCODE-EXTENSION.md §8).
 */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

export function isSecretFile(relPath: string): boolean {
  return SECRET_FILE.test(relPath);
}

export function languageOf(relPath: string): string | null {
  return LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()] ?? null;
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface ScanOptions {
  workspace: string;
  include: string[];
  exclude: string[];
  languages: string[];
}

export interface ScannedFile {
  path: string; // posix, relative to workspace
  language: string;
}

async function listWithGit(workspace: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), root, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
}

export async function scanWorkspace(opts: ScanOptions): Promise<ScannedFile[]> {
  const candidates = (await listWithGit(opts.workspace)) ?? (await (async () => {
    const out: string[] = [];
    await walk(opts.workspace, opts.workspace, out);
    return out;
  })());

  const include = opts.include.map(globToRegExp);
  const exclude = opts.exclude.map(globToRegExp);
  const wanted = new Set(opts.languages);
  const files: ScannedFile[] = [];

  for (const rel of candidates) {
    if (rel.split("/").some((seg) => ALWAYS_SKIP_DIRS.has(seg))) continue;
    if (isSecretFile(rel)) continue;
    if (exclude.some((r) => r.test(rel))) continue;
    if (include.length > 0 && !include.some((r) => r.test(rel))) continue;
    const language = languageOf(rel);
    if (!language) continue;
    if (wanted.size > 0 && !wanted.has(language)) continue;
    try {
      if (!(await fs.stat(path.join(opts.workspace, rel))).isFile()) continue; // deleted, or a submodule
    } catch {
      continue; // listed by git but missing on disk
    }
    files.push({ path: rel, language });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
