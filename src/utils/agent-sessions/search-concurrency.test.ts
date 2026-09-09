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

test("time-ordered source search overlaps reads without scanning past available result slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "history-search-concurrency-"));
    const ids = Array.from({ length: 12 }, (_, index) => `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`);
    for (const [index, id] of ids.entries()) {
        const file = join(root, `${id}.jsonl`);
        writeFileSync(
            file,
            `${SafeJSON.stringify({ type: "user", sessionId: id, cwd: "/projects/fixture", timestamp: "2026-09-01T00:00:00Z", message: { content: "fixture body" } })}\n`
        );
        utimesSync(file, new Date(1_700_000_000_000 + index * 1000), new Date(1_700_000_000_000 + index * 1000));
    }
    let active = 0;
    let maximum = 0;
    let started = 0;
    const scan = claudeHistoryReader.scan!;
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const service = new HistoryService({
        providerId: "anthropic-sub",
        roots: [root],
        repository: new HistorySyncRepository(database),
        reader: {
            ...claudeHistoryReader,
            async *scan(source, options) {
                active++;
                started++;
                maximum = Math.max(maximum, active);
                try {
                    await Bun.sleep(2);
                    yield* scan(
                        {
                            ...source,
                            kind: "claude",
                            metadata: source.metadata ? { ...source.metadata, kind: "claude" } : undefined,
                        },
                        options
                    );
                } finally {
                    active--;
                }
            },
        },
    });
    try {
        const result = await service.search({ query: "fixture", limit: 5 });
        expect(result.results.map((row) => row.session.sessionId)).toEqual(ids.slice(-5).reverse());
        expect(maximum).toBeGreaterThan(1);
        expect(maximum).toBeLessThanOrEqual(5);
        expect(started).toBe(5);
        expect(active).toBe(0);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
