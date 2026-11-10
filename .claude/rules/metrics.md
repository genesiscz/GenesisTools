---
paths:
  - "src/metrics/**"
  - "src/utils/metrics/**"
  - "scripts/benchmarks/metrics/**"
  - "plugins/genesis-tools-mods/hooks/metrics.ts"
---

# tools metrics (src/metrics/, src/utils/metrics/)

Loaded by Claude Code when you read, write or edit the metrics tool, its library, its benchmark or the mods plugin's
spool writer. The design: `.claude/plans/2026-11-11-MetricsTool.md`; the user docs and the measured numbers:
`src/metrics/README.md`.

- **Where the code is.** `src/utils/metrics/`: `types.ts` (the shapes), `dims.ts` (the dim-name guard and the event
  check), `sql.ts` (every SQL text built from a request), `store.ts` (`MetricsStore`, the only reader and writer of
  `metrics.db`), `spool.ts` (paths, the line format, the drain), `client.ts` (`metrics.record()`), `protocol.ts` (the
  RPC method table), `service.ts` and `service-client.ts`. `src/metrics/` is the CLI. The mods plugin's writer is
  `plugins/genesis-tools-mods/hooks/metrics.ts` (standalone, no engine types, since `src/metrics` imports it).
- **The spool line contract.** One JSON object per line, ending in `\n`: `{"v":1, project, metric, at, value, dims?,
  context?}`, `at` in epoch ms (set by the writer; an absent one reads as the drain's time), file name
  `<writer>-<local YYYY-MM-DD>.jsonl`. The drain takes whole lines only, and writes the events and the new offset in
  one transaction. A line `{"v":1,"define":{project, metric, unit?, description?, dims?}}` declares a metric (a
  plugin cannot call `define`). A change of the shape is a new `v`, and the drain keeps reading the old one.
- **The dim-name rule.** A dim name matches `^[A-Za-z][A-Za-z0-9_]{0,39}$`, checked by `assertDimName` / `isDimName`
  in `dims.ts`, the one check between a name and SQL text. Every door calls it; values are always bound parameters.
  Build SQL only in `sql.ts`; a caller passes a `MetricQuery`, never SQL.
- **Diagnostics never mutate.** `list` and `status` (and the `catalog` and `status` methods) never start the service
  and never drain the spool.
- **The native-code gate.** Bun FFI or a compiled helper only when `bun scripts/benchmarks/metrics/ingest-query.ts
  --runs 5` measures a median query above 250 ms at 1 M events, or a door's ingest below 50 000 events per second.
  Run it before and after any change to `sql.ts`, `store.ts` or the drain, with the load average, and update the
  README's table.
