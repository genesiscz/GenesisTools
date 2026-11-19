import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeSearchCommand } from "@app/github/commands/code-search";
import { createSearchCommand, searchCommand } from "@app/github/commands/search";
import { env } from "@genesiscz/utils/env";
import type { CommentRecord, IssueRecord, TimelineEventRecord } from "@genesiscz/utils/github/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    clearCache,
    closeDatabase,
    getCacheStats,
    getCommentCount,
    getComments,
    getDatabase,
    getFetchMetadata,
    getIssue,
    getLastNComments,
    getOrCreateRepo,
    getTimelineEvents,
    initSchema,
    updateFetchMetadata,
    updateFetchMetadataForDb,
    upsertComment,
    upsertComments,
    upsertIssue,
    upsertTimelineEvents,
} from "./cache";
import * as localIssueSearch from "./local-issue-search";

const { searchCachedIssues } = localIssueSearch;

describe("GitHub issue search backends", () => {
    test.each([
        ["semantic", "issue", "open"],
        ["hybrid", "pr", "closed"],
        ["semantic", "all", "all"],
    ])("sends one hosted %s request for %s/%s and reports its source", async (mode, type, state) => {
        const item = {
            number: 17,
            title: "Empty window",
            state: state === "closed" ? "closed" : "open",
            user: { login: "alice" },
            created_at: "2026-01-02T00:00:00Z",
            updated_at: "2026-01-03T00:00:00Z",
            repository_url: "https://api.github.com/repos/acme/widgets",
            html_url: `https://github.com/acme/widgets/${type === "pr" ? "pull" : "issues"}/17`,
            comments: 3,
            reactions: { total_count: 8 },
            ...(type === "pr" && { pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/17" } }),
        };
        const http = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [item] }));
        const stdout = spyOn(out, "println").mockImplementation(() => {});
        try {
            await env.testing.withOverrides({ GITHUB_TOKEN: "fixture-token" }, async () => {
                await createSearchCommand().parseAsync(
                    [
                        "empty window reactions:>5",
                        "--search-type",
                        mode,
                        "--repo",
                        "acme/widgets",
                        "--type",
                        type,
                        "--state",
                        state,
                        "--limit",
                        "8",
                        "--format",
                        "json",
                    ],
                    { from: "user" }
                );
            });
            expect(http).toHaveBeenCalledTimes(1);
            const [url, init] = http.mock.calls[0];
            const { pathname, searchParams } = new URL(String(url));
            expect(init?.method).toBe("GET");
            expect(pathname).toBe("/search/issues");
            expect(searchParams.get("advanced_search")).toBe("true");
            expect(searchParams.get("search_type")).toBe(mode);
            expect(searchParams.get("per_page")).toBe("8");
            const expectedTerms = ["empty", "window", "reactions:>5", "repo:acme/widgets"];
            if (type !== "all") {
                expectedTerms.push(`is:${type}`);
            }

            if (state !== "all") {
                expectedTerms.push(`is:${state}`);
            }

            expect(searchParams.get("q")?.split(" ").sort()).toEqual(expectedTerms.sort());
            expect(stdout).toHaveBeenCalledTimes(1);
            expect(SafeJSON.parse(String(stdout.mock.calls[0][0]))).toEqual([
                expect.objectContaining({
                    number: 17,
                    repo: "acme/widgets",
                    type: type === "pr" ? "pr" : "issue",
                    source: mode,
                }),
            ]);
        } finally {
            stdout.mockRestore();
            http.mockRestore();
        }
    });

    test("the default keyword search writes only its JSON to stdout", async () => {
        const item = {
            number: 21,
            title: "Window flicker",
            state: "open",
            user: { login: "alice" },
            created_at: "2026-01-02T00:00:00Z",
            updated_at: "2026-01-03T00:00:00Z",
            repository_url: "https://api.github.com/repos/acme/widgets",
            html_url: "https://github.com/acme/widgets/issues/21",
            comments: 1,
            reactions: { total_count: 2 },
        };
        // Each backend reads its own body, so every call gets a fresh Response.
        const reply = Object.assign(async () => Response.json({ total_count: 1, items: [item] }), {
            preconnect: globalThis.fetch.preconnect,
        });
        const http = spyOn(globalThis, "fetch").mockImplementation(reply);
        const stdout = spyOn(out, "println").mockImplementation(() => {});
        const stderr = spyOn(out, "printlnErr").mockImplementation(() => {});
        try {
            await env.testing.withOverrides({ GITHUB_TOKEN: "fixture-token" }, async () => {
                await createSearchCommand().parseAsync(
                    ["window flicker", "--repo", "acme/widgets", "--type", "issue", "--format", "json"],
                    { from: "user" }
                );
            });
            expect(stdout).toHaveBeenCalledTimes(1);
            expect(SafeJSON.parse(String(stdout.mock.calls[0][0]))).toEqual([
                expect.objectContaining({ number: 21, repo: "acme/widgets" }),
            ]);
            expect(stderr.mock.calls.map((call) => String(call[0])).join("\n")).toContain("Searching (advanced)");
        } finally {
            stderr.mockRestore();
            stdout.mockRestore();
            http.mockRestore();
        }
    });

    test.each([403, 429])("reports the quota reset after HTTP %i without retrying", async (status) => {
        const response = Response.json(
            { message: "API rate limit exceeded" },
            { status, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "978307200" } }
        );
        const http = spyOn(globalThis, "fetch").mockResolvedValue(response);
        try {
            await env.testing.withOverrides({ GITHUB_TOKEN: "fixture-token" }, async () => {
                await expect(searchCommand("empty window", { searchType: "semantic" })).rejects.toThrow(
                    new RegExp(`HTTP ${status}.*10 requests per minute.*2001-01-01T00:00:00\\.000Z`)
                );
            });
            expect(http).toHaveBeenCalledTimes(1);
        } finally {
            http.mockRestore();
        }
    });

    test("routes --local to the cache without a GitHub request", async () => {
        const cached = spyOn(localIssueSearch, "searchCachedIssues").mockResolvedValue([]);
        const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected request"));
        const stdout = spyOn(out, "println").mockImplementation(() => {});
        try {
            await createSearchCommand().parseAsync(["empty window", "--search-type", "hybrid", "--local"], {
                from: "user",
            });
            expect(cached).toHaveBeenCalledWith("empty window", "hybrid", expect.objectContaining({ local: true }));
            expect(stdout).toHaveBeenCalledWith("No matching issues or pull requests in the local GitHub cache.");
            expect(http).not.toHaveBeenCalled();
        } finally {
            stdout.mockRestore();
            http.mockRestore();
            cached.mockRestore();
        }
    });

    test("rejects repository search, code search and hosted comment scans before a request", async () => {
        const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected request"));
        const stderr = spyOn(out, "printlnErr").mockImplementation(() => {});
        const savedExitCode = process.exitCode;
        try {
            for (const searchType of ["semantic", "hybrid"] as const) {
                await expect(searchCommand("window", { type: "repo", searchType })).rejects.toThrow("--type repo");
                await createCodeSearchCommand().parseAsync(["window", "--search-type", searchType], { from: "user" });
                expect(process.exitCode).toBe(1);
                expect(stderr).toHaveBeenCalledWith(
                    expect.stringContaining(`does not accept "${searchType}". Possible: keyword`)
                );
            }

            await expect(searchCommand("window", { searchType: "hybrid", minCommentReactions: 1 })).rejects.toThrow(
                "--min-comment-reactions"
            );
            expect(http).not.toHaveBeenCalled();
        } finally {
            process.exitCode = savedExitCode;
            stderr.mockRestore();
            http.mockRestore();
        }
    });
});

describe("updateFetchMetadata concurrency safety", () => {
    test("two sequential calls for the same issueId result in exactly one row without UNIQUE constraint error", () => {
        const db = new Database(":memory:");
        initSchema(db);

        // total_comments is an absolute snapshot per call, not additive.
        // Cross-process races can both see existing=null and attempt INSERT;
        // the transaction ensures the second call takes the UPDATE branch instead.
        updateFetchMetadataForDb(db, 12345, { total_comments: 1 });
        updateFetchMetadataForDb(db, 12345, { total_comments: 5 });

        const row = db.query("SELECT issue_id, total_comments FROM fetch_metadata WHERE issue_id = ?").get(12345) as {
            issue_id: number;
            total_comments: number;
        } | null;

        expect(row).toBeTruthy();
        expect(row!.issue_id).toBe(12345);
        expect(row!.total_comments).toBe(5);

        const count = db.query("SELECT COUNT(*) as c FROM fetch_metadata WHERE issue_id = ?").get(12345) as {
            c: number;
        };
        expect(count.c).toBe(1);

        db.close();
    });
});

function issueFields(repoId: number, over: Partial<Omit<IssueRecord, "id">> = {}): Omit<IssueRecord, "id"> {
    return {
        repo_id: repoId,
        number: 12,
        type: "issue",
        title: "Crash on save",
        body: "It crashes.",
        state: "open",
        author: "alice",
        created_at: "2026-03-01T09:00:00Z",
        updated_at: "2026-03-01T09:00:00Z",
        closed_at: null,
        last_fetched: "2026-03-05T09:00:00Z",
        last_comment_cursor: null,
        ...over,
    };
}

function commentRecord(over: Partial<CommentRecord> & Pick<CommentRecord, "id" | "issue_id">): CommentRecord {
    return {
        author: "bob",
        body: "text",
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T10:00:00Z",
        reaction_count: 0,
        reactions_json: "{}",
        is_bot: 0,
        ...over,
    };
}

describe("github cache database", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-github-cache-"));
        getDatabase(dir);
    });

    afterAll(() => {
        closeDatabase();
        rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        clearCache();
    });

    test("opens one WAL database file with the schema and hands the same connection to every caller", () => {
        const db = getDatabase();

        expect(existsSync(join(dir, "cache.db"))).toBe(true);
        expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        expect(tables.map((t) => t.name)).toEqual(
            expect.arrayContaining(["repos", "issues", "comments", "timeline_events", "fetch_metadata"])
        );
        expect(getDatabase(join(dir, "other"))).toBe(db);
        expect(existsSync(join(dir, "other"))).toBe(false);
    });

    test("a repository is created once and found again by owner and name", () => {
        const first = getOrCreateRepo("acme", "widgets");
        const again = getOrCreateRepo("acme", "widgets");
        const other = getOrCreateRepo("acme", "gadgets");

        expect(first).toEqual({ id: expect.any(Number), owner: "acme", name: "widgets" });
        expect(again).toEqual(first);
        expect(other.id).not.toBe(first.id);
        expect(getCacheStats().repos).toBe(2);
    });

    test("local semantic and hybrid search filter before ranking, including cached reactions", async () => {
        const repo = getOrCreateRepo("acme", "widgets");
        upsertIssue(issueFields(repo.id, { title: "Save failure", reaction_total: 4, comment_total: 10 }));
        upsertIssue(issueFields(repo.id, { number: 13, state: "closed" }));
        upsertIssue(issueFields(getOrCreateRepo("acme", "other").id));
        const embedder = {
            dimensions: 2,
            isAvailable: async () => true,
            embed: async () => ({ dimensions: 2, vector: new Float32Array([1, 0]) }),
        };
        const deps = { cachePath: join(dir, "cache.db"), embedder };
        for (const mode of ["semantic", "hybrid"] as const) {
            const hits = await searchCachedIssues(
                "save repo:ACME/widgets is:open type:issue reactions:>=3",
                mode,
                {},
                deps
            );
            expect(hits).toEqual([
                expect.objectContaining({
                    repo: "acme/widgets",
                    number: 12,
                    reactions: 4,
                    comments: 10,
                    source: `local-${mode}`,
                    url: "https://github.com/acme/widgets/issues/12",
                }),
            ]);
        }
        const filtered = await searchCachedIssues(
            "save",
            "semantic",
            { repo: "acme/widgets", state: "closed", minReactions: 1 },
            deps
        );
        expect(filtered).toEqual([]);
        await expect(searchCachedIssues("save", "hybrid", { type: "repo" }, deps)).rejects.toThrow("issues and PRs");
        await expect(searchCachedIssues("save", "semantic", { advanced: true }, deps)).rejects.toThrow("keyword");
    });

    test("local ranking filters by cached comment reactions before embedding", async () => {
        const repo = getOrCreateRepo("acme", "widgets");
        const qualifying = upsertIssue(issueFields(repo.id, { number: 1, title: "Save failure" }));
        const below = upsertIssue(issueFields(repo.id, { number: 2, title: "Save issue" }));
        upsertIssue(issueFields(repo.id, { number: 3, title: "Save error" }));
        upsertComments([
            commentRecord({ id: "a", issue_id: qualifying.id, reaction_count: 3 }),
            commentRecord({ id: "b", issue_id: below.id, reaction_count: 2 }),
        ]);
        let embedded = 0;
        const embedder = {
            dimensions: 2,
            isAvailable: async () => true,
            embed: async () => {
                embedded++;
                return { dimensions: 2, vector: new Float32Array([1, 0]) };
            },
        };
        for (const mode of ["semantic", "hybrid"] as const) {
            const results = await searchCachedIssues(
                "save",
                mode,
                { minCommentReactions: 3 },
                { cachePath: join(dir, "cache.db"), embedder }
            );
            expect(results.map((result) => result.number)).toEqual([1]);
        }
        expect(embedded).toBe(4);
    });

    test("omitted totals survive refresh and null explicitly resets one total", () => {
        const repo = getOrCreateRepo("acme", "widgets");
        upsertIssue(issueFields(repo.id, { reaction_total: 7, comment_total: 10 }));
        const kept = upsertIssue(issueFields(repo.id));
        const reset = upsertIssue(issueFields(repo.id, { comment_total: null }));
        closeDatabase();
        getDatabase(dir);
        expect(kept).toMatchObject({ reaction_total: 7, comment_total: 10 });
        expect(reset).toMatchObject({ reaction_total: 7, comment_total: null });
        expect(getIssue(repo.id, 12)).toEqual(reset);
    });

    test("semantic synonyms and keyword matches both contribute to hybrid rank", async () => {
        const repo = getOrCreateRepo("acme", "widgets");
        upsertIssue(issueFields(repo.id, { number: 1, title: "Gray screen", body: "" }));
        upsertIssue(issueFields(repo.id, { number: 2, title: "Blank window", body: "" }));
        upsertIssue(issueFields(repo.id, { number: 3, title: "Blank window tracker", body: "" }));
        const deps = {
            cachePath: join(dir, "cache.db"),
            embedder: {
                dimensions: 2,
                isAvailable: async () => true,
                embed: async (text: string) => ({
                    dimensions: 2,
                    vector: new Float32Array(
                        text.trim() === "Blank window" ? [0.9, 0.1] : text.includes("tracker") ? [0, 1] : [1, 0]
                    ),
                }),
            },
        };
        const vector = await searchCachedIssues("blank window", "semantic", {}, deps);
        expect(vector[0].number).toBe(1);
        const hybrid = await searchCachedIssues("blank window", "hybrid", {}, deps);
        expect(hybrid[0].number).toBe(2);
    });

    test("an issue is inserted with an id, then updated in place by repository and number", () => {
        const repo = getOrCreateRepo("acme", "widgets");

        const created = upsertIssue(issueFields(repo.id));
        const updated = upsertIssue(issueFields(repo.id, { title: "Crash on save (fixed)", state: "closed" }));

        expect(created.id).toEqual(expect.any(Number));
        expect(updated.id).toBe(created.id);
        expect(getIssue(repo.id, 12)).toMatchObject({
            id: created.id,
            title: "Crash on save (fixed)",
            state: "closed",
        });
        expect(getCacheStats().issues).toBe(1);
    });

    test("an issue that was never cached is null, and the same number in another repository is a different issue", () => {
        const widgets = getOrCreateRepo("acme", "widgets");
        const gadgets = getOrCreateRepo("acme", "gadgets");
        upsertIssue(issueFields(widgets.id));

        expect(getIssue(widgets.id, 99)).toBeNull();
        expect(getIssue(gadgets.id, 12)).toBeNull();
        expect(upsertIssue(issueFields(gadgets.id)).id).not.toBe(getIssue(widgets.id, 12)?.id);
    });

    describe("comments", () => {
        let issueId: number;

        beforeEach(() => {
            issueId = upsertIssue(issueFields(getOrCreateRepo("acme", "widgets").id)).id;
            upsertComments([
                commentRecord({ id: "100", issue_id: issueId, author: "alice", created_at: "2026-03-01T10:00:00Z" }),
                commentRecord({
                    id: "200",
                    issue_id: issueId,
                    author: "bob",
                    created_at: "2026-03-02T10:00:00Z",
                    reaction_count: 3,
                }),
                commentRecord({
                    id: "300",
                    issue_id: issueId,
                    author: "bob",
                    created_at: "2026-03-03T10:00:00Z",
                    reaction_count: 1,
                    is_bot: 1,
                }),
                commentRecord({
                    id: "400",
                    issue_id: issueId,
                    author: "carol",
                    created_at: "2026-03-04T10:00:00Z",
                    reaction_count: 5,
                }),
                commentRecord({ id: "500", issue_id: issueId, author: "alice", created_at: "2026-03-05T10:00:00Z" }),
                commentRecord({ id: "1000", issue_id: issueId, author: "dana", created_at: "2026-03-06T10:00:00Z" }),
            ]);
        });

        const ids = (comments: CommentRecord[]): string[] => comments.map((c) => c.id);

        test("come back oldest first and only for the asked issue", () => {
            const otherIssue = upsertIssue(issueFields(getOrCreateRepo("acme", "widgets").id, { number: 13 })).id;
            upsertComment(commentRecord({ id: "9", issue_id: otherIssue }));

            expect(ids(getComments(issueId))).toEqual(["100", "200", "300", "400", "500", "1000"]);
            expect(ids(getComments(otherIssue))).toEqual(["9"]);
        });

        test("since compares comment ids as numbers, so 1000 is after 200", () => {
            expect(ids(getComments(issueId, { since: "200" }))).toEqual(["300", "400", "500", "1000"]);
        });

        test("after and before are exclusive bounds on the creation time", () => {
            expect(ids(getComments(issueId, { after: "2026-03-02T10:00:00Z" }))).toEqual(["300", "400", "500", "1000"]);
            expect(ids(getComments(issueId, { before: "2026-03-02T10:00:00Z" }))).toEqual(["100"]);
        });

        test("minReactions keeps comments at or above it, and zero keeps all", () => {
            expect(ids(getComments(issueId, { minReactions: 3 }))).toEqual(["200", "400"]);
            expect(getComments(issueId, { minReactions: 0 })).toHaveLength(6);
        });

        test("author and excludeBots narrow the list", () => {
            expect(ids(getComments(issueId, { author: "bob" }))).toEqual(["200", "300"]);
            expect(ids(getComments(issueId, { author: "bob", excludeBots: true }))).toEqual(["200"]);
            expect(getComments(issueId, { excludeBots: true })).toHaveLength(5);
        });

        test("limit and offset page through the list, and an offset without a limit is ignored", () => {
            expect(ids(getComments(issueId, { limit: 2 }))).toEqual(["100", "200"]);
            expect(ids(getComments(issueId, { limit: 2, offset: 2 }))).toEqual(["300", "400"]);
            expect(getComments(issueId, { offset: 2 })).toHaveLength(6);
        });

        test("the last N come back in time order and honour the same filters", () => {
            expect(ids(getLastNComments(issueId, 2))).toEqual(["500", "1000"]);
            expect(ids(getLastNComments(issueId, 2, { excludeBots: true, author: "bob" }))).toEqual(["200"]);
            expect(ids(getLastNComments(issueId, 5, { minReactions: 3 }))).toEqual(["200", "400"]);
        });

        test("counts all comments or only the human ones", () => {
            expect(getCommentCount(issueId)).toBe(6);
            expect(getCommentCount(issueId, true)).toBe(5);
        });

        test("saving a comment with an existing id replaces it", () => {
            upsertComment(commentRecord({ id: "200", issue_id: issueId, body: "edited", reaction_count: 9 }));

            const edited = getComments(issueId, { since: "199", limit: 1 })[0];
            expect(edited).toMatchObject({ id: "200", body: "edited", reaction_count: 9 });
            expect(getCommentCount(issueId)).toBe(6);
        });
    });

    test("timeline events come back oldest first and a saved id is replaced", () => {
        const issueId = upsertIssue(issueFields(getOrCreateRepo("acme", "widgets").id)).id;
        const event = (id: string, created_at: string, event_type: string): TimelineEventRecord => ({
            id,
            issue_id: issueId,
            event_type,
            actor: "carol",
            created_at,
            data_json: "{}",
        });

        upsertTimelineEvents([
            event("e2", "2026-03-03T08:00:00Z", "closed"),
            event("e1", "2026-03-02T08:00:00Z", "labeled"),
        ]);
        upsertTimelineEvents([event("e1", "2026-03-02T08:00:00Z", "unlabeled")]);

        expect(getTimelineEvents(issueId).map((e) => [e.id, e.event_type])).toEqual([
            ["e1", "unlabeled"],
            ["e2", "closed"],
        ]);
    });

    test("fetch metadata is created with defaults, then only the given fields change", () => {
        const issueId = upsertIssue(issueFields(getOrCreateRepo("acme", "widgets").id)).id;

        expect(getFetchMetadata(issueId)).toBeNull();

        updateFetchMetadata(issueId, { last_full_fetch: "2026-03-05T09:00:00Z" });
        expect(getFetchMetadata(issueId)).toMatchObject({
            issue_id: issueId,
            last_full_fetch: "2026-03-05T09:00:00Z",
            last_incremental_fetch: null,
            total_comments: 0,
            last_comment_date: null,
        });

        updateFetchMetadata(issueId, { total_comments: 7, last_comment_date: "2026-03-04T10:00:00Z" });
        updateFetchMetadata(issueId, { last_incremental_fetch: "2026-03-06T09:00:00Z" });
        updateFetchMetadata(issueId, {});
        expect(getFetchMetadata(issueId)).toMatchObject({
            last_full_fetch: "2026-03-05T09:00:00Z",
            last_incremental_fetch: "2026-03-06T09:00:00Z",
            total_comments: 7,
            last_comment_date: "2026-03-04T10:00:00Z",
        });

        updateFetchMetadata(issueId, { last_full_fetch: "2026-03-08T09:00:00Z" });
        expect(getFetchMetadata(issueId)).toMatchObject({
            last_full_fetch: "2026-03-08T09:00:00Z",
            last_incremental_fetch: "2026-03-06T09:00:00Z",
            total_comments: 7,
        });
    });

    test("the stats count every table and clearing the cache empties them all", () => {
        const issueId = upsertIssue(issueFields(getOrCreateRepo("acme", "widgets").id)).id;
        upsertComments([commentRecord({ id: "1", issue_id: issueId }), commentRecord({ id: "2", issue_id: issueId })]);
        upsertTimelineEvents([
            { id: "e1", issue_id: issueId, event_type: "closed", actor: "carol", created_at: "x", data_json: "{}" },
        ]);
        updateFetchMetadata(issueId, { total_comments: 2 });

        expect(getCacheStats()).toEqual({ repos: 1, issues: 1, comments: 2, events: 1 });

        clearCache();

        expect(getCacheStats()).toEqual({ repos: 0, issues: 0, comments: 0, events: 0 });
        expect(getFetchMetadata(issueId)).toBeNull();
    });

    test("closing the database lets the next open start a fresh connection in a new folder", () => {
        closeDatabase();
        closeDatabase();
        const second = join(dir, "second");

        const db = getDatabase(second);

        expect(existsSync(join(second, "cache.db"))).toBe(true);
        expect(getCacheStats().repos).toBe(0);
        expect(getDatabase()).toBe(db);
    });
});
