# Merge a PR or MR the rebase way

Purpose: land a reviewed branch with a linear history. "merge" means rebase and fast-forward,
never a merge commit, unless the user says otherwise. Not for: deciding readiness (reviews,
CI) — that is `gt:github` and the review loop.

## GitHub

```bash
tools github merge --rebase <PR>        # stack-safe: restacks locally, force-with-lease, fast-forwards the base, retargets dependents
tools github merge --ff-only <PR>       # when the branch is already linear on its base
tools github merge --squash <PR> --subject "<title> (#N)" --body-file /tmp/body.md   # only when history is messy enough
```

- Prefer `--ff-only` when nothing landed on the base since the branch was rebased. Add
  `--delete-branch` only when asked to clean up.
- Squash needs an explicit subject and a body listing the commits
  (`gh pr view <N> --json commits --jq '.commits[].messageHeadline'`), never GitHub's generated
  text. Never plain `--merge` unless a merge commit was requested.
- `--rebase` restacks over HTTPS with the `gh` token, which lacks the `workflow` scope: a PR that
  touches `.github/workflows/*` must be rebased locally, pushed over SSH, then landed with
  `--ff-only`.
- Before the first push of a session: `git branch -vv`. A branch tracking a differently named
  upstream pushes there. Create branches from remote refs with `--no-track`.
- Bodies for `gh pr create|edit|comment`: write a temp file and pass `--body-file`; inline
  `--body` gets backticks and `$` shell-expanded.
- After merging, `tools git merged <branch>` proves the content landed (`content` after a
  squash), then `merged-and-cleanup.md`.

## Stacked PRs (A ← B ← C)

`gh pr merge --delete-branch` does NOT retarget child PRs, it closes them (verified 2026-07-13
across three deletion paths; GitHub only retargets from the web UI's Delete button). Bottom-up:

1. merge the PR based on trunk, without `--delete-branch`;
2. `gh pr edit <next> --base <branch the previous one merged into>` before touching that branch;
3. `gh pr view <next> --json baseRefName,state,mergeable` must say OPEN and MERGEABLE;
4. only now `git push origin --delete <merged branch>`; repeat.

## GitLab

In order, because any other `merge_method` writes a merge commit while still reporting "Merged":

1. The project must be fast-forward only:
   `glab api --method PUT "projects/:id" -f merge_method=ff`.
2. `glab mr view <N> --output json`; if `detailed_merge_status` is `need_rebase`: `glab mr rebase <N>`.
3. Poll that field until `mergeable` (merging during `checking` returns a bare 405).
4. `glab mr merge <N> --yes`, never with `--rebase` (it starts a second rebase and races).
5. Verify: `git fetch origin && git log --merges --oneline <old-tip>..origin/<target>` prints nothing.

The `push` policy of the target branch in `genesis-tools.config.json` applies to the merge tool's
push as well: `never` means stop and print the command.
