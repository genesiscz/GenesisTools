# Automate

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)
![Runtime](https://img.shields.io/badge/Runtime-Bun-orange?style=flat-square)

> **Chain any GenesisTools commands into reusable, schedulable automation presets.**

Define multi-step workflows as JSON presets, run them on demand or on a schedule, and get notified via desktop alerts, clipboard, or Telegram.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **40+ Step Types** | HTTP, file, git, JSON, text, array, NLP, notifications, and more |
| **Variable Interpolation** | Reference previous step outputs and variables with `{{ }}` syntax |
| **Scheduled Execution** | Cron-like intervals with a background daemon |
| **SQLite History** | Every run and step result is persisted for auditing |
| **Telegram Notifications** | Send results to Telegram via bot integration |
| **macOS Daemon** | Install as a launchd service for always-on scheduling |
| **Parallel Execution** | Run steps concurrently with `parallel` |
| **Conditional Branching** | `if`/`then`/`else` flow control between steps |
| **Credential Management** | Secure storage (0600 permissions) for API keys and tokens |
| **Dry Run Mode** | Preview what a preset will do without executing anything |

---

## Quick Start

```bash
# List all available presets
tools automate preset list

# Run a preset
tools automate preset run api-health-check

# Run with variable overrides
tools automate preset run api-health-check --var url=https://example.com

# Dry run (preview without executing)
tools automate preset run api-health-check --dry-run

# Create a new preset interactively
tools automate preset create

# Browse available step types
tools automate step list
```

---

## Command Reference

### Presets

| Command | Description |
|---------|-------------|
| `tools automate preset run <name>` | Execute a preset by name or file path |
| `tools automate preset list` | List all saved presets with metadata |
| `tools automate preset show [name]` | Display the full JSON of a preset |
| `tools automate preset create` | Interactive wizard to create a new preset |

**Run options:**

| Flag | Alias | Description |
|------|-------|-------------|
| `--dry-run` | | Preview steps without executing |
| `--var key=val` | | Override preset variables (repeatable) |
| `--verbose` | `-v` | Show detailed step output |

### Steps

| Command | Description |
|---------|-------------|
| `tools automate step list` | List all available step types with descriptions |
| `tools automate step show <action>` | Show detailed info and parameters for a step type |

### Tasks (Scheduled Runs)

| Command | Description |
|---------|-------------|
| `tools automate task create` | Interactive wizard to schedule a preset |
| `tools automate task list` | List all scheduled tasks |
| `tools automate task show <name-or-id>` | Show task details and recent runs |
| `tools automate task enable <name>` | Enable a disabled task |
| `tools automate task disable <name>` | Disable a task without deleting it |
| `tools automate task delete <name>` | Permanently remove a scheduled task |
| `tools automate task run <name>` | Manually trigger a scheduled task |
| `tools automate task history [-n 20]` | Show execution history across all tasks |

### Daemon

| Command | Description |
|---------|-------------|
| `tools automate daemon start` | Run the scheduler in the foreground |
| `tools automate daemon status` | Check if the daemon is running and show recent logs |
| `tools automate daemon tail` | Tail daemon logs in real-time |
| `tools automate daemon install` | Install as a macOS launchd service (auto-start on login) |
| `tools automate daemon uninstall` | Remove the launchd service |

### Configuration

| Command | Description |
|---------|-------------|
| `tools automate configure` | Run the configuration wizard |
| `tools automate configure credentials add` | Store a new API credential |
| `tools automate configure credentials list` | List all stored credentials |
| `tools automate configure credentials show` | Display a credential (masked) |
| `tools automate configure credentials delete` | Remove a stored credential |

---

## Preset Format

Presets are JSON files stored in `~/.genesis-tools/automate/presets/`. Each preset follows this schema:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "My Automation",
  "description": "What this preset does",
  "trigger": { "type": "manual" },
  "vars": {
    "url": {
      "type": "string",
      "description": "Target URL to check",
      "default": "https://example.com"
    },
    "threshold": {
      "type": "number",
      "description": "Alert threshold",
      "default": 5
    }
  },
  "steps": [
    {
      "id": "fetch",
      "name": "Fetch data",
      "action": "http.get",
      "params": { "url": "{{ vars.url }}" }
    },
    {
      "id": "check",
      "name": "Check threshold",
      "action": "if",
      "condition": "{{ steps.fetch.output.count > vars.threshold }}",
      "then": "notify",
      "else": "done"
    },
    {
      "id": "notify",
      "name": "Send alert",
      "action": "notify.telegram",
      "params": { "message": "Count exceeded: {{ steps.fetch.output.count }}" }
    },
    {
      "id": "done",
      "name": "Log result",
      "action": "log",
      "params": { "message": "All clear ({{ steps.fetch.output.count }})" }
    }
  ]
}
```

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema` | `string` | Yes | Must be `"genesis-tools-preset-v1"` |
| `name` | `string` | Yes | Display name for the preset |
| `description` | `string` | No | What the preset does |
| `trigger` | `object` | Yes | `{ "type": "manual" }` or `{ "type": "schedule", "interval": "..." }` |
| `vars` | `object` | No | Variable definitions with type, description, and default |
| `steps` | `array` | Yes | Ordered list of steps to execute |

### Step Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique step identifier (alphanumeric, hyphens, underscores) |
| `name` | `string` | Yes | Human-readable label shown in progress output |
| `action` | `string` | Yes | Step type (e.g. `http.get`, `shell`, `if`) |
| `params` | `object` | No | Parameters passed to the action |
| `onError` | `string` | No | `"stop"` (default), `"continue"`, or `"skip"` |
| `interactive` | `boolean` | No | If true, subprocess inherits stdin for interactive prompts |
| `condition` | `string` | No | For `if` action: expression returning a boolean |
| `then` | `string` | No | For `if` action: step ID to jump to when truthy |
| `else` | `string` | No | For `if` action: step ID to jump to when falsy |

### Variable Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | Yes | `"string"`, `"number"`, or `"boolean"` |
| `description` | `string` | Yes | Shown in prompts and documentation |
| `default` | `any` | No | Default value if not provided at runtime |
| `required` | `boolean` | No | If true, the user must supply a value |

---

## Interpolation

All string values in `params` support `{{ }}` expressions. Expressions are evaluated against the execution context which contains variables, previous step outputs, and environment variables.

### Syntax

| Pattern | Description | Example |
|---------|-------------|---------|
| `{{ vars.name }}` | Preset variable | `{{ vars.url }}` |
| `{{ steps.id.output }}` | Previous step output | `{{ steps.fetch.output.body }}` |
| `{{ steps.id.output.field }}` | Nested output field | `{{ steps.fetch.output.status }}` |
| `{{ steps['my-id'].output }}` | Bracket notation for hyphenated IDs | `{{ steps['health-check'].output }}` |
| `{{ env.HOME }}` | Environment variable | `{{ env.PATH }}` |
| `{{ expression }}` | JavaScript expression | `{{ steps.count.output > 0 ? 'yes' : 'no' }}` |

### Expression Details

- **Simple paths** (e.g. `vars.url`, `steps.fetch.output.count`) are resolved via direct property access -- fast and safe.
- **Complex expressions** (e.g. `steps.a.output + steps.b.output`, ternary operators) are evaluated via `new Function()` with a sandboxed context containing only `vars`, `steps`, and `env`.
- **Hyphenated step IDs** in dot paths are automatically rewritten to bracket notation before evaluation. `steps.my-step.output` becomes `steps["my-step"].output`.
- If an entire `{{ }}` expression resolves to a non-string type (number, boolean, array, object), the raw value is preserved. Mixed expressions with surrounding text always produce strings.

---

## Step Types

### HTTP

Perform HTTP requests with automatic JSON parsing, credential injection, and timeout handling.

| Action | Description |
|--------|-------------|
| `http.get` | GET request |
| `http.post` | POST request with body |
| `http.put` | PUT request with body |
| `http.patch` | PATCH request with body |
| `http.delete` | DELETE request |

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Request URL (supports interpolation) |
| `headers` | `object` | No | Additional HTTP headers |
| `query` | `object` | No | URL query parameters |
| `body` | `any` | No | Request body (auto-serialized to JSON) |
| `credential` | `string` | No | Name of a stored credential to inject |
| `timeout` | `number` | No | Timeout in milliseconds |
| `validateStatus` | `string` | No | Expected status code or range |

**Output:** `{ status, statusText, headers, body }`

### File

Read, write, copy, move, and search files.

| Action | Description |
|--------|-------------|
| `file.read` | Read file contents |
| `file.write` | Write content to a file |
| `file.append` | Append content to a file |
| `file.delete` | Delete a file |
| `file.glob` | Find files matching a glob pattern |
| `file.copy` | Copy a file |
| `file.move` | Move/rename a file |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `path` | `string` | Target file path |
| `content` | `string` | Content to write or append |
| `source` | `string` | Source path (copy/move) |
| `destination` | `string` | Destination path (copy/move) |
| `pattern` | `string` | Glob pattern (file.glob) |
| `cwd` | `string` | Working directory for glob |
| `encoding` | `string` | `"utf-8"` (default) or `"base64"` |

### Git

Query and interact with local git repositories.

| Action | Description |
|--------|-------------|
| `git.status` | Get working tree status |
| `git.log` | Get recent commits |
| `git.diff` | Show changes between commits or working tree |
| `git.branch` | List or get current branch |
| `git.commit` | Create a commit |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `cwd` | `string` | Repository path (default: current directory) |
| `limit` | `number` | Max number of commits (git.log) |
| `message` | `string` | Commit message (git.commit) |
| `files` | `string[]` | Files to stage (git.commit) |
| `from` | `string` | Start ref (git.diff) |
| `to` | `string` | End ref (git.diff) |

### JSON

Parse, stringify, and query JSON data with JSONPath.

| Action | Description |
|--------|-------------|
| `json.parse` | Parse a JSON string into an object |
| `json.stringify` | Serialize an object to a JSON string |
| `json.query` | Query data using JSONPath expressions |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `input` | `string` | JSON string or expression reference |
| `query` | `string` | JSONPath query string (json.query) |
| `indent` | `number` | Indentation spaces (json.stringify) |

### Text

String manipulation and templating.

| Action | Description |
|--------|-------------|
| `text.regex` | Apply a regex pattern with optional replacement |
| `text.template` | Render a template string with interpolation |
| `text.split` | Split a string into an array |
| `text.join` | Join an array into a string |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `input` | `string` | Input text |
| `pattern` | `string` | Regex pattern (text.regex) |
| `replacement` | `string` | Replacement string (text.regex) |
| `flags` | `string` | Regex flags, e.g. `"gi"` (text.regex) |
| `template` | `string` | Template string (text.template) |
| `separator` | `string` | Delimiter for split/join |

### Array

Transform and filter array data from previous steps.

| Action | Description |
|--------|-------------|
| `array.filter` | Filter items by expression |
| `array.map` | Transform each item |
| `array.sort` | Sort items by key |
| `array.flatten` | Flatten nested arrays |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `input` | `string` | Expression referencing an array |
| `expression` | `string` | Filter/map expression (`item` is the current element) |
| `key` | `string` | Sort key (array.sort) |
| `order` | `string` | `"asc"` (default) or `"desc"` (array.sort) |

### Notifications

Send results to various outputs.

| Action | Description |
|--------|-------------|
| `notify.desktop` | macOS notification center alert |
| `notify.clipboard` | Copy text to the system clipboard |
| `notify.sound` | Play a system sound |
| `notify.telegram` | Send a message via Telegram bot |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `title` | `string` | Notification title (desktop) |
| `message` | `string` | Notification body (desktop, telegram) |
| `content` | `string` | Text to copy (clipboard) |
| `sound` | `string` | System sound name (sound) |
| `parse_mode` | `string` | Telegram parse mode: `"HTML"` or `"Markdown"` |

> **Note:** `notify.telegram` requires prior configuration via `tools telegram-bot configure`.

### NLP (macOS)

Natural language processing using macOS NaturalLanguage framework.

| Action | Description |
|--------|-------------|
| `nlp.sentiment` | Analyze sentiment of text (-1.0 to 1.0) |
| `nlp.language` | Detect the language of text |
| `nlp.tag` | Tag parts of speech, named entities, lemmas |
| `nlp.distance` | Compute semantic distance between two texts |
| `nlp.embed` | Generate text embeddings |

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `text` | `string` | Text to analyze |
| `text2` | `string` | Second text (nlp.distance) |
| `schemes` | `string[]` | Tag schemes: `lexicalClass`, `nameType`, `lemma`, etc. |
| `language` | `string` | BCP-47 language code (default: `"en"`) |
| `type` | `string` | `"word"` or `"sentence"` for embeddings (default: `"sentence"`) |

### Flow Control

| Action | Description |
|--------|-------------|
| `forEach` | Loop over an array, executing a sub-step for each item |
| `while` | Repeat a sub-step while a condition is true |
| `parallel` | Run multiple steps concurrently |

**forEach parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `items` | `string` | Expression referencing an array |
| `step` | `object` | Step definition to run for each item |
| `concurrency` | `number` | Max parallel executions (default: 1) |
| `as` | `string` | Variable name for current item (default: `"item"`) |
| `indexAs` | `string` | Variable name for current index |

**while parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `condition` | `string` | Expression that must be truthy to continue |
| `step` | `object` | Step definition to repeat |
| `maxIterations` | `number` | Safety limit to prevent infinite loops |

**parallel parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `steps` | `string[]` | List of step IDs to run concurrently |
| `onError` | `string` | `"stop"` or `"continue"` on failure |

### Built-in Actions

These actions are handled directly by the engine without spawning a subprocess.

| Action | Description |
|--------|-------------|
| `shell` | Run a raw shell command via bash |
| `if` | Conditional branching (evaluate expression, jump to `then`/`else` step) |
| `log` | Print a message to the console |
| `prompt` | Ask the user for input interactively |
| `set` | Set key-value pairs into the variables context |

**shell parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `command` | `string` | Shell command to execute |
| `cwd` | `string` | Working directory (default: current directory) |
| `timeout` | `number` | Timeout in seconds (default: 300) |

**set parameters:** Any key-value pairs in `params` are written to `vars`.

---

## Scheduling

### Creating a Scheduled Task

Use the interactive wizard:

```bash
tools automate task create
```

This prompts for:
1. A task name
2. Which preset to run
3. An interval expression
4. Optional variable overrides

### Interval Syntax

| Expression | Meaning |
|------------|---------|
| `every 30 seconds` | Run every 30 seconds |
| `every 5 minutes` | Run every 5 minutes |
| `every 1 hour` | Run every hour |
| `every day at 09:00` | Run daily at 9:00 AM |
| `every day at 17:30` | Run daily at 5:30 PM |
| `every 7 days` | Run weekly |

### Managing Tasks

```bash
# List all tasks with status and next run time
tools automate task list

# Disable a task (keeps config, stops execution)
tools automate task disable my-health-check

# Re-enable
tools automate task enable my-health-check

# Manually trigger a scheduled task
tools automate task run my-health-check

# View execution history
tools automate task history
tools automate task history -n 50
```

### Running the Daemon

The daemon polls the SQLite database for due tasks and executes them.

```bash
# Foreground (for testing) -- Ctrl+C to stop
tools automate daemon start

# Install as macOS launchd service (starts on login, auto-restarts)
tools automate daemon install

# Check status
tools automate daemon status

# Tail logs in real-time
tools automate daemon tail

# Uninstall the launchd service
tools automate daemon uninstall
```

When installed via launchd, the daemon:
- Starts automatically on login (`RunAtLoad`)
- Restarts on crash (`KeepAlive`)
- Logs to `~/.genesis-tools/automate/logs/daemon-stdout.log` and `daemon-stderr.log`
- Runs as a background process with minimal resource usage

---

## Credentials

Store API credentials securely for use in HTTP steps.

### Credential Types

| Type | Fields | Produces |
|------|--------|----------|
| `bearer` | `token` | `Authorization: Bearer <token>` |
| `basic` | `username`, `password` | `Authorization: Basic <base64>` |
| `apikey` | `key`, `headerName` | `<headerName>: <key>` (default: `X-API-Key`) |
| `custom` | `headers` | Arbitrary headers object |

### Managing Credentials

```bash
# Add a new credential (interactive)
tools automate configure credentials add

# List stored credentials
tools automate configure credentials list

# Show a credential (values masked)
tools automate configure credentials show my-api

# Delete a credential
tools automate configure credentials delete my-api
```

### Using Credentials in Steps

Reference a stored credential by name in any HTTP step:

```json
{
  "id": "fetch",
  "name": "Call protected API",
  "action": "http.get",
  "params": {
    "url": "https://api.example.com/data",
    "credential": "my-api"
  }
}
```

Credential values support `{{ }}` expressions, so you can reference environment variables:

```json
{
  "name": "github-token",
  "type": "bearer",
  "token": "{{ env.GITHUB_TOKEN }}"
}
```

### Storage

Credentials are stored as individual JSON files in `~/.genesis-tools/automate/credentials/` with `0600` (owner read/write only) permissions. The directory itself is created with `0700` permissions.

---

## Examples

### 1. API Health Check with Telegram Alert

Checks multiple endpoints concurrently and sends a Telegram notification with the results.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "API Health Check",
  "description": "Check multiple API endpoints and notify on results",
  "trigger": { "type": "manual" },
  "vars": {
    "endpoints": {
      "type": "string",
      "description": "Comma-separated list of URLs to check",
      "default": "https://httpstat.us/200,https://httpstat.us/500"
    }
  },
  "steps": [
    {
      "id": "split-urls",
      "name": "Parse endpoint list",
      "action": "text.split",
      "params": {
        "input": "{{ vars.endpoints }}",
        "separator": ","
      }
    },
    {
      "id": "check-all",
      "name": "Check all endpoints",
      "action": "forEach",
      "params": {
        "items": "{{ steps.split-urls.output }}",
        "concurrency": 5,
        "step": {
          "id": "check",
          "name": "Check endpoint",
          "action": "http.get",
          "params": {
            "url": "{{ item }}",
            "timeout": 10000
          }
        }
      }
    },
    {
      "id": "notify",
      "name": "Report results",
      "action": "notify.desktop",
      "params": {
        "title": "API Health Check",
        "message": "Checked {{ steps.check-all.output.count }} endpoints, {{ steps.check-all.output.failures }} failures"
      }
    }
  ]
}
```

Run it:
```bash
tools automate preset run api-health-check
tools automate preset run api-health-check --var endpoints=https://myapi.com/health,https://myapi.com/status
```

### 2. Weekly Git Summary with Clipboard

Collects recent commits, formats them as markdown, and copies the result to the clipboard.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Weekly Git Summary",
  "description": "Get recent commits, format as markdown, copy to clipboard",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "log",
      "name": "Get recent commits",
      "action": "git.log",
      "params": { "limit": 50 }
    },
    {
      "id": "format",
      "name": "Format as markdown",
      "action": "text.template",
      "params": {
        "template": "# Weekly Git Summary\n\nCommits: {{ steps.log.output.count }}\n\n{{ steps.log.output.commits }}"
      }
    },
    {
      "id": "copy",
      "name": "Copy to clipboard",
      "action": "notify.clipboard",
      "params": { "content": "{{ steps.format.output }}" }
    },
    {
      "id": "done",
      "name": "Show notification",
      "action": "notify.desktop",
      "params": {
        "title": "Git Summary",
        "message": "{{ steps.log.output.count }} commits copied to clipboard"
      }
    }
  ]
}
```

### 3. Scheduled Health Check with Telegram

Runs every 5 minutes via the daemon and sends results to Telegram.

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Scheduled Health Check",
  "description": "Check API endpoints periodically, notify via Telegram on completion",
  "trigger": { "type": "schedule", "interval": "every 5 minutes" },
  "vars": {
    "url": {
      "type": "string",
      "description": "URL to check",
      "default": "https://httpstat.us/200"
    }
  },
  "steps": [
    {
      "id": "check",
      "name": "Check endpoint",
      "action": "http.get",
      "params": { "url": "{{ vars.url }}", "timeout": 10000 },
      "onError": "continue"
    },
    {
      "id": "notify",
      "name": "Send Telegram notification",
      "action": "notify.telegram",
      "params": {
        "message": "Health check: {{ vars.url }} -- {{ steps.check.status }}"
      }
    }
  ]
}
```

To schedule it:
```bash
# Create the task
tools automate task create
# (select "Scheduled Health Check", enter interval "every 5 minutes")

# Start the daemon
tools automate daemon start
# or install as a service:
tools automate daemon install
```

---

## File Locations

| Path | Description |
|------|-------------|
| `~/.genesis-tools/automate/presets/` | Saved preset JSON files |
| `~/.genesis-tools/automate/automate.db` | SQLite database (schedules, runs, logs) |
| `~/.genesis-tools/automate/credentials/` | Stored credentials (0600 permissions) |
| `~/.genesis-tools/automate/logs/` | Daemon stdout/stderr logs |
| `~/Library/LaunchAgents/com.genesis-tools.automate.plist` | launchd service definition |

---

## Error Handling

Each step has an `onError` field that controls what happens when it fails:

| Value | Behavior |
|-------|----------|
| `"stop"` | Halt the entire preset (default) |
| `"continue"` | Record the error and proceed to the next step |
| `"skip"` | Skip the step silently and continue |

Step results always include a `status` field (`"success"`, `"error"`, or `"skipped"`) and a `duration` in milliseconds. Errors include an `error` message and, for shell/process steps, an `exitCode`.

---

## Technical Details

- **Runtime**: Bun (uses `Bun.spawn`, `bun:sqlite`, and Bun file APIs)
- **Database**: SQLite with WAL mode and foreign keys enabled
- **Expression Engine**: Simple paths resolved via property access; complex expressions via `new Function()` with `vars`, `steps`, `env` in scope
- **Credential Security**: Files stored with `0600` permissions in a `0700` directory; values can reference `{{ env.* }}` to avoid storing secrets on disk
- **Daemon**: Polls the database on a timer; installed via macOS launchd with `KeepAlive` and `RunAtLoad`
- **Logging**: All operations logged via pino to `logs/` directory; daemon logs separately to `~/.genesis-tools/automate/logs/`
