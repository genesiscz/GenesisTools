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
- **🛑 A plugin file that RUNS must be standalone.** The harness copies `plugins/**` out of this checkout and executes it elsewhere, where the tsconfig paths and `node_modules` do not exist — measured 2026-09-21: `Cannot find module '@genesiscz/utils/json'`. So no runtime plugin file may import `@genesiscz/*` or `@app/*`; inline what it needs, or put it in a sibling file under the same plugin. `bun scripts/ci/check-plugin-standalone.ts` fails CI on a violation and is proven to catch. Tests and `evals/**` fixtures are exempt: they only ever run from this checkout.
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
- When working with union types, use discriminant checks (e.g. `entity.className === "User"`).
- Prefer `error: err` over `error: err instanceof Error ? err.message : String(err)` when the error field accepts unknown.

## 🛑 Never spin: waits, polls and timers

Measured on this machine on 2026-09-16: an app face whose `RunLoop.run(mode:before:)` had no sources returned at once and burned 60% of a core for 1 h 03 m while holding the Launch Services registration, so every notification click went to it and was swallowed; a 50 ms `stat` loop was the whole idle cost of `tools watch`; `Bun.sleepSync` inside `waitFor` froze the event loop for 1055 ms per wait. `docs/benchmarks-cpu.md` has the numbers, the fixes and the harness for the work in this PR (measurement library, lint-rules, `tools doctor cpu`, evented waits, macos-resources batching, lazy CLI). Sibling PRs own youtube WorkerPool, dashboard idle, and the Swift app reap.

- **A wait has a deadline or it is a bug.** Every TS "wait until X" gets a timeout and a defined outcome on expiry (a thrown error, `false`, a logged warning). `waitForPath` requires `timeoutMs` or `signal`. A Swift `.wait()` without `timeout:` fails `bun scripts/ci/lint-rules.ts`.
- **Wake on the event, never on a timer under 100 ms.** Files: `watchFileFeed`, `waitForPath`, `FileTailer` from `@genesiscz/utils/fs`, an `fs.watch` with a slow safety poll behind it, because on bun 1.3.13 every `fs.watch` created after the first `FSWatcher.close()` in a process goes deaf. A `setInterval` under 100 ms (including a delay bound to a numeric constant) fails lint-rules unless `// lint-rules-ignore: <why this must poll>` names the reason.
- **Never `sleepSync` in a loop.** It blocks the whole event loop, timers and signal handlers included. Use `await Bun.sleep()` in an async loop and honour the deadline (`Math.min(interval, remaining)`). lint-rules fails the loop form.
- **One `ps` per refresh, never one per row.** Batch `ps` and `lsof` reads through `@genesiscz/utils/process/ps`; a TUI table renders the visible window, never every row.
- **Measure before and after.** `bun scripts/benchmarks/<area>/<script>.ts --baseline`, change the code, then `--compare` (`src/benchmark/lib`: `sampleProcess`, `withSpawnCounter`, `withFsCounter`, `monitorLoopStalls`, `compareToBaseline` with `floor`). CPU time and counts are the metrics; wall time on this Mac is noise. `tools doctor cpu` shows what is spinning right now. It is opt-in, not part of the default `tools doctor` suite.

## Side Effects: Diagnostics & Irreversible Operations

The recurring bug shape in this repo is a path that READS like an inspection but MUTATES durable state. Two of them shipped in one week: `tools ai config doctor` and `tools ai config account test` both spent single-use Anthropic refresh tokens, because both reached a shared auth path that refreshed on expiry. Diagnosing an account could brick it.

- **A diagnostic must never mutate.** If the name says it inspects (`doctor`, `test`, `probe`, `health`, `check`, `status`, `list`, `show`, `--dry-run`, `--check`) it may READ durable state and REPORT on it, and nothing else. No writes, no token rotation, no cache mint that changes what a later process observes. When a diagnostic finds a problem it prints the fix command; it does not apply the fix.
- **Guard above the consuming call, not at the caller.** Single-use credentials (OAuth refresh tokens), machine-global state (the OS keychain), and anything with a rotation counter get their guard in the shared function, immediately BEFORE the line that spends them. A guard at the call site only protects the callers you thought of.
- **A new safety parameter leaves every existing caller unsafe.** Adding `{ noRefresh: true }` fixes exactly the one caller you pass it to. Prefer inverting the default so the DANGEROUS behavior is the opt-in. When you cannot invert (too many callers, public API), `rg` every call site and classify each one in the same commit — an unclassified caller is an unfixed bug, and "I fixed it at the root" is not a defense if the root still defaults to dangerous.
- **Ship the negative control.** A test proving the guarded path is safe is half a test. The other half proves normal use still WORKS: `a bind without probe still reaches the refresh call`. Without it, a guard that leaks into the normal path silently breaks every account at token expiry, which is worse than the bug it fixed.
- **Spy on the irreversible call itself.** Assert against the primitive that spends the resource (the `refresh` call, the keychain `setPassword`, the `DELETE`), not on a symptom downstream. Make the spy THROW as well as record, so a path that reaches it fails loudly instead of passing quietly.
