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

# Health-check every configured MCP server (does it start, answer, and how fast)
tools mcp-manager doctor
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
| `doctor list`         | Show the servers your clients are configured with, start nothing |
| `doctor check`        | Start or connect to every configured server and probe it (default of `doctor`) |
| `doctor tools <server>` | Probe one server and print its tools, resources and prompts |
| `doctor env [command...]` | Print the environment, PATH and cwd a client passes to a server |

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

Verified against the Claude Code binary (2.1.296, research note
`2026-10-13-ClaudeCodeGlobalMcpSwitch.md`): Claude Code reads `disabledMcpServers`
**only** from per-project entries (`.projects[<cwd>].disabledMcpServers`). The
**top-level `disabledMcpServers` key is never read by Claude Code** — it is an
mcp-manager-only marker. The only mechanism Claude Code honors globally
(including future projects) that one project can still override is the server
**not existing in `mcpServers` at all**. A `deniedMcpServers` entry in
`~/.claude/settings.json` is global and costs no tokens, but no project setting
can lift it (it also blocks a project-scope or `.mcp.json` server of the same
name), so mcp-manager does not use it for a global disable.

**Global means the global switch only.** A global disable, a global enable,
an install and a `sync` never write the per-project `disabledMcpServers` lists
in `~/.claude.json`. Only a named project writes its own list. The one opt-in
exception is `enable --clear-project-overrides` (below). A dry run of
`sync` once wanted to add one disabled server to the lists of all 98 projects
(about 640 diff lines). That is why the old sweep was removed on 2026-10-13.

mcp-manager therefore implements a TRUE global disable for Claude:

-   **Global disable** (`tools mcp-manager disable <server> --provider claude`):
    1. Preserves the server's full config in the unified config with
       `_meta.enabled.claude = false` (imports it there first if missing —
       the entry is never removed unless it is safely preserved). If the
       config cannot be preserved, the entry stays and Claude Code still loads
       the server everywhere; a warning says so.
    2. Keeps the top-level marker.
    3. **Removes the entry from `mcpServers`** in `~/.claude.json`.
-   **Global enable** restores the entry into `mcpServers` from the unified
    config and drops the top-level marker. It does not change project lists.
    When some projects still list the server (old entries from the removed
    sweep, or a per-project disable), the server stays off in those projects,
    and one warning gives the count and the two commands below.
-   **Global enable with `--clear-project-overrides`**
    (`tools mcp-manager enable <server> -p claude --clear-project-overrides`)
    also takes the name off every `.projects[<path>].disabledMcpServers` list
    that still names it, and prints how many lists it changed. Other names on
    those lists stay. A project with a project-scope entry counts too, because
    its list switches the server off there as well. The flag applies only to a
    global Claude enable: with `--project`, or for a provider without project
    lists, the command says that it does not apply. For one project, use
    `tools mcp-manager enable <server> -p claude --project <path>`.
-   **Per-project disable or enable** (`--project <path>`) is the only command
    that writes a project's `disabledMcpServers` list, and only for the named
    projects. The global entry stays in `mcpServers`.
-   **`list`** shows globally-disabled servers (absent from `~/.claude.json`)
    as `disabled` for claude — sourced from the unified config — instead of
    "not installed".
-   **`sync`** treats `_meta.enabled.claude === false` as disabled-by-absence:
    such servers are never (re)installed into `mcpServers`, and drifted
    entries are removed. For `true`, `false` or an unset state, `sync` writes
    no project list. For a per-project map (`{ "/abs/path": false }`), it writes
    only the lists of the projects the map names, and creates no project entry.
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
-   **Override-awareness:** a global disable and `sync` never delete the
    project-scope entry, and never put the name back on that project's
    `disabledMcpServers` list (a per-project map in `sync` skips that project
    too). `sync` refreshes the entry's config from the unified config.
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
-   HTTP servers use `[mcp_servers.<name>.http_headers]`, not `headers`
-   Servers are enabled if they exist in config
-   Extra Codex homes (for example `~/.codex-shop`) are listed under `harnesses.codex.syncTo.homes` in the unified config. The first `sync` or save writes default homes when that block is missing. Extra homes keep dest-only servers and home-bound env (such as `node_repl` `CODEX_HOME`). A dest HTTP server that still uses `headers` is replaced with `http_headers`.

### Harness homes (Codex only)

The unified config (`~/.genesis-tools/mcp-manager/config.json`) may contain:

```json
"harnesses": {
  "codex": {
    "syncTo": { "homes": ["~/.codex", "~/.codex-shop", "~/.codex-work"] },
    "syncFrom": { "homes": ["~/.codex"] }
  }
}
```

`syncTo.homes` is where `sync` writes; `syncFrom.homes` is where `listServers` /
`sync from` read, first home winning a name clash. Writes always go to the first
`syncTo` home, so reading a shop home never moves an install into it.

**Only Codex reads this block.** The Claude, Gemini and Cursor providers build
their config path in their constructors from the OS home (see
`utils/providers/claude.ts`) and ignore `harnesses` entirely, so an entry for them
is written by the defaults pass but changes nothing. `ensureHarnessDefaults` still
fills every harness on the next `sync` or save — Claude `~/.claude.json`, Gemini
`~/.gemini/settings.json`, Cursor `~/.cursor/mcp.json`, Codex `~/.codex` — so the
file shows the paths in use even where they are not configurable.

### Grok (`~/.grok/config.toml`)

Grok runs more than its own `[mcp_servers]` tables. Measured on Grok 1.0.44
(2026-10-13) with `grok inspect --json` and `grok mcp doctor --json` in an
isolated home:

-   Sources, highest priority first: a `config.toml` table, a plugin server
    (Claude-enabled plugins and Grok's own), `~/.claude.json` top-level
    `mcpServers`, then `~/.cursor/mcp.json` and a project `.mcp.json`. On a name
    clash Grok runs one server: the highest source wins. A `config.toml` table
    wins even with `enabled = false`, so such a table switches the Claude copy
    off as well.
-   Grok also reads `~/.claude.json` `projects[<cwd>].mcpServers` for the folder
    it starts in (a project-scoped server needs a trusted folder).
    `[compat.claude] mcps = false` stops every `~/.claude.json` source, and
    `[compat.cursor] mcps = false` stops `~/.cursor/mcp.json`.
-   Claude's own switches do not reach Grok: a project's `disabledMcpServers`
    and the `deniedMcpServers` setting leave the server running in Grok. Only
    `disabled_mcp_servers` in `config.toml`, or a table with `enabled = false`,
    keeps a server off there.

mcp-manager follows that model:

-   `list` and `show` name the source of each Grok row: `grok (config.toml)`,
    `grok (~/.claude.json)`, `grok (~/.cursor/mcp.json)` or
    `grok (plugin <id>)`. A row that a higher source shadows is not shown.
    Project-scoped Claude servers are not shown, because they depend on the
    folder Grok starts in.
-   `sync` writes a table only for a server with an explicit grok decision in
    the unified config (`_meta.enabled.grok` true or false). With no grok
    decision, the existing table stays exactly as it is and no table is
    created, so a sync never turns off a server Grok runs. An enabled server
    that Grok already gets with the same definition from a plugin,
    `~/.claude.json` or `~/.cursor/mcp.json` gets no `config.toml` copy. A
    different definition (for example the Grok gateway projection) does get a
    table, and that table wins. Tables that the sync does not name stay.
-   `disable <server> -p grok` sets `enabled = false` on a table. For a server
    that Grok takes from another file, it adds the name to
    `disabled_mcp_servers` instead. `enable` reverses both, and also removes the
    name from that list when a table exists, because the list would keep the
    server off.

### Cursor (`~/.cursor/mcp.json`)

-   JSON-based configuration
-   Only supports stdio transport
-   Servers are enabled if they exist in config

## Plugin-provided servers (Claude, Codex and Grok)

A plugin can bring its own MCP server. For example, the `expo` plugin brings the
`expo` server. These servers are not in the unified config, and `sync` never
installs them. `list` and `show` read them from the enabled plugins and mark each
row as `(plugin <plugin id>)`. A Codex row also names its home. `list --json`
leaves them out, because `tools scripts` dials every entry in that payload.

-   Claude: a plugin is enabled in `~/.claude/settings.json` `enabledPlugins`. Its
    install folder comes from `~/.claude/plugins/installed_plugins.json` (the user-scope
    install). The folder declares the servers in `.mcp.json`, `mcp.json` or the
    `.claude-plugin/plugin.json` `mcpServers` field.
-   Codex: a plugin is enabled by `[plugins."<plugin>@<marketplace>"]` in `config.toml`.
    Its servers come from the newest version folder under
    `<codex home>/plugins/cache/<marketplace>/<plugin>/`. Every `syncTo` and `syncFrom`
    home is read.
-   Grok: Grok loads the plugins that Claude enables (its Claude compatibility reads
    `~/.claude/plugins/installed_plugins.json`), so `expo` reaches Grok with no Grok entry.
    It also loads its own plugins from `[plugins].paths` and
    `~/.grok/installed-plugins/registry.json` when `[plugins].enabled` names them and
    `[plugins].disabled` does not.

`tools mcp-manager disable expo` checks the unified config first. If `expo` is
not there, the command switches the plugin server off in every harness that
loads it (`-p` limits the harnesses). The plugin itself stays enabled.

-   Claude: the command adds `{ "serverName": "plugin:<plugin>:<server>" }` (here
    `plugin:expo:expo`) to `deniedMcpServers` in `~/.claude/settings.json`. Two plugins
    with the same short name share one entry. Other keys stay as they are.
-   Codex: the command writes `[plugins."<plugin id>".mcp_servers.<server>]` with
    `enabled = false` in every home that enables the plugin. It never writes a bare
    `[mcp_servers.<server>]` table: an entry without a transport stops Codex from
    starting.
-   Grok: the command adds the server name to the top-level `disabled_mcp_servers`
    list in `~/.grok/config.toml`. Grok honours a name there even when no
    `[mcp_servers]` table defines it. The command never adds a table.

`enable expo` removes exactly these entries again. `sync` keeps every switch:
Claude's sync does not write `settings.json`, Codex's sync keeps every
`[plugins.*]` table, and Grok's sync replaces only `[mcp_servers]`. A running
Claude Code, Codex or Grok session keeps the server until you restart it.

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

## Doctor: health-check and debug the servers your clients run

`tools mcp-manager doctor` answers the question you have when an assistant says a tool is unavailable: is the
server configured, does it start, does it respond, and how slow is it. It reads the client config files
(`~/.claude.json`, plus `.mcp.json` and `.cursor/mcp.json` of the project), not the unified config, so it checks
what the clients really use.

```bash
tools mcp-manager doctor list                           # what is configured, without starting anything
tools mcp-manager doctor                                # probe everything (same as `doctor check`)
tools mcp-manager doctor check --only github,jina
tools mcp-manager doctor check --slow 1000              # flag anything over 1s
tools mcp-manager doctor check --timeout 30000          # be patient with slow starters
tools mcp-manager doctor tools jina                     # tools, resources and prompts of one server
tools mcp-manager doctor check --json | tools json
tools mcp-manager doctor check --project ~/some/repo    # include that repo's local config
```

Every option applies to `list`, `check` and `tools`.

| Flag | Description |
|------|-------------|
| `--json` | Emit machine-readable JSON to stdout |
| `--timeout <ms>` | Per-server probe timeout (default: 15000) |
| `--slow <ms>` | Latency above which a server is flagged slow (default: 3000) |
| `--only <names>` | Restrict to comma-separated server names |
| `--project <dir>` | Project root to scan for `.mcp.json` and `.cursor/mcp.json` |

### `list` versus `check`

`list` reads and normalizes configuration. It spawns nothing, so it is instant and safe. It prints four columns:
`SERVER`, `TRANSPORT`, `SOURCE` and `TARGET`, where `TARGET` is the command plus its args for a stdio server, or
the URL for a remote one. `list --json` keeps the NAMES of a server's headers and env keys and replaces their
values with `•••`, because those values are the gateway token, bearer tokens and API keys. Nothing else is masked:
`TARGET`, and the `args` and `url` fields of `list --json`, print as written. A key typed into a command argument or
into a URL (`?api_key=...`) therefore reaches terminal scrollback and CI logs. Keep credentials in `env` or `headers`.

`check` starts each stdio server and connects to each remote one, then completes an MCP handshake and lists the
tools. That is the only way to tell "configured" from "working". A server whose command is missing, whose token
expired, or which crashes on startup only shows up here. Spawning a server runs whatever command its config
names, so `check` executes third-party code. `list` does not.

`check` sends the `headers` of a remote entry on every request, exactly as the client does. Servers behind the
local gateway need `X-Genesis-Mcp-Gateway`, and hosted servers often need `Authorization`. Before this was
fixed the probe sent no headers, and every such server was reported as down with `missing X-Genesis-Mcp-Gateway`
or `invalid_token`.

`check` is a read-only diagnostic: it never refreshes an OAuth token, never opens a login and never writes
configuration. A server behind the gateway is reached through the gateway, so the gateway must be running
(`tools mcp-manager gateway status`). The probe marks its requests with `X-Genesis-Mcp-Diagnostic`. For such a
request the gateway reads the stored token and, when it is missing or expired, answers "needs a login" instead of
refreshing it or starting a login. That server shows as an error until you run `tools mcp-manager auth login <server>`;
`tools mcp-manager auth status` tells you first.

`doctor tools <server>` is the deep look at one server. Use it when an assistant reports a tool name you do not
recognise, or when a server's tool set changed after an upgrade.

`--project` matters because MCP config is layered. A repo can add servers through `.mcp.json` or
`.cursor/mcp.json` that your global config knows nothing about. `${VAR}` references inside a config value are
not expanded; the probe sends the value as written.

To edit configuration rather than diagnose it, use the other commands of this tool.

### `doctor env`: what does the client actually pass to my server

When an MCP server misbehaves in Cursor or Claude Desktop, it is often an env, PATH or cwd problem.
`doctor env` runs the commands you give it and prints one JSON object on stdout: `cwd`, the whole `env`, `path`
(PATH split into entries), and for each command its `exitCode`, `stdout` and `stderr`. The debug lines go to
stderr (visible in the client's debug console). Nothing else reaches stdout, so a client can parse it.

```bash
tools mcp-manager doctor env which playwright            # one command plus the environment it saw
tools mcp-manager doctor env                             # only the environment
COMMANDS="env;which playwright;echo test" tools mcp-manager doctor env
COMMANDS="which bun" tools mcp-manager doctor env echo test    # positional command first, then COMMANDS
tools mcp-manager doctor env -- ls -la                   # `--` lets the command carry its own flags
```

`COMMANDS` holds extra commands separated by `;`. Commands are split on whitespace, with no quote handling. The
exit code of the process is the exit code of the last failing command, or 0. Each command gets `--timeout <ms>`
(default 30000): one that outlives it is killed and reported as failed with a `timed out` error, and the report is
still printed. `-e, --env` is still accepted so
that older client configs keep working. It does nothing, because the report always has the environment.

⚠️ The report prints the **whole** environment, so it contains every token the client passed. Do not paste it
into an issue or a chat unredacted. The stderr dump is kept out of the log file on purpose.

To wire it into a client, use it as the server command and restart the client:

```json
{
  "mcpServers": {
    "debug-me": {
      "command": "tools",
      "args": ["mcp-manager", "doctor", "env", "which", "bun"]
    }
  }
}
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



-   `mcp-web-reader`: Web content fetching MCP server

## Local auth gateway

Remote MCP servers that need OAuth are stored with `auth.gateway: true` and projected into
each harness as `http://127.0.0.1:8318/mcp/<server>`. GenesisTools owns the tokens; the
harness only carries a local gateway header.

| Command | Description |
| --- | --- |
| `gateway install` | Install the gateway as a launchd agent (KeepAlive, RunAtLoad) |
| `gateway up` | Start the installed agent and wait until it answers `/health` |
| `gateway uninstall` | Remove the launchd agent |
| `gateway start` | Run a gateway in the foreground (dies with the terminal) |
| `gateway status` | Listen address, health, and whether an agent supervises it |
| `gateway stop` | Stop listeners this process started |
| `gateway rotate-client` | Rotate the local gateway header, then resync every harness |

**Install it.** Without the agent, the only gateway is the in-process one `ensureGatewayUp`
starts, and that dies with the CLI that started it. A harness launched afterwards then shows
every gateway-backed server as ConnectionRefused, which reads as a broken server rather than
a missing process.

**Logins start themselves.** A request for a server with no usable token makes the gateway
run the OAuth login, open the browser and post a notification, then answer the client with
what is happening. One browser window per server, and a failed login waits 60 seconds before
another attempt, so a reconnecting client cannot open a tab per retry.

The login runs as a detached `src/mcp-manager/index.ts auth login <server>` process, never
inside the gateway and never through the `tools` wrapper, so a gateway restart (crash,
KeepAlive respawn, `gateway up` after a code change) does not kill the callback listener
your browser is about to return to. The parent writes
`~/.genesis-tools/mcp-manager/logins/<server>.json` with the child's pid immediately; a
restarted gateway reads that record and answers "already open" with the link instead of
starting a second login. The notification carries the same link, and clicking it reopens
the page. Servers that need an interactive `client_name` (Figma) are not auto-started:
the 401 names `tools mcp-manager auth login <server>` instead of claiming a browser is
opening. A successful interactive login stores `auth.clientName` so later gateway logins
can pass `--client-name`.

A harness's own "Authenticate" button cannot do this: it runs Dynamic Client Registration
against the gateway's origin, which serves no OAuth metadata and answers 404. Claude Code
reports that as `Dynamic Client Registration rejected (HTTP 404)`.

**Config changes need no restart.** The gateway re-reads the unified config on every request,
so adding or editing a server is picked up immediately and sessions already connected keep
their streams. Reconnect a harness only for a server it has never connected to: Claude Code
retries dropped servers by itself, but a server that failed at startup stays failed until you
press Reconnect in `/mcp`.
