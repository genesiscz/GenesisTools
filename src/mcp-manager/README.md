# mcp-manager - MCP Configuration Manager

Cross-platform MCP (Model Context Protocol) server configuration manager. Manage MCP servers across multiple AI assistants (Claude Desktop, Gemini Code Assist, Codex, Cursor) with a unified interface.

## Features

-   ✅ **Multi-Provider Support**: Manage MCP servers for Claude, Gemini, Codex, and Cursor
-   ✅ **Unified Configuration**: Single config file (`~/.genesis-tools/mcp-manager/config.json`) to manage all servers
-   ✅ **Automatic Backups**: Creates backups before any changes with automatic restore on rejection
-   ✅ **Visual Diffs**: See exactly what changed before applying updates
-   ✅ **Interactive Confirmation**: Review changes and approve or revert
-   ✅ **Bidirectional Sync**: Sync servers from unified config to providers, or import from providers to unified config
-   ✅ **Safe Operations**: All changes are reversible with automatic backup restoration

## CLI Usage

### Basic Examples

```bash
# Interactive mode - choose an action
tools mcp-manager

# Open/edit unified configuration file
tools mcp-manager config

# Sync servers from unified config to selected providers
tools mcp-manager sync

# Sync servers FROM providers TO unified config
tools mcp-manager sync-from-providers

# List all MCP servers across all providers
tools mcp-manager list

# Enable a server in a provider
tools mcp-manager enable github

# Disable a server in a provider
tools mcp-manager disable github

# Re-enable a globally-disabled server for ONE claude project (override)
tools mcp-manager enable github -p claude --project /abs/path/to/project

# Completely REMOVE server(s) everywhere (permanent — disable is reversible)
tools mcp-manager remove github,old-server -y

# Install a server from unified config to a provider
tools mcp-manager install github

# Show full configuration of a server
tools mcp-manager show github
```

### Commands

| Command               | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `config`              | Open/create unified configuration file                   |
| `config --path`       | Print config file path without opening editor            |
| `sync`                | Sync MCP servers from unified config to providers        |
| `sync-from-providers` | Sync servers FROM providers TO unified config            |
| `list`                | List all MCP servers across all providers                |
| `enable`              | Enable an MCP server in a provider (`--project` for per-project) |
| `disable`             | Disable an MCP server in a provider (`--project` for per-project) |
| `remove` (`purge`)    | PERMANENTLY remove server(s) from unified config + all provider configs |
| `install`             | Install/add an MCP server to a provider                  |
| `show`                | Show full configuration of an MCP server                 |
| `backup-all`          | Backup all configs for all providers                     |
| `rename`              | Rename an MCP server key across unified config/providers |
| `config-json`         | Output servers as JSON in standard client format         |

### Global Options

```bash
-p, --provider <name>    Provider name(s) (claude, cursor, gemini, codex, or 'all')
-v, --verbose            Enable verbose logging
-y, --yes                Auto-confirm changes without prompting
-?, --help-full          Show detailed help message
-h, --help               Show help message
```

### Install Command Options

```bash
-t, --type <type>        Transport type (stdio, sse, http) for install
-H, --headers <str>      Headers for http/sse (colon separator: "Key: value")
-e, --env <str>          Env vars for stdio (equals separator: "KEY=value")
```

### Header and Env Format

**Headers** use **colon (`:`)** as separator (like HTTP headers):
```bash
# Single header
--headers "Authorization: Bearer YOUR_TOKEN"

# Multiple headers (use multiple flags)
--headers "Authorization: Basic abc123==" --headers "X-Api-Key: secret"
```

**Env vars** use **equals (`=`)** as separator:
```bash
# Single env var
--env "API_KEY=your-key"

# Multiple env vars (use multiple flags)
--env "API_KEY=xxx" --env "TOKEN=yyy"
```

Both support JSON format as alternative:
```bash
--headers '{"Authorization": "Bearer token"}'
--env '{"API_KEY": "xxx", "TOKEN": "yyy"}'
```

## Unified Configuration

The tool uses a unified configuration file at `~/.genesis-tools/mcp-manager/config.json` (managed via Storage class) with the following schema:

```json
{
    "mcpServers": {
        "server-name": {
            "command": "node",
            "args": ["path/to/server.js"],
            "env": {
                "API_KEY": "your-key"
            },
            "type": "stdio",
            "enabled": true
        }
    }
}
```

### Server Configuration Fields

-   `command` (string): Executable command to run
-   `args` (array): Command arguments
-   `env` (object): Environment variables
-   `type` (string): Transport type - `"stdio"`, `"sse"`, or `"http"`
-   `url` (string): URL for SSE/HTTP servers
-   `httpUrl` (string): HTTP endpoint URL (Gemini)
-   `headers` (object): HTTP headers (Gemini)
-   `enabled` (boolean): Enable/disable state

## Supported Providers

### Claude Desktop (`~/.claude.json`)

-   Supports global and project-specific server configurations
-   Supports stdio, SSE, and HTTP transports
-   **Global disable = removal from `mcpServers`** (see below)

#### Claude enable/disable semantics

Verified against the Claude Code binary: Claude Code reads `disabledMcpServers`
**only** from per-project entries (`.projects[<cwd>].disabledMcpServers`). The
**top-level `disabledMcpServers` key is never read by Claude Code** — it is an
mcp-manager-only marker. A per-project sweep covers only projects registered at
sweep time; a project registered later would load the server again. The only
mechanism Claude Code honors globally (including future projects) is the server
**not existing in `mcpServers` at all**.

mcp-manager therefore implements a TRUE global disable for Claude:

-   **Global disable** (`tools mcp-manager disable <server> --provider claude`):
    1. Preserves the server's full config in the unified config with
       `_meta.enabled.claude = false` (imports it there first if missing —
       the entry is never removed unless it is safely preserved).
    2. Keeps the top-level marker + per-project sweep for back-compat.
    3. **Removes the entry from `mcpServers`** in `~/.claude.json`.
-   **Global enable** restores the entry into `mcpServers` from the unified
    config and cleans the top-level + all per-project disabled lists.
-   **Per-project disable** is unchanged: the entry stays in `mcpServers` and
    the project's `disabledMcpServers` list is updated (this is the mechanism
    Claude Code actually reads).
-   **`list`** shows globally-disabled servers (absent from `~/.claude.json`)
    as `disabled` for claude — sourced from the unified config — instead of
    "not installed".
-   **`sync`** treats `_meta.enabled.claude === false` as disabled-by-absence:
    such servers are never (re)installed into `mcpServers`, and drifted
    entries are removed.
-   **`sync-from-providers`** does not interpret the absence of a
    globally-disabled server as "user deleted it" — the unified config entry
    and its `_meta.enabled.claude = false` flag are preserved.

#### Per-project enable override (claude)

A global disable can be overridden for individual projects:

```bash
tools mcp-manager enable <server> -p claude --project /abs/path [--project /other] [-y]
```

-   Installs the server's claude-format config into
    `.projects[<path>].mcpServers.<name>` in `~/.claude.json` — Claude Code
    DOES honor project-scope entries there (it's the same storage
    `claude mcp add -s local` uses) — and removes the name from that project's
    `disabledMcpServers` list.
-   The global state stays disabled: the server remains absent from the global
    `mcpServers` and `_meta.enabled.claude` stays `false`. The override is
    tracked solely by the presence of the project-scope entry — no extra
    metadata.
-   **Override-awareness:** the per-project sweep (global disable) and `sync`
    SKIP projects that have a project-scope entry for that server — they never
    re-add the name to that project's `disabledMcpServers` and never delete
    the entry (its config is refreshed from the unified config on sync).
    `sync-from-providers` keeps `_meta.enabled.claude === false` even though
    the override projects report the server as enabled.
-   `list` shows such servers as `disabled globally, enabled in N project(s)`.
-   Undo with `tools mcp-manager disable <server> -p claude --project <path>` —
    removes the project-scope entry and puts the name back on that project's
    disabled list.
-   `--project` is repeatable and accepts comma-separated paths; `-p all` is
    also accepted for enable/disable and expands to all providers with configs.

#### `remove` vs `disable`

`disable` is reversible: the full server config stays in the unified config
and `enable` can restore it anywhere. `remove` (alias `purge`) is PERMANENT:
it deletes the server from the unified config (`mcpServers.<name>` and the
`enabledMcpServers.<name>` mirror) and from every selected provider config —
claude `~/.claude.json` `mcpServers` (global + project-scope entries; the
per-project `disabledMcpServers` history lists are left as harmless
leftovers), cursor `~/.cursor/mcp.json`, gemini `~/.gemini/settings.json`
(`mcpServers` + `mcp.excluded`), and codex `~/.codex/config.toml`
(`[mcp_servers.<name>]` including nested `.env`/`.http_headers` subsections,
leaving `[projects.*]`/`[notice]` untouched). Each write shows the standard
diff + confirmation and goes through the backup path; `-y` auto-confirms.

### Gemini Code Assist (`~/.gemini/settings.json`)

-   Explicit `disabled` boolean flag per server
-   Supports stdio and HTTP transports
-   Uses `mcp.excluded` array for global exclusions

### Codex (`~/.codex/config.toml`)

-   TOML-based configuration
-   Only supports stdio transport
-   Servers are enabled if they exist in config

### Cursor (`~/.cursor/mcp.json`)

-   JSON-based configuration
-   Only supports stdio transport
-   Servers are enabled if they exist in config

## Workflow Example

### 1. Create Unified Configuration

```bash
# Open config editor
tools mcp-manager config

# Add servers to unified config (~/.genesis-tools/mcp-manager/config.json)
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/path/to/github-server.js"],
      "env": {
        "GITHUB_TOKEN": "your-token"
      },
      "enabled": true
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
      "enabled": true
    }
  }
}
```

### 2. Sync Servers

**Option A: Sync FROM unified config TO providers**

```bash
# Sync servers to selected providers
tools mcp-manager sync

# Select providers: claude, gemini, codex, cursor
# Review diff and confirm changes
```

**Option B: Sync FROM providers TO unified config**

```bash
# Import servers from providers into unified config
tools mcp-manager sync-from-providers

# Select providers to import from
# Servers will be merged into unified config
# Later providers override earlier ones for same server name
```

### 3. Manage Individual Servers

```bash
# List all servers
tools mcp-manager list

# Enable/disable servers
tools mcp-manager enable github
tools mcp-manager disable github

# View server configuration
tools mcp-manager show github
```

## Backup and Safety

### Automatic Backups

Before any write operation, the tool:

1. **Creates Backup**: Saves current configuration to `~/.mcp-manager/backups/`
2. **Shows Diff**: Displays colored diff of changes (green = added, red = removed)
3. **Asks Confirmation**: Prompts "Are these changes okay?"
4. **Applies or Restores**:
    - If confirmed: Writes new configuration
    - If rejected: Automatically restores from backup

### Backup File Format

Backups are stored with timestamps:

```
~/.mcp-manager/backups/claude-.claude.json-2024-01-15T10-30-45-123Z.backup
~/.mcp-manager/backups/gemini-settings.json-2024-01-15T10-30-45-123Z.backup
~/.mcp-manager/backups/unified-mcp.json-2024-01-15T10-30-45-123Z.backup
```

### Example Diff Output

```
Backup created: /Users/Martin/.mcp-manager/backups/claude-.claude.json-2024-01-15T10-30-45-123Z.backup

Changes to /Users/Martin/.claude.json:

  "mcpServers": {
+   "github": {
+     "command": "node",
+     "args": ["/path/to/server.js"]
+   },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"]
    }
  }

? Are these changes okay? (Y/n) y
✓ Configuration written to /Users/Martin/.claude.json
```

## Architecture

### Provider System

Each provider extends the base `MCPProvider` class:

```typescript
abstract class MCPProvider {
    abstract configExists(): Promise<boolean>;
    abstract readConfig(): Promise<unknown>;
    abstract writeConfig(config: unknown): Promise<void>;
    abstract listServers(): Promise<MCPServerInfo[]>;
    abstract enableServer(serverName: string): Promise<void>;
    abstract disableServer(serverName: string): Promise<void>;
    abstract syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void>;
}
```

### Backup Manager

The `BackupManager` class handles:

-   Creating timestamped backups
-   Showing visual diffs with context
-   Asking for user confirmation
-   Restoring from backups on rejection

### Configuration Conversion

Each provider converts between:

-   **Provider-specific format** → **Unified format** (`toUnifiedConfig`)
-   **Unified format** → **Provider-specific format** (`fromUnifiedConfig`)

This allows seamless syncing between different provider configurations.

## Troubleshooting

### "No provider configuration files found"

Ensure you have at least one provider configured:

-   Claude: `~/.claude.json`
-   Gemini: `~/.gemini/settings.json`
-   Codex: `~/.codex/config.toml`
-   Cursor: `~/.cursor/mcp.json`

### "Server not found in any provider"

The server doesn't exist in any provider configuration. Use `install` command to add it from unified config, or use `sync-from-providers` to import existing servers from providers.

### Backup restoration failed

Check that backup files exist in `~/.mcp-manager/backups/`. You can manually restore by copying a backup file back to the original location.

### TOML parsing errors (Codex)

Ensure your TOML syntax is valid. The tool uses `@iarna/toml` for parsing.

## Dependencies

-   `@iarna/toml`: TOML parsing for Codex provider
-   `diff`: Diff calculation for change visualization
-   `@inquirer/prompts`: Interactive prompts
-   `chalk`: Colored terminal output

## Related Tools

-   `mcp-tsc`: TypeScript diagnostics MCP server
-   `mcp-ripgrep`: Code search MCP server
-   `mcp-web-reader`: Web content fetching MCP server
