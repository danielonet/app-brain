#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_OUTPUT_DIR, ENV_ADMIN_TOKEN, ENV_WORKSPACE } from "@app-brain/brain-protocol";
import { createBrainServer } from "./server.js";
import { BrainWorkspace } from "./workspace.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const workspace = new BrainWorkspace(arg("workspace") ?? process.env[ENV_WORKSPACE] ?? process.cwd(), arg("output-dir") ?? DEFAULT_OUTPUT_DIR);
  const brain = createBrainServer({ workspace, adminToken: process.env[ENV_ADMIN_TOKEN] });
  await brain.server.connect(new StdioServerTransport());
  // stdout is the protocol channel; log to stderr only.
  console.error(`brain-mcp ready: workspace=${workspace.root} output=${workspace.outputDir}`);
  brain.start();
}

main().catch((e) => {
  console.error("brain-mcp failed to start:", e);
  process.exit(1);
});
