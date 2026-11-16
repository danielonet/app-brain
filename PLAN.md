# app-brain: plan and design

**Goal:** a VS Code extension, backed by an MCP server, that builds a "brain" for a codebase: a knowledge base and documentation generated from the code (plus curated human notes), so that AI agents (Copilot, Claude Code, Cursor, …) can do a better job on that codebase.

Status: design draft. Nothing is built yet.

---

## 1. Background: the building blocks

| Tool | What it is | Role in app-brain |
|---|---|---|
| **tree-sitter** | Incremental parser producing concrete syntax trees for many languages | Fast structural extraction: files, symbols, signatures, docstrings, chunk boundaries. Works on broken or half-written code. |
| **LSP** (Language Server Protocol) | Protocol between editors and language servers (pyright, typescript-language-server, gopls, rust-analyzer, …) | Semantic layer: resolved go-to-definition, find-references, types, call hierarchy, hover docs. |
| **SCIP** (and older **LSIF**) | Index formats that dump LSP-style data (definitions, references, symbols, hover docs) to a file | Headless, precise code graph for CI or when no editor is running. Easy to load into tables. |
| **MCP** (Model Context Protocol) | Protocol for giving AI clients tools, resources and prompts | How agents query the brain. |
| **LLM** | Any model the user has access to | Turns code and graph data into plain-language summaries. |

**Why tree-sitter is not enough on its own:** it can see that `foo()` is called, but not *which* `foo`. LSP / SCIP resolve that, which turns a name index into a real knowledge graph.

**Key leverage inside VS Code:** the extension does not need to run its own language servers. It can call VS Code's built-in commands, which use whatever language extensions the user already has installed:

- `vscode.executeDocumentSymbolProvider`
- `vscode.executeDefinitionProvider`
- `vscode.executeReferenceProvider`
- `vscode.executeHoverProvider`
- `vscode.prepareCallHierarchy` / `vscode.provideIncomingCalls` / `vscode.provideOutgoingCalls`
- `vscode.executeWorkspaceSymbolProvider`

This gives semantic coverage for every language the user already works in, without extra work.

---

## 2. Layers

| Layer | Tool | What it gives | When it runs |
|---|---|---|---|
| Syntax | tree-sitter | Files, symbols, signatures, docstrings, chunks | On every save (milliseconds) |
| Meaning | LSP via VS Code | Resolved definitions/references, types, call hierarchy, hover docs | Background or on demand, in the editor |
| Precise batch | SCIP indexers | Same resolved graph, headless | CI / CLI, no editor |
| Understanding | LLM | Summaries of symbols → files → modules → architecture | Background, prioritised |
| Serving | MCP | Tools, resources and prompts for any agent | Whenever an agent asks |

---

## 3. Architecture

```
┌──────────────── VS Code extension ────────────────┐
│ • Registers the MCP server (mcpServerDefinition-  │
│   Providers) so Copilot finds it automatically    │
│ • File watcher → incremental re-index             │
│ • LSP bridge: VS Code language providers → edges  │
│ • UI: Brain tree view, "stale doc" CodeLens,      │
│   "Document this module", review generated docs  │
└──────────────┬────────────────────────────────────┘
               │ (shared core library)
┌──────────────▼──────────┐     ┌────────────────────┐
│ brain-core (TypeScript) │◄────│ brain CLI (CI):    │
│ web-tree-sitter (WASM)  │     │ tree-sitter + SCIP │
│ SCIP importer           │     │ → index + docs     │
│ doc generator, search   │     └────────────────────┘
└──────────────┬──────────┘
        SQLite (WAL) + FTS5 + sqlite-vec   ← derived, rebuildable (gitignored)
        .brain/*.md                         ← curated knowledge (committed to git)
               │
┌──────────────▼──────────┐
│ brain-mcp (stdio)       │ ← Copilot / Claude Code / Cursor
│ Quick tree-sitter       │
│ refresh on start, so it │
│ also works without      │
│ VS Code                 │
└─────────────────────────┘
```

### Components

- **brain-core** (library): parsers (web-tree-sitter), SCIP importer, SQLite store, ranking, doc generator, search. Shared by every entry point.
- **brain-mcp** (stdio MCP server): opens the store, does a quick incremental tree-sitter refresh on start, serves tools/resources/prompts. Works standalone (e.g. Claude Code in a terminal) without VS Code.
- **brain-vscode** (extension): registers `brain-mcp` through `mcpServerDefinitionProviders`; watches files and re-indexes incrementally; runs the LSP bridge (feeds resolved edges from VS Code's language providers into the store); provides the UI (Brain tree view, staleness CodeLens, "Document this module" command, review of generated docs). Can also write config snippets for Claude Code / Cursor.
- **brain CLI**: index and generate docs in CI using tree-sitter + SCIP; export docs as a static markdown site.

### Key decision: markdown in the repo is the source of truth; the database is a cache

Curated notes and reviewed docs live in `.brain/` and are committed, so they are versioned, reviewable in PRs and shared with the team. The SQLite file can always be rebuilt from the code plus `.brain/`.

### Practical notes

- Native Node modules are painful in VS Code extensions (Electron ABI mismatches). Prefer `web-tree-sitter` (WASM). For SQLite, either ship platform-specific VSIX packages or keep database writes in the separate Node process.
- SQLite in WAL mode with a busy timeout and short write transactions is enough for the extension and the MCP server to share one file.

---

## 4. Data model (sketch)

```sql
file    (id, path, lang, content_hash, indexed_at)
symbol  (id, file_id, qualified_name, kind, start_line, end_line,
         signature, docstring, body_hash, scip_symbol)
edge    (src_id, dst_id, kind,      -- calls|imports|extends|implements|references
         source,                    -- treesitter|lsp|scip
         confidence)                -- name-match guess vs resolved
summary (target_kind, target_id, text, model, built_from_hash,
         status)                    -- generated|reviewed|stale
note    (id, md_path, title, linked_symbols, updated_at)
-- plus FTS5 over names/signatures/docstrings/summaries, and sqlite-vec embeddings
```

- **Freshness:** each summary stores the hash of the code it was built from. When a symbol's `body_hash` changes, its summary becomes `stale`, and staleness propagates up to file, module and architecture summaries. A stale doc that misleads the AI is worse than no doc.
- **Provenance:** every edge records how it was found (`source`) and how confident we are (`confidence`). Agents should know whether a link is a name-match guess or a resolved reference.

---

## 5. Documentation generation

1. **Rank first.** Run PageRank over the reference graph (same idea as Aider's repo map). Document central symbols first; skip trivial ones such as getters.
2. **Summarise bottom-up:** symbol (code, signature, callers and callees) → file (from its symbol summaries) → directory / module → architecture overview. Each level reads only the level below, which keeps prompts small.
3. **Who runs the LLM** (options):
   - **(a) The agent itself — recommended for the MVP.** Expose `list_undocumented` and `save_summary`; the user's own agent writes the docs. No API keys, no LLM cost on our side.
   - **(b) `vscode.lm` API** from the extension, using the user's Copilot models.
   - **(c) MCP sampling**, where the client supports it.
   - **(d) Bring your own key, or a local model** for privacy-sensitive code.
4. **Human review.** Generated docs are labelled "generated, unreviewed" until someone approves them in the extension. Tools return that status, so the agent knows how far to trust a doc.

---

## 6. MCP surface

Keep it to about 8 well-described tools. Return compact output (paths, line ranges, freshness flag) and paginate.

| Tool | Purpose |
|---|---|
| `search_code(query, kind?)` | Combined keyword + semantic search over symbols, docs and notes |
| `get_symbol(name)` | Signature, location, docstring, summary, status |
| `get_neighbors(symbol, direction, depth)` | Callers, callees, imports |
| `impact_of_change(symbol)` | Everything that transitively depends on it |
| `get_overview(path?)` | Summary of a module or directory, or the whole architecture |
| `read_notes(topic)` / `add_note(...)` | The "brain": decisions, conventions, gotchas, past failures |
| `list_undocumented` / `save_summary` | Agent-driven documentation (option a above) |

**Resources:** `brain://architecture`, `brain://module/{path}`

**Prompts:** `/onboard`, `/document-module`

---

## 7. Roadmap

- **Phase 0 — spike (~1 week):** tree-sitter → SQLite for one language, plus an MCP server with `search_code` and `get_symbol`. Try it in Claude Code on a real repo.
- **Phase 1 — MVP:** VS Code extension, incremental indexing, LSP bridge, `.brain/` notes, staleness tracking. Two languages (e.g. TypeScript and Python).
- **Phase 2:** documentation generation with review, embeddings and combined search, export of docs as a static markdown site.
- **Phase 3:** SCIP ingestion in CI, team sharing, multi-repo graphs.

---

## 8. Measuring whether it helps

- **Task benchmark:** take ~20 real past tasks from our own repos (closed issues or commits). Run the agent on each with and without the server; compare pass rate, tokens used, number of file reads and time taken.
- **Retrieval benchmark:** for a set of questions, does `search_code` return the right symbol in its top 5?

Without this, "makes AI better" cannot be tuned.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Stale or wrong docs mislead the agent | Hash-based staleness, review status returned by every tool |
| Token bloat in tool output | Output limits, pagination, summaries before full code |
| Privacy: code is sent to an LLM | Respect `.gitignore`, skip secrets and `.env` files, offer a local-model option |
| Slow LSP on large repos | Lazy, prioritised LSP queries; SCIP for full precision in CI |
| Native-module pain in the extension | WASM tree-sitter; platform-specific VSIX or out-of-process DB writes |

---

## 10. Open decisions

- **Implementation language.** The design assumes TypeScript throughout (the VS Code extension must be JS/TS, and one shared core avoids two codebases). The repo's current `.gitignore` is the Python template; update it once this is decided.
- **Process topology.** Who owns database writes: the extension, the MCP server, or both via WAL?
- **SQLite packaging** inside the extension (platform-specific VSIX vs. out-of-process).
- **Default LLM path** for doc generation beyond the MVP (options b–d in §5).
- **First two languages** for Phase 1.

---

## 11. Prior art to study

- **Serena** — MCP server built on language servers.
- **Aider's repo map** — tree-sitter plus PageRank to pick important symbols.
- **DeepWiki** and **Google CodeWiki** — generate a wiki from a repository.
- **Sourcegraph / SCIP** — precise code indexing.
- **Context7** — MCP server that serves library documentation.

**Our edge:** the combination of knowledge committed to the repo, tracked freshness, and a VS Code UI for human review.
