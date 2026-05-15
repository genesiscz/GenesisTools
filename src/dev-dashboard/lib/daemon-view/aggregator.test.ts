import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { getRunLog } from "./aggregator";

const tmpDir = mkdtempSync(join(tmpdir(), "daemon-view-test-"));
const logFile = join(tmpDir, "run.jsonl");

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("getRunLog", () => {
    test("round-trips a meta/stdout/exit jsonl log", () => {
        const lines = [
            SafeJSON.stringify({
                type: "meta",
                taskName: "demo",
                command: "echo hi",
                runId: "r1",
                attempt: 1,
                startedAt: "2026-05-15T10:00:00.000Z",
            }),
            SafeJSON.stringify({
                type: "stdout",
                ts: "2026-05-15T10:00:00.100Z",
                data: "hi",
            }),
            SafeJSON.stringify({
                type: "exit",
                ts: "2026-05-15T10:00:00.200Z",
                code: 0,
                duration_ms: 12,
            }),
        ];
        writeFileSync(logFile, `${lines.join("\n")}\n`);

        const entries = getRunLog(logFile);

        expect(entries).toHaveLength(3);
        expect(entries[0]?.type).toBe("meta");
        expect(entries[1]?.type).toBe("stdout");
        expect(entries[2]?.type).toBe("exit");

        const meta = entries[0];
        if (meta?.type === "meta") {
            expect(meta.taskName).toBe("demo");
            expect(meta.runId).toBe("r1");
        }

        const out = entries[1];
        if (out?.type === "stdout") {
            expect(out.data).toBe("hi");
        }

        const exit = entries[2];
        if (exit?.type === "exit") {
            expect(exit.code).toBe(0);
            expect(exit.duration_ms).toBe(12);
        }
    });
});
