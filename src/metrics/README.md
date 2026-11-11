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
# Mark a change, then compare before and after it
tools metrics checkpoint add agent-context pointers --commit 4e7a3bc --note "area rules as pointer lines"
tools metrics query agent-context hook.injection --group-by checkpoint --since 14d
```

## Commands

- `record <project> <metric> <value> [--dim name=value]... [--context <json>]`: append one event to the spool.
- `query <project> <metric>`: group and aggregate. `--group-by a,b` (dims, plus `time:hour`, `time:day` or `checkpoint`),
  `--agg count,sum,avg,min,max,p50,p90,p99` (default `count,sum`), `--sort -sum` (a leading `-` sorts descending;
  default the sum, descending), `--limit 50`, `--json`.
- `events <project> <metric>`: the single events with dims and context, newest first. `--limit 20`, `--json`,
  `--checkpoint` (each event names the checkpoint it falls under).
- Both take `--since <when>` and `--until <when>` (`10d`, `2h`, `30m`, a date `2026-11-01`, a time `09:30`, or
  `checkpoint:<name>` for that checkpoint's time) and `--where` (repeatable): `dim=value`, `dim=a,b` (one of),
  `dim!=value`, `dim~glob`. `null`, `true`, `false` and numbers are read as such. `checkpoint=<name>` keeps the
  events from that checkpoint to the next one.
- `tail [project] [metric]`: print events as the service takes them in, until Ctrl-C. `--json` for one JSON line each,
  `--checkpoint` to name each event's checkpoint.
- `checkpoint add <project> <name> [--commit <sha>] [--repo <text>] [--note <text>] [--at <when>] [--data <json>]`:
  mark "at this time we changed Y in commit Z". A name that exists is updated: a field given replaces the stored one, a
  field left out keeps it, and `--at` defaults to now only for a new name.
- `checkpoint list [project] [--json]`: the checkpoints by project and time; reads only, like `list`.
- `checkpoint rm <project> <name>`: remove one (exit code 1 when there was none). Its events stay and fall under the
  checkpoint before it.
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
- **Checkpoints** belong to a project (`checkpoints` table: `project`, `name` unique per project, `at`, `commit`,
  `repo`, `note`, `data`). `--group-by checkpoint` puts each event under the latest checkpoint of its project at or
  before its time, under `(before <first name>)` when it is older than all, or under `(none)` when the project has
  none. It works beside other group keys (`--group-by agent,checkpoint`). Grouped by `checkpoint` alone (or with
  `time:hour` or `time:day`), each checkpoint's span is read as a time range of the `(metric_id, at)` index. Grouped
  by `checkpoint` and nothing else, the table also shows each span (`from`, `to`, `days`) and `count/day` and
  `sum/day`: the spans differ in length, so compare the rates, not the raw sums. A span's open start is `--since`, else
  the first event; its open end is `--until`, else now. The name `checkpoint` in `--group-by` and `--where` always
  means the checkpoint, never a dim of that name.
- **A producer can mark a checkpoint in the spool**: a line `{"v":1,"checkpoint":{"project":…,"name":…,"at":…,
  "commit":…,"repo":…,"note":…,"data":…}}` does what `checkpoint add` does (`checkpointSpoolLine()` in
  `@genesiscz/utils/metrics/spool` writes one). Set `at`: without it a new name takes the drain's time.
- **A producer can declare its metric in the spool**: a line `{"v":1,"define":{"project":…,"metric":…,"unit":…,
  "dims":[…]}}` does what `define` does. The mods plugin writes one per plugin load, so the dims of
  `agent-context / hook.injection` (`session`, `agent`, `agentType`, `event`, `source`, `rule`, `dropped`, `model`,
  `delivery`) are indexed without any setup.
- **The service** (`~/.genesis-tools/metrics/service/`: `service.json`, `service.sock`) starts on demand when a
  command needs it and exits after 10 minutes with no connection, or when its code changed.
- **`list` and `status` only read.** They ask a running service, or open the store file read-only; neither starts the
  service nor drains the spool.
- **The service measures itself** into project `metrics`: `query.ms` (dims `method`, `caller`, `project`, `metric`,
  `groupBy`), `ingest.events` and `ingest.rejected` (dim `door`: `spool`, `rpc`, `import`) and `drain.ms`.
- The mods plugin's ledger also writes `model` (the model of the loop the injection went to, null while the plugin
  has not seen one) and `delivery` (`full` for an area rule's text, `pointer` for one `Area rules (pointer): ...`
  line, null for other sources). The shell guard writes `agent-context / guard.verdict`, one event per firing rule
  (`src/agents/README.md`, "Guard messages"). The resume guard writes `agent-context / agent.resume` and `agent.resume.result`
  (the plugin's README, "The resume guard").
- `import hooks-log` makes one event per old line (the old log kept no per-entry length) with `session: null`. Its
  offset is kept, so a second run adds only new lines.
- Time buckets are UTC; the CLI prints each bucket's start in local time. Boolean dims group as `1` and `0`.
- Profiling: `PROFILE=metrics` times each drain, ingest batch, query and events read.

## Before and after a change

```bash
# The change landed 2 hours ago in commit 4e7a3bc
tools metrics checkpoint add agent-context pointers --at 2h --commit 4e7a3bc --repo owner/app \
    --note "area rules as pointer lines"
# Injected characters per day before and after it (count/day and sum/day are the fair comparison)
tools metrics query agent-context hook.injection --group-by checkpoint --since 7d
# The same split by source, and only the events since the checkpoint
tools metrics query agent-context hook.injection --group-by source,checkpoint --since 7d
tools metrics query agent-context hook.injection --since checkpoint:pointers --group-by source
# The single events after it, each with its checkpoint
tools metrics events agent-context hook.injection --where checkpoint=pointers --checkpoint --limit 10
```

## Configuration

- `mods.hooks.metrics` (default `true`): the mods plugin's hook ledger records each injection into the spool.
  `tools agents hooks config set mods.hooks.metrics false` turns it off.
- `GENESIS_TOOLS_HOME` moves the whole `~/.genesis-tools` tree (store, spool, service), as for every tool.

## For agents

Every command but `record` and `tail` prints its machine result with `--json` (or always, for `record`, `connect`,
`import` and `serve --status`) on stdout; human tables go to stdout only without `--json`, messages to stderr. Exit
code 1 for a refused flag, an unknown dim name or a service that does not start.

## Speed (benchmark)

`bun scripts/benchmarks/metrics/ingest-query.ts --scratch <dir> --runs 5`, 2026-11-11 03:30 on the Mac checkout,
bun 1.4.2, load average 27.65 30.94 34.60 (a busy machine). Median of 5 interleaved runs, with min and max. The 1 M
arms query one metric of 1 M events, `agent` and `event` declared, `tool` undeclared. The checkpoint arms group by
`checkpoint` with 5 checkpoints in the project (four in the first 160 s, so the 100 k metric splits into five groups,
and one at day 15 of the 1 M metric's 30 days). Against a baseline taken at 03:16 before the checkpoint change (load
12.76), `--compare` found no arm slower by more than its 25% tolerance; the largest change was the 1 M filter on an
undeclared dim, 329 to 379 ms (+15%), on a machine twice as loaded.

| arm | min ms | median ms | max ms | events/s |
| --- | ---: | ---: | ---: | ---: |
| insert, batch 1 | 347 | 368 | 384 | 54 367 |
| insert, batch 100 | 38 | 46 | 58 | 434 841 |
| insert, batch 1000 | 23 | 24 | 31 | 825 961 |
| spool drain, 50 k lines | 116 | 125 | 139 | 400 992 |
| RPC ingest, 20 k | 47 | 58 | 81 | 342 017 |
| 100 k group, declared dim | 4.5 | 5.0 | 5.4 | |
| 100 k group, two dims | 87 | 89 | 103 | |
| 100 k group, time:hour | 16 | 18 | 21 | |
| 100 k filter, declared | 8.4 | 9.3 | 9.5 | |
| 100 k filter, undeclared | 29 | 34 | 35 | |
| 100 k p90, declared | 5.4 | 5.7 | 6.0 | |
| 100 k group, checkpoint | 3.3 | 3.4 | 3.9 | |
| 1 M group, declared dim | 47 | 47 | 48 | |
| 1 M group, two dims | 984 | 1008 | 1074 | |
| 1 M group, time:hour | 193 | 206 | 228 | |
| 1 M filter, declared | 130 | 134 | 165 | |
| 1 M filter, undeclared | 343 | 379 | 404 | |
| 1 M p90, declared | 54 | 55 | 56 | |
| 1 M group, checkpoint | 31 | 32 | 32 | |

The first build of the checkpoint group was one pass with the label as a CASE expression: 248 ms median at 1 M (230
to 264), just under the gate, because SQLite sorted all 1 M labels in a temporary B-tree. A group by `checkpoint`
alone (or with a time bucket) is now one SELECT per checkpoint span joined by UNION ALL, each a range read of the
`(metric_id, at)` index: 32 ms. With a dim beside it (`--group-by agent,checkpoint`) the CASE pass stays.

A first run with each declared dim indexed on the dim alone took 835 ms for the 1 M group by a declared dim and
738 ms for its p90, because SQLite parsed every row's dims JSON. The index now carries `at` and `value`, and a query
that groups by one declared dim and touches no other dim names that index, so it reads the index alone.

**Native-code gate: triggered** by the two 1 M shapes that read an undeclared dim (two dims, 1008 ms; filter on an
undeclared dim, 379 ms), as before the checkpoints; the checkpoint arms do not trigger it. Ingest passes: every door
is above 300 000 events per second (batch 1 is no door; every door batches). The time is SQLite's `json_extract` over 1 M rows, about 0.7 µs per row, which a compiled helper would not
remove without another storage layout. No native code was added. The decision (2026-11-11): declare the dims a
question needs (a `define`, or a define line in the spool), and add a rollup only when a declared shape is slow.

## Related

- [`tools agents`](../agents/README.md): the hook config that holds `mods.hooks.metrics`.
