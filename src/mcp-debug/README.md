# MCP Debug

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Type](https://img.shields.io/badge/Type-MCP%20Helper-purple?style=flat-square)

> **Debug tool for MCP server configurations — execute a command and emit JSON results + debug logs.**

When an MCP server misbehaves in Cursor or Claude Desktop, it's often an env / PATH / cwd problem. `mcp-debug` wraps an arbitrary command in an MCP-friendly envelope: debug info goes to stderr (visible in the client's debug console), valid JSON goes to stdout (parsed by the client). Use it to verify what env the client actually launches your server with.

---

## Quick Start

```bash
# Run a single command and see its output + the env the server sees
tools mcp-debug which playwright

# Dump the env the MCP client launches the server with
tools mcp-debug --env

# Combine: --env plus one or more additional commands
tools mcp-debug --env which playwright

# Run multiple commands via env var (semicolon-separated)
COMMANDS="env;which playwright;echo test" tools mcp-debug

# Primary command + extras from COMMANDS
COMMANDS="env;which playwright" tools mcp-debug echo "test"
```

---

## Options

| Option | Alias | Description |
|--------|-------|-------------|
| `[command...]` | — | Command + args to execute (optional if `COMMANDS` or `--env` set) |
| `--env` | `-e` | Auto-execute `env` |
| `--verbose` | `-v` | Verbose logging |
| `--help-full` | — | Extended help |

`COMMANDS` env var: semicolon-delimited list of extra commands to execute after the positional one.

---

## Output

Stdout is always valid JSON of the form:

```json
{
  "success": true,
  "exitCode": 0,
  "cwd": "/some/path",
  "env": { ... full env ... },
  "commands": [
    { "command": "which playwright", "exitCode": 0, "stdout": "...", "stderr": "" }
  ]
}
```

Stderr carries `[MCP-DEBUG]`-prefixed log lines that show up in the MCP client's debug console.

---

## Typical use

Wire it into an MCP config slot as the server command to confirm the client is passing the env / PATH you expect:

```json
{
  "mcpServers": {
    "debug-me": {
      "command": "tools",
      "args": ["mcp-debug", "--env", "which", "bun"]
    }
  }
}
```

Restart the client, open the MCP debug console, and inspect what came back.
