import { describe, expect, test } from "bun:test";
import { expectedLabels, parseIids, parseLabels, renderChangeTable, sameLabels } from "@app/gitlab/lib/label-batch";
import {
    type DiscussionSummary,
    type DraftSummary,
    findUnanchoredDrafts,
    renderDiscussionTable,
    renderDraftTable,
} from "@app/gitlab/lib/review-drafts";
import {
    collectUnresolvedAnchorPairs,
    type Discussion,
    renderMarkdown,
    unresolvedThreads,
} from "@app/gitlab/lib/review-render";
import { formatSearchText, type MRNode, matchedPaths } from "@app/gitlab/lib/search-by-file";

const draft = (id: number, discussionId: string | null, path: string | null = null): DraftSummary => ({
    id,
    discussionId,
    path,
    line: path ? 12 : null,
    note: "body",
});

describe("findUnanchoredDrafts", () => {
    test("flags drafts that carry no discussion id", () => {
        const drafts = [draft(1, "abc"), draft(2, null), draft(3, "def")];

        expect(findUnanchoredDrafts(drafts).map((d) => d.id)).toEqual([2]);
    });

    test("does not flag a top-level draft the caller declared intentional", () => {
        expect(findUnanchoredDrafts([draft(1, "abc"), draft(2, null)], [2])).toEqual([]);
    });

    test("returns nothing when every draft is a reply", () => {
        expect(findUnanchoredDrafts([draft(1, "abc"), draft(2, "def")])).toEqual([]);
    });
});

describe("renderDraftTable", () => {
    test("distinguishes a reply from a top-level draft", () => {
        const rendered = renderDraftTable([draft(501, "3f9c2d1e8b7a6c5d4e", "client.ts"), draft(502, null)]);

        expect(rendered).toContain("reply → 3f9c2d1e8b7a");
        expect(rendered).toContain("client.ts:12");
        expect(rendered).toContain("TOP-LEVEL");
    });
});

describe("renderDiscussionTable", () => {
    const discussion = (over: Partial<DiscussionSummary> = {}): DiscussionSummary => ({
        id: "3f9c2d1e8b7a6c5d4e123456",
        author: "alice",
        path: "src/api/client.ts",
        line: 34,
        body: "Can't this  do\nsomething weird",
        resolved: false,
        noteCount: 2,
        ...over,
    });

    test("shows the thread author, because that is who second person addresses", () => {
        expect(renderDiscussionTable([discussion()])).toContain("alice");
    });

    test("collapses whitespace in the quoted body", () => {
        expect(renderDiscussionTable([discussion()])).toContain("Can't this do something weird");
    });

    test("labels an unanchored thread and reports resolved state", () => {
        const rendered = renderDiscussionTable([discussion({ path: null, line: null, resolved: true })]);

        expect(rendered).toContain("TOP-LEVEL");
        expect(rendered).toContain("resolved");
    });
});

describe("label batch", () => {
    test("parse iids as unique numbers and reject junk", () => {
        expect(parseIids("12, 34,12")).toEqual([12, 34]);
        expect(() => parseIids("12,abc")).toThrow("must be numbers");
    });

    test("parse labels from repeated and comma-separated values", () => {
        expect(parseLabels(["Stale, Needs review", "Stale"])).toEqual(["Stale", "Needs review"]);
    });

    test("expected labels remove then add, sorted", () => {
        expect(expectedLabels(["b", "a"], ["c"], ["a"])).toEqual(["b", "c"]);
        expect(sameLabels(["b", "a"], ["a", "b"])).toBe(true);
        expect(sameLabels(["a"], ["a", "b"])).toBe(false);
    });

    test("the change table shows before, after and result per MR", () => {
        const md = renderChangeTable([
            {
                iid: 1,
                title: "t",
                webUrl: "u",
                before: ["a"],
                expected: ["a", "b"],
                after: ["a", "b"],
                ok: true,
                unchanged: false,
                status: 200,
            },
            {
                iid: 2,
                title: "t",
                webUrl: "u",
                before: ["a", "b"],
                expected: ["a", "b"],
                after: ["a", "b"],
                ok: true,
                unchanged: true,
                status: 0,
            },
            {
                iid: 3,
                title: "t",
                webUrl: "u",
                before: [],
                expected: ["b"],
                after: null,
                ok: false,
                unchanged: false,
                status: 403,
                error: "Forbidden",
            },
        ]);

        expect(md).toContain("| !1 | a | a, b | ok |");
        expect(md).toContain("| !2 | a, b | a, b | unchanged |");
        expect(md).toContain("| !3 | (none) | b | FAIL 403 Forbidden |");
        expect(
            renderChangeTable([
                {
                    iid: 4,
                    title: "t",
                    webUrl: "u",
                    before: [],
                    expected: ["b"],
                    after: null,
                    ok: true,
                    unchanged: false,
                    status: 0,
                },
            ])
        ).toContain("| !4 | (none) | b | planned |");
    });
});

describe("review render", () => {
    const position = { head_sha: "a1b2c3d4e5f6a7b8", base_sha: "0f0f0f0f0f", new_path: "src/app.ts", new_line: 2 };
    const discussions: Discussion[] = [
        {
            id: "t1",
            notes: [{ resolvable: true, resolved: false, position, author: { username: "bob" }, body: "Why | this?" }],
        },
        { id: "t2", notes: [{ resolvable: true, resolved: true, position, body: "done" }] },
        { id: "t3", individual_note: true, notes: [{ body: "top-level chat" }] },
    ];

    test("only unresolved diff-attached threads count", () => {
        expect(unresolvedThreads(discussions).map((d) => d.id)).toEqual(["t1"]);
        expect([...collectUnresolvedAnchorPairs(discussions)]).toEqual(["a1b2c3d4e5f6a7b8 src/app.ts"]);
    });

    test("the report quotes the thread and compares the frozen view with the working tree", () => {
        const { md, threadCount, totalDiscussions } = renderMarkdown(discussions, {
            mrIid: "42",
            project: "acme/web-app",
            cwd: "/nonexistent-checkout",
            contextLines: 1,
            anchorViews: new Map([["a1b2c3d4e5f6a7b8:src/app.ts", ["one", "two", "three"]]]),
        });

        expect(threadCount).toBe(1);
        expect(totalDiscussions).toBe(3);
        expect(md).toContain("## Thread 1 — `src/app.ts`:2");
        expect(md).toContain("_(file not in current working tree)_");
        expect(md).toContain("2 ▶ two");
        expect(md).toContain("**@bob**:\n> Why \\| this?");
    });
});

describe("search by file", () => {
    const node = (iid: string, paths: string[]): MRNode => ({
        iid,
        title: `MR ${iid}`,
        sourceBranch: `feature/${iid}`,
        targetBranch: "main",
        webUrl: `https://gitlab.example.com/acme/web-app/-/merge_requests/${iid}`,
        updatedAt: "2026-09-01T10:00:00Z",
        commitCount: 2,
        divergedFromTargetBranch: false,
        diffStats: paths.map((path) => ({ path })),
    });

    test("a file matches exactly or as a path suffix", () => {
        expect(matchedPaths(node("1", ["bun.lock", "apps/web/bun.lock", "bun.lockb"]), ["bun.lock"])).toEqual([
            "bun.lock",
            "apps/web/bun.lock",
        ]);
    });

    test("the text output ends with the iids for a batch comment", () => {
        const text = formatSearchText([node("7", ["package.json"]), node("9", ["package.json"])], ["package.json"]);

        expect(text).toContain("2 MRs touch package.json (oldest first):");
        expect(text.split("\n").at(-1)).toBe("7,9");
        expect(formatSearchText([], ["x"])).toBe("No open MRs touch x.");
    });
});
