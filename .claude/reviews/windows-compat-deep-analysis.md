# Windows Compatibility Analysis: azure-devops + clarity + shared utilities

> Analyzed 2026-03-24 | Scope: `src/azure-devops/`, `src/clarity/`, `src/utils/storage/`, `src/utils/cli/`, `src/utils/async.ts`, `src/utils/url.ts`, `src/utils/json.ts`, `src/utils/date.ts`, `src/utils/curl.ts`, `src/utils/markdown/html-to-md.ts`, `src/utils/readme.ts`, `src/utils/clarity/`, `src/logger.ts`

## Summary

Both tools have **moderate** Windows compatibility. The majority of business logic (API calls, caching, formatting) is platform-agnostic. The blocking issues are: (1) heavy reliance on `Bun.$` shell template literals which use `/bin/sh` on Unix and `cmd.exe` on Windows -- `az` CLI commands generally work on both but need testing, (2) one filesystem path constructed with string concatenation using `/` instead of `path.join()`, (3) `chmod(path, 0o600)` is a no-op/error on Windows, (4) `process.kill(pid, 0)` for liveness detection works differently on Windows, and (5) the `defaults read` macOS-only locale detection in `src/utils/date.ts`. The `open`/`xdg-open` browser launching in clarity's UI command already has a Windows code path.

## Key Findings

### 1. Bun Shell (`$` template literal) -- 11 call sites

Every `az` CLI invocation in both tools uses Bun's `$` tagged template, which spawns a shell. On macOS/Linux this uses `/bin/sh`; on Windows, Bun's `$` uses its own cross-platform shell implementation (not `cmd.exe`). The `az` CLI itself is available on Windows, so these calls should work -- **but need testing** since Bun's `$` on Windows is relatively new.

| File | Line | Command | Risk |
|------|------|---------|------|
| `src/azure-devops/api.ts` | 183 | `az account get-access-token --resource ... --query accessToken -o tsv` | LOW -- `az` works on Windows, Bun `$` handles quoting |
| `src/azure-devops/api.ts` | 963 | Same as above (static method `getProjectId`) | LOW |
| `src/azure-devops/api.ts` | 989 | Same as above (static method `getProjects`) | LOW |
| `src/azure-devops/commands/configure.ts` | 29 | `az account show` | LOW |
| `src/azure-devops/commands/configure.ts` | 81 | `az devops configure --defaults organization=... project=...` | LOW |
| `src/azure-devops/commands/timelog/configure.ts` | 69 | `az rest --method GET --resource "..." --uri "..."` | **MEDIUM** -- long interpolated URL in shell context |
| `src/azure-devops/commands/history-activity.ts` | 461 | `az account show --query user.name -o tsv` | LOW |
| `src/azure-devops/commands/history-search.ts` | 171 | `az account get-access-token ...` | LOW |
| `src/azure-devops/workitem-precheck.ts` | 64 | `az ${command}` -- command is an array spread into shell | **MEDIUM** -- array interpolation in `$` needs careful handling |

**Verdict:** Bun's `$` on Windows uses its own built-in shell (not `cmd.exe`), so these should work if Bun's Windows shell handles the `az` CLI correctly. The main risk is in `workitem-precheck.ts:64` where an array is interpolated (`$\`az ${command}\``) -- Bun should escape the array elements, but this pattern is less battle-tested.

### 2. `Bun.spawn()` calls -- 1 call site in scope

| File | Line | Command | Windows compatible? |
|------|------|---------|---------------------|
| `src/clarity/index.ts` | 24 | `Bun.spawn(["bun", "run", "dev"], ...)` | YES -- `bun` is on PATH if installed |
| `src/clarity/index.ts` | 35 | `Bun.spawn(["open", url])` | NO -- macOS only, but **guarded** by `process.platform === "darwin"` |
| `src/clarity/index.ts` | 37 | `Bun.spawn(["cmd", "/c", "start", url])` | YES -- this IS the Windows path |
| `src/clarity/index.ts` | 39 | `Bun.spawn(["xdg-open", url])` | NO -- Linux only, but guarded by else branch |

**Verdict:** The browser-opening code in `clarity/index.ts:34-40` already handles all three platforms correctly. No issue.

### 3. Path Construction Issues

#### 3a. String concatenation with `/` instead of `path.join()`

| File | Line | Code | Severity |
|------|------|------|----------|
| `src/azure-devops/commands/workitem.ts` | 296 | `` `${getTasksDir(finalCategory)}/${id}` `` | **HIGH** -- filesystem path, will produce wrong separator on Windows |
| `src/utils/storage/storage.ts` | 367 | `` `${prefix}/${entry.name}` `` | **MEDIUM** -- used in `listCacheFiles()` for relative paths within cache dir; inconsistent separator but functional since it's only used for display/comparison |
| `src/azure-devops/cache-manager.ts` | 33,38,42 | `` `${domain}/${key}.json` `` | **LOW** -- passed to `Storage.getCacheFile()` which uses `path.join(cacheDir, relativePath)` internally, so the `/` becomes a legitimate part of a filename path segment. However, `path.join()` on Windows normalizes `/` to `\`, so this actually works. |

#### 3b. URL-like paths (not filesystem) -- FALSE POSITIVES

These use `/` for URL segments and API paths, not filesystem paths:

- `src/azure-devops/timelog-api.ts:109` -- API URL path (`/timelog/project/.../workitem/...`)
- `src/azure-devops/lib/urls.ts:11` -- Web URL (`org/project/_workitems/edit/id`)
- `src/azure-devops/api.ts:610,738` -- API URL path segments

These are all correct -- URLs always use forward slashes.

#### 3c. Properly handled paths

All other filesystem path construction in both tools uses `path.join()` or `path.resolve()`:
- `src/azure-devops/config.ts` -- `join(currentDir, configName)`, `join(process.cwd(), ".claude/azure")`
- `src/azure-devops/task-files.ts` -- all paths use `join()`
- `src/azure-devops/cache.ts` -- `join(cacheDir, file)`
- `src/utils/storage/storage.ts` -- `join(homedir(), ".genesis-tools", toolName)`, `join(this.baseDir, "cache")`

### 4. `homedir()` and Environment Variables

| File | Line | Usage | Windows compatible? |
|------|------|-------|---------------------|
| `src/utils/storage/storage.ts` | 27 | `homedir()` from `node:os` | YES -- returns `C:\Users\<user>` on Windows |
| `src/azure-devops/config.ts` | 21 | `process.env.CLARITY_PROJECT_CWD` | YES -- custom env var, works on all platforms |
| `src/azure-devops/cli.utils.ts` | 78,92 | `process.env.DEBUG` | YES |
| `src/logger.ts` | 29-35 | `process.env.LOG_TRACE`, `LOG_DEBUG`, `LOG_SILENT`, `LOG_PID`, `DEBUG` | YES |

No usage of `HOME`, `XDG_*`, or `TMPDIR` in the scoped files. The `homedir()` function correctly handles Windows (`USERPROFILE`/`HOMEDRIVE+HOMEPATH`).

### 5. File Permission: `chmod()`

| File | Line | Code | Severity |
|------|------|------|----------|
| `src/clarity/config.ts` | 48 | `await chmod(storage.getConfigPath(), 0o600)` | **MEDIUM** -- `chmod` on Windows is a no-op or may throw. Node.js docs say Windows only supports changing the read-only bit. `0o600` (owner read/write) will likely be silently ignored but could throw on some Windows Node/Bun builds. |

**Fix:** Wrap in try-catch or check `process.platform !== "win32"` before calling.

### 6. File Locking: `process.kill(pid, 0)` for Stale Lock Detection

| File | Line | Code | Severity |
|------|------|------|----------|
| `src/utils/storage/file-lock.ts` | 21 | `process.kill(pid, 0)` | **MEDIUM** -- On Unix, signal 0 checks process existence without killing. On Windows, Node.js/Bun emulates this check but the behavior may differ for processes owned by other users. Generally works for same-user processes. |

The `O_CREAT|O_EXCL` (`{ flag: "wx" }`) file locking pattern itself is **cross-platform** -- both Unix and Windows support exclusive file creation.

### 7. macOS-only Locale Detection

| File | Line | Code | Severity |
|------|------|------|----------|
| `src/utils/date.ts` | 23-28 | `execSync("defaults read NSGlobalDomain AppleLocale", ...)` | **LOW** -- guarded by `process.platform === "darwin"`. Falls back to `$LC_TIME`/`$LANG`/`Intl.DateTimeFormat` on non-macOS. No Windows issue. |

### 8. `Bun.file()` and `Bun.write()` -- Bun-specific APIs

These are used throughout for file I/O and are cross-platform within Bun:

| File | Lines | Usage |
|------|-------|-------|
| `src/utils/storage/storage.ts` | 91, 150, 160, 255, 275, 454, 470, 528, 548 | `Bun.file().text()`, `Bun.write()` |
| `src/utils/storage/file-lock.ts` | 58, 74 | `Bun.file().text()` |
| `src/azure-devops/cache.ts` | 205 | `Bun.file().text()` |
| `src/azure-devops/inline-images.ts` | 115 | `Bun.write()` |
| `src/azure-devops/commands/attachments.ts` | 80 | `Bun.write()` |
| `src/azure-devops/commands/timelog/export-month.ts` | 37, 111 | `Bun.write()` |

**Verdict:** These are Bun runtime APIs, not OS-specific. They work on Windows as long as Bun is installed. No issue.

### 9. Signal Handling

No `SIGINT`/`SIGTERM`/`SIGHUP` handlers found in either `azure-devops/` or `clarity/` code. No issue.

### 10. Socket/Pipe Paths

None found in either tool. No issue.

### 11. Unix-only Commands

| Command | File | Line | Windows? |
|---------|------|------|----------|
| `open` (macOS) | `src/clarity/index.ts` | 35 | Guarded by `process.platform === "darwin"` |
| `cmd /c start` (Windows) | `src/clarity/index.ts` | 37 | This IS the Windows path |
| `xdg-open` (Linux) | `src/clarity/index.ts` | 39 | Guarded by else branch |
| `defaults read` (macOS) | `src/utils/date.ts` | 25 | Guarded by `process.platform === "darwin"` |
| `az` (Azure CLI) | multiple | multiple | Available on Windows, but see Section 1 |

No usage of `diff`, `grep`, `cat`, `cp`, `mv`, `rm` (bare), or other Unix-only commands in the scoped code.

### 12. Error Messages with Unix Assumptions

| File | Line | Code | Note |
|------|------|------|------|
| `src/utils/storage/storage.ts` | 99-100 | `$EDITOR "path"` and `cp "path" "path.bak"` in error suggestion | Minor -- `$EDITOR` may not be set on Windows, `cp` is not available. Could suggest `copy` on Windows or use cross-platform wording. |

## Architecture / Flow

```
clarity/index.ts (entry)
  ├── commands/configure.ts  → ClarityApi (HTTP), parse-auth-curl, Storage
  ├── commands/timesheet.ts  → ClarityApi (HTTP), cli-table3
  ├── commands/fill.ts       → ClarityApi + TimeLogApi (HTTP), Storage
  ├── commands/link-workitems.ts → ClarityApi + TimeLogApi, Storage
  └── "ui" command           → Bun.spawn(["bun","run","dev"]) + open/cmd/xdg-open

azure-devops/index.ts (entry)
  ├── commands/configure.ts  → Bun.$ `az ...`, writeFileSync
  ├── commands/workitem.ts   → Api (HTTP + Bun.$ for token), Storage, task-files
  ├── commands/query.ts      → Api (HTTP), Storage
  ├── commands/timelog/*.ts   → Bun.$ `az rest ...`, TimeLogApi (HTTP)
  ├── commands/history-*.ts  → Bun.$ `az account show`, Api (HTTP), Storage
  ├── workitem-precheck.ts   → Bun.$ `az boards work-item show`
  └── api.ts                 → Bun.$ `az account get-access-token`, fetch()

Shared utilities:
  src/utils/storage/storage.ts  → homedir(), Bun.file/write, path.join
  src/utils/storage/file-lock.ts → process.kill(pid,0), writeFile({flag:"wx"})
  src/utils/date.ts             → execSync("defaults read") [macOS guard]
  src/utils/clarity/api.ts      → fetch() [pure HTTP]
```

## File Map

| File | Role | Windows Issues |
|------|------|----------------|
| `src/azure-devops/api.ts` | Azure DevOps REST API + `az` token via `Bun.$` | `Bun.$` on Windows (LOW risk) |
| `src/azure-devops/cache.ts` | Cache read/write using Storage | None |
| `src/azure-devops/cache-manager.ts` | Domain-specific cache wrapper | None |
| `src/azure-devops/config.ts` | Config file search via `path.join` | None |
| `src/azure-devops/cli.utils.ts` | Error message helpers | None |
| `src/azure-devops/task-files.ts` | Task file path building via `path.join` | None |
| `src/azure-devops/inline-images.ts` | Image download + `Bun.write` | None |
| `src/azure-devops/timelog-api.ts` | TimeLog REST API via `fetch()` | None |
| `src/azure-devops/workitem-precheck.ts` | Work item validation via `Bun.$ \`az ...\`` | `Bun.$` array interpolation (MEDIUM) |
| `src/azure-devops/commands/configure.ts` | `az account show` + `az devops configure` via `Bun.$` | `Bun.$` on Windows (LOW) |
| `src/azure-devops/commands/workitem.ts` | Work item fetch + save | Path concat with `/` on line 296 (**HIGH**) |
| `src/azure-devops/commands/timelog/configure.ts` | `az rest` with long URL via `Bun.$` | Long URL in shell (MEDIUM) |
| `src/azure-devops/commands/history-activity.ts` | `az account show` via `Bun.$` | `Bun.$` on Windows (LOW) |
| `src/azure-devops/commands/history-search.ts` | `az` token via `Bun.$` | `Bun.$` on Windows (LOW) |
| `src/azure-devops/lib/urls.ts` | URL builder (web URLs, not filesystem) | None |
| `src/azure-devops/lib/work-item-enrichment.ts` | Cached enrichment via Storage + API | None |
| `src/azure-devops/lib/work-item-search.ts` | WIQL search via API | None |
| `src/clarity/index.ts` | Entry point, `Bun.spawn` for UI + browser open | **Already handles** win32 |
| `src/clarity/config.ts` | Config with `chmod(path, 0o600)` | `chmod` no-op/error on Windows (**MEDIUM**) |
| `src/clarity/commands/configure.ts` | Interactive cURL paste setup | None |
| `src/clarity/commands/fill.ts` | Fill timesheets from ADO data | None |
| `src/clarity/commands/timesheet.ts` | View/submit/revert timesheets | None |
| `src/clarity/commands/link-workitems.ts` | Link ADO to Clarity tasks | None |
| `src/clarity/lib/parse-auth-curl.ts` | Parse cURL for auth tokens | None |
| `src/clarity/lib/fill-utils.ts` | Build fill entries from ADO data | None |
| `src/clarity/lib/timelog-workitems.ts` | ADO timelog → work item groups | None |
| `src/clarity/lib/timesheet-weeks.ts` | Timesheet week navigation | None |
| `src/utils/storage/storage.ts` | `homedir()` + `path.join` everywhere | `/` in `listCacheFiles` (LOW) |
| `src/utils/storage/file-lock.ts` | `O_CREAT\|O_EXCL` lock + `process.kill(pid,0)` | `process.kill` behavior (MEDIUM) |
| `src/utils/date.ts` | `defaults read` macOS locale | Guarded by platform check |
| `src/utils/clarity/api.ts` | Clarity REST API via `fetch()` | None |
| `src/utils/url.ts` | URL builder (web URLs) | None |
| `src/utils/async.ts` | retry, debounce, concurrentMap | None |
| `src/utils/json.ts` | SafeJSON wrapper | None |
| `src/utils/curl.ts` | cURL command parser | None |
| `src/utils/readme.ts` | README renderer | None |
| `src/utils/markdown/html-to-md.ts` | HTML→Markdown via Turndown | None |
| `src/logger.ts` | Pino logger setup | None |

## Code Excerpts

### HIGH: Path concatenation with `/` in workitem.ts

```typescript
// src/azure-devops/commands/workitem.ts:296
const tasksDir = finalTaskFolder ? `${getTasksDir(finalCategory)}/${id}` : getTasksDir(finalCategory);
```

**Fix:**
```typescript
const tasksDir = finalTaskFolder ? join(getTasksDir(finalCategory), String(id)) : getTasksDir(finalCategory);
```

### MEDIUM: `chmod` on Windows in clarity config

```typescript
// src/clarity/config.ts:48
await chmod(storage.getConfigPath(), 0o600);
```

**Fix:**
```typescript
if (process.platform !== "win32") {
    await chmod(storage.getConfigPath(), 0o600);
}
```

### MEDIUM: `Bun.$` with array interpolation

```typescript
// src/azure-devops/workitem-precheck.ts:64
const result = await $`az ${command}`.quiet();
// where command = ["boards", "work-item", "show", "--id", String(id), "--org", org, "-o", "json"]
```

Bun's `$` shell handles array interpolation by joining with spaces and escaping. This works on Unix; Windows behavior under Bun's built-in shell should be verified.

### LOW: `/` in relative path for listCacheFiles

```typescript
// src/utils/storage/storage.ts:367
const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
```

Used only for building relative paths within the cache listing. The `/` is passed back to the caller and also to `path.join(this.cacheDir, relativePath)` where `path.join` normalizes it. Still, using `join(prefix, entry.name)` would be cleaner.

### LOW: Error message with Unix-isms

```typescript
// src/utils/storage/storage.ts:99-100
`    1. Open and fix manually: $EDITOR "${this.configPath}"\n` +
`    2. Backup first: cp "${this.configPath}" "${this.configPath}.bak"`
```

`$EDITOR` and `cp` are Unix conventions. On Windows, these would be `%EDITOR%` and `copy`.

## Severity Summary

| Severity | Count | Items |
|----------|-------|-------|
| **HIGH** | 1 | Path concat with `/` in `workitem.ts:296` |
| **MEDIUM** | 4 | `chmod` in clarity config, `process.kill(pid,0)` in file-lock, `Bun.$` array interp in precheck, `az rest` long URL in timelog configure |
| **LOW** | 3 | `/` in `listCacheFiles`, error message Unix-isms, `Bun.$` simple `az` commands |
| **NONE** | ~35 | All other files -- pure HTTP/fetch, proper `path.join`, platform-guarded code |

## Recommended Fixes (Priority Order)

1. **`workitem.ts:296`** -- Replace string concat with `path.join()` (trivial, 1 line)
2. **`clarity/config.ts:48`** -- Guard `chmod` with platform check (trivial, 2 lines)
3. **`storage.ts:367`** -- Replace string concat with `path.join()` (trivial, 1 line)
4. **`storage.ts:99-100`** -- Make error message cross-platform (cosmetic)
5. **Bun `$` on Windows** -- Add integration tests running `az` commands on Windows CI to verify Bun's shell works correctly

## Open Questions

1. **Bun `$` on Windows maturity** -- Bun's built-in shell for `$` template literals on Windows is relatively new. While it should handle simple `az` commands, edge cases (quoted URLs with special characters, array interpolation) need real-world testing on Windows.
2. **`process.kill(pid, 0)` on Windows** -- Node.js documentation says this works for checking process existence on Windows, but the Bun runtime may behave differently. If stale lock detection fails, the lock system degrades to timeout-only recovery.
3. **Bun for Windows availability** -- The entire toolkit requires Bun. Bun for Windows is stable as of 2025, but some Bun-specific APIs (`Bun.file`, `Bun.write`, `Bun.spawn`) may have subtle platform differences. No known issues, but less battle-tested than macOS/Linux.
