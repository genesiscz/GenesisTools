import { describe, expect, test } from "bun:test";
import {
    buildSquashMessage,
    collectPages,
    collectPullCommits,
    commitSubjectOf,
    defaultSquashBody,
    defaultSquashTitle,
    describeSquashMessage,
    type PullCommitSubject,
} from "./squash-message";

/** A page fetcher over a fixed list, with an optional hard cap like GitHub's 250 on pulls/{n}/commits. */
function pagedSource(
    total: number,
    cap = Number.POSITIVE_INFINITY
): {
    fetch: (page: number, perPage: number) => Promise<PullCommitSubject[]>;
    pages: number[];
} {
    const pages: number[] = [];
    const all = Array.from({ length: total }, (_, i) => ({ sha: `sha${i}`, subject: `c${i}` }));
    const visible = all.slice(0, Math.min(total, cap));

    return {
        pages,
        async fetch(page, perPage) {
            pages.push(page);
            return visible.slice((page - 1) * perPage, page * perPage);
        },
    };
}

describe("defaultSquashTitle", () => {
    test("appends (#N) once", () => {
        expect(defaultSquashTitle("feat: thing", 12)).toBe("feat: thing (#12)");
        expect(defaultSquashTitle("feat: thing (#12)", 12)).toBe("feat: thing (#12)");
        expect(defaultSquashTitle("  feat: thing  ", 12)).toBe("feat: thing (#12)");
    });

    test("a different PR number in the title is not treated as the suffix", () => {
        expect(defaultSquashTitle("revert: undo (#11)", 12)).toBe("revert: undo (#11) (#12)");
    });
});

describe("commitSubjectOf", () => {
    test("takes the first line only, trimmed, for LF and CRLF bodies", () => {
        expect(commitSubjectOf("fix: one\n\nlong body\nmore")).toBe("fix: one");
        expect(commitSubjectOf("fix: crlf\r\nbody")).toBe("fix: crlf");
        expect(commitSubjectOf("  padded  ")).toBe("padded");
    });

    test("an empty message still yields a subject", () => {
        expect(commitSubjectOf("")).toBe("(no subject)");
        expect(commitSubjectOf("\n\nbody only")).toBe("(no subject)");
    });
});

describe("defaultSquashBody", () => {
    test("one bullet per commit, original order, single newlines, no blank lines", () => {
        const body = defaultSquashBody([
            { sha: "1", subject: "first" },
            { sha: "2", subject: 'second "quoted" `ticked` $VAR' },
            { sha: "3", subject: "third" },
        ]);
        expect(body).toBe('* first\n* second "quoted" `ticked` $VAR\n* third');
        expect(body).not.toContain("\n\n");
    });

    test("no commits gives an empty body", () => {
        expect(defaultSquashBody([])).toBe("");
    });
});

describe("buildSquashMessage", () => {
    const commits = [
        { sha: "1", subject: "a" },
        { sha: "2", subject: "b" },
    ];

    test("generates both parts when nothing is given", () => {
        expect(buildSquashMessage({ number: 3, title: "t", commits })).toEqual({
            title: "t (#3)",
            body: "* a\n* b",
            titleGenerated: true,
            bodyGenerated: true,
            commitCount: 2,
        });
    });

    test("an explicit subject or body wins, independently", () => {
        const onlyTitle = buildSquashMessage({ number: 3, title: "t", commits, commitTitle: "custom" });
        expect(onlyTitle.title).toBe("custom");
        expect(onlyTitle.titleGenerated).toBe(false);
        expect(onlyTitle.body).toBe("* a\n* b");
        expect(onlyTitle.bodyGenerated).toBe(true);

        const onlyBody = buildSquashMessage({ number: 3, title: "t", commits, commitMessage: "mine" });
        expect(onlyBody.title).toBe("t (#3)");
        expect(onlyBody.body).toBe("mine");
        expect(onlyBody.bodyGenerated).toBe(false);
    });

    test("an empty --subject falls back to the generated title, an empty --body is kept", () => {
        const built = buildSquashMessage({ number: 3, title: "t", commits, commitTitle: "", commitMessage: "" });
        expect(built.title).toBe("t (#3)");
        expect(built.titleGenerated).toBe(true);
        expect(built.body).toBe("");
        expect(built.bodyGenerated).toBe(false);
    });
});

describe("describeSquashMessage", () => {
    test("names the source of each part and prints every body line", () => {
        const lines = describeSquashMessage(buildSquashMessage({ number: 9, title: "t", commits: [] }));
        expect(lines[0]).toBe(
            "Squash commit message (subject generated from the PR title; body generated from 0 commit subject(s)):"
        );
        expect(lines[1]).toBe("  t (#9)");
        expect(lines[2]).toBe("  (empty body)");

        const explicit = describeSquashMessage(
            buildSquashMessage({ number: 9, title: "t", commits: [], commitTitle: "s", commitMessage: "l1\nl2" })
        );
        expect(explicit).toEqual([
            "Squash commit message (subject from --subject; body from --body):",
            "  s",
            "  l1",
            "  l2",
        ]);
    });
});

describe("collectPages", () => {
    test("keeps requesting pages until one comes back short", async () => {
        const requested: number[] = [];
        const items = await collectPages(async (page, perPage) => {
            requested.push(page);
            const count = page < 3 ? perPage : 3;
            return Array.from({ length: count }, (_, i) => `p${page}-${i}`);
        }, 100);

        expect(requested).toEqual([1, 2, 3]);
        expect(items).toHaveLength(203);
        expect(items[0]).toBe("p1-0");
        expect(items[202]).toBe("p3-2");
    });

    test("an exactly full last page costs one extra empty request, never a truncation", async () => {
        const requested: number[] = [];
        const items = await collectPages(async (page, perPage) => {
            requested.push(page);
            return page === 1 ? Array.from({ length: perPage }, (_, i) => i) : [];
        }, 2);

        expect(requested).toEqual([1, 2]);
        expect(items).toEqual([0, 1]);
    });
});

describe("collectPullCommits", () => {
    test("a PR under the cap comes straight from the PR commits endpoint", async () => {
        const list = pagedSource(120);
        const compare = pagedSource(120);
        const logs: string[] = [];

        const commits = await collectPullCommits({
            expectedCount: 120,
            listPullCommitsPage: list.fetch,
            compareCommitsPage: compare.fetch,
            log: (m) => logs.push(m),
        });

        expect(commits).toHaveLength(120);
        expect(list.pages).toEqual([1, 2]);
        expect(compare.pages).toEqual([]);
        expect(logs).toEqual([]);
    });

    test("a 300-commit PR is walked through the compare endpoint once the 250 cap shows", async () => {
        const list = pagedSource(300, 250);
        const compare = pagedSource(300);
        const logs: string[] = [];

        const commits = await collectPullCommits({
            expectedCount: 300,
            listPullCommitsPage: list.fetch,
            compareCommitsPage: compare.fetch,
            log: (m) => logs.push(m),
        });

        expect(list.pages).toEqual([1, 2, 3]);
        // 300 is three exactly full pages, so the walk needs a fourth, empty page to know it is done.
        expect(compare.pages).toEqual([1, 2, 3, 4]);
        expect(commits).toHaveLength(300);
        expect(commits[0].subject).toBe("c0");
        expect(commits[299].subject).toBe("c299");
        expect(logs[0]).toContain("returned 250 of 300 commits");
    });

    test("a count that still does not match throws instead of producing a short body", async () => {
        const list = pagedSource(300, 250);
        const compare = pagedSource(280);

        await expect(
            collectPullCommits({
                expectedCount: 300,
                listPullCommitsPage: list.fetch,
                compareCommitsPage: compare.fetch,
            })
        ).rejects.toThrow(/PR reports 300, compare returned 280.*--body/);
    });
});
