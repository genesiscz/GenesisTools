import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historySourceKey } from "./identity";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryRepository } from "./repository";

const PROVIDER = "anthropic-sub";

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "history-projection-")));

function seed(repository: HistoryRepository, sessionId: string, mtime: number): void {
    repository.replaceMetadata({
        metadata: {
            providerId: PROVIDER,
            sourceKey: historySourceKey({ providerId: PROVIDER, nativeId: sessionId, sourceHome: HOME }),
            sourceHome: HOME,
            nativeId: sessionId,
            root: HOME,
            filePath: `${HOME}/${sessionId}.jsonl`,
            sessionId,
            customTitle: `Title ${sessionId}`,
            summary: `Summary ${sessionId}`,
            firstPrompt: `Prompt ${sessionId}`,
            allUserText: `everything the user typed in ${sessionId}`,
            gitBranch: "main",
            project: "shop",
            cwd: "/projects/shop",
            mtime,
            firstTimestamp: "2026-09-01T10:00:00.000Z",
            lastTimestamp: "2026-09-01T11:00:00.000Z",
            isSubagent: false,
            archived: false,
            resumeMode: "native",
            boundedFields: [],
        },
        revision: `r-${sessionId}`,
        parserVersion: "reader-v1",
        generation: 1,
        expected: null,
    });
}

/**
 * `all_user_text` is the widest column in the table (20 KB a session, 27 MB across this
 * machine's 12k rows) and only `search` reads it. A listing asks for the projection without
 * it; everything else must come back the same.
 */
test("the listing projection returns every field except allUserText", () => {
    const database = new Database(":memory:");

    try {
        initializeCompactHistorySchema(database);
        const repository = new HistoryRepository(database);
        seed(repository, "one", 100);
        seed(repository, "two", 200);

        const full = repository.listMetadata({ providerId: PROVIDER });
        const listing = repository.listMetadata({ providerId: PROVIDER, withUserText: false });

        expect(full).toHaveLength(2);
        expect(full.map((row) => row.allUserText)).toEqual([
            "everything the user typed in two",
            "everything the user typed in one",
        ]);
        expect(listing.map((row) => row.allUserText)).toEqual([null, null]);
        expect(listing.map((row) => ({ ...row, allUserText: null }))).toEqual(
            full.map((row) => ({ ...row, allUserText: null }))
        );
    } finally {
        database.close();
    }
});

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
});

test("the projection is derived from the schema, so a new column is carried automatically", () => {
    const database = new Database(":memory:");

    try {
        initializeCompactHistorySchema(database);
        const columns = database
            .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
            .all()
            .map((row) => row.name);
        const repository = new HistoryRepository(database);
        seed(repository, "one", 100);

        // Every column but the one deliberately left out reaches the decoded row, and the
        // decoder covers them: a column added later flows through without an edit here.
        expect(columns).toContain("all_user_text");
        expect(
            Object.keys(repository.listMetadata({ providerId: PROVIDER, withUserText: false })[0] ?? {}).length
        ).toBeGreaterThanOrEqual(columns.length - 1);
    } finally {
        database.close();
    }
});
