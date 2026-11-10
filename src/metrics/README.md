# tools metrics

Record a number with its context, and ask about it later. A producer records `(project, metric, value, dims,
context)`; anyone can filter, group, sort and bucket the events by time, down to the single event with its context.
The first producer is the mods plugin's hook ledger (`agent-context / hook.injection`).

## Quick start

```bash
# Record one event (appends to the spool; no service needed)
tools metrics record shop checkout.ms 120 --dim agent=main --dim tool=Bash --context '{"note":"first"}'
# What the hooks handed the model in the last 30 days, per hook event
tools metrics query agent-context hook.injection --group-by event --since 30d
# The biggest injection sources and rule files after tool calls, with the 90th percentile
tools metrics query agent-context hook.injection --group-by source,rule --where event=PostToolUse --agg count,sum,p90
# The single events of one session, with their context
tools metrics events agent-context hook.injection --where session=s-1 --limit 20
# Watch events arrive
tools metrics tail agent-context
```

## Commands

- `record <project> <metric> <value> [--dim name=value]... [--context <json>]`: append one event to the spool.
- `query <project> <metric>`: group and aggregate. `--group-by a,b` (dims, plus `time:hour` or `time:day`),
  `--agg count,sum,avg,min,max,p50,p90,p99` (default `count,sum`), `--sort -sum` (a leading `-` sorts descending;
  default the sum, descending), `--limit 50`, `--json`.
- `events <project> <metric>`: the single events with dims and context, newest first. `--limit 20`, `--json`.
- Both take `--since <when>` and `--until <when>` (`10d`, `2h`, `30m`, a date `2026-11-01` or a time `09:30`) and
  `--where` (repeatable): `dim=value`, `dim=a,b` (one of), `dim!=value`, `dim~glob`. `null`, `true`, `false` and
  numbers are read as such.
- `tail [project] [metric]`: print events as the service takes them in, until Ctrl-C. `--json` for one JSON line each.
- `define <project> <metric> [--unit u] [--description d] [--dim name]...`: declare a metric; declared dims get an
  index. Any other dim works too, only slower.
- `prune --before <when>`: delete the events of every metric older than a time (`90d`, a date). Nothing is deleted
  until you run it.
- `list`: every project and metric with its event count and first and last time. `--json`.
- `status`: the service, the store and the spool bytes not taken in yet. `--json`.
- `connect --stdin`: read one event JSON per line and send them through `ingest` in batches; prints accepted and
  rejected counts. `connect --rpc`: JSON-RPC 2.0 on stdin and stdout, forwarded to the service.
- `import hooks-log [path]`: read the old ledger log (`~/.genesis-tools/agents/mods-log/hooks.jsonl` by default) into
  `agent-context / hook.injection`.
- `serve [--detach | --status | --stop] [--no-idle]`: run the service in this process, in the background, print the
  running one's `service.json`, or stop it.

## How it works

- **One SQLite file per machine**: `~/.genesis-tools/metrics/metrics.db` (WAL). Events are the source of truth; every
  statistic is a query over them. The metrics service is the only process that writes it.
- **The spool is the default way to record**: `~/.genesis-tools/metrics/spool/<writer>-<YYYY-MM-DD>.jsonl`, one event
  per line with `"v":1`. `record`, `metrics.record(...)` from `@genesiscz/utils/metrics` (buffered, never throws) and
  the mods plugin write it. The service drains it at start, when the folder changes, and before each `query` and
  `events`. A drain writes the events and the file's new offset in one transaction, so nothing is counted twice; a
  fully read file of an earlier day is deleted; a bad line is counted, logged with its line number, and skipped.
- **A producer can declare its metric in the spool**: a line `{"v":1,"define":{"project":…,"metric":…,"unit":…,
  "dims":[…]}}` does what `define` does. The mods plugin writes one per plugin load, so the dims of
  `agent-context / hook.injection` (`session`, `agent`, `agentType`, `event`, `source`, `rule`, `dropped`) are
  indexed without any setup.
- **The service** (`~/.genesis-tools/metrics/service/`: `service.json`, `service.sock`) starts on demand when a
  command needs it and exits after 10 minutes with no connection, or when its code changed.
- **`list` and `status` only read.** They ask a running service, or open the store file read-only; neither starts the
  service nor drains the spool.
- **The service measures itself** into project `metrics`: `query.ms` (dims `method`, `caller`, `project`, `metric`,
  `groupBy`), `ingest.events` and `ingest.rejected` (dim `door`: `spool`, `rpc`, `import`) and `drain.ms`.
- `import hooks-log` makes one event per old line (the old log kept no per-entry length) with `session: null`. Its
  offset is kept, so a second run adds only new lines.
- Time buckets are UTC; the CLI prints each bucket's start in local time. Boolean dims group as `1` and `0`.
- Profiling: `PROFILE=metrics` times each drain, ingest batch, query and events read.

## Configuration

- `mods.hooks.metrics` (default `true`): the mods plugin's hook ledger records each injection into the spool.
  `tools agents hooks config set mods.hooks.metrics false` turns it off.
- `GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` tree (store, spool, service), as for every tool.

## For agents

Every command but `record` and `tail` prints its machine result with `--json` (or always, for `record`, `connect`,
`import` and `serve --status`) on stdout; human tables go to stdout only without `--json`, messages to stderr. Exit
code 1 for a refused flag, an unknown dim name or a service that does not start.

## Speed (benchmark)

`bun scripts/benchmarks/metrics/ingest-query.ts --scratch <dir> --runs 5`, 2026-11-11 00:33 on the Mac checkout,
bun 1.4.2, load average 24.48 25.86 26.45 (a busy machine). Median of 5 interleaved runs, with min and max. The 1 M
arms query one metric of 1 M events, `agent` and `event` declared, `tool` undeclared.

| arm | min ms | median ms | max ms | events/s |
| --- | ---: | ---: | ---: | ---: |
| insert, batch 1 | 373 | 381 | 395 | 52 475 |
| insert, batch 100 | 36 | 42 | 58 | 478 012 |
| insert, batch 1000 | 22 | 23 | 24 | 879 535 |
| spool drain, 50 k lines | 110 | 121 | 134 | 413 890 |
| RPC ingest, 20 k | 48 | 57 | 88 | 348 949 |
| 100 k group, declared dim | 4.7 | 4.8 | 5.4 | |
| 100 k group, two dims | 81 | 84 | 97 | |
| 100 k group, time:hour | 16 | 19 | 22 | |
| 100 k filter, declared | 8.3 | 8.8 | 9.7 | |
| 100 k filter, undeclared | 29 | 29 | 30 | |
| 100 k p90, declared | 5.6 | 5.7 | 6.7 | |
| 1 M group, declared dim | 46 | 47 | 52 | |
| 1 M group, two dims | 942 | 1107 | 1160 | |
| 1 M group, time:hour | 199 | 221 | 242 | |
| 1 M filter, declared | 121 | 144 | 153 | |
| 1 M filter, undeclared | 318 | 340 | 354 | |
| 1 M p90, declared | 55 | 56 | 58 | |

A first run with each declared dim indexed on the dim alone took 835 ms for the 1 M group by a declared dim and
738 ms for its p90, because SQLite parsed every row's dims JSON. The index now carries `at` and `value`, and a query
that groups by one declared dim and touches no other dim names that index, so it reads the index alone.

**Native-code gate: triggered** by the two 1 M shapes that read an undeclared dim (two dims, 1107 ms; filter on an
undeclared dim, 340 ms). Ingest passes: every door is above 300 000 events per second (batch 1 is no door; every door
batches). The time is SQLite's `json_extract` over 1 M rows, about 0.7 µs per row, which a compiled helper would not
remove without another storage layout. No native code was added. The decision (2026-11-11): declare the dims a
question needs (a `define`, or a define line in the spool), and add a rollup only when a declared shape is slow.

## Related

- [`tools agents`](../agents/README.md): the hook config that holds `mods.hooks.metrics`.
