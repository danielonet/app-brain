import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BrainConfig,
  ConfigError,
  ConfigSchema,
  DEFAULT_OUTPUT_DIR,
  InitResult,
  OKF_VERSION,
  defaultConfig,
} from "@app-brain/brain-protocol";

export class BrainWorkspace {
  readonly root: string;
  readonly outputDir: string; // relative, posix

  constructor(root: string, outputDir: string = DEFAULT_OUTPUT_DIR) {
    this.root = path.resolve(root);
    const normalised = path.posix.normalize(outputDir.split(path.sep).join("/"));
    if (path.isAbsolute(outputDir) || normalised.startsWith("..") || normalised === ".") {
      throw new Error(`outputDir must be a folder inside the workspace, got "${outputDir}"`);
    }
    this.outputDir = normalised.replace(/\/$/, "");
  }

  abs(...parts: string[]): string {
    return path.join(this.root, this.outputDir, ...parts);
  }
  get configPath(): string {
    return this.abs("config.json");
  }

  async isInitialised(): Promise<boolean> {
    try {
      await fs.access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Reads config.json; falls back to defaults when the workspace is not initialised. */
  async readConfig(): Promise<BrainConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, "utf8");
    } catch {
      return { ...defaultConfig(), outputDir: this.outputDir };
    }
    return ConfigSchema.parse(JSON.parse(raw));
  }

  /** Validates and writes the config. Returns errors instead of throwing. */
  async writeConfig(input: unknown): Promise<{ config: BrainConfig } | { errors: ConfigError[] }> {
    const parsed = ConfigSchema.safeParse(input);
    if (!parsed.success) {
      return { errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    }
    if (parsed.data.outputDir !== this.outputDir) {
      return {
        errors: [{
          path: "outputDir",
          message: `The server is running with outputDir "${this.outputDir}". Move the folder and restart the server with the new path to change it.`,
        }],
      };
    }
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(parsed.data, null, 2) + "\n");
    return { config: parsed.data };
  }

  /** Creates the layout from PLAN-VSCODE-EXTENSION.md §5. Never overwrites an existing file. */
  async init(now: Date = new Date()): Promise<InitResult> {
    const alreadyInitialised = await this.isInitialised();
    const created: string[] = [];
    const rel = (p: string) => path.relative(this.root, p).split(path.sep).join("/");

    const write = async (file: string, content: string) => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, { flag: "wx" });
        created.push(rel(file));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    };

    const config = { ...defaultConfig(), outputDir: this.outputDir };
    await write(this.configPath, JSON.stringify(config, null, 2) + "\n");

    await write(
      this.abs(".gitignore"),
      ["# Written by brain-mcp. Derived or unreviewed output is never committed.", ".cache/", "drafts/", "graph/", "reports/", "site/", ""].join("\n"),
    );

    // OKF bundle root. Only the root index.md may carry front matter (OKF §7).
    await write(
      this.abs("knowledge", "index.md"),
      `---\nokf_version: "${OKF_VERSION}"\n---\n\n# Knowledge\n\nReviewed knowledge about this code base, as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle. Maintained by brain-mcp.\n`,
    );
    const day = now.toISOString().slice(0, 10);
    await write(this.abs("knowledge", "log.md"), `# Log\n\n## ${day}\n\n- **Creation**: knowledge bundle initialised.\n`);
    for (const dir of ["notes", "references", "files", "modules"]) {
      await fs.mkdir(this.abs("knowledge", dir), { recursive: true });
    }
    await fs.mkdir(this.abs("drafts"), { recursive: true });
    await fs.mkdir(this.abs(".cache"), { recursive: true });

    return { created, alreadyInitialised };
  }
}
