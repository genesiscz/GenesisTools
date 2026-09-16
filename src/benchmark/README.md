# Benchmark

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Lightweight command-benchmarking runner — save, run, and compare timed command recipes.**

Define benchmarks once (command + args + expected behaviour), then run/list/edit/diff them from the CLI. Under the hood it records per-run history so you can see how a command's timing drifts over releases.

---

## Quick Start

```bash
# Run a saved benchmark interactively (no args)
tools benchmark

# Add a benchmark
tools benchmark add

# List benchmarks
tools benchmark list

# Show one + its recent runs
tools benchmark show <name>

# Run a benchmark by name
tools benchmark run <name>

# Edit / remove
tools benchmark edit <name>
tools benchmark remove <name>

# Historical runs
tools benchmark history <name>
```

---

## Commands

| Command | Description |
|---------|-------------|
| `run [name]` | Run a benchmark by name, or pick interactively |
| `add` | Create a new benchmark definition |
| `list` | List all benchmarks with their last run time |
| `show <name>` | Show the definition + recent history |
| `edit <name>` | Edit a benchmark |
| `remove <name>` | Delete a benchmark |
| `history <name>` | Show the run history for one benchmark |

Run each subcommand with `--help` for the full option list.

---

## Storage

Benchmark definitions and history live under `~/.genesis-tools/benchmark/`. History is JSON, so you can diff it with any tool.

---

## In-process measurement library

Everything above wraps **hyperfine**, which times a command from the outside. That cannot answer
the questions a CPU-hog investigation asks: what does a long-lived daemon burn while idle, how
many child processes does one call start, how many `stat` calls does a scan make, and did
anything block the event loop.

`src/benchmark/lib/` carries a second, independent surface for that. Import it as
`@app/benchmark/lib`; it pulls in no CLI or prompt code.

| Module | Answers |
|---|---|
| [`process-sample.ts`](lib/process-sample.ts) | What does this process burn over a known window? |
| [`spawn-counter.ts`](lib/spawn-counter.ts) | How many child processes did this code start? |
| [`fs-counter.ts`](lib/fs-counter.ts) | How many `node:fs` calls did this code make? |
| [`loop-stall.ts`](lib/loop-stall.ts) | Did anything block the event loop, and for how long? |
| [`baseline.ts`](lib/baseline.ts) | Is the "after" number better than the recorded "before"? |

```typescript
import { compareToBaseline, formatComparison, sampleProcess, withSpawnCounter } from "@app/benchmark/lib";

const idle = await sampleProcess(daemonPid, { windowMs: 30_000 });
const { count } = await withSpawnCounter(() => refreshStatusline());
const cmp = await compareToBaseline({
    name: "statusline",
    metrics: { idleCpuPercent: idle.cpuPercent, spawns: count },
    tolerancePct: 10,
});
out.println(formatComparison(cmp));
```

### What each counter cannot see

Both counters report a **floor**, never a total, and each module's JSDoc says why.

- `withSpawnCounter` patches only `Bun.spawn` and `Bun.spawnSync`. Every `node:child_process`
  entry point funnels into those two, so patching `node:child_process` as well would double-count.
  `Bun.$` reaches the OS through a native path and is invisible.
- `withFsCounter` patches the methods on the `node:fs` module object. A module written as
  `import { statSync } from "node:fs"` binds the function value at import time and is invisible;
  `import fs from "node:fs"` plus `fs.statSync(...)` is counted. `Bun.file` and `Bun.write` are
  native and are invisible.

### Why CPU time and not wall time

`ps %cpu` on macOS is a decayed average over a process's whole life, so a daemon that spun hard
yesterday still reads high today. `sampleProcess` takes two `cputime` snapshots a known interval
apart instead, which cannot be gamed that way. Wall time on this machine swings with load average
(see [`docs/benchmarks-du.md`](../../docs/benchmarks-du.md)), so CPU time and call counts are the
metrics a baseline should hold.

Baselines are git-tracked under [`scripts/benchmarks/baselines/`](../../scripts/benchmarks/baselines/).
