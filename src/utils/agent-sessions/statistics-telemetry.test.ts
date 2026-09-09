import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { grokHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistoryStatisticsRepository } from "./statistics-repository";
import { synchronizeHistory } from "./sync";
import { HistorySyncRepository } from "./sync-repository";
import type { NativeSessionReader } from "./types";

const PROVIDER = "xai-sub";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const REWRITTEN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function line(value: object): string {
    return `${SafeJSON.stringify(value, { strict: true })}\n`;
}

function update(eventId: string): string {
    return line({
        timestamp: 1_788_333_200,
        params: {
            sessionId: SESSION_ID,
            update: {
                sessionUpdate: "turn_completed",
                usage: { inputTokens: 30, cachedReadTokens: 10, outputTokens: 5 },
            },
            _meta: { eventId, agentTimestampMs: Date.parse("2026-09-03T10:00:00.000Z") },
        },
    });
}

function fixture() {
    const home = mkdtempSync(join(tmpdir(), "history-grok-telemetry-"));
    const root = join(home, "sessions");
    const directory = join(root, encodeURIComponent("/invented/grok"), SESSION_ID);
    const chat = join(directory, "chat_history.jsonl");
    const summary = join(directory, "summary.json");
    const updates = join(directory, "updates.jsonl");
    mkdirSync(directory, { recursive: true });
    writeFileSync(chat, line({ type: "user", timestamp: "2026-09-01T10:00:00.000Z", content: "telemetry needle" }));
    writeFileSync(
        summary,
        SafeJSON.stringify(
            { info: { id: SESSION_ID, cwd: "/invented/grok" }, current_model_id: "grok-4.6" },
            { strict: true }
        )
    );
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const reader: NativeSessionReader<string> = { ...grokHistoryReader, roots: () => [root] };
    const repository = new HistorySyncRepository(db);
    const service = new HistoryService({
        providerId: PROVIDER,
        reader,
        repository,
        statistics: new HistoryStatisticsRepository(db),
        roots: [root],
    });
    return { db, repository, root, service, summary, updates, reader };
}

test("Grok telemetry freshness refreshes statistics without reparsing chat metadata and preserves rows through identity rewrite", async () => {
    const fixtureOwner = fixture();
    try {
        const first = await fixtureOwner.service.refreshStatistics();
        expect(first).toMatchObject({ parsed: 1, unchanged: 0, coverage: "complete", issues: [] });
        expect(
            fixtureOwner.db
                .query("SELECT token_usage FROM daily_stats WHERE provider=? AND project='__all__'")
                .all(PROVIDER)
        ).toEqual([{ token_usage: null }]);
        const sourceBefore = fixtureOwner.repository.sources(PROVIDER)[0]!;
        writeFileSync(fixtureOwner.updates, update("evt-1"));
        const metadataOnly = await synchronizeHistory({
            providerId: PROVIDER,
            reader: fixtureOwner.reader,
            repository: fixtureOwner.repository,
            roots: [fixtureOwner.root],
        });
        expect(metadataOnly.report).toMatchObject({ parsed: 0, unchanged: 1 });
        const telemetry = await fixtureOwner.service.refreshStatistics();
        expect(telemetry).toMatchObject({ parsed: 1, unchanged: 0, coverage: "complete", issues: [] });
        expect(
            fixtureOwner.db
                .query<{ token_usage: string | null }, [string]>("SELECT token_usage FROM daily_stats WHERE provider=?")
                .all(PROVIDER)
                .some((row) => row.token_usage !== null)
        ).toBe(true);
        const unchanged = await fixtureOwner.service.refreshStatistics();
        expect(unchanged).toMatchObject({ parsed: 0, unchanged: 1, coverage: "complete" });

        const totalsBeforePartial = fixtureOwner.db
            .query("SELECT total_messages FROM totals_cache WHERE provider=? AND scope='__all__'")
            .get(PROVIDER);
        writeFileSync(fixtureOwner.updates, `${update("evt-1")}{"broken":`);
        const partial = await fixtureOwner.service.refreshStatistics();
        expect(partial).toMatchObject({ parsed: 0, coverage: "partial" });
        expect(
            fixtureOwner.db
                .query("SELECT total_messages FROM totals_cache WHERE provider=? AND scope='__all__'")
                .get(PROVIDER)
        ).toEqual(totalsBeforePartial);

        writeFileSync(
            fixtureOwner.summary,
            SafeJSON.stringify(
                { info: { id: REWRITTEN_ID, cwd: "/invented/grok" }, current_model_id: "grok-4.6" },
                { strict: true }
            )
        );
        await synchronizeHistory({
            providerId: PROVIDER,
            reader: fixtureOwner.reader,
            repository: fixtureOwner.repository,
            roots: [fixtureOwner.root],
        });
        const sourceAfter = fixtureOwner.repository.sources(PROVIDER)[0]!;
        expect(sourceAfter.sourceKey).not.toBe(sourceBefore.sourceKey);
        expect(
            fixtureOwner.db
                .query("SELECT count(*) AS count FROM file_daily_stats WHERE source_key=?")
                .get(sourceBefore.sourceKey)
        ).toEqual({ count: 0 });
        expect(
            fixtureOwner.db
                .query("SELECT count(*) AS count FROM file_daily_stats WHERE source_key=?")
                .get(sourceAfter.sourceKey)
        ).toEqual({ count: 2 });
    } finally {
        fixtureOwner.db.close();
    }
});
