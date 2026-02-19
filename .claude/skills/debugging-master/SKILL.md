---
name: debugging-master
description: |
  Hypothesis-driven runtime debugging toolkit. Use when debugging runtime bugs, investigating unexpected behavior, profiling performance, tracing execution flow, or inspecting runtime data. Triggers on "debug this", "why is this happening", "instrument the code", "add logging", "trace execution", "profile performance", "runtime bug", "debug session". NEVER guess at runtime behavior - instrument, reproduce, and analyze real data.
---

# Debugging Master

Runtime data beats static analysis. Instead of guessing, instrument code with targeted logging, reproduce the bug, and analyze real runtime data.

## Critical Rule

**NEVER guess at runtime values or execution flow.** Instrument, reproduce, analyze. One `dbg.dump()` is worth a hundred lines of static reasoning.

## Quick Reference

```bash
tools debugging-master start --session <name>          # Start session, copy snippet
tools debugging-master get                              # Read logs (L1 compact)
tools debugging-master get -l dump,error                # Filter by level
tools debugging-master get --last 5                     # Last 5 entries
tools debugging-master expand d2                        # Schema view (L2, default)
tools debugging-master expand d2 --full                 # Full data (L3)
tools debugging-master expand d2 --query 'x[*].y'      # JMESPath projection (L3)
tools debugging-master tail                             # Live tail
tools debugging-master sessions                         # List all sessions
tools debugging-master diff --session s1 --against s2   # Compare two runs
tools debugging-master cleanup                          # Remove instrumentation
```

## When to Use

- **Runtime bugs**: Values aren't what you expect, logic branches wrong
- **Performance issues**: Something is slow but you don't know what
- **Execution flow**: Code paths are unclear, order of operations is wrong
- **Data inspection**: Need to see actual shapes/values at runtime
- **Intermittent failures**: Need to capture state when the bug occurs
- **Comparing runs**: Passing vs failing, before vs after

## Setup

```bash
# First time for a project - copies llm-log snippet into your project
tools debugging-master start --session fix-auth-bug --path src/utils

# Subsequent runs - remembers snippet path
tools debugging-master start --session fix-auth-bug
```

The `start` command:
1. Copies/updates `llm-log.ts` (or `.php`) into the configured snippet path
2. Creates a session log file
3. Outputs the import path to use in instrumentation

## Instrumentation

### Rules

1. **Always wrap in region markers** - enables automated cleanup:
   ```ts
   // #region @dbg
   import { dbg } from '../utils/llm-log';
   // #endregion @dbg
   ```
2. **Every debug line gets its own region block** - granular removal:
   ```ts
   // #region @dbg
   dbg.dump('userData', userData);
   // #endregion @dbg
   ```
3. Use `tools debugging-master snippet <type> <label>` to generate ready-to-paste blocks with correct imports and markers.

### API Methods

| Method | Use For | Example |
|--------|---------|---------|
| `dbg.dump(label, data)` | Inspect any value | `dbg.dump('user', user)` |
| `dbg.info(msg, data?)` | Log a message with optional data | `dbg.info('auth started')` |
| `dbg.warn(msg, data?)` | Warnings | `dbg.warn('token expiring', { ttl })` |
| `dbg.error(msg, err?)` | Capture errors with stack | `dbg.error('auth failed', err)` |
| `dbg.timerStart(label)` | Start a timer | `dbg.timerStart('db-query')` |
| `dbg.timerEnd(label)` | End timer, log duration | `dbg.timerEnd('db-query')` |
| `dbg.checkpoint(label)` | Mark execution reached a point | `dbg.checkpoint('after-auth')` |
| `dbg.assert(cond, label, ctx?)` | Assert + log pass/fail | `dbg.assert(user.id > 0, 'valid-id', { id: user.id })` |
| `dbg.snapshot(label, vars)` | Capture multiple variables at once | `dbg.snapshot('state', { user, token, config })` |
| `dbg.trace(label, data?)` | Trace with optional data | `dbg.trace('enter-handler', { method: req.method })` |

### Hypothesis Tagging

Tag instrumentation with hypothesis IDs to filter later:

```ts
// #region @dbg
dbg.dump('token', token, { h: 'H1' });
// #endregion @dbg

// #region @dbg
dbg.dump('session', session, { h: 'H2' });
// #endregion @dbg
```

Then filter: `tools debugging-master get --h H1`

### Instrumentation Example

```ts
import express from 'express';

// #region @dbg
import { dbg } from '../utils/llm-log';
// #endregion @dbg

async function handleAuth(req: Request) {
  // #region @dbg
  dbg.dump('reqHeaders', req.headers, { h: 'H1' });
  // #endregion @dbg

  // #region @dbg
  dbg.timerStart('token-verify');
  // #endregion @dbg
  const token = await verifyToken(req.headers.authorization);
  // #region @dbg
  dbg.timerEnd('token-verify');
  // #endregion @dbg

  // #region @dbg
  dbg.dump('verifiedToken', token, { h: 'H1' });
  // #endregion @dbg

  if (!token.valid) {
    // #region @dbg
    dbg.error('token invalid', new Error('Token verification failed'));
    // #endregion @dbg
    return { status: 401 };
  }

  // #region @dbg
  dbg.checkpoint('auth-passed');
  // #endregion @dbg
  return { status: 200, user: token.user };
}
```

## Reading Logs — Progressive Detail (3 Levels)

Always start at L1 and drill down. This saves tokens.

### L1: Compact Timeline (`get`)

```bash
tools debugging-master get
```

Output:
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

Tip: Expand a ref -> tools debugging-master expand d2
```

Values >200 chars get a `[ref:XX]`. Use filtering to narrow down:

```bash
tools debugging-master get -l dump,error     # Only dumps and errors
tools debugging-master get --last 5          # Last 5 entries
tools debugging-master get --h H1            # Only hypothesis H1
```

### L2: Schema View (`expand`, default)

```bash
tools debugging-master expand d2
```

Shows the structure/shape of the data without full values. Three schema modes:

```bash
tools debugging-master expand d2                        # skeleton (default)
tools debugging-master expand d2 --schema typescript    # TypeScript interface
tools debugging-master expand d2 --schema schema        # JSON Schema
```

### L3: Full Data (`expand --full` or `--query`)

```bash
tools debugging-master expand d2 --full                       # Everything
tools debugging-master expand d2 --query 'user.email'         # Just one field
tools debugging-master expand d2 --query 'items[*].name'      # Array projection
```

**Token efficiency rule**: L1 -> L2 -> L3. Never jump to `--full` without checking the schema first.

## Workflow: Hypothesis-Driven (Complex Bugs)

Recommended for bugs where the root cause is unclear.

1. **Form hypotheses** (2-3 guesses about what's wrong)
2. **Start session**: `tools debugging-master start --session <descriptive-name>`
3. **Instrument** — add targeted `dbg.*` calls near suspected code, tag with `{h: 'H1'}`, `{h: 'H2'}`
4. **Ask user to reproduce** the bug
5. **Read L1**: `tools debugging-master get` — scan summary and timeline
6. **Drill into refs**: `expand <ref>` for structure, `--query` for specific fields
7. **Analyze** — confirm or eliminate hypotheses based on actual data
8. **Iterate** — if not resolved, add more instrumentation and repeat from step 4
9. **Fix** the bug with confidence (you have the data)
10. **Cleanup**: `tools debugging-master cleanup`

## Workflow: Quick Instrumentation (Simple Bugs)

For straightforward issues where you just need to see a value.

1. `tools debugging-master start --session quick-check`
2. Add 1-3 `dbg.dump()` calls
3. Ask user to reproduce
4. `tools debugging-master get --last 5`
5. Fix and `cleanup`

## Workflow: Performance Profiling

```ts
// #region @dbg
dbg.timerStart('total-request');
// #endregion @dbg

// #region @dbg
dbg.timerStart('db-query');
// #endregion @dbg
const data = await db.query(sql);
// #region @dbg
dbg.timerEnd('db-query');
// #endregion @dbg

// #region @dbg
dbg.timerStart('transform');
// #endregion @dbg
const result = transform(data);
// #region @dbg
dbg.timerEnd('transform');
// #endregion @dbg

// #region @dbg
dbg.timerEnd('total-request');
// #endregion @dbg
```

Read timings: `tools debugging-master get -l timer`

## Workflow: Execution Flow Tracing

```ts
// #region @dbg
dbg.checkpoint('handler-entry');
// #endregion @dbg

if (condition) {
  // #region @dbg
  dbg.checkpoint('branch-a');
  // #endregion @dbg
} else {
  // #region @dbg
  dbg.checkpoint('branch-b');
  // #endregion @dbg
}

// #region @dbg
dbg.checkpoint('before-return');
// #endregion @dbg
```

Read flow: `tools debugging-master get -l checkpoint`

## Workflow: Session Comparison

Compare a failing run against a passing run to spot divergence:

```bash
# Run 1 (failing)
tools debugging-master start --session auth-fail
# ... reproduce failing case ...

# Run 2 (passing)
tools debugging-master start --session auth-pass
# ... reproduce passing case ...

# Compare
tools debugging-master diff --session auth-fail --against auth-pass
tools debugging-master diff --session auth-fail --against auth-pass -l checkpoint  # Just flow
```

## JMESPath Quick Reference

Use with `tools debugging-master expand <ref> --query '<expression>'`:

```
data.field                     # Nested field access
data.nested.deep.value         # Multi-level nesting
items[0]                       # First array element
items[-1]                      # Last array element
items[0:3]                     # Slice (first 3)
items[*].name                  # All names from array of objects
items[?status=='active']       # Filter array by condition
items[?age>`25`]               # Numeric comparison (backtick numbers)
items[?contains(name, 'foo')]  # String contains filter
{id: id, name: name}           # Object projection (pick fields)
items[*].{id: id, n: name}    # Array of projections
length(items)                  # Count items
sort_by(items, &timestamp)     # Sort by field
max_by(items, &duration)       # Max by field
join(', ', items[*].name)      # Join names into string
@                              # Current node (identity)
```

### Common Patterns

```bash
# Get just email from a user dump
--query 'data.user.email'

# Get all error messages from an array
--query 'data.errors[*].message'

# Filter to failed items and get their IDs
--query 'data.items[?status==`failed`].id'

# Get summary stats
--query '{total: length(items), first: items[0].name, last: items[-1].name}'
```

## HTTP Server Mode

For browser debugging or environments where file writes are not possible:

```bash
# Start with HTTP server
tools debugging-master start --session browser-debug --serve
# Server starts on http://localhost:7243
```

Send logs via fetch:

```ts
// #region @dbg
fetch('http://127.0.0.1:7243/log/browser-debug', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    level: 'dump',
    label: 'componentState',
    data: state,
    location: 'App.tsx:42',
    ts: Date.now()
  })
}).catch(() => {});
// #endregion @dbg
```

Use `tools debugging-master snippet dump myVar --http` to generate these blocks automatically.

## PHP Support

Use `--language php` when starting a PHP project:

```bash
tools debugging-master start --session laravel-bug --language php --path app/Support
```

PHP API uses static methods (`LlmLog::` instead of `dbg.`):

```php
// #region @dbg
require_once __DIR__ . '/../app/Support/llm-log.php';
// #endregion @dbg

// #region @dbg
LlmLog::dump('userData', $userData);
// #endregion @dbg

// #region @dbg
LlmLog::timerStart('db-query');
// #endregion @dbg
$result = DB::table('users')->get();
// #region @dbg
LlmLog::timerEnd('db-query');
// #endregion @dbg
```

PHP HTTP mode auto-detects Guzzle. If installed, uses Guzzle; otherwise falls back to `file_get_contents`.

## Cleanup Checklist

Always clean up after debugging is resolved:

```bash
# 1. Remove all @dbg blocks from project files, archive logs to /tmp
tools debugging-master cleanup

# 2. If cleanup reports formatting-only diffs, fix them:
tools debugging-master cleanup --repair-formatting

# 3. If you want to keep logs permanently:
tools debugging-master cleanup --keep-logs ./debug-logs/
```

What cleanup does:
- Scans all project files for `// #region @dbg` ... `// #endregion @dbg` blocks
- Removes those blocks
- Archives session logs to `/tmp/<datetime>-llmlog-<session>.jsonl`
- Reports files with formatting-only diffs (blank lines left by block removal)
- `--repair-formatting` runs `git checkout` on files with only whitespace diffs
- `--keep-logs <path>` moves archived logs to a permanent location

What cleanup does NOT do:
- Delete sessions from config
- Permanently delete log data (always archives first)
- Touch files with non-debug changes

## Token Efficiency Tips

1. **Filter with `-l <level>`** — don't load all entries when you only need dumps
2. **Use `--last N`** — when the log is long, read only recent entries
3. **Use `expand` before `expand --full`** — check schema/shape first
4. **Use `--query` with JMESPath** — extract only the fields you need
5. **Use `--format json`** for machine processing (pipe to `tools json`)
6. **Use `--h <hypothesis>`** — filter to specific hypothesis when multiple are tagged
7. **Use `get -l timer`** for performance work — skip everything except timing data
