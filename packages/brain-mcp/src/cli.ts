#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_OUTPUT_DIR, ENV_ADMIN_TOKEN, ENV_WORKSPACE } from "@app-brain/brain-protocol";
import { createBrainServer } from "./server";
import { BrainWorkspace } from "./workspace";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const workspace = new BrainWorkspace(arg("workspace") ?? process.env[ENV_WORKSPACE] ?? process.cwd(), arg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  // stdout is the protocol channel; log to stderr only.
  const log = (line: string) => console.error(`brain-mcp: ${line}`);
  const brain = createBrainServer({ workspace, adminToken: process.env[ENV_ADMIN_TOKEN], watch: !process.argv.includes("--no-watch"), log });
  await brain.server.connect(new StdioServerTransport());
  log(`ready: workspace=${workspace.root} output=${workspace.outputDir}`);
  await brain.start();

  const shutdown = () => {
    brain.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown); // the client went away
}

main().catch((e) => {
  console.error("brain-mcp failed to start:", e);
  process.exit(1);
});
