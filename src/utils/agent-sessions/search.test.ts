import { describe, expect, test } from "bun:test";
import { searchSessions } from "./search";
import type { AgentSearchFilters, AgentSearchHit, AgentSessionAdapter } from "./types";

// One query over every provider's adapter, with injected fake adapters: no index, no spawn, no real clock wait.

const NOW = new Date("2026-03-02T15:00:00Z");
const minutesAgo = (minutes: number) => NOW.getTime() - minutes * 60_000;
const isoAgo = (minutes: number) => new Date(minutesAgo(minutes)).toISOString();

describe("search", () => {
    function hit(overrides: Partial<AgentSearchHit<string>> & { sessionId: string }): AgentSearchHit<string> {
        return {
            kind: "claude",
            cwd: "/work/shop",
            title: "Fix the cart",
            mtime: new Date(minutesAgo(10)),
            filePath: `/sessions/${overrides.sessionId}.jsonl`,
            project: "shop",
            ...overrides,
        };
    }

    function adapter(
        kind: string,
        hits: AgentSearchHit<string>[],
        seen: AgentSearchFilters[] = []
    ): () => AgentSessionAdapter<string> {
        return () => ({
            kind,
            list: async () => [],
            search: async (filters) => {
                seen.push(filters);
                return hits;
            },
        });
    }

    test("fans out to every provider with the filters pushed in, merges newest first and dedupes", async () => {
        const seen: AgentSearchFilters[] = [];
        const since = new Date(minutesAgo(600));
        const result = await searchSessions(
            { query: " cart bug ", project: "shop", since, limit: 5 },
            {
                claude: adapter(
                    "claude",
                    [
                        hit({
                            sessionId: "c1",
                            matchedEntries: [
                                {
                                    line: 7,
                                    role: "user",
                                    text: "the cart bug again",
                                    paths: [],
                                    commits: [],
                                    timestamp: isoAgo(20),
                                },
                                { line: 9, role: "assistant", text: "   ", paths: [], commits: [] },
                            ],
                        }),
                        hit({ sessionId: "c1" }),
                    ],
                    seen
                ),
                codex: adapter(
                    "codex",
                    [
                        hit({
                            kind: "codex",
                            sessionId: "x1",
                            mtime: new Date(minutesAgo(1)),
                            matchedText: "cart bug in title",
                        }),
                    ],
                    seen
                ),
            }
        );

        expect(seen).toHaveLength(2);
        expect(seen[0]).toMatchObject({
            query: "cart bug",
            project: "shop",
            all: false,
            since,
            limit: 5,
            excludeAgents: true,
        });
        expect(result.results.map((entry) => entry.sessionId)).toEqual(["x1", "c1"]);
        expect(result.results[1].snippets).toEqual([
            { role: "user", text: "the cart bug again", line: 7, timestamp: isoAgo(20), tool: null },
        ]);
        // A metadata hit still shows what matched.
        expect(result.results[0].snippets[0].text).toBe("cart bug in title");
        expect(result.filters.providers).toEqual(["claude", "codex"]);
    });

    test("one failing provider is reported and does not blank the others", async () => {
        const result = await searchSessions(
            { query: "cart", providers: ["claude", "grok"] },
            {
                claude: adapter("claude", [hit({ sessionId: "c1" })]),
                grok: () => {
                    throw new Error("index locked");
                },
            }
        );
        expect(result.results).toHaveLength(1);
        expect(result.providers.grok).toMatchObject({ hits: 0, error: "index locked" });
        expect(result.providers.claude).toMatchObject({ hits: 1, error: null });
    });

    test("a cancelled search rejects instead of reporting the aborted provider as failed", async () => {
        const controller = new AbortController();
        const aborting = () => ({
            kind: "claude",
            list: async () => [],
            search: async () => {
                controller.abort();
                throw new DOMException("The operation was aborted.", "AbortError");
            },
        });

        await expect(
            searchSessions({ query: "cart", providers: ["claude"], signal: controller.signal }, { claude: aborting })
        ).rejects.toThrow("aborted");
    });

    test("an empty query is refused", async () => {
        await expect(searchSessions({ query: "   " }, {})).rejects.toThrow("empty");
    });
});
