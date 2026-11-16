# app-brain
generate application context out of code base

- [PLAN.md](PLAN.md): overall design and roadmap.
- [PLAN-VSCODE-EXTENSION.md](PLAN-VSCODE-EXTENSION.md): the VS Code extension over a local MCP server, the OKF output format, cost and usage reporting.

## Status: Phase 0 (protocol spike)

| Package | What it does today |
|---|---|
| `packages/brain-protocol` | Shared types and schemas: config, status, tool and resource names |
| `packages/brain-mcp` | Stdio MCP server. Resources `brain://status`, `brain://config`. Admin tools (token-gated): `hello`, `init`, `get_config`, `get_config_schema`, `set_config`, `reindex`. `init` creates the `.brain/` layout with an OKF v0.2 bundle. `reindex` is a file inventory only (no symbols yet) |
| `packages/brain-vscode` | Extension: spawns the server, handshakes, shows status in the status bar, commands (initialise, reindex, open output folder, copy MCP config), registers the server for Copilot agent mode |

Not built yet: tree-sitter indexing, search tools, doc generation, review flow, cost and usage reporting, dependency graph, settings webview. See the plans.

## Develop

```sh
npm install
npm test        # builds, then runs the server and extension tests
```

Run the extension: open this folder in VS Code and press F5 (“Run App Brain extension”), then open any folder in the new window.

Use the server from another agent without VS Code:

```sh
node packages/brain-mcp/out/cli.js --workspace /path/to/repo
```

The server only enables `brain_admin_*` tools for a client that presents the token in `BRAIN_ADMIN_TOKEN`. Agents started without it get the read-only resources.
