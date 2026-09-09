import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { SafeJSON } from "@genesiscz/utils/json";
import { aggregateDailyStats, HistoryCacheRepository } from "./cache-repository";
import type { DailyStats, SessionMetadataRecord } from "./cache-types";
import { historySourceKey, unresolvedHistorySourceKey } from "./identity";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryRepository } from "./repository";

const CLAUDE = "anthropic-sub";
const CODEX = "openai-sub";

function metadata(filePath: string, sessionId: string): SessionMetadataRecord {
    return {
        filePath,
        sessionId,
        customTitle: `Title ${sessionId}`,
        summary: `Summary ${sessionId}`,
        firstPrompt: `Prompt ${sessionId}`,
        gitBranch: "main",
        project: "shop",
        cwd: "/projects/shop",
        mtime: 123,
        firstTimestamp: "2026-09-01T10:00:00.000Z",
        isSubagent: false,
        allUserText: `Text ${sessionId}`,
    };
}

function daily(model: string, messages: number): DailyStats {
    return {
        date: "2026-09-01",
        project: "__all__",
        conversations: 2,
        messages,
        subagentSessions: 1,
        toolCounts: { Read: messages },
        hourlyActivity: { "10": messages },
        tokenUsage: {
            inputTokens: messages * 10,
            outputTokens: messages * 2,
            cacheCreateTokens: messages,
            cacheReadTokens: messages * 3,
        },
        modelCounts: { [model]: messages },
        branchCounts: { main: messages },
    };
}

test("provider-scoped cache reads exclude other providers and metadata-only file rows", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const claude = new HistoryCacheRepository(db, CLAUDE);
    const codex = new HistoryCacheRepository(db, CODEX);

    claude.upsertDailyStats(daily("claude", 4));
    codex.upsertDailyStats(daily("codex", 9));
    claude.updateCachedTotals({
        totalConversations: 2,
        totalMessages: 4,
        totalSubagents: 1,
        projectCount: 1,
    });
    codex.updateCachedTotals({
        totalConversations: 3,
        totalMessages: 9,
        totalSubagents: 0,
        projectCount: 2,
    });
    claude.upsertSessionMetadata(metadata("/tmp/claude.jsonl", "claude-session"));
    codex.upsertSessionMetadata(metadata("/tmp/codex.jsonl", "codex-session"));
    claude.upsertFileIndex({
        filePath: "/tmp/claude.jsonl",
        mtime: 123,
        messageCount: 4,
        firstDate: "2026-09-01",
        lastDate: "2026-09-01",
        project: "shop",
        isSubagent: false,
        lastIndexed: "2026-09-01T11:00:00.000Z",
    });
    codex.upsertFileIndex({
        filePath: "/tmp/codex.jsonl",
        mtime: 456,
        messageCount: 9,
        firstDate: "2026-09-01",
        lastDate: "2026-09-01",
        project: "other",
        isSubagent: false,
        lastIndexed: "2026-09-01T12:00:00.000Z",
    });
    claude.upsertFileIndex({
        filePath: "/tmp/claude-archive.jsonl",
        mtime: 321,
        messageCount: 6,
        firstDate: "2026-08-01",
        lastDate: "2026-08-02",
        project: "archive",
        isSubagent: false,
        lastIndexed: "2026-08-02T12:00:00.000Z",
    });

    expect(claude.getDailyStats("2026-09-01")?.messages).toBe(4);
    expect(codex.getDailyStats("2026-09-01")?.messages).toBe(9);
    expect(claude.getCachedTotals()?.totalMessages).toBe(4);
    expect(codex.getCachedTotals()?.totalMessages).toBe(9);
    expect(claude.getAllSessionMetadata().map((row) => row.sessionId)).toEqual(["claude-session"]);
    expect(codex.getAllSessionMetadata().map((row) => row.sessionId)).toEqual(["codex-session"]);
    expect(claude.getAllFileIndexes().map((row) => row.filePath)).toEqual([
        "/tmp/claude-archive.jsonl",
        "/tmp/claude.jsonl",
    ]);
    expect(codex.getAllFileIndexes().map((row) => row.filePath)).toEqual(["/tmp/codex.jsonl"]);

    const sourceHome = realpathSync(mkdtempSync(join(tmpdir(), "cache-metadata-only-")));
    const filePath = join(sourceHome, "metadata-only.jsonl");
    const sourceKey = historySourceKey({ providerId: CLAUDE, nativeId: "metadata-only", sourceHome });
    const canonical = new HistoryRepository(db);
    expect(
        canonical.replaceMetadata({
            metadata: {
                ...metadata(filePath, "metadata-only"),
                providerId: CLAUDE,
                sourceKey,
                sourceHome,
                nativeId: "metadata-only",
                root: sourceHome,
                archived: false,
                resumeMode: "native",
                boundedFields: [],
            },
            revision: "metadata-r1",
            parserVersion: "reader-v1",
            generation: 7,
            expected: null,
        })
    ).toBe(true);
    expect(claude.getFileIndex(filePath)).toBeNull();
    db.query("UPDATE file_index SET message_count = 99 WHERE source_key = ?").run(sourceKey);

    expect(claude.getFileIndexProjectCounts()).toEqual({ archive: 1, shop: 1 });
    expect(
        claude.getFileIndexProjectCounts({
            from: "2026-09-01",
            to: "2026-09-30",
        })
    ).toEqual({ shop: 1 });
    expect(claude.getFileIndexConversationLengths()).toEqual([4, 6]);
    expect(codex.getFileIndexProjectCounts()).toEqual({ other: 1 });
    expect(codex.getFileIndexConversationLengths()).toEqual([9]);
    db.close();
});

test("legacy upserts preserve resolved identity, freshness, and unknown columns", () => {
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    db.exec("ALTER TABLE session_metadata ADD COLUMN local_note TEXT DEFAULT 'metadata-kept'");
    db.exec("ALTER TABLE file_index ADD COLUMN local_flag TEXT DEFAULT 'file-kept'");
    const sourceHome = realpathSync(mkdtempSync(join(tmpdir(), "cache-resolved-")));
    const filePath = join(sourceHome, "resolved.jsonl");
    const sourceKey = historySourceKey({ providerId: CLAUDE, nativeId: "resolved-id", sourceHome });
    const canonical = new HistoryRepository(db);
    expect(
        canonical.replaceMetadata({
            metadata: {
                ...metadata(filePath, "public-id"),
                providerId: CLAUDE,
                sourceKey,
                sourceHome,
                nativeId: "resolved-id",
                root: sourceHome,
                archived: false,
                resumeMode: "native",
                boundedFields: [],
            },
            revision: "metadata-r1",
            parserVersion: "reader-v1",
            generation: 11,
            expected: null,
        })
    ).toBe(true);
    db.query("UPDATE session_metadata SET local_note='custom-note' WHERE source_key=?").run(sourceKey);
    db.query("UPDATE file_index SET local_flag='custom-flag' WHERE source_key=?").run(sourceKey);

    const cache = new HistoryCacheRepository(db, CLAUDE);
    cache.upsertSessionMetadata({
        ...metadata(filePath, "updated-public-id"),
        customTitle: "Updated legacy title",
    });
    cache.upsertFileIndex({
        filePath,
        mtime: 999,
        messageCount: 42,
        firstDate: "2026-09-01",
        lastDate: "2026-09-02",
        project: "shop",
        isSubagent: false,
        lastIndexed: "2026-09-02T12:00:00.000Z",
    });

    expect(
        db
            .query(
                "SELECT source_key, source_home, native_id, identity_status, local_note FROM session_metadata WHERE provider=? AND file_path=?"
            )
            .get(CLAUDE, filePath)
    ).toEqual({
        source_key: sourceKey,
        source_home: sourceHome,
        native_id: "resolved-id",
        identity_status: "resolved",
        local_note: "custom-note",
    });
    expect(
        db
            .query(
                "SELECT metadata_revision, metadata_parser_version, generation, statistics_status, message_count, local_flag FROM file_index WHERE source_key=?"
            )
            .get(sourceKey)
    ).toEqual({
        metadata_revision: "metadata-r1",
        metadata_parser_version: "reader-v1",
        generation: 11,
        statistics_status: "legacy",
        message_count: 42,
        local_flag: "custom-flag",
    });

    const newPath = "/tmp/new-legacy.jsonl";
    cache.upsertSessionMetadata(metadata(newPath, "new-legacy"));
    expect(
        db
            .query(
                "SELECT source_key, source_home, native_id, identity_status, local_note FROM session_metadata WHERE provider=? AND file_path=?"
            )
            .get(CLAUDE, newPath)
    ).toEqual({
        source_key: unresolvedHistorySourceKey({ providerId: CLAUDE, filePath: newPath }),
        source_home: null,
        native_id: null,
        identity_status: "legacy",
        local_note: "metadata-kept",
    });
    db.close();
});

function tableHash(db: Database, table: string): string {
    const rows = db.query(`SELECT * FROM "${table}" ORDER BY id`).all();
    return createHash("sha256")
        .update(SafeJSON.stringify(rows, { strict: true }))
        .digest("hex");
}

test("reset removes one provider's derived rows while preserving observations and global keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "cache-reset-"));
    const dbPath = join(directory, "index.db");
    const usage = new UsageLimitsDb(dbPath);
    usage.recordSnapshot("work", "five_hour", 42, "2026-09-01T10:00:00.000Z");
    usage.recordSpendIfChanged("work", {
        used_minor: 1250,
        used_currency: "USD",
        used_exponent: 2,
        limit_minor: 5000,
        limit_exponent: 2,
        percent: 25,
        severity: "ok",
        enabled: true,
        cap_minor: null,
        cap_currency: null,
    });

    const db = new Database(dbPath);
    initializeCompactHistorySchema(db);
    const claude = new HistoryCacheRepository(db, CLAUDE);
    const codex = new HistoryCacheRepository(db, CODEX);
    for (const cache of [claude, codex]) {
        const path = `/tmp/${cache.providerId}.jsonl`;
        cache.upsertSessionMetadata(metadata(path, cache.providerId));
        cache.upsertFileIndex({
            filePath: path,
            mtime: 1,
            messageCount: 3,
            firstDate: "2026-09-01",
            lastDate: "2026-09-01",
            project: "shop",
            isSubagent: false,
            lastIndexed: "2026-09-01T11:00:00.000Z",
        });
        cache.upsertDailyStats(daily(cache.providerId, 3));
        cache.updateCachedTotals({
            totalConversations: 1,
            totalMessages: 3,
            totalSubagents: 0,
            projectCount: 1,
        });
    }
    db.query("INSERT INTO history_roots(provider,root,generation) VALUES (?,?,1)").run(CLAUDE, "/claude");
    db.query("INSERT INTO history_roots(provider,root,generation) VALUES (?,?,1)").run(CODEX, "/codex");
    db.query("INSERT INTO history_source_issues(provider,path,code,message,occurrences) VALUES (?,?,?,?,1)").run(
        CLAUDE,
        "/claude",
        "fixture",
        "fixture"
    );
    db.query("INSERT INTO history_source_issues(provider,path,code,message,occurrences) VALUES (?,?,?,?,1)").run(
        CODEX,
        "/codex",
        "fixture",
        "fixture"
    );
    db.query("INSERT INTO file_daily_stats(source_key,provider,date,project,messages) VALUES (?,?,?,?,1)").run(
        unresolvedHistorySourceKey({ providerId: CLAUDE, filePath: "/tmp/contribution" }),
        CLAUDE,
        "2026-09-01",
        "__all__"
    );
    db.query("INSERT INTO file_daily_stats(source_key,provider,date,project,messages) VALUES (?,?,?,?,1)").run(
        unresolvedHistorySourceKey({ providerId: CODEX, filePath: "/tmp/contribution" }),
        CODEX,
        "2026-09-01",
        "__all__"
    );
    db.exec(
        "CREATE TABLE unknown_fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO unknown_fixture VALUES(1,'kept')"
    );
    claude.setCacheMeta("metadata_version", "legacy");
    claude.setCacheMeta("last_full_update", "legacy");
    const generationKey = SafeJSON.stringify(["history", CLAUDE, "generation"], { strict: true });
    claude.setCacheMeta(generationKey, "19");
    claude.setCacheMeta("history:budget:fixture", "kept");

    const usageHash = tableHash(db, "usage_snapshots");
    const spendHash = tableHash(db, "spend_snapshots");
    claude.resetDatabase();

    expect(claude.getAllSessionMetadata()).toEqual([]);
    expect(claude.getAllFileIndexes()).toEqual([]);
    expect(claude.getDailyStats("2026-09-01")).toBeNull();
    expect(claude.getCachedTotals()).toBeNull();
    expect(codex.getAllSessionMetadata()).toHaveLength(1);
    expect(codex.getAllFileIndexes()).toHaveLength(1);
    expect(codex.getDailyStats("2026-09-01")?.messages).toBe(3);
    expect(codex.getCachedTotals()?.totalMessages).toBe(3);
    expect(db.query("SELECT COUNT(*) AS count FROM history_roots WHERE provider=?").get(CLAUDE)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM history_roots WHERE provider=?").get(CODEX)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM history_source_issues WHERE provider=?").get(CLAUDE)).toEqual({
        count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM history_source_issues WHERE provider=?").get(CODEX)).toEqual({
        count: 1,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM file_daily_stats WHERE provider=?").get(CLAUDE)).toEqual({
        count: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM file_daily_stats WHERE provider=?").get(CODEX)).toEqual({
        count: 1,
    });
    expect(claude.getCacheMeta("metadata_version")).toBeNull();
    expect(claude.getCacheMeta("last_full_update")).toBeNull();
    expect(claude.getCacheMeta(generationKey)).toBe("19");
    expect(claude.getCacheMeta("history:budget:fixture")).toBe("kept");
    expect(tableHash(db, "usage_snapshots")).toBe(usageHash);
    expect(tableHash(db, "spend_snapshots")).toBe(spendHash);
    expect(db.query("SELECT value FROM unknown_fixture WHERE id=1").get()).toEqual({ value: "kept" });
    expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE id LIKE 'provider_history:%'").get()).toEqual({
        count: 6,
    });

    usage.close();
    db.close();
});

test("aggregateDailyStats preserves legacy numeric and JSON semantics", () => {
    const result = aggregateDailyStats([
        daily("claude", 4),
        {
            ...daily("claude", 6),
            date: "2026-09-02",
            toolCounts: { Read: 2, Edit: 3 },
            hourlyActivity: { "10": 1, "11": 5 },
            modelCounts: { opus: 6 },
            branchCounts: { feature: 6 },
        },
    ]);

    expect(result).toEqual({
        totalConversations: 4,
        totalMessages: 10,
        subagentCount: 2,
        projectCounts: {},
        toolCounts: { Read: 6, Edit: 3 },
        dailyActivity: { "2026-09-01": 4, "2026-09-02": 6 },
        hourlyActivity: { "10": 5, "11": 5 },
        tokenUsage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheCreateTokens: 10,
            cacheReadTokens: 30,
        },
        modelCounts: { claude: 4, opus: 6 },
        branchCounts: { main: 4, feature: 6 },
        dailyTokens: {
            "2026-09-01": {
                inputTokens: 40,
                outputTokens: 8,
                cacheCreateTokens: 4,
                cacheReadTokens: 12,
            },
            "2026-09-02": {
                inputTokens: 60,
                outputTokens: 12,
                cacheCreateTokens: 6,
                cacheReadTokens: 18,
            },
        },
    });
});

test("path-keyed reads resolve symlinks, so a caller's raw path finds the row discovery wrote", () => {
    const root = mkdtempSync(join(tmpdir(), "gt-cache-canonical-"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    const source = join(realpathSync(real), "session.jsonl");
    writeFileSync(source, "{}\n");
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const cache = new HistoryCacheRepository(database, CLAUDE);

    try {
        cache.upsertFileIndex({
            filePath: source,
            mtime: 1,
            messageCount: 1,
            firstDate: "2026-09-01",
            lastDate: "2026-09-01",
            project: "fixture",
            isSubagent: false,
            lastIndexed: "2026-09-01T00:00:00.000Z",
        });

        // Discovery stored the resolved path; the caller holds the symlinked one.
        expect(cache.getFileIndex(join(link, "session.jsonl"))?.filePath).toBe(source);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
