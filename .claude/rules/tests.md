---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "scripts/test*.ts"
---

# Tests

Loaded by Claude Code when you read, write or edit a test file. Read it yourself before you add a test file or run a large suite.

## Running Tests

**Use `bun run test` (or `bun scripts/test.ts <paths>`), never bare `bun test`.** The wrapper stat-checks the dependency tree first (~1ms) and reinstalls when it is missing, partial or stale, then hands off to `bun test` with argv, output and exit code untouched.

This exists because inside a **git worktree** any `bunx` call creates a partial `node_modules/` that shadows the parent checkout's complete one. Bare `bun test` then fails across a hundred unrelated files with errors like `Cannot find module 'parse5/lib/common/doctype'`, which looks exactly like the branch broke the world. Logic lives in `scripts/test-deps.ts` (`diagnose()` / `lockStamp()`), covered by `scripts/test-deps.test.ts`.

**A run that stops making progress is killed after 15 minutes**, per `bun test` phase, and the wrapper then prints `[test] suite STALLED` INSTEAD of the `[test] suite complete` marker, so a killed run can never read as a finished one. Raise or disable it with `GENESIS_TOOLS_TEST_MAX_MINUTES=<n>` (`0` = off). It exists because bun 1.3.13 hangs `bun test --parallel` in a checkout with tens of thousands of directories (a worktree carrying a generated `ios/Pods` tree): the coordinator loops on `posix_spawn` past the macOS fd ceiling and never starts a worker. One such run burned 5 h 27 m unnoticed. Run a directory-heavy worktree **serially**; the full rationale and the measured arms are in the block comment in `scripts/test.ts`.

**Which file left a process behind? Turn on the worker log** (off by default): `GENESIS_TOOLS_TEST_WORKER_LOG=1 bun run test`, then `bun scripts/test-worker-log.ts`. Each file records its `--parallel` worker and that worker's child processes at its start and end, and the report names the files that left processes alive and the later files that started with them. It exists because bun prints `killed N dangling process` at the LATER file, so a CI log blames the wrong one (`record.test.ts`, 2026-10-08, spawned nothing). On CI set the repository variable `TEST_WORKER_LOG=1`: the job summary gets the report and the log is in the uploaded artifact.

🛑 **CI runs bun 1.4.2 (which has the hang fix); the repo still SUPPORTS 1.3.13, which is what developers run.** Those are different statements. A green CI run does not mean the hang is gone on your machine, and a 1.4-only API must not enter the codebase just because CI accepts it.

**Tests must not use real account names.** Fixture handles, emails, and login ids in `*.test.ts` are invented (`work`, `personal`, `shop`, `side`, `work@shop`, `alice@example.com`). Never copy a live Claude/AI account name, email, or org from this machine into a test. A test that needs several distinct accounts uses those fixtures, not the real ones.

**Before adding a test file, read `.claude/docs/test-runtime.md`** (local-only, not tracked). The ubuntu CI step is a fixed budget that the suite has already outgrown twice. Measured there: `--parallel` implies `--isolate`, so **a new test FILE costs ~368 ms of runner time (~92 ms of wall) before it asserts anything**, while a new test in an existing file costs only its own runtime. The three patterns that make one file expensive, each with a measured example: a real wall-clock wait (`device-flow.test.ts`, 9.6 s of 9.75 s asleep), a child process per assertion (`merged.test.ts`, 1359 `git` spawns for 33 tests), and an on-demand package install inside a test (`chunker.test.ts`, 9836 ms of `bun add`). `scripts/ci/test-runtime-guard.ts` enforces a per-file ceiling on CI; make the test cheap rather than raising the ceiling.

## Test traps

- **Rewriting untested code: a characterization test first.** Pin the current behaviour, prove the test passes on the old code, then rewrite. When the test fails after the rewrite, assume the rewrite is wrong. Change a test only for an intended behaviour change, and say in the commit what changed and why.
- **Red today, green yesterday, no relevant commit: check the calendar.** A dated fixture crosses a window when one input still resolves against the real clock: `--since=N days ago` for git, `find -mtime`, `date -v-7d`. Derive every cutoff from the injected `now`.
- **`bun test --timeout` bounds a test body only.** A hang at module scope (an import that never settles) blocks forever. The signal is the wrapper's `[test] suite complete` line missing. Do not grep bun's own "Ran N tests across M files": it prints once per process, and `bun run test` runs two.
- **`src/utils/profile/profile.test.ts` can poison itself:** its guard probe can leave `~/.genesis-tools/logs/__profiler_guard_probe__.log` behind, and every later run then fails on any branch. Check for that file before you blame a branch.
