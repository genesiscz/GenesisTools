import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DailyStats } from "@genesiscz/utils/agent-sessions/cache-types";
import type {
    HistoryStatisticsRead,
    NativeSessionReader,
    NativeSessionSource,
} from "@genesiscz/utils/agent-sessions/types";
import type { FileIndexRecord } from "@genesiscz/utils/claude/history-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { SearchFilters, SearchResult } from "./types";

type Reader = NativeSessionReader<string>;

interface Catalog {
    metadata: Array<Record<string, unknown>>;
    report: { parsed: number; removed: number };
    reindexed: boolean;
}

interface State {
    indexedSearches: Array<{ filters: SearchFilters }>;
    indexedResults: SearchResult[];
    indexedConversation: SearchResult | null;
    conversationRequests: Array<{ sessionId: string }>;
    catalogCalls: Array<Record<string, unknown>>;
    catalog: Catalog;
    projectDirs: Record<string, string | undefined>;
    reader: Reader | null;
    fileIndex: Record<string, FileIndexRecord | null>;
    refreshCalls: Array<{ options: Record<string, unknown> | undefined; roots: string[] | undefined }>;
    refresh: { issues: Array<{ path: string; message: string }>; coverage: string };
    onRefresh: () => void;
    cacheMeta: Array<[string, string]>;
    dailyStats: DailyStats[];
    dailyRanges: Array<Record<string, string | undefined>>;
    projectCountRanges: Array<unknown>;
    projectCounts: Record<string, number>;
    lengths: number[];
    totals: { totalConversations: number; totalMessages: number; totalSubagents: number; projectCount: number } | null;
}

const projectsDir = mkdtempSync(join(tmpdir(), "gt-claude-search-"));
const root = realpathSync(projectsDir);

const state: State = {
    indexedSearches: [],
    indexedResults: [],
    indexedConversation: null,
    conversationRequests: [],
    catalogCalls: [],
    catalog: { metadata: [], report: { parsed: 0, removed: 0 }, reindexed: false },
    projectDirs: {},
    reader: null,
    fileIndex: {},
    refreshCalls: [],
    refresh: { issues: [], coverage: "complete" },
    onRefresh: () => undefined,
    cacheMeta: [],
    dailyStats: [],
    dailyRanges: [],
    projectCountRanges: [],
    projectCounts: {},
    lengths: [],
    totals: null,
};

const realOpenService = await import("@genesiscz/utils/agent-sessions/open-service");
const realProvider = await import("@genesiscz/utils/agent-sessions/provider");
const realCache = await import("@genesiscz/utils/claude/history-cache");
const realProjects = await import("@genesiscz/utils/claude/projects");
const realIndexed = await import("./indexed-search");

mock.module("./indexed-search", () => ({
    ...realIndexed,
    searchIndexedClaudeHistory: async (options: { filters: SearchFilters }) => {
        state.indexedSearches.push(options);
        return state.indexedResults;
    },
    getIndexedClaudeConversation: async (options: { sessionId: string }) => {
        state.conversationRequests.push(options);
        return state.indexedConversation;
    },
}));
mock.module("@genesiscz/utils/agent-sessions/open-service", () => ({
    ...realOpenService,
    catalogHistory: async (options: Record<string, unknown>) => {
        state.catalogCalls.push(options);
        return state.catalog;
    },
    openHistoryService: (options: { roots?: string[] }) => ({
        refreshStatistics: async (refreshOptions?: Record<string, unknown>) => {
            state.refreshCalls.push({ options: refreshOptions, roots: options.roots });
            state.onRefresh();
            return state.refresh;
        },
    }),
}));
mock.module("@genesiscz/utils/agent-sessions/provider", () => ({
    ...realProvider,
    resolveHistoryProvider: () => {
        if (!state.reader) {
            throw new Error("no reader in this test");
        }

        return { id: "claude", reader: state.reader };
    },
}));
mock.module("@genesiscz/utils/claude/projects", () => ({
    ...realProjects,
    PROJECTS_DIR: projectsDir,
    resolveProjectDir: (project: string) => state.projectDirs[project],
}));
mock.module("@genesiscz/utils/claude/history-cache", () => ({
    ...realCache,
    getFileIndex: (filePath: string) => state.fileIndex[filePath] ?? null,
    setCacheMeta: (key: string, value: string) => {
        state.cacheMeta.push([key, value]);
    },
    getDailyStatsInRange: (range: Record<string, string | undefined>) => {
        state.dailyRanges.push(range);
        return state.dailyStats;
    },
    getFileIndexProjectCounts: (range?: unknown) => {
        state.projectCountRanges.push(range);
        return state.projectCounts;
    },
    getFileIndexConversationLengths: () => state.lengths,
    getCachedTotals: () => state.totals,
}));

const search = await import("./search");

afterAll(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

function metadata(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        filePath: "/tmp/fixture/a.jsonl",
        sessionId: "s-a",
        customTitle: null,
        summary: null,
        firstPrompt: null,
        gitBranch: null,
        project: "widgets",
        cwd: null,
        mtime: 1,
        firstTimestamp: null,
        isSubagent: false,
        allUserText: null,
        ...overrides,
    };
}

function result(sessionId: string, types: string[]): SearchResult {
    return {
        filePath: `/tmp/fixture/${sessionId}.jsonl`,
        project: "widgets",
        sessionId,
        timestamp: new Date("2026-03-01T10:00:00.000Z"),
        isSubagent: false,
        matchedMessages: types.map((type) => SafeJSON.parse(`{"type":"${type}"}`)),
    };
}

function indexed(filePath: string, mtime: number): FileIndexRecord {
    return {
        filePath,
        mtime,
        messageCount: 1,
        firstDate: null,
        lastDate: null,
        project: "widgets",
        isSubagent: false,
        lastIndexed: "2026-03-01T10:00:00.000Z",
    };
}

const tokens = (n: number) => ({ inputTokens: n, outputTokens: n * 2, cacheCreateTokens: 0, cacheReadTokens: 1 });

function day(date: string, extra: Partial<DailyStats> = {}): DailyStats {
    return {
        date,
        project: "widgets",
        conversations: 1,
        messages: 10,
        subagentSessions: 0,
        toolCounts: { Read: 2 },
        hourlyActivity: { "10": 4 },
        tokenUsage: tokens(5),
        modelCounts: { "claude-test-1": 1 },
        branchCounts: { main: 1 },
        ...extra,
    };
}

function source(filePath: string, sourceRoot = root): NativeSessionSource<string> {
    return {
        kind: "claude",
        root: sourceRoot,
        sourceHome: sourceRoot,
        filePath,
        dataPaths: [filePath],
        metadataPaths: [],
    };
}

function statistics(messages: number, extra: Partial<HistoryStatisticsRead["summary"]> = {}): HistoryStatisticsRead {
    return {
        summary: {
            conversations: 1,
            messages,
            subagentSessions: 0,
            toolCounts: { Read: messages },
            dailyActivity: { "2026-03-01": messages },
            hourlyActivity: { "10": messages },
            tokenUsage: tokens(messages),
            modelCounts: { "claude-test-1": 1 },
            branchCounts: { main: 1 },
            firstDate: "2026-03-01",
            lastDate: "2026-03-01",
            ...extra,
        },
        dailyTokens: { "2026-03-01": tokens(messages) },
        days: [],
        issues: [],
        complete: true,
    };
}

function reader(overrides: Partial<Reader> = {}): Reader {
    return {
        kind: "claude",
        parserVersion: "test",
        roots: () => [root],
        discover: async () => ({ sources: [], issues: [], completeRoots: [root] }),
        read: async () => {
            throw new Error("not used");
        },
        readStatistics: async () => statistics(1),
        ...overrides,
    };
}

function transcript(project: string, name: string, mtimeSeconds: number): string {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, "{}\n");
    utimesSync(path, mtimeSeconds, mtimeSeconds);
    return path;
}

let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;

beforeEach(() => {
    state.indexedSearches = [];
    state.indexedResults = [];
    state.indexedConversation = null;
    state.conversationRequests = [];
    state.catalogCalls = [];
    state.catalog = { metadata: [], report: { parsed: 0, removed: 0 }, reindexed: false };
    state.projectDirs = {};
    state.reader = reader();
    state.fileIndex = {};
    state.refreshCalls = [];
    state.refresh = { issues: [], coverage: "complete" };
    state.onRefresh = () => undefined;
    state.cacheMeta = [];
    state.dailyStats = [];
    state.dailyRanges = [];
    state.projectCountRanges = [];
    state.projectCounts = {};
    state.lengths = [];
    state.totals = null;
    warn = spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    warn.mockRestore();
});

describe("conversation lookups", () => {
    it("searchConversations hands the filters to the indexed search and returns its results", async () => {
        state.indexedResults = [result("s1", ["user"])];

        const found = await search.searchConversations({ query: "refund", limit: 3 });

        expect(found).toBe(state.indexedResults);
        expect(state.indexedSearches).toEqual([{ filters: { query: "refund", limit: 3 } }]);
    });

    it("getAllConversations forces full results and counts user and assistant messages", async () => {
        state.indexedResults = [result("s1", ["user", "assistant", "user", "summary"]), result("s2", [])];

        const all = await search.getAllConversations({ project: "widgets", summaryOnly: true });

        expect(state.indexedSearches[0].filters).toEqual({ project: "widgets", summaryOnly: false });
        expect(all.map((r) => [r.sessionId, r.userMessageCount, r.assistantMessageCount])).toEqual([
            ["s1", 2, 1],
            ["s2", 0, 0],
        ]);
    });

    it("getConversationBySessionId asks the indexed search for that id", async () => {
        state.indexedConversation = result("s9", ["user"]);

        expect(await search.getConversationBySessionId("s9")).toBe(state.indexedConversation);
        expect(state.conversationRequests).toEqual([{ sessionId: "s9" }]);
    });

    it("parseDate reads a calendar day as local midnight and relative phrases from now", () => {
        expect(search.parseDate("2026-03-01").getTime()).toBe(new Date(2026, 2, 1).getTime());

        // A frozen clock, and calendar days in local time: the day after a DST change is the case wall-clock
        // bounds got wrong, since "2 days ago" is then 47 or 49 hours back, not 48.
        try {
            for (const now of [new Date(2026, 5, 15, 12, 0, 0), new Date(2026, 2, 30, 12, 0, 0)]) {
                setSystemTime(now);
                const expected = new Date(now);
                expected.setDate(now.getDate() - 2);

                expect(search.parseDate("2 days ago").getTime()).toBe(expected.getTime());
                expect(search.parseDate("2 days ago").getHours()).toBe(12);
            }
        } finally {
            setSystemTime();
        }
    });
});

describe("getSessionListing", () => {
    const main = metadata({
        filePath: "/tmp/p/main.jsonl",
        sessionId: "main",
        firstTimestamp: "2026-03-01T10:00:00.000Z",
    });
    const newer = metadata({
        filePath: "/tmp/p/newer.jsonl",
        sessionId: "newer",
        firstTimestamp: "2026-03-02T10:00:00.000Z",
        project: "gadgets",
    });
    const undated = metadata({ filePath: "/tmp/p/undated.jsonl", sessionId: "undated", project: null });
    const agent = metadata({
        filePath: "/tmp/p/agent-1.jsonl",
        sessionId: "agent",
        isSubagent: true,
        firstTimestamp: "2026-03-03T10:00:00.000Z",
    });

    beforeEach(() => {
        state.catalog = { metadata: [main, newer, undated, agent], report: { parsed: 3, removed: 1 }, reindexed: true };
    });

    it("lists main sessions newest first, counting everything the catalog returned", async () => {
        const listing = await search.getSessionListing();

        expect(listing.sessions.map((s) => s.sessionId)).toEqual(["newer", "main", "undated"]);
        expect(listing).toMatchObject({
            total: 4,
            subagents: 1,
            indexed: 3,
            staleRemoved: 1,
            reindexed: true,
            projectCount: 2,
            scope: "all projects",
        });
        expect(state.catalogCalls[0]).toEqual({
            provider: "claude",
            filters: {
                project: undefined,
                excludeAgents: true,
                agentsOnly: false,
                limit: undefined,
                mtimeFrom: undefined,
                filePaths: undefined,
                newest: undefined,
            },
            maxDiscoveryAgeMs: undefined,
            refresh: undefined,
        });
    });

    it("includes subagent sessions when excludeSubagents is false", async () => {
        const listing = await search.getSessionListing({ excludeSubagents: false });

        expect(listing.sessions.map((s) => s.sessionId)).toEqual(["agent", "newer", "main", "undated"]);
        expect(state.catalogCalls[0].filters).toMatchObject({ excludeAgents: false, agentsOnly: false });
    });

    it("lists only subagent sessions with subagentsOnly", async () => {
        const listing = await search.getSessionListing({ subagentsOnly: true });

        expect(listing.sessions.map((s) => s.sessionId)).toEqual(["agent"]);
        expect(state.catalogCalls[0].filters).toMatchObject({ excludeAgents: false, agentsOnly: true });
    });

    it("limits the rows after sorting and passes the bounds to the catalog", async () => {
        const listing = await search.getSessionListing({
            limit: 2,
            mtimeFrom: 1_700_000_000_000,
            filePaths: ["/tmp/p/main.jsonl"],
            newest: 5,
            maxDiscoveryAgeMs: 60_000,
            refresh: false,
        });

        expect(listing.sessions.map((s) => s.sessionId)).toEqual(["newer", "main"]);
        expect(listing.total).toBe(4);
        expect(state.catalogCalls[0]).toMatchObject({
            maxDiscoveryAgeMs: 60_000,
            refresh: false,
            filters: { limit: 2, mtimeFrom: 1_700_000_000_000, filePaths: ["/tmp/p/main.jsonl"], newest: 5 },
        });
    });

    it("scopes the catalog to the project folder a project name resolves to", async () => {
        state.projectDirs = { widgets: join(projectsDir, "-work-widgets") };

        const listing = await search.getSessionListing({ project: "widgets" });

        expect(listing.scope).toBe("widgets");
        expect(state.catalogCalls[0].filters).toMatchObject({ project: "-work-widgets" });
    });

    it("searches every project when the name does not resolve", async () => {
        const listing = await search.getSessionListing({ project: "unknown" });

        expect(listing.scope).toBe("all projects");
        expect(state.catalogCalls[0].filters).toMatchObject({ project: undefined });
    });

    it("getAvailableProjects returns each project name once, sorted, including subagent sessions", async () => {
        state.catalog = {
            ...state.catalog,
            metadata: [main, newer, undated, metadata({ project: "gadgets", isSubagent: true })],
        };

        expect(await search.getAvailableProjects()).toEqual(["gadgets", "widgets"]);
        expect(state.catalogCalls[0].filters).toMatchObject({ excludeAgents: false });
    });
});

describe("getConversationStats", () => {
    it("aggregates every source, newest file first, under the project name of its folder", async () => {
        const older = transcript("-work-widgets", "old.jsonl", 1_000);
        const newer = transcript("-work-widgets", "new.jsonl", 2_000);
        const other = transcript("-work-gadgets", "g.jsonl", 1_500);
        const bySource = new Map([
            [older, statistics(5)],
            [newer, statistics(3)],
            [other, statistics(7)],
        ]);
        state.reader = reader({
            discover: async () => ({
                sources: [source(older), source(newer), source(other)],
                issues: [],
                completeRoots: [root],
            }),
            readStatistics: async (src) => bySource.get(src.filePath) ?? statistics(0),
        });

        const stats = await search.getConversationStats();

        expect(stats.totalConversations).toBe(3);
        expect(stats.totalMessages).toBe(15);
        expect(stats.conversationLengths).toEqual([3, 7, 5]);
        expect(stats.projectCounts).toEqual({ widgets: 2, gadgets: 1 });
        expect(stats.toolCounts).toEqual({ Read: 15 });
        expect(stats.tokenUsage).toEqual({
            inputTokens: 15,
            outputTokens: 30,
            cacheCreateTokens: 0,
            cacheReadTokens: 3,
        });
        expect(stats.modelCounts).toEqual({ "claude-test-1": 3 });
        expect(warn).not.toHaveBeenCalled();
    });

    it("keeps going and logs which source could not be read or stated", async () => {
        const good = transcript("-work-widgets", "good.jsonl", 1_000);
        const unreadable = transcript("-work-widgets", "bad.jsonl", 900);
        const vanished = join(root, "-work-widgets", "vanished.jsonl");
        state.reader = reader({
            discover: async () => ({
                sources: [source(good), source(unreadable), source(vanished)],
                issues: [{ path: "/tmp/p/skipped.jsonl", message: "discovery issue" }],
                completeRoots: [root],
            }),
            readStatistics: async (src) => {
                if (src.filePath === unreadable) {
                    throw new Error("parse failed");
                }

                return statistics(4);
            },
        });

        const stats = await search.getConversationStats();

        expect(stats.totalMessages).toBe(4);
        expect(warn).toHaveBeenCalledTimes(1);

        const [fields, message] = warn.mock.calls[0] as unknown as [
            { issues: Array<{ path: string; message: string }> },
            string,
        ];
        expect(message).toBe("Claude uncached statistics skipped malformed or unavailable source records");
        expect(fields.issues.map((i) => i.path).sort()).toEqual([unreadable, vanished, "/tmp/p/skipped.jsonl"].sort());
        expect(fields.issues.find((i) => i.path === vanished)?.message).toStartWith("Could not stat source:");
        expect(fields.issues.find((i) => i.path === unreadable)?.message).toContain(
            "Could not read statistics: Error: parse failed"
        );
    });

    it("fails clearly when the Claude reader cannot read statistics", async () => {
        state.reader = reader({ readStatistics: undefined });

        await expect(search.getConversationStats()).rejects.toThrow("Claude native history statistics are unavailable");
    });
});

describe("file statistics", () => {
    it("computeFileStats reads the canonical file through the root that contains it", async () => {
        const file = transcript("-work-widgets", "one.jsonl", 1_000);
        const seen: NativeSessionSource<string>[] = [];
        state.reader = reader({
            readStatistics: async (src) => {
                seen.push(src);
                return statistics(6);
            },
        });

        const stats = await search.computeFileStats(file);

        expect(seen).toEqual([{ ...source(file), sourceHome: dirname(root) }]);
        expect(stats.messages).toBe(6);
        expect(stats.toolCounts).toEqual({ Read: 6 });
        expect(stats.tokenUsage).toEqual(tokens(6));
    });

    it("computeFileStats falls back to a zero token usage when the file has none", async () => {
        const file = transcript("-work-widgets", "none.jsonl", 1_000);
        state.reader = reader({ readStatistics: async () => statistics(2, { tokenUsage: null }) });

        const stats = await search.computeFileStats(file);

        expect(stats.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 });
    });

    it("computeFileStats derives the root from the project folder when no configured root contains the file", async () => {
        const file = transcript("-work-gadgets", "two.jsonl", 1_000);
        const seen: NativeSessionSource<string>[] = [];
        state.reader = reader({
            roots: () => ["/somewhere/else"],
            readStatistics: async (src) => {
                seen.push(src);
                return statistics(1);
            },
        });

        await search.computeFileStats(file);

        expect(seen[0].root).toBe(root);
        expect(seen[0].sourceHome).toBe(dirname(root));
    });

    it("computeFileStats uses the projects dir when the file sits under no project folder", async () => {
        const dir = join(root, "plain-folder");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "three.jsonl");
        writeFileSync(file, "{}\n");
        const seen: NativeSessionSource<string>[] = [];
        state.reader = reader({
            roots: () => [],
            readStatistics: async (src) => {
                seen.push(src);
                return statistics(1);
            },
        });

        await search.computeFileStats(file);

        expect(seen[0].root).toBe(projectsDir);
    });

    it("processFileForCache skips a file whose indexed modification time is current", async () => {
        const file = transcript("-work-widgets", "cached.jsonl", 3_000);
        state.fileIndex[realpathSync(file)] = indexed(file, 3_000_000);

        expect(await search.processFileForCache(file)).toBeNull();
        expect(state.refreshCalls).toEqual([]);
    });

    it("processFileForCache refreshes the index and returns the new statistics", async () => {
        const file = transcript("-work-widgets", "fresh.jsonl", 4_000);
        const canonical = realpathSync(file);
        state.onRefresh = () => {
            state.fileIndex[canonical] = indexed(canonical, 4_000_000);
        };

        const stats = await search.processFileForCache(file);

        expect(stats?.messages).toBe(1);
        expect(state.refreshCalls).toEqual([{ options: undefined, roots: [root] }]);
    });

    it("processFileForCache returns null when the refresh did not index the file", async () => {
        const file = transcript("-work-widgets", "unindexed.jsonl", 5_000);

        expect(await search.processFileForCache(file)).toBeNull();
        expect(state.refreshCalls).toHaveLength(1);
    });

    it("processFileForCache logs and returns null when the file cannot be read", async () => {
        const missing = join(root, "-work-widgets", "missing.jsonl");

        expect(await search.processFileForCache(missing)).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toBe("Claude statistics compatibility refresh failed");
    });
});

describe("cached statistics", () => {
    it("getConversationStatsWithCache refreshes the index and aggregates the cached days", async () => {
        state.dailyStats = [day("2026-03-01"), day("2026-03-02", { messages: 20, subagentSessions: 1 })];
        state.projectCounts = { widgets: 2 };
        state.lengths = [10, 20];
        const progress: number[] = [];
        const onProgress = (processed: number) => progress.push(processed);

        const stats = await search.getConversationStatsWithCache({
            forceRefresh: true,
            dateRange: { from: "2026-03-01", to: "2026-03-02" },
            onProgress,
        });

        expect(state.refreshCalls).toEqual([{ options: { force: true, onProgress }, roots: undefined }]);
        expect(state.dailyRanges).toEqual([{ from: "2026-03-01", to: "2026-03-02" }]);
        expect(stats).toMatchObject({
            totalConversations: 2,
            totalMessages: 30,
            subagentCount: 1,
            projectCounts: { widgets: 2 },
            toolCounts: { Read: 4 },
            dailyActivity: { "2026-03-01": 10, "2026-03-02": 20 },
            conversationLengths: [10, 20],
            modelCounts: { "claude-test-1": 2 },
            branchCounts: { main: 2 },
        });
        expect(stats.tokenUsage).toEqual({
            inputTokens: 10,
            outputTokens: 20,
            cacheCreateTokens: 0,
            cacheReadTokens: 2,
        });
        expect(stats.dailyTokens["2026-03-02"]).toEqual(tokens(5));
    });

    it("getConversationStatsWithCache stamps the full-update time only when the refresh was complete", async () => {
        await search.getConversationStatsWithCache();
        expect(state.cacheMeta.map(([key]) => key)).toEqual(["last_full_update"]);
        expect(Number.isNaN(Date.parse(state.cacheMeta[0][1]))).toBe(false);

        state.cacheMeta = [];
        state.refresh = { issues: [], coverage: "partial" };
        await search.getConversationStatsWithCache();
        expect(state.cacheMeta).toEqual([]);
        expect(state.refreshCalls.at(-1)?.options).toEqual({ force: false, onProgress: undefined });
        expect(state.dailyRanges.at(-1)).toEqual({});
    });

    it("getConversationStatsWithCache warns about sources the refresh could not finish", async () => {
        state.refresh = { issues: [{ path: "/tmp/p/x.jsonl", message: "truncated" }], coverage: "partial" };

        await search.getConversationStatsWithCache();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toBe("Claude statistics retain previous aggregates for incomplete sources");
    });

    it("getQuickStatsFromCache reports nothing for an empty cache and renames the subagent total otherwise", () => {
        expect(search.getQuickStatsFromCache()).toBeNull();

        state.totals = { totalConversations: 8, totalMessages: 90, totalSubagents: 3, projectCount: 2 };
        expect(search.getQuickStatsFromCache()).toEqual({
            totalConversations: 8,
            totalMessages: 90,
            subagentCount: 3,
            projectCount: 2,
        });
    });

    it("getStatsForDateRange answers from the cache when the range has cached days", async () => {
        state.dailyStats = [day("2026-03-01")];
        state.projectCounts = { widgets: 1 };
        state.lengths = [10];
        const range = { from: "2026-03-01", to: "2026-03-01" };

        const stats = await search.getStatsForDateRange(range);

        expect(stats.totalMessages).toBe(10);
        expect(stats.projectCounts).toEqual({ widgets: 1 });
        expect(stats.conversationLengths).toEqual([10]);
        expect(state.projectCountRanges).toEqual([range]);
        expect(state.refreshCalls).toEqual([]);
    });

    it("getStatsForDateRange recomputes through the refresh when the range has no cached days", async () => {
        const range = { from: "2026-04-01", to: "2026-04-02" };

        const stats = await search.getStatsForDateRange(range);

        expect(stats.totalMessages).toBe(0);
        expect(state.refreshCalls).toHaveLength(1);
        expect(state.dailyRanges).toEqual([range, range]);
    });
});
