import { describe, expect, test } from "bun:test";
import { descendantsFromTable, reap, type Worker } from "./test-reap";

/** A `ps -Ao pid=,ppid=,lstart=` table, in the exact shape the real command emits. */
const TABLE = [
    "    1     0 Mon Sep 22 09:00:00 2026",
    "  100     1 Mon Sep 22 09:01:00 2026",
    "  200   100 Mon Sep 22 09:02:00 2026",
    "  201   100 Mon Sep 22 09:02:01 2026",
    "  300   200 Mon Sep 22 09:03:00 2026",
    "  999     1 Mon Sep 22 09:04:00 2026",
    "",
].join("\n");

describe("descendantsFromTable", () => {
    test("collects children, grandchildren and nobody else", () => {
        const found = descendantsFromTable(TABLE, 100);

        expect(found.map((w) => w.pid).sort((a, b) => a - b)).toEqual([200, 201, 300]);
        expect(found.find((w) => w.pid === 300)?.start).toBe("Mon Sep 22 09:03:00 2026");
    });

    test("an unrelated subtree is never swept", () => {
        expect(descendantsFromTable(TABLE, 999)).toEqual([]);
    });

    test("normalises the start time, because ps pads its columns", () => {
        const padded = "  100     1   Mon Sep 22   09:01:00   2026\n  200   100 Mon Sep 22 09:02:00 2026\n";

        expect(descendantsFromTable(padded, 100)[0]?.start).toBe("Mon Sep 22 09:02:00 2026");
    });

    test("a malformed line is skipped rather than throwing", () => {
        const damaged = "garbage\n  200   100 Mon Sep 22 09:02:00 2026\n\n   \n";

        expect(descendantsFromTable(damaged, 100).map((w) => w.pid)).toEqual([200]);
    });

    test("a ppid cycle terminates instead of looping forever", () => {
        // The kernel does not produce this, but a truncated or corrupted table can, and this
        // walk runs precisely when something is already wrong.
        const cyclic = "  200   100 a\n  100   200 b\n";

        expect(descendantsFromTable(cyclic, 100).map((w) => w.pid)).toEqual([200]);
    });

    test("an empty table yields nothing", () => {
        expect(descendantsFromTable("", 100)).toEqual([]);
    });
});

describe("reap", () => {
    const workers: Worker[] = [
        { pid: 200, start: "start-200" },
        { pid: 201, start: "start-201" },
    ];

    test("kills only the processes whose identity still matches", () => {
        const signalled: number[] = [];
        // 201 was reissued to a different process between the snapshot and now.
        const probe = (pid: number) => (pid === 200 ? "start-200" : "a-stranger");

        const killed = reap(workers, { probe, kill: (pid) => void signalled.push(pid) });

        expect(signalled).toEqual([200]);
        expect(killed).toBe(1);
    });

    test("a pid that ps can no longer answer for is spared", () => {
        const signalled: number[] = [];

        const killed = reap(workers, { probe: () => null, kill: (pid) => void signalled.push(pid) });

        expect(signalled).toEqual([]);
        expect(killed).toBe(0);
    });

    test("the normal case still kills — the negative control", () => {
        const signalled: Array<[number, string]> = [];

        const killed = reap(workers, {
            probe: (pid) => `start-${pid}`,
            kill: (pid, signal) => void signalled.push([pid, signal]),
        });

        expect(signalled).toEqual([
            [200, "SIGKILL"],
            [201, "SIGKILL"],
        ]);
        expect(killed).toBe(2);
    });

    test("a worker that exits between the check and the signal is not counted", () => {
        const killed = reap(workers, {
            probe: (pid) => `start-${pid}`,
            kill: (pid) => {
                if (pid === 201) {
                    throw new Error("ESRCH");
                }
            },
        });

        expect(killed).toBe(1);
    });

    test("an empty worker list signals nothing", () => {
        let calls = 0;

        expect(reap([], { probe: () => null, kill: () => void calls++ })).toBe(0);
        expect(calls).toBe(0);
    });
});
