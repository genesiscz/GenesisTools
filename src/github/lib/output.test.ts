import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
    ActivityItem,
    CommentData,
    GitHubIssue,
    GitHubPullRequest,
    GitHubReactions,
    IssueData,
    NotificationItem,
    ParsedReviewThread,
    PRData,
    PRLevelComment,
    RepoSearchResult,
    ReviewData,
    SearchResult,
} from "@genesiscz/utils/github/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
import {
    calculateStats,
    formatActivity,
    formatIssue,
    formatNotifications,
    formatPR,
    formatRepoResults,
    formatSearchResults,
} from "./output";
import {
    formatPrCommentsLLM,
    formatReviewJSON,
    formatReviewLLM,
    formatReviewMarkdown,
    formatReviewTerminal,
    formatThreadExpanded,
    saveReviewMarkdown,
} from "./review-output";

/** An ISO timestamp for a LOCAL wall-clock time, so the local-time formatters print the same text in every zone. */
function localIso(year: number, month: number, day: number, hour = 0, minute = 0): string {
    return new Date(year, month - 1, day, hour, minute).toISOString();
}

function reactions(over: Partial<GitHubReactions> = {}): GitHubReactions {
    return {
        total_count: 0,
        "+1": 0,
        "-1": 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 0,
        eyes: 0,
        ...over,
    };
}

function makeComment(over: Partial<CommentData> = {}): CommentData {
    return {
        id: 501,
        nodeId: "IC_501",
        author: "bob",
        body: "Reproduced on 2.1.",
        createdAt: localIso(2026, 3, 2, 11, 0),
        updatedAt: localIso(2026, 3, 2, 11, 0),
        reactions: reactions(),
        isBot: false,
        htmlUrl: "",
        ...over,
    };
}

function makeIssue(over: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
        id: 1,
        node_id: "I_1",
        number: 12,
        title: "Crash on save",
        body: "It crashes.",
        state: "open",
        user: { login: "alice", id: 1, type: "User" },
        created_at: localIso(2026, 3, 1, 9, 0),
        updated_at: localIso(2026, 3, 2, 10, 30),
        closed_at: null,
        labels: [],
        assignees: [],
        milestone: null,
        comments: 0,
        ...over,
    };
}

function makeIssueData(over: Partial<IssueData> = {}): IssueData {
    return {
        owner: "acme",
        repo: "widgets",
        issue: makeIssue(),
        comments: [],
        events: [],
        fetchedAt: localIso(2026, 3, 5, 9, 0),
        ...over,
    };
}

function makePull(over: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
    return {
        ...makeIssue({ number: 77, title: "Add widget cache", pull_request: { url: "https://api.example.com/p" } }),
        head: { ref: "feat/x", sha: "a".repeat(40), repo: null },
        base: { ref: "main", sha: "b".repeat(40), repo: null },
        merged: false,
        merged_at: null,
        merged_by: null,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        additions: 10,
        deletions: 2,
        changed_files: 3,
        ...over,
    };
}

function makePrData(over: Partial<PRData> = {}): PRData {
    const pr = over.pr ?? makePull();

    return { ...makeIssueData({ issue: pr }), pr, ...over };
}

function makeThread(over: Partial<ParsedReviewThread> = {}): ParsedReviewThread {
    return {
        threadId: "PRRT_1",
        threadNumber: 1,
        status: "unresolved",
        severity: "high",
        file: "src/a.ts",
        line: 12,
        startLine: null,
        author: "carol",
        title: "Null check missing",
        issue: "Add a null check.",
        diffHunk: null,
        suggestedCode: null,
        firstCommentId: "C_1",
        createdAt: "2026-03-10T09:00:00Z",
        replies: [],
        ...over,
    };
}

function makeReview(over: Partial<ReviewData> = {}): ReviewData {
    const threads = over.threads ?? [makeThread()];

    return {
        owner: "acme",
        repo: "widgets",
        prNumber: 77,
        title: "Add widget cache",
        state: "OPEN",
        threads,
        stats: {
            total: threads.length,
            resolved: threads.filter((t) => t.status === "resolved").length,
            unresolved: threads.filter((t) => t.status === "unresolved").length,
            high: threads.filter((t) => t.severity === "high").length,
            medium: threads.filter((t) => t.severity === "medium").length,
            low: threads.filter((t) => t.severity === "low").length,
        },
        ...over,
    };
}

describe("calculateStats", () => {
    test("counts authors most active first, bots, reactions and the date range", () => {
        const stats = calculateStats([
            makeComment({ id: 1, author: "bob", createdAt: "2026-03-01T10:00:00Z", reactions: reactions({ "+1": 2 }) }),
            makeComment({ id: 2, author: "dana", createdAt: "2026-03-02T10:00:00Z", isBot: true }),
            makeComment({
                id: 3,
                author: "bob",
                createdAt: "2026-03-03T10:00:00Z",
                reactions: reactions({ "+1": 1, heart: 3, total_count: 4 }),
            }),
        ]);

        expect(stats.total).toBe(3);
        expect(stats.shown).toBe(3);
        expect(stats.uniqueAuthors).toBe(2);
        expect(stats.authorBreakdown).toEqual([
            { author: "bob", count: 2 },
            { author: "dana", count: 1 },
        ]);
        expect(stats.botComments).toBe(1);
        expect(stats.totalReactions).toBe(6);
        expect(stats.reactionBreakdown["+1"]).toBe(3);
        expect(stats.reactionBreakdown.heart).toBe(3);
        expect(stats.reactionBreakdown.total_count).toBeUndefined();
        expect(stats.dateRange).toEqual({ start: "2026-03-01T10:00:00Z", end: "2026-03-03T10:00:00Z" });
    });

    test("a cache total larger than the shown list wins, and no comments gives an empty range", () => {
        expect(calculateStats([makeComment()], 9)).toMatchObject({ total: 9, shown: 1 });
        expect(calculateStats([])).toMatchObject({
            total: 0,
            shown: 0,
            uniqueAuthors: 0,
            authorBreakdown: [],
            dateRange: { start: "", end: "" },
        });
    });
});

describe("formatIssue", () => {
    test("json is the data itself", () => {
        const data = makeIssueData({ comments: [makeComment()] });

        expect(SafeJSON.parse(formatIssue(data, "json"))).toEqual(SafeJSON.parse(SafeJSON.stringify(data)));
    });

    test("markdown names the issue, its link, state, author, dates and people", () => {
        const md = formatIssue(
            makeIssueData({
                issue: makeIssue({
                    labels: [
                        { name: "bug", color: "f00", description: null },
                        { name: "p1", color: "00f", description: null },
                    ],
                    assignees: [{ login: "bob", id: 2, type: "User" }],
                    milestone: { number: 1, title: "v1.0", state: "open" },
                    reactions: reactions({ "+1": 2, heart: 1, total_count: 3 }),
                }),
            }),
            "md"
        );

        expect(md).toContain("# Issue #12: Crash on save");
        expect(md).toContain(
            "**URL:** [https://github.com/acme/widgets/issues/12](https://github.com/acme/widgets/issues/12)"
        );
        expect(md).toContain("**Repository:** acme/widgets");
        expect(md).toContain("**State:** open | **Author:** @alice");
        expect(md).toContain("**Created:** 2026-03-01 09:00 | **Updated:** 2026-03-02 10:30");
        expect(md).toContain("**Reactions:** 👍 2 · ❤️ 1");
        expect(md).toContain("**Labels:** bug, p1");
        expect(md).toContain("**Assignees:** @bob");
        expect(md).toContain("**Milestone:** v1.0");
        expect(md).toContain("## Description\n\nIt crashes.");
    });

    test("an author that was deleted shows as unknown and a missing body points at the full fetch", () => {
        const md = formatIssue(makeIssueData({ issue: makeIssue({ user: null, body: null }) }), "md");

        expect(md).toContain("**Author:** @unknown");
        expect(md).toContain(
            "_No description provided._ (Run `tools github issue https://github.com/acme/widgets/issues/12 --full` to fetch full details)"
        );
    });

    test("the index lists each section, groups comments by ten, and noIndex removes it", () => {
        const comments = Array.from({ length: 12 }, (_, i) =>
            makeComment({ id: 600 + i, createdAt: localIso(2026, 3, 2 + i, 9, 0) })
        );
        const data = makeIssueData({
            comments,
            events: [
                { id: "e1", event: "labeled", actor: "carol", createdAt: localIso(2026, 3, 3, 8, 0), details: "x" },
            ],
            linkedIssues: [{ number: 7, title: "Old bug", state: "closed", linkType: "fixes" }],
            stats: calculateStats(comments),
        });

        const md = formatIssue(data, "md");

        expect(md).toContain("## Index");
        expect(md).toMatch(/\| Description \| \d+-\d+ \| 01\.03\.2026 09:00 \|/);
        expect(md).toMatch(/\| Linked Issues \| \d+-\d+ \| - \|/);
        expect(md).toMatch(/\| Timeline Events \| \d+-\d+ \| 03\.03\.2026 08:00 → 03\.03\.2026 08:00 \|/);
        expect(md).toMatch(/\| Comments 1-10 \| \d+-\d+ \| 02\.03\.2026 09:00 → 11\.03\.2026 09:00 \|/);
        expect(md).toMatch(/\| Comments 11-12 \| \d+-\d+ \| 12\.03\.2026 09:00 → 13\.03\.2026 09:00 \|/);
        expect(md).toContain("| Statistics | end | - |");
        expect(formatIssue(data, "md", { noIndex: true })).not.toContain("## Index");
    });

    test("a short comment list is one Comments row", () => {
        const md = formatIssue(makeIssueData({ comments: [makeComment()] }), "md");

        expect(md).toMatch(/\| Comments \| \d+-\d+ \|/);
        expect(md).not.toContain("Comments 1-");
    });

    test("comments show their link, reactions and the comment they reply to", () => {
        const md = formatIssue(
            makeIssueData({
                issue: makeIssue({ comments: 5 }),
                comments: [
                    makeComment({ id: 501, author: "bob", reactions: reactions({ rocket: 2, total_count: 2 }) }),
                    makeComment({
                        id: 502,
                        author: "erin",
                        body: "Agreed.",
                        htmlUrl: "https://github.com/acme/widgets/issues/12#issuecomment-502",
                        replyTo: 501,
                    }),
                ],
            }),
            "md"
        );

        expect(md).toContain("## Comments (5 total, showing 2)");
        expect(md).toContain(
            "### Comment 1 — @bob · [2026-03-02 11:00](https://github.com/acme/widgets/issues/12#issuecomment-501)"
        );
        expect(md).toContain("🚀 2");
        expect(md).toContain(
            "### Comment 2 — @erin · [2026-03-02 11:00](https://github.com/acme/widgets/issues/12#issuecomment-502)"
        );
        expect(md).toContain("[replying to comment #501]\n\nAgreed.");
        expect(md).toContain("**Date Range:** 2026-03-02 11:00 → 2026-03-02 11:00");
    });

    test("events, linked issues and the statistics table are listed, with bots marked as filtered", () => {
        const comments = [makeComment({ author: "bob" }), makeComment({ id: 502, author: "bob", isBot: true })];
        const md = formatIssue(
            makeIssueData({
                comments,
                events: [
                    {
                        id: "e1",
                        event: "labeled",
                        actor: "carol",
                        createdAt: localIso(2026, 3, 3, 8, 0),
                        details: "added bug",
                    },
                ],
                linkedIssues: [{ number: 7, title: "Old bug", state: "closed", linkType: "closes" }],
                stats: calculateStats(comments, 4),
                cacheCursor: "cur-9",
            }),
            "md"
        );

        expect(md).toContain("## Timeline Events (1)");
        expect(md).toContain("- 2026-03-03 08:00 - @carol added bug");
        expect(md).toContain("- Closes #7 (closed): Old bug");
        expect(md).toContain("| Total Comments | 4 |");
        expect(md).toContain("| Most Active | @bob (2 comments) |");
        expect(md).toContain("| Bot Comments | 1 (filtered) |");
        expect(md.trimEnd().endsWith(`_Fetched: ${localIso(2026, 3, 5, 9, 0)} | Cache cursor: cur-9_`)).toBe(true);
    });

    test("the ai summary has the title, metadata, computed statistics and the fetch time, but no comment bodies", () => {
        const comments = [
            makeComment({ id: 1, author: "bob", createdAt: localIso(2026, 3, 2, 11, 0), body: "SECRET-BODY-ONE" }),
            makeComment({ id: 2, author: "bob", createdAt: localIso(2026, 3, 3, 12, 0), isBot: true }),
        ];
        const ai = formatIssue(
            makeIssueData({
                issue: makeIssue({ comments: 2, reactions: reactions({ eyes: 1, total_count: 1 }) }),
                comments,
                linkedIssues: [{ number: 7, title: "Old bug", state: "closed", linkType: "fixes" }],
            }),
            "ai",
            { filePath: "/tmp/full.md" }
        );

        expect(ai.startsWith("# Issue #12: Crash on save\n")).toBe(true);
        expect(ai).toContain("**Full content saved to:** `/tmp/full.md`");
        expect(ai).toContain("**Repo:** acme/widgets | **State:** open | **Author:** @alice");
        expect(ai).toContain("**Reactions:** 👀 1");
        expect(ai).toContain("| Total Comments | 2 |");
        expect(ai).toContain("| Most Active | @bob (2) |");
        expect(ai).toContain("| Bot Comments | 1 |");
        expect(ai).toContain("| Date Range | 02.03.2026 11:00 → 03.03.2026 12:00 |");
        expect(ai).toContain("- Fixes #7 (closed): Old bug");
        expect(ai).not.toContain("SECRET-BODY-ONE");
        expect(ai.trimEnd().endsWith("_Fetched: 2026-03-05 09:00_")).toBe(true);
    });

    test("the ai summary leaves out the saved-file line without a path and the index with noIndex", () => {
        const ai = formatIssue(makeIssueData(), "ai", { noIndex: true });

        expect(ai).not.toContain("Full content saved to");
        expect(ai).not.toContain("## Index");
        expect(formatIssue(makeIssueData({ comments: [makeComment()] }), "ai")).toContain("## Index");
    });

    test("dates that are empty or not dates print a dash instead of a broken timestamp", () => {
        const invalid = makeIssueData({
            issue: makeIssue({ created_at: "garbage", updated_at: "" }),
            comments: [makeComment()],
        });
        const empty = makeIssueData({ issue: makeIssue({ created_at: "" }) });

        const md = formatIssue(invalid, "md");

        expect(md).toContain("**Created:** - | **Updated:** -");
        expect(md).toMatch(/\| Description \| \d+-\d+ \| - \|/);
        expect(formatIssue(empty, "md")).toMatch(/\| Description \| \d+-\d+ \| - \|/);
    });

    test("an issue that is a pull request is labelled PR in the ai summary", () => {
        expect(formatIssue(makeIssueData({ issue: makePull() }), "ai")).toContain("# PR #77: Add widget cache");
    });
});

describe("formatPR", () => {
    test("json is the data itself", () => {
        const data = makePrData();

        expect(SafeJSON.parse(formatPR(data, "json"))).toEqual(SafeJSON.parse(SafeJSON.stringify(data)));
    });

    test("markdown puts branch, change size, draft and merge state before the index", () => {
        const md = formatPR(
            makePrData({
                pr: makePull({
                    draft: true,
                    merged: true,
                    merged_at: localIso(2026, 3, 4, 16, 0),
                    merged_by: { login: "erin", id: 5, type: "User" },
                }),
            }),
            "md"
        );

        expect(md).toContain("# PR #77: Add widget cache");
        expect(md).toContain(
            "**URL:** [https://github.com/acme/widgets/pull/77](https://github.com/acme/widgets/pull/77)"
        );
        expect(md).toContain("**Branch:** feat/x → main");
        expect(md).toContain("**Changes:** +10 -2 in 3 files");
        expect(md).toContain("**Status:** Draft");
        expect(md).toContain("**Merged:** 2026-03-04 16:00 by @erin");
        expect(md.indexOf("**Branch:**")).toBeLessThan(md.indexOf("## Index"));
    });

    test("a merged pull request with no merger shows an unknown merger", () => {
        const md = formatPR(makePrData({ pr: makePull({ merged: true, merged_at: null }) }), "md");

        expect(md).toContain("**Merged:** - by @unknown");
    });

    test("a pull request with no body points at the pr command", () => {
        const md = formatPR(makePrData({ pr: makePull({ body: null }) }), "md");

        expect(md).toContain("tools github pr https://github.com/acme/widgets/pull/77 --full");
    });

    test("review threads are embedded before the statistics", () => {
        const thread = makeThread({ suggestedCode: "x" });
        const comments = [makeComment()];
        const md = formatPR(
            makePrData({
                comments,
                stats: calculateStats(comments),
                reviewThreads: [thread],
                reviewThreadStats: makeReview({ threads: [thread] }).stats,
            }),
            "md"
        );

        expect(md).toContain("PR Review: #77");
        expect(md).toContain("### Thread #1 (PRRT_1): Null check missing");
        expect(md).toContain("```suggestion\nx\n```");
        expect(md.indexOf("PR Review: #77")).toBeLessThan(md.lastIndexOf("## Statistics"));
    });

    test("review threads without a statistics table go before the footer", () => {
        const thread = makeThread();
        const md = formatPR(
            makePrData({ reviewThreads: [thread], reviewThreadStats: makeReview({ threads: [thread] }).stats }),
            "md"
        );

        expect(md.indexOf("PR Review: #77")).toBeLessThan(md.lastIndexOf("_Fetched:"));
        expect(md.indexOf("PR Review: #77")).toBeGreaterThan(md.indexOf("## Description"));
    });

    test("flat review comments list their file, line, author and the last three diff lines", () => {
        const comments = [makeComment()];
        const md = formatPR(
            makePrData({
                comments,
                stats: calculateStats(comments),
                reviewComments: [
                    {
                        ...makeComment({ id: 9, author: "dave", body: "Rename this." }),
                        path: "src/a.ts",
                        diffHunk: "@@ -1,4 +1,4 @@\n one\n two\n three\n four",
                        line: 4,
                        side: "RIGHT",
                    },
                    {
                        ...makeComment({ id: 10, author: "dave", body: "Whole file." }),
                        path: "src/b.ts",
                        diffHunk: "@@ -1 +1 @@\n only",
                        line: null,
                        side: "RIGHT",
                    },
                ],
            }),
            "md"
        );

        expect(md).toContain("## Review Comments (2)");
        expect(md).toContain("### src/a.ts:4 — @dave\n```\n two\n three\n four\n```\nRename this.");
        expect(md).not.toContain(" one\n two");
        expect(md).toContain("### src/b.ts:file — @dave");
        expect(md.indexOf("## Review Comments (2)")).toBeLessThan(md.lastIndexOf("## Statistics"));
    });

    test("a diff is added as a fenced block before the footer", () => {
        const md = formatPR(makePrData({ diff: "diff --git a/x b/x\n+added" }), "md");

        expect(md).toContain("## Diff\n\n```diff\ndiff --git a/x b/x\n+added\n```");
        expect(md.indexOf("## Diff")).toBeLessThan(md.lastIndexOf("_Fetched:"));
    });

    test("the ai summary adds a PR details block before the fetch line", () => {
        const ai = formatPR(
            makePrData({
                pr: makePull({
                    draft: true,
                    merged: true,
                    merged_at: localIso(2026, 3, 4, 16, 0),
                    merged_by: { login: "erin", id: 5, type: "User" },
                }),
            }),
            "ai"
        );

        expect(ai).toContain("## PR Details");
        expect(ai).toContain("- **Branch:** feat/x → main");
        expect(ai).toContain("- **Changes:** +10 -2 in 3 files");
        expect(ai).toContain("- **Status:** Draft");
        expect(ai).toContain("- **Merged:** 2026-03-04 16:00 by @erin");
        expect(ai.indexOf("## PR Details")).toBeLessThan(ai.lastIndexOf("_Fetched:"));
    });

    test("the ai summary embeds the terminal review before the fetch line", () => {
        const thread = makeThread({ title: "Needs a guard" });
        const ai = formatPR(
            makePrData({ reviewThreads: [thread], reviewThreadStats: makeReview({ threads: [thread] }).stats }),
            "ai"
        );
        const plain = stripAnsi(ai);

        expect(plain).toContain("[THREAD #1 PRRT_1] HIGH - Needs a guard");
        expect(plain.indexOf("[THREAD #1")).toBeLessThan(plain.lastIndexOf("_Fetched:"));
    });
});

describe("formatPR markdown layout", () => {
    const flatComment = {
        ...makeComment({ id: 9, author: "dave", body: "Rename this." }),
        path: "src/a.ts",
        diffHunk: "@@ -1,4 +1,4 @@\n one\n two\n three\n four",
        line: 4,
        side: "RIGHT",
    };

    test("the embedded review heading is demoted from H1 to a single H2", () => {
        const thread = makeThread();
        const md = formatPR(
            makePrData({ reviewThreads: [thread], reviewThreadStats: makeReview({ threads: [thread] }).stats }),
            "md"
        );

        expect(md.match(/^#{1,6} PR Review: #77$/gm)).toEqual(["## PR Review: #77"]);
    });

    test("with an index the pull request lines sit between the metadata and the index", () => {
        const md = formatPR(makePrData({ pr: makePull({ draft: true }) }), "md");

        expect(md).toContain(
            "**Updated:** 2026-03-02 10:30\n\n**Branch:** feat/x → main\n**Changes:** +10 -2 in 3 files\n**Status:** Draft\n## Index"
        );
    });

    test("without an index the branch, change size, draft and merge lines still come before the description", () => {
        const md = formatPR(
            makePrData({
                pr: makePull({
                    draft: true,
                    merged: true,
                    merged_at: localIso(2026, 3, 4, 16, 0),
                    merged_by: { login: "erin", id: 5, type: "User" },
                }),
            }),
            "md",
            { noIndex: true }
        );

        expect(md).not.toContain("## Index");
        expect(md).toContain(
            "**Updated:** 2026-03-02 10:30\n\n**Branch:** feat/x → main\n**Changes:** +10 -2 in 3 files\n" +
                "**Status:** Draft\n**Merged:** 2026-03-04 16:00 by @erin\n\n---\n\n## Description"
        );
    });

    test("flat review comments are listed when there is no statistics table, before the footer", () => {
        const md = formatPR(makePrData({ reviewComments: [flatComment] }), "md");

        expect(md).not.toContain("## Statistics");
        expect(md).toContain("## Review Comments (1)");
        expect(md).toContain("### src/a.ts:4 — @dave\n```\n two\n three\n four\n```\nRename this.");
        expect(md.indexOf("## Review Comments (1)")).toBeLessThan(md.lastIndexOf("_Fetched:"));
    });

    test("without a statistics table the review threads, review comments and diff keep that order before the footer", () => {
        const thread = makeThread();
        const md = formatPR(
            makePrData({
                reviewThreads: [thread],
                reviewThreadStats: makeReview({ threads: [thread] }).stats,
                reviewComments: [flatComment],
                diff: "+added",
            }),
            "md"
        );

        const positions = ["PR Review: #77", "## Review Comments (1)", "## Diff", "_Fetched:"].map((needle) =>
            md.indexOf(needle)
        );
        expect(positions.every((position) => position > 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    test("without an index the review comments and statistics still come out in order", () => {
        const comments = [makeComment()];
        const md = formatPR(
            makePrData({ comments, stats: calculateStats(comments), reviewComments: [flatComment] }),
            "md",
            { noIndex: true }
        );

        expect(md.indexOf("## Review Comments (1)")).toBeLessThan(md.lastIndexOf("## Statistics"));
    });
});

describe("formatSearchResults", () => {
    const issue: SearchResult = {
        type: "issue",
        number: 5,
        title: "Crash",
        state: "open",
        author: "alice",
        createdAt: localIso(2026, 3, 1),
        updatedAt: localIso(2026, 3, 2),
        comments: 1,
        reactions: 3,
        repo: "acme/widgets",
        url: "https://github.com/acme/widgets/issues/5",
    };
    const pull: SearchResult = {
        ...issue,
        type: "pr",
        number: 6,
        title: "Fix",
        state: "closed",
        reactions: 0,
        url: "https://github.com/acme/widgets/pull/6",
    };

    test("json is the list itself", () => {
        expect(SafeJSON.parse(formatSearchResults([issue, pull], "json"))).toEqual(
            SafeJSON.parse(SafeJSON.stringify([issue, pull]))
        );
    });

    test("markdown is a table with a type icon, a state icon and a dash for no reactions", () => {
        const md = formatSearchResults([issue, pull], "md");

        expect(md).toContain("# Search Results (2)");
        expect(md).toContain("| # | Type | Title | State | Author | Reactions | Repo |");
        expect(md).not.toContain("| Src |");
        expect(md).toContain(
            "| [#5](https://github.com/acme/widgets/issues/5) | 📋 | Crash | 🟢 open | @alice | 3 | acme/widgets |"
        );
        expect(md).toContain(
            "| [#6](https://github.com/acme/widgets/pull/6) | 🔀 | Fix | 🔴 closed | @alice | - | acme/widgets |"
        );
        expect(md.trimEnd().endsWith("_Found 2 results_")).toBe(true);
    });

    test("a result list with sources gets a Src column that tags both, advanced and legacy", () => {
        const md = formatSearchResults(
            [
                { ...issue, number: 1, source: "both" },
                { ...issue, number: 2, source: "advanced" },
                { ...issue, number: 3, source: "legacy" },
                { ...issue, number: 4 },
            ],
            "md"
        );
        const rows = md.split("\n").filter((line) => line.startsWith("| [#"));

        expect(md).toContain("| # | Type | Title | State | Author | Reactions | Repo | Src |");
        expect(rows.map((row) => row.split("|").at(-2)?.trim())).toEqual(["A+L", "A", "L", ""]);
    });
});

describe("formatRepoResults", () => {
    const repo: RepoSearchResult = {
        name: "acme/widgets",
        description: "A widget toolkit",
        language: "TypeScript",
        stars: 1234,
        forks: 30,
        openIssues: 4,
        topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        archived: false,
        url: "https://github.com/acme/widgets",
        pushedAt: localIso(2026, 3, 4, 10, 0),
        createdAt: localIso(2020, 1, 1),
        license: "MIT",
    };

    test("json is the list itself", () => {
        expect(SafeJSON.parse(formatRepoResults([repo], "json"))).toEqual(SafeJSON.parse(SafeJSON.stringify([repo])));
    });

    test("markdown shows stars in thousands, language, description, eight topics and the push time", () => {
        const md = formatRepoResults([repo], "md");

        expect(md).toContain("Found 1 repository");
        expect(md).toContain("**acme/widgets** — ★1.2k forks:30 · TypeScript");
        expect(md).toContain("  A widget toolkit");
        expect(md).toContain("  Topics: a, b, c, d, e, f, g, h\n");
        expect(md).toContain("  https://github.com/acme/widgets · pushed 2026-03-04 10:00");
    });

    test("markdown marks an archived repository and skips missing description, language and topics", () => {
        const md = formatRepoResults(
            [
                repo,
                {
                    ...repo,
                    name: "acme/old",
                    stars: 5,
                    forks: 0,
                    archived: true,
                    description: null,
                    language: null,
                    topics: [],
                },
            ],
            "md"
        );

        expect(md).toContain("Found 2 repositories");
        expect(md).toContain("**acme/old** [ARCHIVED] — ★5 forks:0\n");
        const oldBlock = md.slice(md.indexOf("**acme/old**"));
        expect(oldBlock).not.toContain("Topics:");
        expect(oldBlock.split("\n")[1]).toContain("https://github.com/acme/widgets");
    });
});

describe("formatNotifications", () => {
    const items: NotificationItem[] = [
        {
            id: "1",
            title: "Fix it",
            repo: "acme/widgets",
            reason: "review_requested",
            type: "PullRequest",
            unread: true,
            updatedAt: localIso(2026, 3, 4, 10, 0),
            webUrl: "https://github.com/acme/widgets/pull/5",
            number: 5,
        },
        {
            id: "2",
            title: "Release 1",
            repo: "acme/widgets",
            reason: "subscribed",
            type: "Release",
            unread: false,
            updatedAt: localIso(2026, 3, 3, 10, 0),
            webUrl: "https://github.com/acme/widgets/releases/1",
            number: null,
        },
    ];

    test("json is the list itself", () => {
        expect(SafeJSON.parse(formatNotifications(items, "json"))).toEqual(SafeJSON.parse(SafeJSON.stringify(items)));
    });

    test("an empty list says so", () => {
        expect(formatNotifications([], "md")).toBe("# Notifications (0)\n\nNo notifications found.");
    });

    test("markdown counts unread items and reasons and prints one row per item", () => {
        const md = formatNotifications(items, "md");

        expect(md).toContain("# Notifications (2)");
        expect(md).toContain("**Unread:** 1 / 2");
        expect(md).toContain("**Reasons:** review_requested (1), subscribed (1)");
        expect(md).toContain(
            `| 1 | ● | PR | [Fix it](https://github.com/acme/widgets/pull/5) #5 | acme/widgets | review_requested | ${new Date(items[0].updatedAt).toLocaleDateString()} |`
        );
        expect(md).toContain(
            `| 2 | ○ | Release | [Release 1](https://github.com/acme/widgets/releases/1)  | acme/widgets | subscribed | ${new Date(items[1].updatedAt).toLocaleDateString()} |`
        );
    });
});

describe("formatActivity", () => {
    const items: ActivityItem[] = [
        {
            id: "1",
            type: "PushEvent",
            actor: "alice",
            repo: "acme/widgets",
            summary: "pushed 2 commits",
            createdAt: localIso(2026, 3, 4, 10, 0),
            url: "https://github.com/acme/widgets/compare/a...b",
        },
        {
            id: "2",
            type: "WatchEvent",
            actor: "bob",
            repo: "acme/widgets",
            summary: "starred acme/widgets",
            createdAt: localIso(2026, 3, 4, 11, 0),
            url: null,
        },
    ];

    test("json is the list itself", () => {
        expect(SafeJSON.parse(formatActivity(items, "json"))).toEqual(SafeJSON.parse(SafeJSON.stringify(items)));
    });

    test("an empty feed says so", () => {
        expect(formatActivity([], "ai")).toBe("# Activity Feed (0)\n\nNo activity found.");
    });

    test("a row links the summary only when the event has a URL", () => {
        const md = formatActivity(items, "md");

        expect(md).toContain("# Activity Feed (2)");
        expect(md).toContain(
            `| 1 | ${new Date(items[0].createdAt).toLocaleString()} | @alice | PushEvent | [pushed 2 commits](https://github.com/acme/widgets/compare/a...b) | acme/widgets |`
        );
        expect(md).toContain(
            `| 2 | ${new Date(items[1].createdAt).toLocaleString()} | @bob | WatchEvent | starred acme/widgets | acme/widgets |`
        );
    });
});

describe("formatReviewTerminal", () => {
    test("the summary box names the pull request, repository, branches, state and counts", () => {
        const threads = [
            makeThread(),
            makeThread({ threadNumber: 2, threadId: "PRRT_2", status: "resolved", severity: "low" }),
        ];
        const out = stripAnsi(
            formatReviewTerminal(
                makeReview({
                    threads,
                    headRefName: "feat/x",
                    baseRefName: "main",
                    stats: { total: 5, resolved: 3, unresolved: 2, high: 1, medium: 1, low: 3 },
                }),
                false
            )
        );

        expect(out).toContain("PR #77: Add widget cache");
        expect(out).toContain("|  Repository: acme/widgets");
        expect(out).toContain("|  Branch: feat/x → main");
        expect(out).toContain("|  Status: OPEN");
        expect(out).toContain("Summary: 5 threads (showing 2) (2 unresolved, 3 resolved)");
        expect(out).toContain("HIGH: 1  |  MEDIUM: 1  |  LOW: 3");
    });

    test("a title longer than 70 characters is cut to 70 and the branch line is skipped without branches", () => {
        const out = stripAnsi(formatReviewTerminal(makeReview({ title: "x".repeat(100) }), false));

        expect(out).toContain(`PR #77: ${"x".repeat(70)} `);
        expect(out).not.toContain("x".repeat(71));
        expect(out).not.toContain("Branch:");
    });

    test("no threads prints a notice and still prints pull-request-level comments", () => {
        const prComments: PRLevelComment[] = [
            {
                id: "R1",
                author: "frank",
                body: "Ship it.",
                createdAt: "2026-03-09T08:00:00Z",
                type: "review",
                reviewState: "APPROVED",
            },
            { id: "R2", author: "gina", body: "Thanks!", createdAt: "2026-03-10T08:00:00Z", type: "comment" },
            {
                id: "R3",
                author: "hank",
                body: "Needs work.",
                createdAt: "2026-03-10T09:00:00Z",
                type: "review",
                reviewState: "CHANGES_REQUESTED",
            },
        ];
        const out = stripAnsi(formatReviewTerminal(makeReview({ threads: [], prComments }), true));

        expect(out).toContain("PR-LEVEL COMMENTS (3)");
        expect(out).toContain("APPROVED @frank 2026-03-09\nShip it.");
        expect(out).toContain("COMMENT @gina 2026-03-10\nThanks!");
        expect(out).toContain("CHANGES_REQUESTED @hank 2026-03-10\nNeeds work.");
        expect(out).toContain("No review comments found.");
        expect(out).not.toContain("[THREAD");
    });

    test("grouping by file adds a header per file with its thread count; without it there are none", () => {
        const threads = [
            makeThread({ file: "src/a.ts" }),
            makeThread({ threadNumber: 2, threadId: "PRRT_2", file: "src/b.ts" }),
            makeThread({ threadNumber: 3, threadId: "PRRT_3", file: "src/a.ts" }),
        ];
        const grouped = stripAnsi(formatReviewTerminal(makeReview({ threads }), true));
        const flat = stripAnsi(formatReviewTerminal(makeReview({ threads }), false));

        expect(grouped).toContain("FILE: src/a.ts (2 threads)");
        expect(grouped).toContain("FILE: src/b.ts (1 threads)");
        expect(grouped.indexOf("[THREAD #3")).toBeLessThan(grouped.indexOf("FILE: src/b.ts"));
        expect(flat).not.toContain("FILE:");
        expect(flat).toContain("[THREAD #3 PRRT_3]");
    });

    test("a thread shows status, file range, ids, issue text and numbered replies", () => {
        const out = stripAnsi(
            formatReviewTerminal(
                makeReview({
                    threads: [
                        makeThread({
                            startLine: 10,
                            line: 12,
                            severity: "medium",
                            replies: [
                                {
                                    author: "dave",
                                    body: "Looks good\n\nsecond line",
                                    id: "R_1",
                                    createdAt: "2026-03-10T09:30:00Z",
                                },
                                { author: "erin", body: "Same here", id: "R_2", createdAt: "2026-03-10T09:40:00Z" },
                            ],
                        }),
                    ],
                }),
                false
            )
        );

        expect(out).toContain("[THREAD #1 PRRT_1] MEDIUM - Null check missing");
        expect(out).toContain("Status:   X UNRESOLVED (2 replies)");
        expect(out).toContain("File:     src/a.ts:10-12");
        expect(out).toContain("Author:   carol");
        expect(out).toContain("Thread ID: #1 (PRRT_1)");
        expect(out).toContain("First Comment ID: C_1");
        expect(out).toContain("Issue:\nAdd a null check.");
        expect(out).toContain("  > dave (R_1): Looks good\n\n  > second line\n\n");
        expect(out).toContain("  > erin (R_2): Same here");
    });

    test("a resolved thread with one reply and a single line says RESOLVED and (1 reply)", () => {
        const out = stripAnsi(
            formatReviewTerminal(
                makeReview({
                    threads: [
                        makeThread({
                            status: "resolved",
                            severity: "low",
                            line: 7,
                            replies: [{ author: "dave", body: "Done", id: "R_1", createdAt: "2026-03-10T09:30:00Z" }],
                        }),
                    ],
                }),
                false
            )
        );

        expect(out).toContain("LOW - Null check missing");
        expect(out).toContain("Status:   OK RESOLVED (1 reply)");
        expect(out).toContain("File:     src/a.ts:7\n");
    });

    test("a thread without a line shows the bare file name", () => {
        const out = stripAnsi(formatReviewTerminal(makeReview({ threads: [makeThread({ line: null })] }), false));

        expect(out).toContain("File:     src/a.ts\n");
    });

    test("the code context marks the commented line with an arrow and skips removed lines", () => {
        const diffHunk = "@@ -10,3 +10,4 @@\n context\n-old\n+new\n tail";
        const out = stripAnsi(
            formatReviewTerminal(makeReview({ threads: [makeThread({ line: 11, diffHunk })] }), false)
        );

        expect(out).toContain("Code Context:");
        expect(out).toContain("@@ -10,3 +10,4 @@\n    context\n   -old\n-> +new\n    tail");
    });

    test("a multi-line comment marks every line of its range", () => {
        const diffHunk = "@@ -10,3 +10,4 @@\n context\n-old\n+new\n tail";
        const out = stripAnsi(
            formatReviewTerminal(makeReview({ threads: [makeThread({ startLine: 11, line: 12, diffHunk })] }), false)
        );

        expect(out).toContain("-> +new\n->  tail");
        expect(out).not.toContain("->  context");
    });

    test("a suggestion lists the removed lines of the hunk and then the added lines", () => {
        const diffHunk = "@@ -1,2 +1,2 @@\n-const a = b;\n+const a = b ?? 0;";
        const out = stripAnsi(
            formatReviewTerminal(
                makeReview({ threads: [makeThread({ line: 1, diffHunk, suggestedCode: "const a = b ?? 1;" })] }),
                false
            )
        );

        expect(out).toContain("Suggested Change:\n```diff\n-const a = b;\n+const a = b ?? 1;\n```");
    });

    test("a suggestion without a hunk shows only added lines", () => {
        const out = stripAnsi(
            formatReviewTerminal(makeReview({ threads: [makeThread({ suggestedCode: "one\ntwo" })] }), false)
        );

        expect(out).toContain("Suggested Change:\n```diff\n+one\n+two\n```");
    });
});

describe("formatReviewMarkdown", () => {
    afterEach(() => {
        setSystemTime();
    });

    test("the header and summary table carry the pull request, link, branches, state and counts", () => {
        setSystemTime(new Date("2026-03-10T12:00:00Z"));
        const md = formatReviewMarkdown(
            makeReview({
                threads: [
                    makeThread(),
                    makeThread({ threadNumber: 2, threadId: "PRRT_2", status: "resolved", severity: "medium" }),
                ],
                headRefName: "feat/x",
                baseRefName: "main",
                stats: { total: 4, resolved: 3, unresolved: 1, high: 1, medium: 2, low: 1 },
            }),
            false
        );

        expect(md).toContain("# PR Review: #77\n\n**Add widget cache**");
        expect(md).toContain("| **Repository** | [acme/widgets](https://github.com/acme/widgets/pull/77) |");
        expect(md).toContain("| **Branch** | `feat/x` → `main` |");
        expect(md).toContain("| **State** | OPEN |");
        expect(md).toContain("| **Generated** | 2026-03-10T12:00:00.000Z |");
        expect(md).toContain("| Total Threads | 4 (showing 2) |");
        expect(md).toContain("| [X] Unresolved | 1 |");
        expect(md).toContain("| [OK] Resolved | 3 |");
        expect(md).toContain("| [HIGH] High Priority | 1 |");
        expect(md).toContain("| [MED] Medium Priority | 2 |");
        expect(md).toContain("| [LOW] Low Priority | 1 |");
    });

    test("no branches means no branch row, and no threads ends with a notice", () => {
        const md = formatReviewMarkdown(makeReview({ threads: [] }), true);

        expect(md).not.toContain("**Branch**");
        expect(md).not.toContain("## Review Threads");
        expect(md.endsWith("*No review comments found.*\n")).toBe(true);
    });

    test("pull-request-level comments show the review state only for reviews", () => {
        const md = formatReviewMarkdown(
            makeReview({
                threads: [],
                prComments: [
                    {
                        id: "R1",
                        author: "frank",
                        body: "Ship it.",
                        createdAt: "2026-03-09T08:00:00Z",
                        type: "review",
                        reviewState: "APPROVED",
                    },
                    { id: "R2", author: "gina", body: "Thanks!", createdAt: "2026-03-10T08:00:00Z", type: "comment" },
                ],
            }),
            false
        );

        expect(md).toContain("## PR-Level Comments");
        expect(md).toContain("### @frank — APPROVED (2026-03-09)\n\nShip it.");
        expect(md).toContain("### @gina (2026-03-10)\n\nThanks!");
    });

    test("grouping by file puts a heading and a thread count above each file's threads", () => {
        const threads = [
            makeThread({ file: "src/a.ts" }),
            makeThread({ threadNumber: 2, threadId: "PRRT_2", file: "src/b.ts" }),
            makeThread({ threadNumber: 3, threadId: "PRRT_3", file: "src/a.ts" }),
        ];
        const grouped = formatReviewMarkdown(makeReview({ threads }), true);
        const flat = formatReviewMarkdown(makeReview({ threads }), false);

        expect(grouped).toContain("### `src/a.ts`\n\n*2 thread(s)*");
        expect(grouped).toContain("### `src/b.ts`\n\n*1 thread(s)*");
        expect(flat).not.toContain("thread(s)*");
        expect(flat).toContain("### Thread #3 (PRRT_3): Null check missing");
    });

    test("a thread is a property table followed by the issue, context, suggestion and replies", () => {
        const md = formatReviewMarkdown(
            makeReview({
                threads: [
                    makeThread({
                        startLine: 10,
                        line: 12,
                        diffHunk: "@@ -10 +10 @@\n+x",
                        suggestedCode: "const x = 1;",
                        replies: [
                            {
                                author: "dave",
                                body: "Looks good\nsecond",
                                id: "R_1",
                                createdAt: "2026-03-10T09:30:00Z",
                            },
                        ],
                    }),
                ],
            }),
            false
        );

        expect(md).toContain("### Thread #1 (PRRT_1): Null check missing");
        expect(md).toContain("| **Status** | [X] UNRESOLVED |");
        expect(md).toContain("| **Severity** | [HIGH] HIGH |");
        expect(md).toContain("| **File** | `src/a.ts:10-12` |");
        expect(md).toContain("| **Author** | @carol |");
        expect(md).toContain("| **Thread ID** | #1 (`PRRT_1`) |");
        expect(md).toContain("| **First Comment ID** | `C_1` |");
        expect(md).toContain("| **Replies** | 1 |");
        expect(md).toContain("**Issue:**\n\nAdd a null check.");
        expect(md).toContain("Comment targets **lines 10-12**");
        expect(md).toContain("```diff\n@@ -10 +10 @@\n+x\n```");
        expect(md).toContain("**Suggested Change:**\n\n```suggestion\nconst x = 1;\n```");
        expect(md).toContain("- **@dave** (`R_1`):\n  Looks good\n  second");
        expect(md.trimEnd().endsWith("---")).toBe(true);
    });

    test("a single line says line N, a missing line says nothing, and a trailing newline in a suggestion is kept once", () => {
        const single = formatReviewMarkdown(
            makeReview({
                threads: [
                    makeThread({
                        line: 7,
                        status: "resolved",
                        severity: "low",
                        diffHunk: "@@ -7 +7 @@\n+x",
                        suggestedCode: "y\n",
                    }),
                ],
            }),
            false
        );
        const none = formatReviewMarkdown(
            makeReview({ threads: [makeThread({ line: null, diffHunk: "@@ -7 +7 @@\n+x" })] }),
            false
        );

        expect(single).toContain("Comment targets **line 7**");
        expect(single).toContain("| **File** | `src/a.ts:7` |");
        expect(single).toContain("| **Status** | [OK] RESOLVED |");
        expect(single).toContain("| **Severity** | [LOW] LOW |");
        expect(single).toContain("```suggestion\ny\n```");
        expect(none).toContain("| **File** | `src/a.ts` |");
        expect(none).not.toContain("Comment targets");
    });
});

describe("formatReviewJSON", () => {
    test("has the repository slug, stats, threads and an empty comment list by default", () => {
        const review = makeReview({ headRefName: "feat/x" });
        const parsed = SafeJSON.parse(formatReviewJSON(review));

        expect(parsed).toEqual({
            repository: "acme/widgets",
            prNumber: 77,
            title: "Add widget cache",
            state: "OPEN",
            stats: review.stats,
            threads: SafeJSON.parse(SafeJSON.stringify(review.threads)),
            prComments: [],
        });
    });

    test("keeps pull-request-level comments", () => {
        const prComments: PRLevelComment[] = [
            { id: "R2", author: "gina", body: "Thanks!", createdAt: "2026-03-10T08:00:00Z", type: "comment" },
        ];

        expect(SafeJSON.parse(formatReviewJSON(makeReview({ prComments }))).prComments).toEqual(prComments);
    });
});

describe("LLM review formats", () => {
    afterEach(() => {
        setSystemTime();
    });

    function freezeClock(): void {
        setSystemTime(new Date("2026-03-10T12:00:00Z"));
    }

    test("the session summary lists one compact row per thread and the follow-up commands", () => {
        freezeClock();
        const out = formatReviewLLM(
            makeReview({
                headRefName: "feat/x",
                baseRefName: "main",
                threads: [
                    makeThread({
                        startLine: 10,
                        line: 12,
                        replies: [
                            { author: "dave", body: "ok", id: "R_1", createdAt: "2026-03-10T09:30:00Z" },
                            { author: "erin", body: "ok", id: "R_2", createdAt: "2026-03-10T09:40:00Z" },
                        ],
                    }),
                    makeThread({
                        threadNumber: 2,
                        threadId: "PRRT_2",
                        status: "resolved",
                        severity: "low",
                        file: "src/b.ts",
                        line: 4,
                        title: "t".repeat(50),
                        createdAt: "2026-03-08T12:00:00Z",
                    }),
                    makeThread({
                        threadNumber: 3,
                        threadId: "PRRT_3",
                        severity: "medium",
                        file: "src/c.ts",
                        line: null,
                    }),
                ],
                stats: { total: 3, resolved: 1, unresolved: 2, high: 1, medium: 1, low: 1 },
            }),
            "sess-1"
        );

        expect(out.startsWith("=== PR Review Session: sess-1 ===\n")).toBe(true);
        expect(out).toContain("PR #77: Add widget cache | OPEN | acme/widgets\n");
        expect(out).toContain("Branch: feat/x → main\n");
        expect(out).toContain("Stats: 3 threads (2 unresolved) | HIGH: 1 | MED: 1 | LOW: 1\n");
        expect(out).toContain("  t1  UNRESOLVED  HIGH  2r  src/a.ts:10-12  Null check missing  @carol  3h ago\n");
        expect(out).toContain(`  t2  RESOLVED  LOW  src/b.ts:4  ${"t".repeat(37)}...  @carol  2d ago\n`);
        expect(out).toContain("  t3  UNRESOLVED  MEDIUM  src/c.ts  Null check missing  @carol  3h ago\n");
        expect(out).toContain("Expand: tools github review expand t1 -s sess-1\n");
        expect(out).toContain('Respond: tools github review respond t1 "message" -s sess-1\n');
        expect(out).toContain("Resolve: tools github review resolve t1,t2 -s sess-1\n");
    });

    test("a session without threads says so and offers no commands", () => {
        const out = formatReviewLLM(makeReview({ threads: [] }), "sess-1");

        expect(out).toContain("No review threads found.\n");
        expect(out).not.toContain("Branch:");
        expect(out).not.toContain("Expand:");
    });

    test("an expanded thread shows its issue, diff, suggestion, replies with their age and the commands", () => {
        freezeClock();
        const out = formatThreadExpanded(
            makeThread({
                startLine: 10,
                line: 12,
                diffHunk: "@@ -10 +10 @@\n+x",
                suggestedCode: "const x = 1;",
                replies: [{ author: "dave", body: "Looks good", id: "R_1", createdAt: "2026-03-10T11:30:00Z" }],
            }),
            "sess-1"
        );

        expect(out).toContain("=== Session: sess-1 | Thread t1 ===\n\nThread #1: Null check missing\n");
        expect(out).toContain("Status: UNRESOLVED | Severity: HIGH\n");
        expect(out).toContain("File: src/a.ts:10-12 | Author: @carol | 3h ago\n");
        expect(out).toContain("Thread ID: PRRT_1\n");
        expect(out).toContain("Issue:\nAdd a null check.\n");
        expect(out).toContain("Diff Context:\n@@ -10 +10 @@\n+x\n");
        expect(out).toContain("Suggested Change:\n```suggestion\nconst x = 1;\n```\n");
        expect(out).toContain("Replies (1):\n  @dave (30m ago): Looks good\n");
        expect(out).toContain('Respond: tools github review respond t1 "message" -s sess-1\n');
        expect(out).toContain("Resolve: tools github review resolve t1 -s sess-1\n");
    });

    test("an expanded thread without a line, diff, suggestion or replies leaves those parts out", () => {
        freezeClock();
        const out = formatThreadExpanded(makeThread({ line: null }), "sess-1");

        expect(out).toContain("File: src/a.ts | Author: @carol | 3h ago\n");
        expect(out).not.toContain("Diff Context:");
        expect(out).not.toContain("Suggested Change:");
        expect(out).not.toContain("Replies (");
    });

    test("pull-request-level comments are listed with a state tag for reviews only", () => {
        expect(formatPrCommentsLLM([], "sess-1")).toBe("No PR-level comments.\n");

        const out = formatPrCommentsLLM(
            [
                {
                    id: "R1",
                    author: "frank",
                    body: "Ship it.",
                    createdAt: "2026-03-09T08:00:00Z",
                    type: "review",
                    reviewState: "APPROVED",
                },
                { id: "R2", author: "gina", body: "Thanks!", createdAt: "2026-03-10T08:00:00Z", type: "comment" },
            ],
            "sess-1"
        );

        expect(out).toContain("=== PR-Level Comments (2) | Session: sess-1 ===\n\n");
        expect(out).toContain("--- @frank [APPROVED] (2026-03-09) ---\nShip it.\n\n");
        expect(out).toContain("--- @gina (2026-03-10) ---\nThanks!\n\n");
    });
});

describe("saveReviewMarkdown", () => {
    const stamp = "2026-02-03T04-05-06";
    let root: string;
    const tmpSlug = `gt-review-save-${process.pid}`;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "gt-review-save-"));
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(join(tmpdir(), "github", "reviews", tmpSlug), { recursive: true, force: true });
    });

    afterEach(() => {
        setSystemTime();
    });

    function freezeClock(): void {
        setSystemTime(new Date("2026-02-03T04:05:06.789Z"));
    }

    test("a folder path without an extension gets a timestamped file inside it", async () => {
        freezeClock();
        const path = await saveReviewMarkdown({
            content: "# one",
            prNumber: 7,
            save: "out/reviews",
            originalCwd: root,
        });

        expect(path).toBe(join(root, "out", "reviews", `pr-7-${stamp}.md`));
        expect(readFileSync(path, "utf8")).toBe("# one");
    });

    test("a path ending in a slash is a folder even when its name has an extension", async () => {
        freezeClock();
        const path = await saveReviewMarkdown({ content: "# two", prNumber: 8, save: "notes.d/", originalCwd: root });

        expect(path).toBe(join(root, "notes.d", `pr-8-${stamp}.md`));
        expect(readFileSync(path, "utf8")).toBe("# two");
    });

    test("a path with an extension is the file itself, and its folder is created", async () => {
        const path = await saveReviewMarkdown({
            content: "# three",
            prNumber: 9,
            save: "docs/deep/review.md",
            originalCwd: root,
        });

        expect(path).toBe(join(root, "docs", "deep", "review.md"));
        expect(readFileSync(path, "utf8")).toBe("# three");
    });

    test("save true writes under .claude/reviews in the original folder", async () => {
        freezeClock();
        const path = await saveReviewMarkdown({ content: "# four", prNumber: 10, save: true, originalCwd: root });

        expect(path).toBe(join(root, ".claude", "reviews", `pr-10-${stamp}.md`));
        expect(readFileSync(path, "utf8")).toBe("# four");
    });

    test("without save the file goes to the temp folder under the repository name", async () => {
        freezeClock();
        const path = await saveReviewMarkdown({ content: "# five", prNumber: 11, repo: tmpSlug });

        expect(path).toBe(join(tmpdir(), "github", "reviews", tmpSlug, `pr-11-${stamp}.md`));
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("# five");
    });
});
