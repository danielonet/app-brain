# app-brain
generate application context out of code base

- [PLAN.md](PLAN.md): overall design and roadmap.
- [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md): the VS Code extension over a local MCP server, the OKF output format, cost and usage reporting.

## Status: Phase 1 (MVP in progress)

| Package | What it does today |
|---|---|
| `packages/brain-protocol` | Shared types and schemas: config, status, usage, tool and resource names |
| `packages/brain-mcp` | Stdio MCP server. **Indexing:** tree-sitter (WASM) symbols for TypeScript, TSX, JavaScript and Python, import edges between files, SQLite + FTS5 store, incremental re-index, file watcher. **Agent tools (read-only):** `search_code`, `get_symbol`, `get_neighbors`, `impact_of_change`. **Resources:** `brain://status`, `brain://config`, `brain://usage`. **Admin tools (token-gated):** `hello`, `init`, `get_config`, `get_config_schema`, `set_config`, `reindex`. `init` creates the `.brain/` layout with an OKF v0.2 bundle. Every agent call is logged (client, tool, tokens returned, latency) |
| `packages/brain-vscode` | Extension: spawns the server, status bar (files, symbols), **Brain: Search Symbols**, an **Agent Activity** view plus a status bar flash when an agent calls the brain, commands (initialise, reindex, open output folder, copy MCP config), Copilot agent-mode registration |

The index lives in memory until you run **Brain: Initialise**; after that it is cached in `.brain/.cache/brain.db` (gitignored). Nothing is written to your workspace before then. Files matching secret patterns (`.env*`, keys, certificates) and everything in `.gitignore` are never indexed.

Not built yet: doc generation and the review flow, writing OKF concept files, cost reporting, the dependency-graph view, the settings webview, symbol-level call edges (LSP/SCIP), the HTTP daemon. See the plans.

## Develop

```sh
npm install
npm test        # builds, then runs the server and extension tests (needs Node 22.13+ for node:sqlite)
```

Run the extension: open this folder in VS Code and press F5 (“Run App Brain extension”), then open any folder in the new window.

Use the server from another agent without VS Code:

```sh
node packages/brain-mcp/out/cli.js --workspace /path/to/repo
```

The server only enables `brain_admin_*` tools for a client that presents the token in `BRAIN_ADMIN_TOKEN`. Agents started without it get the read-only resources.
