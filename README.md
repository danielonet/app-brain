# app-brain
generate application context out of code base

- [PLAN.md](PLAN.md): overall design and roadmap.
- [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md): the VS Code extension over a local MCP server, the OKF output format, cost and usage reporting.

## Status: Phase 1 complete, Phase 2 started

| Package | What it does today |
|---|---|
| `packages/brain-protocol` | Shared types and schemas: config, status, usage, review, validation, tool and resource names |
| `packages/brain-mcp` | Stdio MCP server (details below) |
| `packages/brain-vscode` | Extension: spawns the server, status bar (files, symbols, docs to review), **Review Queue** (approve or reject generated docs), **Agent Activity** view and a status bar flash when an agent calls the brain, **Search Symbols**, **Validate Knowledge Bundle**, initialise, reindex, open output folder, copy MCP config, Copilot agent-mode registration |

**Indexing.** tree-sitter (WASM) symbols for TypeScript, TSX, JavaScript and Python; import edges between files; SQLite + FTS5 store; incremental re-index by mtime and content hash; file watcher. The index lives in memory until you run **Brain: Initialise**, then moves to `.brain/.cache/brain.db` (gitignored). Secret files (`.env*`, keys, certificates) and everything in `.gitignore` are never indexed.

**Agent tools (read-only, no token).** `search_code`, `get_symbol`, `get_neighbors`, `impact_of_change`, `list_undocumented`, `save_summary`. Every call is logged (client, tool, tokens returned, latency) at `brain://usage`.

**Documentation flow.** An agent calls `list_undocumented` (ranked by how many files import each target), reads the code, and calls `save_summary`. That writes an **unreviewed draft** to `.brain/drafts/`, never to the knowledge base. A person approves or rejects it in VS Code. Approval moves it into `.brain/knowledge/`, an [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle, with `status: stable` and `verified: {by: human:<you>}`; the server maintains `index.md` and `log.md`, and a managed `Dependencies` block in each doc. Code changes make a reviewed doc *stale* (computed from a content hash, never written into the files). Rejections and edits are recorded in `.brain/feedback/feedback.jsonl`. `brain_admin_validate` checks OKF conformance, broken links, orphans and dependency cycles. Every `save_summary` is recorded in an `llm_call` table with the model that wrote it.

**Admin tools (token-gated, extension only).** `hello`, `init`, `get_config`, `get_config_schema`, `set_config`, `reindex`, `review_summary`, `validate`. Agents started without `BRAIN_ADMIN_TOKEN` cannot call them, so an agent cannot approve its own docs.

Not built yet: the cost calculator UI and price-table editor, doc generation by the server itself (`vscode.lm`, API key), the dependency-graph view, the settings webview, notes (`add_note`), symbol-level call edges (LSP/SCIP), the HTTP daemon. See the plans.

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
