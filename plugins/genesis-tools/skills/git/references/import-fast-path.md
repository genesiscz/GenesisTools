# The import-only fast path (rare)

On a JS/TS monorepo with a barrel normaliser, a long rebase produces dozens of conflicts whose
every line is an import: the base holds the normalised full path, the branch the
pre-normalisation alias, and both mean the same module. Reading both sides and taking the
branch side is a correct manual resolution, because the normaliser re-normalises afterwards; the
typecheck and the tests, not `range-diff`, then prove the imports were right.

That automation lives where the normaliser lives: the internal plugin's `rebase-prs` skill
ships `scripts/resolve-imports.ts` (a Bun port of the monorepo's `rebase-resolve-imports.sh` +
`classify.awk` pair) which resolves import-only hunks toward the branch side and stops at the
first real-code conflict (exit 2), or finishes the rebase (exit 0). Outside that repository the
answer is "resolve by hand", one hunk at a time, both sides' intent, never `-X`.
