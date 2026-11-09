# tools mcp-manager

Manage the MCP (Model Context Protocol) servers of Claude Code, Codex, Grok, Gemini and Cursor from one unified
config. mcp-manager writes servers into each client's own config file, switches them on and off per client (and per
project for Claude), signs in to OAuth servers through a local gateway that keeps the tokens, and health-checks the
servers your clients really run. Every write shows a diff first and keeps a backup.

## Quick start

```bash
tools mcp-manager list                        # every server in every client, and where it is on
tools mcp-manager sync-from-providers -p all  # import what the clients already have into the unified config
tools mcp-manager sync -p all                 # write the unified config into every client (diff, then confirm)
tools mcp-manager disable github -p claude    # switch a server off; `enable` brings it back
tools mcp-manager doctor                      # start every configured server and report what answers
tools mcp-manager auth login notes            # OAuth sign-in for a remote server; GenesisTools keeps the tokens
```

`tools mcp-manager` with no command opens an interactive menu. Without a terminal it prints the help and exits 1.

## Commands

The clients are called providers: `claude`, `codex`, `grok`, `gemini` and `cursor`.

### Global options

Global options work before or after the command: `tools mcp-manager sync -p all -y`.

| Option | Meaning |
| --- | --- |
| `-p, --provider <name>` | One provider, a comma list, or `all` |
| `-y, --yes` | Write without asking. Read the diff of a run without it first |
| `-v, --verbose` | Verbose logging, and the stack trace of an error |
| `-?, --help-full` | The long help text |
| `--readme` | Print this README |
| `-h, --help` | Help for the tool or for one command |

Without `-p`, `sync`, `sync-from-providers`, `install`, `enable`, `disable` and `rename` ask which providers to use,
and that needs a terminal. `list`, `show`, `backup-all` and `remove` ask nothing: they use every provider unless `-p`
limits them, so `remove <server> -y` without `-p` deletes the server from every provider config. In a script, always
pass `-p`. An unknown provider name exits 1 and prints the valid names.

### Servers and sync

- `config [--path]`: print the unified config path, then open the file in `$VISUAL` or `$EDITOR` (`nano` when
  neither is set). A missing file is created as `{ "mcpServers": {} }`; an existing file that does not parse is never
  replaced. Without a terminal it still creates a missing file and prints the path, but opens no editor. `--path`
  prints the path and creates nothing.
- `sync`: write the unified config into the selected providers. It installs the servers that belong there, removes or
  switches off the ones that do not, and writes OAuth servers as their gateway projection. Each provider gets its own
  diff and confirmation. An explicit `-p <name>` (not `all`) creates that provider's config file when it is missing.
- `sync-from-providers`: read the selected providers and merge their servers into the unified config, with each
  provider's on or off state. When the same name differs in `command`, `args`, `env`, `url` or `type`, it shows both
  and asks which to keep; without a terminal it keeps the current one. Otherwise the provider read last wins.
- `list [--json [--enabled-only]]`: every server in every provider, with its state per provider, plus plugin servers
  and the servers Grok reads from other clients' files. `--json` prints the registry payload (see For agents).
  `--enabled-only` works with `--json` only: it keeps the servers enabled in at least one provider. The human listing
  ignores it.
- `show [server]`: the server's config as each provider stores it, plugin and Grok rows included, on stdout. Secret
  values are masked.
- `install [server] [command-or-url]`: add or update a server in the unified config, then install it into one
  provider. Flags below.
- `enable [servers] [--project <path>] [--clear-project-overrides]`: switch servers on. A provider that lacks the
  server gets it from the unified config first.
- `disable [servers] [--project <path>]`: switch servers off. The full config stays in the unified config, so this is
  reversible.
- `remove [servers]` (alias `purge`): delete servers from the unified config and from every provider config.
  Permanent.
- `rename [oldName] [newName]`: rename a server key in the unified config, then in the selected providers (without a
  terminal: every provider with a config file). When the new name exists, it shows a diff and asks; without a terminal
  it refuses.
- `backup-all`: copy the unified config and every provider config that exists into the backup folder, and print the
  map of original to backup.
- `config-json`: print the servers of the unified config as a client `mcpServers` JSON. Flags below.

Server lists take one name or a comma list: `tools mcp-manager disable github,jina -p claude`. A name must be in the
unified config, except the name of a plugin server for `enable` and `disable`.

#### `install`

```bash
tools mcp-manager install github "npx -y @modelcontextprotocol/server-github" \
    -t stdio \
    -e "GITHUB_TOKEN=<token>" \
    -p claude
tools mcp-manager install notes https://mcp.example.com/mcp -t http -p codex
```

| Flag | Meaning |
| --- | --- |
| `-t, --type <type>` | Transport: `stdio`, `sse` or `http` |
| `-H, --headers <str>` | A header for `http` or `sse`, `"Key: value"`. Repeatable |
| `-e, --env <str>` | An env var for `stdio`, `"KEY=value"`. Repeatable |

- Without a terminal, it needs the name, the command or URL, `--type` and `-p`. Given a name, a command or URL and
  `--type`, it asks nothing, so it then needs `-p` even in a terminal.
- `install <server> -p <provider>` for a server already in the unified config installs it as stored and asks nothing.
- The command string is split on whitespace, with no quote handling.
- An `http` server is stored with both `url` and `httpUrl` (Gemini reads `httpUrl`).
- `install` writes to exactly one provider per run. `-p all` or a comma list is refused. Use `sync` for many.
- The unified entry is written before the provider is chosen, so a run that fails on `-p` has still saved the entry.
- `install` copies the entry as stored. It does not write the gateway projection of an OAuth server: `sync` does.

Headers use a colon, like HTTP headers. Env vars use an equals sign. Both accept JSON instead. Only the first separator
splits, and surrounding quotes around the value are removed.

```bash
--headers "Authorization: Bearer <token>" --headers "X-Api-Key: <key>"
--env "API_KEY=<key>" --env "TOKEN=<token>"
--headers '{"Authorization": "Bearer <token>"}'
--env '{"API_KEY": "<key>", "TOKEN": "<token>"}'
```

#### `config-json`

| Flag | Meaning |
| --- | --- |
| `--client <type>` | `standard` (default), `cursor` or `claude` |
| `--enabled-only` | Only servers enabled for that client (needs `cursor` or `claude`) |
| `--servers <names>` | Only these servers (comma list) |
| `--bare` | Print the server map without the `mcpServers` wrapper |
| `-c, --clipboard` | Copy to the clipboard instead of printing |

`_meta` is stripped. `--client claude` adds a `disabledMcpServers` list of the servers that are not enabled for
Claude, when there are any and not with `--bare`; that is the top-level list Claude Code does not read (see Claude
below). `--enabled-only` with `standard` is ignored with a warning. ⚠️ The output prints `env`, `headers` and `auth`
values as stored, so it can contain secrets.

### OAuth: `auth`

- `auth login [server] [--device] [--client-name <name>]`: discover the server's OAuth metadata, register a client
  (dynamic registration), open the browser on a loopback callback, and store the tokens in the GenesisTools vault.
  It then marks the server `auth.gateway: true` in the unified config (without asking) and starts an in-process
  gateway when none answers. Without a name it offers the HTTP servers of the unified config. `--device` uses the
  device-code grant (it prints a URL and a code). `--client-name` sets the OAuth `client_name` for registration.
  `--worker` is internal: the gateway and the CLI start the login worker with it.
- `auth client <server> --client-id <id> [--redirect-uri <url>]`: store a pre-registered OAuth app for a server
  without dynamic registration. The secret comes from a hidden prompt, or from stdin when stdin is not a terminal.
- `auth logout <server>`: delete the stored tokens and the status row. A stored `auth client` app stays.
- `auth refresh <server>`: use the refresh token when the access token is missing or expires within 60 seconds. A live
  token is kept as it is.
- `auth status [server]`: a table of `SERVER`, `AUTH`, `TOKEN` (`live`, `expired`, `missing`, `none`) and `EXPIRES`
  for every server with an `auth` block or a stored token. It prints the redirect URL of each static-client server, a
  warning when its app is not stored, and a `login:` command for each server that needs one. With a server name it
  also prints the issuer.

A login opens the browser and waits up to 10 minutes for the callback. The authorization server must advertise PKCE
S256. A server stored with `auth.kind` `bearer` or `none` is refused: OAuth login does not apply to it.

### Gateway: `gateway`

| Command | What it does |
| --- | --- |
| `gateway install` | Install the gateway as a launchd agent (macOS only) |
| `gateway up` | Start the installed agent and wait until `/health` answers |
| `gateway status` | Listen address, health, and whether launchd supervises it |
| `gateway start [--port <n>]` | Run a gateway in the foreground (dies with the terminal) |
| `gateway stop` | Stop the listeners this same process started |
| `gateway uninstall` | Remove the launchd agent |
| `gateway rotate-client` | New local gateway token, then you resync every provider |
| `gateway host <server> [--off]` | Serve a server from the gateway for Claude and Codex |
| `gateway stdio --server <name>` | Bridge one HTTP server to a command-only client |

- `install` refuses when a gateway already listens or another process holds the port. It waits for `/health` and
  removes the agent again when the check fails.
- `status` reports `ok`, `down`, or `stranger` (another process holds the port), and prints the command that fixes it.
- `start` refuses when a launchd agent is installed, because a second gateway would race KeepAlive; use `up`. It stops
  on Ctrl-C or SIGTERM. `--port` overrides the configured port for this run.
- `stop` reaches only listeners this process started. There is no pidfile: stop a `gateway start` in another terminal
  with Ctrl-C there, and the agent with `gateway uninstall`.
- `uninstall` ends the launchd job. A gateway started by hand in a terminal survives.
- `rotate-client` writes a new token. A running gateway picks it up, but every provider config still carries the old
  one and is refused until `tools mcp-manager sync -p all -y`.
- `host` is described under "Hosted servers" below.

### Doctor: `doctor`

| Command | What it does |
| --- | --- |
| `doctor list` | Show the servers the clients are configured with; starts nothing |
| `doctor check` | Start or connect to every server and probe it (the default) |
| `doctor tools <server>` | Probe one server and print its tools, resources and prompts |
| `doctor env [command...]` | Print the environment, PATH and cwd a client passes, as JSON |

Options of `list`, `check` and `tools`:

| Flag | Meaning |
| --- | --- |
| `--json` | Machine-readable JSON on stdout |
| `--timeout <ms>` | Per-server probe timeout (default 15000) |
| `--slow <ms>` | Latency above which a server is flagged slow (default 3000) |
| `--only <names>` | Only these servers (comma list) |
| `--project <dir>` | Project root to scan for `.mcp.json` and `.cursor/mcp.json` (default: cwd) |

`doctor env` takes `--timeout <ms>` per command (default 30000). Details are under "Doctor" below.

```bash
tools mcp-manager doctor list                           # what is configured, without starting anything
tools mcp-manager doctor                                # probe everything (same as `doctor check`)
tools mcp-manager doctor check --only github,jina
tools mcp-manager doctor check --slow 1000              # flag anything over 1 s
tools mcp-manager doctor check --timeout 30000          # be patient with slow starters
tools mcp-manager doctor tools jina                     # tools, resources and prompts of one server
tools mcp-manager doctor check --json | tools json
tools mcp-manager doctor check --project ~/Projects/app # include that repo's local config
```

## How it works

### The unified config and the two sync directions

The unified config (`~/.genesis-tools/mcp-manager/config.json`) holds every server once, with its on or off state per
provider in `_meta.enabled`. `sync` projects it into each provider's file; `sync-from-providers` reads the provider
files back into it. `_meta` never leaves the unified config. `enable`, `disable`, `install`, `remove` and `rename`
change both sides in one run.

A typical start: import with `sync-from-providers -p all`, edit with `config`, then write with `sync -p all`.

Give a server you add by hand with `config` a `_meta.enabled` entry for each provider, or add it with `install` or
`enable`, which record `true`. A provider with no entry is read as off by Codex, Cursor and Gemini: `sync` removes the
server from `~/.codex/config.toml` and `~/.cursor/mcp.json`, and puts it on Gemini's `mcp.excluded` list (see
Configuration).

### Writes: diff, confirm, backup

Every write to a provider config or to the unified config goes the same way:

1. When the new content equals the old one, nothing happens.
2. It prints `Changes to <path>:` and a diff from the system `diff -U 20`. Secret values are masked in the diff,
   because the diff also goes to the day log: credential headers, env names that read like a secret
   (`API_KEY`, `PASSWORD`), `--token=` style arguments, and tokens with a known prefix (`ghp_`, `sk-`, `sbp_`). On
   2026-10-13 a sync diff printed two Sentry tokens and a Supabase token in clear; that is why.
3. It asks `Are these changes okay?`. With `-y` it does not ask.
4. Without a terminal and without `-y`, it prints `!!! CHANGES NOT APPLIED !!!` and writes nothing. That run is the
   dry run: a yellow banner at the top says to review the diff below it.
5. On yes, it copies the current file to the backup folder (mode 0600), then writes the new file atomically, so a full
   disk or a crash never leaves a truncated config. A provider config is written with mode 0600. The unified config
   keeps the mode it already has (a new file gets the umask default).

The diff is colored (red removed, green added, cyan hunk headers). A run looks like this (the real output prints the
absolute path where this shows `~`):

```
Changes to ~/.claude.json:

--- old
+++ new
@@ -1,6 +1,10 @@
   "mcpServers": {
+    "github": {
+      "command": "npx",
+      "args": ["-y", "@modelcontextprotocol/server-github"]
+    },
     "filesystem": {
       "command": "npx",
? Are these changes okay? (Y/n) y
✓ Configuration written to ~/.claude.json
```

A declined change writes nothing, so there is nothing to restore. `remove` is the one command that undoes its own
provider writes: when the unified write is declined or fails, it puts the servers back into the providers that
already removed them.

Backups live in `~/.mcp-manager/backups/` as `<provider>-<file>-<timestamp>.backup`. They are never pruned.

```
~/.mcp-manager/backups/claude-.claude.json-2026-01-15T10-30-45-123Z.backup
~/.mcp-manager/backups/gemini-settings.json-2026-01-15T10-30-45-123Z.backup
~/.mcp-manager/backups/unified-config.json-2026-01-15T10-30-45-123Z.backup
```

To restore one by hand, copy the backup file over the original path.

### Files

| Path | What it holds |
| --- | --- |
| `~/.genesis-tools/mcp-manager/config.json` | The unified config |
| `~/.genesis-tools/mcp-manager/auth-status.json` | Last known auth state per server |
| `~/.genesis-tools/mcp-manager/logins/<server>.json` | A login in flight (pid, URL) |
| `~/.genesis-tools/mcp-manager/locks/` | Token refresh and credential locks |
| `~/.genesis-tools/mcp-manager/hosted/` | Sockets of hosted server children |
| `~/.genesis-tools/security/vault.json` | The vault: OAuth tokens and the gateway token |
| `~/.genesis-tools/logs/mcp-gateway.log` | Gateway log (launchd agent) |
| `~/.genesis-tools/logs/mcp-login-<server>.log` | Log of a detached login worker |
| `~/.mcp-manager/backups/` | Backups of every config before each write |
| `~/Library/LaunchAgents/com.genesis-tools.mcp-gateway.plist` | The launchd agent |

Vault entries are `mcp/<server>/access-token`, `refresh-token`, `token-expires-at`, `client-id`, `client-secret`,
`static-client-id` and `static-client-secret`, plus `mcp/gateway/client-token` for the local gateway header.

### Providers

| Provider | Config file | Off switch |
| --- | --- | --- |
| `claude` | `~/.claude.json` | Absent from `mcpServers` (global), or a project list |
| `codex` | `~/.codex/config.toml` | Absent (presence means enabled) |
| `grok` | `~/.grok/config.toml` | `enabled = false`, or `disabled_mcp_servers` |
| `gemini` | `~/.gemini/settings.json` | The `mcp.excluded` list |
| `cursor` | `~/.cursor/mcp.json` | Absent (presence means enabled) |

Each provider converts between its own format and the unified format. A command only touches providers whose config
file exists, except `sync -p <name>`, which may create it.

#### Claude Code (`~/.claude.json`)

The file is `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, and the user settings are
`$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). The file holds global servers (`mcpServers`)
and project servers (`projects[<path>].mcpServers`), over stdio, SSE and HTTP.

Recorded against Claude Code 2.1.296 on 2026-10-13 ([evidence and recheck procedure](claude-code-disable-evidence.md)):
Claude Code reads `disabledMcpServers` only from per-project entries (`projects[<cwd>].disabledMcpServers`). The
top-level `disabledMcpServers` key is never read by Claude Code: it is an mcp-manager marker. The only global switch
Claude Code honours (future projects included) that one project can still override is the server not being in
`mcpServers` at all. A `deniedMcpServers` entry in `~/.claude/settings.json` is global and costs no tokens, but no
project setting can lift it (it also blocks a project-scope or `.mcp.json` server of the same name), so mcp-manager
does not use it for a global disable.

Global means the global switch only. A global disable, a global enable, an install and a `sync` never write the
per-project `disabledMcpServers` lists in `~/.claude.json`. Only a named project writes its own list. The one opt-in
exception is `enable --clear-project-overrides`. A dry run of `sync` once wanted to add one disabled server to the
lists of all 98 projects (about 640 diff lines). That is why the old sweep was removed on 2026-10-13.

mcp-manager therefore implements a true global disable for Claude:

- **Global disable** (`disable <server> -p claude`):
  1. Keeps the server's full config in the unified config with `_meta.enabled.claude = false` (it imports the entry
     there first if it is missing; the entry is never removed unless it is safely kept). If the config cannot be
     kept, the entry stays, Claude Code still loads the server everywhere, and a warning says so.
  2. Keeps the top-level marker.
  3. Removes the entry from `mcpServers` in `~/.claude.json`.
- **Global enable** restores the entry into `mcpServers` from the unified config and drops the top-level marker. It
  does not change project lists. When some projects still list the server (old entries from the removed sweep, or a
  per-project disable), the server stays off in those projects, and one warning gives the count and the two commands
  below.
- **Global enable with `--clear-project-overrides`** (`enable <server> -p claude --clear-project-overrides`) also takes
  the name off every `projects[<path>].disabledMcpServers` list that still names it, and prints how many lists it
  changed. Other names on those lists stay. A project with a project-scope entry counts too, because its list switches
  the server off there as well. The flag applies only to a global Claude enable: with `--project`, or for a provider
  without project lists, the command says that it does not apply.
- **Per-project disable or enable** (`--project <path>`) is the only command that writes a project's
  `disabledMcpServers` list, and only for the named projects. The global entry stays in `mcpServers`.
- **`list`** shows a globally disabled server (absent from `~/.claude.json`) as `disabled` for claude, from the unified
  config, instead of "not installed".
- **`sync`** treats `_meta.enabled.claude === false` as disabled by absence: such a server is never (re)installed into
  `mcpServers`, and a drifted entry is removed. For `true`, `false` or an unset state, `sync` writes no project list.
  For a per-project map (`{ "/abs/path": false }`), it writes only the lists of the projects the map names, and creates
  no project entry.
- **`sync-from-providers`** does not read the absence of a globally disabled server as "the user deleted it": the
  unified entry and its `_meta.enabled.claude = false` stay.

Without `-p`, an interactive `enable` or `disable` asks, for each provider with projects (Claude), which projects to
change, or "Global". With `-p` and no `--project`, it applies globally.

##### Per-project enable override

A global disable can be lifted for single projects:

```bash
tools mcp-manager enable <server> \
    -p claude \
    --project ~/Projects/app \
    --project ~/Projects/site \
    -y
```

- It writes the server's Claude config into `projects[<path>].mcpServers.<name>` in `~/.claude.json`, which Claude
  Code honours (it is the same storage `claude mcp add -s local` uses), and removes the name from that project's
  `disabledMcpServers` list.
- The global state stays disabled: the server remains absent from the global `mcpServers`, and
  `_meta.enabled.claude` stays `false`. The project-scope entry alone records the override; there is no extra
  metadata.
- A global disable and `sync` never delete the project-scope entry, and never put the name back on that project's
  list (a per-project map in `sync` skips that project too). `sync` refreshes the entry from the unified config.
  `sync-from-providers` keeps `_meta.enabled.claude === false` even though the override projects report the server as
  enabled.
- `list` shows such a server as `disabled globally, enabled in N project(s)`.
- Undo with `disable <server> -p claude --project <path>`: it removes the project-scope entry and puts the name back on
  that project's list.
- `--project` is repeatable and takes comma-separated paths. `-p all` works for `enable` and `disable` and means every
  provider with a config file. On a provider without projects, `--project` gives a warning and the switch applies
  globally there.

##### `remove` versus `disable`

`disable` is reversible: the full config stays in the unified config, and `enable` restores it anywhere. `remove`
(alias `purge`) is permanent. It deletes the server from the unified config (`mcpServers.<name>` and the
`enabledMcpServers.<name>` mirror) and from every selected provider config:

- claude `~/.claude.json` `mcpServers`, global and project-scope entries (the per-project `disabledMcpServers` lists
  keep the name as a harmless leftover);
- cursor `~/.cursor/mcp.json`;
- gemini `~/.gemini/settings.json` (`mcpServers` and `mcp.excluded`);
- codex `~/.codex/config.toml` (`[mcp_servers.<name>]` with its nested `.env` and `.http_headers` tables; `[projects.*]`
  and `[notice]` stay);
- grok `~/.grok/config.toml` (`[mcp_servers.<name>]`; a name on `disabled_mcp_servers` stays there).

`remove` reads no `harnesses` block, so it touches only the default `~/.codex` and `~/.grok` homes. An extra Codex
home keeps the server (see Troubleshooting). Each write shows the usual diff and confirmation. When a provider fails
or you decline it, the unified entries stay, so you can run `remove` again.

#### Codex (`~/.codex/config.toml`)

- TOML, parsed with `@iarna/toml`. A server is enabled when it exists, so `disable` removes the table.
- HTTP servers use `[mcp_servers.<name>.http_headers]`, not `headers`. A destination HTTP server that still uses
  `headers` is rewritten with `http_headers`.
- Extra Codex homes (for example `~/.codex-work`) go under `harnesses.codex` in the unified config (see
  Configuration). Extra homes keep their own servers and their home-bound env (such as the `node_repl` server's
  `CODEX_HOME`).

#### Grok (`~/.grok/config.toml`)

Grok runs more than its own `[mcp_servers]` tables. Measured on Grok 1.0.44 (2026-10-13) with `grok inspect --json`
and `grok mcp doctor --json` in an isolated home:

- Sources, highest priority first: a `config.toml` table, a plugin server (Claude-enabled plugins and Grok's own),
  `~/.claude.json` top-level `mcpServers`, then `~/.cursor/mcp.json` and a project `.mcp.json`. On a name clash Grok
  runs one server: the highest source wins. A `config.toml` table wins even with `enabled = false`, so such a table
  switches the Claude copy off as well.
- Grok also reads `~/.claude.json` `projects[<cwd>].mcpServers` for the folder it starts in (a project-scoped server
  needs a trusted folder). `[compat.claude] mcps = false` stops every `~/.claude.json` source, and
  `[compat.cursor] mcps = false` stops `~/.cursor/mcp.json`.
- Claude's own switches do not reach Grok: a project's `disabledMcpServers` and the `deniedMcpServers` setting leave
  the server running in Grok. Only `disabled_mcp_servers` in `config.toml`, or a table with `enabled = false`, keeps a
  server off there.

mcp-manager follows that model:

- `list` and `show` name the source of each Grok row: `grok (config.toml)`, `grok (~/.claude.json)`,
  `grok (~/.cursor/mcp.json)` or `grok (plugin <id>)`. A row that a higher source shadows is not shown. Project-scoped
  Claude servers are not shown, because they depend on the folder Grok starts in.
- `sync` writes a table only for a server with an explicit grok decision in the unified config (`_meta.enabled.grok`
  true or false). With no grok decision, the existing table stays exactly as it is and no table is created, so a sync
  never turns off a server Grok runs. An enabled server that Grok already gets with the same definition from a
  plugin, `~/.claude.json` or `~/.cursor/mcp.json` gets no `config.toml` copy. A different definition (for example the
  gateway projection) does get a table, and that table wins. Tables that the sync does not name stay.
- `disable <server> -p grok` sets `enabled = false` on a table. For a server that Grok takes from another file, it adds
  the name to `disabled_mcp_servers` instead. `enable` reverses both, and also removes the name from that list when a
  table exists, because the list would keep the server off.

#### Gemini (`~/.gemini/settings.json`)

The settings file of Gemini CLI and Gemini Code Assist. Stdio and HTTP servers (HTTP through `httpUrl`). A server is
switched off by its name on the `mcp.excluded` list, not by a per-server flag.

#### Cursor (`~/.cursor/mcp.json`)

JSON with stdio and URL entries. A server is enabled when it exists, so `disable` removes it. `sync` writes an OAuth
gateway server into Cursor as the stdio bridge (`tools mcp-manager gateway stdio --server <name>`), not as a URL.

### Plugin-provided servers (Claude, Codex and Grok)

A plugin can bring its own MCP server. For example, the `expo` plugin brings the `expo` server. These servers are not
in the unified config, and `sync` never installs them. `list` and `show` read them from the enabled plugins and mark
each row as `(plugin <plugin id>)`. A Codex row also names its home. `list --json` leaves them out, because
`tools scripts` dials every entry in that payload.

- Claude: a plugin is enabled in `~/.claude/settings.json` `enabledPlugins`. Its install folder comes from
  `~/.claude/plugins/installed_plugins.json` (the user-scope install). The folder declares the servers in `.mcp.json`,
  `mcp.json` or the `.claude-plugin/plugin.json` `mcpServers` field.
- Codex: a plugin is enabled by `[plugins."<plugin>@<marketplace>"]` in `config.toml`. Its servers come from the newest
  version folder under `<codex home>/plugins/cache/<marketplace>/<plugin>/`. Every `syncTo` and `syncFrom` home is
  read.
- Grok: Grok loads the plugins that Claude enables (its Claude compatibility reads
  `~/.claude/plugins/installed_plugins.json`), so `expo` reaches Grok with no Grok entry. It also loads its own plugins
  from `[plugins].paths` and `~/.grok/installed-plugins/registry.json` when `[plugins].enabled` names them and
  `[plugins].disabled` does not.

`tools mcp-manager disable expo` checks the unified config first. If `expo` is not there, the command switches the
plugin server off in every harness that loads it (`-p` limits the harnesses). The plugin itself stays enabled.
`--project` does not apply: the switch is global.

- Claude: the command adds `{ "serverName": "plugin:<plugin>:<server>" }` (here `plugin:expo:expo`) to
  `deniedMcpServers` in `~/.claude/settings.json`. Two plugins with the same short name share one entry. Other keys stay
  as they are.
- Codex: the command writes `[plugins."<plugin id>".mcp_servers.<server>]` with `enabled = false` in every home that
  enables the plugin. It never writes a bare `[mcp_servers.<server>]` table: an entry without a transport stops Codex
  from starting.
- Grok: the command adds the server name to the top-level `disabled_mcp_servers` list in `~/.grok/config.toml`. Grok
  honours a name there even when no `[mcp_servers]` table defines it. The command never adds a table.

`enable expo` removes exactly these entries again. `sync` keeps every switch: Claude's sync does not write
`settings.json`, Codex's sync keeps every `[plugins.*]` table, and Grok's sync replaces only `[mcp_servers]`. A running
Claude Code, Codex or Grok session keeps the server until you restart it.

### The local auth gateway

Remote MCP servers that need OAuth are stored with `auth.gateway: true` and projected into each harness as
`http://127.0.0.1:8318/mcp/<server>` with an `X-Genesis-Mcp-Gateway` header. GenesisTools owns the tokens; the harness
only carries the local gateway header. The gateway adds the real token to each upstream request and refreshes it
when needed. It answers only loopback requests, and `gateway.listen.host` must be a loopback address.

The usual flow for an OAuth server:

```bash
tools mcp-manager install notes https://mcp.example.com/mcp -t http -p claude
tools mcp-manager auth login notes          # browser sign-in; stores tokens, marks auth.gateway
tools mcp-manager gateway install           # once per Mac: a gateway that survives reboots
tools mcp-manager sync -p all               # every harness now gets the gateway URL
```

**Install it.** Without the agent, the only gateway is the in-process one that `auth login` and `gateway stdio` start,
and that dies with the CLI that started it. A harness launched afterwards then shows every gateway-backed server as
ConnectionRefused, which reads as a broken server rather than a missing process. The agent runs
`bun <checkout>/tools mcp-manager gateway start --supervised` from the checkout that installed it, so install it from
the checkout you keep.

**Config changes need no restart.** The gateway re-reads the unified config on every request, so adding or editing a
server is picked up immediately, and sessions already connected keep their streams. Reconnect a harness only for a
server it has never connected to: Claude Code retries dropped servers by itself, but a server that failed at startup
stays failed until you press Reconnect in `/mcp`.

**Logins start themselves.** A request for a server with no usable token makes the gateway run the OAuth login, open
the browser and post a macOS notification, then answer the client with what is happening. One browser window per
server, and a failed login waits 60 seconds before another attempt, so a reconnecting client cannot open a tab per
retry.

The login runs as a detached `src/mcp-manager/index.ts auth login <server> --worker` process, never inside the gateway
and never through the `tools` wrapper, so a gateway restart (a crash, a KeepAlive respawn, a restart after a code
change) does not kill the callback listener your browser is about to return to. A plain `auth login` in a terminal
starts the same detached worker, so a killed CLI cannot take the callback port with it. The parent writes
`~/.genesis-tools/mcp-manager/logins/<server>.json` with the child's pid immediately; a restarted gateway reads that
record and answers "already open" with the link instead of starting a second login. The notification carries the same
link, and clicking it reopens the page.

Servers that need an interactive `client_name` (Figma) are not auto-started: the 401 names
`tools mcp-manager auth login <server>` instead of claiming a browser is opening. Measured 2026-08-31: Figma's dynamic
registration accepts only `client_name` values that start like Claude Code's, and refuses the default
`Genesis Tools (mcp-manager)` with HTTP 403. So for a Figma URL without `--client-name`, `auth login` asks for the
client name before it registers, and offers `Claude Code (genesis-tools)` or Cancel. It never picks that name by
itself. Without a terminal it exits 1 and prints the command to run:

```bash
tools mcp-manager auth login <server> --client-name "Claude Code (genesis-tools)"
```

When a registration still gets a 403, `auth login` prints the same retry command. A successful interactive login
stores `auth.clientName`, so later gateway logins pass `--client-name`.

A harness's own "Authenticate" button cannot do this: it runs Dynamic Client Registration against the gateway's
origin, which serves no OAuth metadata and answers 404. Claude Code reports that as
`Dynamic Client Registration rejected (HTTP 404)`.

#### Servers without dynamic registration (HubSpot)

Some servers publish no `registration_endpoint`, so mcp-manager cannot register an OAuth client by itself. HubSpot's
official MCP (`https://mcp.hubspot.com`) is one. Create the app by hand at the provider (HubSpot: Development, then MCP
Connectors, then Create) and enter this redirect URL exactly:

```
http://127.0.0.1:8320/callback
```

Then store the app and log in:

```bash
tools mcp-manager install hubspot https://mcp.hubspot.com -t http -p claude
tools mcp-manager auth client hubspot --client-id <id>   # secret: hidden prompt, or pipe it on stdin
tools mcp-manager auth login hubspot
tools mcp-manager auth status hubspot                    # prints the redirect URL again
tools mcp-manager sync -p all
```

`auth client` sets `auth.policy` to `static-client` and stores the client ID and secret in the GenesisTools vault
(`mcp/<server>/static-client-*`). The secret is never an argument and never goes into the unified config, a provider
config or a log. `auth logout` keeps the stored app; running `auth client` again replaces it, and a different client ID
clears the old tokens, so that app must log in again.

The login uses the stored app with PKCE S256 and sends `client_secret` in the POST body (`client_secret_post`), for the
code exchange and for every refresh. The callback binds port 8320 (`WEB_SERVICES["mcp-oauth-callback"]`), not a random
port, because the provider matches the redirect URL exactly. A different loopback URL is possible with
`auth client --redirect-uri http://127.0.0.1:<port>/<path>` (it must be `http`, `127.0.0.1` and an explicit port); the
app at the provider must then list that one. When the gateway gets a request for such a server and no app is stored,
its 401 names the `auth client` command and the redirect URL instead of opening a browser.

#### The stdio bridge

`gateway stdio --server <name>` reads newline JSON-RPC on stdin, posts each message over HTTP and writes the answers to
stdout. Use it for a client that can only start a command, such as Claude Desktop or Cursor:

```json
{ "command": "tools", "args": ["mcp-manager", "gateway", "stdio", "--server", "notes"] }
```

Where the messages go depends on the server's unified entry:

- An OAuth server with `auth.gateway: true`, or a gateway-hosted server, goes through the local gateway, which adds the
  token. The bridge starts the gateway if needed and sends only the local gateway header.
- Any other `http` server goes straight to its `url` with the `headers` of its unified entry. The header values stay
  inside the bridge process: they are not in the client's config, in argv or in a log line (the log names the headers,
  not their values).
- A stdio or `sse` server is refused, because the client can start a stdio command itself and the bridge speaks
  Streamable HTTP only.

The bridge does not negotiate a protocol version: the client's own messages go through as written. A server that
speaks only protocol version 2026-07-28 or later needs a client of that version, because such a server refuses an
`initialize` of an earlier version. For a message that carries `_meta["io.modelcontextprotocol/protocolVersion"]`, the
bridge adds the headers the 2026-07-28 HTTP transport requires (`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`),
because a stdio message has no headers of its own. It does not add `Mcp-Param-*` headers for tool arguments marked
`x-mcp-header`: those need the tool's schema.

#### Hosted servers (`gateway host`)

`gateway host <server>` serves a stdio server from the gateway for the harnesses whose MCP client the gateway can
identify per request: Claude and Codex. They get an HTTP entry pointing at the gateway instead of starting one stdio
child per session. The other providers keep the stdio definition, which stays stored in the unified config. Cursor
sends no identity, and Grok passes its session id only in a stdio child's env.

- Only `genesis-tools` can be hosted. Its `GENESIS_TOOLS_MCP_CAPABILITIES` env value becomes the
  `X-Genesis-Mcp-Capabilities` header of the HTTP entry.
- The command sets `_meta.gatewayHosted` in the unified config, then syncs only that server into Claude and Codex.
  `--off` removes the flag and gives them the stdio definition back.
- It shows every diff first. Without a terminal and without `-y`, it is a dry run. A declined unified write leaves the
  harness configs as they are.
- It warns when the gateway is not up, because the switched harnesses fail until it is.
- The server runs in a child process the gateway starts, never in the gateway itself. The launchd gateway lives for
  days, and an in-process import kept its first code for good (2026-10-27: a gateway started on 2026-10-19 still ran
  week-old code). The child exits once its source changes, and the next call starts the new code; the gateway needs no
  restart.
- Running sessions keep the server they started with until they restart.

### Doctor

`doctor` answers the question you have when an assistant says a tool is unavailable: is the server configured, does it
start, does it respond, and how slow is it. It reads the client config files, not the unified config, so it checks what
the clients really use: `~/.claude.json` (top-level `mcpServers`), then the project's `.mcp.json`, then the project's
`.cursor/mcp.json`. A later file overrides a server of the same name. It does not read Codex, Grok, Gemini or the
global `~/.cursor/mcp.json`, and it never sees claude.ai connectors or plugin servers.

**`list` versus `check`.** `list` reads and normalizes configuration. It spawns nothing, so it is instant and safe. It
prints four columns: `SERVER`, `TRANSPORT`, `SOURCE` and `TARGET`, where `TARGET` is the command plus its args for a
stdio server, or the URL for a remote one. `doctor list --json` keeps the names of a server's headers and env keys and
replaces their values with `•••`, because those values are the gateway token, bearer tokens and API keys. Nothing else
is masked: `TARGET`, and the `args` and `url` fields of the JSON, print as written. A key typed into a command argument
or into a URL (`?api_key=...`) therefore reaches terminal scrollback and CI logs. Keep credentials in `env` or
`headers`.

`check` starts each stdio server and connects to each remote one, four at a time, then completes an MCP handshake and
lists the tools. That is the only way to tell "configured" from "working". A server whose command is missing, whose
token expired, or which crashes on startup only shows up here. Spawning a server runs whatever command its config
names, so `check` executes third-party code. `list` does not. The table has `SERVER`, `SOURCE`, `STATUS` (`ok`,
`slow`, `timeout`, `error`, `invalid`), `LATENCY`, `TOOLS` and `NOTE`, and a list of tool names that more than one
server registers.

`check` sends the `headers` of a remote entry on every request, exactly as the client does. Servers behind the local
gateway need `X-Genesis-Mcp-Gateway`, and hosted servers often need `Authorization`. Before this was fixed the probe
sent no headers, and every such server was reported as down with `missing X-Genesis-Mcp-Gateway` or `invalid_token`.

`check` is a read-only diagnostic: it never refreshes an OAuth token, never opens a login and never writes
configuration. A server behind the gateway is reached through the gateway, so the gateway must be running
(`tools mcp-manager gateway status`). The probe marks its requests with `X-Genesis-Mcp-Diagnostic`. For such a request
the gateway reads the stored token and, when it is missing or expired, answers "needs a login" instead of refreshing it
or starting a login. That server shows as an error until you run `tools mcp-manager auth login <server>`;
`tools mcp-manager auth status` tells you first.

`doctor tools <server>` is the deep look at one server. Use it when an assistant reports a tool name you do not
recognise, or when a server's tool set changed after an upgrade. An unknown name exits 1.

`--project` matters because MCP config is layered. A repo can add servers through `.mcp.json` or `.cursor/mcp.json`
that your global config knows nothing about. `${VAR}` references inside a config value are not expanded; the probe
sends the value as written.

#### `doctor env`: what does the client actually pass to my server

When an MCP server misbehaves in Cursor or Claude Desktop, it is often an env, PATH or cwd problem. `doctor env` runs
the commands you give it and prints one JSON object on stdout: `success`, `exitCode`, `cwd`, the whole `env`, `path`
(PATH split into entries), and for each command its `exitCode`, `stdout` and `stderr`. The debug lines go to stderr
(visible in the client's debug console). Nothing else reaches stdout, so a client can parse it.

```bash
tools mcp-manager doctor env which playwright                  # one command plus the environment it saw
tools mcp-manager doctor env                                   # only the environment
COMMANDS="env;which playwright;echo test" tools mcp-manager doctor env
COMMANDS="which bun" tools mcp-manager doctor env echo test    # positional command first, then COMMANDS
tools mcp-manager doctor env -- ls -la                         # `--` lets the command carry its own flags
```

`COMMANDS` holds extra commands separated by `;`. Commands are split on whitespace, with no quote handling. The exit
code of the process is the exit code of the last failing command, or 0. Each command gets `--timeout <ms>` (default
30000): one that outlives it is killed and reported as failed with a `timed out` error, and the report is still
printed. `-e, --env` is still accepted so that older client configs keep working. It does nothing, because the report
always has the environment.

⚠️ The report prints the whole environment, so it contains every token the client passed. Do not paste it into an
issue or a chat unredacted. The stderr dump is kept out of the log file on purpose.

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

### What it needs and what it costs

- Bun and this repository; the TOML providers use `@iarna/toml`, diffs use the system `diff`, prompts use
  `@inquirer/prompts`, and `doctor` uses `@modelcontextprotocol/client`.
- `gateway install` needs macOS (launchd). The rest runs anywhere Bun runs.
- `auth` commands, the gateway and every sync that includes a gateway server read the GenesisTools vault, which needs
  its master key (`GENESIS_TOOLS_MASTER_KEY`, the keychain, or a key file). A sync dry run (no terminal and no `-y`)
  only reads the gateway token. Any other sync mints a missing token before it shows the diff, so a run in a terminal
  that you then decline has still created the vault entry.
- An OAuth login opens your default browser. Auto-started logins post macOS notifications.
- mcp-manager calls no paid API. `doctor check` starts every configured stdio server, which runs that server's code.

### Code layout and tests

- `index.ts` registers the commands; `commands/` holds one file per command.
- `utils/providers/<name>.ts` holds one class per provider, each extending `MCPProvider` (`utils/providers/types.ts`)
  and converting with `toUnifiedConfig` and `fromUnifiedConfig`. `defaultProviders()` in `utils/providers/index.ts` is
  the one list of providers; `tools scripts` builds its registry from it too.
- `utils/backup.ts` (`BackupManager`) owns the diff, the confirmation and the backups.
- `lib/auth/` is OAuth (discovery, login, tokens, the vault), `lib/gateway/` the gateway, `lib/doctor/` the doctor.
- Tests: `bun run test src/mcp-manager/`. The command tests and their mocks are described in
  [commands/__tests__/TESTING_GUIDE.md](commands/__tests__/TESTING_GUIDE.md).
- [Analysis.md](Analysis.md) records the config formats of each client. [EnhancePlan.md](EnhancePlan.md) is an older
  list of ideas, not a description of the current commands.

## Configuration

The unified config, `~/.genesis-tools/mcp-manager/config.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "<token>" },
      "_meta": { "enabled": { "claude": true, "codex": true, "cursor": false } }
    },
    "notes": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "httpUrl": "https://mcp.example.com/mcp",
      "auth": { "kind": "oauth", "gateway": true },
      "_meta": { "enabled": { "claude": { "/abs/path/app": true } } }
    }
  },
  "gateway": { "listen": { "host": "127.0.0.1", "port": 8318 } },
  "harnesses": {
    "codex": {
      "syncTo": { "homes": ["~/.codex", "~/.codex-work"] },
      "syncFrom": { "homes": ["~/.codex"] }
    }
  }
}
```

Server fields:

| Field | Meaning |
| --- | --- |
| `type` | `stdio`, `sse` or `http` |
| `command`, `args`, `env` | A stdio server |
| `url`, `headers` | An `sse` or `http` server |
| `httpUrl` | The HTTP URL Gemini reads |
| `auth` | OAuth state that `auth login` and `auth client` write |
| `_meta.enabled.<provider>` | `true`, `false`, or a map of project path to boolean |
| `_meta.gatewayHosted` | Set by `gateway host` |

- `_meta` stays in the unified config and is stripped from every provider write. When `_meta.enabled` has no state
  for a provider, `sync` reads it per provider:
  - Claude: on. The server is installed.
  - Codex and Cursor: off. `sync` removes the entry from their config.
  - Gemini: off. `sync` writes the server and puts its name on `mcp.excluded`.
  - Grok: no decision. `sync` leaves the table as it is and creates none.
- `enabledMcpServers` at the top level is a mirror of every `_meta.enabled`, rebuilt on each read and write. On each
  read, the mirror wins over `_meta.enabled` for every provider it names. When you edit `_meta.enabled` by hand,
  change or delete the matching `enabledMcpServers` entry too, or the next command puts the old state back.
- `auth` holds `kind` (`oauth`, `bearer`, `none`), `gateway`, `resource`, `authorizationServer`, `tokenEndpoint`,
  `clientName`, `policy` and `redirectUri`. `policy` is `open-dcr` (the default), `static-client` (set by
  `auth client`), `device-code` (always use the device grant) or `figma-client-name` (default client name
  `Claude Code (genesis-tools)`). Tokens are never in this file.
- A file without `mcpServers` reads as empty.

Other top-level keys:

- `gateway.listen.host` (default `127.0.0.1`, must be loopback) and `gateway.listen.port` (default 8318).
- `harnesses.<provider>.syncTo.homes` and `.syncFrom.homes`. The first `sync` or save fills every missing provider with
  its default: claude `~/.claude.json`, gemini `~/.gemini/settings.json`, cursor `~/.cursor/mcp.json`, codex
  `~/.codex`, grok `~/.grok`. Only Codex and Grok read this block, and only these commands load it: `sync`,
  `sync-from-providers`, the human `list`, `show`, `enable`, `disable` and `gateway host`. `install`, `remove`,
  `rename`, `backup-all` and `list --json` always use the default `~/.codex` and `~/.grok`.
  - Codex: `syncTo.homes` is where `sync` writes; `syncFrom.homes` is what `list` and `sync-from-providers` read, the
    first home winning a name clash. `enable` and `disable` write only the first `syncTo` home, so reading a second
    home never moves a server into it. `install` writes `~/.codex/config.toml` even when the first `syncTo` home is
    another one.
  - Grok: the first `syncTo` home is the Grok home whose `config.toml` those commands read and write.
  - Claude, Gemini and Cursor build their path from the home folder (and `CLAUDE_CONFIG_DIR`) and ignore the block;
    their entries only show the paths in use.

Environment variables:

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Claude's folder: `.claude.json` and `settings.json` are read there |
| `VISUAL`, `EDITOR` | The editor `config` opens (default `nano`) |
| `COMMANDS` | Extra `;`-separated commands for `doctor env` |
| `GENESIS_TOOLS_HOME` | Replaces the home folder that holds `.genesis-tools/` (tests use it) |

## For agents

- Never rely on a prompt. Pass `-p` and the server names. Without a terminal and without `-p`, `sync`,
  `sync-from-providers` and `install` exit 1; `enable` and `disable` print `--provider required in non-interactive
  mode` and do nothing, but exit 0. The exception is a plugin server name such as `expo`: `enable` and `disable`
  switch it in every harness that loads it, even without `-p` (as a dry run without `-y`). `remove`, `rename` and
  `show` need their names, and `install` also needs the command or URL and `--type`.
- A write without a terminal and without `-y` is a dry run: it prints the diffs and `CHANGES NOT APPLIED`, and writes
  nothing. Run it, read the diff, then repeat with `-y`.
- `list --json` prints `{ servers, providersScanned, providersFailed }`. Each server has `name`, `enabled`, `status`
  (`enabled`, `partial`, `disabled`), `providers` (`provider`, `enabled`), `connection` (`type`, `command`, `args`,
  `env`, `url`, `headers`), and for an OAuth gateway server `upstream.url` and `auth`. Header values are masked as
  `•••`; `env` and `args` print as written. Plugin servers and Grok's compat rows are left out. A provider missing from
  both lists had no config file. The field names are a contract: `tools scripts` and the mcp-scripting skill build
  their server definitions from it, so add fields rather than rename them. In-process callers use `buildListJson`
  from `commands/list.ts`.
- `show <server>` prints the masked configs on stdout.
- `doctor check --json` prints `{ servers, duplicates, summary }`. It exits 0 whatever the probes found: read
  `summary.error` and `summary.timeout`. With no configured server it prints no JSON, only a warning, so stdout is
  empty. `doctor tools <server> --json` prints one probe result; `doctor list --json` prints `{ servers }`, and
  `{ "servers": [] }` when nothing is configured.
- `doctor env` prints one JSON object on stdout, and its exit code is that of the last failing command.
- Gateway and auth commands set exit code 1 on failure (a busy port, no launchd agent, an unknown server).
- `auth login` opens a browser and waits for a person. In an agent, run it only when the user can sign in.
- mcp-manager is not an MCP server itself. The mcp-scripting skill reaches the configured servers through
  `tools scripts`.

## Troubleshooting

- **`!!! CHANGES NOT APPLIED !!!`.** You ran a write without a terminal and without `-y`. Read the diff, then repeat
  the command with `-y`.
- **`--provider required in non-interactive mode`.** Pass `-p <name>` or `-p all`.
- **`No provider configuration files found`.** None of the provider files exists: `~/.claude.json`,
  `~/.codex/config.toml`, `~/.grok/config.toml`, `~/.gemini/settings.json`, `~/.cursor/mcp.json`. Install the client,
  or let `sync -p <name>` create its file.
- **`Server '<name>' not found in any provider`** (`show`). `show` reads the provider files. Install the server with
  `install` or `sync`, or import existing servers with `sync-from-providers`.
- **`Server '<name>' not found in unified config`.** `enable`, `disable`, `remove` and `rename` work on the unified
  config. Import with `sync-from-providers -p <name>` first.
- **A removed server is still in an extra Codex home** (such as `~/.codex-work`). `remove` deletes only from
  `~/.codex/config.toml`, and when that home is in `syncFrom.homes`, `sync-from-providers` reads the server back. A
  later `sync` does not clear it, because the deletion is keyed by a name the unified config marks off. Before
  `remove`, run `disable <server> -p codex`, then `sync -p codex`: that sync deletes the server from every `syncTo`
  home. Otherwise delete its `[mcp_servers.<name>]` table in that home's `config.toml` by hand.
- **A disabled server still runs in one Claude project.** That project has a project-scope entry (an override), or
  defines the server in its own `.mcp.json`. Check with `list` and `doctor list --project <path>`; undo an override
  with `disable <server> -p claude --project <path>`.
- **A Claude switch does not reach Grok.** Grok ignores Claude's project lists and `deniedMcpServers`. Run
  `disable <server> -p grok`.
- **Every gateway server shows ConnectionRefused.** No gateway runs. Check `gateway status`, then `gateway install` (or
  `gateway up` when the agent is installed).
- **`port 8318 is in use by another process`** (`stranger`). Another program holds the port. Release it, or set
  `gateway.listen.port`.
- **`a launchd agent owns this gateway`** (`gateway start`). Use `gateway up`; the agent log is
  `~/.genesis-tools/logs/mcp-gateway.log`.
- **`no gateway running in this process`** (`gateway stop`). `stop` reaches only its own listeners. Press Ctrl-C in the
  terminal that runs `gateway start`, or `gateway uninstall` for the agent.
- **`missing X-Genesis-Mcp-Gateway`.** The harness carries an old or no gateway token, usually after `rotate-client`.
  Run `sync -p all -y`.
- **`Dynamic Client Registration rejected (HTTP 404)`** in Claude Code. You pressed the harness's Authenticate button.
  Run `tools mcp-manager auth login <server>` instead.
- **`doctor check` reports a gateway server as an error with "needs a login".** The stored token is missing or
  expired, and the diagnostic does not refresh it. Run `auth status`, then `auth login <server>`.
- **A login never finishes.** Read `~/.genesis-tools/logs/mcp-login-<server>.log`. A login in flight is recorded in
  `~/.genesis-tools/mcp-manager/logins/<server>.json`; a second `auth login` prints its link.
- **A server that failed at Claude Code startup stays failed.** Press Reconnect in `/mcp`. Claude Code retries only
  servers that dropped.
- **A change does not show in a running session.** Claude Code, Codex and Grok load their servers at start. Restart the
  session.
- **TOML parse error (Codex, Grok).** The `config.toml` is not valid TOML. Fix it, or restore a backup from
  `~/.mcp-manager/backups/`.
- **A config looks wrong after a write.** Copy the matching `.backup` file from `~/.mcp-manager/backups/` back over
  the original path.

## Related

- [scripts](../scripts/README.md): call the MCP tools of every configured server from TypeScript; reads this tool's
  provider list.
- [genesis-tools-mcp](../genesis-tools-mcp/README.md): the GenesisTools MCP server, the one `gateway host` can serve.
- [mcp-web-reader](../mcp-web-reader/README.md): a web content fetching MCP server.
- [json](../json/README.md): pretty-print `doctor check --json` and `list --json`.
