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

**Cost.** Every `save_summary` is recorded with the model, token counts and where they came from (reported by the agent, or estimated). A call made before its model had a price is priced from today's table, but only when both token counts are known; otherwise the report says the total is a lower bound and why. The budget cap stops the server's own generation before it would go over; it cannot stop an agent that calls `save_summary` on its own.

**One shared server.** By default (`brain.server.transport`: `http`) the extension starts one `brain-mcp` daemon per workspace on `127.0.0.1` and every client uses it: the extension, and any agent whose usual stdio config (`node packages/brain-mcp/out/cli.js --workspace …`, see **Brain: Copy MCP Config**) quietly becomes a proxy to it. The code is indexed once, and the extension shows what agents ask as it happens. Details and the security model are in [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md) §2 and §8. In short:

- It listens on loopback only, needs a bearer token, and rejects browser requests and unexpected `Host` headers.
- `server.json` (with the *agent* token, read-only tools) is in a per-user runtime directory, not in your workspace. The *admin* token and any API key are never in a file, the environment or the command line: they are passed on stdin and kept in memory, so an agent cannot approve its own drafts by reading a file.
- It stops when the editor closes if the editor was its only client, leaves itself running for agents or another window otherwise, and exits after ten minutes with nobody connected. If it cannot start, the editor uses a private server and says so.
- Run it yourself with `node packages/brain-mcp/out/cli.js --daemon --workspace .`; `--no-proxy` makes a stdio server run on its own even when a daemon exists.

**Server-side generation.** **Brain: Generate Docs** lets the server write the drafts itself instead of waiting for an agent. Choose who writes them in the `brain.llm.*` settings (the default, `agent`, does nothing):

| Mode | Who writes | Tokens and cost | Leaves your machine |
|---|---|---|---|
| `api-key` | Claude, through the official SDK, with a key kept in VS Code's secret storage (**Brain: Set LLM API Key**) | Exact, from the API's usage | Yes: source code goes to Anthropic. Anything that looks like a credential is removed first |
| `vscode-lm` | The editor's own model (for example Copilot), asked over MCP sampling. VS Code asks for consent | Measured by the editor's tokenizer, or estimated | Whatever that model's provider does |
| `local` | A model you host (Ollama, LM Studio, llama.cpp, any OpenAI-compatible server), picked with `brain.llm.local.preset` and **Brain: Choose Local Model** | Free on this machine or your network; server-reported when it reports usage | Not if the URL is on this machine; otherwise the confirmation says exactly where your code goes |

**Local models** need two things beyond a URL. **Brain: Test LLM Connection** tells you what is wrong in plain words: the server is not running, the model is not pulled, the URL is not on this machine. And `brain.llm.local.contextTokens` must match the context window your server really runs the model with (servers often default to 2 to 4K tokens, and cut longer prompts off silently); prompts are sized to it, anything cut says so in the doc, and files that cannot fit are skipped and reported. See [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md) §6.1.

Before anything is spent you see an estimate (every number labelled as one) and confirm. The job is bottom-up (files by how many others import them, then modules from the deepest up, so a module reads the summaries of what it contains), runs one document at a time, shows progress, and can be cancelled mid-call. The budget cap is enforced here: before each call the server prices its worst case and stops rather than risk going over, and it refuses to start with a cap if the model has no price. A refusal, a truncated answer or an unusable one is recorded as a problem, still counted in the cost report, and never kept. Three failures in a row stop the job; a rejected key stops it at once. Reviewer notes from earlier rejections are given to the model on the next attempt. Everything written is still an unreviewed draft: nothing reaches the knowledge base without a person approving it. The code is treated as data: all repository text sits inside a fence with a random id that the code cannot close, and the model's output cannot forge a review or the managed dependency block.

Not built yet: notes (`add_note`), symbol-level call edges (LSP/SCIP), the HTTP daemon, automatic generation after indexing (`docs.autoGenerate` is reserved and does nothing). See the plans.

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
