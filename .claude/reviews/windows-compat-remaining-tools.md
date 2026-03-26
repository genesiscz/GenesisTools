> Audited on 2026-03-24 | Scope: all `src/` directories, excluding already-fixed files in `fix/windows`
Every tool in `src/` was audited for Windows compatibility issues. **35 distinct issues** were found across 25 files in cross-platform tools. The biggest categories are: (1) spawning Unix shell commands (`sh -c`, `bash -c`, `sed`, `lsof`, `less`, `which`, `find`, `chmod`, `rm`), (2) hardcoded `/tmp/` paths instead of `os.tmpdir()`, (3) `process.env.SHELL` fallback to `/bin/sh`, and (4) `open` for launching URLs. Most are P1 (feature broken on Windows), with a few P0 crashes.
| Tool | Reason |
|------|--------|
| `macos/` | Apple Mail, JXA, system preferences |
| `macos-eslogger/` | macOS Endpoint Security |
| `macos-resources/` | macOS system resources (Ink/React-based) |
| `voice-memos/` | Apple Voice Memos |
| `darwinkit/` | Apple on-device ML (NaturalLanguage.framework) |
| `fsevents-profile/` | macOS fs_usage profiling |
| `say/` | macOS `say` TTS command |
| `notify/` | macOS terminal-notifier / osascript |
| `benchmark/` | Hardcoded osascript/terminal-notifier suites |
| `utils/macos/` | All of: `tts.ts`, `notifications.ts`, `apple-notes.ts`, `voice-memos.ts`, `ocr.ts`, `nlp.ts`, `icloud.ts`, `darwinkit.ts`, `system-settings.ts`, `auth.ts`, `system.ts` |
| `zsh/` | Shell hook manager for zsh/bash rc files |
All other tools fall into this category. Individual issues follow.
---
---
**Lines 475, 484, 488**
```ts
const messagesDir = `/tmp/genesis-tools-msgs-${Date.now()}`;
const indexFilePath = `/tmp/genesis-tools-index-${Date.now()}.txt`;
const editorScriptPath = `/tmp/genesis-tools-editor-${Date.now()}.sh`;
```
**Why:** `/tmp/` does not exist on Windows. Crashes with `ENOENT`.
**Fix:** Use `import { tmpdir } from "node:os"` and `join(tmpdir(), ...)`.
**Lines 491-517**
```ts
const editorScript = `#!/bin/bash\nset -euo pipefail\n...`;
```
**Why:** Generates a bash script and sets it as `GIT_EDITOR`. Bash is not available on Windows by default.
**Fix:** Use a cross-platform approach: write a Node/Bun script as the editor instead of a bash script. Or provide a Windows `.cmd` fallback.
**Line 519**
```ts
await Bun.spawn({ cmd: ["chmod", "+x", editorScriptPath] }).exited;
```
**Why:** `chmod` does not exist on Windows. Crashes.
**Fix:** Skip on Windows (`process.platform === "win32"`) -- Windows does not need execute permission bits.
**Line 523**
```ts
const sequenceEditorCmd = `sed -i '' 's/^pick /reword /' "$1"`;
```
**Why:** `sed -i ''` is BSD (macOS) syntax. GNU sed uses `sed -i`. On Windows, `sed` does not exist at all.
**Fix:** Use a Bun/Node script as the sequence editor instead of sed.
**Lines 538-540, 455**
```ts
await Bun.spawn({ cmd: ["rm", "-rf", messagesDir, indexFilePath, editorScriptPath] }).exited;
await Bun.spawn({ cmd: ["rm", "-f", lockFile], cwd: repoDir }).exited;
```
**Why:** `rm` does not exist on Windows.
**Fix:** Use `rmSync(path, { recursive: true, force: true })` from `node:fs`.
---
**Line 218**
```ts
const proc = Bun.spawn(["lsof", "-i", `:${port}`, "-n", "-P"], { ... });
```
**Why:** `lsof` is Unix-only. Windows has `netstat -ano` or PowerShell `Get-NetTCPConnection`.
**Fix:** On `win32`, use `Bun.spawn(["netstat", "-ano"])` and parse for the port.
**Lines 151, 177**
```ts
process.kill(pid, "SIGTERM");
process.kill(pid, "SIGKILL");
```
**Why:** `SIGTERM` and `SIGKILL` are not properly supported on Windows. `process.kill(pid)` works but unconditionally terminates.
**Fix:** On Windows, use `process.kill(pid)` or `Bun.spawn(["taskkill", "/PID", String(pid), "/F"])`.
---
**Line 42**
```ts
const proc = spawn("diff", ["-U", "20", oldFile, newFile], { ... });
```
**Why:** `diff` is not available on Windows by default (unless Git for Windows is installed).
**Fix:** Use a JS diff library (e.g., `diff` npm package already used in `npm-package-diff`) as fallback when `diff` is not found.
---
**Line 64**
```ts
const shell = process.env.SHELL || "/bin/sh";
// Then used as:
Bun.spawn({ cmd: [shell, "-ic", `'${candidate}' --version 2>&1`], ... });
```
**Why:** `SHELL` is not set on Windows. `/bin/sh` does not exist. `-ic` flags are Unix shell flags.
**Fix:** On Windows, use `Bun.which(candidate)` + direct spawn instead of interactive shell.
---
**Line 306**
```ts
const shell = process.env.SHELL || "/bin/sh";
const proc = Bun.spawn({
    cmd: [shell, "-ic", `exec ${cmd} --resume '${session.sessionId}'`],
});
```
**Why:** Same as above -- no SHELL on Windows, `/bin/sh` does not exist.
**Fix:** On Windows, spawn the command directly: `Bun.spawn({ cmd: [cmd, "--resume", session.sessionId] })`.
---
**Lines 50, 522**
```ts
Bun.spawn(["open", authUrl], { stdio: ["ignore", "ignore", "ignore"] });
```
**Why:** `open` is macOS-only. Windows uses `start`, Linux uses `xdg-open`.
**Fix:** Use `Browser.open(url)` from `src/utils/browser.ts` which already has cross-platform support.
---
**Lines 334, 340, 346**
```ts
execSync("which pnpm", { stdio: "ignore" });
execSync("which bun", { stdio: "ignore" });
execSync("which yarn", { stdio: "ignore" });
```
**Why:** `which` is Unix-only. Windows equivalent is `where`.
**Fix:** Use `Bun.which("pnpm")` (cross-platform) instead of `execSync("which ...")`.
**Line 1006**
```ts
execSync("which delta", { stdio: "ignore" });
```
**Why:** Same -- `which` does not exist on Windows.
**Fix:** Use `Bun.which("delta")`.
**Line 759**
```ts
this.pagerProcess = spawn("less", ["-R", "-F", "-X"], { ... });
```
**Why:** `less` is not available on Windows by default. The code does have a fallback (`on("error")`), so it degrades gracefully.
**Fix:** On Windows, skip paging or use `more`. Low priority since fallback exists.
---
**Lines 1-90**
```ts
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");
// ... launchctl load, launchctl unload, launchctl list
```
**Why:** `launchctl` and `~/Library/LaunchAgents/` are macOS-only.
**Fix:** Guard with `if (process.platform !== "darwin") throw new Error("Not supported")` or implement Windows Task Scheduler alternative.
---
**Lines 1-68** -- Same pattern as `daemon/lib/launchd.ts`.
**Fix:** Same approach -- platform guard or Windows Task Scheduler alternative.
---
**Line 119**
```ts
const proc = Bun.spawn(["bash", "-c", command], { ... });
```
**Why:** `bash` may not exist on Windows.
**Fix:** `process.platform === "win32" ? [process.env.COMSPEC || "cmd", "/c", command] : ["bash", "-c", command]`
---
**Line 20**
```ts
cmd: ["osascript", "-e", `display notification "${escapedMsg}" with title "${escapedTitle}"`],
```
**Why:** `osascript` is macOS-only.
**Fix:** Use PowerShell toast notifications on Windows.
**Lines 35-36**
```ts
const soundPath = `/System/Library/Sounds/${sound}.aiff`;
Bun.spawn({ cmd: ["afplay", soundPath], ... });
```
**Why:** `afplay` and `/System/Library/Sounds/` are macOS-only.
**Fix:** On Windows, use PowerShell SystemSounds or accept no-op.
---
**Lines 23, 35**
```ts
mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
chmodSync(filePath, 0o600);
```
**Why:** Unix permission modes are silently ignored on Windows.
**Fix:** Accept limitation or use `icacls`. Low priority -- does not crash.
---
**Line 14** -- `chmodSync(storage.getConfigPath(), 0o600)` -- no-op on Windows.
---
**Line 125** -- Same as above.
---
**Line 69**
```ts
const proc = Bun.spawn(["sh", "-c", task.command], { ... });
```
**Why:** `sh` does not exist on Windows.
**Fix:** Use `cmd /c` on Windows.
---
**Line 94**
```ts
const child = spawn(program, args, { shell: true });
```
**Why:** `shell: true` uses `cmd.exe` on Windows which has very different escaping rules. The `escapeShellArg` function uses single-quote wrapping which does not work with `cmd.exe`.
**Fix:** Avoid `shell: true`. Pass args as an array directly to `spawn("rg", [...args])`.
---
**Lines 8-15**
```ts
export const CLAUDE_DESKTOP_BASE = join(
    homedir(), "Library", "Application Support", "Claude",
    "local-agent-mode-sessions", "skills-plugin"
);
```
**Why:** On Windows, Claude Desktop uses `%APPDATA%\Claude\...`.
**Fix:** `process.platform === "win32" ? join(process.env.APPDATA || ..., "Claude") : join(homedir(), "Library", "Application Support", "Claude")`
---
**Line 98**
```ts
await Bun.spawn({ cmd: ["rm", "-f", path] }).exited;
```
**Why:** `rm` does not exist on Windows.
**Fix:** Use `rmSync(path, { force: true })`.
---
**Lines 18-20**
```ts
classify: { provider: "darwinkit" },
embed: { provider: "darwinkit" },
sentiment: { provider: "darwinkit" },
```
**Why:** `darwinkit` only works on macOS. On Windows, default config fails at runtime.
**Fix:** `provider: process.platform === "darwin" ? "darwinkit" : "local-hf"`
---
**Lines 213, 496, 710-711, 871**
```ts
const modelId = this.config.embedding?.model ?? "darwinkit";
```
**Why:** Falls back to macOS-only `darwinkit`.
**Fix:** Platform-aware default.
---
**Line 61**
```ts
const fallbackOrder: AIProviderType[] = ["darwinkit", "local-hf", "cloud", "ollama", "google"];
```
**Why:** On Windows, `darwinkit` always fails. Wastes time on the first attempt.
**Fix:** Filter out `darwinkit` on non-darwin.
---
**Lines 371-372** -- Default `["darwinkit"]` fails on Windows, falls back.
**Fix:** Platform-aware default.
---
**Lines 165, 169** -- Spawns `notify` and `say` tools which are macOS-only.
**Why:** On Windows, fails but `Promise.allSettled` prevents crashes.
**Fix:** Guard with platform check or implement cross-platform notification.
---
**Lines 898-904** -- Already uses `junction` for directories on win32. File symlinks require Developer Mode.
**Fix:** Document requirement or fallback to copy for files.
---
| Priority | Count | Description |
|----------|-------|-------------|
| **P0** | 7 | Crashes on startup or during core operation |
| **P1** | 16 | Feature completely broken on Windows |
| **P2** | 10 | Degraded behavior, silent failures, or no-op |
| **P3** | 2 | Cosmetic or already partially handled |
| File | Line(s) | Issue |
|------|---------|-------|
| `src/git-rename-commits/index.ts` | 475,484,488 | `/tmp/` hardcoded paths |
| `src/git-rename-commits/index.ts` | 491-517 | Bash shell script as GIT_EDITOR |
| `src/git-rename-commits/index.ts` | 519 | `chmod +x` via spawn |
| `src/git-rename-commits/index.ts` | 538-540,455 | `rm -rf` via spawn |
| `src/port/index.ts` | 218 | `lsof` command |
| `src/daemon/lib/launchd.ts` | all | Entire file is launchd-specific |
| `src/automate/lib/launchd.ts` | all | Entire file is launchd-specific |
| File | Line(s) | Issue |
|------|---------|-------|
| `src/git-rename-commits/index.ts` | 523 | BSD `sed -i ''` |
| `src/git-rename-commits/index.ts` | 538-540 | `rm -rf` via spawn |
| `src/port/index.ts` | 151,177 | SIGTERM/SIGKILL |
| `src/utils/diff.ts` | 42 | `diff` command |
| `src/utils/claude/index.ts` | 64 | `SHELL` / `/bin/sh` |
| `src/claude/commands/resume.ts` | 306 | `SHELL` / `/bin/sh` |
| `src/claude/commands/config.ts` | 50,522 | `open` for URLs |
| `src/npm-package-diff/index.ts` | 334,340,346 | `which` for pkg managers |
| `src/npm-package-diff/index.ts` | 1006 | `which delta` |
| `src/automate/lib/builtins.ts` | 119 | `bash -c` |
| `src/automate/lib/steps/notify.ts` | 20 | `osascript` |
| `src/automate/lib/steps/notify.ts` | 35-36 | `afplay` |
| `src/daemon/lib/runner.ts` | 69 | `sh -c` |
| `src/mcp-ripgrep/index.ts` | 94 | `shell: true` with Unix escaping |
| `src/claude/lib/desktop/index.ts` | 8-15 | macOS `Library/` path |
| `src/git-rebase-multiple/state.ts` | 98 | `rm -f` via spawn |
---
```ts
// Before
const file = `/tmp/genesis-tools-${Date.now()}.txt`;
// After
import { tmpdir } from "node:os";
const file = join(tmpdir(), `genesis-tools-${Date.now()}.txt`);
```
```ts
// Before
execSync("which pnpm", { stdio: "ignore" });
// After
Bun.which("pnpm")  // returns path or null, cross-platform
```
```ts
// Before
await Bun.spawn({ cmd: ["rm", "-f", path] }).exited;
// After
import { rmSync } from "node:fs";
try { rmSync(path, { force: true }); } catch {}
```
```ts
// Before
Bun.spawn(["sh", "-c", command], { ... });
// After
const shell = process.platform === "win32"
    ? [process.env.COMSPEC || "cmd", "/c", command]
    : ["sh", "-c", command];
Bun.spawn(shell, { ... });
```
```ts
// Before
Bun.spawn(["open", url]);
// After (use existing Browser utility)
import { Browser } from "@app/utils/browser";
await Browser.open(url);
// Browser.buildCommand already handles win32/linux/darwin
```
```ts
// Already acceptable -- chmodSync is a no-op on Windows
// Just wrap in try/catch if not already
try { chmodSync(path, 0o600); } catch {}
```
---
1. **Should `daemon` and `automate` daemon management be cross-platform?** Currently entirely launchd-based. Windows would need Task Scheduler (`schtasks`) or a service wrapper. If these are considered macOS-only features, they should be classified as such.
2. **Should `port` tool support Windows?** The entire approach (lsof-based) is Unix-specific. A Windows implementation would be fundamentally different (`netstat` parsing or PowerShell).
3. **Should `mcp-ripgrep` use shell?** The `shell: true` pattern with hand-built command strings is fragile. Switching to array-based args with `spawn("rg", args)` would fix both Windows compat and potential injection issues.
4. **AI provider defaults:** The `darwinkit` default is baked into multiple files. A centralized `getDefaultProvider()` function that checks `process.platform` would fix all instances at once.
