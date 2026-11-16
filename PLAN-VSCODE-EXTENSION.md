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

- **Reads** use MCP **resources**: `brain://status`, `brain://config`, `brain://coverage`, `brain://knowledge/pending-review`, `brain://usage`.
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
| `llm.mode` | personal | `agent` | `agent` (the user's agent writes docs), `vscode-lm`, `api-key`, `local` |
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
    │   ├── server.json          #   {pid, port, token} for the running daemon
    │   └── logs/
    └── .gitignore               # written by the server, covers the ignored paths above
```

### 5.1 OKF rules the brain follows

- **A concept is one Markdown file.** Its concept ID is its path inside `knowledge/` without `.md` (e.g. `files/src/auth/session.ts`). `index.md` and `log.md` are reserved names, so no concept uses them for content. A module's concept is therefore `modules/<path>.md` (e.g. `modules/src/auth.md`), and each directory's own `index.md` is the generated listing.
- **Only `type` is required**, and the brain always sets `title` and `description` too (the index generator uses `description`). Types used: `Brain Architecture`, `Brain Module`, `Brain File`, `Brain Decision`, `Brain Convention`, `Brain Gotcha`, `Brain Note`. Types are free strings in OKF, so other tools simply treat them as generic concepts.
- **Links are standard Markdown links, bundle-absolute**, starting with `/`: `[session store](/files/src/auth/session.ts.md)`. Absolute links stay valid when a file moves within the bundle. A symbol inside a file is addressed by heading anchor: `/files/src/auth/session.ts.md#sessionstoreget`. Symbols are headings in their file's concept, not files of their own.
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

Creates and validates user sessions, backed by [the connection pool](/files/src/db/pool.ts.md)
and signed with [token helpers](/files/src/crypto/token.ts.md).[^code]

# SessionStore.get

Looks up a session by id and rejects expired ones. Why sessions are stored server-side:
[decision 0007](/notes/decisions/0007-session-storage.md).

<!-- brain:auto:start dependencies -->
# Dependencies

- Depends on: [pool.ts](/files/src/db/pool.ts.md), [token.ts](/files/src/crypto/token.ts.md)
- Used by: [login handler](/files/src/http/login.ts.md)
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
  - `llm_call` table and the `brain.llm` fields in concept front matter.
  - OKF bundle: `knowledge/` layout, `index.md` (with `okf_version`), `log.md`, concept front matter, `brain validate` for OKF conformance.
  - Graph: Markdown links and `brain.depends_on` from tree-sitter edges, `get_neighbors` and `impact_of_change` on it.
- **Phase 2 — review, feedback and cost:** drafts → `knowledge/` promotion (sets `status`, `verified`), Review queue, CodeLens for stale docs, feedback storage and use in regeneration, coverage dashboard, Dependency Graph view and graph-health checks (§4.2), HTTP daemon mode with token. Cost calculator: price table, pre-run estimate, budget cap, Cost & Models view, report export.
- **Phase 3 — depth:** usage levels 2 and 3 (follow-up correlation, client hooks, per-session summary, estimated saving), Check Agent Connection, optional language-provider edge feeder, `vscode-lm` mode, docs site export, JSON-LD graph export, SCIP import.
- **Phase 4:** team features: shared config conventions, multi-root workspaces, CI integration.

---

## 11. Testing

- **Protocol tests:** the server and extension are both tested against `brain-protocol` schemas, so drift fails the build.
- **OKF and graph:** conformance tests on a fixture bundle (every concept parses and has `type`; reserved filenames respected; unknown keys survive a rewrite; a bare `verified` mapping reads as a one-element list), round-trip of the `brain:auto` block, trust-tier derivation, and graph tests (cycle detection, rollup from symbol edges to file edges, impact walk).
- **Server:** unit and integration tests with fixture repos, no VS Code needed. This is where most tests live, because most logic lives here.
- **Extension:** `@vscode/test-electron` smoke tests (activate, connect to a stub MCP server, render the tree), plus webview tests with the server stubbed.
- **End-to-end:** a script that starts the daemon on a fixture repo, drives it through the extension's commands, and checks the files created under `.brain/`.
- **Does it help agents:** the task and retrieval benchmarks from PLAN.md §8, run against the server alone.

---

## 12. Open decisions

- **Default transport:** HTTP daemon (recommended) vs per-client stdio. Check which target clients support HTTP MCP before fixing it.
- **Admin-tool separation:** same server with a token-gated tool set (recommended) vs a second, extension-only endpoint.
- **Drafts location:** physical `drafts/` folder (recommended) vs OKF `status: draft` in the same `knowledge/` folder. The folder keeps unreviewed text out of PRs but duplicates the layout.
- **OKF maturity:** v0.2 is a Google Cloud draft and the spec has already had a breaking change (v0.1 → v0.2). Pin the version, keep brain data under the `brain:` key, and re-check the official spec (and its licence, which secondary sources report inconsistently) before Phase 1.
- **Typed edges in front matter:** OKF links are untyped, so `brain.depends_on` / `part_of` are a brain extension. Decide whether to propose typed relations upstream or keep them private.
- **Resource URIs for code:** permalink URL when a git remote exists (recommended, survives moves) vs a path relative to the concept file.
- **Commit generated docs by default?** Recommended: commit only reviewed docs. Needs agreement from the team.
- **Server distribution:** bundled with the VSIX (works offline, larger) vs installed on first run (smaller, needs network).
- **Native SQLite packaging:** the server is a separate Node process, so native `better-sqlite3` is usable there, which removes the Electron ABI problem from PLAN.md §3.
- **First two languages** for Phase 1.
- **Cost accuracy in `agent` mode:** accept estimated numbers (recommended, always labelled), or require agents to report their real usage in `save_summary` (more accurate, but most clients cannot supply it).
- **Price table maintenance:** ship defaults and let users edit (recommended), or fetch from a pricing source on demand. Fetching adds a network dependency and a trust question.
- **Usage hooks:** which clients to support in Phase 3 (Claude Code first, since it has hooks), and whether hook installation should be one click or a copy-paste snippet.
- **Usage log retention and sharing:** local only (recommended) vs an opt-in team report. A team report would expose queries, so it needs explicit consent.
