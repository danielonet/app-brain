<p align="center">
  <img src="assets/banner.png" alt="app-brain: generate smart context for AI. Summarize documents, organize knowledge, boost AI context." width="100%">
</p>

# app-brain

Generate application context out of a code base: a knowledge base an AI agent can query, written by agents and approved by people.

- [PLAN.md](PLAN.md): overall design and roadmap.
- [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md): the VS Code extension over a local MCP server, the OKF output format, cost and usage reporting.

## Status: Phase 1 complete, Phase 2 started

| Package | What it does today |
|---|---|
| `packages/brain-protocol` | Shared types and schemas: config, status, usage, review, validation, tool and resource names |
| `packages/brain-mcp` | Stdio MCP server (details below) |
| `packages/brain-vscode` | Extension: spawns the server, status bar (files, symbols, docs to review), **Review Queue** (approve or reject generated docs), **Settings** (a form generated from the server's config schema, with inline errors and a model-price table), **Dependency Graph** (modules or files, circular dependencies in red, each node coloured by documentation status and ringed by who reviewed it, click to see what it uses and what uses it, focus, highlight dependents, keyboard accessible), **Export Graph (JSON-LD)**, **Cost & Models** (spend by day, model and module; known versus estimated token counts; approval and rejection rates; a budget meter; a table view under every chart; light and dark), **Export Cost Report** (CSV and Markdown into `.brain/reports/`, safe to open in a spreadsheet), **Agent Activity** view and a status bar flash when an agent calls the brain, **Search Symbols**, **Validate Knowledge Bundle**, initialise, reindex, open output folder, copy MCP config, Copilot agent-mode registration |

**Indexing.** tree-sitter (WASM) symbols for TypeScript, TSX, JavaScript and Python; import edges between files; SQLite + FTS5 store; incremental re-index by mtime and content hash; file watcher. The index lives in memory until you run **Brain: Initialise**, then moves to `.brain/.cache/brain.db` (gitignored). Secret files (`.env*`, keys, certificates) and everything in `.gitignore` are never indexed.

**Agent tools (read-only, no token).** `search_code`, `get_symbol`, `get_neighbors`, `impact_of_change`, `get_graph`, `get_overview` (the reviewed doc for a file or module, with its OKF trust tier and a warning when the code changed since), `list_undocumented`, `save_summary`. Every call is logged (client, tool, tokens returned, latency) at `brain://usage`.

**Documentation flow.** An agent calls `list_undocumented` (ranked by how many files import each target), reads the code, and calls `save_summary`. That writes an **unreviewed draft** to `.brain/drafts/`, never to the knowledge base. A person approves or rejects it in VS Code. Approval moves it into `.brain/knowledge/`, an [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle, with `status: stable` and `verified: {by: human:<you>}`; the server maintains `index.md` and `log.md`, and a managed `Dependencies` block in each doc. Code changes make a reviewed doc *stale* (computed from a content hash, never written into the files). Rejections and edits are recorded in `.brain/feedback/feedback.jsonl`. `brain_admin_validate` checks OKF conformance, broken links, orphans and dependency cycles. Every `save_summary` is recorded in an `llm_call` table with the model that wrote it.

**Admin tools (token-gated, extension only).** `hello`, `init`, `get_config`, `get_config_schema`, `set_config`, `reindex`, `review_summary`, `validate`, `export_graph` (writes `.brain/graph/graph.jsonld`), `export_cost_report`. Agents started without `BRAIN_ADMIN_TOKEN` cannot call them, so an agent cannot approve its own docs.

**Cost.** Every `save_summary` is recorded with the model, token counts and where they came from (reported by the agent, or estimated). A call made before its model had a price is priced from today's table, but only when both token counts are known; otherwise the report says the total is a lower bound and why. The budget cap is a warning for now: nothing stops an agent that keeps going.

Not built yet: doc generation by the server itself (`vscode.lm`, API key), notes (`add_note`), symbol-level call edges (LSP/SCIP), the HTTP daemon. See the plans.

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
