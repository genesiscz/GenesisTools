import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api } from "@app/azure-devops/api";
import type { GitCommitRefApi, WikiPageApi, WikiV2 } from "@app/azure-devops/api.types";
import {
    defaultAttachmentDir,
    diffWikiPage,
    downloadWikiAttachments,
    extractAttachmentRefs,
    fillPageIds,
    findCommit,
    flattenPageTree,
    gitPathToPagePath,
    loadWikiPageDetails,
    localAttachmentNames,
    parseWikiPageRef,
    pickWiki,
    recursionLevelForDepth,
    renderWikiPageMarkdown,
    resolveWikiPage,
    rewriteAttachmentLinks,
    stripHighlightTags,
    toPageChange,
    toSearchRows,
    type WikiTreeRow,
} from "@app/azure-devops/lib/wiki";
import type { AzureConfig } from "@app/azure-devops/types";
import { logger } from "@genesiscz/utils/logger";

const config: AzureConfig = {
    org: "https://dev.azure.com/contoso",
    project: "Widgets",
    projectId: "p-1",
    apiResource: "499b84ac-1321-427f-aa17-267ca6975798",
};

function wiki(overrides: Partial<WikiV2>): WikiV2 {
    return {
        id: "w-1",
        name: "Widgets.wiki",
        type: "projectWiki",
        projectId: "p-1",
        repositoryId: "r-1",
        mappedPath: "/",
        url: "",
        ...overrides,
    };
}

/** A real Api whose network-facing methods fail loudly unless the test gives them an answer. */
function stubApi() {
    const api = new Api(config);
    const unexpected = (method: string) => async (): Promise<never> => {
        throw new Error(`unexpected Api.${method} call`);
    };

    return {
        api,
        getWikis: spyOn(api, "getWikis").mockImplementation(unexpected("getWikis")),
        getWikiPage: spyOn(api, "getWikiPage").mockImplementation(unexpected("getWikiPage")),
        getWikiPageViews: spyOn(api, "getWikiPageViews").mockImplementation(unexpected("getWikiPageViews")),
        getGitCommitsForPath: spyOn(api, "getGitCommitsForPath").mockImplementation(unexpected("getGitCommitsForPath")),
        fetchBinary: spyOn(api, "fetchBinary").mockImplementation(unexpected("fetchBinary")),
    };
}

function bytes(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
}

function treeRow(path: string, id?: number): WikiTreeRow {
    return { id, path, name: path.split("/").at(-1) ?? "/", depth: 1, hasChildren: false };
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ado-wiki-"));
    tempDirs.push(dir);

    return dir;
}

afterEach(async () => {
    mock.restore();

    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

describe("parseWikiPageRef", () => {
    test("reads a bare page id", () => {
        expect(parseWikiPageRef("57274")).toEqual({ pageId: 57274 });
    });

    test("reads a page path and adds the leading slash", () => {
        expect(parseWikiPageRef("Projects/Feature")).toEqual({ pagePath: "/Projects/Feature" });
        expect(parseWikiPageRef("/Projects/Feature")).toEqual({ pagePath: "/Projects/Feature" });
    });

    test("reads wiki and id from a /_wiki/wikis/<wiki>/<id>/<slug> URL and decodes the wiki", () => {
        expect(
            parseWikiPageRef("https://contoso.visualstudio.com/My%20Proj/_wiki/wikis/My-Proj%C3%A9.wiki/1234/Some-Page")
        ).toEqual({ wiki: "My-Projé.wiki", pageId: 1234 });
    });

    test("reads pagePath and pageId from the query string", () => {
        expect(
            parseWikiPageRef(
                "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki?pagePath=%2FA%2FB&pageId=12"
            )
        ).toEqual({ wiki: "Widgets.wiki", pageId: 12, pagePath: "/A/B" });
    });

    test("refuses a wiki URL that names no page, and a URL that is not a wiki", () => {
        expect(() => parseWikiPageRef("https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki")).toThrow(
            "no page"
        );
        expect(() => parseWikiPageRef("https://dev.azure.com/contoso/Widgets/_workitems/edit/1")).toThrow(
            "Not a wiki URL"
        );
    });
});

describe("pickWiki", () => {
    const projectWiki = wiki({});
    const codeWiki = wiki({ id: "w-2", name: "Team-Docs", type: "codeWiki", mappedPath: "/docs" });

    test("matches the name without .wiki and with spaces for dashes, and the id", () => {
        expect(pickWiki([projectWiki, codeWiki], "widgets")).toBe(projectWiki);
        expect(pickWiki([projectWiki, codeWiki], "team docs")).toBe(codeWiki);
        expect(pickWiki([projectWiki, codeWiki], "w-2")).toBe(codeWiki);
    });

    test("defaults to the project wiki", () => {
        expect(pickWiki([codeWiki, projectWiki])).toBe(projectWiki);
    });

    test("falls back to the only wiki there is when it is not a project wiki", () => {
        expect(pickWiki([codeWiki])).toBe(codeWiki);
    });

    test("says there are no wikis when the project has none", () => {
        expect(() => pickWiki([], "Widgets")).toThrow("Available: none");
        expect(() => pickWiki([])).toThrow("Available: none");
    });

    test("names the available wikis when nothing matches or the default is ambiguous", () => {
        expect(() => pickWiki([projectWiki, codeWiki], "nope")).toThrow("Available: Widgets.wiki, Team-Docs");
        expect(() => pickWiki([codeWiki, wiki({ id: "w-3", name: "Other", type: "codeWiki" })])).toThrow("pass --wiki");
    });
});

describe("gitPathToPagePath", () => {
    test("turns dashes back into spaces before decoding, so an escaped dash stays a dash", () => {
        expect(gitPathToPagePath("/Widgets/Projects,-change-requests/100-%7C-Feature-%2D-off.md")).toBe(
            "/Widgets/Projects, change requests/100 | Feature - off"
        );
    });

    test("strips the mapped folder of a code wiki", () => {
        expect(gitPathToPagePath("/docs/Setup/Getting-started.md", "/docs")).toBe("/Setup/Getting started");
    });

    test("keeps a segment with a malformed percent escape as it is instead of throwing", () => {
        expect(gitPathToPagePath("/Notes/100%-off.md")).toBe("/Notes/100% off");
    });
});

describe("attachments", () => {
    const markdown = [
        "![shot](/.attachments/image-1.png =600x)",
        '<img src="/.attachments/diagram%20v2.png" />',
        "again ![shot](/.attachments/image-1.png)",
    ].join("\n");

    test("finds each attachment once, without the size suffix, with the name decoded", () => {
        expect(extractAttachmentRefs(markdown)).toEqual([
            { original: "/.attachments/image-1.png", name: "image-1.png" },
            { original: "/.attachments/diagram%20v2.png", name: "diagram v2.png" },
        ]);
    });

    test("points every occurrence at the local copy", () => {
        const rewritten = rewriteAttachmentLinks(
            markdown,
            new Map([["/.attachments/image-1.png", "/tmp/wiki files/image-1.png"]])
        );

        expect(rewritten).not.toContain("/.attachments/image-1.png");
        expect(rewritten.split("/tmp/wiki%20files/image-1.png")).toHaveLength(3);
    });

    test("gives attachments that flatten to the same name distinct local files", () => {
        const names = localAttachmentNames([
            { original: "/.attachments/a/b.png", name: "a/b.png" },
            { original: "/.attachments/a_b.png", name: "a_b.png" },
            { original: "/.attachments/A_B.png", name: "A_B.png" },
            { original: "/.attachments/notes", name: "notes" },
        ]);

        expect([...names.values()]).toEqual(["a_b.png", "a_b-2.png", "A_B-3.png", "notes"]);
    });

    test("a link whose path extends another is rewritten on its own, not by the shorter one", () => {
        const rewritten = rewriteAttachmentLinks(
            "![a](/.attachments/shot.png) ![b](/.attachments/shot.png.orig)",
            new Map([
                ["/.attachments/shot.png", "/tmp/w/shot.png"],
                ["/.attachments/shot.png.orig", "/tmp/w/shot-orig.png"],
            ])
        );

        expect(rewritten).toBe("![a](/tmp/w/shot.png) ![b](/tmp/w/shot-orig.png)");
    });
});

describe("page tree", () => {
    const root: WikiPageApi = {
        id: 1,
        path: "/A",
        subPages: [
            { path: "/A/B", subPages: [{ path: "/A/B/C" }] },
            { path: "/A/D", isParentPage: true },
        ],
    };

    test("cuts the tree below the requested depth and keeps the has-children marker", () => {
        expect(flattenPageTree(root, 1).map((row) => [row.name, row.depth, row.hasChildren])).toEqual([
            ["A", 0, true],
            ["B", 1, true],
            ["D", 1, true],
        ]);
        expect(flattenPageTree(root, "all")).toHaveLength(4);
    });

    test("asks the API only for the depth it needs", () => {
        expect([0, 1, 2, "all" as const].map(recursionLevelForDepth)).toEqual(["none", "oneLevel", "full", "full"]);
    });
});

describe("findCommit", () => {
    const commits: GitCommitRefApi[] = [{ commitId: "FD625F6E00" }, { commitId: "08bab81300" }];

    test("matches an abbreviated id regardless of case", () => {
        expect(findCommit(commits, "fd625f")?.commitId).toBe("FD625F6E00");
        expect(findCommit(commits, "08BAB813")?.commitId).toBe("08bab81300");
        expect(findCommit(commits, "ffff")).toBeUndefined();
    });

    test("refuses a prefix that matches more than one commit", () => {
        const close: GitCommitRefApi[] = [{ commitId: "abc1230000" }, { commitId: "abc4560000" }];

        expect(() => findCommit(close, "abc")).toThrow("ambiguous: abc1230000, abc4560000");
        expect(findCommit(close, "abc4")?.commitId).toBe("abc4560000");
    });
});

describe("renderWikiPageMarkdown", () => {
    test("escapes pipes in the details table and appends the content", () => {
        const markdown = renderWikiPageMarkdown({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            id: 7,
            path: "/Projects/100 | Feature",
            title: "100 | Feature",
            subPages: [],
            attachments: [{ name: "image-1.png", localPath: "/tmp/image-1.png" }],
            content: "Body text\n",
        });

        expect(markdown).toContain("| Path | `/Projects/100 \\| Feature` |");
        expect(markdown).toContain("- image-1.png → /tmp/image-1.png");
        expect(markdown.trimEnd().endsWith("Body text")).toBe(true);
    });

    test("lists url, git path, last change, views, subpages and attachments when the page has them", () => {
        const markdown = renderWikiPageMarkdown({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            id: 7,
            path: "/Projects/Feature",
            title: "Feature",
            url: "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki/7",
            gitItemPath: "/Projects/Feature.md",
            lastChange: {
                commitId: "fd625f6e00aa",
                date: "2026-02-03T10:00:00Z",
                author: "Alice Example",
                message: "Reword intro",
            },
            views: { days: 30, count: 12 },
            subPages: [{ id: 8, path: "/Projects/Feature/Sub" }, { path: "/Projects/Feature/Draft" }],
            attachments: [{ name: "a.png" }, { name: "b.png", localPath: "/tmp/b.png" }],
            content: "Body\n\n",
        });

        expect(markdown).toBe(
            [
                "# Feature",
                "",
                "| Field | Value |",
                "|---|---|",
                "| Wiki | Widgets.wiki |",
                "| Page id | 7 |",
                "| Path | `/Projects/Feature` |",
                "| URL | https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki/7 |",
                "| Git path | `/Projects/Feature.md` |",
                "| Last change | 2026-02-03T10:00:00Z · Alice Example · Reword intro (`fd625f6e`) |",
                "| Views (30 d) | 12 |",
                "| Subpages | 2 |",
                "| Attachments | 2 |",
                "",
                "## Subpages",
                "",
                "- `8` /Projects/Feature/Sub",
                "- /Projects/Feature/Draft",
                "",
                "## Attachments",
                "",
                "- a.png",
                "- b.png → /tmp/b.png",
                "",
                "---",
                "",
                "Body",
                "",
            ].join("\n")
        );
    });

    test("marks a missing page id and unknown change details, and keeps a pipe in the message inside its cell", () => {
        const markdown = renderWikiPageMarkdown({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            path: "/A",
            title: "A",
            lastChange: { commitId: "abcdef1234567" },
            subPages: [],
            attachments: [],
        });
        const piped = renderWikiPageMarkdown({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            path: "/A",
            title: "A",
            lastChange: { commitId: "abcdef1234567", message: "a | b" },
            subPages: [],
            attachments: [],
        });

        expect(markdown).toContain("| Page id | — |");
        expect(markdown).toContain("| Last change | ? · ? ·  (`abcdef12`) |");
        expect(piped).toContain("| Last change | ? · ? · a \\| b (`abcdef12`) |");
    });

    test("leaves the content out when it was not asked for", () => {
        const markdown = renderWikiPageMarkdown({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            path: "/A",
            title: "A",
            subPages: [],
            attachments: [],
        });

        expect(markdown).not.toContain("\n---\n");
    });
});

describe("toSearchRows", () => {
    test("derives the page path and a web URL from the git path of each hit", () => {
        const rows = toSearchRows(config, {
            count: 1,
            results: [
                {
                    fileName: "100-%7C-Feature.md",
                    path: "/Projects/100-%7C-Feature.md",
                    wiki: { id: "w-1", name: "Widgets.wiki", mappedPath: "/" },
                    hits: [{ fieldReferenceName: "content", highlights: ["the <highlighthit>Feature</highlighthit>"] }],
                },
            ],
        });

        expect(rows[0].pagePath).toBe("/Projects/100 | Feature");
        expect(rows[0].url).toBe(
            "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki?pagePath=%2FProjects%2F100%20%7C%20Feature"
        );
        expect(rows[0].highlights).toEqual(["the <highlighthit>Feature</highlighthit>"]);
    });
});

describe("stripHighlightTags", () => {
    test("removes the search hit markers and leaves the text between them", () => {
        expect(stripHighlightTags("the <highlighthit>Feature</highlighthit> page")).toBe("the Feature page");
    });
});

describe("toPageChange", () => {
    test("reads the author, date and first line of the commit message", () => {
        expect(
            toPageChange({
                commitId: "fd625f6e00",
                author: { name: "Alice Example", date: "2026-02-03T10:00:00Z" },
                committer: { name: "Bob Example", date: "2026-02-04T10:00:00Z" },
                comment: "Reword intro\n\nA longer explanation",
            })
        ).toEqual({
            commitId: "fd625f6e00",
            date: "2026-02-03T10:00:00Z",
            author: "Alice Example",
            message: "Reword intro",
        });
    });

    test("falls back to the committer, and leaves out what the commit does not carry", () => {
        expect(
            toPageChange({ commitId: "a1", committer: { name: "Bob Example", date: "2026-02-04T10:00:00Z" } })
        ).toEqual({
            commitId: "a1",
            date: "2026-02-04T10:00:00Z",
            author: "Bob Example",
            message: undefined,
        });
        expect(toPageChange({ commitId: "a2" })).toEqual({
            commitId: "a2",
            date: undefined,
            author: undefined,
            message: undefined,
        });
    });
});

describe("fillPageIds", () => {
    test("asks for the id of the rows that lack one and keeps the order of the rows", async () => {
        const stubs = stubApi();
        stubs.getWikiPage.mockImplementation(async ({ path }) => ({
            id: path === "/A/B" ? 22 : 33,
            path: path ?? "/",
        }));

        const filled = await fillPageIds({
            api: stubs.api,
            wiki: wiki({}),
            rows: [treeRow("/A", 1), treeRow("/A/B"), treeRow("/A/C")],
        });

        expect(filled.map((row) => [row.path, row.id])).toEqual([
            ["/A", 1],
            ["/A/B", 22],
            ["/A/C", 33],
        ]);
        expect(stubs.getWikiPage.mock.calls.map(([args]) => args)).toEqual([
            { wikiId: "w-1", path: "/A/B", recursionLevel: "none" },
            { wikiId: "w-1", path: "/A/C", recursionLevel: "none" },
        ]);
    });

    test("leaves the id empty for a row whose lookup fails, logs it and still fills the others", async () => {
        const stubs = stubApi();
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        stubs.getWikiPage.mockImplementation(async ({ path }) => {
            if (path === "/A/B") {
                throw new Error("HTTP 404");
            }

            return { id: 33, path: path ?? "/" };
        });

        const filled = await fillPageIds({
            api: stubs.api,
            wiki: wiki({}),
            rows: [treeRow("/A/B"), treeRow("/A/C")],
        });

        expect(filled.map((row) => row.id)).toEqual([undefined, 33]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("no id for /A/B");
    });

    test("makes no request when every row already has an id", async () => {
        const stubs = stubApi();
        const rows = [treeRow("/A", 1), treeRow("/A/B", 2)];

        expect(await fillPageIds({ api: stubs.api, wiki: wiki({}), rows })).toEqual(rows);
        expect(stubs.getWikiPage).not.toHaveBeenCalled();
    });
});

describe("resolveWikiPage", () => {
    const projectWiki = wiki({});
    const codeWiki = wiki({ id: "w-2", name: "Team-Docs", type: "codeWiki", mappedPath: "/docs" });

    test("reads a page by id from a URL and picks the wiki that URL names", async () => {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([projectWiki, codeWiki]);
        stubs.getWikiPage.mockResolvedValue({ id: 1234, path: "/Some Page" });

        const result = await resolveWikiPage({
            api: stubs.api,
            input: "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Team-Docs/1234/Some-Page",
        });

        expect(result.wiki).toBe(codeWiki);
        expect(result.page).toEqual({ id: 1234, path: "/Some Page" });
        expect(stubs.getWikiPage).toHaveBeenCalledWith({
            wikiId: "w-2",
            pageId: 1234,
            path: undefined,
            recursionLevel: "oneLevel",
            includeContent: false,
        });
    });

    test("reads a page by path in the project wiki and passes the recursion level and content flag on", async () => {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([codeWiki, projectWiki]);
        stubs.getWikiPage.mockResolvedValue({ path: "/Projects/Feature" });

        const result = await resolveWikiPage({
            api: stubs.api,
            input: "Projects/Feature",
            recursionLevel: "full",
            includeContent: true,
        });

        expect(result.wiki).toBe(projectWiki);
        expect(stubs.getWikiPage).toHaveBeenCalledWith({
            wikiId: "w-1",
            pageId: undefined,
            path: "/Projects/Feature",
            recursionLevel: "full",
            includeContent: true,
        });
    });

    test("an explicit wiki name wins over the wiki in the URL", async () => {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([projectWiki, codeWiki]);
        stubs.getWikiPage.mockResolvedValue({ id: 1234, path: "/Some Page" });

        const result = await resolveWikiPage({
            api: stubs.api,
            input: "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Team-Docs/1234/Some-Page",
            wikiName: "widgets",
        });

        expect(result.wiki).toBe(projectWiki);
    });

    test("does not ask for the page when no wiki matches", async () => {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([projectWiki]);

        await expect(resolveWikiPage({ api: stubs.api, input: "57274", wikiName: "nope" })).rejects.toThrow(
            "No wiki named 'nope'"
        );
        expect(stubs.getWikiPage).not.toHaveBeenCalled();
    });
});

describe("defaultAttachmentDir", () => {
    test("keeps the attachments of a page by wiki name and page id under the working directory", () => {
        expect(defaultAttachmentDir(wiki({}), { id: 57274, path: "/Projects/Feature" })).toBe(
            join(process.cwd(), ".claude/azure", "wiki", "Widgets-wiki", "57274")
        );
    });

    test("uses the slug of the page title when the page has no id", () => {
        expect(defaultAttachmentDir(wiki({}), { path: "/Projects/100 | Feature" })).toBe(
            join(process.cwd(), ".claude/azure", "wiki", "Widgets-wiki", "100-Feature")
        );
    });
});

describe("downloadWikiAttachments", () => {
    test("saves each attachment from the wiki's git repository and maps the link to the saved file", async () => {
        const stubs = stubApi();
        const outputDir = join(await tempDir(), "files");
        const codeWiki = wiki({ mappedPath: "/docs/", versions: [{ version: "wikiMaster" }] });
        stubs.fetchBinary.mockImplementation(async (url) => bytes(`bytes of ${new URL(url).searchParams.get("path")}`));

        const localPaths = await downloadWikiAttachments({
            api: stubs.api,
            config,
            wiki: codeWiki,
            refs: extractAttachmentRefs("![a](/.attachments/image-1.png) ![b](/.attachments/diagram%20v2.png)"),
            outputDir,
        });

        expect(Object.fromEntries(localPaths)).toEqual({
            "/.attachments/image-1.png": join(outputDir, "image-1.png"),
            "/.attachments/diagram%20v2.png": join(outputDir, "diagram v2.png"),
        });
        expect(await readFile(join(outputDir, "image-1.png"), "utf8")).toBe("bytes of /docs/.attachments/image-1.png");
        expect(await readFile(join(outputDir, "diagram v2.png"), "utf8")).toBe(
            "bytes of /docs/.attachments/diagram v2.png"
        );

        const requested = new URL(stubs.fetchBinary.mock.calls[0][0]);

        expect(requested.pathname).toBe("/contoso/Widgets/_apis/git/repositories/r-1/items");
        expect(requested.searchParams.get("versionDescriptor.version")).toBe("wikiMaster");
    });

    test("reports a download that fails and still saves the other attachments", async () => {
        const stubs = stubApi();
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        const outputDir = await tempDir();
        stubs.fetchBinary.mockImplementation(async (url) => {
            const gitPath = new URL(url).searchParams.get("path") ?? "";

            if (gitPath.endsWith("missing.png")) {
                throw new Error("HTTP 404");
            }

            return bytes(`bytes of ${gitPath}`);
        });

        const localPaths = await downloadWikiAttachments({
            api: stubs.api,
            config,
            wiki: wiki({}),
            refs: extractAttachmentRefs("![a](/.attachments/ok.png) ![b](/.attachments/missing.png)"),
            outputDir,
        });

        expect([...localPaths.keys()]).toEqual(["/.attachments/ok.png"]);
        expect(existsSync(join(outputDir, "missing.png"))).toBe(false);
        expect(await readFile(join(outputDir, "ok.png"), "utf8")).toBe("bytes of /.attachments/ok.png");
        expect(String(warn.mock.calls[0][0])).toContain("could not download missing.png");
        expect(new URL(stubs.fetchBinary.mock.calls[0][0]).searchParams.has("versionDescriptor.version")).toBe(false);
    });

    test("saves attachments whose names flatten to the same file under different names", async () => {
        const stubs = stubApi();
        const outputDir = await tempDir();
        stubs.fetchBinary.mockImplementation(async (url) => bytes(`bytes of ${new URL(url).searchParams.get("path")}`));

        const localPaths = await downloadWikiAttachments({
            api: stubs.api,
            config,
            wiki: wiki({}),
            refs: [
                { original: "/.attachments/a/b.png", name: "a/b.png" },
                { original: "/.attachments/a_b.png", name: "a_b.png" },
            ],
            outputDir,
        });

        expect(localPaths.get("/.attachments/a/b.png")).toBe(join(outputDir, "a_b.png"));
        expect(localPaths.get("/.attachments/a_b.png")).toBe(join(outputDir, "a_b-2.png"));
        expect(await readFile(join(outputDir, "a_b.png"), "utf8")).toBe("bytes of /.attachments/a/b.png");
        expect(await readFile(join(outputDir, "a_b-2.png"), "utf8")).toBe("bytes of /.attachments/a_b.png");
    });

    test("neither requests nor creates anything for a page without attachments", async () => {
        const stubs = stubApi();
        const outputDir = join(await tempDir(), "never-created");

        const localPaths = await downloadWikiAttachments({
            api: stubs.api,
            config,
            wiki: wiki({}),
            refs: [],
            outputDir,
        });

        expect(localPaths.size).toBe(0);
        expect(stubs.fetchBinary).not.toHaveBeenCalled();
        expect(existsSync(outputDir)).toBe(false);
    });
});

describe("loadWikiPageDetails", () => {
    const projectWiki = wiki({ versions: [{ version: "wikiMaster" }] });
    const page: WikiPageApi = {
        id: 7,
        path: "/Projects/Feature",
        gitItemPath: "/Projects/Feature.md",
        remoteUrl: "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki/7/Feature",
        content: "Intro ![shot](/.attachments/shot.png =400x) and ![again](/.attachments/shot.png)\n",
        subPages: [{ id: 8, path: "/Projects/Feature/Sub" }, { path: "/Projects/Feature/Draft" }],
    };
    const commit: GitCommitRefApi = {
        commitId: "fd625f6e00aa",
        author: { name: "Alice Example", date: "2026-02-03T10:00:00Z" },
        comment: "Reword intro\n\nlonger body",
    };

    function stubbedPage(pageApi: WikiPageApi = page) {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([projectWiki]);
        stubs.getWikiPage.mockResolvedValue(pageApi);
        stubs.getGitCommitsForPath.mockResolvedValue([commit]);
        stubs.getWikiPageViews.mockResolvedValue({
            id: 7,
            path: "/Projects/Feature",
            viewStats: [
                { day: "2026-02-01", count: 3 },
                { day: "2026-02-02", count: 4 },
            ],
        });
        stubs.fetchBinary.mockImplementation(async () => bytes("png bytes"));

        return stubs;
    }

    test("collects the page, last change, summed views and subpages, and points the content at the downloads", async () => {
        const stubs = stubbedPage();
        const outputDir = await tempDir();

        const details = await loadWikiPageDetails({
            api: stubs.api,
            config,
            input: "7",
            includeContent: true,
            viewsDays: 30,
            images: { outputDir },
        });

        const localPath = join(outputDir, "shot.png");

        expect(details).toEqual({
            wiki: { id: "w-1", name: "Widgets.wiki" },
            id: 7,
            path: "/Projects/Feature",
            title: "Feature",
            url: "https://dev.azure.com/contoso/Widgets/_wiki/wikis/Widgets.wiki/7/Feature",
            gitItemPath: "/Projects/Feature.md",
            lastChange: {
                commitId: "fd625f6e00aa",
                date: "2026-02-03T10:00:00Z",
                author: "Alice Example",
                message: "Reword intro",
            },
            views: { days: 30, count: 7 },
            subPages: [
                { id: 8, path: "/Projects/Feature/Sub" },
                { id: undefined, path: "/Projects/Feature/Draft" },
            ],
            attachments: [{ name: "shot.png", localPath }],
            content: `Intro ![shot](${encodeURI(localPath)} =400x) and ![again](${encodeURI(localPath)})\n`,
        });
        expect(await readFile(localPath, "utf8")).toBe("png bytes");
        expect(stubs.getWikiPage).toHaveBeenCalledWith({
            wikiId: "w-1",
            pageId: 7,
            path: undefined,
            recursionLevel: "oneLevel",
            includeContent: true,
        });
        expect(stubs.getGitCommitsForPath).toHaveBeenCalledWith({
            repositoryId: "r-1",
            itemPath: "/Projects/Feature.md",
            version: "wikiMaster",
            top: 1,
        });
        expect(stubs.getWikiPageViews).toHaveBeenCalledWith({ wikiId: "w-1", pageId: 7, days: 30 });
    });

    test("lists the attachments without downloading them or returning the content when neither was asked for", async () => {
        const stubs = stubbedPage();

        const details = await loadWikiPageDetails({
            api: stubs.api,
            config,
            input: "7",
            includeContent: false,
            viewsDays: 30,
        });

        expect(details.content).toBeUndefined();
        expect(details.attachments).toEqual([{ name: "shot.png", localPath: undefined }]);
        expect(stubs.fetchBinary).not.toHaveBeenCalled();
    });

    test("downloads nothing for a page whose content links no attachment", async () => {
        const stubs = stubbedPage({ ...page, content: "No pictures here\n" });

        const details = await loadWikiPageDetails({
            api: stubs.api,
            config,
            input: "7",
            includeContent: true,
            viewsDays: 0,
            images: {},
        });

        expect(details.attachments).toEqual([]);
        expect(details.content).toBe("No pictures here\n");
        expect(stubs.fetchBinary).not.toHaveBeenCalled();
    });

    test("skips the view count when views are off or the page has no id", async () => {
        const off = stubbedPage();
        const noId = stubbedPage({ ...page, id: undefined });

        const withoutViews = await loadWikiPageDetails({
            api: off.api,
            config,
            input: "7",
            includeContent: false,
            viewsDays: 0,
        });
        const withoutId = await loadWikiPageDetails({
            api: noId.api,
            config,
            input: "/Projects/Feature",
            includeContent: false,
            viewsDays: 30,
        });

        expect(withoutViews.views).toBeUndefined();
        expect(withoutId.views).toBeUndefined();
        expect(off.getWikiPageViews).not.toHaveBeenCalled();
        expect(noId.getWikiPageViews).not.toHaveBeenCalled();
    });

    test("leaves the last change out when the page has no git path or the history is empty", async () => {
        const noGitPath = stubbedPage({ ...page, gitItemPath: undefined });
        const emptyHistory = stubbedPage();
        emptyHistory.getGitCommitsForPath.mockResolvedValue([]);

        const first = await loadWikiPageDetails({
            api: noGitPath.api,
            config,
            input: "7",
            includeContent: false,
            viewsDays: 0,
        });
        const second = await loadWikiPageDetails({
            api: emptyHistory.api,
            config,
            input: "7",
            includeContent: false,
            viewsDays: 0,
        });

        expect(first.lastChange).toBeUndefined();
        expect(noGitPath.getGitCommitsForPath).not.toHaveBeenCalled();
        expect(second.lastChange).toBeUndefined();
        expect(emptyHistory.getGitCommitsForPath).toHaveBeenCalledTimes(1);
    });

    test("still returns the page when the last change and the views cannot be loaded, and logs both", async () => {
        const stubs = stubbedPage();
        const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
        stubs.getGitCommitsForPath.mockRejectedValue(new Error("HTTP 500"));
        stubs.getWikiPageViews.mockRejectedValue(new Error("HTTP 403"));

        const details = await loadWikiPageDetails({
            api: stubs.api,
            config,
            input: "7",
            includeContent: false,
            viewsDays: 30,
        });

        expect(details.path).toBe("/Projects/Feature");
        expect(details.lastChange).toBeUndefined();
        expect(details.views).toBeUndefined();

        const messages = warn.mock.calls.map(([message]) => String(message));

        expect(messages.some((message) => message.includes("last change of /Projects/Feature unavailable"))).toBe(true);
        expect(messages.some((message) => message.includes("views of /Projects/Feature unavailable"))).toBe(true);
    });
});

describe("diffWikiPage", () => {
    const projectWiki = wiki({ versions: [{ version: "wikiMaster" }] });
    const page: WikiPageApi = { id: 7, path: "/Projects/Feature", gitItemPath: "/Projects/Feature.md" };
    const commits: GitCommitRefApi[] = [
        { commitId: "ccc3333333", author: { name: "Alice Example", date: "2026-03-03T10:00:00Z" }, comment: "Third" },
        { commitId: "bbb2222222", author: { name: "Bob Example", date: "2026-03-02T10:00:00Z" }, comment: "Second" },
        { commitId: "aaa1111111", comment: "First" },
    ];
    const versions: Record<string, string> = {
        ccc3333333: "one\nthree\n",
        bbb2222222: "one\ntwo\n",
        aaa1111111: "one\n",
    };

    function stubbedHistory(history: GitCommitRefApi[] = commits, pageApi: WikiPageApi = page) {
        const stubs = stubApi();
        stubs.getWikis.mockResolvedValue([projectWiki]);
        stubs.getWikiPage.mockResolvedValue(pageApi);
        stubs.getGitCommitsForPath.mockResolvedValue(history);
        stubs.fetchBinary.mockImplementation(async (url) =>
            bytes(versions[new URL(url).searchParams.get("versionDescriptor.version") ?? ""] ?? "")
        );

        return stubs;
    }

    test("compares the newest commit with the one before it when no versions are named", async () => {
        const stubs = stubbedHistory();

        const result = await diffWikiPage({ api: stubs.api, config, input: "7" });

        expect(result.wiki).toBe("Widgets.wiki");
        expect(result.path).toBe("/Projects/Feature");
        expect(result.from).toEqual({
            commitId: "bbb2222222",
            date: "2026-03-02T10:00:00Z",
            author: "Bob Example",
            message: "Second",
        });
        expect(result.to.commitId).toBe("ccc3333333");
        expect(result.diff.startsWith("--- a/Feature\n+++ b/Feature\n")).toBe(true);
        expect(result.diff).toContain("@@ -1,2 +1,2 @@\n one\n-two\n+three");
        expect(stubs.getWikiPage).toHaveBeenCalledWith({
            wikiId: "w-1",
            pageId: 7,
            path: undefined,
            recursionLevel: "none",
            includeContent: false,
        });
        expect(stubs.getGitCommitsForPath).toHaveBeenCalledWith({
            repositoryId: "r-1",
            itemPath: "/Projects/Feature.md",
            version: "wikiMaster",
            top: 100,
        });
    });

    test("reads each version of the page file at its own commit", async () => {
        const stubs = stubbedHistory();

        await diffWikiPage({ api: stubs.api, config, input: "7" });

        const requested = stubs.fetchBinary.mock.calls.map(([url]) => new URL(url).searchParams);

        expect(requested.map((params) => params.get("versionDescriptor.version")).sort()).toEqual([
            "bbb2222222",
            "ccc3333333",
        ]);
        expect(requested.every((params) => params.get("versionDescriptor.versionType") === "commit")).toBe(true);
        expect(requested.every((params) => params.get("path") === "/Projects/Feature.md")).toBe(true);
    });

    test("takes both versions from abbreviated commit ids when they are given", async () => {
        const stubs = stubbedHistory();

        const result = await diffWikiPage({ api: stubs.api, config, input: "7", from: "aaa", to: "bbb" });

        expect(result.from.commitId).toBe("aaa1111111");
        expect(result.to.commitId).toBe("bbb2222222");
        expect(result.diff).toContain("@@ -1,1 +1,2 @@\n one\n+two");
    });

    test("starts from the commit before a chosen target version", async () => {
        const stubs = stubbedHistory();

        const result = await diffWikiPage({ api: stubs.api, config, input: "7", to: "bbb2" });

        expect(result.from.commitId).toBe("aaa1111111");
        expect(result.to.commitId).toBe("bbb2222222");
    });

    test("returns an empty diff when both versions hold the same text", async () => {
        const stubs = stubbedHistory([
            { commitId: "ddd4444444" },
            { commitId: "ccc3333333", comment: "Same text, other commit" },
        ]);
        stubs.fetchBinary.mockImplementation(async () => bytes("same\n"));

        const result = await diffWikiPage({ api: stubs.api, config, input: "7" });

        expect(result.diff).toBe("");
    });

    test("passes the context size on to the diff", async () => {
        const stubs = stubbedHistory();
        const lines = (middle: string) => ["l1", "l2", "l3", "l4", middle, "l6", "l7", "l8", "l9", ""].join("\n");
        stubs.fetchBinary.mockImplementation(async (url) =>
            bytes(
                new URL(url).searchParams.get("versionDescriptor.version") === "ccc3333333"
                    ? lines("new")
                    : lines("old")
            )
        );

        const narrow = await diffWikiPage({ api: stubs.api, config, input: "7", context: 1 });
        const wide = await diffWikiPage({ api: stubs.api, config, input: "7" });

        expect(narrow.diff).toContain(" l4\n-old\n+new\n l6");
        expect(narrow.diff).not.toContain(" l3");
        expect(wide.diff).toContain(" l2\n l3\n l4\n-old\n+new\n l6\n l7\n l8");
        expect(wide.diff).not.toContain(" l1");
    });

    test("refuses a page that has no git path", async () => {
        const stubs = stubbedHistory(commits, { id: 7, path: "/Projects/Feature" });

        await expect(diffWikiPage({ api: stubs.api, config, input: "7" })).rejects.toThrow(
            "Page /Projects/Feature has no git path"
        );
        expect(stubs.getGitCommitsForPath).not.toHaveBeenCalled();
    });

    test("names the history window when the requested version is not in it", async () => {
        const stubs = stubbedHistory();

        await expect(diffWikiPage({ api: stubs.api, config, input: "7", to: "zzz" })).rejects.toThrow(
            "No commit 'zzz' in the last 3 versions of /Projects/Feature"
        );
        await expect(diffWikiPage({ api: stubs.api, config, input: "7", from: "yyy" })).rejects.toThrow(
            "No commit 'yyy' in the last 3 versions of /Projects/Feature"
        );
        expect(stubs.fetchBinary).not.toHaveBeenCalled();
    });

    test("says so when the target is the oldest version and nothing older exists", async () => {
        const stubs = stubbedHistory();

        await expect(diffWikiPage({ api: stubs.api, config, input: "7", to: "aaa" })).rejects.toThrow(
            "/Projects/Feature has no version older than aaa11111"
        );
    });

    test("says the page has no history when no version is named and the history is empty", async () => {
        const stubs = stubbedHistory([]);

        const failure = await diffWikiPage({ api: stubs.api, config, input: "7" }).catch((error: Error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "Page /Projects/Feature has no history, so there is nothing to compare"
        );
        expect(stubs.fetchBinary).not.toHaveBeenCalled();
    });

    test("still names a requested version that an empty history cannot hold", async () => {
        const stubs = stubbedHistory([]);

        await expect(diffWikiPage({ api: stubs.api, config, input: "7", to: "zzz" })).rejects.toThrow(
            "No commit 'zzz' in the last 0 versions of /Projects/Feature"
        );
    });
});
