# tools mcp-doctor

> **Health-check and benchmark your configured MCP servers.**

Answers the question you have when an assistant says a tool is unavailable: is the server configured, does it start, does it respond, and how slow is it.

---

## Commands

| Command | Description |
|---------|-------------|
| `list` | Discover and normalize config only, no spawn |
| `check` | Spawn, connect and probe every configured server (default) |
| `tools <server>` | Probe one server and print its tools, resources and prompts |

## Quick start

```bash
tools mcp-doctor list                           # what is configured, without starting anything
tools mcp-doctor                                # probe everything
tools mcp-doctor check --only github,jina
tools mcp-doctor check --slow 1000              # flag anything over 1s
tools mcp-doctor check --timeout 30000          # be patient with slow starters
tools mcp-doctor tools jina
tools mcp-doctor check --json | tools json
tools mcp-doctor check --project ~/some/repo    # include that repo's local config
```

## Options

Every option applies to every subcommand.

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON to stdout |
| `--timeout <ms>` | Per-server probe timeout (default: 15000) |
| `--slow <ms>` | Latency above which a server is flagged slow (default: 3000) |
| `--only <names>` | Restrict to comma-separated server names |
| `--project <dir>` | Project root to scan for `.mcp.json` and `.cursor/mcp.json` |

---

## `list` versus `check`

`list` reads and normalizes configuration. It spawns nothing, so it is instant and completely safe. Use it to answer "is this server even configured, and with what command and env".

`check` actually starts each server and completes an MCP handshake. That is the only way to distinguish "configured" from "working", and it is why it takes real time. A server whose command is missing, whose token expired, or which crashes on startup only shows up here.

`tools <server>` is the deep look at one server: its full tool list, resources and prompts. Useful when an assistant reports a tool name you do not recognise, or when a server's tool set changed after an upgrade.

## Notes

- `--project` matters because MCP config is layered. A repo can add servers through `.mcp.json` or `.cursor/mcp.json` that your global config knows nothing about.
- Spawning a server runs whatever command its config names. That is the point of `check`, but it does mean `check` executes third-party code. `list` does not.
- To edit configuration rather than diagnose it, use [`tools mcp-manager`](../mcp-manager/README.md). To debug what environment a client passes to a server, use [`tools mcp-debug`](../mcp-debug/README.md).
