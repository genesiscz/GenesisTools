# Automate CLI Restructure + Enhancements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the `tools automate` CLI from flat commands into nested subcommand groups, merge schedule/tasks into a unified `task` concept, enhance daemon with log tailing, add a claude-usage preset, and write comprehensive README.

**Architecture:** Commander.js subcommand groups replace flat top-level commands. `schedule` and `tasks` merge into a single `task` group. Daemon gains log tailing via `tail -f` on launchd log files. New preset demonstrates shell→json→notify pipeline.

**Tech Stack:** Commander.js, @clack/prompts, picocolors, Bun

**Branch:** `feat/automate`

---

## Context

The automate tool currently has 10 flat top-level commands which makes the CLI overwhelming. The user wants a cleaner, more modular structure. Additionally:
- `schedule` and `tasks` are conceptually the same thing (scheduled work + history) but split across two commands
- The daemon has no log visibility
- There's no way to create tasks from the `tasks` command (only view history)
- No README exists for `tools automate --readme`
- A sample preset for claude usage monitoring + telegram notification is needed

---

## Target CLI Tree

```
tools automate preset run <name> [--dry-run] [--var key=val] [-v]
tools automate preset list|ls
tools automate preset show [name]
tools automate preset create

tools automate step list|ls
tools automate step show <action>

tools automate task list|ls
tools automate task create
tools automate task show <name-or-run-id>
tools automate task enable <name>
tools automate task disable <name>
tools automate task delete <name>
tools automate task run <name>
tools automate task history [-n 20]

tools automate daemon start
tools automate daemon status
tools automate daemon tail
tools automate daemon install
tools automate daemon uninstall

tools automate configure
tools automate configure credentials add|list|show|delete
```

**Note:** `tools claude usage --json` lives on `feat/claude` branch. The preset uses `shell` to call it.

---

## Task 1: Restructure `index.ts` — Create Subcommand Groups

**Files:**
- Modify: `src/automate/index.ts`

**Steps:**
1. Replace flat `registerXxxCommand(program)` calls with subcommand group pattern
2. Create `preset` group: `const preset = program.command("preset").description("Manage automation presets")`
3. Create `step` group: `const step = program.command("step").description("Browse available step types")`
4. Create `task` group: `const task = program.command("task").description("Manage scheduled tasks and view run history")`
5. Keep `daemon` at top level (already a group)
6. Keep `configure` at top level, nest `credentials` as a subcommand group under `configure`
7. Update all register functions to accept a `Command` group instead of root program
8. Change function signatures: e.g., `registerRunCommand(preset)` instead of `registerRunCommand(program)`

**Verification:** `tools automate --help` shows grouped commands. `tools automate preset --help` shows preset subcommands.

---

## Task 2: Refactor `commands/run.ts`, `commands/list.ts`, `commands/show.ts`, `commands/create.ts` — Move Under `preset` Group

**Files:**
- Modify: `src/automate/commands/run.ts` — change `program.command("run ...")` to just register on the passed parent
- Modify: `src/automate/commands/list.ts` — same
- Modify: `src/automate/commands/show.ts` — same
- Modify: `src/automate/commands/create.ts` — same

**Steps:**
1. Each register function already receives a `Command` parent — just ensure they register on whatever parent is passed (no changes needed if they already use `program.command(...)` since `program` is just the parameter name)
2. Verify each works as `tools automate preset run/list/show/create`
3. Update any help text that references old paths (e.g., `"Run: tools automate create"` → `"Run: tools automate preset create"`)

**Verification:** `tools automate preset run api-health-check --dry-run` works.

---

## Task 3: Refactor `commands/steps.ts` — Split Into `step list` and `step show`

**Files:**
- Modify: `src/automate/commands/steps.ts`

**Steps:**
1. Rename function to `registerStepCommands(parent: Command)`
2. Currently handles both listing (no arg) and showing (with arg) in one command
3. Split into two subcommands on the parent:
   - `parent.command("list").alias("ls")` — lists all step types (the current no-arg path)
   - `parent.command("show <action>")` — shows detail for a specific action (the current with-arg path)
4. Make `list` the default: `{ isDefault: true }`

**Verification:** `tools automate step list` and `tools automate step show http.get` both work.

---

## Task 4: Merge `schedule` + `tasks` Into Unified `task` Group

**Files:**
- Modify: `src/automate/commands/schedule.ts` → rename to `src/automate/commands/task.ts`
- Delete: `src/automate/commands/tasks.ts` (merge content into task.ts)

**Steps:**
1. Create new `registerTaskCommand(parent: Command)` that combines both
2. Subcommands from current `schedule`:
   - `task create` — interactive schedule creation (from `schedule create`)
   - `task enable <name>` — enable (from `schedule enable`)
   - `task disable <name>` — disable (from `schedule disable`)
   - `task delete <name>` — delete (from `schedule delete`)
3. Subcommands from current `tasks`:
   - `task history` (default) — show recent runs (from `tasks list`), with `-n` option
   - `task show <name-or-id>` — if numeric, show run details (from `tasks show`); if string, show schedule details (new)
4. New subcommand:
   - `task list` (default) — show all scheduled tasks (from `schedule list`)
   - `task run <name>` — manually trigger a scheduled task's preset (loads schedule, runs its preset immediately, logs to SQLite)
5. Make `list` the default subcommand

**Verification:** `tools automate task list`, `tools automate task create`, `tools automate task history`, `tools automate task run <name>` all work.

---

## Task 5: Enhance Daemon — Add `tail`, Auto-Tail on `start`/`status`

**Files:**
- Modify: `src/automate/commands/daemon.ts`
- Modify: `src/automate/lib/launchd.ts` (export log paths)

**Steps:**
1. Export log paths from `launchd.ts`:
   ```typescript
   export const DAEMON_LOG_DIR = join(homedir(), ".genesis-tools", "automate", "logs");
   export const DAEMON_STDOUT_LOG = join(DAEMON_LOG_DIR, "daemon-stdout.log");
   export const DAEMON_STDERR_LOG = join(DAEMON_LOG_DIR, "daemon-stderr.log");
   ```
2. Add `daemon tail` subcommand:
   - Spawns `tail -f <stdout-log> <stderr-log>` with inherited stdio
   - Handles SIGINT to clean exit
   - If log files don't exist, show "No daemon logs found. Is the daemon installed?"
3. Modify `daemon start`:
   - Current behavior already checks `getDaemonPid()` and shows "Daemon already running (PID X)"
   - After that message, auto-invoke the tail logic (follow daemon logs)
4. Modify `daemon status`:
   - After showing status info, if daemon is running, show last 20 lines of log then start tailing
   - If not running, just show status (no tail)

**Verification:** `tools automate daemon tail` tails logs. `tools automate daemon start` (when already running) shows PID then tails.

---

## Task 6: Create Claude Usage Preset

**Files:**
- Create: `src/automate/presets/claude-usage-report.json`

**Steps:**
1. Create preset that:
   - Step 1 (`get-usage`): `shell` action runs `tools claude usage --json`
   - Step 2 (`format-report`): `text.template` formats a human-readable summary from the JSON
   - Step 3 (`send-telegram`): `notify.telegram` sends the formatted report
2. Trigger: `manual` (can be scheduled later with `task create`)

**`tools claude usage --json` output structure** (from `feat/claude` branch):
```typescript
// Array of AccountUsage objects:
[{
  accountName: string,
  label?: string,
  usage?: {
    five_hour: { utilization: number, resets_at: string | null },
    seven_day: { utilization: number, resets_at: string | null },
    seven_day_opus?: { utilization: number, resets_at: string | null },
    seven_day_sonnet?: { utilization: number, resets_at: string | null },
  }
}]
```

**Preset structure:**
```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "claude-usage-report",
  "description": "Report Claude API usage quotas via Telegram",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "get-usage",
      "name": "Fetch Claude usage",
      "action": "shell",
      "params": { "command": "tools claude usage --json" }
    },
    {
      "id": "format-report",
      "name": "Format report",
      "action": "text.template",
      "params": {
        "template": "📊 Claude Usage Report\n\n⏱ 5h window: {{ Math.round(steps['get-usage'].output[0].usage.five_hour.utilization * 100) }}%\n📅 7d window: {{ Math.round(steps['get-usage'].output[0].usage.seven_day.utilization * 100) }}%\n🎭 Opus 7d: {{ steps['get-usage'].output[0].usage.seven_day_opus ? Math.round(steps['get-usage'].output[0].usage.seven_day_opus.utilization * 100) + '%' : 'N/A' }}\n💎 Sonnet 7d: {{ steps['get-usage'].output[0].usage.seven_day_sonnet ? Math.round(steps['get-usage'].output[0].usage.seven_day_sonnet.utilization * 100) + '%' : 'N/A' }}\n\nResets: {{ steps['get-usage'].output[0].usage.five_hour.resets_at ?? 'unknown' }}"
      }
    },
    {
      "id": "notify",
      "name": "Send Telegram notification",
      "action": "notify.telegram",
      "params": { "message": "{{ steps['format-report'].output }}" }
    }
  ]
}
```

**Note:** `tools claude usage` is on `feat/claude` branch — the preset works once that branch is merged. The template expressions use bracket notation for hyphenated step IDs.

**Verification:** `tools automate preset run claude-usage-report` sends a telegram message with usage percentages.

---

## Task 7: Write Comprehensive README

**Files:**
- Create: `src/automate/README.md`

**Steps:**
1. Follow the style of `src/watch/README.md` (badges, feature table, quick start, options, examples)
2. Sections:
   - Header with badges and tagline
   - Key Features table
   - Quick Start (run a preset, list presets, create preset)
   - CLI Reference (full command tree with descriptions)
   - Preset Format (JSON schema with annotated example)
   - Step Types (table of all actions with one-line descriptions)
   - Variables & Interpolation (syntax, examples: `{{ vars.x }}`, `{{ steps.id.output }}`, `{{ env.HOME }}`)
   - Scheduling (create task, enable, daemon start)
   - Notifications (desktop, clipboard, sound, telegram)
   - Daemon Management (install, status, tail, logs)
   - Example Presets (3-4 realistic examples with full JSON)
   - Credentials Management

**Verification:** `tools automate --readme` renders nicely in terminal.

---

## Task 8: Nest Credentials Under Configure

**Files:**
- Modify: `src/automate/commands/configure.ts` — register credentials as subcommand group
- Modify: `src/automate/commands/credentials.ts` — change to accept parent command (configure group)
- Modify: `src/automate/index.ts` — pass configure command to credentials registration

**Steps:**
1. In `configure.ts`, make configure a command group (not just a flat command):
   - `const configure = program.command("configure").description("Setup wizard and credential management")`
   - The wizard becomes the default action (no subcommand)
   - Register credentials as subcommand: `registerCredentialsCommand(configure)`
2. Update `credentials.ts` to register on passed parent instead of creating its own top-level group
3. Result: `tools automate configure` runs wizard, `tools automate configure credentials add|list|show|delete` manages creds

**Verification:** `tools automate configure` runs wizard. `tools automate configure credentials list` shows creds.

---

## Task 9: Update Help Text and Cross-References

**Files:**
- Modify: Various files across `src/automate/` and `src/telegram-bot/`

**Steps:**
1. Search for all strings containing `"tools automate "` across the automate and telegram-bot directories
2. Update to new paths:
   - `"tools automate run"` → `"tools automate preset run"`
   - `"tools automate list"` → `"tools automate preset list"`
   - `"tools automate create"` → `"tools automate preset create"`
   - `"tools automate show"` → `"tools automate preset show"`
   - `"tools automate schedule"` → `"tools automate task"`
   - `"tools automate steps"` → `"tools automate step"`
   - `"tools automate tasks"` → `"tools automate task history"`
3. Update telegram bot `/run` handler to reference `tools automate preset run`
4. Update telegram bot `/tasks` handler to reference `tools automate task history`

**Verification:** Grep for old-style references finds none.

---

## Task 10: Clean Up Debug Logging

**Files:**
- Modify: `src/telegram-bot/commands/configure.ts` — remove leftover `console.error` debug lines from previous debugging session

**Steps:**
1. Remove any `console.error` debug logging that was added during the telegram configure debugging session
2. Keep proper `p.log.*` calls
3. Ensure the configure command uses only clack prompts for output

**Verification:** `tools telegram-bot configure` has clean output with no debug noise.

---

## Verification

After all tasks:
1. `tools automate --help` shows: `preset`, `step`, `task`, `daemon`, `configure`
2. `tools automate preset --help` shows: `run`, `list`, `show`, `create`
3. `tools automate step --help` shows: `list`, `show`
4. `tools automate task --help` shows: `list`, `create`, `show`, `enable`, `disable`, `delete`, `run`, `history`
5. `tools automate daemon --help` shows: `start`, `status`, `tail`, `install`, `uninstall`
6. `tools automate configure --help` shows wizard + `credentials` subgroup
7. `tools automate preset run api-health-check --dry-run` works
8. `tools automate task create` interactively creates a schedule
9. `tools automate daemon tail` tails logs
10. `tools automate preset run claude-usage-report` sends telegram notification
11. `tools automate --readme` shows formatted documentation
12. `tools automate configure credentials list` shows credentials

---

## Critical Files Reference

| File | Purpose |
|------|---------|
| `src/automate/index.ts` | Entry point — create subcommand groups |
| `src/automate/commands/run.ts` | Preset run (moves under `preset`) |
| `src/automate/commands/list.ts` | Preset list (moves under `preset`) |
| `src/automate/commands/show.ts` | Preset show (moves under `preset`) |
| `src/automate/commands/create.ts` | Preset create (moves under `preset`) |
| `src/automate/commands/steps.ts` | Split into `step list` + `step show` |
| `src/automate/commands/schedule.ts` | Merge into `task.ts` |
| `src/automate/commands/tasks.ts` | Merge into `task.ts` |
| `src/automate/commands/daemon.ts` | Add `tail`, enhance `start`/`status` |
| `src/automate/commands/credentials.ts` | Nest under configure |
| `src/automate/lib/launchd.ts` | Export log file paths |
| `src/automate/presets/claude-usage-report.json` | New preset |
| `src/automate/README.md` | New comprehensive README |
| `src/telegram-bot/lib/handlers/*.ts` | Update command references |
| `src/telegram-bot/commands/configure.ts` | Remove debug console.error |
