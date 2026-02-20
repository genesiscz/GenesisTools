# Debugging Master - Design Document

*Date: 2026-02-19*

## 1. Overview

A multi-part LLM debugging toolkit:

1. **Instrumentation snippets** — self-contained logging files copied into target projects (`llm-log.ts`, `llm-log.php`)
2. **CLI reader** (`tools debugging-master`) — token-efficient log reader with sessions, refs, JMESPath
3. **Skill** (`SKILL.md`) — teaches debugging workflows (all recommendations, not enforced)

The core insight (from Cursor debug mode): runtime data beats static analysis. Instead of guessing at fixes, the LLM instruments code with targeted logging, the developer reproduces the bug, and the LLM analyzes real runtime data to make precise fixes.

## 2. Architecture

```
GenesisTools repo:
  src/debugging-master/                <- CLI tool
  ├── index.ts                         <- commander entry
  ├── commands/
  │   ├── start.ts                     <- init session, copy snippet, optionally start server
  │   ├── get.ts                       <- read logs (summary + filtered entries)
  │   ├── expand.ts                    <- expand refs + JMESPath (defaults to schema)
  │   ├── snippet.ts                   <- generate instrumentation lines (auto-detect lang)
  │   ├── sessions.ts                  <- list sessions
  │   ├── tail.ts                      <- live tail with fuzzy session search
  │   ├── cleanup.ts                   <- remove @dbg blocks + archive logs
  │   └── diff.ts                      <- compare two sessions (trace diff)
  ├── core/
  │   ├── session-manager.ts           <- session lifecycle + JSONL read/write
  │   ├── ref-store.ts                 <- reference system (→ shared from src/utils/references.ts)
  │   ├── log-parser.ts                <- JSONL reading, filtering, grouping
  │   ├── config-manager.ts            <- global project config
  │   ├── http-server.ts               <- local HTTP ingest server
  │   └── formatter.ts                 <- token-efficient output
  └── types.ts

  src/utils/debugging-master/
  ├── llm-log.ts                       <- TypeScript/JS snippet
  └── llm-log.php                      <- PHP snippet

  src/utils/references.ts              <- shared ref system (extracted from har-analyzer)

  .claude/skills/debugging-master/
  └── SKILL.md                         <- teaches workflows + JMESPath reference section
```

## 3. Global Config

**Location**: `~/.genesis-tools/debugging-master/config.json`

```json
{
  "projects": {
    "/Users/Martin/Projects/my-app": {
      "snippetPath": "src/utils",
      "language": "typescript"
    },
    "/Users/Martin/Projects/laravel-api": {
      "snippetPath": "app/Support",
      "language": "php"
    }
  },
  "recentSession": "fix-auth-bug"
}
```

**Session logs**: `~/.genesis-tools/debugging-master/sessions/<session-name>.jsonl`

**`recentSession`**: Updated on `start` and on any command with `--session`. Used as default when no session is specified.

## 4. Session Resolution

Sessions are specified via `--session <name>` flag (not positional). Supports **fuzzy matching** on all commands — `--session fix-au` matches `fix-auth-bug`.

Behavior when `--session` is omitted:

1. If `recentSession` exists and was updated in the last hour → use it
2. If multiple active sessions exist → show `suggestCommand()` listing active session names
3. If no sessions → error with tip: `No active sessions. Start one with: tools debugging-master start --session <name>`

Active session = last log entry or last command within the last hour.

## 4.1. Output Formats & UX Philosophy

### Guided journey

Every command output should feel like a **guided journey** for both LLMs and humans:
- **On success**: Show result + `suggestCommand()` with the most useful next action
- **On error**: Show what went wrong + tip with the exact command to fix it
- **On empty**: Show what's expected + how to populate (e.g., "No entries yet. Reproduce the bug, then re-run this command.")
- **On ambiguity**: Show options + `suggestCommand()` for each

### Output format flag

Most commands support `--format ai|json|md` (default: `ai`):

| Format | Purpose | Description |
|---|---|---|
| `ai` | LLM consumption (default) | Token-efficient, includes `suggestCommand()`, refs, summaries |
| `json` | Programmatic use | Raw JSON output, no decorations |
| `md` | Human-readable markdown | Formatted with headers, tables, colors (when TTY) |

### Pretty flag

`--pretty` — enhances output for human reading (colors, box drawing, padding). Primarily useful for `tail` and `get`. Auto-enabled when TTY is detected + format is `md`.

## 5. Start Command

```bash
tools debugging-master start --session <name> [--serve] [--path <dir>] [--port <num>] [--language <lang>]
```

### First run for a project (no config entry):

- **TTY (human)**: Clack prompt with suggestions based on project tree:
  - `src/utils/` (if `src/` exists)
  - `app/Support/` (if `app/` exists — Laravel)
  - `lib/` (if `lib/` exists)
  - Custom path
  - Also prompts for language if ambiguous
- **Non-TTY (LLM)**: Error message + `suggestCommand()`:
  ```
  No snippet path configured for this project.
  Run: tools debugging-master start --session my-session --path src/utils
  ```

### What start does:

1. Creates/updates config entry for the project
2. **Always copies/overwrites** the snippet file to the configured path (ensures latest version)
3. Creates empty session JSONL file
4. Sets `recentSession` in config
5. If `--serve`: starts HTTP ingest server on `localhost:7243` (or `--port`)
6. Outputs session info + snippet import path for the LLM

## 6. Instrumentation Snippets

All instrumentation uses `// #region @dbg` / `// #endregion @dbg` markers (all styles, all languages). This is multiline-safe and avoids linter formatting issues.

### TypeScript/JS — `llm-log.ts`

Self-contained TypeScript file (~200 lines). Zero dependencies.

**File mode (default)** — uses `appendFileSync`:
```ts
// #region @dbg
import { dbg } from '../src/utils/llm-log';
// #endregion @dbg

// #region @dbg
dbg.dump('userData', userData);
// #endregion @dbg

// #region @dbg
dbg.timerStart('db-query');
// #endregion @dbg
const result = await db.query(...);
// #region @dbg
dbg.timerEnd('db-query');
// #endregion @dbg
```

**HTTP mode (Cursor-style inline)** — requires `start --serve`:
```ts
// #region @dbg
fetch('http://127.0.0.1:7243/log/fix-auth-bug', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({level:'dump', label:'userData', data: userData,
    location:'api.ts:54', ts: Date.now()})
}).catch(()=>{});
// #endregion @dbg
```

### PHP — `llm-log.php`

Self-contained PHP file. Zero dependencies.

**File mode (default)** — uses `file_put_contents` with `FILE_APPEND`:
```php
// #region @dbg
require_once __DIR__ . '/../app/Support/llm-log.php';
// #endregion @dbg

// #region @dbg
LlmLog::dump('userData', $userData);
// #endregion @dbg
```

**HTTP mode (Cursor-style inline)** — auto-detects Guzzle vs `file_get_contents`:
```php
// #region @dbg
// With Guzzle (auto-detected if installed):
(new \GuzzleHttp\Client())->post('http://127.0.0.1:7243/log/fix-auth-bug', [
    'json' => ['level'=>'dump','label'=>'userData','data'=>$userData,'location'=>'api.php:54','ts'=>round(microtime(true)*1000)]
]);
// #endregion @dbg

// Without Guzzle (file_get_contents fallback):
// #region @dbg
@file_get_contents('http://127.0.0.1:7243/log/fix-auth-bug', false, stream_context_create([
    'http' => ['method'=>'POST','header'=>"Content-Type: application/json\r\n",
    'content'=>json_encode(['level'=>'dump','label'=>'userData','data'=>$userData,'location'=>'api.php:54','ts'=>round(microtime(true)*1000)])]
]));
// #endregion @dbg
```

### Entry types (10)

| Method | Level | Written fields |
|---|---|---|
| `dbg.dump(label, data, opts?)` | dump | `{level, label, data, ts, file, line, h?}` |
| `dbg.info(msg, data?, opts?)` | info | `{level, msg, data?, ts, file, line, h?}` |
| `dbg.warn(msg, data?, opts?)` | warn | `{level, msg, data?, ts, file, line, h?}` |
| `dbg.error(msg, err?, opts?)` | error | `{level, msg, stack?, data?, ts, file, line, h?}` |
| `dbg.timerStart(label)` | timer-start | `{level, label, ts, file, line}` |
| `dbg.timerEnd(label)` | timer-end | `{level, label, ts, durationMs, file, line}` |
| `dbg.checkpoint(label)` | checkpoint | `{level, label, ts, file, line}` |
| `dbg.assert(cond, label, ctx?)` | assert | `{level, label, passed, ctx?, ts, file, line}` |
| `dbg.snapshot(label, vars)` | snapshot | `{level, label, vars, ts, file, line}` |
| `dbg.trace(label, data?)` | trace | `{level, label, data?, ts, file, line}` |

**Optional hypothesis tagging**: All methods accept an optional `{h: 'H1'}` options object as the last parameter. Adds `h` field for filtering.

**JSONL format** (one line per entry):
```json
{"level":"dump","label":"userData","data":{...},"ts":1708300000000,"file":"src/api.ts","line":54,"h":"H1"}
```

## 7. HTTP Server

**Endpoint**: `POST /log/<session-name>`

Accepts JSON body matching the log entry schema. Appends to session JSONL file.

**Server resilience** (never rejects):
- Valid JSON matching schema → append as-is
- Valid JSON but missing fields → fill defaults (`level: "info"`, `ts: Date.now()`) and append
- Invalid JSON → wrap raw body as `{level: "raw", data: "<raw string>", ts: Date.now()}`

**Additional endpoints**:
- `GET /health` — server status
- `DELETE /log/<session-name>` — clear session logs

## 8. CLI Commands

All commands use `--session <name>` flag. Defaults to most recent session (see Section 4).

### `get` — Read logs

```bash
tools debugging-master get                            # Summary + all entries (L1), recent session
tools debugging-master get --session fix-auth          # Specific session
tools debugging-master get -l dump                     # Filter by level (comma-separated)
tools debugging-master get -l dump,error               # Multiple levels
tools debugging-master get -l timer                    # Timer pairs with computed durations
tools debugging-master get --last 5                    # Last N entries
tools debugging-master get --h H1                      # Filter by hypothesis
```

**Note**: `-l` / `--level` filter always includes `raw` entries (corrupted/malformed input) alongside the requested levels, so nothing is silently hidden.

**Output structure (L1)**:

Timeline is preserved chronologically. File headers appear inline when the source file changes between entries (relative paths).

```
Session: fix-auth-bug (23 entries, 4.2s span)

Summary:
  5 dump  3 checkpoint  2 error  1 timer-pair (avg 340ms)
  8 info  3 trace  1 assert (0 failed)  1 raw

File: src/api.ts
  #1  14:32:05.123  info       "starting auth flow"
  #2  14:32:05.200  dump       userData                    [ref:d2] 2.4KB
  #3  14:32:05.201  timer      db-query                    341ms
File: src/auth/handler.ts
  #4  14:32:05.542  checkpoint after-query
  #5  14:32:05.543  dump       queryResult                 [ref:d5] 890B
  #6  14:32:05.600  error      "auth token expired"        [ref:e6] stack
File: src/api.ts
  #7  14:32:05.610  info       "retrying with refresh token"
  ...

Tip: Expand a ref → tools debugging-master expand d2
```

Values >200 chars get a ref. Every output ends with a `suggestCommand()` tip for the next action.

### `expand` — View referenced data

**Defaults to schema view** (L2). Use `--full` for complete data (L3).

```bash
tools debugging-master expand <ref>                              # Schema skeleton (L2, default)
tools debugging-master expand <ref> --schema typescript          # TS interface mode
tools debugging-master expand <ref> --schema schema              # JSON Schema mode
tools debugging-master expand <ref> --full                       # Full value (L3)
tools debugging-master expand <ref> --query '<jmes>'             # JMESPath projection (L3)
```

Schema modes (from `formatSchema()`): `skeleton` (default), `typescript`, `schema`.

**JMESPath examples** (detailed reference in SKILL.md):
```bash
--query 'data.user.email'                              # Dot path
--query 'items[*].{id: id, name: name}'                # Projection
--query 'items[?status==`error`].message'              # Filter
--query 'sort_by(items, &timestamp)'                   # Sort
```

### `snippet` — Generate instrumentation lines

Auto-detects language from project config. Override with `--language`.

```bash
tools debugging-master snippet dump userData                     # Auto-detect language
tools debugging-master snippet dump userData --http              # HTTP mode (fetch/file_get_contents)
tools debugging-master snippet checkpoint after-auth             # Checkpoint line
tools debugging-master snippet dump userData --language php      # Force PHP
tools debugging-master snippet dump userData --language typescript --http  # Force TS HTTP mode
```

For PHP HTTP mode: auto-detects Guzzle (checks `composer.json` / `vendor/`) and generates the appropriate snippet.

Outputs ready-to-paste code with correct import path, session name, and `// #region @dbg` markers.

### `tail` — Live tail logs

```bash
tools debugging-master tail                            # Tail recent session
tools debugging-master tail --session fix-au           # Fuzzy-match session name
tools debugging-master tail --pretty                   # Human-friendly colored output
tools debugging-master tail -l dump,error              # Filter while tailing
```

Streams new entries as they arrive. `--pretty` adds colors, box drawing, and timestamps formatted for quick scanning. Ideal for running in a side terminal while reproducing bugs.

### `sessions` — List sessions

```bash
tools debugging-master sessions                        # All sessions
```

Shows: session name, entry count, time span, project path, last activity.

### `diff` — Compare two sessions (trace diff)

```bash
tools debugging-master diff --session sess1 --against sess2     # Compare sessions
tools debugging-master diff --session sess1 --against sess2 -l checkpoint  # Compare only checkpoints
```

Compares entries by matching labels/checkpoints between sessions. Shows:
- Entries present in one session but not the other
- Data differences for matching labels (e.g., same dump label, different values)
- Timing differences for matching timer labels

Useful for comparing a failing run vs. a passing run to spot divergence.

### `cleanup` — Remove instrumentation + archive logs

```bash
tools debugging-master cleanup                         # Remove @dbg blocks from project files
tools debugging-master cleanup --repair-formatting     # Also checkout files with only formatting diffs
tools debugging-master cleanup --keep-logs             # Move archived logs to a permanent location
```

**Cleanup flow**:

1. **Scan project** for `// #region @dbg` ... `// #endregion @dbg` blocks
2. **Remove blocks** from all files
3. **Check `git diff`** of each modified file (uses `src/utils/diff.ts`):
   - If the diff contains **only** blank line / whitespace changes caused by block removal → show the diff in ` ```diff ``` ` format
   - Suggest `suggestCommand("cleanup --repair-formatting")` to `git checkout` those files
4. **Report**: `Removed 12 blocks from 4 files. 2 files have minor formatting diffs.`

**`--repair-formatting`**:
- For each file where the git diff is **only** formatting artifacts from block removal: `git checkout` that file
- Shows ` ```diff ``` ` of what was repaired
- Files with substantive diffs (non-debug changes) are **never** touched

**Log archival**:
- Logs are written to a temp file: `/tmp/<datetime>-llmlog-<session>.jsonl`
- Session entry remains in config (not removed)
- Suggests `tools debugging-master cleanup --keep-logs` which prompts for a permanent save location (TTY) or accepts `--keep-logs <path>` (non-TTY) to move from temp

**Does NOT**:
- Delete the session from the storage config
- Permanently delete log data (always archives to temp first)

## 9. Shared Reference System

Extract the reference system from har-analyzer into `src/utils/references.ts` so both tools can use it:

- **Threshold**: Values >200 chars get a ref ID
- **Preview**: 80-char truncated preview with natural break detection
- **Ref IDs**: `d<n>` for dumps, `e<n>` for errors, `s<n>` for snapshots (n = entry index)
- **First show**: Full preview + ref ID
- **Subsequent shows**: Compact ref + preview + size
- **Expand**: `expand <ref>` defaults to schema view

Both `har-analyzer` and `debugging-master` import from `src/utils/references.ts`.

## 10. Token Efficiency

Three output levels:
- **L1** (`get`): Compact entry list with refs, summary, file grouping
- **L2** (`expand`, default): JSON skeleton via `formatSchema(data, 'skeleton'|'typescript'|'schema')`
- **L3** (`expand --full` / `expand --query`): Full data or JMESPath-projected subset

Additional strategies:
- Summary view groups entries by level with counts before showing detail
- File headers in L1 appear inline when file changes (timeline preserved)
- `suggestCommand()` on every output suggests the most useful next action
- Tips on errors guide the user/LLM to the right command
- Timer pairs auto-computed (no need to manually match start/end)
- Assert summary shows pass/fail counts
- `raw` entries always included in filtered output so nothing is silently hidden
- `--format ai` (default) optimized for LLM token efficiency
- Fuzzy session matching on all commands reduces typo friction

## 11. Skill (`SKILL.md`)

Teaches the LLM:

### Workflow examples (all recommendations, not enforced)

**Hypothesis-driven** (for complex bugs):
1. Generate 2-3 hypotheses about the bug
2. `tools debugging-master start --session <name> [--path <dir>]`
3. Add targeted instrumentation (tag with `{h: 'H1'}` etc.)
4. Ask user to reproduce the bug
5. `tools debugging-master get` — read summary
6. Drill into refs with `expand` (defaults to schema), then `--query` for specific fields
7. Analyze data → either fix or add more instrumentation and repeat
8. `tools debugging-master cleanup`

**Quick instrumentation** (for simple bugs):
- Drop a few `dbg.dump()` calls, reproduce, check `get`, fix, cleanup

**Performance profiling**:
- Use `timerStart`/`timerEnd` pairs around suspected slow paths
- Filter with `-l timer` to see all timings

**Execution flow tracing**:
- Use `checkpoint` and `trace` to map the actual execution path
- Compare against expected flow

### JMESPath reference section
Detailed examples of JMESPath syntax for complex path queries. The LLM reads this section when it needs to write non-trivial queries.

### Token efficiency tips
- `expand` defaults to schema — check structure before getting full data
- Use `--query` with JMESPath projections to get only needed fields
- Use `--last N` to limit entries when the log is long
- Use `-l <level>` to focus on specific entry types

### Cleanup checklist
- Run `cleanup` after debugging is resolved
- Check for `--repair-formatting` suggestion
- Decide on `--keep-logs` if logs are worth preserving

## 12. Future Considerations

- **More language snippets**: `llm-log.py`, `llm-log.rb`, `llm-log.rs` — same JSONL format
- **MCP server**: Could be added later if CLI proves too cumbersome
- **Token budget**: Warn when log output exceeds a configurable token limit
- **Counter-experiment validation** (from dilagent): Validate hypotheses with negative tests
