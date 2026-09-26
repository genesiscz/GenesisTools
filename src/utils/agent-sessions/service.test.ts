import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { claudeHistoryReader } from "./compact-readers";
import { initializeCompactHistorySchema } from "./migrations";
import { createClaudeHistoryOperations } from "./readers/claude";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { fallbackTitle, HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";
import { type BaselineOracle, createBaselineOracle } from "./testing/baseline-oracle";
import { generateHistoryCorpus } from "./testing/corpus";
import { createFixtureWorld } from "./testing/fixture-world";
import { withBaseline } from "./testing/with-baseline";
import type { AgentSearchFilters, NativeSessionReader, NativeSessionSource } from "./types";

function sourceHashes(paths: string[]): Promise<string[]> {
    return Promise.all(
        paths.map(async (path) =>
            createHash("sha256")
                .update(await readFile(path))
                .digest("hex")
        )
    );
}

function createReader(options: { kind: string; roots: string[] }): NativeSessionReader<string> {
    const operations = createClaudeHistoryOperations();
    const asClaude = ({ metadata, ...source }: NativeSessionSource<string>): NativeSessionSource<"claude"> => ({
        ...source,
        kind: "claude",
        ...(metadata ? { metadata: { ...metadata, kind: "claude" } } : {}),
    });

    return {
        kind: options.kind,
        ...operations,
        roots: () => options.roots,
        read: async () => {
            throw new Error("fixture reader does not read transcripts");
        },
        discover: async (roots, discoveryOptions) => {
            const discovered = await discoverClaudeHistorySources(roots, discoveryOptions);
            return {
                ...discovered,
                sources: discovered.sources.map((source) => ({ ...source, kind: options.kind })),
            };
        },
        readMetadata: async (source, readOptions) => operations.readMetadata(asClaude(source), readOptions),
        scan: (source, readOptions) => operations.scan(asClaude(source), readOptions),
        readRecords: (source, readOptions) => operations.readRecords(asClaude(source), readOptions),
    };
}

function createService(options: {
    providerId: string;
    reader: NativeSessionReader<string>;
    roots: string[];
    now?: () => Date;
}) {
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    return { database, service: new HistoryService({ ...options, repository: new HistorySyncRepository(database) }) };
}
function summaryTuple(options: {
    summary?: string | null;
    customTitle?: string | null;
    gitBranch?: string | null;
}): [string | null, string | null, string | null] {
    return [options.summary ?? null, options.customTitle ?? null, options.gitBranch ?? null];
}

withBaseline(
    "service content search preserves frozen-oracle session order, summaries, relevance, and original matches",
    async () => {
        const world = await createFixtureWorld();
        let oracle: BaselineOracle | undefined;
        const { database, service } = createService({
            providerId: "anthropic-sub",
            reader: createReader({ kind: "claude", roots: [world.sources.claude] }),
            roots: [world.sources.claude],
            now: () => world.now,
        });
        try {
            const corpus = await generateHistoryCorpus({
                root: world.root,
                seed: 43,
                sessionCount: 2,
                recordCount: 4,
                distribution: { main: 1, subagent: 1 },
            });
            oracle = await createBaselineOracle({ world });
            const filters = { query: corpus.queries.common, context: 1, sortByRelevance: true };
            const baseline = await oracle.searchContent(filters);
            const current = await service.search(filters);

            expect(current.issues).toEqual([]);
            // The frozen Claude facade exposed public parent IDs; service sessions retain native resumable IDs.
            expect(current.results.map((result) => result.metadata.sessionId)).toEqual(
                baseline.map((result) => result.sessionId)
            );
            const nativeIds = current.results.map((result) => {
                if (result.metadata.nativeId === null) {
                    throw new Error("Resolved service metadata omitted a native session ID");
                }
                return result.metadata.nativeId;
            });
            expect(current.results.map((result) => result.session.sessionId)).toEqual(nativeIds);
            expect(current.results.map((result) => summaryTuple(result.metadata))).toEqual(
                baseline.map((result) => summaryTuple(result))
            );
            const baselineRelevance = baseline.map((result) => {
                if (result.relevanceScore === undefined) {
                    throw new Error("Frozen oracle omitted a requested relevance score");
                }
                return result.relevanceScore;
            });
            expect(current.results.map((result) => result.relevanceScore)).toEqual(baselineRelevance);
            expect(current.results.map((result) => result.matchedRecords.map((record) => record.original))).toEqual(
                baseline.map((result) =>
                    result.matchedMessages.map((message) => SafeJSON.stringify(message, { strict: true }))
                )
            );
        } finally {
            await oracle?.close();
            database.close();
            await world.dispose();
        }
    }
);

withBaseline("service keeps original dense context records and leaves corpus source bytes unchanged", async () => {
    const world = await createFixtureWorld();
    let oracle: BaselineOracle | undefined;
    const { database, service } = createService({
        providerId: "anthropic-sub",
        reader: createReader({ kind: "claude", roots: [world.sources.claude] }),
        roots: [world.sources.claude],
        now: () => world.now,
    });
    try {
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: 47,
            sessionCount: 1,
            recordCount: 5,
            distribution: { main: 1, subagent: 0 },
        });
        const sourcePaths = corpus.sources
            .filter((source) => source.provider === "claude")
            .map((source) => `${world.root}/${source.relativePath}`);
        const before = await sourceHashes(sourcePaths);
        oracle = await createBaselineOracle({ world });
        const filters = { query: corpus.queries.common, context: 2 };
        const baseline = await oracle.searchContent(filters);
        const current = await service.search(filters);

        expect(current.results.map((result) => result.contextRecords.map((record) => record.original))).toEqual(
            baseline.map((result) =>
                (result.contextMessages ?? []).map((message) => SafeJSON.stringify(message, { strict: true }))
            )
        );
        expect(await sourceHashes(sourcePaths)).toEqual(before);
    } finally {
        await oracle?.close();
        database.close();
        await world.dispose();
    }
});

test("service initializes a cached listing, reports unchanged refreshes, and works for a fourth provider id", async () => {
    const world = await createFixtureWorld();
    const reader = createReader({ kind: "fixture-fourth", roots: [world.sources.claude] });
    const { database, service } = createService({
        providerId: "fixture-fourth-provider",
        reader,
        roots: [world.sources.claude],
        now: () => world.now,
    });
    try {
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: 53,
            sessionCount: 1,
            recordCount: 3,
            distribution: { main: 1, subagent: 0 },
        });
        const initial = await service.sync();
        const cached = service.cached({ query: corpus.queries.common });
        const refreshed = await service.sync();

        expect(initial.report).toMatchObject({ sessions: 1, parsed: 1, unchanged: 0 });
        expect(cached.results.map((result) => result.session.kind)).toEqual(["fixture-fourth"]);
        expect(cached.results.map((result) => result.session.sessionId)).toEqual([corpus.sessions[0]!.sessionId]);
        expect(refreshed.report).toMatchObject({ sessions: 1, parsed: 0, unchanged: 1 });
    } finally {
        database.close();
        await world.dispose();
    }
});

/**
 * An untitled Claude SUBAGENT rendered as 120 characters of directory in every table, picker
 * and menu-bar row, because the title fell back to the native id and a subagent's native id is
 * its whole project-relative path. Found by running the converted `tools claude history`
 * against the real index; no unit fixture was shaped like one.
 */
test("an untitled row falls back to a name a human can read, never to a whole path", () => {
    expect(
        fallbackTitle({
            nativeId: "-Users-me-Projects-shop/54cad246-b912-4ba4-892b-b9f9cf67d90a/subagents/agent-areview-0ec859f1",
        })
    ).toBe("agent-areview-0ec859f1");

    // A short native id is already the name; there is nothing to strip.
    expect(fallbackTitle({ nativeId: "01a08283-d374-7ab3-bcc5-72f83340a153" })).toBe(
        "01a08283-d374-7ab3-bcc5-72f83340a153"
    );

    // Anything the session actually calls itself still wins, in the order it always did.
    expect(fallbackTitle({ customTitle: "invoice import", summary: "s", nativeId: "x/y" })).toBe("invoice import");
    expect(fallbackTitle({ summary: "refund rounding", nativeId: "x/y" })).toBe("refund rounding");
    expect(fallbackTitle({ firstPrompt: "fix the refund", nativeId: "x/y" })).toBe("fix the refund");
    expect(fallbackTitle({})).toBe("");
});

function claudeRow(options: { id: string; text: string; timestamp: string }): string {
    return `${SafeJSON.stringify({
        type: "user",
        sessionId: options.id,
        cwd: "/projects/fixture",
        timestamp: options.timestamp,
        message: { content: options.text },
    })}\n`;
}

function scanRecorder(options: { lineLocalRecords: boolean }): {
    reader: NativeSessionReader<string>;
    scanned: string[];
} {
    const scanned: string[] = [];
    const scan = claudeHistoryReader.scan!;
    return {
        scanned,
        reader: {
            ...claudeHistoryReader,
            lineLocalRecords: options.lineLocalRecords,
            scan(source, readOptions) {
                scanned.push(source.filePath);
                return scan(
                    {
                        ...source,
                        kind: "claude",
                        metadata: source.metadata ? { ...source.metadata, kind: "claude" } : undefined,
                    },
                    readOptions
                );
            },
        },
    };
}

test("a Claude content search never scans a transcript where no line holds every query word", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "history-same-line-")));
    const project = join(root, "-projects-fixture");
    const apartId = "11111111-2222-4333-8444-000000000001";
    const togetherId = "11111111-2222-4333-8444-000000000002";
    mkdirSync(project, { recursive: true });
    writeFileSync(
        join(project, `${apartId}.jsonl`),
        claudeRow({ id: apartId, text: "alpha only", timestamp: "2026-09-01T00:00:00Z" }) +
            claudeRow({ id: apartId, text: "bravo only", timestamp: "2026-09-01T00:01:00Z" })
    );
    writeFileSync(
        join(project, `${togetherId}.jsonl`),
        claudeRow({ id: togetherId, text: "alpha and bravo", timestamp: "2026-09-02T00:00:00Z" })
    );

    try {
        for (const lineLocalRecords of [true, false]) {
            const { reader, scanned } = scanRecorder({ lineLocalRecords });
            const { database, service } = createService({ providerId: "anthropic-sub", reader, roots: [root] });

            try {
                const found = await service.search({ query: "alpha bravo", limit: 10 });

                expect(found.results.map((result) => result.session.sessionId)).toEqual([togetherId]);
                // The negative control: a reader that cannot promise line-local records still
                // pays for the transcript that only holds each word apart.
                expect(scanned.map((path) => basename(path)).sort()).toEqual(
                    lineLocalRecords ? [`${togetherId}.jsonl`] : [`${apartId}.jsonl`, `${togetherId}.jsonl`]
                );
            } finally {
                database.close();
            }
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a scoped content search still reads a source the index places out of scope once it changes", async () => {
    // The scope pre-check drops an indexed source that is out of scope only while its fingerprint
    // still matches the index. Appending a newer record must bring it back for a --since search.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "history-index-scope-")));
    const project = join(root, "-projects-fixture");
    const staleId = "11111111-2222-4333-8444-000000000003";
    const grownId = "11111111-2222-4333-8444-000000000004";
    const grown = join(project, `${grownId}.jsonl`);
    mkdirSync(project, { recursive: true });
    writeFileSync(
        join(project, `${staleId}.jsonl`),
        claudeRow({ id: staleId, text: "scopeword early", timestamp: "2026-01-10T00:00:00Z" })
    );
    writeFileSync(grown, claudeRow({ id: grownId, text: "scopeword early", timestamp: "2026-01-11T00:00:00Z" }));
    const { database, service } = createService({
        providerId: "anthropic-sub",
        reader: claudeHistoryReader,
        roots: [root],
    });
    const since = new Date("2026-06-01T00:00:00Z");
    const ids = async (filters: AgentSearchFilters) =>
        (await service.search(filters)).results.map((result) => result.session.sessionId).sort();

    try {
        await service.sync();

        expect(await ids({ query: "scopeword" })).toEqual([staleId, grownId]);
        expect(await ids({ query: "scopeword", since })).toEqual([]);

        appendFileSync(grown, claudeRow({ id: grownId, text: "scopeword later", timestamp: "2026-09-01T00:00:00Z" }));

        expect(await ids({ query: "scopeword", since })).toEqual([grownId]);
    } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
    }
});
