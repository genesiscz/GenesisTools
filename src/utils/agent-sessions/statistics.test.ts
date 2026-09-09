import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { HistoryCacheRepository } from "./cache-repository";
import { claudeHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistoryStatisticsRepository } from "./statistics-repository";
import { HistorySyncRepository } from "./sync-repository";
import type { NativeSessionReader } from "./types";

const PROVIDER = "anthropic-sub";
const FIRST_ID = "11111111-2222-4333-8444-555555555555";
const SECOND_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function rows(id: string, dates: string[]): string {
    return `${dates
        .map((timestamp, index) =>
            SafeJSON.stringify(
                {
                    type: index % 2 === 0 ? "user" : "assistant",
                    sessionId: id,
                    cwd: "/invented/statistics",
                    timestamp,
                    gitBranch: "fixture-main",
                    message:
                        index % 2 === 0
                            ? { role: "user", content: `statistics needle ${index}` }
                            : {
                                  role: "assistant",
                                  content: [{ type: "text", text: `statistics answer ${index}` }],
                                  usage: { input_tokens: 2, output_tokens: 1 },
                              },
                },
                { strict: true }
            )
        )
        .join("\n")}\n`;
}

function fixture() {
    const home = mkdtempSync(join(tmpdir(), "history-statistics-service-"));
    const root = join(home, "projects");
    const project = join(root, "-invented-statistics");
    const firstPath = join(project, `${FIRST_ID}.jsonl`);
    const secondPath = join(project, `${SECOND_ID}.jsonl`);
    mkdirSync(project, { recursive: true });
    writeFileSync(firstPath, rows(FIRST_ID, ["2026-09-01T10:00:00.000Z"]));
    writeFileSync(secondPath, rows(SECOND_ID, ["2026-09-01T11:00:00.000Z"]));
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const reader: NativeSessionReader<string> = { ...claudeHistoryReader, roots: () => [root] };
    const service = new HistoryService({
        providerId: PROVIDER,
        reader,
        repository: new HistorySyncRepository(db),
        statistics: new HistoryStatisticsRepository(db),
        roots: [root],
        now: () => new Date("2026-09-08T00:00:00.000Z"),
    });
    return { db, firstPath, reader, root, secondPath, service };
}

function totals(db: Database) {
    return db
        .query("SELECT total_conversations,total_messages FROM totals_cache WHERE provider=? AND scope='__all__'")
        .get(PROVIDER);
}

test("ordinary search leaves statistics empty while explicit refresh builds and skips identical Claude sources", async () => {
    const fixtureOwner = fixture();
    try {
        await fixtureOwner.service.search({ query: "statistics needle" });
        expect(
            fixtureOwner.db.query("SELECT count(*) AS count FROM file_daily_stats WHERE provider=?").get(PROVIDER)
        ).toEqual({ count: 0 });
        const first = await fixtureOwner.service.refreshStatistics();
        const second = await fixtureOwner.service.refreshStatistics();

        expect(first).toMatchObject({
            parsed: 2,
            unchanged: 0,
            sources: 2,
            completeSources: 2,
            coverage: "complete",
            issues: [],
        });
        expect(second).toMatchObject({
            parsed: 0,
            unchanged: 2,
            sources: 2,
            completeSources: 2,
            coverage: "complete",
            issues: [],
        });
        expect(totals(fixtureOwner.db)).toEqual({ total_conversations: 2, total_messages: 2 });
    } finally {
        fixtureOwner.db.close();
    }
});

test("statistics refresh replaces changed dates and retains published values for a partial Claude source", async () => {
    const fixtureOwner = fixture();
    try {
        await fixtureOwner.service.refreshStatistics();
        writeFileSync(fixtureOwner.firstPath, rows(FIRST_ID, ["2026-09-01T10:00:00.000Z", "2026-09-02T10:00:00.000Z"]));
        const appended = await fixtureOwner.service.refreshStatistics();
        expect(appended).toMatchObject({ parsed: 1, unchanged: 1, coverage: "complete" });
        expect(
            fixtureOwner.db
                .query("SELECT date,messages FROM daily_stats WHERE provider=? AND project='__all__' ORDER BY date")
                .all(PROVIDER)
        ).toEqual([
            { date: "2026-09-01", messages: 2 },
            { date: "2026-09-02", messages: 1 },
        ]);

        writeFileSync(fixtureOwner.firstPath, rows(FIRST_ID, ["2026-09-03T10:00:00.000Z"]));
        const truncated = await fixtureOwner.service.refreshStatistics();
        expect(truncated).toMatchObject({ parsed: 1, unchanged: 1, coverage: "complete" });
        expect(
            fixtureOwner.db
                .query("SELECT date,messages FROM daily_stats WHERE provider=? AND project='__all__' ORDER BY date")
                .all(PROVIDER)
        ).toEqual([
            { date: "2026-09-01", messages: 1 },
            { date: "2026-09-03", messages: 1 },
        ]);
        const beforePartial = totals(fixtureOwner.db);
        const original = fixtureOwner.reader.readStatistics!;
        fixtureOwner.reader.readStatistics = async (source, options) => ({
            ...(await original(source, options)),
            complete: false,
        });
        const partial = await fixtureOwner.service.refreshStatistics({ force: true });
        expect(partial).toMatchObject({ parsed: 0, coverage: "partial" });
        expect(totals(fixtureOwner.db)).toEqual(beforePartial);
    } finally {
        fixtureOwner.db.close();
    }
});

test("removing one Claude source republishs only remaining statistics contributions", async () => {
    const fixtureOwner = fixture();
    try {
        await fixtureOwner.service.refreshStatistics();
        unlinkSync(fixtureOwner.secondPath);
        const discoveryReader = fixtureOwner.reader;
        const originalDiscover = discoveryReader.discover;
        discoveryReader.discover = async (roots, options) => {
            const discovered = await originalDiscover(roots, options);
            return {
                ...discovered,
                sources: discovered.sources.filter((source) => source.filePath !== fixtureOwner.secondPath),
            };
        };
        const removed = await fixtureOwner.service.refreshStatistics();

        expect(removed).toMatchObject({ sources: 1, completeSources: 1, coverage: "complete" });
        expect(totals(fixtureOwner.db)).toEqual({ total_conversations: 1, total_messages: 1 });
    } finally {
        fixtureOwner.db.close();
    }
});

test("the indexed message count is absent until the statistics pass runs, then real", async () => {
    // The dashboard listing reads this through `getFileIndex`, because a query-less listing never
    // hydrates messages to count them. `getFileIndex` filters `statistics_status != 'unavailable'`,
    // so it yields nothing on a cold index and for a source whose statistics never completed. That
    // is a legitimate zero, not the bug it replaced, and pinning the difference here stops a future
    // reader from "re-fixing" it.
    const fixtureOwner = fixture();
    const cache = new HistoryCacheRepository(fixtureOwner.db, PROVIDER);

    try {
        // The metadata sync writes the row with statistics_status 'unavailable' and mtime -1, so
        // the row EXISTS and `getFileIndex` still refuses it. That is the case that matters: it is
        // indistinguishable from "no session" unless the difference is pinned.
        await fixtureOwner.service.sync();

        expect(
            fixtureOwner.db
                .query("SELECT statistics_status FROM file_index WHERE provider=?")
                .all(PROVIDER)
                .map((row) => (row as { statistics_status: string }).statistics_status)
        ).toEqual(["unavailable", "unavailable"]);
        expect(cache.getFileIndex(fixtureOwner.firstPath)).toBeNull();

        await fixtureOwner.service.refreshStatistics();
        const indexed = cache.getFileIndex(fixtureOwner.firstPath);

        expect(indexed).not.toBeNull();
        expect(indexed?.messageCount).toBeGreaterThan(0);
    } finally {
        fixtureOwner.db.close();
    }
});
