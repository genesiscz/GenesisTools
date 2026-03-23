> Explored on 2026-03-24 | Scope: `src/daemon/`, `src/automate/`, `src/utils/macos/notifications.ts`, `src/utils/storage/storage.ts`
Both the `daemon` and `automate` tools are deeply coupled to macOS via launchd (LaunchAgents plist files), `osascript`/`terminal-notifier` for notifications, `afplay` for sounds, `sh`/`bash` for command execution, and macOS NaturalLanguage framework for NLP. The core scheduler loop and task/config management are platform-agnostic, but the daemon lifecycle management layer would need a complete replacement for Windows (Windows Services or Task Scheduler). Signal handling (`SIGTERM`/`SIGINT`) partially works on Windows but with important caveats. PID file management works but `process.kill(pid, 0)` behaves differently. Roughly 60% of the code is portable; 40% needs platform-specific abstraction.
Both tools have nearly identical `launchd.ts` files that generate Apple plist XML, write to `~/Library/LaunchAgents/`, and call `launchctl load`/`unload`/`list`.
**daemon:** `src/daemon/lib/launchd.ts:5-90`
**automate:** `src/automate/lib/launchd.ts:5-68`
Key macOS-only elements:
- Plist XML generation (`generatePlist()`)
- `~/Library/LaunchAgents/` directory (does not exist on Windows)
- `launchctl load/unload/list` commands (macOS only)
- `RunAtLoad`, `KeepAlive`, `ThrottleInterval` semantics
**Windows alternatives:**
| macOS Concept | Windows Equivalent | API/Tool |
|---|---|---|
| LaunchAgent plist | Windows Service | `sc.exe create`, `nssm`, or `node-windows` |
| `launchctl load` | `sc start` / Task Scheduler `schtasks` | Win32 API |
| `launchctl list` | `sc query` / `tasklist` | Win32 API |
| `KeepAlive` | Service recovery options / `sc failure` | Service Control Manager |
| `RunAtLoad` | Service start type = Auto | `sc config start= auto` |
**Suggested approach:** Extract a `PlatformDaemonManager` interface:
```typescript
interface PlatformDaemonManager {
    install(): Promise<void>;
    uninstall(): Promise<void>;
    getStatus(): Promise<{ installed: boolean; running: boolean; pid: number | null }>;
    readonly logDir: string;
}
```
Implement `LaunchdDaemonManager` (existing code) and `WindowsServiceManager` (new).
**daemon:** `src/daemon/daemon.ts:9-10` (write), `src/daemon/daemon.ts:35-54` (read+validate)
**automate:** `src/automate/lib/daemon.ts:12` (write), `src/automate/lib/daemon.ts:36-51` (read+validate)
Both tools write `process.pid` to a file and validate with `process.kill(pid, 0)`:
```typescript
// daemon.ts:46 and automate/lib/daemon.ts:43
process.kill(pid, 0);  // Check if process is alive
```
**Windows issue:** `process.kill(pid, 0)` on Windows does NOT reliably check if a process is alive -- it actually terminates the process on some Node/Bun versions because Windows doesn't support signal 0. Bun's behavior may differ from Node here but this is fragile.
**Suggested approach:**
```typescript
function isProcessRunning(pid: number): boolean {
    if (process.platform === "win32") {
        const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        return result.stdout.toString().includes(String(pid));
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
```
**Locations:**
- `src/daemon/lib/scheduler.ts:20-21` -- `SIGTERM`, `SIGINT`
- `src/daemon/daemon.ts:21-22` -- `SIGTERM`, `SIGINT`
- `src/daemon/commands/stop.ts:39` -- `process.kill(pid, "SIGTERM")`
- `src/daemon/interactive/menu.ts:239` -- `process.kill(pid, "SIGTERM")`
- `src/automate/lib/scheduler.ts:16-17` -- `SIGTERM`, `SIGINT`
- `src/automate/lib/daemon.ts:24-25` -- `SIGTERM`, `SIGINT`
**Windows behavior:**
- `SIGINT` (Ctrl+C) works on Windows via console event
- `SIGTERM` is NOT a real signal on Windows. `process.kill(pid, 'SIGTERM')` on Windows **unconditionally terminates** the process (equivalent to `SIGKILL`) with no chance for cleanup
- `process.on('SIGTERM', handler)` -- the handler may never fire on Windows because the process is killed immediately
**Impact:** The graceful shutdown flow (wait for active tasks, cleanup PID file) in `scheduler.ts:70-83` and `daemon.ts:13-19` will NOT execute on Windows when stopped via `process.kill(pid, 'SIGTERM')`.
**Suggested approach:**
- Use a named pipe or file-based signal mechanism for graceful shutdown on Windows
- Or use `process.kill(pid, 'SIGINT')` which maps to `GenerateConsoleCtrlEvent(CTRL_C_EVENT)` and can be caught
- Alternative: Write a sentinel file that the daemon polls (e.g., `daemon.stop` in the data dir)
**daemon:** `src/daemon/lib/runner.ts:69`
```typescript
const proc = Bun.spawn(["sh", "-c", task.command], { ... });
```
**automate:** `src/automate/lib/builtins.ts:119`
```typescript
const proc = Bun.spawn(["bash", "-c", command], { ... });
```
**Windows issue:** Neither `sh` nor `bash` exist on a stock Windows installation. Windows uses `cmd.exe` or `powershell.exe`.
**Suggested approach:**
```typescript
function getShellCommand(command: string): string[] {
    if (process.platform === "win32") {
        return ["cmd.exe", "/c", command];
    }
    return ["sh", "-c", command];
}
```
Note: `cmd.exe` has different quoting, escaping, and piping rules than sh/bash. Commands like `echo $HOME` won't work -- would need `echo %USERPROFILE%`. This is a semantic compatibility gap, not just a binary swap.
**daemon:** `src/daemon/commands/logs.ts:84`
```typescript
const proc = Bun.spawn(["tail", "-f", ...files], { ... });
```
**automate:** `src/automate/commands/daemon.ts:31`
```typescript
const proc = Bun.spawn(["tail", "-f", ...files], { ... });
```
Also in automate: `src/automate/commands/daemon.ts:58`
```typescript
const proc = Bun.spawnSync(["tail", `-${lines}`, ...files], { ... });
```
**Windows issue:** `tail` is not available on Windows.
**Suggested approach:** Implement a pure-TypeScript file tail using `fs.watch()` + read from last known offset. Or use `Get-Content -Wait -Tail N` via PowerShell. A pure-TS approach is more portable:
```typescript
import { watch, openSync, readSync, statSync } from "node:fs";
// ... watch file for changes, read new bytes from last offset
```
**daemon scheduler:** `src/daemon/lib/scheduler.ts:89-94, 104-109, 123-128` -- calls `sendNotification()`
**notifications utility:** `src/utils/macos/notifications.ts` -- uses `terminal-notifier` and `osascript`
The `sendNotification` function is imported from `@app/utils/macos/notifications` and is 100% macOS-specific:
- `terminal-notifier` binary (macOS only)
- `osascript -e 'display notification ...'` (macOS only)
- `tools say` for TTS (likely macOS `say` command)
**automate notify.desktop:** `src/automate/lib/steps/notify.ts:19-23`
```typescript
const proc = Bun.spawn({
    cmd: ["osascript", "-e", `display notification "${escapedMsg}" with title "${escapedTitle}"`],
});
```
**automate notify.sound:** `src/automate/lib/steps/notify.ts:35-36`
```typescript
const soundPath = `/System/Library/Sounds/${sound}.aiff`;
const proc = Bun.spawn({ cmd: ["afplay", soundPath], ... });
```
**Windows alternatives:**
| macOS | Windows |
|---|---|
| `terminal-notifier` / `osascript` | `PowerShell [Windows.UI.Notifications.ToastNotificationManager]` or `node-notifier` |
| `afplay /System/Library/Sounds/Glass.aiff` | `PowerShell [System.Media.SoundPlayer]` or `rundll32 user32.dll,MessageBeep` |
**Suggested approach:** Abstract behind `import { sendNotification } from "@app/utils/platform/notifications"` with platform detection:
```typescript
if (process.platform === "darwin") {
    // existing macOS code
} else if (process.platform === "win32") {
    // PowerShell toast notification
} else {
    // Linux: notify-send
}
```
**automate:** `src/automate/lib/steps/nlp.ts:6`
```typescript
import { analyzeSentiment, closeDarwinKit, detectLanguage, embedText, tagText, textDistance } from "@app/utils/macos";
```
The entire `nlp.*` step family (sentiment, language, tag, distance, embed) depends on macOS NaturalLanguage framework via DarwinKit FFI. There is no Windows equivalent without pulling in a third-party NLP library.
**Suggested approach:** On Windows, either:
- Disable the `nlp.*` steps with a clear error ("NLP steps require macOS")
- Provide fallback implementations using a cross-platform library (e.g., `compromise` for tagging, a simple sentiment library)
**Storage base dir:** `src/utils/storage/storage.ts:27`
```typescript
this.baseDir = join(homedir(), ".genesis-tools", toolName);
```
This works on Windows (`C:\Users\<user>\.genesis-tools\<tool>`). Dotfiles are less conventional on Windows but functional.
**Plist path:** `src/daemon/lib/launchd.ts:5`
```typescript
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");
```
This is macOS-only. The `~/Library/` directory does not exist on Windows. This is already gated behind launchd functionality so it's naturally platform-specific.
**Bun path fallback:** `src/daemon/lib/launchd.ts:16` and `src/automate/lib/launchd.ts:16`
```typescript
const bunPath = Bun.which("bun") ?? "/usr/local/bin/bun";
```
Fallback path is Unix-specific. On Windows it would be something like `C:\Users\<user>\.bun\bin\bun.exe`.
**PATH in plist:** `src/daemon/lib/launchd.ts:30`
```typescript
<string>/usr/local/bin:/usr/bin:/bin:${dirname(bunPath)}</string>
```
Unix PATH format with colons. Windows uses semicolons and different paths.
These components work across platforms without modification:
| Component | Location | Notes |
|---|---|---|
| Config storage (JSON-based) | `src/daemon/lib/config.ts` | Uses `Storage` class, `homedir()` |
| Task registration/CRUD | `src/daemon/lib/register.ts` | Pure logic |
| Interval parsing | `src/daemon/lib/interval.ts`, `src/automate/lib/interval-parser.ts` | Pure logic |
| Scheduler loop logic | `src/daemon/lib/scheduler.ts` (minus signals+notifications) | Core loop is platform-agnostic |
| Log reading/writing (JSONL) | `src/daemon/lib/log-reader.ts`, `src/daemon/lib/runner.ts` (minus `sh -c`) | Uses Node fs APIs |
| Types | `src/daemon/lib/types.ts`, `src/automate/lib/types.ts` | Pure types |
| Automate engine | `src/automate/lib/engine.ts` | Core execution loop |
| Automate DB (SQLite) | `src/automate/lib/db.ts` | `bun:sqlite` is cross-platform |
| Automate storage | `src/automate/lib/storage.ts` | Uses `Storage` class |
| Step runner (minus shell) | `src/automate/lib/step-runner.ts` | Tool dispatch is portable |
| Interactive TUI | `src/daemon/interactive/*.ts` | `@clack/prompts` works on Windows |
| Expression engine | `src/automate/lib/expressions.ts` | Pure logic |
```
+-----------------------------------------------------------+
|                    CLI Entry Point                          |
|  src/daemon/index.ts  |  src/automate/index.ts            |
+------------+----------------------------+-----------------+
             |                            |
     +-------v--------+          +-------v--------+
     |   Commands      |          |   Commands      |
     |  install/start  |          |  daemon start   |
     |  stop/status    |          |  daemon install  |
     +-------+--------+          +-------+--------+
             |                            |
     +-------v----------------------------v--------+
     |         PLATFORM BOUNDARY                    |
     |                                              |
     |  +--------------+   +--------------------+  |
     |  |  launchd.ts  |   |  notifications.ts  |  |  <-- macOS-only
     |  |  (plist/ctl) |   |  (osascript/tn)    |  |
     |  +--------------+   +--------------------+  |
     |  +----------+  +---------+  +-----------+   |
     |  | runner.ts|  | tail -f |  | afplay    |   |  <-- Unix shell cmds
     |  | (sh -c)  |  |         |  | osascript |   |
     |  +----------+  +---------+  +-----------+   |
     |  +--------------+                            |
     |  | SIGTERM/kill |                            |  <-- Partial Windows
     |  +--------------+                            |
     +----------------------------------------------+
             |                            |
     +-------v----------------------------v--------+
     |         PORTABLE CORE                        |
     |                                              |
     |  scheduler.ts  config.ts  interval.ts       |
     |  types.ts  log-reader.ts  register.ts       |
     |  engine.ts  db.ts  storage.ts               |
     +----------------------------------------------+
```
| File | Role | Windows Impact |
|------|------|----------------|
| `src/daemon/lib/launchd.ts` | macOS LaunchAgent management | **REPLACE** -- needs Windows Service/Task Scheduler equivalent |
| `src/daemon/daemon.ts` | Entry point, PID file, signal handlers | **MODIFY** -- PID validation, signal handling |
| `src/daemon/lib/scheduler.ts` | Core scheduler loop | **MODIFY** -- signal handlers, notification calls |
| `src/daemon/lib/runner.ts:69` | Task execution via `sh -c` | **MODIFY** -- shell command |
| `src/daemon/commands/stop.ts:39` | Sends SIGTERM to daemon | **MODIFY** -- need Windows-compatible stop mechanism |
| `src/daemon/commands/logs.ts:84` | `tail -f` for log tailing | **REPLACE** -- need TS-native or PowerShell equivalent |
| `src/daemon/commands/install.ts` | Install/uninstall launchd | **REPLACE** -- Windows Service registration |
| `src/daemon/commands/status.ts` | Queries launchd for status | **MODIFY** -- query Windows Service status instead |
| `src/daemon/interactive/menu.ts:239` | Sends SIGTERM to stop | **MODIFY** -- Windows stop mechanism |
| `src/daemon/lib/config.ts` | Config storage (JSON) | Portable |
| `src/daemon/lib/register.ts` | Task registration | Portable |
| `src/daemon/lib/interval.ts` | Interval parsing | Portable |
| `src/daemon/lib/log-reader.ts` | JSONL log reader | Portable |
| `src/daemon/lib/types.ts` | Type definitions | Portable |
| `src/daemon/interactive/task-editor.ts` | Interactive task creation | Portable |
| `src/daemon/interactive/log-viewer.ts` | Interactive log browser | Portable |
| `src/daemon/index.ts` | CLI entry point | Portable |
| File | Role | Windows Impact |
|------|------|----------------|
| `src/automate/lib/launchd.ts` | macOS LaunchAgent management | **REPLACE** |
| `src/automate/lib/daemon.ts` | Entry point, PID file, signals | **MODIFY** -- PID validation, signal handling |
| `src/automate/lib/scheduler.ts` | Core scheduler loop | **MODIFY** -- signal handlers |
| `src/automate/commands/daemon.ts:31,58` | `tail -f` / `tail -N` | **REPLACE** |
| `src/automate/lib/builtins.ts:119` | `shell` action via `bash -c` | **MODIFY** -- `cmd.exe /c` on Windows |
| `src/automate/lib/steps/notify.ts:19-23` | Desktop notification via osascript | **REPLACE** |
| `src/automate/lib/steps/notify.ts:35-36` | Sound via `afplay` + `/System/Library/Sounds/` | **REPLACE** |
| `src/automate/lib/steps/nlp.ts` | NLP via macOS NaturalLanguage | **REPLACE** or disable |
| `src/automate/lib/engine.ts` | Preset execution engine | Portable |
| `src/automate/lib/db.ts` | SQLite database | Portable |
| `src/automate/lib/storage.ts` | Preset storage | Portable |
| `src/automate/lib/step-runner.ts` | Step dispatch | Portable |
| `src/automate/lib/types.ts` | Type definitions | Portable |
| `src/automate/lib/interval-parser.ts` | Interval parsing | Portable |
| `src/automate/lib/expressions.ts` | Expression evaluation | Portable |
| `src/automate/index.ts` | CLI entry point | Portable |
| File | Role | Windows Impact |
|------|------|----------------|
| `src/utils/macos/notifications.ts` | terminal-notifier + osascript | **REPLACE** for Windows |
| `src/utils/storage/storage.ts` | `~/.genesis-tools/<tool>/` | Portable (dotdir works on Windows) |
| `src/utils/cli/tools.ts` | `runTool()` via `bun run` | Portable |
```typescript
// src/daemon/lib/launchd.ts:5
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");
// :38-46
export async function installLaunchd(): Promise<void> {
    mkdirSync(join(homedir(), ".genesis-tools", "daemon", "logs"), { recursive: true });
    await Bun.write(PLIST_PATH, generatePlist());
    const proc = Bun.spawn(["launchctl", "load", PLIST_PATH], ...);
}
```
```typescript
// src/daemon/daemon.ts:45-48
try {
    process.kill(pid, 0);  // On Windows: may KILL the process instead of probing
    return pid;
} catch { return null; }
```
```typescript
// src/daemon/lib/runner.ts:69
const proc = Bun.spawn(["sh", "-c", task.command], { ... });
// src/automate/lib/builtins.ts:119
const proc = Bun.spawn(["bash", "-c", command], { ... });
```
```typescript
// src/daemon/commands/stop.ts:39
process.kill(pid, "SIGTERM");  // On Windows: immediate termination, no handler runs
```
Create `src/utils/platform.ts`:
```typescript
export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export function getShell(): [string, string] {
    return IS_WINDOWS ? ["cmd.exe", "/c"] : ["sh", "-c"];
}
```
Create `src/utils/daemon/manager.ts` interface, with:
- `src/utils/daemon/launchd.ts` (existing code, extracted)
- `src/utils/daemon/windows-service.ts` (new, uses `sc.exe` or `schtasks`)
Move from `src/utils/macos/notifications.ts` to `src/utils/platform/notifications.ts` with platform switching.
Replace `process.kill(pid, 'SIGTERM')` with a cross-platform stop mechanism (file-based signal or named pipe on Windows).
| Area | Files to Change | Effort |
|------|-----------------|--------|
| Daemon manager abstraction | 4 new + 4 modified | High (Windows Service API is complex) |
| Shell command abstraction | 2 modified | Low |
| PID file / process check | 2 modified | Low |
| Signal handling | 4 modified | Medium |
| Notification abstraction | 3 new + 2 modified | Medium |
| Log tailing | 2 modified or 1 new utility | Low-Medium |
| NLP steps | 1 modified | Low (just disable or guard) |
| **Total** | ~15 files | **Medium-High** |
1. **Is Bun fully supported on Windows?** Bun's Windows support has been improving but `bun:sqlite` and `Bun.spawn` behavior may have edge cases. Worth testing.
2. **Windows Service vs Task Scheduler?** A Windows Service provides the closest equivalent to launchd's `KeepAlive` behavior. Task Scheduler is simpler but doesn't offer auto-restart on crash. For a background daemon, a Service is more appropriate.
3. **Should `cmd.exe` or `powershell` be the default shell on Windows?** PowerShell is more capable but slower to start. `cmd.exe` is lighter but less featureful. Could offer a config option.
4. **Is Linux support also desired?** Linux uses systemd user services (`systemctl --user`), which is a third daemon management backend. The abstraction should account for this if planned.
