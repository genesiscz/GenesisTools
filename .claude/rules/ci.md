---
paths:
  - ".github/**"
  - "scripts/ci/**"
  - ".githooks/**"
---

# CI scripts, guards and git hooks

Loaded by Claude Code when you read, write or edit a file under `.github/`, `scripts/ci/` or `.githooks/`.

- **A guard is worthless until it is proven to catch.** Plant a real violation, watch the guard exit non-zero and name the file, then remove the plant. Every guard here that was not checked this way enforced nothing: `if rg …` read the exit code 127 of a missing ripgrep (the ubuntu runner has none) as "no matches" and printed OK for weeks.
  - Exit code 0 means matched and 1 means no match. Anything else is a broken scan: abort and name the reason.
  - Use `git grep -P` in anything CI runs, never `rg`. Git is always present and searches tracked files only.
- **Lint the diff, not the tree, and not with `biome --changed`.** Under CI's depth-1 checkout it finds zero files, and biome exits 1 on "No files were processed". `scripts/ci/lint-changed.sh` passes `git diff --name-only --diff-filter=ACMR <base> HEAD` to biome with an `[ -f ]` test per path. The base is `github.event.pull_request.base.sha`, which already is the merge base, so no history fetch is needed.
- **`lint-rules.ts` and `placeholder-check.sh` scan tracked files only** (`git ls-files`). Run them after the last commit, or after `git add` of every new file. A run before staging proves nothing about a new file.
