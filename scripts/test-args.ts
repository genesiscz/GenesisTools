/**
 * Argument parsing for the `--profile` mode of `scripts/test.ts`, the stall-tripwire
 * ceiling, serial isolation and the phases of a full run, in their own module so they can be
 * tested: importing the runner would run the whole suite.
 *
 * No imports on purpose — the runner loads this before `node_modules` is known to be present.
 */

/**
 * The `bun test` argv with per-file isolation added to a serial run, so a serial run sees
 * the same module registry per file as `--parallel` (which implies `--isolate`). An explicit
 * `--isolate` or `--no-isolate` is left alone. Why and what it costs: the block comment above
 * `runBunTest` in `scripts/test.ts`.
 */
export function withSerialIsolation(testArgs: string[]): string[] {
    const decided = testArgs.some(
        (arg) => arg.startsWith("--parallel") || arg === "--isolate" || arg === "--no-isolate"
    );

    return decided ? testArgs : [...testArgs, "--isolate"];
}

/** One `bun test` process of a full (no explicit paths) run, in the order they run. */
export interface FullRunPhase {
    kind: "parallel" | "serial" | "own-process";
    /** The phase in the closing `[test] phase exits:` line: its kind, or the file it runs. */
    name: string;
    /** Printed before the phase starts; the parallel bulk prints nothing of its own. */
    banner?: string;
    testArgs: string[];
}

/**
 * The phases of a full run: the parallel bulk, then the load-sensitive files serially in one
 * process, then each own-process file in a `bun test` of its own. Every listed file is ignored
 * by the bulk, and an own-process file never shares a process with any other file. The later
 * phases drop `--parallel` (and `--parallel=N`) from the caller's argv; everything else carries.
 * Why each list exists: the block comments above `LOAD_SENSITIVE_FILES` and
 * `OWN_PROCESS_FILES` in `scripts/test.ts`.
 */
export function fullRunPhases(options: {
    args: string[];
    excludes: string[];
    loadSensitive: string[];
    ownProcess: string[];
    parallelTimeoutMs: number;
}): FullRunPhase[] {
    const { args, excludes, loadSensitive, ownProcess, parallelTimeoutMs } = options;
    const hasExplicitTimeout = args.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
    // `startsWith`, not equality: bun also accepts `--parallel=N`, and an exact match would let
    // that form through into the phases whose whole purpose is to keep these files apart.
    const serialArgs = args.filter((arg) => !arg.startsWith("--parallel"));
    const phases: FullRunPhase[] = [
        {
            kind: "parallel",
            name: "parallel",
            testArgs: [
                ...args,
                ...(hasExplicitTimeout ? [] : [`--timeout=${parallelTimeoutMs}`]),
                ...excludes.map((glob) => `--path-ignore-patterns=${glob}`),
                ...[...loadSensitive, ...ownProcess].map((file) => `--path-ignore-patterns=${file}`),
            ],
        },
    ];

    // An empty list must not become a `bun test` with no path, which would run the whole repo.
    if (loadSensitive.length > 0) {
        phases.push({
            kind: "serial",
            name: "serial",
            banner: `serial phase: ${loadSensitive.length} load-sensitive file(s)`,
            testArgs: [...serialArgs, ...loadSensitive],
        });
    }

    ownProcess.forEach((file, index) => {
        phases.push({
            kind: "own-process",
            name: file,
            banner: `own-process phase ${index + 1}/${ownProcess.length}: ${file}`,
            testArgs: [...serialArgs, file],
        });
    });

    return phases;
}

/** The exit code of a whole run: the first phase that failed, else 0. */
export function firstFailure(exits: number[]): number {
    return exits.find((code) => code !== 0) ?? 0;
}

/** Default wall-clock ceiling for one `bun test` process, in minutes. */
export const DEFAULT_MAX_MINUTES = 15;

/**
 * Wall-clock ceiling for one `bun test` process, in milliseconds.
 *
 * Unset, empty, or whitespace-only → default. `0` (or negative) → off. A non-number keeps
 * the default and warns. Trim first: `Number(" ")` is `0`, which would otherwise disable
 * the tripwire through an accidental CI env value.
 */
export function maxRunMs(raw: string | undefined, warn: (message: string) => void): number {
    const trimmed = raw?.trim() ?? "";

    if (trimmed === "") {
        return DEFAULT_MAX_MINUTES * 60_000;
    }

    const minutes = Number(trimmed);
    if (!Number.isFinite(minutes)) {
        warn(`GENESIS_TOOLS_TEST_MAX_MINUTES=${raw} is not a number — using ${DEFAULT_MAX_MINUTES}m`);
        return DEFAULT_MAX_MINUTES * 60_000;
    }

    if (minutes <= 0) {
        return 0;
    }

    return minutes * 60_000;
}

export function profileArgs(args: string[], defaultJobs: number): { jobs: number; roots: string[] } {
    const jobsIndex = args.indexOf("--jobs");
    // `Number(undefined)` is NaN and `Number("0")` is 0; both reach
    // `Array.from({ length: Math.min(jobs, files.length) })`, which is EMPTY for either, so a
    // mistyped `--jobs` profiled nothing and still exited 0 with "0 file(s) failed".
    const requested = jobsIndex === -1 ? Number.NaN : Math.floor(Number(args[jobsIndex + 1]));
    const jobs = Number.isFinite(requested) && requested >= 1 ? requested : defaultJobs;
    // Without the `-1` guard the excluded index is 0 whenever `--jobs` is absent, so
    // `bun scripts/test.ts src/du --profile` lost its only path and profiled the whole repo.
    const jobsValueIndex = jobsIndex === -1 ? -1 : jobsIndex + 1;

    return { jobs, roots: args.filter((arg, index) => !arg.startsWith("-") && index !== jobsValueIndex) };
}
