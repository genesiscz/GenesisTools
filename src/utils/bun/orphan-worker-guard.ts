import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
// Relative on purpose: the ban below is on the `@genesiscz/*` alias graph, and this module
// imports nothing itself, so a relative path keeps the guard loadable from a /tmp repro.
import { isProcessAlive } from "../process-alive";

/**
 * A fixed path on purpose. `os.tmpdir()` reads TMPDIR, and `preload-test-tmpdir.ts` points
 * that at a FRESH directory in every isolate evaluation, so a tmpdir-based note would land
 * somewhere different for every test file and would dedupe nothing. Mode 0700 because /tmp
 * is world-writable: a squatted note can only cost a worker its watchdog, never more.
 *
 * Notes are left behind deliberately. Each is a few bytes, there is one per guarded process,
 * and /tmp is swept by the OS; deleting one would mean racing a live worker for no gain.
 */
// lint-rules-ignore: a fixed path is the point (see above); win32 returns before this is read
const NOTE_DIR = "/tmp/genesis-orphan-guard";

/**
 * 5s, not 1s. The condition this catches is a worker orphaned for hours (2026-09-08: 1d12h),
 * so five-second detection is just as useful and the shell plus its `sleep` wake a fifth as
 * often. The guard's own tests carry explicit timeouts because they now wait out one poll.
 */
const POLL_SECONDS = 5;

/**
 * One live watchdog per guarded pid, however many times this module is evaluated.
 *
 * Bun re-evaluates every `[test].preload` entry once per test FILE under `--isolate`, and no
 * JS-level flag survives that. Measured 2026-09-14 inside ONE worker pid across 201 files: a
 * module-scope `let`, a `globalThis` property and a `process.env` stamp each read back their
 * initial value on all 201 evaluations, and the env write never reached the real process
 * environment either (a spawned child saw the variable unset). Before this note file, one
 * worker held 97 polling shells and the count grew by one per test file.
 *
 * The note therefore lives on disk, and it records the watchdog's PID rather than a "done"
 * flag, because a flag is not enough: the shell spawned during a worker's FIRST test file is
 * reliably dead by its second (measured the same day: counts ran 1,1,2,3,…, one short of the
 * file number for exactly that reason). A once-only claim leaves such a worker unguarded for
 * the rest of the run, which is the failure this guard exists to prevent. Re-checking
 * liveness costs one `readFileSync` and one signal-0, and never a fork.
 *
 * `process.uptime()` IS process-wide (0.090 -> 23.502 over those same 201 evaluations), so
 * `now - uptime` names this process incarnation: all 201 derived the same second. Pairing that
 * second with the pid stops a recycled pid from reading a dead run's note.
 */
function noteFileFor(selfPid: number): string {
    const startSecond = Math.round((Date.now() - process.uptime() * 1000) / 1000);

    return `${NOTE_DIR}/${selfPid}-${startSecond}.pid`;
}

function recordedWatchdogPid(notePath: string): number {
    try {
        return Number.parseInt(readFileSync(notePath, "utf8").trim(), 10);
    } catch {
        // ENOENT is the ordinary first evaluation. Every other read failure is
        // indistinguishable from it here and means the same thing to the caller: this
        // process has no watchdog on record, so install one. There is no logger to report
        // it to, by the no-imports rule above.
        return 0;
    }
}

/** The marker `installOrphanWorkerGuard` puts on ITS OWN watchdog's command line. */
function watchdogMarker(selfPid: number): string {
    return `self=${selfPid}`;
}

/**
 * Whether `pid` is genuinely the watchdog `installOrphanWorkerGuard(selfPid)` started, not
 * merely a live process that reused its number.
 *
 * A pidfile that records only a number is unverifiable forever after — `pid-safety-guard.sh`
 * says exactly that, though its own regex does not catch this file (the variable here is
 * `notePath`, not `...pid...`). The watchdog's shell script embeds `self=<selfPid>` in its own
 * argv, so a recycled pid belonging to an unrelated program will not carry it, and the guard
 * installs a fresh watchdog instead of trusting a stranger. Never used to decide whom to
 * signal — only ever probed — so a `ps` failure degrades to "not verified, install anyway"
 * rather than to a thrown error.
 */
function isOurWatchdog(pid: number, selfPid: number): boolean {
    try {
        const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
        return command.includes(watchdogMarker(selfPid));
    } catch {
        return false;
    }
}

/**
 * Single-quote a value for `/bin/sh`.
 *
 * `SafeJSON` is the repo's rule everywhere else, but this file must stay importable by
 * isolate workers and `/tmp` repro scripts with no `@genesiscz/*` alias graph, and a bare
 * `JSON` is biome-restricted. The value here is a `ps` date string, so the only character
 * that can break out is a quote; the standard `'\''` dance covers it regardless.
 */
function shQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The process's start time, as `ps` reports it — the discriminator that separates "this pid"
 * from "a pid the kernel reissued to someone else".
 *
 * A liveness probe cannot do this: `kill -0` succeeds for whoever holds the number now. At
 * 400-800 pids/second the macOS pid space recycles in about three minutes, so liveness alone
 * is not identity. Returns null when `ps` cannot answer, and the caller then declines to
 * schedule a kill at all.
 */
function startedAt(pid: number): string | null {
    try {
        // Normalise whitespace the same way the shell side does. `ps -o lstart=` pads its
        // column, so a raw `$(ps ...)` in sh keeps leading spaces that `.trim()` here would
        // strip — the two strings then never match and the kill silently never fires. That
        // exact mismatch turned the guard's own SIGKILL test red, which is how it was caught.
        const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" })
            .replace(/\s+/g, " ")
            .trim();

        return started.length > 0 ? started : null;
    } catch {
        return null;
    }
}

/**
 * The poll interval is interpolated straight into `/bin/sh`, so it is a boundary.
 *
 * The script has no `set -e`, so a `sleep` that rejects its argument does not stop the loop: it
 * spins on `ps` and `awk` for the life of the worker. `sleep 0` is worse, because it succeeds and
 * spins just as fast. Both are the CPU burn this guard exists to prevent, so an unusable value
 * falls back to the default rather than being passed on.
 */
function pollInterval(seconds: number | undefined): number {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
        return POLL_SECONDS;
    }

    return seconds;
}

/**
 * The watchdog's `/bin/sh` program, as text.
 *
 * Exported so the identity checks can be tested directly. Driving them through
 * `installOrphanWorkerGuard` means orphaning a real parent, which a test can only do to
 * itself, so the two recycled-pid branches had no coverage while they were inline.
 *
 * @internal
 */
export function buildWatchdogScript(args: {
    parentPid: number;
    selfPid: number;
    selfStart: string;
    parentStart: string;
    /** Seconds between polls; defaults to POLL_SECONDS. See installOrphanWorkerGuard. */
    pollSeconds?: number;
}): string {
    return [
        `parent=${args.parentPid}`,
        `self=${args.selfPid}`,
        `selfstart=${shQuote(args.selfStart)}`,
        `parentstart=${shQuote(args.parentStart)}`,
        "while :; do",
        '  if ! kill -0 "$self"; then',
        "    exit 0",
        "  fi",
        // Identity, not liveness, on the PARENT too. `kill -0 "$parent"` proves only that the
        // NUMBER is occupied, so once the original parent exits and the kernel reissues its pid
        // — about three minutes at the 400-800 pids/second this guard exists for — the probe
        // keeps succeeding against a stranger and the watchdog waits forever for a parent that
        // died long ago. The worker it was installed to reap is then never reaped, which is the
        // precise failure this guard exists to prevent. An empty reading means the pid is gone
        // and subsumes `kill -0`; a different reading means it belongs to someone else. Both are
        // parent loss.
        `  pnow=$(ps -o lstart= -p "$parent" 2>/dev/null | awk '{$1=$1;print}')`,
        '  if [ -z "$pnow" ] || [ "$pnow" != "$parentstart" ]; then',
        // pid-verified: `ps -o lstart=` is re-read here and compared against the value
        // captured at install time, so a recycled pid fails the check and is spared.
        `    now=$(ps -o lstart= -p "$self" 2>/dev/null | awk '{$1=$1;print}')`,
        '    if [ -n "$now" ] && [ "$now" = "$selfstart" ]; then',
        '      kill -KILL "$self"',
        "    fi",
        "    exit 0",
        "  fi",
        `  sleep ${pollInterval(args.pollSeconds)}`,
        "done",
    ].join("\n");
}

function rememberWatchdog(notePath: string, watchdogPid: number): void {
    try {
        writeFileSync(notePath, String(watchdogPid), { mode: 0o600 });
    } catch {
        // An unwritable note only costs deduplication, never the guard itself: the next
        // evaluation reads nothing back and installs again, which is the old behaviour.
    }
}

/**
 * Bun isolate workers (`--test-worker --isolate`) are separate processes. The 5s
 * test timeout is enforced by the coordinator. If that parent dies (session killed,
 * gt-claude wrapper gone, PPID becomes 1), the timeout dies with it and a busy-loop
 * worker can spin at 100% CPU for days. Measured 2026-09-08: PID 59882, 1d12h, PPID 1.
 *
 * A JS timer cannot save that worker: a tight `for (;;)` never yields, so `setInterval`
 * never fires. macOS also has no `PR_SET_PDEATHSIG`. The guard is therefore a sibling
 * `/bin/sh` that `kill -0`s the original parent and `SIGKILL`s this pid when it is gone.
 *
 * `unref()` so the helper does not keep a finished worker's event loop alive. That
 * detaches the helper but does not end it, so the loop also watches the guarded pid
 * and exits with it — otherwise every finished worker in a long test run would leave
 * a polling shell behind, and the eventual kill could name a recycled pid.
 *
 * No `@genesiscz/*` imports: isolate workers and `/tmp` repro scripts must load this
 * file without the repo alias graph.
 */
export function installOrphanWorkerGuard(options?: {
    parentPid?: number;
    selfPid?: number;
    /**
     * Seconds the watchdog sleeps between checks. Tuning, not behaviour: the guard's own
     * tests must observe a real SIGKILL, and at the five-second default two of them waited
     * out a whole poll, which was 10.5 s of a 15.7 s file. A shorter interval runs the same
     * identity check more often rather than differently, so no test may assert on poll COUNT.
     */
    pollSeconds?: number;
}): void {
    if (process.env.GENESIS_TOOLS_TEST_ALLOW_ORPHAN_WORKERS === "1") {
        return;
    }

    if (process.platform === "win32") {
        return;
    }

    const parentPid = options?.parentPid ?? process.ppid;
    const selfPid = options?.selfPid ?? process.pid;

    if (!parentPid || parentPid <= 1) {
        return;
    }

    const notePath = noteFileFor(selfPid);
    const recordedPid = recordedWatchdogPid(notePath);
    if (isProcessAlive(recordedPid) && isOurWatchdog(recordedPid, selfPid)) {
        return;
    }

    try {
        mkdirSync(NOTE_DIR, { recursive: true, mode: 0o700 });
    } catch {
        // The note is a deduplicator, not the safety property: install anyway, which is
        // exactly the pre-2026-09-14 behaviour.
    }

    // `Bun.spawn` queues the fork on the event loop. A tight `for (;;)` after
    // install never ticks, so the helper would never start — the exact hang this
    // exists to stop. `child_process.spawn` forks before returning.
    // 🛑 The kill below is identity-verified, not just liveness-verified. `kill -0` proves
    // SOMETHING is alive at that number, never that it is still us. A `bun test --parallel`
    // failure mode on bun 1.3.13 burns 400-800 pids/second, which recycles the macOS pid
    // space in about three minutes, so a watchdog that outlived its worker and then fired on
    // a bare `kill -0` would SIGKILL whatever unrelated program inherited the number.
    //
    // `ps -o lstart=` is the standard discriminator: a recycled pid has a different start
    // time. It is captured HERE, at install, while the process is provably us, and compared
    // immediately before the signal. If `ps` fails or the strings differ, the loop exits
    // without signalling — refusing to kill is always safe, killing the wrong process is not.
    const selfStart = startedAt(selfPid);

    if (!selfStart) {
        // No identity to verify against, so there is no safe kill to schedule.
        return;
    }

    const parentStart = startedAt(parentPid);

    if (!parentStart) {
        // The parent is already gone, so there is no identity to compare against on any later
        // poll. Same rule as `selfStart` above: without a verifiable premise, schedule nothing.
        return;
    }

    const proc = spawn(
        "/bin/sh",
        ["-c", buildWatchdogScript({ parentPid, selfPid, selfStart, parentStart, pollSeconds: options?.pollSeconds })],
        {
            stdio: "ignore",
        }
    );

    proc.unref();

    if (proc.pid !== undefined) {
        rememberWatchdog(notePath, proc.pid);
    }
}
