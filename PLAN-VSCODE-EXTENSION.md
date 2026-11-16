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
| LLM cost and model records | Counts tokens, applies the price table, stores `llm_call` rows, enforces the budget cap | Shows estimates and reports, edits prices and the cap |
| Agent usage log | Logs every MCP call by client and session, correlates follow-up actions | Shows the live indicator, timeline and per-session summary |
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
| **Agent activity** (webview) | Which tools agents called, with what query, what came back, latency, tokens, confidence badge, per-session summary (§4.4) | `brain://usage` |
| **Cost & Models** (webview) | Spend and tokens by day, model, job and module; exact vs estimated share; pre-run estimate (§4.3) | `brain://cost/summary` |
| **Stale-doc CodeLens** | "Doc is stale, regenerate?" above symbols whose `body_hash` changed | `brain://coverage` for the open file |
| **Hover** | Summary and review status on hover over a symbol | `get_symbol` |
| **Feedback buttons** | Thumbs up / down and a note on any summary or on a logged agent answer | `brain_admin_submit_feedback` |
| **Output channel** | Server logs | server stderr or log file |

**Feedback loop.** The server records each piece of feedback against the symbol or answer it refers to. It uses it in three ways: rejected summaries are regenerated with the human's note as extra context; summaries the human edited are marked `reviewed` and become examples for later generation; and "wrong result" feedback on a search is added to the retrieval benchmark set (PLAN.md §8).

### 4.3 Cost calculator and LLM report

The server records every LLM call it makes or oversees for doc generation, and the extension shows the totals and an estimate before anything is spent.

**What is recorded (one row per call, in the `llm_call` table):**

| Field | Meaning |
|---|---|
| `ts`, `job_id` | When, and which generation job it belonged to |
| `target` | The symbol, file or module being documented |
| `provider`, `model` | **Which LLM was used** (e.g. `anthropic` / `claude-…`, `vscode-lm` / `copilot-…`, `local` / `llama…`) |
| `llm_mode` | `agent`, `vscode-lm`, `api-key` or `local` |
| `input_tokens`, `output_tokens`, `cached_tokens` | Token counts |
| `tokens_source` | `provider-reported` (exact, from the API response) or `estimated` (counted by a tokenizer) |
| `cost_usd`, `cost_source` | Computed from the price table (below) |
| `outcome` | `generated`, `approved`, `rejected`, `regenerated`, `error` |

**Exactness by mode.** The server can only be exact when it makes the call itself:

| `llm.mode` | Tokens | Model | Cost |
|---|---|---|---|
| `api-key`, `local` | Exact (provider usage field) | Known | Exact for API, zero or "local compute" for local |
| `vscode-lm` | Estimated (the API does not return usage) | Known (the extension reports the model id it was given) | Estimated, may be `n/a` for subscription models |
| `agent` | Output estimated from the text sent to `save_summary`; input estimated from what `list_undocumented` returned | **Reported by the agent**: `save_summary` takes a required `model` argument | Estimated, because the server never sees the agent's real request. Marked `estimated` everywhere it is shown |

**Price table.** Prices change, so they are never hard-coded. `.brain/config.json` holds a `pricing` map (`model → {input_per_mtok, output_per_mtok, cached_per_mtok}`) that ships with defaults and can be edited in Settings. A model with no entry shows tokens only and is flagged "no price set".

**Estimate before running.** *Brain: Generate Docs* opens a dialog first. The server (`brain_admin_estimate_generation`) counts the code that would be sent for the chosen scope, assumes an average output length per level, applies the price table and returns a range per model, e.g. `~412 symbols · ~1.9M input / ~210K output tokens · $X–$Y with <model>`. The user can change scope, granularity or model and see the number update. A configurable **budget cap** (`docs.maxCostUsd`) stops a job when its running total reaches the cap and asks whether to continue.

**Reporting in the extension**
- **Cost & Models view** (webview): spend by day, by model, by job and by module; tokens in/out; share of calls estimated vs exact; cost per approved doc; number of regenerations (a high number points to a poor prompt or model).
- **Per-doc provenance:** hover or the review queue shows `model`, `tokens`, `cost` for each draft, and the same values are written into the doc's front matter (`model`, `cost_usd`, `tokens_in`, `tokens_out`).
- **Status bar tooltip:** running total for the current job.
- **Export:** *Brain: Export Cost Report* writes `.brain/reports/cost-<date>.csv` and `.md` (gitignored by default; commit them if the team wants an audit trail).

Resources: `brain://cost/summary`, `brain://cost/calls`. Admin tools: `brain_admin_estimate_generation`, `brain_admin_set_budget`.

### 4.4 Feedback that agents actually used the brain

**What can and cannot be known.** The server sees every MCP call made to it, so it can prove *the agent asked the brain a question and what the brain returned*. It cannot see the agent's own outgoing LLM request, so it cannot prove the returned text ended up in the prompt, or that the model relied on it. The feedback is therefore built from what is observable, in three levels of confidence:

| Level | Signal | How | Confidence |
|---|---|---|---|
| **1. Brain was called** | Each MCP tool call is logged with client name (from the MCP `initialize` handshake, e.g. Claude Code, Copilot), session id, tool, arguments, result size, latency | Server-side log | High: it happened |
| **2. Brain output was used** | The agent's next steps touch what the brain returned: it opens a file or symbol the brain pointed at, or calls `save_summary`/`add_note` | Server correlates a brain result with a following call from the same session (e.g. `get_symbol(X)` then a read of `X`'s file), within a time window | Medium: strong hint, not proof |
| **3. Request left with brain context** | Optional hooks in clients that support them (Claude Code `PreToolUse` / `PostToolUse` / `UserPromptSubmit` hooks; Copilot instructions) call `brain report-usage` so the server learns what the agent did next and can mark "brain context was in this turn" | Opt-in snippet installed by *Brain: Install Usage Hooks* | Medium to high, only for clients with hooks |

The extension must label which level a line is at. It does not claim "the LLM used the brain" from level 1 alone.

**What the user sees in VS Code**
- **Live indicator in the status bar:** when an agent calls the brain, the item pulses and shows `Brain ◉ Claude Code · get_symbol`. Click it for the activity panel.
- **Agent Activity panel** (timeline, newest first), each row: time, client, session, tool, query, result size (tokens), latency, a confidence badge (1/2/3), and whether the result was followed by use of what it returned. Click a row to see exactly what the brain returned.
- **Per-session summary:** "In this session Claude Code made 14 brain calls (≈6.2K tokens returned), then opened 9 of the 11 files the brain pointed to, and ran 3 greps." Next to it, a hint when the agent never called the brain at all: "This session did not use the brain".
- **Notification option:** `brain.notifyOnAgentUse` shows a short toast the first time per session an agent uses the brain, so the user knows it is wired up. Off by default after the first run.
- **Rate the answer:** each row has thumbs up/down, which feeds the retrieval benchmark (PLAN.md §8).
- **Estimated saving (clearly marked as an estimate):** tokens the brain returned versus the tokens of the files it replaced (size of the files a normal search would have read). This is not a measured saving, and the A/B benchmark in PLAN.md §8 remains the real measurement.
- **Setup check:** *Brain: Check Agent Connection* lists every client config found (Copilot registration, `.mcp.json`, Cursor) and tests that each can reach the server, so "the agent never called the brain" can be told apart from "the agent is not connected".

**Data and privacy.** The activity log stores tool names, argument text, result sizes and the client name, in `.brain/.cache/` (gitignored). It does not store the agent's prompts or model output, because the server never receives them. Retention is configurable (`usage.retentionDays`, default 30). Resources: `brain://usage`, `brain://usage/sessions`.

### 4.5 Commands

`Brain: Open Settings`, `Brain: Start Server`, `Brain: Stop Server`, `Brain: Reindex Workspace`, `Brain: Generate Docs for Module…`, `Brain: Open Review Queue`, `Brain: Open Output Folder`, `Brain: Add Note`, `Brain: Estimate Generation Cost`, `Brain: Export Cost Report`, `Brain: Check Agent Connection`, `Brain: Install Usage Hooks`, `Brain: Copy MCP Config for Claude Code`, `Brain: Copy MCP Config for Cursor`, `Brain: Show Server Logs`.

### 4.6 Making agents find the server

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
    ├── graph/                   # derived dependency graph      [commit optional, see §5.1]
    │   ├── context.jsonld       #   JSON-LD @context (vocabulary), versioned
    │   └── brain.jsonld         #   the whole graph, deterministic key order
    ├── feedback/                # review notes and ratings     [commit, optional]
    │   └── feedback.jsonl
    ├── reports/                 # exported cost + usage reports [gitignored by default]
    │   ├── cost-<date>.csv
    │   └── cost-<date>.md
    ├── site/                    # static markdown/HTML export  [gitignored]
    ├── .cache/                  #                              [gitignored]
    │   ├── brain.db             #   SQLite: graph, FTS, embeddings, llm_call, usage log
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
  tokens_in: 1840                    # see §4.3; estimated in agent / vscode-lm modes
  tokens_out: 260
  cost_usd: 0.0123
  tokens_source: provider-reported   # or estimated
  reviewed_by: <git user name>
  reviewed_at: 2026-11-16
  # typed relations, written as Obsidian links (see §5.1)
  part_of: "[[docs/modules/src/auth/index]]"
  depends_on:
    - "[[docs/files/src/db/pool.ts]]"
    - "[[docs/files/src/crypto/token.ts]]"
  see_also:
    - "[[notes/decisions/0007-session-storage]]"
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
  - Usage level 1 (§4.4): log every MCP call by client and session, live status bar indicator, basic Agent Activity list. Cheap and gives the "did the agent call the brain" answer early.
  - `llm_call` table and the model/tokens fields in doc front matter.
- **Phase 2 — review, feedback and cost:** drafts → docs promotion, Review queue, CodeLens for stale docs, feedback storage and use in regeneration, coverage dashboard, HTTP daemon mode with token. Cost calculator: price table, pre-run estimate, budget cap, Cost & Models view, report export.
- **Phase 3 — depth:** usage levels 2 and 3 (follow-up correlation, client hooks, per-session summary, estimated saving), Check Agent Connection, optional language-provider edge feeder, `vscode-lm` mode, docs site export, SCIP import.
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
- **Cost accuracy in `agent` mode:** accept estimated numbers (recommended, always labelled), or require agents to report their real usage in `save_summary` (more accurate, but most clients cannot supply it).
- **Price table maintenance:** ship defaults and let users edit (recommended), or fetch from a pricing source on demand. Fetching adds a network dependency and a trust question.
- **Usage hooks:** which clients to support in Phase 3 (Claude Code first, since it has hooks), and whether hook installation should be one click or a copy-paste snippet.
- **Usage log retention and sharing:** local only (recommended) vs an opt-in team report. A team report would expose queries, so it needs explicit consent.
