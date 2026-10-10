# genesis-tools-mcp

Stdio MCP server used by Claude Code, Codex, and Grok. The same process serves every host.
New `jev_*` tools will join this registry. The MCP server name is `genesis-tools`.

## What it exposes

| Capability | Tools | Purpose |
|------------|-------|---------|
| `question_answer` | `question_answer`, `inbox_send` | Record a user question and the complete answer in the local question store (`images` takes screenshot paths). `inbox_send` sends the user a message with screenshots to the native widget inbox; it is registered only on a Mac with the native app (see "Native inbox" below). |
| `inbox` | `inbox_send` | `inbox_send` alone. |
| `question_ask` | `question_post`, `question_wait`, `question_poll`, `question_respond`, `question_cancel`, `question_update`, `question_tokens` | Ask the user: `question_post` creates a pending form and returns its id at once, and blocks only with `wait: true`. Then wait, poll, respond, or cancel. `question_tokens` (read-only) lists the inline `{{kind …}}` tokens `question_post` resolves, or previews a text; see `src/question/README.md`. |
| `handoff` | `handoff_post`, `handoff_get`, `handoff_list`, `handoff_action` | Cross-agent task handoff. |
| `annotate` | `annotate_image` | Annotate an image (arrows, boxes, labels). |

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
tools genesis-tools-mcp install  # register with Claude (or --agent codex, --agent grok)
tools claude mcp install         # same install, via the alias
```

stdout is JSON-RPC. Diagnostics go to the logger (stderr), never stdout.
The install command stores `tools genesis-tools-mcp`, the stable global command, never a worktree path.
Host entries that still say `tools claude mcp` keep working through the alias.

Codex and Grok launch the same binary as a stdio MCP server and set
`GENESIS_TOOLS_MCP_CAPABILITIES` in that process env. `install --agent grok` writes
`[mcp_servers.genesis-tools]` into `~/.grok/config.toml` and leaves every other key of that file as it was.

## Native inbox

`nativeInboxState()` (`src/utils/macos/native-inbox.ts`) is `none`, `installed` or `running`:

- installed: `~/Applications/GenesisTools Preview.app`, or `~/Applications/GenesisTools.app` with the staging
  defaults key `GenesisToolsStagingFaces` (`bun scripts/native/staging.ts on`).
- running: a widget `worker.lock` holds the live pid of the `tools hub widget watch` process the widget keeps open.

The server instructions, the `question_post` description and the `inbox_send` tool follow it, with the precedence
over `tools question config --ask-via-question-tool` written down in `src/question/lib/inbox-guidance.ts`. With
`none` nothing mentions the inbox and `inbox_send` is not registered. The plugin's SessionStart hook
(`plugins/genesis-tools/hooks/native-inbox-hint.ts`) reads `~/.genesis-tools/app/native-inbox.json`, which the
state function writes; no file means no native app.
