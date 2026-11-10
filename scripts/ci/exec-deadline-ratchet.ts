/**
 * The files whose `Executor` calls (`exec`, `execOrThrow`) name no timeout, and how many each has. Counted 2026-11-10
 * when lint-rules `no-exec-without-deadline` was added (D3, decision 3 a and b): since then every such call runs under
 * `DEFAULT_EXEC_TIMEOUT_MS` (60 s), and this list is the roster of the calls that rely on it. A call leaves the roster
 * only when its command can run longer by design and it says why: `timeout: { ms, reason }`. Ratchet: a file may not
 * join the list, lint-rules fails a file with more calls than its count and also one with fewer, so a classified call
 * lowers its count in the same change. An executor-level bound (`new Executor({ timeout })`) does not count: the rule
 * reads the call only.
 */
export const EXEC_DEADLINE_RATCHET: ReadonlyMap<string, number> = new Map<string, number>([
    ["src/automate/lib/steps/git.ts", 6],
    ["src/codex/lib/review/prepare.ts", 3],
    ["src/git/commands/commits.ts", 2],
    ["src/git/commands/configure-authors.ts", 1],
    ["src/git/commands/configure-workitem-patterns.ts", 2],
    ["src/git/commands/merged.ts", 1],
    ["src/git/commands/rename-commits.ts", 29],
    ["src/git/commands/worktree.ts", 1],
    ["src/git/lib/branch-attribution.ts", 2],
    ["src/git/lib/cascade/execute.ts", 11],
    ["src/git/lib/merged/prune.ts", 3],
    ["src/git/lib/monster/analyze.ts", 1],
    ["src/git/lib/rebranch/apply.ts", 5],
    ["src/git/lib/rebranch/history.ts", 1],
    ["src/github/lib/stack-restack.ts", 7],
    ["src/hub/lib/worktrees.ts", 4],
    ["src/macos/commands/clones/daemon.ts", 1],
    ["src/shops/commands/daemon.ts", 1],
    ["src/utils/git/base-detect.ts", 3],
    ["src/utils/git/core.ts", 44],
    ["src/utils/git/origins/detector.ts", 1],
    ["src/utils/git/origins/pr-fetch.ts", 5],
    ["src/utils/git/repo-config.ts", 3],
    ["src/utils/git/repo-facts.ts", 3],
    ["src/utils/git/worktree-backup.ts", 1],
    ["src/utils/git/worktree.ts", 9],
    ["src/utils/github/url-parser.ts", 1],
]);
