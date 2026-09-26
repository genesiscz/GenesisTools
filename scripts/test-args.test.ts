import { expect, test } from "bun:test";
import { DEFAULT_MAX_MINUTES, maxRunMs, profileArgs, withSerialIsolation } from "./test-args";

test("a serial run gets per-file isolation, like a parallel one", () => {
    expect(withSerialIsolation(["src/cmux"])).toEqual(["src/cmux", "--isolate"]);
    expect(withSerialIsolation([])).toEqual(["--isolate"]);
});

test("a parallel run, or an explicit isolation choice, is left alone", () => {
    expect(withSerialIsolation(["--parallel", "src/cmux"])).toEqual(["--parallel", "src/cmux"]);
    expect(withSerialIsolation(["--parallel=4"])).toEqual(["--parallel=4"]);
    expect(withSerialIsolation(["src/cmux", "--isolate"])).toEqual(["src/cmux", "--isolate"]);
    expect(withSerialIsolation(["src/cmux", "--no-isolate"])).toEqual(["src/cmux", "--no-isolate"]);
});

test("a leading path survives --profile without --jobs", () => {
    // The documented shape `bun scripts/test.ts <paths> --profile`: index 0 is the path, and
    // `args.indexOf("--jobs")` is -1, which used to exclude exactly that index.
    expect(profileArgs(["src/du", "--profile"], 8)).toEqual({ jobs: 8, roots: ["src/du"] });
    expect(profileArgs(["src/du", "src/port", "--profile"], 4)).toEqual({
        jobs: 4,
        roots: ["src/du", "src/port"],
    });
});

test("--jobs consumes only its own value", () => {
    expect(profileArgs(["--jobs", "3", "src/du", "--profile"], 8)).toEqual({ jobs: 3, roots: ["src/du"] });
    expect(profileArgs(["src/du", "--jobs", "3", "--profile"], 8)).toEqual({ jobs: 3, roots: ["src/du"] });
});

test("no positional path leaves the roots empty for the caller's own default", () => {
    expect(profileArgs(["--profile"], 8)).toEqual({ jobs: 8, roots: [] });
    expect(profileArgs(["--profile", "--jobs", "2"], 8)).toEqual({ jobs: 2, roots: [] });
});

test("a --jobs value that is not a positive count falls back to the default", () => {
    // `Array.from({ length: Math.min(NaN, files.length) })` is EMPTY, so a bad `--jobs`
    // profiled zero files and reported "0 file(s) failed" with exit 0 — a silent green.
    expect(profileArgs(["--profile", "--jobs"], 8)).toEqual({ jobs: 8, roots: [] });
    expect(profileArgs(["--profile", "--jobs", "abc"], 8)).toEqual({ jobs: 8, roots: [] });
    expect(profileArgs(["--profile", "--jobs", "0"], 8)).toEqual({ jobs: 8, roots: [] });
    expect(profileArgs(["--profile", "--jobs", "-2"], 8)).toEqual({ jobs: 8, roots: [] });
});

test("a fractional --jobs value is floored, never zero", () => {
    expect(profileArgs(["--profile", "--jobs", "2.7"], 8)).toEqual({ jobs: 2, roots: [] });
});

test("whitespace-only GENESIS_TOOLS_TEST_MAX_MINUTES keeps the default tripwire", () => {
    // `Number(" ")` is 0, which used to take the disable-the-tripwire branch.
    const warnings: string[] = [];
    const warn = (message: string) => {
        warnings.push(message);
    };

    expect(maxRunMs(" ", warn)).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(maxRunMs("\t\n", warn)).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(maxRunMs("", warn)).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(maxRunMs(undefined, warn)).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(warnings).toEqual([]);
});

test("a non-numeric GENESIS_TOOLS_TEST_MAX_MINUTES falls back to the default, not off", () => {
    const warnings: string[] = [];
    expect(maxRunMs("fifteen", (message) => warnings.push(message))).toBe(DEFAULT_MAX_MINUTES * 60_000);
    expect(warnings).toEqual([
        `GENESIS_TOOLS_TEST_MAX_MINUTES=fifteen is not a number — using ${DEFAULT_MAX_MINUTES}m`,
    ]);
});

test("0 disables the tripwire, a positive count is minutes in ms", () => {
    const warn = () => {};
    expect(maxRunMs("0", warn)).toBe(0);
    expect(maxRunMs("  0  ", warn)).toBe(0);
    expect(maxRunMs("2", warn)).toBe(120_000);
    expect(maxRunMs("  3  ", warn)).toBe(180_000);
});
