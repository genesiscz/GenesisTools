import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectedLabels, parseIids, parseLabels, renderChangeTable, sameLabels } from "@app/gitlab/lib/label-batch";
import { type DiffFile, parseApiDiffs } from "@app/gitlab/lib/pr-review";
import {
    anchorDrift,
    anchoredPosition,
    type DiscussionSummary,
    type DraftSummary,
    diffLinePosition,
    findUnanchoredDrafts,
    renderDiscussionTable,
    renderDraftTable,
    resolveAnchor,
    writeAnchoredDraft,
} from "@app/gitlab/lib/review-drafts";
import {
    collectUnresolvedAnchorPairs,
    type Discussion,
    fetchAnchorViews,
    renderMarkdown,
    unresolvedThreads,
} from "@app/gitlab/lib/review-render";
import { formatSearchText, type MRNode, matchedPaths, searchMrsByFiles } from "@app/gitlab/lib/search-by-file";
import { localImagePath, rewriteLocalImages, uploadToProject } from "@app/gitlab/lib/uploads";

const draft = (id: number, discussionId: string | null, path: string | null = null): DraftSummary => ({
    id,
    discussionId,
    path,
    line: path ? 12 : null,
    side: path ? "new" : null,
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

    test("does not flag a new thread anchored on a diff line", () => {
        expect(findUnanchoredDrafts([draft(1, null, "EmailEditModal.tsx")])).toEqual([]);
    });
});

const A_TS_DIFF = [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1,3 +1,4 @@\n a\n b\n+c\n d\n" }];

describe("anchoredPosition", () => {
    // A rename that also edits the file: GitLab reports the new path with the old one beside it.
    const [renamed] = parseApiDiffs([
        {
            old_path: "packages/core/src/roles/Roles.ts",
            new_path: "packages/types/src/roles/Roles.ts",
            renamed_file: true,
            diff: [
                "@@ -1,5 +1,5 @@",
                "-// TODO: replace this enum",
                "-/** @deprecated */",
                "+/** Single source of role identifiers */",
                " export enum Roles {",
                ' \tADMIN = "ADMIN",',
                '+\tEDITOR = "EDITOR",',
                ' \tVIEWER = "VIEWER",',
                "\\ No newline at end of file",
                "",
            ].join("\n"),
        },
    ]);
    const files = renamed ? [renamed] : [];
    const newPath = "packages/types/src/roles/Roles.ts";
    const oldPath = "packages/core/src/roles/Roles.ts";

    test("an unchanged line of a renamed file carries the old path and the old line", () => {
        expect(anchoredPosition(files, newPath, 2)).toEqual({
            old_path: oldPath,
            new_path: newPath,
            old_line: 3,
            new_line: 2,
        });
    });

    test("an added line of a renamed file carries the old path and no old line", () => {
        expect(anchoredPosition(files, newPath, 4)).toEqual({
            old_path: oldPath,
            new_path: newPath,
            old_line: null,
            new_line: 4,
        });
    });

    test("counts old lines past a removed block", () => {
        expect(anchoredPosition(files, newPath, 5)).toMatchObject({ old_line: 5, new_line: 5 });
    });

    test("finds the file by its old path too", () => {
        expect(anchoredPosition(files, oldPath, 2)).toMatchObject({ old_path: oldPath, new_path: newPath });
    });

    test("refuses a line outside every hunk", () => {
        expect(anchoredPosition(files, newPath, 40)).toContain("is not in the MR diff");
    });

    test("refuses a file that is not in the diff", () => {
        expect(anchoredPosition(files, "missing.ts", 1)).toBe("missing.ts is not in the MR diff");
    });
});

describe("writeAnchoredDraft", () => {
    test("refuses a line that is not a positive integer before any request", async () => {
        // Port 9 is discard: a request that got through would fail with a connection error, not this message.
        const api = { host: "http://127.0.0.1:9", token: "t", project: "group/app" };

        for (const line of [Number.NaN, 0, -3, 1.5]) {
            const result = await writeAnchoredDraft(api, { iid: "1", path: "a.ts", line, body: "x" });

            expect(result.ok).toBe(false);
            expect(result.error).toContain("positive line number");
        }
    });

    test("deletes the draft again, once, when GitLab drops the anchor", async () => {
        // GitLab answers the POST with every position field null; the DELETE fails with 502 once.
        const calls: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                calls.push(request.method);

                if (request.method === "GET") {
                    return new URL(request.url).pathname.endsWith("/diffs")
                        ? Response.json(A_TS_DIFF)
                        : Response.json({ diff_refs: { base_sha: "a", start_sha: "b", head_sha: "c" } });
                }

                if (request.method === "POST") {
                    return Response.json({ id: 77, position: null });
                }

                return new Response("bad gateway", { status: 502 });
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };
            const result = await writeAnchoredDraft(api, { iid: "1", path: "a.ts", line: 3, body: "x" });

            expect(result.ok).toBe(false);
            expect(result.draftId).toBe(77);
            expect(result.error).toContain("deleting it failed");
            // One DELETE, not three: a retried delete that had landed would answer 404.
            expect(calls).toEqual(["GET", "GET", "POST", "DELETE"]);
        } finally {
            server.stop(true);
        }
    });

    test("posts the old path and old line of a renamed file's context line", async () => {
        const posted: unknown[] = [];
        const server = Bun.serve({
            port: 0,
            async fetch(request) {
                if (request.method === "GET") {
                    return new URL(request.url).pathname.endsWith("/diffs")
                        ? Response.json([
                              {
                                  old_path: "old/a.ts",
                                  new_path: "new/a.ts",
                                  renamed_file: true,
                                  diff: A_TS_DIFF[0]?.diff,
                              },
                          ])
                        : Response.json({ diff_refs: { base_sha: "a", start_sha: "b", head_sha: "c" } });
                }

                const body = (await request.json()) as { position: Record<string, unknown> };
                posted.push(body.position);

                return Response.json({ id: 79, position: body.position });
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };
            const result = await writeAnchoredDraft(api, { iid: "1", path: "new/a.ts", line: 2, body: "x" });

            expect(result.ok).toBe(true);
            expect(posted[0]).toMatchObject({ old_path: "old/a.ts", new_path: "new/a.ts", old_line: 2, new_line: 2 });
        } finally {
            server.stop(true);
        }
    });

    test("refuses a line outside the diff before any write", async () => {
        const calls: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                calls.push(request.method);

                return Response.json(A_TS_DIFF);
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };
            const result = await writeAnchoredDraft(api, { iid: "1", path: "a.ts", line: 40, body: "x" });

            expect(result.ok).toBe(false);
            expect(result.error).toContain("cannot anchor a comment there");
            expect(calls).toEqual(["GET"]);
            // The check alone, as `draft-reply` runs it before uploading any image: one read, no write.
            expect(await resolveAnchor(api, { iid: "1", path: "a.ts", line: 40 })).toContain(
                "cannot anchor a comment there"
            );
            expect(await resolveAnchor(api, { iid: "1", path: "nope.ts", line: 1 })).toContain("not in the MR diff");
            expect(calls).toEqual(["GET", "GET", "GET"]);
        } finally {
            server.stop(true);
        }
    });
});

describe("positioned drafts", () => {
    const file: DiffFile = {
        path: "src/a.ts",
        oldPath: "src/a.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 0,
        truncated: false,
        hunks: [
            {
                header: "@@ -10,2 +10,3 @@",
                oldStart: 10,
                newStart: 10,
                lines: [
                    { kind: " ", oldLine: 10, newLine: 10, text: "a" },
                    { kind: "+", oldLine: null, newLine: 11, text: "b" },
                    { kind: " ", oldLine: 11, newLine: 12, text: "c" },
                ],
            },
        ],
    };

    test("a range endpoint on a context line is `old`, as GitLab's API documents it", () => {
        // docs.gitlab.com/api/discussions: line_range type is "new for lines added by this commit, otherwise old".
        const position = diffLinePosition({ file, side: "additions", line: 12, startLine: 10 });

        expect(typeof position).not.toBe("string");
        expect(typeof position === "string" ? null : position.line_range).toMatchObject({
            start: { type: "old", old_line: 10, new_line: 10 },
            end: { type: "old", old_line: 11, new_line: 12 },
        });
        expect(diffLinePosition({ file, side: "additions", line: 11, startLine: 10 })).toMatchObject({
            line_range: { end: { type: "new", old_line: null, new_line: 11 } },
        });
    });

    test("an anchor GitLab dropped, moved or narrowed is drift; the same anchor is not", () => {
        const position = diffLinePosition({ file, side: "additions", line: 12, startLine: 10 });

        if (typeof position === "string") {
            throw new Error(position);
        }

        const stored = { ...position, line_range: position.line_range };
        expect(anchorDrift(position, stored)).toBeNull();
        expect(anchorDrift(position, null)).toBe("dropped the anchor");
        expect(anchorDrift(position, { ...stored, new_line: 13 })).toContain("new_line 12 became 13");
        expect(anchorDrift(position, { ...stored, new_path: "src/b.ts" })).toContain("new_path");
        expect(anchorDrift(position, { ...stored, line_range: null })).toBe("dropped the line range");
    });

    test("a draft GitLab stored on another line is deleted again", async () => {
        const calls: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                calls.push(request.method);

                if (request.method === "GET") {
                    return new URL(request.url).pathname.endsWith("/diffs")
                        ? Response.json(A_TS_DIFF)
                        : Response.json({ diff_refs: { base_sha: "a", start_sha: "b", head_sha: "c" } });
                }

                if (request.method === "POST") {
                    return Response.json({
                        id: 78,
                        position: { new_path: "a.ts", old_path: "a.ts", new_line: 4, old_line: null },
                    });
                }

                return new Response(null, { status: 204 });
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };
            const result = await writeAnchoredDraft(api, { iid: "1", path: "a.ts", line: 3, body: "x" });

            expect(result.ok).toBe(false);
            expect(result.error).toContain("new_line 3 became 4");
            expect(calls).toEqual(["GET", "GET", "POST", "DELETE"]);
        } finally {
            server.stop(true);
        }
    });
});

describe("fetchAnchorViews", () => {
    test("keeps a path with a space whole, for the request and for the view key", async () => {
        // cwd is not a git checkout, so every view goes through the API fallback.
        const requested: string[] = [];
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                requested.push(new URL(request.url).pathname);

                return new Response("line one\nline two\n");
            },
        });

        try {
            const { views } = await fetchAnchorViews({
                pairs: new Set(["a1b2c3d4 docs/release notes.md"]),
                api: { host: `http://localhost:${server.port}`, token: "t", project: "group/app" },
                fetchRemote: true,
                onWarn: () => {},
                cwd: mkdtempSync(join(tmpdir(), "gt-anchor-")),
            });

            expect(requested[0]).toContain(encodeURIComponent("docs/release notes.md"));
            expect(views.get("a1b2c3d4:docs/release notes.md")).toEqual(["line one", "line two"]);
        } finally {
            server.stop(true);
        }
    });
});

describe("searchMrsByFiles retries", () => {
    test("a 401 fails at once instead of waiting through five retries", async () => {
        let requests = 0;
        const server = Bun.serve({
            port: 0,
            fetch() {
                requests += 1;

                return new Response("unauthorized", { status: 401 });
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t" };

            await expect(
                searchMrsByFiles(api, { projectPath: "group/app", files: ["a.ts"], log: () => {} })
            ).rejects.toThrow();
            expect(requests).toBe(1);
        } finally {
            server.stop(true);
        }
    });
});

describe("renderDraftTable", () => {
    test("distinguishes a reply from a top-level draft", () => {
        const rendered = renderDraftTable([draft(501, "3f9c2d1e8b7a6c5d4e", "client.ts"), draft(502, null)]);

        expect(rendered).toContain("reply → 3f9c2d1e8b7a");
        expect(rendered).toContain("client.ts:12");
        expect(rendered).toContain("TOP-LEVEL");
    });

    test("labels an anchored draft without a discussion as a new thread, not top-level", () => {
        const rendered = renderDraftTable([draft(503, null, "EmailEditModal.tsx")]);

        expect(rendered).toContain("new thread on a line");
        expect(rendered).not.toContain("TOP-LEVEL");
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
        expect(md).not.toContain("Reply with the review skill.");
        expect(
            renderMarkdown(discussions, {
                mrIid: "42",
                project: "acme/web-app",
                cwd: "/nonexistent-checkout",
                contextLines: 1,
                nextSteps: ["Reply with the review skill for !{iid}."],
            }).md
        ).toContain("- Resolve threads in the GitLab UI after verifying.\n- Reply with the review skill for !42.");
    });

    test("the report keeps its sections, excerpts and quotes (snapshot taken before the json2md move)", () => {
        const cwd = mkdtempSync(join(tmpdir(), "gt-render-"));
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "src/app.ts"), ["one", "two", "three", "four", "five"].join("\n"));
        writeFileSync(join(cwd, "src/moved.ts"), ["alpha", "beta", "gamma"].join("\n"));
        const at = (sha: string, path: string, newLine: number | null, oldLine: number | null = null) => ({
            head_sha: sha,
            base_sha: "b0b0b0b0b0b0",
            new_path: path,
            old_path: path,
            new_line: newLine,
            old_line: oldLine,
        });
        const rich: Discussion[] = [
            {
                id: "match",
                notes: [
                    {
                        resolvable: true,
                        resolved: false,
                        position: at("1111111111aa", "src/app.ts", 3),
                        author: { username: "alice" },
                        created_at: "2026-09-01T10:00:00Z",
                        body: "Rename this.\nIt reads | badly.",
                    },
                    { resolvable: true, resolved: false, author: { username: "bob" }, body: "Agreed." },
                ],
            },
            {
                id: "diverged",
                notes: [
                    {
                        resolvable: true,
                        resolved: false,
                        position: at("2222222222bb", "src/moved.ts", 2),
                        author: { username: "bob" },
                        body: "Moved?",
                    },
                ],
            },
            {
                id: "deleted",
                notes: [
                    {
                        resolvable: true,
                        resolved: false,
                        position: at("3333333333cc", "src/gone.ts", null, 7),
                        body: "Why remove it?",
                    },
                ],
            },
            {
                id: "closed",
                notes: [{ resolvable: true, resolved: true, position: at("1111111111aa", "src/app.ts", 1) }],
            },
            { id: "chat", individual_note: true, notes: [{ body: "top-level chat" }] },
        ];
        const { md } = renderMarkdown(rich, {
            mrIid: "42",
            project: "group/app",
            cwd,
            contextLines: 1,
            anchorViews: new Map([
                ["1111111111aa:src/app.ts", ["one", "two", "three", "four", "five"]],
                ["2222222222bb:src/moved.ts", ["alpha", "BETA", "gamma"]],
            ]),
        });

        expect(md.replaceAll(cwd, "<cwd>")).toMatchInlineSnapshot(`
          "# GitLab MR 42 review — unresolved threads

          - **Project**: \`group/app\`
          - **Discussions total**: 5
          - **Unresolved diff-attached threads**: 3
          - **Files touched**: 3
          - **Distinct head_shas**: 3  _(each comment may be anchored to a different commit — fetch / read at its own \`head_sha\`)_
          - **Local cwd**: \`<cwd>\`

          ---

          ## Thread 1 — \`src/app.ts\`:3

          - **File**: [app.ts:3](file://<cwd>/src/app.ts#L3)
          - **Anchored at**: \`1111111111\` _(per-thread head_sha; **NOT** necessarily MR HEAD)_
          - **Base sha**: \`b0b0b0b0b0\`
          - **Local state**: file is 5 lines locally

          ### Local working tree (lines 2–4):

          \`\`\`
          2   two
          3 ▶ three
          4   four
          \`\`\`

          ### Reviewer's frozen view at \`1111111111\` (lines 2–4):

          \`\`\`
          2   two
          3 ▶ three
          4   four
          \`\`\`

          > ✓ Local working tree matches this view at the anchor lines.

          ### Discussion (2 notes):

          **@alice** _(2026-09-01)_:
          > Rename this.
          > It reads \\| badly.

          **@bob**:
          > Agreed.

          ---

          ## Thread 2 — \`src/moved.ts\`:2

          - **File**: [moved.ts:2](file://<cwd>/src/moved.ts#L2)
          - **Anchored at**: \`2222222222\` _(per-thread head_sha; **NOT** necessarily MR HEAD)_
          - **Base sha**: \`b0b0b0b0b0\`
          - **Local state**: file is 3 lines locally

          ### Local working tree (lines 1–3):

          \`\`\`
          1   alpha
          2 ▶ beta
          3   gamma
          \`\`\`

          ### Reviewer's frozen view at \`2222222222\` (lines 1–3):

          \`\`\`
          1   alpha
          2 ▶ BETA
          3   gamma
          \`\`\`

          > ⚠️ **Local working tree diverges from this view** — the line may have moved or been refactored. Read both before applying.

          ### Discussion (1 note):

          **@bob**:
          > Moved?

          ---

          ## Thread 3 — \`src/gone.ts\`:7 _(deleted line — comment on removed code)_

          - **File**: [gone.ts:7](file://<cwd>/src/gone.ts#L7)
          - **Anchored at**: \`3333333333\` _(per-thread head_sha; **NOT** necessarily MR HEAD)_
          - **Base sha**: \`b0b0b0b0b0\`
          - **Local state**: file not in cwd

          ### Local working tree (lines 6–8):

          _(file not in current working tree)_

          ### Reviewer's frozen view at \`3333333333\` (lines 6–8):

          _(fetch failed — see stderr)_

          ### Discussion (1 note):

          **@(unknown)**:
          > Why remove it?

          ---

          ## Next steps

          - Apply the fixes to the current working tree (not to the reviewer's frozen view).
          - Resolve threads in the GitLab UI after verifying.
          "
        `);
        expect(
            renderMarkdown([], { mrIid: "7", project: "group/app", cwd: "/x", contextLines: 3 }).md
        ).toMatchInlineSnapshot(`
              "# GitLab MR 7 review — unresolved threads

              - **Project**: \`group/app\`
              - **Discussions total**: 0
              - **Unresolved diff-attached threads**: 0
              - **Files touched**: 0
              - **Distinct head_shas**: 0  _(each comment may be anchored to a different commit — fetch / read at its own \`head_sha\`)_
              - **Local cwd**: \`/x\`

              ---

              _No unresolved diff-attached threads._

              ## Next steps

              - Apply the fixes to the current working tree (not to the reviewer's frozen view).
              - Resolve threads in the GitLab UI after verifying.
              "
            `);
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

describe("local images in a draft", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-uploads-"));
    const shot = join(dir, "shot.png");
    writeFileSync(shot, "png");
    const never = async (): Promise<string> => {
        throw new Error("uploader must not run");
    };

    test("resolves absolute, home, relative, file: and Windows paths, and leaves remote targets alone", () => {
        expect(localImagePath("/tmp/a.png", "/base")).toBe("/tmp/a.png");
        expect(localImagePath("~/x/a.png", "/base")).toBe(join(homedir(), "x/a.png"));
        expect(localImagePath("shots/a.png", "/base")).toBe(resolve("/base", "shots/a.png"));
        expect(localImagePath("shots/a%20b.png", "/base")).toBe(resolve("/base", "shots/a b.png"));
        expect(localImagePath("file:///tmp/a.png", "/base")).toBe("/tmp/a.png");
        expect(localImagePath(String.raw`C:\shots\a.png`, "/base")).toBe(String.raw`C:\shots\a.png`);
        expect(localImagePath("https://example.com/a.png", "/base")).toBeNull();
        expect(localImagePath("/uploads/abc/a.png", "/base")).toBeNull();
    });

    test("uploads each local file once and swaps in its URL, keeping alt text and remote images", async () => {
        const calls: string[] = [];
        const uploader = async (path: string): Promise<string> => {
            calls.push(path);

            return "/uploads/hash/shot.png";
        };
        const body = `before ![one](${shot}) mid ![two](shot.png) ![remote](https://x.test/r.png)`;
        const result = await rewriteLocalImages(body, dir, uploader);

        expect(result.body).toBe(
            "before ![one](/uploads/hash/shot.png) mid ![two](/uploads/hash/shot.png) ![remote](https://x.test/r.png)"
        );
        expect(calls).toEqual([shot]);
        expect(result.uploaded).toHaveLength(1);
    });

    test("a missing file, a non-image, a folder or an oversized image uploads nothing", async () => {
        const secret = join(dir, "notes.txt");
        writeFileSync(secret, "secret");
        mkdirSync(join(dir, "folder.png"));

        await expect(rewriteLocalImages(`![a](${shot}) ![b](/nope/missing.png)`, dir, never)).rejects.toThrow(
            "image file not found: /nope/missing.png"
        );
        await expect(rewriteLocalImages(`![a](${secret})`, dir, never)).rejects.toThrow("is not an image");
        await expect(rewriteLocalImages("![a](folder.png)", dir, never)).rejects.toThrow("is not a file");
        await expect(rewriteLocalImages(`![a](${shot})`, dir, never, 2)).rejects.toThrow("over the 2 byte limit");
    });

    test("an image inside a code block or an inline code span is neither uploaded nor rewritten", async () => {
        const calls: string[] = [];
        const uploader = async (path: string): Promise<string> => {
            calls.push(path);
            return "/uploads/hash/shot.png";
        };
        const body = [
            "real ![one](shot.png) and `![inline](shot.png)` stay apart",
            "```md",
            "![fenced](/tmp/private.png)",
            "```",
            "~~~",
            "![tilde](/tmp/private.png)",
            "~~~",
            "after ![two](shot.png)",
        ].join("\n");
        const result = await rewriteLocalImages(body, dir, uploader);

        expect(result.body).toBe(
            body
                .replace("real ![one](shot.png)", "real ![one](/uploads/hash/shot.png)")
                .replace("after ![two](shot.png)", "after ![two](/uploads/hash/shot.png)")
        );
        expect(calls).toEqual([shot]);
    });

    test("returns the body unchanged when it has no local images", async () => {
        const result = await rewriteLocalImages("plain text ![r](https://x.test/r.png)", dir, never);

        expect(result.body).toBe("plain text ![r](https://x.test/r.png)");
        expect(result.uploaded).toEqual([]);
    });

    test("an upload is one multipart POST, sent once even on a 502", async () => {
        const seen: Array<{ method: string; path: string; type: string | null }> = [];
        let fail = false;
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                seen.push({
                    method: request.method,
                    path: new URL(request.url).pathname,
                    type: request.headers.get("content-type"),
                });

                return fail
                    ? new Response("bad gateway", { status: 502 })
                    : Response.json({ url: "/uploads/h/shot.png" });
            },
        });

        try {
            const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };

            expect(await uploadToProject(api, shot)).toBe("/uploads/h/shot.png");
            expect(seen[0]?.path).toBe("/api/v4/projects/group%2Fapp/uploads");
            expect(seen[0]?.type).toContain("multipart/form-data");

            fail = true;
            await expect(uploadToProject(api, shot)).rejects.toThrow();
            expect(seen).toHaveLength(2);
        } finally {
            server.stop(true);
        }
    });

    test("an upload to a plain http host that is not loopback is refused", async () => {
        const api = { host: "http://gitlab.example.com", token: "t", project: "group/app" };

        await expect(uploadToProject(api, shot)).rejects.toThrow("Refusing to send a GitLab token");
    });
});
