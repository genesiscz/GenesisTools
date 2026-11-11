---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Code rules (any TypeScript in this repo)

Loaded by Claude Code when you read, write or edit a `.ts` or `.tsx` file. The root `CLAUDE.md` lists the other area files.

## Environment variables

Never read `process.env` directly in application code — use `import { env } from "@genesiscz/utils/env"`. Values: `env.getXAIApiKey()` or `env.x.getApiKey()`; resolved key names (for config metadata): `env.getXAIApiEnvKey()` or `env.x.getApiEnvKey()`. Grouped domains: `env.tools`, `env.ai.*`, `env.github`, `env.log`, `env.paths`, `env.device`, `env.test`, etc. Tests that need overrides: `env.testing.set()` / `env.testing.withOverrides()`.

## Code Style: Biome formatting gotchas (write it right the first time)

- **Imports are auto-sorted by module specifier** (`bun:` / `node:` builtins first, then packages and `@genesiscz/...` aliases alphabetically), and named imports inside braces are sorted case-insensitively — write them pre-sorted or the hook churns your diff.
- **Line width is 120, 4-space indent.** Don't hand-wrap below that; biome unwraps your "pretty" 3-line call back onto one line.
- **Long call: biome keeps args inline and expands only the trailing object/array** (`fn(a, b, {\n ... \n})`), not one-arg-per-line.
- **Long `if`: parenthesized multiline, one clause per line** — `if (\n  a ||\n  b\n ) {`.
- **`// biome-ignore` must name a rule that actually fires there**, else it becomes a `suppressions/unused` warning itself.
- **The SafeJSON rule (`noRestrictedGlobals` denying bare `JSON`) is OFF in two zones** — `src/youtube/extension/**` and **all of `plugins/**`** (biome.json overrides). In both, use `JSON` directly with NO biome-ignore (it warns as unused). Everywhere else use `SafeJSON`, never an ignore.
- **The pre-commit hook runs `biome check --write --staged` and then formats the staged blobs themselves** (since 2026-09-03 01:05 it pipes each staged copy biome touched through `biome --stdin-file-path` and writes the result back into the index). The commit always carries the formatted copy, a file with unstaged hunks keeps them unstaged, and nothing written to the working tree during the run is swept in. The working-tree copy is formatted too, so the only thing `git status` shows afterwards is what was unstaged before.

## Code Style Rules

- **Fix bugs at the root, not at every call site.** When the same issue appears in multiple places because of a shared function, fix the shared function — don't patch each caller individually. One fix at the source beats N fixes at the edges.
- **No file-path comments**: Never add `// src/path/to/file.ts` as first line of files
- **No obvious comments**: Don't add comments that restate what the code already says (e.g. `// Build initial context` before `buildContext()`)
- **Concise commit messages**: Just a title line, no per-file breakdown in the body. Keep it short and focused on the "why"
- **Always use `SafeJSON`, never `JSON`**: Import `SafeJSON` from `@genesiscz/utils/json` and use `SafeJSON.parse()` / `SafeJSON.stringify()` everywhere — `JSON` is biome-restricted in this repo. `SafeJSON` is a comment-json wrapper that handles `//` comments, multi-line comments, and trailing commas. For strict JSON behavior, pass `{ strict: true }` or `{ jsonl: true }`.

## Code Style: Conditionals & Spacing

- **No one-line `if` statements** — even for early returns. Always use block form with braces.
- **Empty line before `if`** — unless the preceding line is a variable declaration used by that `if`.
- **Empty line after closing `}`** — unless followed by `else`, `catch`, `finally`, or another `}`.
- Example:

  ```typescript
  const value = getValue();
  if (!value) {
      return;
  }

  doSomething(value);
  ```

## Code Style: Function Parameters

- **3+ params or optional params → use an object:** `callLLM({ systemPrompt, userPrompt, providerChoice, streaming })`
- **1-2 required, obvious params → positional is fine:** `estimateTokens(text)`, `resolve(base, path)`
- **Mix of required + optional → object with required fields + optional:** `({ session, mode, tokenBudget? })`
- Rule of thumb: if you'd need to look at the signature to know which arg is which, use an object.

## Code Style: Type Safety

- **No `as any`** — use proper type narrowing, type guards, or explicit interfaces.
- **No inline casts** such as `as Array<{ id: string; score: number }>`. Make the function return the right type, or add a named interface in the nearest `types.ts`.
- When working with union types, use discriminant checks (e.g. `entity.className === "User"`).
- Prefer `error: err` over `error: err instanceof Error ? err.message : String(err)` when the error field accepts unknown.

## 🛑 Never spin: waits, polls and timers

Measured 2026-09-16 (numbers and fixes in `docs/benchmarks-cpu.md`): a source-less `RunLoop.run(mode:before:)` burned 60% of a core for an hour and swallowed every notification click, a 50 ms `stat` loop was the whole idle cost of `tools watch`, and `Bun.sleepSync` inside `waitFor` froze the event loop for 1055 ms per wait.

- **A wait has a deadline or it is a bug.** Every TS "wait until X" gets a timeout and a defined outcome on expiry (a thrown error, `false`, a logged warning). `waitForPath` requires `timeoutMs` or `signal`. A Swift `.wait()` without `timeout:` fails `bun scripts/ci/lint-rules.ts`.
- **Wake on the event, never on a timer under 100 ms.** Files: `watchFileFeed`, `waitForPath`, `FileTailer` from `@genesiscz/utils/fs`, an `fs.watch` with a slow safety poll behind it, because on bun 1.3.13 every `fs.watch` created after the first `FSWatcher.close()` in a process goes deaf. A `setInterval` under 100 ms (including a delay bound to a numeric constant) fails lint-rules unless `// lint-rules-ignore: <why this must poll>` names the reason.
- **Never `sleepSync` in a loop.** It blocks the whole event loop, timers and signal handlers included. Use `await Bun.sleep()` in an async loop and honour the deadline (`Math.min(interval, remaining)`). lint-rules fails the loop form.
- **One `ps` per refresh, never one per row.** Ask `@genesiscz/utils/process/processes` (`readProcessRows`, `listProcessRows` and the other readers read the kernel first and batch the `ps` they still need); `process/ps.ts` is its private fallback, and lint `no-process-tool-spawn` refuses an import of it outside `src/utils/process/`. A TUI table renders the visible window, never every row.
- **Measure before and after.** `bun scripts/benchmarks/<area>/<script>.ts --baseline`, change the code, then `--compare` (`src/benchmark/lib`: `sampleProcess`, `withSpawnCounter`, `withFsCounter`, `monitorLoopStalls`, `compareToBaseline` with `floor`). CPU time and counts are the metrics; wall time on this Mac is noise. `tools doctor cpu` shows what is spinning right now. It is opt-in, not part of the default `tools doctor` suite.

## Side effects

🛑 A diagnostic (`doctor`, `test`, `probe`, `health`, `check`, `status`, `list`, `show`, `--dry-run`) never mutates durable state and never spends a single-use credential; guard in the shared function, right before the line that spends it. The full rules and their history: `.claude/rules/diagnostics.md`.
