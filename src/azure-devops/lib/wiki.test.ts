import { describe, expect, test } from "bun:test";
import type { GitCommitRefApi, WikiPageApi, WikiV2 } from "@app/azure-devops/api.types";
import {
    extractAttachmentRefs,
    findCommit,
    flattenPageTree,
    gitPathToPagePath,
    localAttachmentNames,
    parseWikiPageRef,
    pickWiki,
    recursionLevelForDepth,
    renderWikiPageMarkdown,
    rewriteAttachmentLinks,
    toSearchRows,
} from "@app/azure-devops/lib/wiki";
import type { AzureConfig } from "@app/azure-devops/types";

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
