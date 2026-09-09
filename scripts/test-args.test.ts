import { expect, test } from "bun:test";
import { profileArgs } from "./test-args";

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
