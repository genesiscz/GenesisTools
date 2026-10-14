import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStallSnapshot } from "@genesiscz/utils/bun/worker-stall";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    analyzeWorkerLog,
    describeStallThreads,
    parseWorkerLog,
    parseWorkerStalls,
    type WorkerLogLine,
    type WorkerStallLine,
} from "./test-worker-log";

const line = (event: "start" | "end", at: string, file: string, pids: number[], pid = 100): WorkerLogLine => ({
    event,
    at,
    worker: "1",
    pid,
    file,
    children: pids.map((child) => ({ pid: child, ppid: pid, command: `child ${child}` })),
});

describe("test worker log", () => {
    test("names the file that left a process, and the later file that started with it", () => {
        const report = analyzeWorkerLog([
            line("start", "2026-10-09T01:00:00Z", "a.test.ts", []),
            line("end", "2026-10-09T01:00:01Z", "a.test.ts", [7]),
            line("start", "2026-10-09T01:00:02Z", "b.test.ts", [7]),
            line("end", "2026-10-09T01:00:03Z", "b.test.ts", [7]),
        ]);

        expect(report.leftovers.map((item) => item.file)).toEqual(["a.test.ts"]);
        expect(report.inherited).toHaveLength(1);
        expect(report.inherited[0]?.file).toBe("b.test.ts");
        expect(report.inherited[0]?.processes[0]?.leftBy).toBe("a.test.ts");
    });

    test("keeps workers apart and skips a line it cannot read", () => {
        const text = [
            SafeJSON.stringify(line("start", "2026-10-09T01:00:00Z", "a.test.ts", [], 100)),
            SafeJSON.stringify(line("end", "2026-10-09T01:00:01Z", "a.test.ts", [9], 100)),
            SafeJSON.stringify(line("start", "2026-10-09T01:00:02Z", "c.test.ts", [], 200)),
            "{ cut off",
        ].join("\n");
        const report = analyzeWorkerLog(parseWorkerLog(text));

        expect(report.leftovers).toHaveLength(1);
        expect(report.inherited).toHaveLength(0);
    });
});

describe("stalled tests", () => {
    test("a /proc snapshot names each thread's state and wait, and each child with its state and command", () => {
        const proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
        const task = (tid: number, stat: string, wchan: string, children = "") => {
            const dir = join(proc, "100", "task", String(tid));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "stat"), stat);
            writeFileSync(join(dir, "wchan"), wchan);
            writeFileSync(join(dir, "children"), children);
        };
        // A thread name may hold spaces and parentheses; the state follows the LAST ")".
        task(100, "100 (bun (main) x) D 1 100", "wait_log_commit", "201 202 ");
        task(101, "101 (Pool) S 1 100", "futex_wait");
        mkdirSync(join(proc, "201"));
        writeFileSync(join(proc, "201", "stat"), "201 (git) Z 100");
        writeFileSync(join(proc, "201", "cmdline"), "git\0rev-parse\0--git-dir\0");

        const snapshot = readStallSnapshot(100, proc);

        expect(snapshot.threads).toEqual([
            { tid: 100, name: "bun (main) x", state: "D", wchan: "wait_log_commit" },
            { tid: 101, name: "Pool", state: "S", wchan: "futex_wait" },
        ]);
        // 202 has no /proc entry any more (it ended between the reads): it is listed with an unknown state.
        expect(snapshot.children).toEqual([
            { pid: 201, state: "Z", command: "git rev-parse --git-dir" },
            { pid: 202, state: "?", command: "" },
        ]);
        expect(readStallSnapshot(999, proc)).toEqual({ threads: [], children: [] });
    });

    test("stall lines parse apart from start and end lines, and the thread summary names the waits", () => {
        const stall: WorkerStallLine = {
            event: "stall",
            at: "2026-10-14T20:53:08Z",
            worker: "3",
            pid: 100,
            file: "a.test.ts",
            ms: 15_002,
            threads: [
                { tid: 100, name: "bun", state: "D", wchan: "wait_log_commit" },
                { tid: 101, name: "Pool", state: "S", wchan: "futex_wait" },
                { tid: 102, name: "Pool", state: "S", wchan: "futex_wait" },
            ],
            children: [{ pid: 201, state: "Z", command: "git rev-parse --git-dir" }],
        };
        const text = [
            SafeJSON.stringify(line("start", "2026-10-14T20:52:50Z", "a.test.ts", [])),
            SafeJSON.stringify(stall),
        ].join("\n");

        expect(parseWorkerLog(text)).toHaveLength(1);
        expect(parseWorkerStalls(text)).toEqual([stall]);
        expect(describeStallThreads(stall.threads)).toBe("D 1, S 2 (wait_log_commit)");
    });
});
