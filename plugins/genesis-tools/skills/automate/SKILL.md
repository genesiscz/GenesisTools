---
name: genesis-tools:automate
description: |
  Create and run automation presets using the `tools automate` CLI.
  Use when:
  - User wants to automate a repetitive workflow
  - User says "automate", "create automation", "run preset"
  - User wants to chain multiple tools commands together
  - User asks to create a reusable workflow
  - User wants to run a previously saved preset
---

# Automate Tool Usage Guide

Create and run reusable automation presets that chain GenesisTools commands.

## Quick Reference

| Task | Command |
|------|---------|
| Run a preset | `tools automate run <name-or-path>` |
| Run with overrides | `tools automate run <name> --var startDate=2026-02-01` |
| Dry run (preview) | `tools automate run <name> --dry-run` |
| List presets | `tools automate list` |
| Show preset details | `tools automate show <name>` |
| Create interactively | `tools automate create` |

## Creating Presets via Conversation

When a user wants to create an automation, help them build the JSON preset:

1. **Identify the workflow steps** -- What tools commands do they need?
2. **Identify variables** -- What values change between runs?
3. **Identify conditions** -- Are there any if/else branches?
4. **Build the JSON** -- Write the preset file
5. **Save it** -- Write to `~/.genesis-tools/automate/presets/<name>.json`

## Preset JSON Format (Full Schema)

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Preset Name",
  "description": "What this preset does",
  "trigger": { "type": "manual" },
  "vars": {
    "varName": {
      "type": "string",
      "description": "Human description",
      "default": "value",
      "required": true
    }
  },
  "steps": [
    {
      "id": "unique-step-id",
      "name": "Human-readable name",
      "action": "github search",
      "params": {
        "query": "search term",
        "--repo": "owner/repo",
        "--format": "json"
      },
      "output": "resultVar",
      "onError": "stop",
      "interactive": false
    }
  ]
}
```

### Variable Types
- `"string"` -- text values
- `"number"` -- numeric values
- `"boolean"` -- true/false

### Error Strategies (`onError`)
- `"stop"` (default) -- halt execution on failure
- `"continue"` -- log error and proceed to next step
- `"skip"` -- silently skip and proceed

## Expression Syntax

Expressions use `{{ }}` delimiters and are resolved at runtime:

| Expression | Purpose | Example |
|------------|---------|---------|
| `{{ vars.name }}` | Reference a preset variable | `{{ vars.startDate }}` |
| `{{ steps.id.output }}` | Previous step's full output | `{{ steps.search.output }}` |
| `{{ steps.id.output.field }}` | Nested output field | `{{ steps.search.output.count }}` |
| `{{ env.HOME }}` | Environment variable | `{{ env.USER }}` |
| `{{ expr > 0 }}` | Boolean expression | `{{ steps.x.output.count > 0 }}` |

When the entire value is a single expression, the raw type is preserved (boolean, number, object).
When expressions are embedded in a larger string, they are interpolated as strings.

## Built-in Actions

| Action | Purpose | Key Params |
|--------|---------|------------|
| `if` | Conditional branch | `condition` (required), `then`, `else` (step IDs to jump to) |
| `log` | Print a message | `message` |
| `prompt` | Ask user for input | `message`, `default` |
| `shell` | Run a raw shell command | `command` (required), `cwd` (optional) |
| `set` | Set variables in context | Any key=value pairs in params |

## Action Format for Tools Commands

The `action` field maps directly to `tools <action>`:
- `"action": "github search"` => runs `tools github search`
- `"action": "collect-files-for-ai"` => runs `tools collect-files-for-ai`
- `"action": "azure-devops workitem"` => runs `tools azure-devops workitem`

### Param Conventions
- Keys starting with `--` or `-` become CLI flags
- Boolean `true` includes the flag, `false` omits it
- Array values are joined with commas
- Other keys are treated as positional arguments (the key name is a label, only the value is passed)

## Examples

### Simple: Run a shell command and log result
```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Hello Automate",
  "trigger": { "type": "manual" },
  "vars": {
    "name": { "type": "string", "description": "Your name", "default": "World" }
  },
  "steps": [
    { "id": "greet", "name": "Say hello", "action": "log", "params": { "message": "Hello, {{ vars.name }}!" } },
    { "id": "date", "name": "Get date", "action": "shell", "params": { "command": "date '+%Y-%m-%d'" }, "output": "currentDate" },
    { "id": "done", "name": "Summary", "action": "log", "params": { "message": "Done at {{ steps.date.output }}" } }
  ]
}
```

### With Branching: Search and conditionally download
```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Monthly Invoice Search",
  "trigger": { "type": "manual" },
  "vars": {
    "startDate": { "type": "string", "description": "Start date", "default": "2026-01-01" }
  },
  "steps": [
    { "id": "search", "name": "Search Mail", "action": "macos-mail search", "params": { "query": "invoice", "--from": "{{ vars.startDate }}", "--format": "json" }, "output": "results" },
    { "id": "check", "name": "Has results?", "action": "if", "condition": "{{ steps.search.output.count > 0 }}", "then": "download", "else": "empty" },
    { "id": "download", "name": "Download", "action": "macos-mail download", "params": { "--ids": "{{ steps.search.output.ids }}" } },
    { "id": "empty", "name": "No results", "action": "log", "params": { "message": "Nothing found." } }
  ]
}
```

## Running Presets

```bash
# By name (looks in ~/.genesis-tools/automate/presets/)
tools automate run monthly-invoice-search

# By file path
tools automate run ./my-preset.json

# With variable overrides
tools automate run monthly-invoice-search --var startDate=2026-02-01 --var outputDir=/tmp/invoices

# Dry run (shows what would execute without running)
tools automate run monthly-invoice-search --dry-run
```

## Storage

- Presets: `~/.genesis-tools/automate/presets/*.json`
- Config/metadata: `~/.genesis-tools/automate/config.json`
- Run metadata tracks last run date and total run count per preset
