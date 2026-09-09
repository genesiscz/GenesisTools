/**
 * Argument parsing for the `--profile` mode of `scripts/test.ts`, in its own module so it can be
 * tested: importing the runner would run the whole suite.
 *
 * No imports on purpose — the runner loads this before `node_modules` is known to be present.
 */
export function profileArgs(args: string[], defaultJobs: number): { jobs: number; roots: string[] } {
    const jobsIndex = args.indexOf("--jobs");
    const jobs = jobsIndex !== -1 ? Number(args[jobsIndex + 1]) : defaultJobs;
    // Without the `-1` guard the excluded index is 0 whenever `--jobs` is absent, so
    // `bun scripts/test.ts src/du --profile` lost its only path and profiled the whole repo.
    const jobsValueIndex = jobsIndex === -1 ? -1 : jobsIndex + 1;

    return { jobs, roots: args.filter((arg, index) => !arg.startsWith("-") && index !== jobsValueIndex) };
}
