# Rebase a fleet: many branches onto a moved base

Purpose: faithfully rebase N open branches or MRs onto the new tip of their base after it
absorbed a batch of merged work, resolving conflicts without losing or inverting any branch
intent, proving the rebase preserved the work, and leaving pushing to the human. Not for: one
clean rebase (`rebase-branch.md`), a parent with children (`rebase-cascade.md`), or a branch
whose work already landed in another form (`oracle-merge.md`, which any branch in the fleet may
need). On GitLab fleets at work the audit and the pinned-lease push live in the internal
plugin's `rebase-prs` skill.

Validated on a TypeScript monorepo with a barrel normaliser: `references/rebase-fleet-worked-example.md`
walks two real branches.

## Config seams — fill these in per project before starting

| Seam | What it is | Example (replace) |
|---|---|---|
| base | the moved ref you rebase onto; `tools git base <branch>` answers per branch | `origin/feature/next` |
| untracked install config | a gitignored file the install needs that does not travel with a fresh worktree; copy it in BEFORE install | `.npmrc` |
| install | regenerates deps for the rebased tree | `bun install` |
| normalisation | OPTIONAL codemod after install, before lint and tsc; **always ask** whether the project has one | `bun imports autofix --commit` |
| lint / typecheck / tests | the real per-app tsc, not a faster substitute; the suites that prove no work was lost | `bun run lint`, `yarn --cwd app typescript-check`, `bun run test` |
| fix-commit scope | the scope tag for the lint/tsc fix commit | `fix(<ticket>): Fix tsc/lint 🔧` |

The untracked-config gotcha is the silent failure: an install missing a private registry
config can half-fail and still exit 0; nothing looks wrong until tsc or tests blow up later.

## Per-branch procedure, in order

1. **Isolated worktree + backup.**
   ```bash
   git worktree add --no-track -b rebase/<id> <worktree-path> origin/<branch>
   cp <repo>/<untracked-config> <worktree-path>/               # the seam above
   BACKUP=bkp/rebase/<id>-$(date +%Y%m%d-%H%M)
   git -C <worktree-path> tag "$BACKUP"
   OLD_BASE=$(git -C <worktree-path> merge-base HEAD origin/<base>)
   ANCHOR=$(git rev-parse origin/<branch>)                     # lease anchor, before anything moves
   ```
   `--no-track` so a stray push can never target the base. Record `BACKUP`, `OLD_BASE`, `ANCHOR`;
   every later step uses the variable, never a re-typed timestamp. This procedure is
   **origin-only by construction**: the worktree is cut from `origin/<branch>`, so that is also
   the lease anchor and the push destination. A fleet whose branches push to a second remote
   (a fork, a triangular setup) does not belong here; restack those one at a time through
   `rebase-branch.md`, which resolves `<branch>@{push}` instead of assuming `origin`.
2. **Is it still needed?** `tools git merged <branch> --base origin/<base>`: MERGED means the
   branch is done, not behind; report it and skip. UNMERGED with most files landed and mostly `+`
   in `git cherry` means `oracle-merge.md`, not a replay.
3. **Rebase:** `git -C <worktree-path> rebase origin/<base>`.
4. **Resolve every conflict by hand.** Never `-X theirs`, `-X ours`, `--ours`, `--theirs`,
   "accept current", "accept incoming". Read both sides. An import-only hunk on a repo with a
   normaliser: take the branch side (same imports, different spelling; step 6 re-normalises;
   `import-fast-path.md`). A real-code conflict: merge both sides' intent. Cannot tell → STOP,
   leave the worktree mid-state, report. After each file: `git add`, `git rebase --continue`.
   Record each conflict in the Conflicts sidecar (template below).
5. **Install** from the repo root. Commit a lockfile drift only when the base's lockfile is stale.
6. **Normalisation, only if the project has one and the user said so.** Capture the full log.
7. **Lint + typecheck + tests, fix, commit** under the fix-commit scope. No blanket disables. A
   lint or tsc error that needs a non-mechanical change → STOP and flag.
8. **Verify gate:**
   ```bash
   git range-diff "$OLD_BASE".."$BACKUP" origin/<base>..HEAD
   ```
   PASS = only import-path and lint/format deltas. FAIL = a functional delta → a resolution was
   botched → `git reset --hard "$BACKUP"` and redo. The gate is blind to import-line
   correctness; tsc and tests are the real gate.
9. **Sidecars + index section** (templates below); parallel agents append via quoted heredoc.
10. **Push: HELD** unless the user typed push. Report the new HEAD sha and the exact line:
    ```bash
    git -C <worktree-path> push --force-with-lease=<branch>:$ANCHOR origin HEAD:refs/heads/<branch>
    ```
    The rebase happened on `rebase/<id>` inside the worktree, so the local `<branch>` still points
    at its old tip. `origin <branch>` would push that untouched ref and report success while
    nothing moved. `HEAD:refs/heads/<branch>`, run from the worktree, sends the rebased commits
    to the branch the lease was taken against.

## Orchestration: tier by commit count, not by merge-tree conflict count

```
commits ahead of the base (git rev-list --count origin/<base>..origin/<branch>):
├─ targets the base directly
│   ├─ ≤ ~10 commits   → fan out, one agent per branch, ≤ 3 in flight
│   └─ 40–90+ commits  → one sequential agent; never the fan-out
└─ targets another branch (a chain) → rebase the parent first, then the child onto the
    rebased parent's ref, or `tools git rebase-cascade <parent>` for the whole stack
```

`merge-tree` under-predicts: a three-way merge sees the net result, a rebase replays every
commit and conflicts at intermediate ones (a "2 import-only files" branch conflicted on commit
2 of 62). Cap fan-out at about 3: every worktree carries its own `node_modules`, and many
concurrent installs exhaust the vnode table (MCP servers disconnect with ENFILE;
`sudo sysctl -w kern.maxvnodes=750000` buys headroom on macOS).

Agent protocol: each agent writes its two sidecars, appends its `## PR <id>` section to the
index via `cat >> "<index>" <<'EOF'`, posts a `question_answer` summary (`tag: action`), never
pushes, reports the new HEAD sha, and STOPs on any conflict it cannot resolve with confidence.

## Gotchas

1. Tier by commit count (above).
2. `range-diff` is blind to import correctness; tsc + tests are the gate.
3. `eslint --fix` detaches `eslint-disable-next-line` comments when it reorders imports; place
   them by hand and do not re-run `--fix` on that file.
4. A dependency bump on the base can break a branch's tests through a stale shared test mock;
   fix the mock once and land it on the base so every branch inherits it.
5. Pre-existing red: a failing file byte-identical to the branch tip (`git diff <backup-tag> --
   <file>` empty) was red before you; report it, never force it green.
6. Most commits "should be absorbed" but do not auto-drop → `oracle-merge.md`.
7. Stale rerere replays wrong resolutions silently; move `.git/rr-cache` aside first
   (`oracle-merge.md` step 2).

## Templates

Index section (append-only, newest last):

```md
## PR <id> — <title>
- **Branch:** `<source>` → rebased onto `<base>` @ `<short-sha>`
- **Backup tag:** `bkp/rebase/<id>-<ts>`  (restore: `git reset --hard bkp/rebase/<id>-<ts>`)
- **Result:** <Clean | Resolved N conflict(s) | BLOCKED: …>
- **Conflicts:** <N> file(s) → [sidecar](…-PR<id>-Conflicts.md)
- **Normalisation:** <N files | no-op | none for this project> → [log](…-PR<id>-Normalisation.md)
- **lint/tsc fix commit:** `<short-sha>` | none needed
- **Verify (range-diff):** <PASS — only import/lint deltas | FAIL — functional drift in `<file>`>
- **New HEAD:** `<short-sha>` · **Commits ahead of base:** <n>
- **Push:** HELD — `git -C <worktree-path> push --force-with-lease=<branch>:<anchor> origin HEAD:refs/heads/<branch>`
- **Be aware:** <risky resolutions, deps added, tests touched, or "nothing notable">
```

Conflicts sidecar, one block per hunk (`<base side>`, `<branch side>`, `<resolution>`, `<why>`
with exact lines). Normalisation sidecar: command, exit code, commit, files rewritten, full log.
