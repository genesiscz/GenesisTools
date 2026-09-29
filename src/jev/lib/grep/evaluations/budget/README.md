# Budgeted search on known answers

`tools jev grep` plans for about 100 Jev calls by default (`--budget`). This measures whether that
budget still finds the right code, on behavior questions about this checkout whose answer files were
checked by hand (`cases.ts`).

```bash
bun src/jev/lib/grep/evaluations/budget/run.ts                    # every case, default budget
bun src/jev/lib/grep/evaluations/budget/run.ts --budget 60 --case port-listen
```

A case is a hit when one gold file comes back with source within the first five bullets of the packet.
The table also shows each gold file's rank (`*` means it came back as a location without source), the
calls, the cost, and the wall time. Results go to `results/<time>-budget<n>.json`.

Real calls: each case is capped at 1.3 times the budget and at `--max-usd` dollars (default $0.10),
the cache is off, and the calls are booked as `grep eval budget` in `tools jev spend`.

Parity with upstream `jg` is a different question, measured by `../jevgrep/` with `--budget 0`.
