---
paths:
  - ".github/**"
  - "scripts/ci/**"
  - ".githooks/**"
  - "scripts/git/install-hooks.ts"
---

# CI scripts, guards and git hooks

Loaded by Claude Code when you read, write or edit a file under `.github/`, `scripts/ci/` or `.githooks/`.

- **A guard is worthless until it is proven to catch.** Plant a real violation, watch the guard exit non-zero and name the file, then remove the plant. Every guard here that was not checked this way enforced nothing: `if rg …` read the exit code 127 of a missing ripgrep (the ubuntu runner has none) as "no matches" and printed OK for weeks.
  - Exit code 0 means matched and 1 means no match. Anything else is a broken scan: abort and name the reason.
  - Use `git grep -P` in anything CI runs, never `rg`. Git is always present and searches tracked files only.
- **Lint the diff, not the tree, and not with `biome --changed`.** Under CI's depth-1 checkout it finds zero files, and biome exits 1 on "No files were processed". `scripts/ci/lint-changed.sh` passes `git diff --name-only --diff-filter=ACMR <base> HEAD` to biome with an `[ -f ]` test per path. The base is `github.event.pull_request.base.sha`, which already is the merge base, so no history fetch is needed.
- **Git runs the `.githooks/` scripts as config hooks** (`hook.genesis-tools-<name>`, through `/bin/sh -c`), set by `scripts/git/install-hooks.ts` from package.json `prepare`, never through `core.hooksPath`. Git executes a hook-folder file directly, macOS checks the first execution of every new file in syspolicyd, and a worktree's hooks are new files: on 2026-10-14 a stuck syspolicyd froze every such first execution at `_dyld_start`, and a rebase hung 41 minutes. A config hook runs only while `core.hooksPath` is unset, so `git -c core.hooksPath=/dev/null …` still turns every hook off. A new hook needs a `#!` line (its interpreter becomes the command) and one `bun install`. Check what runs with `git hook list <event>`.
- **A dashboard that does not render fails the push.** `scripts/ci/dashboard-smoke.ts` boots each Vite dashboard a
  push can reach (all of them when `src/utils/` changes) and fetches `/`; a 5xx or no answer fails it with the
  server's own error from its log. Pre-push runs it after the typecheck, about 5 s for all eight. CI does not: the
  dashboards read this Mac's config. It exists because `tools clarity ui` answered 500 for a day (2026-10-22) while
  tsc, the tests and its own launch passed; a launch now also reports a 5xx page and exits 1 (`reportBrokenDashboard`).
- **`lint-rules.ts` and `placeholder-check.sh` scan tracked files only** (`git ls-files`). Run them after the last commit, or after `git add` of every new file. A run before staging proves nothing about a new file.
