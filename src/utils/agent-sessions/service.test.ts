import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SafeJSON } from "@genesiscz/utils/json";
import { initializeCompactHistorySchema } from "./migrations";
import { createClaudeHistoryOperations } from "./readers/claude";
import { discoverClaudeHistorySources } from "./readers/claude-discovery";
import { fallbackTitle, HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";
import { type BaselineOracle, createBaselineOracle } from "./testing/baseline-oracle";
import { generateHistoryCorpus } from "./testing/corpus";
import { createFixtureWorld } from "./testing/fixture-world";
import { withBaseline } from "./testing/with-baseline";
import type { NativeSessionReader, NativeSessionSource } from "./types";

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
