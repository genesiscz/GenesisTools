/**
 * Argument parsing for the `--profile` mode of `scripts/test.ts`, in its own module so it can be
 * tested: importing the runner would run the whole suite.
 *
 * No imports on purpose — the runner loads this before `node_modules` is known to be present.
 */
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
