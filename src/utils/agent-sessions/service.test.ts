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
import { claudeMidWork } from "./readers/claude-mid-work";
import { claudeClassifyPath, claudeReadSpawnLink } from "./readers/claude-paths";
import { fallbackTitle, HistoryService } from "./service";
import { HistorySyncRepository } from "./sync-repository";
import { type BaselineOracle, createBaselineOracle } from "./testing/baseline-oracle";
import { generateHistoryCorpus } from "./testing/corpus";
import { createFixtureWorld } from "./testing/fixture-world";
import { noAnalysis, noStatistics } from "./testing/no-backward-read";
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
        windowTurns: () => [],
        ...operations,
        dialog: {
            eventLogPath: () => null,
            openPermission: () => null,
            sessionAlive: () => null,
            registryDirectory: () => null,
            pendingCall: () => null,
        },
        scanInsights: () => ({ native: null, defaultModel: null }),
        analysis: noAnalysis,
        readStatistics: noStatistics,
        classifyPath: claudeClassifyPath,
        midWork: claudeMidWork,
        readSpawnLink: claudeReadSpawnLink,
        readChanges: () => null,
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

test("a fourth provider's catalog applies each agent flag and the limit to the rows it returns", async () => {
    const world = await createFixtureWorld();
    const reader = createReader({ kind: "fixture-fourth", roots: [world.sources.claude] });
    const { database, service } = createService({
        providerId: "fixture-fourth-provider",
        reader,
        roots: [world.sources.claude],
        now: () => world.now,
    });
    try {
        await generateHistoryCorpus({
            root: world.root,
            seed: 59,
            sessionCount: 3,
            recordCount: 3,
            distribution: { main: 2, subagent: 1 },
        });
        const all = (await service.catalog({})).metadata;
        const main = (await service.catalog({ excludeAgents: true }, { refresh: false })).metadata;
        const agents = (await service.catalog({ agentsOnly: true }, { refresh: false })).metadata;
        const limited = (await service.catalog({ limit: 2 }, { refresh: false })).metadata;

        expect(all.map((row) => row.isSubagent).sort()).toEqual([false, false, true]);
        expect(main.map((row) => row.isSubagent)).toEqual([false, false]);
        expect(agents.map((row) => row.isSubagent)).toEqual([true]);
        expect(limited.map((row) => row.sourceKey)).toEqual(all.slice(0, 2).map((row) => row.sourceKey));
        expect(await service.catalogCounts({ agentsOnly: true, limit: 1 }, { refresh: false })).toEqual({
            total: 3,
            subagents: 1,
        });
    } finally {
        database.close();
        await world.dispose();
    }
});

test("catalogCounts counts the rows catalog returns for every scope term and the top-up, and reads no row out", async () => {
    const database = new Database(":memory:");
    initializeCompactHistorySchema(database);
    const repository = new HistorySyncRepository(database);
    const root = "/history/projects";
    const service = new HistoryService({
        providerId: "anthropic-sub",
        reader: createReader({ kind: "claude", roots: [root] }),
        roots: [root],
        repository,
    });
    const row = (
        key: string,
        values: {
            filePath: string;
            root?: string;
            provider?: string;
            subagent?: boolean;
            project?: string;
            projectDirectory?: string;
            cwd?: string;
            mtime: number;
            first?: string;
            last?: string;
            sessionId?: string | null;
        }
    ) => {
        const provider = values.provider ?? "anthropic-sub";
        database
            .query(
                `INSERT INTO session_metadata (source_key, provider, file_path, session_id, native_id, project, cwd, mtime,
                    first_timestamp, last_timestamp, project_directory, is_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                key,
                provider,
                values.filePath,
                values.sessionId === undefined ? `s-${key}` : values.sessionId,
                `n-${key}`,
                values.project ?? null,
                values.cwd ?? null,
                values.mtime,
                values.first ?? null,
                values.last ?? null,
                values.projectDirectory ?? null,
                values.subagent ? 1 : 0
            );

        if (values.root !== undefined) {
            database
                .query(
                    "INSERT INTO file_index (source_key, provider, file_path, mtime, root, last_indexed) VALUES (?, ?, ?, ?, ?, 0)"
                )
                .run(key, provider, values.filePath, values.mtime, values.root);
        }
    };
    const gt = { project: "GenesisTools", projectDirectory: "-Users-alice-GenesisTools", cwd: "/w/gt" };
    const shop = { project: "Shop", projectDirectory: "-Users-alice-Shop", cwd: "/w/shop" };
    row("a", {
        ...gt,
        filePath: `${root}/a.jsonl`,
        root,
        mtime: 9000,
        first: "2026-11-01T10:00:00.000Z",
        last: "2026-11-01T11:00:00.000Z",
    });
    row("b", {
        ...gt,
        projectDirectory: "-Users-alice-GenesisTools--claude-worktrees-x",
        filePath: `${root}/b.jsonl`,
        root,
        subagent: true,
        mtime: 8000,
        first: "2026-11-02T10:00:00.000Z",
    });
    // No recorded root: in scope by its path.
    row("c", { ...shop, filePath: `${root}/sub/c.jsonl`, mtime: 7000 });
    row("d", { ...gt, filePath: "/elsewhere/d.jsonl", root: "/elsewhere", mtime: 6000 });
    // Recorded under another root, but its path is under the scope root.
    row("e", {
        ...shop,
        filePath: `${root}/e.jsonl`,
        root: "/elsewhere",
        subagent: true,
        mtime: 5000,
        first: "2026-10-01T10:00:00.000Z",
        last: "2026-10-01T12:00:00.000Z",
    });
    row("f", { filePath: `${root}/f.jsonl`, root, mtime: 4000, first: "not a date", sessionId: "skip-me" });
    row("g", {
        ...gt,
        projectDirectory: "-Users-alice-GenesisToolsExtra",
        filePath: `${root}/g.jsonl`,
        root,
        subagent: true,
        mtime: 100,
        first: "2026-09-01T10:00:00.000Z",
        sessionId: null,
    });
    row("h", { ...gt, provider: "openai-sub", filePath: `${root}/h.jsonl`, root, mtime: 9500 });

    const listMetadata = repository.metadata.listMetadata.bind(repository.metadata);
    let listed = 0;
    repository.metadata.listMetadata = (options) => {
        listed++;
        return listMetadata(options);
    };
    const scopes: AgentSearchFilters[] = [
        {},
        { project: "GenesisTools" },
        { project: "-Users-alice-GenesisTools" },
        { project: "alice-Gen" },
        { project: "Shop", all: true },
        { cwd: "/w/gt" },
        { excludeSessions: ["skip-me", "n-a", "b"] },
        { since: new Date("2026-10-15T00:00:00.000Z") },
        { until: new Date("2026-10-15T00:00:00.000Z"), project: "Shop" },
        { mtimeFrom: 6500, newest: 2 },
        { mtimeFrom: 6500, newest: 5, cwd: "/w/shop" },
        { filePaths: [`${root}/a.jsonl`, `${root}/e.jsonl`, "/elsewhere/d.jsonl"] },
        { filePaths: [`${root}/e.jsonl`] },
        { sourceRoots: ["/elsewhere"] },
        { agentsOnly: true, limit: 1 },
    ];

    try {
        for (const filters of scopes) {
            listed = 0;
            const counts = await service.catalogCounts(filters, { refresh: false });
            expect({ filters, listed }).toEqual({ filters, listed: 0 });

            const all = { ...filters, excludeAgents: undefined, agentsOnly: undefined, limit: undefined };
            const rows = (await service.catalog(all, { refresh: false })).metadata;
            expect({ filters, counts }).toEqual({
                filters,
                counts: { total: rows.length, subagents: rows.filter((entry) => entry.isSubagent).length },
            });
        }

        expect(await service.catalogCounts({}, { refresh: false })).toEqual({ total: 6, subagents: 3 });
        expect(await service.catalogCounts({ mtimeFrom: 6500, newest: 2 }, { refresh: false })).toEqual({
            total: 5,
            subagents: 2,
        });
    } finally {
        database.close();
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
