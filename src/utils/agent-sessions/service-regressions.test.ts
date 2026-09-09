import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { codexHistoryReader, grokHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";
import type { HistoryMetadataRecord, HistorySourceRecord, NativeSessionReader, NativeSessionSource } from "./types";

interface FixtureSource {
    source: NativeSessionSource<string>;
    metadata: Omit<HistoryMetadataRecord, "providerId" | "sourceKey">;
    records: HistorySourceRecord[];
}

function service(options: { providerId: string; reader: NativeSessionReader<string>; roots: string[] }): {
    database: Database;
    history: HistoryService;
} {
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    return {
        database,
        history: new HistoryService({
            providerId: options.providerId,
            reader: options.reader,
            repository: new HistorySyncRepository(database),
            roots: options.roots,
            now: () => new Date("2026-09-08T12:00:00.000Z"),
        }),
    };
}

function record(options: {
    locator: string;
    text?: string;
    timestamp?: string;
    metadataChanges?: HistorySourceRecord["metadataChanges"];
}): HistorySourceRecord {
    return {
        position: Number(options.locator.split(":").at(-1) ?? 0),
        locator: options.locator,
        timestamp: options.timestamp,
        role: options.text ? "user" : "system",
        metadataChanges: options.metadataChanges,
        entries: options.text
            ? [{ line: 1, role: "user", text: options.text, paths: [], commits: [], timestamp: options.timestamp }]
            : [],
        original: SafeJSON.stringify({ locator: options.locator, text: options.text }, { strict: true }),
    };
}

function fixtureSource(options: {
    root: string;
    name: string;
    nativeId: string;
    sessionId?: string;
    cwd?: string;
    text?: string;
    timestamp?: string;
    metadataChanges?: HistorySourceRecord["metadataChanges"];
}): FixtureSource {
    const root = realpathSync(options.root);
    const filePath = join(root, `${options.name}.jsonl`);
    writeFileSync(filePath, options.text ?? "needle");
    const sourceHome = join(root, "home");
    mkdirSync(sourceHome, { recursive: true });
    const stamp = options.timestamp ?? "2026-09-01T10:00:00.000Z";
    const records = [
        record({ locator: "fixture:0", text: options.text ?? "needle", timestamp: stamp }),
        ...(options.metadataChanges
            ? [record({ locator: "fixture:1", metadataChanges: options.metadataChanges })]
            : []),
    ];
    return {
        source: {
            kind: "fixture",
            root,
            sourceHome,
            filePath,
            dataPaths: [filePath],
            metadataPaths: [],
            searchPaths: [filePath],
            metadata: {
                sessionId: options.sessionId ?? options.nativeId,
                cwd: options.cwd ?? "/old",
                mtime: new Date(stamp),
                isSubagent: false,
            },
        },
        metadata: {
            filePath,
            sessionId: options.sessionId ?? options.nativeId,
            customTitle: null,
            summary: null,
            firstPrompt: options.text ?? "needle",
            gitBranch: null,
            project: "fixture",
            cwd: options.cwd ?? "/old",
            mtime: Date.parse(stamp),
            firstTimestamp: stamp,
            isSubagent: false,
            allUserText: options.text ?? "needle",
            sourceHome,
            nativeId: options.nativeId,
            root,
            lastTimestamp: stamp,
            archived: false,
            resumeMode: "native",
            boundedFields: [],
        },
        records,
    };
}

function fixtureReader(options: {
    fixtures: FixtureSource[];
    hydrationFailure?: { path: string; mode: "incomplete" | "changed" };
}): NativeSessionReader<string> {
    let changed = false;
    return {
        kind: "fixture",
        parserVersion: "fixture-v1",
        roots: () => [...new Set(options.fixtures.map((fixture) => fixture.source.root))],
        discover: async () => ({
            sources: options.fixtures.map((fixture) => fixture.source),
            issues: [],
            completeRoots: [...new Set(options.fixtures.map((fixture) => fixture.source.root))],
        }),
        readMetadata: async (source) => ({
            metadata: options.fixtures.find((fixture) => fixture.source.filePath === source.filePath)?.metadata ?? null,
            issues: [],
            complete: true,
        }),
        scan: async function* (source) {
            yield* options.fixtures.find((fixture) => fixture.source.filePath === source.filePath)?.records ?? [];

            if (options.hydrationFailure?.path === source.filePath) {
                if (options.hydrationFailure.mode === "incomplete") {
                    throw new Error("fixture source scan incomplete");
                }

                if (!changed) {
                    appendFileSync(source.filePath, " changed");
                    changed = true;
                }
            }
        },
        readRecords: async (source, readOptions) => {
            const fixture = options.fixtures.find((candidate) => candidate.source.filePath === source.filePath);
            return {
                records: (fixture?.records ?? []).filter((candidate) =>
                    readOptions.locators.includes(candidate.locator)
                ),
                issues: [],
                complete: true,
            };
        },
        read: async () => {
            throw new Error("fixture transcript hydration is not used");
        },
    };
}

test("source-stable native exclusion remains early while mutable public id and cwd use final record metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-service-last-wins-"));
    const fixture = fixtureSource({
        root,
        name: "mutable",
        nativeId: "stable-native-id",
        sessionId: "old-id",
        cwd: "/old",
        metadataChanges: { sessionId: "new-id", cwd: "/new" },
    });
    const reader = fixtureReader({ fixtures: [fixture] });
    const current = service({ providerId: "fixture-provider", reader, roots: [root] });
    try {
        const publicAlias = await current.history.search({
            query: "needle",
            cwd: "/new",
            excludeSessions: ["old-id"],
        });
        const stableNative = await current.history.search({ query: "needle", excludeSessions: ["stable-native-id"] });

        expect(publicAlias.results).toHaveLength(1);
        expect(publicAlias.results[0]?.metadata).toMatchObject({
            nativeId: "stable-native-id",
            sessionId: "new-id",
            cwd: "/new",
        });
        expect(stableNative.results).toEqual([]);
    } finally {
        current.database.close();
    }
});

describe.each([false, true])("limit backfill with relevance=%s", (sortByRelevance) => {
    test.each(["incomplete", "changed"] as const)("hydrates the second match after the first is %s", async (mode) => {
        const root = mkdtempSync(join(tmpdir(), `gt-service-backfill-${mode}-`));
        const first = fixtureSource({
            root,
            name: "first",
            nativeId: "first-native",
            timestamp: "2026-09-01T10:00:00.000Z",
        });
        const second = fixtureSource({
            root,
            name: "second",
            nativeId: "second-native",
            timestamp: "2026-09-01T10:00:00.000Z",
        });
        const older = new Date("2026-09-01T00:00:00.000Z");
        const newer = new Date("2026-09-02T00:00:00.000Z");
        utimesSync(second.source.filePath, older, older);
        utimesSync(first.source.filePath, newer, newer);
        const reader = fixtureReader({
            fixtures: [first, second],
            hydrationFailure: { path: first.source.filePath, mode },
        });
        const current = service({ providerId: "fixture-provider", reader, roots: [root] });
        try {
            const response = await current.history.search({ query: "needle", limit: 1, sortByRelevance });

            expect(response.results.map((result) => result.metadata.nativeId)).toEqual(["second-native"]);
            expect(response.issues.some((issue) => issue.path === first.source.filePath)).toBe(true);
        } finally {
            current.database.close();
        }
    });
});

test("summary-only results apply limit after global metadata-mtime ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-service-summary-order-"));
    const first = fixtureSource({
        root,
        name: "first",
        nativeId: "first-native",
        timestamp: "2026-09-03T10:00:00.000Z",
    });
    const second = fixtureSource({
        root,
        name: "second",
        nativeId: "second-native",
        timestamp: "2026-09-01T10:00:00.000Z",
    });
    first.metadata.mtime = Date.parse("2026-09-01T00:00:00.000Z");
    second.metadata.mtime = Date.parse("2026-09-04T00:00:00.000Z");
    const reader = fixtureReader({ fixtures: [first, second] });
    const current = service({ providerId: "fixture-provider", reader, roots: [root] });
    try {
        const response = await current.history.search({ summaryOnly: true, limit: 1 });

        expect(response.results.map((result) => result.metadata.nativeId)).toEqual(["second-native"]);
    } finally {
        current.database.close();
    }
});

test("Codex sidecar titles match on cold and warm content searches without fabricated record locators", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-service-codex-title-"));
    const root = join(home, "sessions");
    mkdirSync(root);
    const nativeId = "11111111-2222-4333-8444-555555555555";
    const rollout = join(root, `rollout-${nativeId}.jsonl`);
    writeFileSync(
        rollout,
        `${SafeJSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: "/projects/shop", history_mode: "legacy" } }, { strict: true })}\n${SafeJSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "unrelated content" }] } }, { strict: true })}\n`
    );
    const state = new Database(join(home, "state_5.sqlite"));
    state.run(
        "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)"
    );
    state.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)", [
        nativeId,
        "Quarterly invoice repair",
        "/projects/shop",
        1_788_000_000,
        1_788_000_100,
        0,
    ]);
    state.close();
    const current = service({ providerId: "openai-sub", reader: codexHistoryReader, roots: [root] });
    try {
        for (const response of [
            await current.history.search({ query: "Quarterly invoice repair" }),
            await current.history.search({ query: "Quarterly invoice repair" }),
        ]) {
            expect(response.results.map((result) => result.metadata.nativeId)).toEqual([nativeId]);
            expect(response.results[0]?.matchedRecords).toEqual([]);
            expect(response.results[0]?.contextRecords).toEqual([]);
            expect(response.results[0]?.matchedEntries).toEqual([]);
        }
    } finally {
        current.database.close();
    }
});

test("Grok sidecar titles match on cold and warm content searches without fabricated record locators", async () => {
    const home = mkdtempSync(join(tmpdir(), "gt-service-grok-title-"));
    const root = join(home, "sessions");
    const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const directory = join(root, encodeURIComponent("/projects/shop"), nativeId);
    mkdirSync(directory, { recursive: true });
    const chat = join(directory, "chat_history.jsonl");
    writeFileSync(
        chat,
        `${SafeJSON.stringify({ type: "assistant", content: [{ type: "text", text: "unrelated content" }] }, { strict: true })}\n`
    );
    writeFileSync(
        join(directory, "summary.json"),
        SafeJSON.stringify(
            { info: { id: nativeId, cwd: "/projects/shop" }, generated_title: "Quarterly invoice repair" },
            { strict: true }
        )
    );
    const current = service({ providerId: "grok-sub", reader: grokHistoryReader, roots: [root] });
    try {
        for (const response of [
            await current.history.search({ query: "Quarterly invoice repair" }),
            await current.history.search({ query: "Quarterly invoice repair" }),
        ]) {
            expect(response.results.map((result) => result.metadata.nativeId)).toEqual([nativeId]);
            expect(response.results[0]?.matchedRecords).toEqual([]);
            expect(response.results[0]?.contextRecords).toEqual([]);
            expect(response.results[0]?.matchedEntries).toEqual([]);
        }
    } finally {
        current.database.close();
    }
});
