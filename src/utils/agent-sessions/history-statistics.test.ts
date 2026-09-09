import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historySourceKey } from "./identity";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryRepository } from "./repository";
import { HistoryStatisticsRepository } from "./statistics-repository";
import { HistorySyncRepository } from "./sync-repository";
import type { HistoryStatisticsRead } from "./types";

const PROVIDER = "fixture-provider";

function statistics(options: { days: HistoryStatisticsRead["days"]; complete?: boolean }): HistoryStatisticsRead {
    const messages = options.days.reduce((total, day) => total + day.messages, 0);
    return {
        complete: options.complete ?? true,
        issues: [],
        summary: {
            conversations: options.days.reduce((total, day) => total + day.conversations, 0),
            messages,
            subagentSessions: options.days.reduce((total, day) => total + day.subagentSessions, 0),
            toolCounts: {},
            dailyActivity: {},
            hourlyActivity: {},
            tokenUsage: null,
            modelCounts: {},
            branchCounts: {},
            firstDate: options.days[0]?.date ?? null,
            lastDate: options.days.at(-1)?.date ?? null,
        },
        days: options.days,
    };
}

function day(
    date: string,
    messages: number,
    tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreateTokens: number;
        cacheReadTokens: number;
    } | null = {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
    }
) {
    return {
        date,
        project: "fixture",
        conversations: 1,
        messages,
        subagentSessions: 0,
        toolCounts: { Read: messages },
        hourlyActivity: { "10": messages },
        tokenUsage,
        modelCounts: { fixture: messages },
        branchCounts: { main: messages },
    };
}

function seed(options: { db: Database; providerId?: string; nativeId: string; generation?: number }) {
    const providerId = options.providerId ?? PROVIDER;
    const repository = new HistoryRepository(options.db);
    const sourceHome = realpathSync(mkdtempSync(join(tmpdir(), "history-stat-source-")));
    const sourceKey = historySourceKey({ providerId, sourceHome, nativeId: options.nativeId });
    const filePath = `/invented/history/${options.nativeId}.jsonl`;
    expect(
        repository.replaceMetadata({
            metadata: {
                providerId,
                sourceKey,
                sourceHome,
                nativeId: options.nativeId,
                root: sourceHome,
                filePath,
                sessionId: options.nativeId,
                customTitle: `${options.nativeId} title`,
                summary: null,
                firstPrompt: "Invented statistics prompt",
                allUserText: "Invented statistics prompt",
                gitBranch: "main",
                project: "fixture",
                cwd: "/invented/project",
                mtime: 1,
                firstTimestamp: "2026-09-01T10:00:00.000Z",
                isSubagent: false,
                archived: false,
                resumeMode: "native",
                boundedFields: [],
            },
            revision: "metadata-r1",
            parserVersion: "fixture-v1",
            generation: options.generation ?? 1,
            expected: null,
        })
    ).toBe(true);
    return repository.getSource(sourceKey)!;
}

function replace(options: {
    repository: HistoryStatisticsRepository;
    expected: ReturnType<typeof seed>;
    statistics: HistoryStatisticsRead;
    revision?: string;
    verifyRevision?: () => boolean;
}) {
    return options.repository.replace({
        expected: options.expected,
        revision: options.revision ?? "metadata-r1",
        parserVersion: "fixture-stats-v1",
        statistics: options.statistics,
        sourceMtime: 2,
        verifyRevision: options.verifyRevision ?? (() => true),
    });
}

test("statistics replacement prevents double-adds and publication removes obsolete multi-day rollups", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const source = seed({ db, nativeId: "first" });
    const statisticsRepository = new HistoryStatisticsRepository(db);
    try {
        expect(
            replace({
                repository: statisticsRepository,
                expected: source,
                statistics: statistics({ days: [day("2026-09-01", 2), day("2026-09-02", 3)] }),
            })
        ).toBe(true);
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [source.sourceKey],
            })
        ).toBe("complete");
        expect(
            db
                .query("SELECT date,project,messages,coverage FROM daily_stats WHERE provider=? ORDER BY date,project")
                .all(PROVIDER)
        ).toEqual([
            { date: "2026-09-01", project: "__all__", messages: 2, coverage: "complete" },
            { date: "2026-09-01", project: "fixture", messages: 2, coverage: "complete" },
            { date: "2026-09-02", project: "__all__", messages: 3, coverage: "complete" },
            { date: "2026-09-02", project: "fixture", messages: 3, coverage: "complete" },
        ]);

        expect(
            replace({
                repository: statisticsRepository,
                expected: source,
                statistics: statistics({ days: [day("2026-09-02", 7)] }),
            })
        ).toBe(true);
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [source.sourceKey],
            })
        ).toBe("complete");
        expect(db.query("SELECT date,messages FROM daily_stats WHERE provider=? ORDER BY date").all(PROVIDER)).toEqual([
            { date: "2026-09-02", messages: 7 },
            { date: "2026-09-02", messages: 7 },
        ]);
    } finally {
        db.close();
    }
});

test("statistics publication preserves incomplete legacy rollups, provider isolation, and null token metrics", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const first = seed({ db, nativeId: "first" });
    const other = seed({ db, providerId: "other-provider", nativeId: "other" });
    const statisticsRepository = new HistoryStatisticsRepository(db);
    try {
        db.query(
            "INSERT INTO daily_stats(provider,date,project,conversations,messages,computed_at,coverage) VALUES (?,?,?,?,?,?,?)"
        ).run(PROVIDER, "2026-08-31", "__all__", 9, 99, "old", "legacy");
        expect(
            replace({
                repository: statisticsRepository,
                expected: first,
                statistics: statistics({ days: [day("2026-09-01", 4, null)] }),
            })
        ).toBe(true);
        expect(
            replace({
                repository: statisticsRepository,
                expected: other,
                statistics: statistics({ days: [day("2026-09-01", 8)] }),
            })
        ).toBe(true);
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: false,
                expectedSourceKeys: [first.sourceKey],
            })
        ).toBe("refused");
        expect(
            db.query("SELECT messages,coverage FROM daily_stats WHERE provider=? AND date='2026-08-31'").get(PROVIDER)
        ).toEqual({ messages: 99, coverage: "stale" });
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [first.sourceKey],
            })
        ).toBe("complete");
        expect(
            db.query("SELECT token_usage FROM daily_stats WHERE provider=? AND date='2026-09-01'").all(PROVIDER)
        ).toEqual([{ token_usage: null }, { token_usage: null }]);
        expect(
            db.query("SELECT messages FROM daily_stats WHERE provider=? AND date='2026-09-01'").all("other-provider")
        ).toEqual([]);
    } finally {
        db.close();
    }
});

test("statistics reject stale revisions and publish remaining source keys after sync removal without touching observations", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const first = seed({ db, nativeId: "first" });
    const second = seed({ db, nativeId: "second" });
    const statisticsRepository = new HistoryStatisticsRepository(db);
    const syncRepository = new HistorySyncRepository(db);
    try {
        db.exec(
            "CREATE TABLE usage_fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO usage_fixture VALUES(1,'kept')"
        );
        expect(
            replace({
                repository: statisticsRepository,
                expected: first,
                statistics: statistics({ days: [day("2026-09-01", 2)] }),
                verifyRevision: () => false,
            })
        ).toBe(false);
        expect(
            replace({
                repository: statisticsRepository,
                expected: first,
                revision: "wrong-revision",
                statistics: statistics({ days: [day("2026-09-01", 2)] }),
            })
        ).toBe(false);
        expect(
            replace({
                repository: statisticsRepository,
                expected: first,
                statistics: statistics({ days: [day("2026-09-01", 2)] }),
            })
        ).toBe(true);
        expect(
            replace({
                repository: statisticsRepository,
                expected: second,
                statistics: statistics({ days: [day("2026-09-01", 5)] }),
            })
        ).toBe(true);
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [first.sourceKey, second.sourceKey],
            })
        ).toBe("complete");
        syncRepository.remove(second);
        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [first.sourceKey],
            })
        ).toBe("complete");
        expect(
            db
                .query(
                    "SELECT total_conversations,total_messages FROM totals_cache WHERE provider=? AND scope='__all__'"
                )
                .get(PROVIDER)
        ).toEqual({ total_conversations: 1, total_messages: 2 });
        expect(db.query("SELECT value FROM usage_fixture WHERE id=1").get()).toEqual({ value: "kept" });
    } finally {
        db.close();
    }
});

test("publication writes the sources that completed and labels the rollup partial", () => {
    // One source whose metadata revision had moved used to refuse the rollup for every other
    // source. On the real corpus that left file_daily_stats at 12,918 rows with daily_stats and
    // totals_cache at zero, so the dashboard read "0 conversations" — and because any live
    // session keeps one source moving, the condition never cleared on its own.
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const done = seed({ db, nativeId: "done" });
    const moving = seed({ db, nativeId: "moving" });
    const statisticsRepository = new HistoryStatisticsRepository(db);

    try {
        expect(
            replace({
                repository: statisticsRepository,
                expected: done,
                statistics: statistics({ days: [day("2026-09-01", 5)] }),
            })
        ).toBe(true);
        // `moving` never completed its statistics pass, so it has no contribution rows.
        db.query("UPDATE file_index SET metadata_revision='moved' WHERE source_key=?").run(moving.sourceKey);

        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [done.sourceKey, moving.sourceKey],
            })
        ).toBe("partial");

        expect(
            db
                .query("SELECT date,project,messages,coverage FROM daily_stats WHERE provider=? ORDER BY project")
                .all(PROVIDER)
        ).toEqual([
            { date: "2026-09-01", project: "__all__", messages: 5, coverage: "partial" },
            { date: "2026-09-01", project: "fixture", messages: 5, coverage: "partial" },
        ]);
        expect(db.query("SELECT total_messages,coverage FROM totals_cache WHERE provider=?").get(PROVIDER)).toEqual({
            total_messages: 5,
            coverage: "partial",
        });
    } finally {
        db.close();
    }
});

test("publication still refuses when nothing at all completed", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const moving = seed({ db, nativeId: "moving" });
    const statisticsRepository = new HistoryStatisticsRepository(db);

    try {
        db.query("UPDATE file_index SET metadata_revision='moved' WHERE source_key=?").run(moving.sourceKey);

        expect(
            statisticsRepository.publish({
                providerId: PROVIDER,
                discoveryComplete: true,
                expectedSourceKeys: [moving.sourceKey],
            })
        ).toBe("refused");
        expect(db.query("SELECT count(*) AS n FROM daily_stats WHERE provider=?").get(PROVIDER)).toEqual({ n: 0 });
    } finally {
        db.close();
    }
});
