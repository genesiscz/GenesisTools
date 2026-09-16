# scripts/benchmarks/swift

Baselines for the two Swift hang-shaped risks in the CPU campaign: the uncapped accessibility
recursion in `ax-tool`, and the missing RPC deadline in `GenesisTools.app`.

Neither site burns CPU today. Both are absences of a bound, so these scripts do not chase a
speed-up. They pin what the current code costs, so the fix can be shown to change the bound
without changing the latency.

## Prerequisites

- **macOS with a Swift toolchain.** Both scripts compile or run Swift binaries.
- **The Accessibility grant on GenesisTools.app**, which is where `ax-tool` inherits it from.
  Check with `tools macos permissions`. The depth script asks `ax-tool permissions` directly before
  measuring and exits 1 when the grant is missing. It has to ask, because a missing grant and a
  working depth cap give the same answer: `axWindows` returns nothing, so `--id` reports
  "element not found" either way.
- **GenesisTools.app installed** at `~/Applications/GenesisTools.app`. Build it with `bun run app`.

## ax-tool-depth.ts

```bash
bun scripts/benchmarks/swift/ax-tool-depth.ts                     # measure and print
bun scripts/benchmarks/swift/ax-tool-depth.ts --baseline          # record swift-ax-tool-depth
bun scripts/benchmarks/swift/ax-tool-depth.ts --compare           # measure again and diff
bun scripts/benchmarks/swift/ax-tool-depth.ts --runs 1 --depths 20  # smoke, not a measurement
```

`--depths` takes a comma-separated list and defaults to `10,20,40,60`. The exit-code metric is
named after the deepest arm actually measured, so `--depths 20` records `findExitCodeAtDepth20`
and the default run records `findExitCodeAtDepth60`. A baseline outlives the person who remembers
which flags produced it.

It compiles `native/ax-tool/Fixtures/ControlFixture.swift`, launches four background instances of
it at nesting depths 10, 20, 40 and 60, and times `ax-tool get --app <pid> --id deep-leaf` against
each. `ax-tool` runs through the GenesisTools.app launcher, exactly as `src/control/lib/runner.ts`
does, because the Accessibility grant belongs to the app and not to the terminal.

The fixture builds its "Deep" window only when asked, through `--deep-depth <n>` or the
`CONTROL_FIXTURE_DEEP_DEPTH` environment variable. That is deliberate: `src/control/scripts/live-smoke.ts`
asserts the fixture shows exactly two windows, and an always-on third window would break it. The
command-line form wins over the environment form because `open(1)` goes through LaunchServices,
which makes no promise about forwarding the caller's environment.

**One nested `NSBox` is one accessibility level.** Measured, not assumed: with a 60-box chain the
leaf first appears at `ax-tool list --depth 61` and is absent at 60. So a `maxDepth` of 15 in
`findByIdentifier` puts `deep-leaf` out of reach at depths 20, 40 and 60, and leaves the depth-10
arm reachable.

### Metrics

| Metric | Meaning |
|---|---|
| `findMsAtDepth<N>` | Median wall time of one `--id` lookup against a depth-`N` chain. |
| `findMinMsAtDepth<N>` | Fastest of the same samples. The row to judge by. |
| `findExitCodeAtDepth60` | Process exit code of the last depth-60 lookup. |
| `foundAtDepth<N>` | 1 when the leaf was found. Recorded, printed, never compared. |

`foundAtDepth<N>` is a behaviour fact rather than a metric. A depth cap flips it 1 to 0 on purpose,
and a comparison would have to call that a pass or a failure when it is neither. `findExitCodeAtDepth60`
is compared higher-is-better for the same reason: the 0 to 1 a cap produces is the documented
not-found path, not a regression.

**Depth 10 is the negative control.** It sits inside any sane cap and must stay found and stay
fast. A cap that also loses the depth-10 arm broke ordinary lookups instead of bounding pathological
ones, which is worse than the risk it closed.

## notify-rpc.ts

```bash
bun scripts/benchmarks/swift/notify-rpc.ts              # measure and print
bun scripts/benchmarks/swift/notify-rpc.ts --baseline   # record swift-notify-rpc
bun scripts/benchmarks/swift/notify-rpc.ts --compare    # measure again and diff
bun scripts/benchmarks/swift/notify-rpc.ts --runs 1     # smoke, not a measurement
```

It calls `GenesisTools --rpc` ten times each for three read-only methods, interleaved.

- `rpc.hello` touches no XPC, so it measures app start plus the run loop. It is the floor.
- `notify.status` adds one `getNotificationSettings` round trip to `usernoted`.
- `notify.list` adds one `getDeliveredNotifications` round trip, sized by the payload.

`notify.post` and `notify.remove` are deliberately absent. Posting writes a real banner into the
user's Notification Center, and a benchmark has no business doing that ten times in a row.

### Metrics

| Metric | Meaning |
|---|---|
| `helloMs`, `statusMs`, `listMs` | Median wall time of one RPC round trip. |
| `helloMinMs`, `statusMinMs`, `listMinMs` | Fastest of the same samples. The row to judge by. |
| `helloExitCode`, `statusExitCode`, `listExitCode` | Exit code of the last call of each method. |
| `listNotificationCount` | Notifications the last `notify.list` serialized. Recorded, never compared. |

`listNotificationCount` exists because `notify.list` serializes whatever is sitting in Notification
Center at the time. Two `listMs` numbers are only comparable when the payload was the same size.

**This script does not prove the deadline fires.** That needs a wedged `usernoted`, which nothing
here can produce. It proves the other half: arming a timer must not make the answer slower, and a
deadline that never fires must not change the answer at all.

## Reading a comparison on a busy machine

These are wall-time numbers on a shared desktop, and that is the weakest kind of measurement this
repo keeps. The baselines currently in `../baselines/` were captured during a large parallel agent
run, at one-minute load averages between 57 and 206.

Measured across consecutive runs of `notify-rpc.ts` with no code change at all:

| Estimator | `rpc.hello` across three runs | Spread |
|---|---|---|
| Median | 86.08, 91.93, 117.19 ms | 26 % |
| Minimum | 65.86, 71.22, 68.01 ms | 4 % |

A preempted sample only ever adds time, so the minimum estimates the uncontended cost and the
median estimates the machine's mood. On one run the median row for `notify.list` reported
REGRESSED at +23 % while its minimum moved 1 % with an identical payload. Judge by the `*MinMs`
rows, and treat a lone median regression as noise unless the minimum moved with it.

Both scripts print the load average at record time beside the load average now, and say plainly
when the two are too far apart for a wall-time delta to be decidable.

Two rules follow:

1. **Use the same `--runs` on both sides.** The minimum of nine samples is lower than the minimum
   of five by construction, so mixing them manufactures an improvement.
2. **Re-record on a quiet machine** before treating any wall-time row as evidence. Both baselines
   are one command each and overwrite in place.

**Run the two benchmarks one at a time.** They are wall-time measurements of process startup, so a
second benchmark running beside them is measuring noise into both. That is also why `--runs` below
five refuses to record or compare, and exits 1 with the reason: a smoke run proves the script
works, and nothing more. One sample of the same depth-20 lookup came back at 52.78 ms and then at
262.34 ms minutes apart.

## Cleanup

`ax-tool-depth.ts` kills every fixture it launched in a `finally` block, after verifying the pid
still belongs to the temporary fixture binary it compiled. Confirm with:

```bash
pgrep -fl control-fixture
```

An exit code of 1 and no output means nothing was left behind. Never redirect that command's stderr
away: a permission error and an empty result look identical once it is gone.

## Typechecking

The root `tsconfig.json` includes only `src/**`, so a bare `bunx tsgo --noEmit` never looks at this
directory. The scoped project here does:

```bash
bunx tsgo --noEmit -p scripts/benchmarks/swift
bunx biome check scripts/benchmarks/swift
```
