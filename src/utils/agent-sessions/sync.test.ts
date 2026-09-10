import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historySourceKey } from "./identity";
import { initializeCompactHistorySchema } from "./migrations";
import { synchronizeHistory } from "./sync";
import { HistorySyncRepository } from "./sync-repository";
import type { HistoryMetadataRead, NativeSessionReader, NativeSessionSource } from "./types";

const PROVIDER = "fixture-provider";
const SESSION_ID = "fixture-session";

type ReaderState = {
    completeRoots: string[];
    complete: boolean;
    issues: Array<{ path: string; message: string }>;
    title: string;
    sources: NativeSessionSource<string>[];
    displaced?: string[];
};

function createFixture(): {
    db: Database;
    filePath: string;
    reader: NativeSessionReader<string>;
    repository: HistorySyncRepository;
    root: string;
    state: ReaderState;
    readCount: () => number;
} {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "history-sync-")));
    const root = join(home, "sessions");
    const filePath = join(root, "fixture.jsonl");
    mkdirSync(root);
    writeFileSync(filePath, "first fixture source\\n");
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const state: ReaderState = {
        completeRoots: [root],
        complete: true,
        issues: [],
        title: "First fixture title",
        sources: [],
    };
    let reads = 0;
    const source = (): NativeSessionSource<string> => ({
        kind: "fixture",
        root,
        sourceHome: home,
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
    });
    state.sources = [source()];
    const reader: NativeSessionReader<string> = {
        kind: "fixture",
        parserVersion: "fixture-v1",
        roots: () => [root],
        discover: async () => ({
            sources: state.sources,
            issues: state.issues,
            completeRoots: state.completeRoots,
            ...(state.displaced === undefined ? {} : { displaced: state.displaced }),
        }),
        readMetadata: async (current): Promise<HistoryMetadataRead> => {
            reads++;
            return {
                complete: state.complete,
                issues: [],
                metadata: state.complete
                    ? {
                          sourceHome: home,
                          nativeId: SESSION_ID,
                          root,
                          filePath: current.filePath,
                          sessionId: SESSION_ID,
                          customTitle: state.title,
                          summary: null,
                          firstPrompt: "Invented fixture prompt",
                          allUserText: "Invented fixture prompt",
                          gitBranch: null,
                          project: "fixture",
                          cwd: "/invented/fixture",
                          mtime: 1,
                          firstTimestamp: "2026-09-01T10:00:00.000Z",
                          isSubagent: false,
                          archived: false,
                          resumeMode: "native",
                          boundedFields: [],
                      }
                    : null,
            };
        },
        read: async () => {
            throw new Error("fixture reader does not read transcripts");
        },
    };
    return { db, filePath, reader, repository: new HistorySyncRepository(db), root, state, readCount: () => reads };
}

function metadataTitle(repository: HistorySyncRepository): string | null {
    return (
        repository.metadata.getMetadataBySessionId({ providerId: PROVIDER, sessionId: SESSION_ID })?.customTitle ?? null
    );
}

async function sync(
    fixture: ReturnType<typeof createFixture>,
    options: { scope?: { project?: string }; signal?: AbortSignal } = {}
) {
    return synchronizeHistory({
        providerId: PROVIDER,
        reader: fixture.reader,
        repository: fixture.repository,
        roots: [fixture.root],
        ...options,
    });
}

test("sync stores initial metadata and skips unchanged sources without another metadata read", async () => {
    const fixture = createFixture();
    try {
        const first = await sync(fixture);
        const second = await sync(fixture);

        expect(first.report).toMatchObject({ sessions: 1, parsed: 1, unchanged: 0, removed: 0 });
        expect(second.report).toMatchObject({ sessions: 1, parsed: 0, unchanged: 1, removed: 0 });
        expect(fixture.readCount()).toBe(1);
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");
    } finally {
        fixture.db.close();
    }
});

test("sync refreshes changed source metadata but retains existing metadata after an incomplete read", async () => {
    const fixture = createFixture();
    try {
        await sync(fixture);
        fixture.state.title = "Changed fixture title";
        writeFileSync(fixture.filePath, "changed fixture source with a longer body\\n");

        const changed = await sync(fixture);
        expect(changed.report).toMatchObject({ parsed: 1, unchanged: 0 });
        expect(metadataTitle(fixture.repository)).toBe("Changed fixture title");

        fixture.state.title = "Incomplete replacement title";
        fixture.state.complete = false;
        writeFileSync(fixture.filePath, "incomplete changed fixture source with a longer body\\n");

        const incomplete = await sync(fixture);
        expect(incomplete.report).toMatchObject({ parsed: 0, unchanged: 0 });
        expect(metadataTitle(fixture.repository)).toBe("Changed fixture title");
    } finally {
        fixture.db.close();
    }
});

test("sync retries one source change during metadata reading and commits the stable second snapshot", async () => {
    const fixture = createFixture();
    const originalRead = fixture.reader.readMetadata!;
    let attempts = 0;
    fixture.reader.readMetadata = async (source, options) => {
        attempts++;
        const result = await originalRead(source, options);

        if (attempts === 1) {
            fixture.state.title = "Stable retry title";
            writeFileSync(fixture.filePath, "source changed once during the first metadata read\n");
        }

        return result;
    };

    try {
        const result = await sync(fixture);
        expect(result.report).toMatchObject({ parsed: 1, sessions: 1 });
        expect(attempts).toBe(2);
        expect(metadataTitle(fixture.repository)).toBe("Stable retry title");
        expect(result.report.issues).toEqual([]);
    } finally {
        fixture.db.close();
    }
});

test("sync stops after two changing snapshots and retains the previous metadata", async () => {
    const fixture = createFixture();

    try {
        await sync(fixture);
        const originalRead = fixture.reader.readMetadata!;
        let attempts = 0;
        fixture.state.title = "Never stable title";
        fixture.reader.readMetadata = async (source, options) => {
            attempts++;
            const result = await originalRead(source, options);
            writeFileSync(fixture.filePath, `source churn ${attempts} ${"x".repeat(attempts)}\n`);
            return result;
        };
        writeFileSync(fixture.filePath, "trigger changed source\n");

        const result = await sync(fixture);
        expect(result.report).toMatchObject({ parsed: 0, sessions: 1 });
        expect(attempts).toBe(2);
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");
        expect(result.report.issues.some((issue) => issue.message.includes("changed during metadata read"))).toBe(true);
    } finally {
        fixture.db.close();
    }
});

test("sync removes a missing source only after an unfiltered complete root scan", async () => {
    const fixture = createFixture();
    try {
        await sync(fixture);
        unlinkSync(fixture.filePath);
        fixture.state.sources = [];
        fixture.state.completeRoots = [];
        await sync(fixture);
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");

        fixture.state.completeRoots = [fixture.root];
        await sync(fixture, { scope: { project: "fixture" } });
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");

        const removed = await sync(fixture);
        expect(removed.report).toMatchObject({ sessions: 0, sources: 0, removed: 1 });
        expect(metadataTitle(fixture.repository)).toBeNull();
    } finally {
        fixture.db.close();
    }
});

test("sync removes the row of a displaced copy even though its file still exists", async () => {
    const fixture = createFixture();
    try {
        await sync(fixture);
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");

        // The file stays on disk (a sidecar stub of a moved session); discovery dropped it for
        // another copy, so the existence check alone would keep this row forever.
        fixture.state.sources = [];
        fixture.state.displaced = [fixture.filePath];
        const removed = await sync(fixture);
        expect(removed.report).toMatchObject({ sources: 0, removed: 1 });
        expect(metadataTitle(fixture.repository)).toBeNull();
    } finally {
        fixture.db.close();
    }
});

// The displaced cleanup runs the same generation guard as the deletion pass: an older sync
// that learns of a displacement must not remove a row a newer sync has since re-indexed.
test("an older sync's displaced cleanup leaves a row a newer generation re-indexed", async () => {
    const fixture = createFixture();
    let releaseOlder: (() => void) | undefined;
    let olderDiscoverStarted: (() => void) | undefined;
    const olderDiscover = new Promise<void>((resolve) => {
        olderDiscoverStarted = resolve;
    });
    const olderRelease = new Promise<void>((resolve) => {
        releaseOlder = resolve;
    });
    const originalDiscover = fixture.reader.discover;
    let discoveries = 0;

    try {
        await sync(fixture);
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");

        // One sync discovers twice: an observation pass, then the real pass after its
        // generation is reserved. The older sync owns the first two calls; it pauses in
        // the second, so its generation is already taken when the newer sync starts.
        fixture.reader.discover = async (roots, options) => {
            discoveries++;
            if (discoveries > 2) {
                return originalDiscover(roots, options);
            }

            if (discoveries === 2) {
                olderDiscoverStarted?.();
                await olderRelease;
            }

            return {
                sources: [],
                issues: [],
                completeRoots: fixture.state.completeRoots,
                displaced: [fixture.filePath],
            };
        };

        const older = sync(fixture);
        await olderDiscover;
        fixture.state.title = "Newer fixture title";
        writeFileSync(fixture.filePath, "second fixture source\n");
        const newer = await sync(fixture);
        releaseOlder?.();
        const olderResult = await older;

        expect(newer.report.parsed).toBe(1);
        expect(olderResult.report.removed).toBe(0);
        expect(metadataTitle(fixture.repository)).toBe("Newer fixture title");
    } finally {
        fixture.db.close();
    }
});

test("sync leaves existing metadata when discovery reports a source issue", async () => {
    const fixture = createFixture();
    try {
        await sync(fixture);
        fixture.state.title = "Unreadable changed title";
        fixture.state.issues = [{ path: fixture.filePath, message: "fixture source unreadable" }];
        writeFileSync(fixture.filePath, "unreadable fixture source with changed data\\n");

        const result = await sync(fixture);
        expect(result.report).toMatchObject({ parsed: 0, unchanged: 0 });
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");
    } finally {
        fixture.db.close();
    }
});

test("sync honours cancellation before discovery and does not create metadata", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();
    try {
        await expect(sync(fixture, { signal: controller.signal })).rejects.toThrow();
        expect(fixture.repository.status(PROVIDER)).toMatchObject({ sessions: 0, sources: 0 });
        expect(fixture.readCount()).toBe(0);
    } finally {
        fixture.db.close();
    }
});

test("an older concurrent sync cannot replace metadata committed by a newer generation", async () => {
    const fixture = createFixture();
    let releaseFirst: (() => void) | undefined;
    let firstReadStarted: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
        firstReadStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const originalReadMetadata = fixture.reader.readMetadata!;
    let reads = 0;
    fixture.reader.readMetadata = async (source, options) => {
        reads++;
        if (reads === 1) {
            firstReadStarted?.();
            await firstRelease;
            fixture.state.title = "Older fixture title";
        }
        return originalReadMetadata(source, options);
    };

    try {
        const older = sync(fixture);
        await firstRead;
        fixture.state.title = "Newer fixture title";
        const newer = await sync(fixture);
        releaseFirst?.();
        const olderResult = await older;

        expect(newer.report.parsed).toBe(1);
        expect(olderResult.report.sessions).toBe(1);
        expect(metadataTitle(fixture.repository)).toBe("Newer fixture title");
        expect(
            fixture.repository.metadata.getSource(
                historySourceKey({
                    providerId: PROVIDER,
                    sourceHome: fixture.root.slice(0, -"/sessions".length),
                    nativeId: SESSION_ID,
                })
            )?.generation
        ).toBe(2);
    } finally {
        fixture.db.close();
    }
});

test("selective refresh reuses full discovery, retains unselected sources, and later indexes unknown candidates", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "history-selective-sync-")));
    const root = join(home, "sessions");
    mkdirSync(root);
    const firstPath = join(root, "first.jsonl");
    const secondPath = join(root, "second.jsonl");
    writeFileSync(firstPath, "first fixture source");
    writeFileSync(secondPath, "second fixture source");
    const makeSource = (filePath: string, nativeId: string): NativeSessionSource<string> => ({
        kind: "fixture",
        root,
        sourceHome: home,
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
        metadata: { sessionId: nativeId },
    });
    const first = makeSource(firstPath, "first-native");
    const second = makeSource(secondPath, "second-native");
    const discovery = { sources: [first, second], issues: [], completeRoots: [root] };
    const reader: NativeSessionReader<string> = {
        kind: "fixture",
        parserVersion: "fixture-v1",
        roots: () => [root],
        discover: async () => discovery,
        readMetadata: async (source): Promise<HistoryMetadataRead> => {
            const nativeId = source.metadata?.sessionId;
            if (!nativeId) {
                throw new Error("fixture source lacks its native ID");
            }
            return {
                complete: true,
                issues: [],
                metadata: {
                    sourceHome: home,
                    nativeId,
                    root,
                    filePath: source.filePath,
                    sessionId: nativeId,
                    customTitle: `${nativeId} title`,
                    summary: null,
                    firstPrompt: "Invented selective fixture prompt",
                    allUserText: "Invented selective fixture prompt",
                    gitBranch: null,
                    project: "fixture",
                    cwd: "/invented/selective",
                    mtime: 1,
                    firstTimestamp: "2026-09-01T10:00:00.000Z",
                    isSubagent: false,
                    archived: false,
                    resumeMode: "native",
                    boundedFields: [],
                },
            };
        },
        read: async () => {
            throw new Error("fixture reader does not read transcripts");
        },
    };
    const db = new Database(":memory:");
    initializeCompactHistorySchema(db);
    const repository = new HistorySyncRepository(db);
    try {
        const firstOnly = await synchronizeHistory({
            providerId: PROVIDER,
            reader,
            repository,
            roots: [root],
            discovery,
            metadataSources: new Set([firstPath]),
        });
        expect(firstOnly.report).toMatchObject({ parsed: 1, sessions: 1, removed: 0 });
        expect(
            repository.metadata.getMetadataBySessionId({ providerId: PROVIDER, sessionId: "second-native" })
        ).toBeNull();

        const secondLater = await synchronizeHistory({
            providerId: PROVIDER,
            reader,
            repository,
            roots: [root],
            discovery,
            metadataSources: new Set([secondPath]),
        });
        expect(secondLater.report).toMatchObject({ parsed: 1, sessions: 2, removed: 0 });
        expect(
            repository.metadata.getMetadataBySessionId({ providerId: PROVIDER, sessionId: "second-native" })
                ?.customTitle
        ).toBe("second-native title");

        const firstAgain = await synchronizeHistory({
            providerId: PROVIDER,
            reader,
            repository,
            roots: [root],
            discovery,
            metadataSources: new Set([firstPath]),
        });
        expect(firstAgain.report).toMatchObject({ unchanged: 1, sessions: 2, removed: 0 });
        expect(
            repository.metadata.getMetadataBySessionId({ providerId: PROVIDER, sessionId: "second-native" })
        ).not.toBeNull();
    } finally {
        db.close();
    }
});

test("clearing metadata invalidates an unchanged physical source so the next sync restores it", async () => {
    const fixture = createFixture();
    try {
        await sync(fixture);
        fixture.repository.metadata.clearMetadata(PROVIDER);
        expect(metadataTitle(fixture.repository)).toBeNull();

        const restored = await sync(fixture);
        expect(restored.report).toMatchObject({ parsed: 1, unchanged: 0, sessions: 1 });
        expect(metadataTitle(fixture.repository)).toBe("First fixture title");
    } finally {
        fixture.db.close();
    }
});
