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

# Disable server for all projects (Claude-specific)
tools mcp-manager disable-all github

# Install a server from unified config to a provider
tools mcp-manager install github

# Show full configuration of a server
tools mcp-manager show github
```

### Commands

| Command               | Description                                       |
| --------------------- | ------------------------------------------------- |
| `config`              | Open/create unified configuration file            |
| `sync`                | Sync MCP servers from unified config to providers |
| `sync-from-providers` | Sync servers FROM providers TO unified config     |
| `list`                | List all MCP servers across all providers         |
| `enable`              | Enable an MCP server in a provider                |
| `disable`             | Disable an MCP server in a provider               |
| `disable-all`         | Disable an MCP server for all projects (Claude)   |
| `install`             | Install/add an MCP server to a provider           |
| `show`                | Show full configuration of an MCP server          |

### Options

```bash
-v, --verbose    Enable verbose logging
-h, --help       Show help message
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
-   Uses `disabledMcpServers` array for disable state
-   Supports stdio, SSE, and HTTP transports

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
-   `enquirer`: Interactive prompts
-   `chalk`: Colored terminal output

## Related Tools

-   `mcp-tsc`: TypeScript diagnostics MCP server
-   `mcp-ripgrep`: Code search MCP server
-   `mcp-web-reader`: Web content fetching MCP server
