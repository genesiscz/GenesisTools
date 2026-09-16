# `@genesiscz/utils/workers`

An on-demand worker pool and a cross-process SQLite wake source. Two files, one purpose: run a
queue without a hot poll.

```ts
import { WorkerPool, watchSqliteChanges } from "@genesiscz/utils/workers";
```

## Why it exists

The youtube pipeline ran 48 workers, each polling SQLite every 250 ms. Idle, with no jobs at
all, that was 182 claim queries a second and 0.50% of a core. Replacing it with one pool of
on-demand workers took the same idle state to 0 claims, one statement a second and 0.18% of a
core, while making a burst *faster*: first start 18 ms to 0.3 ms, drain 24.7 ms to 6.2 ms
(`scripts/benchmarks/youtube/pipeline-idle.ts`, numbers in `docs/benchmarks-cpu.md`).

The rule it enforces is the one in `CLAUDE.md`: wake on the event, never on a timer under
100 ms. See [Never spin](../../../CLAUDE.md).

## `WorkerPool`

A pool over a `claim` function. No worker exists until there is work.

- A worker that claims nothing **parks on a promise**. It does not loop, and it does not sleep.
- `kick()` wakes a parked worker, or spawns one if none is parked and `max` allows it.
- A parked worker idle for `idleTeardownMs` (default 30 s) **retires**, down to `min` (default 0).
- Scaling is **claim-driven**: with `spawnPolicy: "burst"` every successful claim wakes or spawns
  one more worker, which claims the next item, and so on to `max`. The ramp stops by itself the
  moment a claim returns null, so a burst needs no pending count. `pendingHint` lets one kick
  spawn several workers at once when the caller can count cheaply.
- `max` may be a function. It is re-read on every scale decision, so a config change applies to a
  running pool.
- `await stop()` raises the abort signal, then waits up to `drainTimeoutMs` (default 30 s) for
  running jobs before giving up on them.

```ts
const pool = new WorkerPool({
    name: "pipeline",
    max: () => config.concurrency,
    claim: async () => queue.takeNext(),
    run: async (job, ctx) => process(job, ctx.signal),
});

pool.start();
emitter.on("job:created", () => pool.kick());
```

### Wake sources are the caller's business

The pool does not know how work arrives. Give it one of:

- an in-process event (`emitter.on("created", () => pool.kick())`);
- a file watcher;
- `watchSqliteChanges`, below, for a queue another process writes;
- the built-in fallback poll (`pollMs`, default 2 s, `0` disables it), which exists so a missed
  event is healed within one interval rather than never.

`getStats().wakes` splits the wakes into `notify`, `timer` and `cascade`, which is how you tell a
pool that is genuinely event-driven from one living on its fallback: a healthy pool's `timer`
count stays near zero while work flows.

## `watchSqliteChanges`

Fires a callback when **another connection** commits to a `bun:sqlite` database, without polling
the table.

`fs.watch` on the database directory sees the `-wal` file change on every commit, and
`PRAGMA data_version` filters out this connection's own commits, which do not bump it. The
watcher is debounced, so a burst of commits produces one wake. It returns a stop function.

⚠️ An in-memory database has nothing to watch and returns a no-op. Keep the pool's fallback poll
for that case and for the rare dropped fs event. On bun 1.3.13 every `fs.watch` created after the
first `FSWatcher.close()` in a process goes deaf, which is the other reason the fallback is not
optional.

## Provenance

The design is assembled from prior art rather than invented:

- **tinypool / piscina** — `minThreads` / `idleTimeout` retiring idle threads, and `close()`
  racing the drain against a timeout and destroying anyway. Without that timeout one handler that
  ignores its abort signal hangs shutdown for good.
- **poolifier's dynamic pool** — spawn a worker only when no worker is idle.
- **p-queue's `_tryToStartAnother`** — the cascade that makes a burst ramp without a pending count.
- **tarn** — min/max resident resources with idle reaping.
- **graphile-worker** — the LISTEN/NOTIFY shape that `watchSqliteChanges` reproduces for SQLite,
  which has no such channel.

Longer notes: the `pool.ts` header, commit `0278633cb`, and the note
`<vault>/Dev/TypeScript/2026-09-16 Async worker pools and on-demand scaling in TypeScript.md` in
the Obsidian vault.

## Tests

`pool.test.ts` and `sqlite-wake.test.ts` beside the source. The idle behaviour that motivated the
package is measured, not asserted: `bun scripts/benchmarks/youtube/pipeline-idle.ts --compare`.
