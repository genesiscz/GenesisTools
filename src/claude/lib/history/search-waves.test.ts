import { describe, expect, it } from "bun:test";
import {
    agentFillListingOptions,
    agentWaveStopAfter,
    canUseMetadataListing,
    listingIndexSlice,
    listingPassesDate,
    listingStalePaths,
    listingWavePlan,
    mergeSearchWaves,
    ranksByRelevance,
    relevanceParseCap,
    selectRelevanceParseFiles,
    shouldLoadAgentListing,
} from "./search";
import type { SearchResult } from "./types";

function result(overrides: Partial<SearchResult> & Pick<SearchResult, "sessionId" | "isSubagent">): SearchResult {
    return {
        filePath: `/tmp/${overrides.sessionId}.jsonl`,
        project: "GenesisTools",
        timestamp: overrides.timestamp ?? new Date("2026-08-28T12:00:00.000Z"),
        matchedMessages: [],
        ...overrides,
    };
}

describe("listingWavePlan", () => {
    it("scans main sessions first and only loads agents when the limit is short", () => {
        expect(listingWavePlan({ limit: 5 })).toEqual({
            excludeSubagents: true,
            needAgentFill: true,
            subagentsOnly: false,
        });
        expect(shouldLoadAgentListing({ excludeSubagents: true, needAgentFill: true }, 5, 5)).toBe(false);
        expect(shouldLoadAgentListing({ excludeSubagents: true, needAgentFill: true }, 2, 5)).toBe(true);
        // Regression test: stress #18 — date-filtered mains < limit filled from
        // getSessionListing({ excludeSubagents: false }) and re-indexed ~11k agents.
        expect(agentFillListingOptions(undefined, 3)).toEqual({
            project: undefined,
            excludeSubagents: false,
            subagentsOnly: true,
            limit: 3,
        });
        expect(listingWavePlan({ agentsOnly: true, limit: 5 })).toEqual({
            excludeSubagents: false,
            needAgentFill: false,
            subagentsOnly: true,
        });
    });

    // Regression test: stress #5 — a mains listing treated every cached subagent
    // path as deleted, wiped them, then --agents-only re-indexed ~11k files (10s).
    it("does not treat cached subagent files as stale during a mains-only listing", () => {
        const main = "/tmp/proj/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl";
        const agent = "/tmp/proj/subagents/agent-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jsonl";

        expect(
            listingStalePaths({
                cachedPaths: [main, agent],
                diskFiles: new Set([main]),
                excludeSubagents: true,
            })
        ).toEqual([]);
    });

    // Regression test: stress #5 — --agents-only --limit 5 indexed every subagent
    // jsonl (~11k, ~10s) even though the listing only returns 5 rows.
    it("indexes only the newest slice of files when a listing has a limit", () => {
        const entries = Array.from({ length: 100 }, (_, i) => ({ path: `${i}.jsonl`, mtime: i }));
        const sliced = listingIndexSlice(entries, 5);

        expect(sliced).toHaveLength(20);
        expect(sliced[0].path).toBe("99.jsonl");
        expect(sliced[19].path).toBe("80.jsonl");
    });

    it("does not stale-delete nested jsonl files a mains listing never scanned", () => {
        const main = "/tmp/proj/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl";
        const nested = "/tmp/proj/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/extra.jsonl";

        expect(
            listingStalePaths({
                cachedPaths: [main, nested],
                diskFiles: new Set([main]),
                excludeSubagents: true,
            })
        ).toEqual([]);
    });

    it("drops listing rows older than --since", () => {
        const since = new Date("2026-08-20T00:00:00.000Z");
        expect(listingPassesDate(new Date("2026-08-28T00:00:00.000Z"), { since })).toBe(true);
        expect(listingPassesDate(new Date("2026-08-01T00:00:00.000Z"), { since })).toBe(false);
    });

    it("caps relevance scoring to 10 files at limit 5", () => {
        expect(relevanceParseCap(5000, 5)).toBe(10);
        expect(relevanceParseCap(50, 5)).toBe(10);
        expect(relevanceParseCap(3, 5)).toBe(3);
    });

    // Regression test: stress #15 — the time-ordered search parsed every capped
    // agent file even when mains already filled --limit, then mergeSearchWaves
    // dropped them.
    it("skips the agent wave when mains already fill a time-ordered limit", () => {
        expect(agentWaveStopAfter({ limit: 5, mainHitCount: 5, sortByRelevance: false })).toBe(0);
        expect(agentWaveStopAfter({ limit: 5, mainHitCount: 3, sortByRelevance: false })).toBe(2);
    });

    // PR #343 review t20. The stress-#15 optimisation was written while
    // mergeSearchWaves sorted each wave separately, so skipped agents really
    // were discarded. Once relevance became a GLOBAL ranking the same skip
    // truncated the candidate set before ranking, and a stronger subagent could
    // no longer outrank a weak main. Relevance must parse both waves.
    it("never caps the agent wave when ranking by relevance", () => {
        expect(agentWaveStopAfter({ limit: 5, mainHitCount: 5, sortByRelevance: true })).toBeUndefined();
        expect(agentWaveStopAfter({ limit: 5, mainHitCount: 2, sortByRelevance: true })).toBeUndefined();
    });

    // PR #343 review t2 round 7. The caller passes the EFFECTIVE mode, which is
    // `sortByRelevance && query` — the same predicate mergeSearchWaves gets.
    // `history --sort-relevance` with no query merges in time order, so it must
    // keep the optimisation rather than parse the full agent wave for nothing.
    it("keeps the cap for --sort-relevance with no query, which merges in time order", () => {
        // Composed through the SHARED predicate, the same one searchConversations
        // feeds to both the cap and the merge — so this pins the wiring, not just
        // agentWaveStopAfter's own contract.
        expect(
            agentWaveStopAfter({
                limit: 5,
                mainHitCount: 5,
                sortByRelevance: ranksByRelevance({ sortByRelevance: true }),
            })
        ).toBe(0);
        expect(
            agentWaveStopAfter({
                limit: 5,
                mainHitCount: 5,
                sortByRelevance: ranksByRelevance({ sortByRelevance: true, query: "auth" }),
            })
        ).toBeUndefined();
    });

    it("ranksByRelevance needs BOTH the flag and a query", () => {
        expect(ranksByRelevance({ sortByRelevance: true, query: "auth" })).toBe(true);
        expect(ranksByRelevance({ sortByRelevance: true })).toBe(false);
        expect(ranksByRelevance({ sortByRelevance: true, query: "" })).toBe(false);
        expect(ranksByRelevance({ query: "auth" })).toBe(false);
        expect(ranksByRelevance({})).toBe(false);
    });

    // Regression test: stress #15 — --sort-relevance parsed the 200 newest files,
    // so an older high-hit session lost to a newer one-mention session.
    it("ranks relevance parse candidates by match count before recency", () => {
        const picked = selectRelevanceParseFiles(
            [
                { path: "/tmp/new-low.jsonl", mtime: 200, matchCount: 1 },
                { path: "/tmp/old-high.jsonl", mtime: 100, matchCount: 50 },
            ],
            5
        );

        expect(picked).toEqual(["/tmp/old-high.jsonl", "/tmp/new-low.jsonl"]);
    });

    // Regression test: stress #15 — uncapped rg counts preferred a huge old
    // session over a newer file that already had plenty of hits.
    it("treats match counts above 20 as a tie so recency decides among rich files", () => {
        const picked = selectRelevanceParseFiles(
            [
                { path: "/tmp/old-whale.jsonl", mtime: 100, matchCount: 5000 },
                { path: "/tmp/new-rich.jsonl", mtime: 200, matchCount: 20 },
            ],
            1
        );

        expect(picked).toEqual(["/tmp/new-rich.jsonl", "/tmp/old-whale.jsonl"]);
    });
});

describe("mergeSearchWaves", () => {
    it("keeps a main session ahead of a newer subagent when filling the limit", () => {
        const mains = [
            result({
                sessionId: "main-old",
                isSubagent: false,
                timestamp: new Date("2026-08-28T10:00:00.000Z"),
            }),
        ];
        const agents = [
            result({
                sessionId: "agent-new",
                isSubagent: true,
                timestamp: new Date("2026-08-28T18:00:00.000Z"),
            }),
        ];

        const merged = mergeSearchWaves(mains, agents, { limit: 1 });

        expect(merged).toHaveLength(1);
        expect(merged[0].sessionId).toBe("main-old");
    });

    it("fills remaining limit slots with subagents after mains", () => {
        const mains = [
            result({
                sessionId: "main-a",
                isSubagent: false,
                timestamp: new Date("2026-08-28T10:00:00.000Z"),
            }),
        ];
        const agents = [
            result({
                sessionId: "agent-b",
                isSubagent: true,
                timestamp: new Date("2026-08-28T18:00:00.000Z"),
            }),
        ];

        const merged = mergeSearchWaves(mains, agents, { limit: 2 });

        expect(merged.map((s) => s.sessionId)).toEqual(["main-a", "agent-b"]);
    });
});

describe("canUseMetadataListing", () => {
    it("takes the fast path for a plain listing", () => {
        expect(canUseMetadataListing({})).toBe(true);
        expect(canUseMetadataListing({ since: new Date(0) })).toBe(true);
    });

    it("refuses the fast path for filters the listing cannot apply", () => {
        // PR #343 review t17: these silently returned UNFILTERED results,
        // because the listing branch only ever applied since/until.
        expect(canUseMetadataListing({ excludeCurrentSession: "abc" })).toBe(false);
        expect(canUseMetadataListing({ conversationDate: new Date(0) })).toBe(false);
        expect(canUseMetadataListing({ conversationDateUntil: new Date(0) })).toBe(false);
    });
});

describe("mergeSearchWaves relevance ordering", () => {
    const at = (ms: number, score: number, isSubagent: boolean): SearchResult =>
        ({ timestamp: new Date(ms), relevanceScore: score, isSubagent }) as SearchResult;

    it("ranks a stronger subagent above a weaker main when sorting by relevance", () => {
        // PR #343 review t21: sorting each wave and concatenating kept the weak
        // main first, so --limit 1 dropped the actual best match.
        const merged = mergeSearchWaves([at(1, 1, false)], [at(2, 9, true)], { sortByRelevance: true, limit: 1 });

        expect(merged).toHaveLength(1);
        expect(merged[0].relevanceScore).toBe(9);
    });

    it("keeps mains first when sorting by time", () => {
        const merged = mergeSearchWaves([at(1, 1, false)], [at(2, 9, true)], { sortByRelevance: false });

        expect(merged[0].isSubagent).toBe(false);
    });
});
