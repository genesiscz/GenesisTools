# Patterns that paid off (2026-10-12 to 2026-10-24)

Each pattern is one measured change in this repository. The commit has the numbers, the ledger
(`.claude/docs/performance.md` in the main checkout) has the method. Look here before you design a fix: most new
slowness is one of these shapes again.

## Growing files: bound the reader and the writer

- **Read an append-only file from its end.** The cmux surface journal (6.9 MB, 19,344 lines) was parsed whole by
  every reader. `readLinesBackwardSync` reads from the end and stops after 64 lines older than the readers' window
  (7 days plus an hour): 9.7 to 4.2 ms, the same 139 sessions (4d0f2cc3c4). Stop early only after you proved the
  file is time ordered (0 of 19,344 lines were out of order). Do not compact or delete history to get there: the
  compaction was undone because the user wants the journal whole (ledger 2026-10-15 18:10).
- **Write less.** A hook wrote a journal line per prompt: 19,203 lines in a week, and each line cost a cmux identify
  call. It now writes only when the tab changed or 30 minutes passed (77a0e0077c).
- A filter that runs before the parse can change the answer. Rejected: dropping journal lines of closed surfaces
  before the parse, because the newest line on a closed tab must hide an older line on a live one.

## Pay a fixed cost once, not once per item

- **One read snapshot for many keys.** Warm widget cards for 16 sessions ran one `queryEntriesSnapshot` each, and
  each re-ran the answer-log catch-up (5.5 ms, 98 of 206 ms). `queryEntriesOfSessionsSnapshot` reads all of them in
  one snapshot with one catch-up: 183.2 to 95.7 ms of CPU (8c431c540f, ledger 2026-10-24 18:20).
- **One folder read for many ids.** The stuck check resolved each watched session by its own walk; one read of the
  session folders for all 15 ids: 234 to 31 ms of CPU (dbb74251ed).
- Look for the shape: a loop over N items where each call opens, reads or catches up the same thing.

- **Filter by the cheap property, hash only the matches.** Pairing moved files by content: `git cat-file
  --batch-check` gives every deleted blob's size, `lstat` gives every untracked file's size, and only files whose size
  matches a deleted blob are hashed (`hash-object --stdin-paths`). 46 ms on the vault's 650 deletions and 5,000
  untracked files, against 3.9 s for git's own rename detection; hashes cached by file identity (GenesisKit
  `GitWorktreeRenames`, TS `src/utils/git/worktree-renames.ts`).
- **Two languages, one rule, one fixture.** The Swift and TypeScript twins of a rule read the same case file
  (`GenesisKitFixtures/Git/contract-worktree-renames.json`), so the rule cannot drift between the app and the CLI.

## Ask the cheapest source

- **Liveness by signal 0, with identity validation.** Checking the `~/.claude/sessions` registry plus
  `process.kill(pid, 0)` costs 0.4 ms against 213 ms with `ps` (93fcb07b9e), but proves only that the PID exists.
  Before reporting the recorded session alive, validate that the process still matches it with `classifyPid()` or
  the recorded process start time. A stale registry and a reused PID must not revive an old session; an unreadable
  identity is unknown. A `ps`, `lsof` or `pgrep` spawn is a lint error anyway (`no-process-tool-spawn`).
- **git status single-threaded in a hook.** The diff hook's `git status` costs 220 ms of CPU single-threaded against
  417 ms with its default threads, for the same output (c468a81cd3). Threads that each stat the tree can cost more
  CPU than they save in wall time.

## Schedulers, ticks and daemons

- **Overlap independent legs.** The session-rows walk runs beside the usage poll, so a tick lasts as long as the
  slower of the two, not their sum (69dc2ee44a). Spends that arrive together share one ledger lock instead of
  queueing (2ddf62a1e4).
- **A tick reads facts only for what is due.** The hub notify tick reads git facts only for repos whose cadence has
  come, and runs the rules only on ticks that polled (e33c1b788e). Each repo has its own backoff and deadline, so a
  hung repo never holds back the others (65f11d1fc1).
- **Never do cleanup on the scheduler's path.** A retention prune on a slow disk froze the daemon's scheduler for up
  to 82 s; it is now asynchronous and detached (51113cf8f6). Bound walks of an open window: the stats timeline reads
  at most its last 400 buckets (f3bbe4efbf).
- **Process priority is a performance setting, so A/B it.** Low priority made the whole daemon slow under load; it
  runs at Standard process type, and only the clones scan and cache prune run low (191f7aae16). The clones
  reconcile benchmark measures both QoS levels (6018c717d3).

## Child processes and hooks

- **An abandoned Bun child needs its pipes and timer unref'd too.** A build waited 20 s for a child it no longer
  needed. Unref'ing the child alone: 4 s; also its stdout pipe and the deadline timer: 0.03 s (22089d5c24; details in
  the swift skill's gotchas.md).
- **Keep git hooks cheap and bounded.** Bun's `$` shell hung the pre-push hook; the guard now lists files with a
  plain spawn, and every pre-push guard has a deadline (ad23abfe41). The post-checkout hook started a whole `tools`
  run on every rebase in a linked worktree; it now acts only when `git worktree add` creates one (5e121bd229).
  `./tools` never runs `bun install` by itself in a linked worktree (4b8196febd): a fresh install's native binaries
  wait for macOS's first-run check.
- **A watcher's backend probe can leak.** `@parcel/watcher` ran a watchman probe that left a zombie `sh` and a
  descriptor on every subscribe when watchman was missing; the watcher now names its native backend (d846dd0232).

## When the new code is slower on purpose

Accept extra cost when it buys a feature, and say so in the ledger with the number (2026-10-14 23:02: `codex who`
+47 ms for a new column). A "regression" that nobody wrote down is the one that gets reverted.
