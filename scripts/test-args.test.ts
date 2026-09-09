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
