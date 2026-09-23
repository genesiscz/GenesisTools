import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** The file the watchdog rewrites on every poll, next to the note that names it. */
function beatPathFor(notePath: string): string {
    return `${notePath}.beat`;
}

/**
 * Whether the recorded watchdog is still ours and still running, WITHOUT starting a process.
 *
 * 🛑 This check runs once per test FILE, and it must not fork. A child that exits while an
 * `--isolate` worker switches files is never reaped, and the worker then spins at 100% CPU
 * instead of starting the next file (measured 2026-09-23 on bun 1.4.2: 2 stalls in 10 runs
 * while this check still ran `ps`, 0 in 20 with the guard off). The old identity probe was a
 * `ps -o command=` per file, so it was itself one of the children that caused the hang.
 *
 * Identity now comes from a heartbeat instead of argv. Only the watchdog (and the installer,
 * once, at launch) writes `<note>.beat`, inside the 0700 note directory, so a fresh beat means
 * the recorded pid was our watchdog within the last few polls. A pid the kernel reissued to a
 * stranger stops beating, so after at most three polls the guard installs a fresh watchdog
 * rather than trusting it. Liveness is a signal-0, which starts no process.
 */
function isLiveWatchdog(notePath: string, pid: number, pollSeconds: number): boolean {
    if (!isProcessAlive(pid)) {
        return false;
    }

    try {
        return Date.now() - statSync(beatPathFor(notePath)).mtimeMs < pollSeconds * 3000;
    } catch {
        // No beat on disk: the note was not written by an install that also launched a loop.
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
    /** Heartbeat file rewritten on every poll; see isLiveWatchdog. Omitted in the script tests. */
    beatPath?: string;
}): string {
    return [
        `parent=${args.parentPid}`,
        `self=${args.selfPid}`,
        `selfstart=${shQuote(args.selfStart)}`,
        `parentstart=${shQuote(args.parentStart)}`,
        "while :; do",
        ...(args.beatPath ? [`  : > ${shQuote(args.beatPath)}`] : []),
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
        // The first beat comes from here, not from the loop: the next file can install within
        // milliseconds, before the backgrounded shell has run its first line.
        writeFileSync(beatPathFor(notePath), "", { mode: 0o600 });
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
 * The helper is launched detached (see `launchDetached`), so it never keeps a finished
 * worker's event loop alive and is never the worker's child. It does not end by itself, so
 * the loop also watches the guarded pid and exits with it — otherwise every finished worker
 * in a long test run would leave a polling shell behind, and the eventual kill could name a
 * recycled pid.
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
    const pollSeconds = pollInterval(options?.pollSeconds);
    if (isLiveWatchdog(notePath, recordedWatchdogPid(notePath), pollSeconds)) {
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

    const script = buildWatchdogScript({
        parentPid,
        selfPid,
        selfStart,
        parentStart,
        pollSeconds,
        beatPath: beatPathFor(notePath),
    });
    const watchdogPid = launchDetached(script);

    if (watchdogPid !== null) {
        rememberWatchdog(notePath, watchdogPid);
    }
}

/**
 * Start the watchdog so that it is NOT a child of this worker, and return its pid.
 *
 * 🛑 A direct child hangs the test run. Under `--isolate` the watchdog of an earlier test file
 * dies while the worker is between files, the worker never reaps it, and the worker then spins
 * at 100% CPU before it starts the next file. Measured 2026-09-23 on bun 1.4.2 with a 329-file
 * run: 5 stalls in 8 runs, every stalled worker holding `<defunct>` children, and 0 stalls in 20
 * runs with the guard disabled. Detaching the loop alone cut it to 2 in 10; removing the per-file
 * `ps` probe as well (see isLiveWatchdog) brought it to 0 in 12. The old note that the first
 * file's watchdog "is reliably dead by its second" fits the same picture, though what ended
 * those shells was never measured directly.
 *
 * So an intermediate `/bin/sh` backgrounds the loop and exits at once. `execFileSync` waits for
 * and reaps that intermediate before it returns, and the loop is reparented to launchd, so the
 * worker owns no long-lived child at all. The loop keeps `self=<pid>` in its argv (a
 * backgrounded subshell is a fork of the same `sh -c`), so pgrep and the tests still find it.
 * `execFileSync` also forks before it returns, which a tight `for (;;)` after install needs.
 */
function launchDetached(script: string): number | null {
    try {
        const out = execFileSync("/bin/sh", ["-c", `(\n${script}\n) </dev/null >/dev/null 2>&1 &\necho $!`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const pid = Number.parseInt(out.trim(), 10);

        return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
        // No shell, or it refused to fork: the worker runs unguarded, which is the state a
        // failed install always meant. There is no logger here, by the no-imports rule above.
        return null;
    }
}
