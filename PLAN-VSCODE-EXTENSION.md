# app-brain VS Code extension: plan (thin client over a local MCP server)

Companion to [PLAN.md](PLAN.md). That plan describes the whole system. This one narrows the scope and moves the boundary: **the local MCP server does all the work, and the VS Code extension is a front end for configuring it and seeing what it is doing.**

Status: design draft. Nothing is built yet.

---

## 1. Goal and scope

**Goal:** a VS Code extension that sits in front of a local MCP server (`brain-mcp`). The server indexes the code, builds the knowledge base, generates documentation and answers agents. The extension lets a human:

1. **Configure** the server (what to index, which LLM path, where output goes).
2. **See** what the server is doing and how well it is working (index status, doc coverage, staleness, agent usage).
3. **Give feedback** (review, approve, reject or correct generated docs, rate answers) that flows back into the server.

**In scope for the extension:** settings UI, server lifecycle, status and progress, tree views, webviews, review flow, feedback, config snippets for other agents.

**Out of scope for the extension (server only):** parsing, indexing, the code graph, ranking, doc generation, search, storage. The extension must never contain this logic. If the extension is uninstalled, the server must still work in Claude Code, Cursor and the CLI.

This reverses one choice in PLAN.md §3, where the extension ran the file watcher and the LSP bridge. Here both move into the server. See §9 for what that costs.

---

## 2. Architecture

```
┌────────────── VS Code extension (brain-vscode) ──────────────┐
│ Thin client: no indexing, no parsing, no DB access           │
│  • Settings / config UI          • Status bar, progress      │
│  • Brain tree view               • Docs coverage dashboard   │
│  • Review + feedback UI          • Stale-doc CodeLens        │
│  • Server lifecycle              • Config snippets for agents│
│  • MCP client (@modelcontextprotocol/sdk)                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ MCP (stdio or localhost HTTP)
                            │ tools + resources + notifications
┌───────────────────────────▼──────────────────────────────────┐
│ brain-mcp (local server, Node/TypeScript)                    │
│  • Agent tools: search_code, get_symbol, get_neighbors, ...  │
│  • Admin tools: get_status, get_config, set_config,          │
│    reindex, generate_docs, review_summary, submit_feedback   │
│  • Indexer: tree-sitter (WASM) + optional LSP/SCIP input     │
│  • Doc generator, ranking, staleness tracking                │
│  • Emits progress + change notifications                     │
└───────────────────────────┬──────────────────────────────────┘
                            │
        <workspace>/.brain/            ← all output (see §5)
        └── .cache/brain.db            ← SQLite (derived, gitignored)

   Other agents (Copilot, Claude Code, Cursor) connect to the same brain-mcp.
```

### The extension is just another MCP client

The extension talks to the server with the same protocol agents use. This avoids inventing a second API.

- **Reads** use MCP **resources**: `brain://status`, `brain://config`, `brain://coverage`, `brain://docs/pending-review`, `brain://usage`.
- **Actions** use MCP **tools** prefixed `brain_admin_` (reindex, generate docs, approve a summary, save config, submit feedback). Agents are told not to use these. They are hidden from the default agent tool list, and the server exposes them only to clients that connect as the extension (see §8).
- **Live updates** use MCP **notifications**: `notifications/progress` for long jobs (indexing, doc generation) and `notifications/resources/updated` so views refresh without polling.

### Transport: two options

| Option | How | Pro | Con |
|---|---|---|---|
| **A. stdio, one process per client** | The extension spawns its own `brain-mcp`. Claude Code and others spawn theirs. All share `.brain/.cache/brain.db` (SQLite WAL). | Simple. Matches how every MCP client already works. | Several server processes per workspace. Each one must coordinate writes. The extension cannot see what another client's server is doing. |
| **B. one local daemon, HTTP on `127.0.0.1`** | The extension starts (or attaches to) a single `brain-mcp` per workspace and publishes its URL. Agents connect to the same URL. | One indexer, one writer, and the extension sees agent usage live. | Needs a port, a token and a lock file. Not every client supports HTTP MCP yet. |

**Recommendation:** build the server to support both. Ship **B as the default in VS Code** (the extension owns the daemon, the lock file is `.brain/.cache/server.json` with `{pid, port, token}`), and keep **A** for terminal use without VS Code. When a stdio server starts and finds a live daemon, it proxies to it instead of indexing a second time.

---

## 3. Division of responsibilities

| Concern | Server (`brain-mcp`) | Extension (`brain-vscode`) |
|---|---|---|
| Indexing, graph, search | Owns | Triggers and displays |
| File watching | Owns (watches the workspace itself) | None |
| Semantic edges (LSP) | Optional: SCIP import, or its own language servers. See §9 | Optional: forwards VS Code language-provider results through an admin tool |
| Doc generation | Owns, runs the pipeline | Starts, stops, shows progress |
| LLM access | Owns the call (BYO key or local model) or delegates to the agent | Can offer `vscode.lm` as a provider, see §6 |
| Config | Owns the schema and validation, persists `.brain/config.json` | Edits it through forms, never writes the file directly |
| Output files | Writes all files under `.brain/` | Opens and displays them, edits notes on request |
| Review state | Stores status (`generated`, `reviewed`, `stale`) | Collects the human decision |
| Feedback | Stores and uses it | Collects it |
| Lifecycle | Runs until stopped | Starts, health-checks, restarts, shows logs |

---

## 4. Extension features

### 4.1 Configuration

Two layers, so team defaults and personal choices stay separate.

- **Team config (committed):** `.brain/config.json`. Written by the server, edited through the extension's **Brain: Settings** webview. Holds what must be the same for everyone: include/exclude globs, languages, output paths, doc granularity, model policy.
- **Personal settings (VS Code `settings.json`, not committed):** server path, transport, port, API key reference, log level. Secrets go in VS Code `SecretStorage`, never in a file.

The webview renders a form from the JSON schema the server returns from `brain_admin_get_config_schema`, so a new server option shows up in the UI without an extension release. Saving calls `brain_admin_set_config`; the server validates and replies with errors the form can show inline.

Key settings:

| Setting | Where | Default | Meaning |
|---|---|---|---|
| `outputDir` | team config | `.brain` | Root of all generated and curated output (§5) |
| `include` / `exclude` | team config | all source, minus `.gitignore`, `node_modules`, `.env*`, build dirs | What gets indexed. Secrets files are always excluded |
| `languages` | team config | auto-detected | Which tree-sitter grammars to load |
| `docs.granularity` | team config | `module` | `symbol`, `file`, `module` or `architecture-only` |
| `docs.autoGenerate` | team config | `false` | Generate on index, or only on request |
| `llm.mode` | personal | `agent` | `agent` (the user's agent writes docs), `vscode-lm`, `api-key`, `local` |
| `server.transport` | personal | `http` | `http` (daemon) or `stdio` |
| `server.command` | personal | bundled | Path to the `brain-mcp` entry point, for development |
| `commitDocs` | team config | `true` | Whether `.brain/docs` is meant to be committed (affects the generated `.gitignore`) |

### 4.2 Visualisation and feedback

| Surface | Shows | Data source |
|---|---|---|
| **Status bar item** | `Brain: ready · 2,314 symbols · 41 stale`, spinner while working, red on error | `brain://status` |
| **Brain view** (activity bar) | Tree: Modules → files → symbols, each with a status icon (generated / reviewed / stale / none) | `brain://coverage`, `get_overview` |
| **Review queue** | Pending summaries with a side-by-side diff of code and doc. Actions: Approve, Edit, Reject, Regenerate | `brain://docs/pending-review`, `brain_admin_review_summary` |
| **Coverage dashboard** (webview) | Percent documented by module, stale count over time, index freshness, top undocumented central symbols | `brain://coverage` |
| **Agent activity** (webview or output channel) | Which tools agents called, with what query, what came back, latency, tokens | `brain://usage` |
| **Stale-doc CodeLens** | "Doc is stale, regenerate?" above symbols whose `body_hash` changed | `brain://coverage` for the open file |
| **Hover** | Summary and review status on hover over a symbol | `get_symbol` |
| **Feedback buttons** | Thumbs up / down and a note on any summary or on a logged agent answer | `brain_admin_submit_feedback` |
| **Output channel** | Server logs | server stderr or log file |

**Feedback loop.** The server records each piece of feedback against the symbol or answer it refers to. It uses it in three ways: rejected summaries are regenerated with the human's note as extra context; summaries the human edited are marked `reviewed` and become examples for later generation; and "wrong result" feedback on a search is added to the retrieval benchmark set (PLAN.md §8).

### 4.3 Commands

`Brain: Open Settings`, `Brain: Start Server`, `Brain: Stop Server`, `Brain: Reindex Workspace`, `Brain: Generate Docs for Module…`, `Brain: Open Review Queue`, `Brain: Open Output Folder`, `Brain: Add Note`, `Brain: Copy MCP Config for Claude Code`, `Brain: Copy MCP Config for Cursor`, `Brain: Show Server Logs`.

### 4.4 Making agents find the server

- **Copilot in VS Code:** register the server with `mcpServerDefinitionProviders` so it needs no manual setup.
- **Claude Code, Cursor and others:** the "Copy MCP Config" commands write or show the snippet (`.mcp.json` or the client's equivalent) pointing at the same server.

---

## 5. Where the output goes

All output lives under **one root folder at the workspace root: `.brain/`**. It is configurable with `outputDir`, and the path is relative to the workspace root. In a multi-root workspace each folder gets its own `.brain/`.

```
<workspace>/
└── .brain/
    ├── config.json              # team config                 [commit]
    ├── notes/                   # curated human knowledge      [commit]
    │   ├── decisions/           #   why we did X
    │   ├── conventions.md
    │   └── gotchas.md
    ├── docs/                    # reviewed, approved docs      [commit]
    │   ├── architecture.md      #   top-level overview
    │   ├── modules/
    │   │   └── <path>/index.md  #   one per directory / module
    │   └── files/
    │       └── <path>.md        #   per-file docs (if granularity ≥ file)
    ├── drafts/                  # generated, not yet reviewed  [gitignored]
    │   └── (same layout as docs/)
    ├── feedback/                # review notes and ratings     [commit, optional]
    │   └── feedback.jsonl
    ├── site/                    # static markdown/HTML export  [gitignored]
    ├── .cache/                  #                              [gitignored]
    │   ├── brain.db             #   SQLite: graph, FTS, embeddings
    │   ├── server.json          #   {pid, port, token} for the running daemon
    │   └── logs/
    └── .gitignore               # written by the server, covers the ignored paths above
```

**Rules**

- **Everything under `docs/`, `notes/` and `config.json` is plain Markdown or JSON, human-readable, and the source of truth.** `.cache/` can be deleted at any time and rebuilt from the code plus these files.
- **Drafts vs reviewed.** The server writes every generated doc to `drafts/` first. **Approving a doc in the extension moves it to `docs/`.** This makes "generated, unreviewed" a physical location, not just a flag, so a PR only ever contains reviewed docs. Regenerating a stale reviewed doc writes a new draft and leaves the old reviewed doc in place, marked stale, until the new one is approved.
- **Front matter on every doc**, so status survives a lost database:

  ```yaml
  ---
  target: src/auth/session.ts        # file, directory or symbol
  kind: file                         # symbol | file | module | architecture
  status: reviewed                   # generated | reviewed | stale
  built_from_hash: 9f2c1e…           # hash of the code it describes
  model: claude-…                    # or "human" when hand-written
  reviewed_by: <git user name>
  reviewed_at: 2026-11-16
  ---
  ```
- **The extension never writes into `docs/` itself.** Edits and approvals go through `brain_admin_review_summary`, so the server can update its status table and keep file and database consistent. The one exception is `notes/`: **Brain: Add Note** can create a file there directly, and the server picks it up through its file watcher.
- **Per-user data stays out of the repo.** Logs and the daemon lock file are in `.cache/`. The extension's own global state (last-used workspace, UI layout) lives in VS Code's `globalStorageUri`.
- **Export for sharing.** `site/` is produced on demand (a CLI or `Brain: Export Docs Site` command) and is not committed by default.

---

## 6. Server lifecycle (what the extension does on activation)

1. Find the workspace root and read `.brain/config.json` (absent → offer **Brain: Initialise**, which asks the server to create it with defaults and write `.brain/.gitignore`).
2. Resolve the server: bundled build, a user-set path, or `npx`-style install. Check its version against the extension's required protocol version. On mismatch, show a clear upgrade message and do not connect.
3. Read `.brain/.cache/server.json`. If a live daemon exists (pid alive, health check passes), attach. Otherwise spawn one.
4. Connect as an MCP client, call `brain_admin_hello` to declare itself the extension and receive the admin tool set.
5. Subscribe to `brain://status` and `brain://coverage`; draw the status bar and views.
6. On a crash, restart with backoff (3 tries), then show an error in the status bar with a **Show Logs** action.
7. On deactivate, leave the daemon running only if other clients are attached; otherwise stop it.

**LLM modes.** In `agent` mode the server offers `list_undocumented` / `save_summary` to agents and the extension only displays progress. In `vscode-lm` mode the server asks the extension, over an MCP sampling-style request, to run the prompt through VS Code's `vscode.lm` API and return the text, because only the extension can reach that API. `api-key` and `local` modes run entirely in the server.

---

## 7. Implementation structure

```
packages/
  brain-protocol/   # shared TypeScript types + JSON schemas for admin tools,
                    # resources, notifications, config (single source of truth)
  brain-core/       # parsers, store, ranking, doc generator   (server side)
  brain-mcp/        # MCP server: agent tools + admin tools, stdio and HTTP
  brain-vscode/     # extension: MCP client, views, webviews, commands
  brain-cli/        # CI / terminal entry point, reuses brain-core
```

`brain-protocol` is what keeps the two halves in step: both import the same types, and the extension's settings form is generated from the server's schema. TypeScript throughout, as PLAN.md recommends, so the VS Code extension and the server share one language.

---

## 8. Security and privacy

- **HTTP transport binds to `127.0.0.1` only** and requires a random bearer token generated at daemon start, stored in `.brain/.cache/server.json` with file mode `0600`. No token, no connection.
- **Admin tools are gated.** `brain_admin_*` tools work only for a client that presents the admin token. Agents get the read-only agent tool set, so an agent cannot approve its own summaries or change config.
- **No secrets on disk in the repo.** API keys live in `SecretStorage` and are passed to the server by environment variable when it is spawned.
- **Never indexed, regardless of config:** `.env*`, key and certificate files, anything matching the secret-file patterns, and everything in `.gitignore` unless explicitly included.
- **The extension tells the user when code is leaving the machine** (modes `vscode-lm`, `api-key`) with a one-time confirmation per workspace.
- **Untrusted workspaces:** in a VS Code untrusted workspace the extension does not spawn the server and shows a read-only message.

---

## 9. Consequences of putting everything in the server

Moving the file watcher and semantic analysis out of the extension has costs worth stating:

- **Lost shortcut: VS Code's language providers.** PLAN.md used `vscode.executeDefinitionProvider` and friends to get resolved references for free. A headless server cannot call those. Options:
  1. **SCIP indexers** run by the server (precise, but needs a build step per language).
  2. The server **starts its own language servers** (what Serena does). More work, but fully independent of VS Code.
  3. **Extension as an optional edge feeder:** if the user opts in, the extension calls the language providers and pushes resolved edges to the server through `brain_admin_submit_edges`. This keeps VS Code's zero-setup benefit but breaks the rule that the extension has no logic, so it is off by default and clearly separate.

  **Recommendation:** MVP uses tree-sitter only (name-matched edges, flagged low confidence). Phase 2 adds option 3 as an opt-in, Phase 3 adds option 1.
- **File watching is duplicated** if the server and VS Code both watch. Acceptable: only the server does it, and the extension just displays the result.
- **The extension is fully replaceable.** A different front end (a web UI, a JetBrains plugin) can be built against the same admin tools without changing the server. This is the main benefit of the split.

---

## 10. Roadmap

- **Phase 0 — protocol spike (~1 week):** `brain-protocol` types, a minimal `brain-mcp` with `brain://status` and `brain_admin_get_config`, and an extension that spawns it over stdio and shows the status bar item. Proves the client/server split end to end.
- **Phase 1 — MVP:**
  - Server: tree-sitter index for two languages, `search_code`, `get_symbol`, `.brain/` layout creation, status and coverage resources, progress notifications.
  - Extension: activation and lifecycle, Settings webview from the server schema, Brain tree view, status bar, Output Folder command, Copy MCP Config, `mcpServerDefinitionProviders` registration.
- **Phase 2 — review and feedback:** drafts → docs promotion, Review queue, CodeLens for stale docs, feedback storage and use in regeneration, coverage dashboard, HTTP daemon mode with token.
- **Phase 3 — depth:** agent-activity view, optional language-provider edge feeder, `vscode-lm` mode, docs site export, SCIP import.
- **Phase 4:** team features: shared config conventions, multi-root workspaces, CI integration.

---

## 11. Testing

- **Protocol tests:** the server and extension are both tested against `brain-protocol` schemas, so drift fails the build.
- **Server:** unit and integration tests with fixture repos, no VS Code needed. This is where most tests live, because most logic lives here.
- **Extension:** `@vscode/test-electron` smoke tests (activate, connect to a stub MCP server, render the tree), plus webview tests with the server stubbed.
- **End-to-end:** a script that starts the daemon on a fixture repo, drives it through the extension's commands, and checks the files created under `.brain/`.
- **Does it help agents:** the task and retrieval benchmarks from PLAN.md §8, run against the server alone.

---

## 12. Open decisions

- **Default transport:** HTTP daemon (recommended) vs per-client stdio. Check which target clients support HTTP MCP before fixing it.
- **Admin-tool separation:** same server with a token-gated tool set (recommended) vs a second, extension-only endpoint.
- **Drafts location:** physical `drafts/` folder (recommended) vs a status flag in one `docs/` folder. The folder is clearer in git but doubles the file layout.
- **Commit generated docs by default?** Recommended: commit only reviewed docs. Needs agreement from the team.
- **Server distribution:** bundled with the VSIX (works offline, larger) vs installed on first run (smaller, needs network).
- **Native SQLite packaging:** the server is a separate Node process, so native `better-sqlite3` is usable there, which removes the Electron ABI problem from PLAN.md §3.
- **First two languages** for Phase 1.
