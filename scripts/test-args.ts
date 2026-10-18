/**
 * Argument parsing for the `--profile` mode of `scripts/test.ts`, the stall-tripwire
 * ceiling, serial isolation and the phases of a full run, in their own module so they can be
 * tested: importing the runner would run the whole suite.
 *
 * No imports on purpose — the runner loads this before `node_modules` is known to be present.
 */

/**
 * Excludes that hold even for an explicit path argument.
 *
 * An explicit path is an opt-in, so it deliberately bypasses `EXCLUDES` — that is how you
 * run the dev-dashboard tree on purpose. But a `*.spec.ts` can never be a bun test in this
 * repo, so collecting one is always a mistake rather than a choice: bun errors with
 * "Playwright Test needs to be invoked via 'npx playwright test'" or an undefined
 * `this.skip`, and that reads as a suite failure for a file that is green under its own
 * runner. Verified 2026-09-15: 39 `*.spec.ts` files, NONE importing `bun:test`.
 *
 * Declared once and spread into `DEFAULT_EXCLUDES` below, so the default run and the
 * explicit-path run can never disagree about it.
 */
export const ALWAYS_EXCLUDES = [
    "**/*.spec.ts",
    // Same reasoning as `*.spec.ts`, one directory further: every test under
    // DevDashboard/cloud/web is a vitest file, and its own `test` script runs
    // `vitest run` for exactly that reason. The tree loads `better-sqlite3`, a
    // native Node addon bun cannot dlopen ("'better-sqlite3' is not yet supported
    // in Bun", ERR_DLOPEN_FAILED), so bun collecting one is always a mistake and
    // never a choice. Verified 2026-09-16: 6 test files under
    // DevDashboard/cloud/web/src, all 6 import `vitest`, NONE imports `bun:test`;
    // they contributed 13 phantom failures to a local full run. Only `cloud/web`
    // is excluded: `cloud/shared` holds real bun tests, which `bun test ../shared`
    // runs from that package.
    "**/DevDashboard/cloud/web/**",
];

/**
 * Excluded from every full run unless targeted explicitly. These lived only in
 * package.json's `test` script for a long time, which meant a direct
 * `bun scripts/test.ts` (agents do this constantly) silently INCLUDED them —
 * and the e2e suites among them spawn real servers: every such run leaked two
 * orphaned dev-dashboard agents, dozens accumulated over days. The wrapper is
 * the single entrypoint, so the excludes live here.
 */
export const DEFAULT_EXCLUDES = [
    "**/dashboard/**",
    "**/dev-dashboard/**",
    "**/claude-history-dashboard/**",
    "**/Internal/**",
    "**/shops/**",
    "**/task/tests/**",
    "**/*.e2e.test.ts",
    "**/matrix-e2e.test.ts",
    // Playwright and WDIO own `*.spec.ts`; bun's discovery does not. Collecting one errors
    // with "Playwright Test needs to be invoked via 'npx playwright test'" or an undefined
    // `this.skip`, which reads as a suite failure and is green under its own runner. The
    // `**/dev-dashboard/**` and `**/dashboard/**` excludes already hide most of them, but
    // an explicit path argument bypasses those, so passing `src/dev-dashboard/` collected 4.
    // Verified 2026-09-15: all 39 `*.spec.ts` files in the repo belong to Playwright or
    // WDIO and NONE imports `bun:test` (checked with a positive control on two real bun
    // tests, because the first attempt at that check was itself broken and returned 0 for
    // both).
    ...ALWAYS_EXCLUDES,
];

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
    // `--parallel 4` carries its count in the next argument: left behind, bun reads `4` as a test filter.
    const serialArgs = args.filter(
        (arg, index) => !arg.startsWith("--parallel") && !(args[index - 1] === "--parallel" && /^\d+$/.test(arg))
    );
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

    if (phases.length === 1) {
        return phases;
    }

    return phases.map((phase, index) => ({
        ...phase,
        testArgs: withPhaseOutputs(phase.testArgs, `${index}-${phase.kind}`),
    }));
}

/**
 * The argv with every per-process output file moved into a folder of its own phase. Each phase is
 * a separate `bun test`, and each one writes `lcov.info` and the reporter outfile from scratch, so
 * without this the last phase (one own-process file) overwrites the coverage of the whole bulk.
 * `--coverage` with no `--coverage-dir` gets bun's default `coverage` folder, split the same way.
 */
export function withPhaseOutputs(testArgs: string[], slug: string): string[] {
    const result: string[] = [];
    let hasCoverageDir = false;

    for (let i = 0; i < testArgs.length; i++) {
        const arg = testArgs[i];

        if (arg === "--coverage-dir" || arg === "--reporter-outfile") {
            const value = testArgs[i + 1] ?? "";
            result.push(`${arg}=${phaseOutput(arg, value, slug)}`);
            hasCoverageDir ||= arg === "--coverage-dir";
            i++;
            continue;
        }

        const match = /^(--coverage-dir|--reporter-outfile)=(.*)$/.exec(arg);

        if (match) {
            result.push(`${match[1]}=${phaseOutput(match[1], match[2], slug)}`);
            hasCoverageDir ||= match[1] === "--coverage-dir";
            continue;
        }

        result.push(arg);
    }

    if (!hasCoverageDir && testArgs.includes("--coverage")) {
        result.push(`--coverage-dir=coverage/${slug}`);
    }

    return result;
}

function phaseOutput(flag: string, value: string, slug: string): string {
    if (flag === "--coverage-dir") {
        return `${value.replace(/\/+$/, "")}/${slug}`;
    }

    const dot = value.lastIndexOf(".");
    const slash = value.lastIndexOf("/");

    return dot > slash ? `${value.slice(0, dot)}.${slug}${value.slice(dot)}` : `${value}.${slug}`;
}

/** `bun test` flags whose value may come as the NEXT argument (`--timeout 9000`), plus the wrapper's `--jobs`. */
const VALUE_FLAGS = new Set([
    "--timeout",
    "--rerun-each",
    "--retry",
    "--seed",
    "--coverage-reporter",
    "--coverage-dir",
    "-t",
    "--test-name-pattern",
    "--reporter",
    "--reporter-outfile",
    "--max-concurrency",
    "--path-ignore-patterns",
    "--parallel-delay",
    "--shard",
    "--timings",
    "--preload",
    "--jobs",
]);

/** Flags whose value is optional and numeric: `--parallel 4` takes it, `--parallel src/cmux` does not. */
const NUMERIC_OPTIONAL_FLAGS = new Set(["--parallel", "--bail"]);

/**
 * The test paths in the wrapper's argv: every argument that is not a flag and not a flag's value. A bare
 * `!arg.startsWith("-")` read the `r.xml` of `--reporter-outfile r.xml` as a path, so a full run took the
 * explicit-path branch and never split its outputs per phase.
 */
export function explicitPathArgs(args: string[]): string[] {
    const paths: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith("-")) {
            const next = args[i + 1];
            const takesNext =
                !arg.includes("=") &&
                next !== undefined &&
                !next.startsWith("-") &&
                (VALUE_FLAGS.has(arg) || (NUMERIC_OPTIONAL_FLAGS.has(arg) && /^\d+$/.test(next)));

            if (takesNext) {
                i++;
            }

            continue;
        }

        paths.push(arg);
    }

    return paths;
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
