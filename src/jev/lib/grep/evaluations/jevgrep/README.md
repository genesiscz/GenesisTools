# Jev grep vs upstream `jg`

A durable check that `tools jev grep` still behaves like [dzhng/jevgrep](https://github.com/dzhng/jevgrep):
same question, same key, same budget, then compare what each found, how many calls it made, what it cost,
and how long it took.

## Run

```bash
# once: a checkout of upstream next to this repo, with its dependencies (no install scripts)
git clone https://github.com/dzhng/jevgrep ../_Playgrounds/jevgrep
(cd ../_Playgrounds/jevgrep && git checkout 09346e16c43d3b9bb809839591dc43c3d5c5aa8f && bun install --ignore-scripts)

bun src/jev/lib/grep/evaluations/jevgrep/run.ts --case tools-control
bun src/jev/lib/grep/evaluations/jevgrep/run.ts --case all --concurrency 32
bun src/jev/lib/grep/evaluations/jevgrep/run.ts --query "Where is X?" --root src --max-requests 50 --max-usd 0.02
```

`--upstream <path>` points at another checkout. `--no-write` skips the result file.

## What it spends

Real TypeSafe calls with the key from `tools jev login`, handed to upstream in memory (no second
credential file). Each case caps each implementation at `maxRequests` calls and `maxCostUsd` dollars
(defaults 200 and $0.10 in `cases.ts`). The answer cache is off for both, so every run pays. Every call
is booked in the usage ledger as `grep eval upstream` or `grep eval port`, so `tools jev spend` shows
what the comparisons cost.

## Why concurrency 1 by default

Under a cap, 32 parallel workers stop at a point set by network timing, and two runs of the same code
then differ. One call at a time makes each request sequence fixed, so equivalent implementations stop
at the same request and must return the same files. Use `--concurrency 32` to time production settings;
expect the file sets to differ when a cap is hit.

## Reading a result

`results/<time>-<case>-c<concurrency>.json` holds both runs and the comparison:

- `sameFiles`, `sameRanking`, `jaccard`, `onlyUpstream`, `onlyPort`: the returned paths.
- `sameBody`: SHA-256 of the packet from the first file bullet to the end. The header lines differ by
  design (banner, instruction files, projects), so they are not compared.
- `maxScoreDelta`: Jev can answer an identical request with a probability that moves in the second
  decimal, so small deltas are expected and do not mean the code differs.
- `requestsDeltaPct`, `costDeltaPct`, `wallDeltaPct`: port relative to upstream.

Known, intended differences: upstream parses Python with a bundled CPython and this port reads it as text,
so a case that returns `.py` files can differ in excerpts and leads. The port's own diff list is in
`docs/specs/2026-09-28-jev-grep.md`.
