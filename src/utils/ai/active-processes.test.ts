import { describe, expect, test } from "bun:test";
import { parseLsofCwd, parsePsLine } from "./active-processes";

/**
 * The `ps` and `lsof` readers behind `tools <agent> who`. A row that half-parses is worse than
 * one that is skipped: it becomes a table line with a wrong pid or a wrong directory, and
 * `who` is what a person consults before killing something.
 */

describe("parsePsLine", () => {
    test("reads the pid, tty, start time and argv out of one BSD ps row", () => {
        const row = parsePsLine(
            "  4242   111 s045  Wed Aug 26 18:13:02 2026   0:03.21 /opt/homebrew/bin/codex --remote x"
        );

        expect(row).toMatchObject({ pid: 4242, ppid: 111, tty: "s045", cpuTime: "0:03.21" });
        expect(row?.args).toBe("/opt/homebrew/bin/codex --remote x");
        expect(new Date(row?.startedAt ?? 0).getFullYear()).toBe(2026);
    });

    test("a header line or a truncated row is skipped, never half-parsed", () => {
        expect(parsePsLine("  PID  PPID TTY  STARTED  TIME COMMAND")).toBeNull();
        expect(parsePsLine("")).toBeNull();
    });
});

describe("parseLsofCwd", () => {
    test("pairs each pid with the directory that follows it", () => {
        expect([...parseLsofCwd("p4242\nn/repo\np99\nn/tmp/work\n").entries()]).toEqual([
            [4242, "/repo"],
            [99, "/tmp/work"],
        ]);
    });

    test("a name with no pid before it is dropped rather than attributed to another process", () => {
        const paths = parseLsofCwd("n/orphan\np7\nn/kept");

        expect(paths.get(7)).toBe("/kept");
        expect(paths.size).toBe(1);
    });
});
