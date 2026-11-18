# app-brain VS Code extension: plan (thin client over a local MCP server)

Companion to [PLAN.md](PLAN.md). That plan describes the whole system. This one narrows the scope and moves the boundary: **the local MCP server does all the work, and the VS Code extension is a front end for configuring it and seeing what it is doing.**

Status: **built through Phase 2 (and some of Phase 3).** The sections below are the design as it was written; where the build differs from it, §13 says so, and it also lists what is built, what is not, and what comes next.

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

- **Reads** use MCP **resources**: `brain://status`, `brain://config`, `brain://coverage`, `brain://knowledge/pending-review`, `brain://usage`.
- **Actions** use MCP **tools** prefixed `brain_admin_` (reindex, generate docs, approve a summary, save config, submit feedback). Agents are told not to use these. They are hidden from the default agent tool list, and the server exposes them only to clients that connect as the extension (see §8).
- **Live updates** use MCP **notifications**: `notifications/progress` for long jobs (indexing, doc generation) and `notifications/resources/updated` so views refresh without polling.

### Transport: two options

| Option | How | Pro | Con |
|---|---|---|---|
| **A. stdio, one process per client** | The extension spawns its own `brain-mcp`. Claude Code and others spawn theirs. All share `.brain/.cache/brain.db` (SQLite WAL). | Simple. Matches how every MCP client already works. | Several server processes per workspace. Each one must coordinate writes. The extension cannot see what another client's server is doing. |
| **B. one local daemon, HTTP on `127.0.0.1`** | The extension starts (or attaches to) a single `brain-mcp` per workspace and publishes its URL. Agents connect to the same URL. | One indexer, one writer, and the extension sees agent usage live. | Needs a port, a token and a lock file. Not every client supports HTTP MCP yet. |

**Recommendation (built):** support both. **B is the default in VS Code**, and **A** remains for terminal use without VS Code. When a stdio server starts and finds a live daemon it proxies to it instead of indexing a second time. How it works, and where it differs from the first draft of this plan:

- **Agents keep a stable config.** Claude Code, Cursor and Copilot still run `brain-mcp` as a stdio command, with no token and no port in any file. If a daemon is live, that process becomes a thin proxy to it; if not, it runs on its own as before. (Pointing an agent straight at the HTTP URL would put a token that changes at every start into a config file that is often committed.)
- **One lock, one daemon.** `brain-mcp --daemon` takes a lock and refuses to start twice; a crashed daemon's leftovers are detected (dead pid, failed health check) and replaced.
- **Runtime files are outside the workspace.** `server.json` and the lock live in a per-user directory (`~/.cache/app-brain/run/<workspace-hash>/` on Linux, the platform equivalents elsewhere), not in `.brain/.cache/`. Writing `.brain/` before the user runs "Initialise" would break the promise that nothing is written until then.
- **Two tokens, and only one of them is in a file.** `server.json` (mode `0600`) holds an *agent token* only. Anything running as you can read that file, so the *admin token* is never in it: the extension keeps it in VS Code secret storage and gives it to the daemon on stdin. The same goes for the LLM API key. Neither is in the command line or the environment, so neither is visible in `ps` or `/proc/<pid>/environ`.
- **Sessions, not a single connection.** Each client gets its own MCP session (own admin flag, own subscriptions, own client name for the usage log) over one shared core. A client that disappears without the protocol's DELETE is dropped when its notification stream has stayed closed for a grace period.
- **Lifecycle.** The extension attaches to a live daemon or spawns a detached one; replaces it if the LLM settings or key changed (they travel only at start-up); stops it when it closes if it was the only client, and leaves it running for agents or another window otherwise. The daemon also exits by itself after ten minutes with nobody connected.
- **Fallback.** If the daemon cannot start, the extension uses a private stdio server for that window and says why.

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
| Review state | Writes OKF `status` / `verified` / `generated`, derives the trust tier (unverified, machine-confirmed, human-reviewed) and computes staleness | Collects the human decision |
| Feedback | Stores and uses it | Collects it |
| OKF bundle and graph | Writes concepts, `index.md`, `log.md`; builds the dependency graph from links and code edges; validates | Displays the graph and health checks, never edits the bundle directly |
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
| `llm.mode` | personal | `auto` | `auto` (editor language model if available, else the connected agent), `vscode-lm`, `agent` (a connected MCP agent writes docs), `api-key`, `local` |
| `server.transport` | personal | `http` | `http` (daemon) or `stdio` |
| `server.command` | personal | bundled | Path to the `brain-mcp` entry point, for development |
| `commitKnowledge` | team config | `true` | Whether `.brain/knowledge` (the OKF bundle) is meant to be committed (affects the generated `.gitignore`) |

### 4.2 Visualisation and feedback

| Surface | Shows | Data source |
|---|---|---|
| **Status bar item** | `Brain: ready · 2,314 symbols · 41 stale`, spinner while working, red on error | `brain://status` |
| **Brain view** (activity bar) | Tree: Modules → files → symbols, each with a trust icon (unverified / machine-confirmed / human-reviewed, plus stale and none) | `brain://coverage`, `get_overview` |
| **Review queue** | Pending summaries with a side-by-side diff of code and doc. Actions: Approve, Edit, Reject, Regenerate | `brain://knowledge/pending-review`, `brain_admin_review_summary` |
| **Dependency Graph** (webview) | Interactive graph of concepts: nodes coloured by trust tier, stale ones outlined, edges for links and `depends_on`; click to open the file, filter by module, show impact of a change. Side panel lists broken links, orphans and cycles | `get_graph`, `brain://graph/health` |
| **Coverage dashboard** (webview) | Percent documented by module, stale count over time, index freshness, top undocumented central symbols | `brain://coverage` |
| **Agent activity** (webview) | Which tools agents called, with what query, what came back, latency, tokens, confidence badge, per-session summary (§4.4) | `brain://usage` |
| **Cost & Models** (webview) | Spend and tokens by day, model, job and module; exact vs estimated share; pre-run estimate (§4.3) | `brain://cost/summary` |
| **Stale-doc CodeLens** | "Doc is stale, regenerate?" above symbols whose `body_hash` changed | `brain://coverage` for the open file |
| **Hover** | Summary and review status on hover over a symbol | `get_symbol` |
| **Feedback buttons** | Thumbs up / down and a note on any summary or on a logged agent answer | `brain_admin_submit_feedback` |
| **Output channel** | Server logs | server stderr or log file |

*Status of this table:* built are the status bar item, the Review Queue (a tree of pending drafts: open, approve, reject, and approve or reject many at once), the Dependency Graph, Cost & Models, Agent Activity (a view and a status bar flash) and the output channel. Not built: the Brain tree view, the coverage dashboard, the side-by-side diff, editing and regenerating inside the queue, the stale-doc CodeLens, hover, and feedback buttons. Coverage and staleness are available as data (`brain://coverage`) and show in the status bar and the graph.

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
- **Per-doc provenance:** hover or the review queue shows `model`, `tokens`, `cost` for each draft, and the same values are written into the concept's front matter under `brain.llm` (`model`, `cost_usd`, `tokens_in`, `tokens_out`).
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

`Brain: Open Settings`, `Brain: Start Server`, `Brain: Stop Server`, `Brain: Reindex Workspace`, `Brain: Generate Docs for Module…`, `Brain: Open Review Queue`, `Brain: Open Output Folder`, `Brain: Show Dependency Graph`, `Brain: Validate Knowledge Bundle`, `Brain: Open Bundle in Obsidian`, `Brain: Export Graph (JSON-LD)`, `Brain: Add Note`, `Brain: Estimate Generation Cost`, `Brain: Export Cost Report`, `Brain: Check Agent Connection`, `Brain: Install Usage Hooks`, `Brain: Copy MCP Config for Claude Code`, `Brain: Copy MCP Config for Cursor`, `Brain: Show Server Logs`.

### 4.6 Making agents find the server

- **Copilot in VS Code:** register the server with `mcpServerDefinitionProviders` so it needs no manual setup.
- **Claude Code, Cursor and others:** the "Copy MCP Config" commands write or show the snippet (`.mcp.json` or the client's equivalent) pointing at the same server.

---

## 5. Where the output goes, and the file format (OKF)

All output lives under **one root folder at the workspace root: `.brain/`**. It is configurable with `outputDir`, and the path is relative to the workspace root. In a multi-root workspace each folder gets its own `.brain/`.

**Format: the brain files are an [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) v0.2 bundle.** OKF is Google Cloud's open spec for knowledge that people and AI agents both read: a directory of Markdown files with YAML front matter, where Markdown links between files form the graph. It needs no schema registry and no tooling, so any tool that reads Markdown (including Obsidian and any OKF-aware agent) can read the brain. The dependency graph comes straight from those links plus a typed `depends_on` list (§5.2). Note: OKF is young (v0.1 in June 2026, v0.2 since), single-vendor and still a draft, so the plan pins `okf_version: "0.2"` and keeps all brain-specific data in one namespaced front matter key, so a later spec change touches little.

```
<workspace>/
└── .brain/
    ├── config.json              # team config                          [commit]
    ├── knowledge/               # THE OKF BUNDLE: reviewed knowledge   [commit]
    │   ├── index.md             #   root index, carries okf_version: "0.2"
    │   ├── log.md               #   update history, newest first (server appends)
    │   ├── architecture.md      #   top-level overview
    │   ├── modules/
    │   │   └── <path>.md        #   one concept per directory / module (index.md is reserved)
    │   ├── files/
    │   │   └── <path>.md        #   one concept per source file (granularity ≥ file)
    │   ├── notes/               #   curated human knowledge
    │   │   ├── decisions/       #     why we did X
    │   │   ├── conventions.md
    │   │   └── gotchas.md
    │   └── references/          #   external material the docs cite
    ├── drafts/                  # generated, not yet reviewed          [gitignored]
    │   └── (same layout as knowledge/)
    ├── graph/
    │   └── graph.jsonld         # derived JSON-LD export of the graph  [gitignored, optional]
    ├── feedback/                # review notes and ratings             [commit, optional]
    │   └── feedback.jsonl
    ├── reports/                 # exported cost + usage reports        [gitignored by default]
    │   ├── cost-<date>.csv
    │   └── cost-<date>.md
    ├── site/                    # static markdown/HTML export          [gitignored]
    ├── .cache/                  #                                      [gitignored]
    │   ├── brain.db             #   SQLite: graph, FTS, embeddings, llm_call, usage log
    │   ├── (server.json and the daemon lock are in a per-user runtime directory, not here; see §2)
    │   └── logs/
    └── .gitignore               # written by the server, covers the ignored paths above
```

### 5.1 OKF rules the brain follows

- **A concept is one Markdown file.** Its concept ID is its path inside `knowledge/` without `.md` (e.g. `files/src/auth/session.ts`). `index.md` and `log.md` are reserved names, so no concept uses them for content. A module's concept is therefore `modules/<path>.md` (e.g. `modules/src/auth.md`), and each directory's own `index.md` is the generated listing.
- **Only `type` is required**, and the brain always sets `title` and `description` too (the index generator uses `description`). Types used: `Brain Architecture`, `Brain Module`, `Brain File`, `Brain Decision`, `Brain Convention`, `Brain Gotcha`, `Brain Note`. Types are free strings in OKF, so other tools simply treat them as generic concepts.
- **Links are standard Markdown links, relative to the file that holds them**: `[session store](../auth/session.ts.md)`. The first plan used bundle-absolute links (`/files/src/auth/session.ts.md`), which OKF recommends, but an editor or a Markdown preview takes a leading slash to mean the workspace root, so those links did not open from VS Code. OKF §6.1 allows relative links as well, so the server writes relative ones (percent-encoded where a name has spaces or brackets). Front matter values such as `depends_on` are data, not links, and stay bundle-absolute. A symbol inside a file is addressed by heading anchor: `../auth/session.ts.md#sessionstoreget`. Symbols are headings in their file's concept, not files of their own.
- **Broken links are allowed**, as OKF says (they can stand for knowledge not yet written). The extension shows them as information, not errors.
- **Unknown keys are preserved**, so humans can add front matter and the server must not drop it on rewrite.
- **Provenance (`sources`).** Each generated concept lists the code it was derived from, with an `id` so the body can cite it with a footnote.
- **Trust and lifecycle use the OKF fields**, instead of a private status flag:

  | OKF field | Brain use |
  |---|---|
  | `generated: {by, at}` | Who wrote the current text. `by` is `brain-mcp/<version>`, or the agent in `agent` mode. `at` is the last content change |
  | `verified: {by, at}` | Written when a person approves in the extension: `by: human:<git user>`. A bare `verified` with no `human:` actor means machine-confirmed |
  | `status` | `draft` for anything in `drafts/`, `stable` after approval, `deprecated` for removed code |
  | `stale_after` | Optional, time-based: used for notes with a review date, not for code-driven staleness |

  **Trust tiers are derived, never stored** (OKF rule): no `verified` → *unverified*; only non-human actors → *machine-confirmed*; any `human:` actor → *human-reviewed*. The MCP tools return the tier, so an agent knows how far to trust a doc, as the original plan required.
- **Code-driven staleness is computed, not written.** The file stores `brain.built_from_hash` (below). The server compares it with the current code hash and reports `stale` in tools and views. Writing a stale marker into committed files on every code change would create constant diff noise.
- **Reserved files:** `index.md` (progressive-disclosure listing, headed sections with bulleted links and one-line descriptions, generated by the server) and `log.md` (date-grouped entries, newest first: *Creation*, *Update*, *Deprecation*). The root `index.md` is the only index with front matter.
- **Attested Computations (OKF §9) are not used.** The brain records no computed values.

**Example concept** (`knowledge/files/src/auth/session.ts.md`):

```markdown
---
type: Brain File
title: src/auth/session.ts
description: Session creation, lookup and expiry for authenticated users.
resource: https://github.com/<org>/<repo>/blob/9f2c1e/src/auth/session.ts
tags: [auth, session]
generated: { by: brain-mcp/0.1.0, at: 2026-11-16T10:00:00+00:00 }
verified: { by: human:jdoe, at: 2026-11-16T11:30:00+00:00 }
status: stable
sources:
  - id: code
    resource: https://github.com/<org>/<repo>/blob/9f2c1e/src/auth/session.ts
    last_modified: 2026-11-14T08:12:00+00:00
brain:                                  # everything brain-specific lives under one key
  target: src/auth/session.ts
  kind: file                            # symbol | file | module | architecture
  built_from_hash: 9f2c1e…              # hash of the code this doc describes
  part_of: /modules/src/auth.md
  depends_on:                           # typed, from the code graph (§5.2)
    - /files/src/db/pool.ts.md
    - /files/src/crypto/token.ts.md
  llm:                                  # see §4.3 (estimated in agent / vscode-lm modes)
    model: claude-…
    mode: api-key
    tokens_in: 1840
    tokens_out: 260
    cost_usd: 0.0123
    tokens_source: provider-reported    # or estimated
---

# Summary

Creates and validates user sessions, backed by [the connection pool](../db/pool.ts.md)
and signed with [token helpers](../crypto/token.ts.md).[^code]

# SessionStore.get

Looks up a session by id and rejects expired ones. Why sessions are stored server-side:
[decision 0007](../../../notes/decisions/0007-session-storage.md).

<!-- brain:auto:start dependencies -->
# Dependencies

- Depends on: [pool.ts](../db/pool.ts.md), [token.ts](../crypto/token.ts.md)
- Used by: [login handler](../http/login.ts.md)
<!-- brain:auto:end -->

[^code]: src/auth/session.ts
```

The block between the `brain:auto` markers is rewritten by the server from the graph so the Markdown links always match `brain.depends_on`; text outside the markers is human-owned and never touched.

### 5.2 Dependency graph

The graph is the point of choosing OKF, so its construction is explicit.

- **Nodes:** every concept in `knowledge/`, plus, optionally, the code symbols they describe.
- **Edges, two kinds:**
  1. **Untyped links:** every Markdown link in a concept body. These are the OKF edges, and they are what any other OKF tool sees.
  2. **Typed edges:** `brain.part_of` and `brain.depends_on` (and `implements` / `extends` where the code graph has them), generated by the server from tree-sitter / LSP / SCIP edges (PLAN.md §4) and rolled up from symbols to files to modules: file A depends on file B if any symbol in A imports, calls or extends something in B.
- **Provenance and confidence stay in the database, not in the files.** Each typed edge records how it was found (`treesitter`, `lsp`, `scip`, or `human-link`) and whether it is a name-match guess or resolved. Putting that in front matter would make every file noisy. The tools return it, and the JSON-LD export includes it.
- **Direction:** `depends_on` is stored one way; "used by" is derived by the server from the reverse edges, so there is nothing to keep in sync by hand.
- **Rebuild:** the graph is rebuilt from the Markdown in `knowledge/` plus the code index. Deleting `.cache/` loses nothing that is not recomputed.
- **What it enables:** `get_neighbors`, `impact_of_change` (transitive reverse-dependency walk) and staleness propagation (a changed file marks the concepts that depend on it as *possibly affected*, not stale, because their own code did not change) all run on this graph.
- **JSON-LD export (optional):** `graph/graph.jsonld` is a generated export for tools that want typed, linked data rather than Markdown. Nodes are `@id: brain:<concept-id>` with `@type` from the OKF `type`; edges are `brain:dependsOn`, `brain:partOf`, `brain:linksTo`, each with `source` and `confidence`. It is derived, so it is gitignored by default and is not a second source of truth.
- **Checks the server runs (`brain validate`, and on every write):** OKF conformance (every non-reserved `.md` parses and has a non-empty `type`), and graph health: broken links (information), orphan concepts with no inbound link, dependency cycles between modules (warning), and `brain.depends_on` entries pointing at concepts that do not exist.

### 5.3 Rules

- **Everything under `knowledge/` and `config.json` is plain Markdown or JSON, human-readable, and the source of truth.** `.cache/` and `graph/` can be deleted at any time and rebuilt.
- **Drafts vs reviewed.** The server writes every generated concept to `drafts/` first, with `status: draft` and no `verified`. **Approving in the extension moves it to `knowledge/`, sets `status: stable` and adds `verified: {by: human:<git user>, at}`.** "Generated, unreviewed" is a physical location, so a PR only contains reviewed docs. Links in drafts already point to the final `/…` bundle paths, so they do not change on approval. Regenerating a doc whose code changed writes a new draft and leaves the reviewed one in place (reported stale) until the new one is approved.
- **The extension never writes into `knowledge/` itself.** Edits and approvals go through `brain_admin_review_summary`, so the server can update its tables, `index.md` and `log.md` and keep file and database consistent. The one exception is `knowledge/notes/`: **Brain: Add Note** can create a file there directly (with front matter `type: Brain Note`), and the server's file watcher picks it up and adds it to the graph.
- **Obsidian and other readers.** `knowledge/` can be opened as an Obsidian vault as is, because OKF uses standard Markdown links. Obsidian's setting *Use [[Wikilinks]]* should be off and *New link format* set to "Absolute path in vault", so links the user adds match OKF. The brain does not generate wikilinks.
- **Per-user data stays out of the repo.** Logs and the daemon lock file are in `.cache/`. The extension's own global state (last-used workspace, UI layout) lives in VS Code's `globalStorageUri`.
- **Export for sharing.** `site/` is produced on demand (`Brain: Export Docs Site`) and is not committed by default. Because the bundle is plain OKF, the `knowledge/` folder itself can also be shared as is, as an archive or a repo subdirectory.

---

## 6. Server lifecycle (what the extension does on activation)

1. Find the workspace root and read `.brain/config.json` (absent → offer **Brain: Initialise**, which asks the server to create it with defaults and write `.brain/.gitignore`).
2. Resolve the server: bundled build, a user-set path, or `npx`-style install. Check its version against the extension's required protocol version. On mismatch, show a clear upgrade message and do not connect.
3. Read `server.json` from the per-user runtime directory (§2). If a live daemon exists (pid alive, authenticated health check passes, same LLM settings and output folder), attach. Otherwise replace or spawn one, handing it the admin token and any API key on stdin.
4. Connect as an MCP client, call `brain_admin_hello` to declare itself the extension and receive the admin tool set.
5. Subscribe to `brain://status` and `brain://coverage`; draw the status bar and views.
6. On a crash, restart with backoff (3 tries), then show an error in the status bar with a **Show Logs** action.
7. On deactivate, leave the daemon running only if other clients are attached; otherwise stop it.

**LLM modes.** In `agent` mode the server offers `list_undocumented` / `save_summary` to agents and the extension only displays progress. In `vscode-lm` mode the server asks the extension, over an MCP sampling-style request, to run the prompt through VS Code's `vscode.lm` API and return the text, because only the extension can reach that API. `api-key` and `local` modes run entirely in the server.


### 6.1 Configuring a local LLM

`local` mode runs doc generation on a model the user hosts (Ollama, LM Studio, llama.cpp's `llama-server`, or any server that speaks the OpenAI chat-completions protocol). It is the answer to "my code must not leave my machine" and to "I do not want a bill", but it fails in ways a paid API does not, so the design treats configuration as more than a URL and a model name.

**What the person configures** (VS Code settings, personal, never committed):

| Setting | Default | Why it exists |
|---|---|---|
| `brain.llm.mode` = `local` | `auto` | Selects the mode. By default, the extension detects the editor model or connected agent; choose `local` to use a model hosted by the user |
| `brain.llm.local.preset` | `ollama` | Fills in the server's usual address: Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, or `custom` |
| `brain.llm.baseUrl` | empty | Overrides the preset's address (a GPU box on the network, a non-default port) |
| `brain.llm.model` | required | The model id. **Brain: Choose Local Model** lists what the server actually has, so it is picked, not typed |
| `brain.llm.local.contextTokens` | 8192 | The context window the server runs the model with. See below |
| `brain.llm.local.maxOutputTokens` | 1500 | The most the model may write for one doc. Reasoning models need more |
| `brain.llm.local.timeoutSeconds` | 600 | Local models are slow, and the first request loads the model |

**The context window is the central problem.** Hosted models take hundreds of thousands of tokens. Local servers commonly run a model with 2 to 4K, and the OpenAI-compatible endpoint does not let a client change it. A prompt that is too long is then cut off *by the server, silently*, and the model writes confidently about a file it only half saw. So the generator never relies on the server:

- Every prompt is sized to `contextTokens`, leaving room for the answer (`maxOutputTokens`), the fixed part (rules, symbol list, relationships) and slack for tokenizers that need more tokens per character than our estimate.
- A source file too long for what is left is cut in the middle, and the doc records `input_truncated: true` in its front matter. A module's long file list is trimmed with a visible "(and N more not shown)". Nothing is cut without being said.
- A file that would get no usable amount of its code is **skipped and reported with the reason**, never sent as an empty shell. If nothing fits, or the window is below 2,048 tokens, generation does not start and says which setting to change.
- The estimate warns how many documents will be written from partial input and how many will be skipped, before the person confirms.
- The window setting only tells *us* what to do; the server must really run the model with that window. The test (below) and the settings text say so, with the Ollama specifics (`OLLAMA_CONTEXT_LENGTH`, or `PARAMETER num_ctx` in a Modelfile).

**"Local" is a URL, and a URL can point anywhere.** The interface must not say "nothing leaves this machine" for a URL that is not on it. The URL is classified (the whole address, not a prefix: `127.0.0.1.evil.com` is the internet):

| Where it points | What the confirmation says | Cost |
|---|---|---|
| This machine (`localhost`, `127.x`, `::1`) | "Runs on this machine; nothing leaves it." | Free |
| Your network (private ranges, `.local`, single-label names) | "Sends your source code to *host* on your network", with "unencrypted" for `http` | Free |
| The internet | "Sends your source code over the internet to *host*. This is not a local model." (`UNENCRYPTED` for `http`) | **Not assumed free**: priced from the price table like any paid API, and a budget cap cannot start without a price |

**Knowing it works, and why not.** **Brain: Test LLM Connection** runs a one-word request and, for a local server, asks it which models it has. It reports where the code goes, the latency, the token counts, and for every failure a cause and a next step: server not running (with the command to start the one the port suggests), model not pulled (listing what is there, matching Ollama's `:latest` naming), window too small, a URL on the network or internet, a reasoning model that spent its tiny test allowance thinking (not a broken connection). It costs nothing locally and a fraction of a cent on a paid API. The same checks run as a pre-flight when settings are obviously wrong (no model, `custom` without a URL, a window under the minimum).

**Boundaries.** Only the extension may test or list models (admin tools); an agent cannot probe the user's LLM. The API key, if a local gateway needs one, travels like any other secret (stdin to the daemon, never a file). Changing any of these settings replaces the shared daemon, because they are part of its start-up fingerprint.

**Open:** tool use, streaming and structured output are not used, so any chat-completions server works; but quality varies a great deal by model, and the plan makes no claim about which local model is good enough. The cost report marks local calls as free and token counts as reported by the server when it reports usage, else estimated.

---

## 7. Implementation structure

```
packages/
  brain-protocol/   # shared TypeScript types + zod schemas for admin tools, resources, config,
                    # the daemon's server.json and the provider-usage report (single source of truth)
  brain-mcp/        # the server, with the core in it: tree-sitter parsing, SQLite store, OKF bundle,
                    # doc generation, cost, the shared HTTP daemon and the stdio proxy; entry point cli.js
  brain-vscode/     # the extension: MCP client, views, webviews, commands, provider-usage readers
scripts/            # build-and-install.sh (package and install the .vsix), screenshots.js
.github/workflows/  # ci.yml (tests on Linux, macOS, Windows), publish.yml (Marketplace)
```

(The first plan also had a separate `brain-core` library and a `brain-cli` package. The core stayed inside `brain-mcp`, since nothing else uses it yet, and the CLI is `brain-mcp`'s own entry point. Splitting them out is only worth doing when a second consumer exists.)

`brain-protocol` is what keeps the two halves in step: both import the same types, and the extension's settings form is generated from the server's schema. TypeScript throughout, as PLAN.md recommends, so the VS Code extension and the server share one language.

---

## 8. Security and privacy

- **HTTP transport binds to `127.0.0.1` only** and requires a random bearer token generated at daemon start, stored in `server.json` (mode `0600`, in a per-user directory outside the workspace). No token, no connection. A request must also carry our own `Host` (a defence against DNS rebinding), must come from a loopback peer, and must not carry an `Origin` header: a web page is never a client. Bodies are capped at 4 MB and sessions at 64.
- **The token in `server.json` is the agent token.** It lets a client call the read-only tools and nothing else. Anything running as the same user can read it, which is accepted: it grants no more than reading the code would.
- **The admin token and the API key are never in a file, the environment or the command line.** They are passed on stdin and held in memory. The limit of this: an agent that is itself malicious, running as you with a shell, can still read another process's memory. The design stops accidents and prompt-injected tools, not a hostile process that already is you.
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

  **Recommendation:** MVP uses tree-sitter only (name-matched edges, flagged low confidence). Phase 2 adds option 3 as an opt-in, Phase 3 adds option 1. *Status: only the tree-sitter step is built; neither option is, see §13.*
- **File watching is duplicated** if the server and VS Code both watch. Acceptable: only the server does it, and the extension just displays the result.
- **The extension is fully replaceable.** A different front end (a web UI, a JetBrains plugin) can be built against the same admin tools without changing the server. This is the main benefit of the split.

---

## 10. Roadmap

Marks: **done**, **partly**, **not yet**. §13 has the detail.

- **Phase 0 — protocol spike: done.** `brain-protocol` types, a minimal `brain-mcp`, an extension that spawns it and shows the status bar item.
- **Phase 1 — MVP: done, except the items marked.**
  - Server: tree-sitter index for TypeScript, TSX, JavaScript and Python (done), `search_code`, `get_symbol` (done), `.brain/` layout creation, status and coverage resources, progress notifications (done).
  - Extension: activation and lifecycle, Settings webview from the server schema, status bar, Output Folder command, Copy MCP Config, `mcpServerDefinitionProviders` registration (done). **Brain tree view (modules, files, symbols): not yet.**
  - Usage level 1 (§4.4): every MCP call logged by client, live status bar flash, Agent Activity list (done).
  - `llm_call` table and the `brain.llm` fields in concept front matter (done).
  - OKF bundle: `knowledge/` layout, `index.md` with `okf_version`, `log.md`, front matter, validation (done).
  - Graph: Markdown links and `brain.depends_on` from tree-sitter edges, `get_neighbors` and `impact_of_change` (done). **`.brain/` notes (`add_note`, `read_notes`) and an LSP bridge: not yet.**
- **Phase 2 — review, feedback and cost: done, except the items marked.** Drafts to `knowledge/` promotion with `status` and `verified`, the Review Queue, feedback storage used in regeneration, the Dependency Graph view and graph-health checks, the HTTP daemon with a token, and the cost calculator (price table, estimate, budget cap, Cost & Models view, report export) are done. **CodeLens for stale docs, the coverage dashboard, and diff and edit inside the Review Queue: not yet.** Added beyond the plan: server-side doc generation, approving many drafts at once, and provider usage (§13).
- **Phase 3 — depth: partly.** Done: `vscode-lm` mode (and `api-key`, and `local` models), JSON-LD graph export. Not yet: usage levels 2 and 3, Check Agent Connection, the language-provider edge feeder, SCIP import, docs site export.
- **Phase 4:** team features (shared config conventions, multi-root workspaces, CI integration): not yet. CI for this repository exists (§11), which is a different thing.

---

## 11. Testing

- **Protocol tests:** the server and extension are both tested against `brain-protocol` schemas, so drift fails the build.
- **OKF and graph:** conformance tests on a fixture bundle (every concept parses and has `type`; reserved filenames respected; unknown keys survive a rewrite; a bare `verified` mapping reads as a one-element list), round-trip of the `brain:auto` block, trust-tier derivation, and graph tests (cycle detection, rollup from symbol edges to file edges, impact walk).
- **Server:** unit and integration tests with fixture repos, no VS Code needed. This is where most tests live, because most logic lives here.
- **Extension:** `@vscode/test-electron` smoke tests (activate, connect to a stub MCP server, render the tree), plus webview tests with the server stubbed.
- **End-to-end:** a script that starts the daemon on a fixture repo, drives it through the extension's commands, and checks the files created under `.brain/`.
- **Does it help agents:** the task and retrieval benchmarks from PLAN.md §8, run against the server alone. *Not built yet.*
- **What exists:** about 390 tests (server and extension, no VS Code needed) run on Linux, macOS and Windows in CI on every pull request. The webviews are tested in a real Chromium against data from the real server. `@vscode/test-electron` smoke tests are not set up: nothing here has been run inside a real VS Code window by a test.

---

## 12. Decisions

**Decided during the build**

- **Default transport:** the HTTP daemon, one per workspace on loopback; a stdio config quietly becomes a proxy to it; `--no-proxy` opts out.
- **Admin-tool separation:** the same server, with `brain_admin_*` tools gated by an admin token that only the extension has (passed on stdin).
- **Drafts location:** a physical `.brain/drafts/` folder, so unreviewed text stays out of the bundle.
- **OKF maturity:** v0.2 pinned; brain data under the `brain:` key; links relative (§5.1).
- **Native SQLite packaging:** neither `better-sqlite3` nor an extension: the server uses Node's built-in `node:sqlite` with FTS5, which needs Node 22.16 or newer (22.13 to 22.15 ship it without FTS5; the server says so when it starts).
- **Server distribution:** bundled in the `.vsix`, with its production dependencies (about 9 MB).
- **First languages:** TypeScript (with TSX and JavaScript) and Python.
- **Cost accuracy in `agent` mode:** estimates are accepted and always labelled; agents may report real counts.
- **Price table:** edited by the user, no shipped defaults; a model without a price makes totals a lower bound, and the report says so.
- **LLM path:** all four exist (`agent`, `vscode-lm`, `api-key`, `local`) plus `auto`, which never picks `local` or an API key on its own.
- **Resource URIs for code:** a path relative to the concept file.

**Still open**

- **Typed edges in front matter:** OKF links are untyped, so `brain.depends_on` / `part_of` are a brain extension. Decide whether to propose typed relations upstream or keep them private.
- **Commit generated docs by default?** Recommended: commit only reviewed docs. Needs agreement from the team.
- **Usage hooks:** which clients to support in Phase 3 (Claude Code first, since it has hooks), and whether hook installation should be one click or a copy-paste snippet.
- **Usage log retention and sharing:** local only (recommended) vs an opt-in team report. A team report would expose queries, so it needs explicit consent.

---

## 13. Where we are, and what comes next

### 13.1 What is built

| Area | State |
|---|---|
| **Index** | tree-sitter (WASM, `@vscode/tree-sitter-wasm`) for TypeScript, TSX, JavaScript, Python: symbols, signatures, docstrings, import edges. SQLite with FTS5. Incremental by mtime and content hash, with a file watcher. Secret files and everything in `.gitignore` are never indexed. |
| **Agent tools** (read-only) | `search_code`, `get_symbol`, `get_neighbors`, `impact_of_change`, `get_graph`, `get_overview`, `list_undocumented`, `save_summary`. Every call is logged by client, with tokens returned and latency. |
| **Knowledge base** | OKF v0.2 bundle under `.brain/knowledge/`. Agents write drafts to `.brain/drafts/`; a person approves or rejects them; approval sets `status: stable` and `verified`. `index.md` and `log.md` are generated, the Dependencies block is machine-owned, staleness is computed from a content hash, and `validate` checks conformance, broken links, orphans and cycles. Links are relative, so they open from an editor. |
| **Doc generation** | Written by the connected agent, or by the server: `api-key` (the Anthropic SDK), `vscode-lm` (the editor's model over MCP sampling), or `local` (Ollama, LM Studio, llama.cpp, any OpenAI-compatible server). Bottom-up, with an estimate before anything is spent, a budget cap, cancel, and reviewer notes fed into the next attempt. All output is a draft. |
| **Review** | The Review Queue; approve or reject several at once (select them, or **Approve Many Drafts**); documents approved in bulk are marked `approved_in_bulk`. Server-side, 1,000 approvals take about 3 seconds. |
| **Cost** | `llm_call` table, user-edited price table, exact versus estimated token counts, budget meter, Cost & Models view, CSV and Markdown export. |
| **Provider usage** | In Cost & Models, apart from the brain's own cost: Claude Code's local logs for this workspace (on by default; usage numbers only) and the Anthropic organisation through the Usage and Cost Admin API (off by default; needs an Admin API key). |
| **Dependency graph** | Modules or files, circular dependencies marked, each node coloured by documentation status and ringed by who reviewed it, with a side panel and keyboard access. JSON-LD export. |
| **Shared server** | One HTTP daemon per workspace on loopback with a bearer token; stdio configs become proxies to it; admin token and keys travel on stdin, never in a file, the environment or the command line; strict `Host`, `Origin` and peer checks; prompt-injection fencing and secret redaction for anything sent to a model. |
| **Extension** | Status bar, Review Queue, Settings form generated from the server's schema, Dependency Graph, Cost & Models, Agent Activity, symbol search, validation, exports, MCP config for Claude Code, registration with Copilot's agent mode, key commands, LLM connection test, local model picker. The icon is a single-colour SVG so VS Code can recolour it. |
| **Engineering** | GitHub Actions: tests on Linux, macOS and Windows for every pull request; merging a version change publishes to the Marketplace. Node 22.16 or newer. |

### 13.2 Not built yet

- **Notes and prompts:** `add_note`, `read_notes`, and the `/onboard` and `/document-module` prompts.
- **Better edges:** SCIP import. The LSP bridge is built (`lspBridge.ts`: call and type hierarchy from the editor's language servers, stored as `source: lsp` edges); without a language server, edges are tree-sitter name matches.
- **Search:** embeddings and combined semantic search.
- **Extension surfaces:** diff and edit inside the Review Queue, feedback buttons. Built: the Documentation Coverage view, CodeLens and hover for doc status, Check Agent Connection.
- **Usage levels 2 and 3** (§4.4): follow-up correlation, client hooks, per-session summary, estimated saving.
- **Provider usage for Cursor.** Its usage API is for team admins. Copilot is done: it is read from the workspace's `chatSessions/*.jsonl` (see `copilotLogs.ts`).
- **Automatic generation after indexing** (`docs.autoGenerate` is reserved and does nothing).
- **Outside the editor:** a CLI, the docs site export, SCIP in CI.
- **More languages**, large-repository housekeeping, multi-root workspaces.
- **The benchmarks** in PLAN.md §8: without them "makes agents better" is still a claim, not a measurement.
- **Checks in real conditions:** a session inside a real VS Code window, a real Anthropic Admin key, a real Ollama, and the Windows and macOS behaviour by hand. The tests cover the logic; they have not replaced these.

### 13.3 Next

In this order, because each step makes the next one safer:

1. **Use it for real, and fix what that shows.** Install the published extension, run it on a real repository, and walk through indexing, generating, reviewing and the cost view. Everything below is guesswork until this has happened.
2. **The review experience.** Diff and edit in the queue, CodeLens for stale docs, filters. Bulk approval made approving fast; the risk it creates is approving without reading, so the queue should make reading easier too.
3. **Measure whether it helps.** The task and retrieval benchmarks (PLAN.md §8) against the server alone.
4. **Notes and prompts**, then **better edges** (SCIP or an LSP feed). The server's own graph already shows a circular dependency between `brain-mcp/src`, `generate` and `okf`; breaking it is a good first use of the tool on itself.
5. **Provider usage for Copilot** (from its local logs, built against real files) and **Cursor** (admin API).
6. **Semantic search** once the benchmark says search quality is the limit.
7. **Usage levels 2 and 3, `autoGenerate`, the CLI and the site export**, then team features.

