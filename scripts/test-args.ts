/**
 * Argument parsing for the `--profile` mode of `scripts/test.ts`, and the stall-tripwire
 * ceiling, in their own module so they can be tested: importing the runner would run the
 * whole suite.
 *
 * No imports on purpose — the runner loads this before `node_modules` is known to be present.
 */

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
