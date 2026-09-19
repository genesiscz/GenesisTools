# genesis-tools-mcp

Stdio MCP server used by Claude Code, Codex, and Grok. The same process serves every host.
New `jev_*` tools will join this registry. The MCP server name is `genesis-tools`.

## What it exposes

| Capability | Tools | Purpose |
|------------|-------|---------|
| `question_answer` | `question_answer` | Record a user question and the complete answer in the local question store. |
| `question_ask` | `question_post`, `question_wait`, `question_poll`, `question_respond`, `question_cancel` | Blocking ask: post a pending form, wait or poll, respond, or cancel. |
| `handoff` | `handoff_post`, `handoff_get`, `handoff_list`, `handoff_action` | Cross-agent task handoff. |
| `annotate` | `annotate_image` | Annotate an image (arrows, boxes, labels). |
| `boards` | `boards_*` | Dev-dashboard annotation boards: create, compose, list work, wait, attach. |
| `jev` | `jev_route`, `jev_compact`, `jev_verify`, `jev_verify_templates` | Read-only Jev tools (`src/jev/mcp/genesis-tools.ts` adapts the registry `tools jev mcp` serves alone). |

`question_ask` is an explicit set, not a `question_` prefix, so it never includes `question_answer`.

## Capability filter

`GENESIS_TOOLS_MCP_CAPABILITIES` is a comma-delimited list of capability names.
Unset or empty enables every capability. Unknown names enable nothing.

```bash
GENESIS_TOOLS_MCP_CAPABILITIES=question_answer,handoff,annotate
```

Claude Code typically sets that env on the `genesis-tools` MCP entry in `~/.claude.json`
(`command: tools`, `args: ["claude", "mcp"]`). That args list is the legacy door and still works.

## How hosts launch it

```bash
tools genesis-tools-mcp          # preferred: no subcommand starts the stdio server
tools claude mcp                 # legacy alias; existing ~/.claude.json entries keep working
tools genesis-tools-mcp install  # register with Claude (or --agent codex)
tools claude mcp install         # same install, via the alias
```

stdout is JSON-RPC. Diagnostics go to the logger (stderr), never stdout.
The install command stores `tools genesis-tools-mcp`, the stable global command, never a worktree path.
Host entries that still say `tools claude mcp` keep working through the alias.

Codex and Grok launch the same binary as a stdio MCP server and set
`GENESIS_TOOLS_MCP_CAPABILITIES` in that process env.
