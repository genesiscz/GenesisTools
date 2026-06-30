import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { listRunsForTask } from "./log-reader";

const baseDir = mkdtempSync(join(tmpdir(), "log-reader-test-"));
const taskName = "poll";
const taskDir = join(baseDir, taskName);
mkdirSync(taskDir, { recursive: true });

// 50 ISO-timestamped run files (newest = highest minute).
for (let i = 0; i < 50; i++) {
    const stamp = `2026-05-15T10-${String(i).padStart(2, "0")}-00`;
    const lines = [
        SafeJSON.stringify({
            type: "meta",
            runId: `r${i}`,
            attempt: 1,
            startedAt: `2026-05-15T10:${String(i).padStart(2, "0")}:00.000Z`,
        }),
        SafeJSON.stringify({ type: "exit", code: 0, duration_ms: i }),
    ];
    writeFileSync(join(taskDir, `${stamp}-r${i}.jsonl`), `${lines.join("\n")}\n`);
}

afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
});

describe("listRunsForTask malformed-log handling", () => {
    test("logs at warn level when a run-log file fails to parse, instead of silently skipping it", () => {
        const warnSpy = mock(() => {});
        const original = logger.warn;
        logger.warn = warnSpy;

        try {
            const corruptDir = mkdtempSync(join(tmpdir(), "log-reader-corrupt-"));
            const taskDir = join(corruptDir, "test-task");
            mkdirSync(taskDir, { recursive: true });
            writeFileSync(join(taskDir, "corrupt.jsonl"), "{not valid json");

            const runs = listRunsForTask(corruptDir, "test-task", 5);

            expect(runs).toEqual([]);
            expect(warnSpy).toHaveBeenCalled();
            rmSync(corruptDir, { recursive: true, force: true });
        } finally {
            logger.warn = original;
        }
    });
});

describe("listRunsForTask limit", () => {
    test("limited result equals the newest-N of the full result (no quality loss)", () => {
        const all = listRunsForTask(baseDir, taskName);
        const limited = listRunsForTask(baseDir, taskName, 10);

        expect(all).toHaveLength(50);
        expect(limited).toHaveLength(10);
        expect(limited).toEqual(all.slice(0, 10));
    });

    test("results are newest-first", () => {
        const limited = listRunsForTask(baseDir, taskName, 5);

        expect(limited[0].runId).toBe("r49");
        expect(limited[4].runId).toBe("r45");
    });

    test("limit larger than file count returns everything", () => {
        expect(listRunsForTask(baseDir, taskName, 999)).toHaveLength(50);
    });
});
