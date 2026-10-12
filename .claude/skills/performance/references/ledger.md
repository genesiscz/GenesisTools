# Where results go

## The ledger: `.claude/docs/performance.md`

A local, untracked file in the MAIN checkout (`<main>/.claude/docs/performance.md`), also from a linked worktree.
Append a dated section per change (`### YYYY-MM-DD HH:MM — <topic>`, time from `date '+%Y-%m-%d %H:%M'`). Never
rewrite an earlier entry; add a correction below it. Each win names:

- **before and after**, with the metric (CPU ms), the statistic (median of N), the order and the load average;
- **the cause** in one or two sentences (what work stopped happening, and why it was happening);
- **the code** when the user asked for it (the old excerpt and the new one);
- **the commit** and **the command** that reproduces it (`bun scripts/benchmarks/<area>/<script>.ts --compare`).

Rejected ideas go in too, with their numbers. "Tried X, slower by Y, because Z" saves the next person the
afternoon.

## Other places

- **Commit subjects** carry the headline number: `perf(fs): ... so cold Codex discovery spends 82 ms instead of
  143 ms of CPU`. Scopes follow the repository's commit-msg hook vocabulary.
- **Baselines** in `scripts/benchmarks/baselines/<name>.json`, committed with the script.
- **Long write-ups** (research, proposals, explanations) go into the Obsidian vault, never `/tmp`:
  `<notes vault>/Dev/Bun/` for Bun runtime research, `<notes vault>/Dev/Typescript/` for repository proposals.
- **Area docs**: `docs/benchmarks-cpu.md` (CPU harness and idle work), `docs/benchmarks-du.md` (`tools du`, with its
  own rules: append a section per feature), `src/utils/bun/compiler/README.md` (FFI and compiler measurements).
- **JSDoc** of a function that exists for speed states the measured reason in one or two sentences, so nobody
  "simplifies" it back.
