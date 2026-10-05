import { describe, expect, it } from "bun:test";
import {
    collectReleases,
    demoteHeadings,
    parseRepoRef,
    type RawRelease,
    RELEASES_PER_PAGE,
    type ReleaseNote,
    renderReleasesMarkdown,
    toReleaseNote,
} from "./releases";

function release(tag: string, publishedAt: string | null, extra: Partial<RawRelease> = {}): RawRelease {
    return {
        tag_name: tag,
        name: `Release ${tag}`,
        draft: false,
        prerelease: false,
        created_at: "2020-01-01T00:00:00Z",
        published_at: publishedAt,
        html_url: `https://github.com/acme/widgets/releases/tag/${tag}`,
        body: `Notes for ${tag}`,
        ...extra,
    };
}

function pagesOf(...pages: RawRelease[][]): { listPage: (page: number) => Promise<RawRelease[]>; asked: number[] } {
    const asked: number[] = [];

    return {
        asked,
        listPage: async (page) => {
            asked.push(page);
            return pages[page - 1] ?? [];
        },
    };
}

function fullPage(prefix: string, startDay: number): RawRelease[] {
    return Array.from({ length: RELEASES_PER_PAGE }, (_, i) =>
        release(`${prefix}${i}`, new Date(Date.UTC(2026, 0, startDay) - i * 60_000).toISOString())
    );
}

describe("parseRepoRef", () => {
    it("reads owner/repo and the github.com URL shapes", () => {
        const expected = { owner: "acme", repo: "widgets" };

        expect(parseRepoRef("acme/widgets")).toEqual(expected);
        expect(parseRepoRef("  acme/widgets  ")).toEqual(expected);
        expect(parseRepoRef("https://github.com/acme/widgets")).toEqual(expected);
        expect(parseRepoRef("https://github.com/acme/widgets.git")).toEqual(expected);
        expect(parseRepoRef("https://github.com/acme/widgets/releases/tag/v1")).toEqual(expected);
        expect(parseRepoRef("git@github.com:acme/widgets.git")).toEqual(expected);
    });

    it("keeps a dot in the repository name", () => {
        expect(parseRepoRef("https://github.com/acme/next.js")).toEqual({ owner: "acme", repo: "next.js" });
    });

    it("rejects anything that is not a repository", () => {
        expect(parseRepoRef("widgets")).toBeNull();
        expect(parseRepoRef("a/b/c")).toBeNull();
        expect(parseRepoRef("https://gitlab.com/acme/widgets")).toBeNull();
        expect(parseRepoRef("acme/wid gets")).toBeNull();
        expect(parseRepoRef("")).toBeNull();
    });
});

describe("toReleaseNote", () => {
    it("falls back to the creation time, trims and normalises the body, and blanks a missing name", () => {
        const note = toReleaseNote(
            release("v1", null, { name: "  ", body: "\r\n line one\r\nline two \r\n", prerelease: true })
        );

        expect(note).toEqual({
            tag: "v1",
            name: null,
            publishedAt: "2020-01-01T00:00:00Z",
            prerelease: true,
            url: "https://github.com/acme/widgets/releases/tag/v1",
            body: "line one\nline two",
        });
    });

    it("turns a null body into an empty one", () => {
        expect(toReleaseNote(release("v1", "2026-01-01T00:00:00Z", { body: null })).body).toBe("");
    });
});

describe("collectReleases", () => {
    it("returns the releases newest first even when the listing is not in date order", async () => {
        const { listPage } = pagesOf([
            release("v2", "2026-02-01T00:00:00Z"),
            release("v3", "2026-03-01T00:00:00Z"),
            release("v1", "2026-01-01T00:00:00Z"),
        ]);

        const notes = await collectReleases({ listPage, prereleases: true });

        expect(notes.map((n) => n.tag)).toEqual(["v3", "v2", "v1"]);
    });

    it("skips drafts always and pre-releases only when asked", async () => {
        const page = [
            release("v3", "2026-03-01T00:00:00Z"),
            release("v3-draft", null, { draft: true }),
            release("v3-rc", "2026-02-20T00:00:00Z", { prerelease: true }),
            release("v2", "2026-02-01T00:00:00Z"),
        ];

        const withPre = await collectReleases({ listPage: pagesOf(page).listPage, prereleases: true });
        const stable = await collectReleases({ listPage: pagesOf(page).listPage, prereleases: false });

        expect(withPre.map((n) => n.tag)).toEqual(["v3", "v3-rc", "v2"]);
        expect(stable.map((n) => n.tag)).toEqual(["v3", "v2"]);
    });

    it("reads every page of a long listing until a short page", async () => {
        const first = fullPage("a", 20);
        const second = fullPage("b", 10);
        const third = [release("tail", "2025-12-01T00:00:00Z")];
        const { listPage, asked } = pagesOf(first, second, third);

        const notes = await collectReleases({ listPage, prereleases: true });

        expect(asked).toEqual([1, 2, 3]);
        expect(notes).toHaveLength(RELEASES_PER_PAGE * 2 + 1);
        expect(notes.at(-1)?.tag).toBe("tail");
    });

    it("stops fetching once the limit is reached and keeps only the newest", async () => {
        const { listPage, asked } = pagesOf(fullPage("a", 20), fullPage("b", 10));

        const notes = await collectReleases({ listPage, limit: 3, prereleases: true });

        expect(asked).toEqual([1]);
        expect(notes.map((n) => n.tag)).toEqual(["a0", "a1", "a2"]);
    });

    it("counts only the kept releases toward the limit", async () => {
        const { listPage } = pagesOf([
            release("v4-rc", "2026-04-01T00:00:00Z", { prerelease: true }),
            release("v3", "2026-03-01T00:00:00Z"),
            release("v3-rc", "2026-02-20T00:00:00Z", { prerelease: true }),
            release("v2", "2026-02-01T00:00:00Z"),
            release("v1", "2026-01-01T00:00:00Z"),
        ]);

        const notes = await collectReleases({ listPage, limit: 2, prereleases: false });

        expect(notes.map((n) => n.tag)).toEqual(["v3", "v2"]);
    });

    it("drops releases older than since, by publish time", async () => {
        const { listPage } = pagesOf([
            release("v3", "2026-03-01T00:00:00Z"),
            release("v2", "2026-02-01T00:00:00Z"),
            release("v1", "2025-12-31T23:59:59Z"),
        ]);

        const notes = await collectReleases({ listPage, since: new Date("2026-01-01T00:00:00Z"), prereleases: true });

        expect(notes.map((n) => n.tag)).toEqual(["v3", "v2"]);
    });

    it("stops at the first page that is entirely older than since", async () => {
        const recent = fullPage("a", 20);
        const old = Array.from({ length: RELEASES_PER_PAGE }, (_, i) => release(`old${i}`, "2024-01-01T00:00:00Z"));
        const { listPage, asked } = pagesOf(recent, old, fullPage("c", 5));

        const notes = await collectReleases({ listPage, since: new Date("2026-01-01T00:00:00Z"), prereleases: true });

        expect(asked).toEqual([1, 2]);
        expect(notes).toHaveLength(RELEASES_PER_PAGE);
    });

    it("lists the oldest first on request, after picking the newest N", async () => {
        const { listPage } = pagesOf([
            release("v3", "2026-03-01T00:00:00Z"),
            release("v2", "2026-02-01T00:00:00Z"),
            release("v1", "2026-01-01T00:00:00Z"),
        ]);

        const notes = await collectReleases({ listPage, limit: 2, prereleases: true, oldestFirst: true });

        expect(notes.map((n) => n.tag)).toEqual(["v2", "v3"]);
    });

    it("returns nothing for a repository without releases", async () => {
        expect(await collectReleases({ listPage: pagesOf().listPage, prereleases: true })).toEqual([]);
    });
});

describe("demoteHeadings", () => {
    it("pushes headings down two levels and stops at six", () => {
        const body = ["# One", "## Two", "### Three", "###### Six", "plain", "#hashtag", "  ## Indented"].join("\n");

        expect(demoteHeadings(body)).toBe(
            ["### One", "#### Two", "##### Three", "###### Six", "plain", "#hashtag", "  #### Indented"].join("\n")
        );
    });

    it("leaves a heading-looking line inside a fenced code block alone", () => {
        const body = [
            "## Real",
            "```bash",
            "# a comment",
            "## still code",
            "```",
            "## After",
            "~~~",
            "# tilde",
            "~~~",
        ].join("\n");

        expect(demoteHeadings(body)).toBe(
            ["#### Real", "```bash", "# a comment", "## still code", "```", "#### After", "~~~", "# tilde", "~~~"].join(
                "\n"
            )
        );
    });

    it("keeps a shorter fence from closing a longer one", () => {
        const body = ["````md", "```", "# inside", "````", "# outside"].join("\n");

        expect(demoteHeadings(body)).toBe(["````md", "```", "# inside", "````", "### outside"].join("\n"));
    });
});

describe("renderReleasesMarkdown", () => {
    const generatedAt = new Date("2026-10-05T10:00:00Z");
    const notes: ReleaseNote[] = [
        {
            tag: "v2.0.0",
            name: "Widgets 2",
            publishedAt: "2026-09-10T12:00:00Z",
            prerelease: false,
            url: "https://github.com/acme/widgets/releases/tag/v2.0.0",
            body: "## What changed\n\n- faster",
        },
        {
            tag: "v1.9.0-rc.1",
            name: "v1.9.0-rc.1",
            publishedAt: "2026-08-01T08:00:00Z",
            prerelease: true,
            url: "https://github.com/acme/widgets/releases/tag/v1.9.0-rc.1",
            body: "",
        },
    ];

    it("writes one document: a title, then a heading, the body and the URL for each release in order", () => {
        const markdown = renderReleasesMarkdown({ owner: "acme", repo: "widgets", releases: notes, generatedAt });

        expect(markdown).toBe(
            [
                "# Releases: acme/widgets",
                "",
                "2 releases from <https://github.com/acme/widgets/releases>. Generated on 2026-10-05 (UTC).",
                "",
                "---",
                "",
                "## v2.0.0 - Widgets 2 (2026-09-10)",
                "",
                "#### What changed",
                "",
                "- faster",
                "",
                "Release page: <https://github.com/acme/widgets/releases/tag/v2.0.0>",
                "",
                "---",
                "",
                "## v1.9.0-rc.1 (2026-08-01)",
                "",
                "Pre-release.",
                "",
                "_No release notes._",
                "",
                "Release page: <https://github.com/acme/widgets/releases/tag/v1.9.0-rc.1>",
                "",
            ].join("\n")
        );
    });

    it("has exactly one level-one heading, so the document nests cleanly", () => {
        const markdown = renderReleasesMarkdown({
            owner: "acme",
            repo: "widgets",
            releases: [{ ...notes[0], body: "# Big title\n\ntext" }],
            generatedAt,
        });

        expect(markdown.split("\n").filter((line) => /^# /.test(line))).toEqual(["# Releases: acme/widgets"]);
    });

    it("says so when there are no releases", () => {
        const markdown = renderReleasesMarkdown({ owner: "acme", repo: "widgets", releases: [], generatedAt });

        expect(markdown).toContain("0 releases from");
        expect(markdown).toContain("No releases found.");
        expect(markdown).not.toContain("## ");
    });

    it("uses the singular for one release", () => {
        const markdown = renderReleasesMarkdown({
            owner: "acme",
            repo: "widgets",
            releases: [notes[0]],
            generatedAt,
        });

        expect(markdown).toContain("1 release from");
    });
});
