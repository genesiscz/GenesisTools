# General-Purpose Daemon Tool (`tools daemon`)

## Context

GenesisTools has many tools that could benefit from background execution (usage polling, cron-like tasks, health checks). Currently, only `src/automate/` has daemon infrastructure, but it's tightly coupled to its preset/step engine. This plan creates a standalone, general-purpose daemon at `src/daemon/` that any tool can register tasks with.

The daemon manages shell-command-based background tasks with: interval scheduling, retry on crash, JSONL log capture, macOS launchd integration, notifications, and an interactive clack-based UI.

---

## File Structure

```
src/daemon/
  index.ts                       # Entry: interactive menu (no args) or commander subcommands
  daemon.ts                      # Daemon process: PID, signals, scheduler loop entry
  lib/
    types.ts                     # All interfaces
    config.ts                    # Task config CRUD via Storage("daemon")
    interval.ts                  # Interval parser (self-contained, adapted from automate)
    scheduler.ts                 # Polling loop: check tasks, spawn runners, retry
    runner.ts                    # Spawn child process, stream stdout/stderr to JSONL
    launchd.ts                   # macOS launchd plist generate/install/uninstall/status
    log-reader.ts                # Parse JSONL logs, list tasks/runs for viewer
    register.ts                  # Public API for other tools to register tasks programmatically
  interactive/
    menu.ts                      # Main interactive menu (while(true) + clack back-nav)
    task-editor.ts               # Task creation/edit wizard
    log-viewer.ts                # 3-level drill-down: task → run → log content
  commands/
    start.ts                     # daemon start (foreground)
    stop.ts                      # daemon stop (SIGTERM to PID)
    status.ts                    # daemon status (PID + launchd + task summary)
    install.ts                   # daemon install / daemon uninstall (launchd)
    config.ts                    # daemon config list|add|remove|enable|disable
    logs.ts                      # daemon logs [--task X] [--tail]
```

## Storage Layout

```
~/.genesis-tools/daemon/
  config.json                    # { tasks: DaemonTask[] }
  daemon.pid                     # PID file (written by daemon process directly)
  logs/
    <taskname>/
      2026-02-27T09-15-00-a1b2c3d4.jsonl
      2026-02-27T10-15-00-e5f6g7h8.jsonl
    daemon-stdout.log            # launchd stdout capture
    daemon-stderr.log            # launchd stderr capture
```

---

## Step 1: Types (`src/daemon/lib/types.ts`)

```typescript
export interface DaemonTask {
    name: string;           // unique, alphanumeric/hyphens/underscores
    command: string;        // shell command (run via sh -c)
    every: string;          // "every 5 minutes", "every day at 09:00"
    retries: number;        // max restart attempts on non-zero exit (0 = no retry)
    enabled: boolean;
    description?: string;
}

export interface DaemonConfig {
    tasks: DaemonTask[];
}

// JSONL log line types (discriminated union on "type")
export interface LogMeta {
    type: "meta";
    taskName: string;
    command: string;
    runId: string;
    attempt: number;        // 1-based
    startedAt: string;      // ISO
}

export interface LogLine {
    type: "stdout" | "stderr";
    ts: string;
    data: string;
}

export interface LogExit {
    type: "exit";
    ts: string;
    code: number | null;    // null = killed/signaled
    duration_ms: number;
}

export type LogEntry = LogMeta | LogLine | LogExit;

// Scheduler runtime state (in-memory only)
export interface TaskState {
    nextRunAt: Date;
    attemptCount: number;
    running: boolean;
}

export interface RunResult {
    exitCode: number | null;
    duration_ms: number;
    logFile: string;
}
```

## Step 2: Interval Parser (`src/daemon/lib/interval.ts`)

Self-contained copy/adapt from `src/automate/lib/interval-parser.ts`. Same regex patterns, same `ParsedInterval` shape, same `parseInterval()` and `computeNextRunAt()` functions. No dependency on automate.

**Reuse source**: `src/automate/lib/interval-parser.ts` (51 lines)

## Step 3: Config (`src/daemon/lib/config.ts`)

Uses `new Storage("daemon")` from `@app/utils/storage/storage.ts`.

Functions:
- `loadConfig(): Promise<DaemonConfig>` — reads config.json, returns `{ tasks: [] }` if missing
- `saveConfig(config: DaemonConfig): Promise<void>`
- `getTask(name: string): Promise<DaemonTask | undefined>`
- `upsertTask(task: DaemonTask): Promise<void>` — add or update by name
- `removeTask(name: string): Promise<boolean>`
- `setTaskEnabled(name: string, enabled: boolean): Promise<void>`
- `ensureStorage(): Promise<void>` — creates base + logs dirs
- `getLogsBaseDir(): string` — returns `~/.genesis-tools/daemon/logs`
- `getPidFile(): string` — returns `~/.genesis-tools/daemon/daemon.pid`

## Step 4: Task Runner (`src/daemon/lib/runner.ts`)

Spawns a child process, captures stdout/stderr line-by-line into JSONL.

```typescript
export async function runTask(task: DaemonTask, attempt: number, logsBaseDir: string): Promise<RunResult>
```

Key implementation details:
- `runId = crypto.randomUUID().slice(0, 8)`
- Log path: `<logsBaseDir>/<task.name>/<datetime>-<runid>.jsonl` (datetime: `YYYY-MM-DDTHH-mm-ss`)
- First JSONL line: `LogMeta` with command, runId, attempt, startedAt
- Spawn: `Bun.spawn(["sh", "-c", task.command], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })`
- Stream stdout/stderr concurrently using async `ReadableStream` readers with `TextDecoder` + partial-line buffering
- Each complete line → `appendFileSync` as a `LogLine` JSON entry
- After `proc.exited`: write final `LogExit` entry with code + duration
- Return `{ exitCode, duration_ms, logFile }`

## Step 5: Scheduler (`src/daemon/lib/scheduler.ts`)

Polling-based loop (follows `src/automate/lib/scheduler.ts` pattern):

```typescript
export async function runSchedulerLoop(logsBaseDir: string): Promise<void>
```

Algorithm:
1. Load config, build `taskStates: Map<string, TaskState>` (compute initial `nextRunAt` from last log file or `now`)
2. `activeRuns: Set<string>` tracks task names currently executing
3. `while (running)`:
   - Reload config each tick (hot-reload: add/remove/enable/disable without restart)
   - For each enabled task where `now >= nextRunAt` and not in `activeRuns`:
     - Fire `executeTask()` as floating promise
     - Advance `nextRunAt` immediately
   - Sleep `Math.min(nextWakeupMs, 60_000)` (min 1s)
4. On shutdown: wait up to 30s for active runs

**Retry logic** inside `executeTask()`:
- Loop `attempt = 1..retries+1`
- If exit code 0: success, break
- If more retries remain: exponential backoff (`2^attempt * 1000ms`, max 60s), retry
- macOS notifications: on first attempt start, on success, on final failure

**Notifications** (via `sendNotification` from `@app/utils/macos/notifications`):
- Task started: `{ title: "Daemon", subtitle: task.name, message: "Started" }`
- Task success: `{ title: "Daemon", subtitle: task.name, message: "Completed" }`
- Task failed: `{ title: "Daemon", subtitle: task.name, message: "Failed (exit N), retries exhausted" }`

## Step 6: Daemon Process (`src/daemon/daemon.ts`)

Exact pattern from `src/automate/lib/daemon.ts`:
- `startDaemon()`: write PID file → register SIGTERM/SIGINT cleanup → `await runSchedulerLoop(logsBaseDir)` → cleanup in `finally`
- `getDaemonPid()`: read PID file + `process.kill(pid, 0)` liveness check
- `if (import.meta.main) { startDaemon(); }` guard

## Step 7: Launchd (`src/daemon/lib/launchd.ts`)

Exact pattern from `src/automate/lib/launchd.ts` with different label/paths:
- Label: `com.genesis-tools.daemon`
- Plist: `~/Library/LaunchAgents/com.genesis-tools.daemon.plist`
- Daemon script: `resolve(import.meta.dir, "../daemon.ts")`
- `KeepAlive: true`, `RunAtLoad: true`, `ThrottleInterval: 10`
- `generatePlist()`, `installLaunchd()`, `uninstallLaunchd()`, `getDaemonStatus()`

## Step 8: Log Reader (`src/daemon/lib/log-reader.ts`)

```typescript
export interface RunSummary {
    taskName: string;
    runId: string;
    logFile: string;
    startedAt: string;
    exitCode: number | null;
    duration_ms: number | null;
    attempt: number;
}

export function listTasksWithLogs(logsBaseDir: string): string[]
export function listRunsForTask(logsBaseDir: string, taskName: string): RunSummary[]
export function parseLogFile(logFile: string): LogEntry[]
```

- `listTasksWithLogs`: `readdirSync` dirs in logsBaseDir
- `listRunsForTask`: list `.jsonl` files sorted newest first, read first+last line for meta/exit
- `parseLogFile`: read file, split on `\n`, `JSON.parse` each line

## Step 9: Registration API (`src/daemon/lib/register.ts`)

Public API for other tools (e.g., claude) to programmatically register/unregister tasks:

```typescript
export interface RegisterTaskOptions {
    name: string;
    command: string;
    every: string;
    retries?: number;       // default: 3
    enabled?: boolean;      // default: true
    description?: string;
    overwrite?: boolean;    // default: false (skip if exists)
}

export async function registerTask(opts: RegisterTaskOptions): Promise<boolean>
export async function unregisterTask(name: string): Promise<boolean>
export async function isTaskRegistered(name: string): Promise<boolean>
```

## Step 10: Interactive Menu (`src/daemon/interactive/menu.ts`)

Pattern from `src/har-analyzer/interactive.ts` — `while(true)` + `p.select()` + `break` on cancel.

```
Main Menu:
  ● Status        → Show daemon PID, launchd status, task count, next run
  ● Tasks         → Submenu: list, add, edit, enable/disable, delete
  ● Logs          → Log viewer (3-level drill-down)
  ● Start         → Start daemon foreground (or tail if running)
  ● Stop          → SIGTERM daemon
  ● Install       → Install/uninstall launchd plist
  ● Quit

Tasks Submenu:
  ● List           → Table of tasks
  ● Add            → Task creation wizard
  ● Enable/Disable → Select task → toggle
  ● Delete         → Select task → confirm → remove
  ● ← Back

Logs Viewer (3-level):
  Level 1: Select task (or ← Back)
  Level 2: Select run — shows "2026-02-27 09:15  exit:0  3.2s" (or ← Back)
  Level 3: Display log content (stdout white, stderr yellow, meta/exit colored)
```

## Step 11: Task Editor (`src/daemon/interactive/task-editor.ts`)

Interactive wizard using clack prompts:
1. Name: `p.text()` with `^[a-zA-Z0-9_-]+$` validation + uniqueness check
2. Command: `p.text()` non-empty
3. Interval: `p.text()` with `parseInterval()` validation
4. Retries: `p.select()` — 0 / 1 / 3 / 5
5. Description: `p.text()` optional
6. Confirm: `p.confirm()`

Returns `DaemonTask | null` (null on cancel at any step → breaks back to task submenu).

## Step 12: CLI Commands (`src/daemon/commands/`)

Each follows `registerXxxCommand(program: Command)` pattern:

- **start.ts**: If PID exists → log "already running, tailing"; else `startDaemon()`
- **stop.ts**: `getDaemonPid()` → `process.kill(pid, "SIGTERM")` or "not running"
- **status.ts**: launchd status + PID + task table
- **install.ts**: `daemon install` → `installLaunchd()`, `daemon uninstall` → `uninstallLaunchd()`
- **config.ts**: `daemon config list|add|remove|enable|disable`
- **logs.ts**: `daemon logs` (interactive) / `daemon logs --task X` / `daemon logs --tail`

## Step 13: Entry Point (`src/daemon/index.ts`)

```typescript
if (process.argv.length <= 2) {
    // No subcommand → interactive menu
    p.intro(pc.bgCyan(pc.white(" daemon ")));
    await runInteractiveMenu();
} else {
    await program.parseAsync(process.argv);
}
```

---

## Verification

1. **Config CRUD**: `tools daemon config add` → creates task in config.json → `tools daemon config list` shows it
2. **Foreground run**: `tools daemon start` → runs scheduler, tasks execute on interval → Ctrl+C stops cleanly
3. **JSONL logs**: After a task runs, check `~/.genesis-tools/daemon/logs/<taskname>/` for JSONL files with meta/stdout/stderr/exit lines
4. **Retry**: Register task with `command: "exit 1"` and `retries: 2` → verify 3 attempts in log, failure notification
5. **Interactive**: `tools daemon` → navigate menu → add task → view logs → back navigation works at every level
6. **launchd**: `tools daemon install` → verify plist at `~/Library/LaunchAgents/com.genesis-tools.daemon.plist` → `launchctl list | grep daemon` shows running → `tools daemon uninstall` removes it
7. **Registration API**: Import `registerTask` from another tool's code → verify task appears in config.json
8. **Notifications**: On macOS, verify `osascript` notification fires on task start/complete/fail
