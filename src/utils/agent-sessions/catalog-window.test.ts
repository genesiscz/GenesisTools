import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-16T20:00:00Z");

function session(root: string, id: string, ageMs: number): void {
    const file = join(root, `${id}.jsonl`);
    writeFileSync(
        file,
        `${SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/projects/fixture", timestamp: new Date(NOW - ageMs).toISOString(), message: { content: `session ${id}` } })}\n`
    );
    utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
}

test("a windowed catalog refreshes and returns the window plus the newest top-up, never the whole corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-catalog-window-"));
    const fresh = "11111111-2222-4333-8444-000000000001";
    const recent = "11111111-2222-4333-8444-000000000002";
    const old = "11111111-2222-4333-8444-000000000003";
    session(root, fresh, HOUR);
    session(root, recent, 2 * 24 * HOUR);
    session(root, old, 30 * 24 * HOUR);
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: claudeHistoryReader,
        now: () => new Date(NOW),
    });

    try {
        const windowed = await service.catalog({ mtimeFrom: NOW - 24 * HOUR });
        expect(windowed.metadata.map((entry) => entry.nativeId)).toEqual([fresh]);
        // Only the window was parsed: the corpus holds three sessions, one is inside the window.
        expect(windowed.report.parsed).toBe(1);

        const toppedUp = await service.catalog({ mtimeFrom: NOW - 24 * HOUR, newest: 2 });
        expect(toppedUp.metadata.map((entry) => entry.nativeId)).toEqual([fresh, recent]);
        expect(toppedUp.report.parsed).toBe(1);

        const everything = await service.catalog({});
        expect(everything.metadata.map((entry) => entry.nativeId).sort()).toEqual([fresh, recent, old].sort());
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
