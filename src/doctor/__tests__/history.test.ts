import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendHistory, readHistorySince, writeAnalysisLog } from "@app/doctor/lib/history";
import { analysisDirFor, HISTORY_FILE } from "@app/doctor/lib/paths";
import type { ActionResult, AnalyzerResult } from "@app/doctor/lib/types";

let originalHistory: string | null;
let runId: string;

beforeEach(() => {
    originalHistory = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, "utf8") : null;
    runId = `doctor-history-test-${crypto.randomUUID()}`;
});

afterEach(() => {
    if (originalHistory === null) {
        rmSync(HISTORY_FILE, { force: true });
    } else {
        writeFileSync(HISTORY_FILE, originalHistory, "utf8");
    }

    rmSync(analysisDirFor(runId), { recursive: true, force: true });
});

describe("history", () => {
    it("appendHistory then readHistorySince returns the entry", async () => {
        const res: ActionResult = {
            findingId: "f1",
            actionId: "delete",
            status: "ok",
            actualReclaimedBytes: 1024,
        };
        await appendHistory(runId, res);
        const entries = await readHistorySince(new Date(Date.now() - 60_000));
        expect(entries).toHaveLength(1);
        expect(entries[0]?.action.findingId).toBe("f1");
    });

    it("readHistorySince filters by timestamp", async () => {
        await appendHistory(runId, {
            findingId: "f-old",
            actionId: "delete",
            status: "ok",
        });

        const entries = await readHistorySince(new Date(Date.now() + 60_000));
        expect(entries).toHaveLength(0);
    });

    it("writeAnalysisLog creates per-analyzer file", async () => {
        const result: AnalyzerResult = {
            analyzerId: "disk-space",
            findings: [],
            durationMs: 42,
            error: null,
            fromCache: false,
            timestamp: new Date().toISOString(),
        };
        await writeAnalysisLog(runId, "disk-space", result);
        expect(existsSync(`${analysisDirFor(runId)}/disk-space.json`)).toBe(true);
    });
});
