import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "@genesiscz/utils/paths";
import { historySourceKey } from "./identity";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryRepository } from "./repository";
import type { HistoryMetadataRecord } from "./types";

function metadata(providerId: string): HistoryMetadataRecord {
    const sourceHome = realpathSync(mkdtempSync(join(tmpdir(), "history-repository-")));
    const root = join(sourceHome, "sessions");
    mkdirSync(root);
    return {
        providerId,
        sourceHome,
        sourceKey: historySourceKey({ providerId, sourceHome, nativeId: "one" }),
        nativeId: "one",
        filePath: join(root, "one.jsonl"),
        root,
        sessionId: "one",
        customTitle: `${providerId} title`,
        summary: null,
        firstPrompt: "Invented prompt",
        allUserText: "Invented prompt",
        gitBranch: null,
        project: "fixture",
        cwd: "/invented/project",
        mtime: 42,
        firstTimestamp: "2026-08-15T12:00:00Z",
        isSubagent: false,
        archived: false,
        resumeMode: "native",
        boundedFields: [],
    };
}

test("metadata writes stay provider-scoped without claiming transcript statistics", () => {
    const db = new Database(":memory:");

    try {
        initializeCompactHistorySchema(db);
        const repository = new HistoryRepository(db);
        const first = metadata("anthropic-sub");
        const other = metadata("openai-sub");
        repository.replaceMetadata({
            metadata: first,
            revision: "one",
            parserVersion: "2",
            generation: 1,
            expected: null,
        });
        repository.replaceMetadata({
            metadata: other,
            revision: "one",
            parserVersion: "4",
            generation: 1,
            expected: null,
        });

        expect(repository.listMetadata({ providerId: "anthropic-sub" }).map((row) => row.customTitle)).toEqual([
            "anthropic-sub title",
        ]);
        expect(repository.getSource(first.sourceKey)).toMatchObject({
            metadataRevision: "one",
            statisticsStatus: "unavailable",
            statsRevision: null,
        });
        expect(repository.listMetadata({ providerId: "missing-sub" })).toEqual([]);
    } finally {
        db.close();
    }
});

test("a stale metadata writer cannot replace a newer source snapshot", () => {
    const db = new Database(":memory:");

    try {
        initializeCompactHistorySchema(db);
        const repository = new HistoryRepository(db);
        const record = metadata("anthropic-sub");
        repository.replaceMetadata({
            metadata: record,
            revision: "one",
            parserVersion: "2",
            generation: 1,
            expected: null,
        });
        const stale = repository.getSource(record.sourceKey);
        expect(
            repository.replaceMetadata({
                metadata: { ...record, customTitle: "New title" },
                revision: "two",
                parserVersion: "2",
                generation: 2,
                expected: stale,
            })
        ).toBe(true);
        expect(
            repository.replaceMetadata({
                metadata: { ...record, customTitle: "Stale title" },
                revision: "old",
                parserVersion: "2",
                generation: 1,
                expected: stale,
            })
        ).toBe(false);
        expect(repository.listMetadata({ providerId: "anthropic-sub" })[0].customTitle).toBe("New title");
        expect(repository.getSource(record.sourceKey)?.metadataRevision).toBe("two");
    } finally {
        db.close();
    }
});

test("a metadata record cannot publish a key belonging to a different native identity", () => {
    const db = new Database(":memory:");

    try {
        initializeCompactHistorySchema(db);
        const repository = new HistoryRepository(db);
        const record = metadata("anthropic-sub");
        expect(() =>
            repository.replaceMetadata({
                metadata: { ...record, nativeId: "different" },
                revision: "one",
                parserVersion: "2",
                generation: 1,
                expected: null,
            })
        ).toThrow("identity");
        expect(repository.listMetadata({ providerId: "anthropic-sub" })).toEqual([]);
    } finally {
        db.close();
    }
});

test("the write boundary bounds provider text while preserving coverage flags", () => {
    const db = new Database(":memory:");

    try {
        initializeCompactHistorySchema(db);
        const repository = new HistoryRepository(db);
        const record: HistoryMetadataRecord = {
            ...metadata("anthropic-sub"),
            customTitle: "😀".repeat(5_000),
            allUserText: "x".repeat(30_000),
            boundedFields: ["firstTimestamp"],
        };
        repository.replaceMetadata({
            metadata: record,
            revision: "one",
            parserVersion: "2",
            generation: 1,
            expected: null,
        });
        const saved = repository.listMetadata({ providerId: "anthropic-sub" })[0];

        expect(Buffer.byteLength(saved.customTitle ?? "")).toBe(4_096);
        expect(Buffer.byteLength(saved.allUserText ?? "")).toBe(20_000);
        expect(saved.boundedFields).toEqual(["firstTimestamp", "customTitle", "allUserText"]);
        expect(record.allUserText).toHaveLength(30_000);
    } finally {
        db.close();
    }
});
