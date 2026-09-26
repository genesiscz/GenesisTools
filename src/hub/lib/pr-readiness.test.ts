import { describe, expect, test } from "bun:test";
import {
    countByAuthor,
    githubFacts,
    judgeReadiness,
    parseGithubPrUrl,
    prReadiness,
    type RawReadiness,
    type ReadinessDeps,
    type ReadinessFacts,
    rollupToCi,
    splitKnownHead,
} from "./pr-readiness";

// Invented logins, repository and SHAs; the GraphQL shape is GitHub's.
const NOW = new Date("2026-09-26T18:00:00Z");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const URL = "https://github.com/acme/shop/pull/12";

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
    return {
        url: URL,
        provider: "github",
        number: 12,
        title: "Cart totals",
        state: "open",
        draft: false,
        headSha: HEAD,
        ci: "success",
        threads: [],
        reviews: [{ author: "review-bot", state: "COMMENTED", submittedAt: "2026-09-26T17:00:00Z", commit: HEAD }],
        lastPushAt: "2026-09-26T16:00:00Z",
        reviewDecision: null,
        mergeable: "mergeable",
        reviewsKnown: true,
        ...overrides,
    };
}

describe("judgeReadiness", () => {
    test("ready: CI green, no open thread, the newest review looked at the head", () => {
        const result = judgeReadiness(facts(), NOW);

        expect(result).toMatchObject({ verdict: "ready", reasons: [], reviewedHead: true, unresolved: 0 });
        expect(result.summary).toBe("ready to merge: CI green, no open threads, the head is reviewed");
    });

    test("every reviewer's unresolved threads count, outdated and resolved ones do not", () => {
        const result = judgeReadiness(
            facts({
                threads: [
                    { resolved: false, outdated: false, author: "bot-b" },
                    { resolved: false, outdated: false, author: "bot-a" },
                    { resolved: false, outdated: false, author: "bot-b" },
                    { resolved: false, outdated: true, author: "bot-a" },
                    { resolved: true, outdated: false, author: "carol" },
                ],
            }),
            NOW
        );

        expect(result.verdict).toBe("blocked");
        expect(result.unresolved).toBe(3);
        expect(result.outdatedUnresolved).toBe(1);
        expect(result.unresolvedBy).toEqual([
            { author: "bot-b", count: 2 },
            { author: "bot-a", count: 1 },
        ]);
        expect(result.summary).toBe("blocked: 3 unresolved threads (bot-b ×2, bot-a ×1)");
    });

    test("waiting when the newest review looked at an older head, naming who is due", () => {
        const result = judgeReadiness(
            facts({
                reviews: [
                    { author: "bot-a", state: "COMMENTED", submittedAt: "2026-09-26T15:00:00Z", commit: OLD },
                    { author: "bot-b", state: "APPROVED", submittedAt: "2026-09-26T15:30:00Z", commit: OLD },
                ],
            }),
            NOW
        );

        expect(result).toMatchObject({ verdict: "waiting", reviewedHead: false, staleReviewers: ["bot-a", "bot-b"] });
        expect(result.reasons).toEqual(["the last review (bot-b, 3 h ago) is older than the last push"]);
    });

    test("a review without a commit counts as on the head when it came after the last push", () => {
        const after = facts({
            reviews: [{ author: "x", state: "COMMENTED", submittedAt: "2026-09-26T17:00:00Z", commit: null }],
        });
        const before = facts({
            reviews: [{ author: "x", state: "COMMENTED", submittedAt: "2026-09-26T15:00:00Z", commit: null }],
        });

        expect(judgeReadiness(after, NOW).reviewedHead).toBe(true);
        expect(judgeReadiness(before, NOW).reviewedHead).toBe(false);
    });

    test("blocking reasons come before waiting ones, and the summary counts the rest", () => {
        const result = judgeReadiness(
            facts({
                draft: true,
                ci: "running",
                mergeable: "conflicting",
                reviewDecision: "CHANGES_REQUESTED",
                reviews: [],
            }),
            NOW
        );

        expect(result.verdict).toBe("blocked");
        expect(result.reasons).toEqual([
            "it is a draft",
            "changes are requested",
            "it has merge conflicts",
            "CI is still running",
            "no review yet",
        ]);
        expect(result.summary).toBe("blocked: it is a draft (+4 more)");
    });

    test("CI failed blocks; CI pending waits; no checks at all is not a blocker", () => {
        expect(judgeReadiness(facts({ ci: "failed" }), NOW).verdict).toBe("blocked");
        expect(judgeReadiness(facts({ ci: "pending" }), NOW).verdict).toBe("waiting");
        expect(judgeReadiness(facts({ ci: null }), NOW)).toMatchObject({
            verdict: "ready",
            summary: expect.stringContaining("no CI checks"),
        });
    });

    test("a merged PR is closed; GitLab skips the review-vs-push check it cannot know", () => {
        expect(judgeReadiness(facts({ state: "merged" }), NOW)).toMatchObject({ verdict: "closed", summary: "merged" });
        expect(judgeReadiness(facts({ provider: "gitlab", reviewsKnown: false, reviews: [] }), NOW)).toMatchObject({
            verdict: "ready",
            reviewedHead: null,
        });
    });

    test("pending and dismissed reviews are no reviews", () => {
        const result = judgeReadiness(
            facts({
                reviews: [
                    { author: "me", state: "PENDING", submittedAt: "2026-09-26T17:59:00Z", commit: OLD },
                    { author: "bot", state: "DISMISSED", submittedAt: "2026-09-26T17:58:00Z", commit: OLD },
                ],
            }),
            NOW
        );

        expect(result.reasons).toEqual(["no review yet"]);
    });

    test("countByAuthor sorts by count, then by name", () => {
        expect(countByAuthor(["b", "a", "b", "c", "a"]).map((entry) => entry.author)).toEqual(["a", "b", "c"]);
    });
});

function raw(): RawReadiness {
    return {
        repository: {
            pullRequest: {
                number: 12,
                title: "Cart totals",
                state: "OPEN",
                isDraft: false,
                url: URL,
                headRefOid: HEAD,
                author: { login: "alice" },
                mergeable: "MERGEABLE",
                reviewDecision: null,
                commits: {
                    nodes: [
                        {
                            commit: {
                                oid: HEAD,
                                committedDate: "2026-09-26T16:00:00Z",
                                statusCheckRollup: { state: "FAILURE" },
                            },
                        },
                    ],
                },
                reviews: {
                    nodes: [
                        {
                            author: { login: "review-bot" },
                            state: "COMMENTED",
                            submittedAt: "2026-09-26T17:00:00Z",
                            commit: { oid: HEAD },
                        },
                        {
                            author: { login: "alice" },
                            state: "COMMENTED",
                            submittedAt: "2026-09-26T17:30:00Z",
                            commit: { oid: OLD },
                        },
                        { author: { login: "carol" }, state: "PENDING", submittedAt: null, commit: null },
                    ],
                },
                reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ isResolved: false, isOutdated: false, comments: { nodes: [{ author: null }] } }],
                },
                timelineItems: { nodes: [{ createdAt: "2026-09-26T16:30:00Z" }] },
            },
        },
    };
}

describe("githubFacts", () => {
    test("maps the query: rollup to CI, the author's own replies dropped, the newest push time", () => {
        const mapped = githubFacts(raw());

        expect(mapped).toMatchObject({
            ci: "failed",
            mergeable: "mergeable",
            state: "open",
            lastPushAt: "2026-09-26T16:30:00Z",
        });
        expect(mapped?.reviews.map((review) => review.author)).toEqual(["review-bot"]);
        expect(mapped?.threads).toEqual([{ resolved: false, outdated: false, author: "ghost" }]);
    });

    test("without a push event the push time is unknown: a commit's date is not when it was pushed", () => {
        const pullRequest = raw().repository?.pullRequest;

        if (!pullRequest) {
            throw new Error("the fixture always has a pull request");
        }

        const mapped = githubFacts({ repository: { pullRequest: { ...pullRequest, timelineItems: { nodes: [] } } } });
        expect(mapped?.lastPushAt).toBeNull();
    });

    test("thread pages past the first are appended; a missing PR is null", () => {
        const extra = [{ isResolved: true, isOutdated: false, comments: { nodes: [{ author: { login: "bot" } }] } }];

        expect(githubFacts(raw(), extra)?.threads).toHaveLength(2);
        expect(githubFacts({ repository: { pullRequest: null } })).toBeNull();
    });

    test("rollupToCi covers every state", () => {
        expect(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", null].map(rollupToCi)).toEqual([
            "success",
            "failed",
            "failed",
            "running",
            "pending",
            null,
        ]);
    });
});

describe("refs", () => {
    test("a GitHub PR URL parses; a GitLab MR does not", () => {
        expect(parseGithubPrUrl(`${URL}/files`)).toEqual({ owner: "acme", repo: "shop", number: 12 });
        expect(parseGithubPrUrl("https://gitlab.example.com/g/app/-/merge_requests/9")).toBeNull();
    });

    test("an @<sha> suffix is the head the caller knows", () => {
        expect(splitKnownHead(`${URL}@ABCDEF1`)).toEqual({ ref: URL, head: "abcdef1" });
        expect(splitKnownHead("/repo#12")).toEqual({ ref: "/repo#12", head: null });
    });
});

/** In-memory cache and a GraphQL fake that counts calls: nothing reaches GitHub or the disk. */
function fakeDeps(start = NOW): ReadinessDeps & { calls: number; clock: { now: Date } } {
    const cache = new Map<string, unknown>();
    const clock = { now: start };
    const deps = {
        calls: 0,
        clock,
        graphql: async <T>(): Promise<T> => {
            deps.calls++;
            return raw() as T;
        },
        other: async () => facts({ provider: "gitlab", reviewsKnown: false }),
        storage: {
            getCacheFile: async <T>(key: string): Promise<T | null> => (cache.get(key) as T | undefined) ?? null,
            putCacheFile: async <T>(key: string, data: T): Promise<void> => {
                cache.set(key, data);
            },
        },
        now: () => clock.now,
    };
    return deps;
}

describe("prReadiness cache", () => {
    test("the same head within 10 minutes is served from the cache; a new head or --fresh asks again", async () => {
        const deps = fakeDeps();
        const first = await prReadiness({ input: `${URL}@${HEAD.slice(0, 9)}`, deps });
        const second = await prReadiness({ input: `${URL}@${HEAD.slice(0, 9)}`, deps });

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(deps.calls).toBe(1);

        await prReadiness({ input: `${URL}@${OLD.slice(0, 9)}`, deps });
        expect(deps.calls).toBe(2);

        await prReadiness({ input: `${URL}@${HEAD.slice(0, 9)}`, deps, fresh: true });
        expect(deps.calls).toBe(3);

        deps.clock.now = new Date(NOW.getTime() + 11 * 60_000);
        await prReadiness({ input: `${URL}@${HEAD.slice(0, 9)}`, deps });
        expect(deps.calls).toBe(4);
    });

    test("without a known head a cached answer lives one minute; a non-GitHub ref goes through the hub's readers", async () => {
        const deps = fakeDeps();
        await prReadiness({ input: URL, deps });
        await prReadiness({ input: URL, deps });
        expect(deps.calls).toBe(1);

        deps.clock.now = new Date(NOW.getTime() + 61_000);
        await prReadiness({ input: URL, deps });
        expect(deps.calls).toBe(2);

        const gitlab = await prReadiness({ input: "https://gitlab.example.com/g/app/-/merge_requests/9", deps });
        expect(gitlab).toMatchObject({ provider: "gitlab", reviewedHead: null });
        expect(deps.calls).toBe(2);
    });
});
