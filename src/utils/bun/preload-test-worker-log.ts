import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { appendFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readStallSnapshot } from "@genesiscz/utils/bun/worker-stall";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { collectProcessTree, listPsTable, PS_COLUMNS_SPEC } from "@genesiscz/utils/process/ps";

/**
 * Opt-in test-worker log: which `bun test --parallel` worker ran which file, and which child processes
 * that worker had alive when the file started and when it ended.
 *
 * Why: on CI a file that spawns nothing timed out with "killed 7 dangling processes" at its start
 * (src/question/lib/record.test.ts, 2026-10-08). A worker runs many files in turn, so those processes
 * came from an EARLIER file in the same worker, and the CI log groups output by file, not by worker.
 * This log names the file that left them. Read it with `bun scripts/test-worker-log.ts`.
 *
 * Off unless `GENESIS_TOOLS_TEST_WORKER_LOG` is set: `1` writes `test-worker-log.jsonl` in the checkout,
 * any other value is the file path. It costs one `ps` per file start and end, so it stays off by default.
 *
 * Every test file runs isolated (scripts/test.ts), so this preload, and its hooks, run once per file.
 * It sits BEFORE preload-test-tmpdir.ts in bunfig.toml: the path is resolved while the real temp folder
 * and the real cwd are still in place.
 *
 * A test still running after {@link STALL_MS} also gets a `stall` line: what the worker's threads wait on and
 * which children it has, from `/proc`, with no spawn. On CI (2026-10-14) one worker's tests hung at 20 s,
 * each with 5 to 14 "killed 1 dangling process" lines, while the other workers ran normally; the start and
 * end lines cannot show what that worker was waiting on.
 */
const STALL_MS = 15_000;
const setting = env.test.getWorkerLog();

if (setting) {
    const path = setting === "1" ? join(process.cwd(), "test-worker-log.jsonl") : setting;
    const logPath = isAbsolute(path) ? path : join(process.cwd(), path);
    const file = Bun.main;
    const worker = env.test.getWorkerId() ?? "serial";

    const record = async (event: "start" | "end") => {
        let children: Array<{ pid: number; ppid: number; command: string }> = [];

        try {
            const rows = await listPsTable({ timeoutMs: 5_000 });
            const tree = new Set(collectProcessTree(process.pid, rows));
            children = rows
                // The `ps` taking this very measurement is a child too; it is not a leftover.
                .filter((row) => row.pid !== process.pid && tree.has(row.pid) && !row.command.includes(PS_COLUMNS_SPEC))
                .map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command.slice(0, 200) }));
        } catch (error) {
            children = [{ pid: -1, ppid: -1, command: `ps failed: ${String(error).slice(0, 160)}` }];
        }

        const line = { event, at: new Date().toISOString(), worker, pid: process.pid, file, children };
        appendFileSync(logPath, `${SafeJSON.stringify(line, { strict: true })}\n`);
    };

    // A queue, not one variable: tests of a file can run concurrently, and each afterEach clears one timer.
    const stallTimers: Array<ReturnType<typeof setTimeout>> = [];

    beforeAll(() => record("start"));
    afterAll(() => record("end"));
    beforeEach(() => {
        const startedAt = Date.now();
        const stallTimer = setTimeout(() => {
            const line = {
                event: "stall",
                at: new Date().toISOString(),
                worker,
                pid: process.pid,
                file,
                ms: Date.now() - startedAt,
                ...readStallSnapshot(process.pid),
            };
            appendFileSync(logPath, `${SafeJSON.stringify(line, { strict: true })}\n`);
        }, STALL_MS);
        stallTimer.unref?.();
        stallTimers.push(stallTimer);
    });
    afterEach(() => clearTimeout(stallTimers.shift()));
}
