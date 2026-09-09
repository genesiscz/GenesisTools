import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCompactHistorySchema } from "./migrations";
import { synchronizeHistory } from "./sync";
import { HistorySyncRepository } from "./sync-repository";
import type { HistoryMetadataRead, NativeSessionReader, NativeSessionSource, NativeSourceIssue } from "./types";

const PROVIDER = "fixture-provider";
const NATIVE_ID = "fixture-native-id";

function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "history-optimistic-sync-")));
    const root = join(home, "sessions");
    mkdirSync(root);
    const filePath = join(root, "fixture.jsonl");
    writeFileSync(filePath, "version-one");
    const state = { version: "one", present: true, issues: [] as NativeSourceIssue[], discoveryCount: 0 };

    function source(version = state.version): NativeSessionSource<string> {
        return {
            kind: "fixture",
            root,
            sourceHome: home,
            filePath,
            dataPaths: [filePath],
            metadataPaths: [],
            metadataFingerprint: version,
            metadata: { sessionId: NATIVE_ID, title: `title-${version}` },
        };
    }

    const reader: NativeSessionReader<string> = {
        kind: "fixture",
        parserVersion: "fixture-v1",
        roots: () => [root],
        discover: async () => {
            state.discoveryCount++;
            return {
                sources: state.present ? [source()] : [],
                issues: state.issues,
                completeRoots: state.issues.length ? [] : [root],
            };
        },
        readMetadata: async (candidate): Promise<HistoryMetadataRead> => {
            const version = candidate.metadataFingerprint ?? "missing";
            return {
                complete: true,
                issues: [],
                metadata: {
                    sourceHome: home,
                    nativeId: NATIVE_ID,
                    root,
                    filePath,
                    sessionId: NATIVE_ID,
                    customTitle: `title-${version}`,
                    summary: null,
                    firstPrompt: "fixture prompt",
                    allUserText: "fixture prompt",
                    gitBranch: null,
                    project: "fixture",
                    cwd: "/invented/fixture",
                    mtime: statSync(filePath).mtimeMs,
                    firstTimestamp: "2026-09-01T10:00:00.000Z",
                    isSubagent: false,
                    archived: false,
                    resumeMode: "native",
                    boundedFields: [],
                },
            };
        },
        read: async () => {
            throw new Error("fixture transcript read is unused");
        },
    };
    const databasePath = join(home, "history.sqlite");
    const database = new Database(databasePath);
    database.exec("PRAGMA journal_mode=WAL");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);

    return { home, root, filePath, state, source, reader, database, databasePath, repository };
}

function totalChanges(database: Database): number {
    return database.query<{ value: number }, []>("SELECT total_changes() AS value").get()!.value;
}

function walState(path: string): { exists: boolean; size?: bigint; mtimeNs?: bigint } {
    const wal = `${path}-wal`;
    if (!existsSync(wal)) {
        return { exists: false };
    }
    const value = statSync(wal, { bigint: true });
    return { exists: true, size: value.size, mtimeNs: value.mtimeNs };
}

test("a stale preflight descriptor is never committed after the writer performs fresh discovery", async () => {
    const value = fixture();
    try {
        await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });
        const stale = {
            sources: [value.source("one")],
            issues: [],
            completeRoots: [value.root],
        };
        value.state.version = "two";
        writeFileSync(value.filePath, "version-two-with-a-different-size");

        const result = await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
            discovery: stale,
        });

        expect(result.sources[0]?.metadataFingerprint).toBe("two");
        expect(
            value.repository.metadata.getMetadataBySessionId({
                providerId: PROVIDER,
                sessionId: NATIVE_ID,
            })?.customTitle
        ).toBe("title-two");
    } finally {
        value.database.close();
    }
});

test("fresh discovery prunes a deleted source even when the optimistic preflight still lists it", async () => {
    const value = fixture();
    try {
        await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });
        const stale = { sources: [value.source()], issues: [], completeRoots: [value.root] };
        unlinkSync(value.filePath);
        value.state.present = false;

        const result = await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
            discovery: stale,
        });

        expect(result.report).toMatchObject({ sessions: 0, sources: 0, removed: 1 });
        expect(result.sources).toEqual([]);
    } finally {
        value.database.close();
    }
});

test("a completely observed empty root is recorded so its later disappearance is not ignored as optional", async () => {
    const value = fixture();
    unlinkSync(value.filePath);
    value.state.present = false;
    try {
        await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });
        expect(
            value.database
                .query<{ count: number }, []>(
                    "SELECT count(*) AS count FROM history_roots WHERE provider='fixture-provider'"
                )
                .get()?.count
        ).toBe(1);

        value.state.issues = [{ path: value.root, message: "Source root unavailable", code: "root-missing" }];
        const missing = await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });

        expect(missing.report.issues).toEqual([{ path: value.root, message: "Source root unavailable" }]);
    } finally {
        value.database.close();
    }
});

test("an unchanged optimistic sync leaves total_changes and the WAL untouched", async () => {
    const value = fixture();
    try {
        await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });
        const changesBefore = totalChanges(value.database);
        const walBefore = walState(value.databasePath);
        const discoveriesBefore = value.state.discoveryCount;

        const result = await synchronizeHistory({
            providerId: PROVIDER,
            reader: value.reader,
            repository: value.repository,
            roots: [value.root],
        });

        expect(result.report).toMatchObject({ parsed: 0, unchanged: 1, removed: 0 });
        expect(value.state.discoveryCount - discoveriesBefore).toBe(1);
        expect(totalChanges(value.database)).toBe(changesBefore);
        expect(walState(value.databasePath)).toEqual(walBefore);
    } finally {
        value.database.close();
    }
});
