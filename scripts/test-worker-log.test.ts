import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { analyzeWorkerLog, parseWorkerLog, type WorkerLogLine } from "./test-worker-log";

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
