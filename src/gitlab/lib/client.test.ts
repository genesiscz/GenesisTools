import { describe, expect, test } from "bun:test";
import {
    getToken,
    HOST_HELP,
    looksLikeToken,
    newTokenUrl,
    normalizeHost,
    parseGitLabProjectFromRemote,
    parseGitLabRemote,
    pickHost,
    pickProject,
    tokenSetupHelp,
} from "@app/gitlab/lib/client";
import { DEFAULT_CONFIG, mergeConfig } from "@app/gitlab/lib/config";
import { formatDate } from "@app/gitlab/lib/dates";
import { createMessages, fillTemplate } from "@app/gitlab/lib/messages";
import { fetchAllPages, type Page, parseNextPage } from "@app/gitlab/lib/paginate";
import { pool } from "@app/gitlab/lib/pool";
import { extractWorkItemIds, toWorkItem, workItemLink, workItemUrl } from "@app/gitlab/lib/work-items";
import { env } from "@genesiscz/utils/env";

const HOST = "https://gitlab.example.com";

describe("looksLikeToken", () => {
    test("accepts a personal access token", () => {
        expect(looksLikeToken("glpat-abcdefghijklmnopqrstu")).toBe(true);
        expect(looksLikeToken("  glpat-abcdefghijklmnopqrstu\n")).toBe(true);
    });

    test("rejects the help text glab prints when it exits 0 on an unknown subcommand", () => {
        const help =
            "Manages authentication for glab against one or more GitLab instances. Use\n  these commands to log in";

        expect(looksLikeToken(help)).toBe(false);
    });

    test("rejects empty output and anything too short to be a token", () => {
        expect(looksLikeToken("")).toBe(false);
        expect(looksLikeToken("   \n ")).toBe(false);
        expect(looksLikeToken("short")).toBe(false);
    });
});

describe("tokenSetupHelp", () => {
    test("links the token page of the resolved host with the scope already filled in", () => {
        expect(newTokenUrl(HOST)).toBe(
            "https://gitlab.example.com/-/user_settings/personal_access_tokens?name=genesis-tools&scopes=api"
        );
        expect(tokenSetupHelp(HOST, [])).toContain(newTokenUrl(HOST));
    });

    test("offers a way to store it for that host and repeats what was tried", () => {
        const help = tokenSetupHelp(HOST, ["glab auth token --hostname gitlab.example.com — no token in the output"]);

        expect(help).toContain("No GitLab token found for gitlab.example.com.");
        expect(help).toContain("glab auth login --hostname gitlab.example.com");
        expect(help).toContain("export GITLAB_TOKEN=");
        expect(help).toContain("glab auth token --hostname gitlab.example.com — no token in the output");
    });

    test("GITLAB_TOKEN wins without asking glab", async () => {
        await env.testing.withOverrides({ GITLAB_TOKEN: "glpat-fromtheenvironment00" }, async () => {
            expect(await getToken(HOST)).toBe("glpat-fromtheenvironment00");
        });
    });
});

describe("host resolution", () => {
    test("normalises to scheme://host with no trailing slash, keeping http and a relative root", () => {
        expect(normalizeHost("gitlab.example.com")).toBe(HOST);
        expect(normalizeHost("https://gitlab.example.com/")).toBe(HOST);
        expect(normalizeHost(" https://gitlab.example.com ")).toBe(HOST);
        expect(normalizeHost("http://gitlab.example.com:8080/gitlab/")).toBe("http://gitlab.example.com:8080/gitlab");
    });

    test("--host beats GITLAB_HOST beats glab's default host", () => {
        let asked = false;
        const glab = () => {
            asked = true;

            return "https://glab-default.example.com";
        };

        expect(pickHost({ flag: "flag.example.com", env: "env.example.com", glabDefault: glab })).toEqual({
            host: "https://flag.example.com",
            source: "--host",
        });
        expect(asked).toBe(false);
        expect(pickHost({ env: "env.example.com", glabDefault: glab }).host).toBe("https://env.example.com");
        expect(pickHost({ glabDefault: glab })).toEqual({
            host: "https://glab-default.example.com",
            source: "glab config get host",
        });
    });

    test("no source at all is an error that says how to set one", () => {
        expect(() => pickHost({ glabDefault: () => null })).toThrow(HOST_HELP);
        expect(HOST_HELP).toContain("GITLAB_HOST");
    });
});

describe("project resolution", () => {
    test("parses https, scp-style and ssh remotes", () => {
        expect(parseGitLabProjectFromRemote("https://gitlab.example.com/acme/platform/web-app.git")).toBe(
            "acme/platform/web-app"
        );
        expect(parseGitLabProjectFromRemote("git@gitlab.example.com:acme/platform/web-app.git")).toBe(
            "acme/platform/web-app"
        );
        expect(parseGitLabProjectFromRemote("ssh://git@gitlab.example.com:2222/acme/web-app.git")).toBe("acme/web-app");
        expect(parseGitLabProjectFromRemote("")).toBeNull();
        expect(parseGitLabRemote("git@gitlab.example.com:acme/web-app.git")?.hostname).toBe("gitlab.example.com");
    });

    test("--project beats GITLAB_PROJECT beats the origin remote", () => {
        const remote = "git@gitlab.example.com:acme/web-app.git";

        expect(pickProject({ flag: "acme/api", env: "acme/cli", remote, host: HOST }).project).toBe("acme/api");
        expect(pickProject({ env: "acme/cli", remote, host: HOST }).project).toBe("acme/cli");
        expect(pickProject({ remote, host: HOST })).toEqual({ project: "acme/web-app", source: "git remote origin" });
        expect(pickProject({ flag: "1234", host: HOST }).project).toBe("1234");
    });

    test("an origin on another host is not used, and the error says why", () => {
        expect(() => pickProject({ remote: "https://git.other.example/acme/web-app.git", host: HOST })).toThrow(
            "The origin remote points at git.other.example, not gitlab.example.com."
        );
        expect(() => pickProject({ host: HOST })).toThrow("Pass --project");
    });
});

describe("config", () => {
    test("a missing file is the neutral defaults", () => {
        expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
        expect(DEFAULT_CONFIG.workItems.idPattern).toBeNull();
        expect(DEFAULT_CONFIG.stale.environments).toEqual({
            uat: null,
            production: null,
            releasePrefix: null,
            test: null,
        });
    });

    test("the file overrides field by field and keeps the rest", () => {
        const config = mergeConfig({
            language: "cs",
            dateStyle: "dmy",
            messages: { "closedBug.askUnknown": "- Where is the fix?" },
            workItems: { idPattern: "(?<!\\d)(\\d{6})(?!\\d)" },
            stale: { label: "Dormant", environments: { uat: "staging", releasePrefix: "release/" } },
        });

        expect(config.language).toBe("cs");
        expect(config.workItems.urlTemplate).toBeNull();
        expect(config.stale.label).toBe("Dormant");
        expect(config.stale.environments).toEqual({
            uat: "staging",
            production: null,
            releasePrefix: "release/",
            test: null,
        });
        expect(config.stale.mergeLabelPattern).toBe(DEFAULT_CONFIG.stale.mergeLabelPattern);
    });

    test("typos fail loudly instead of being ignored", () => {
        expect(() => mergeConfig({ language: "de" })).toThrow("language must be one of en, cs");
        expect(() => mergeConfig({ messages: { "closedBug.nope": "x" } })).toThrow(
            'unknown message key "closedBug.nope"'
        );
        expect(() => mergeConfig({ workItems: { idPattern: "(" } })).toThrow("not a valid regular expression");
        expect(() => mergeConfig({ stale: { label: 7 } })).toThrow("stale.label must be a string or null");
    });
});

describe("work items", () => {
    const pattern = "(?<!\\d)(\\d{6})(?!\\d)";

    test("no pattern means no ids", () => {
        expect(extractWorkItemIds(null, "Fix 123456 now")).toEqual([]);
    });

    test("ids come out in order of first appearance, once each", () => {
        expect(
            extractWorkItemIds(pattern, "feat: 123456 and 234567", "branch/123456-x", "see 3456789 and 345678")
        ).toEqual([123456, 234567, 345678]);
    });

    test("the URL template links an id; no template leaves the bare id", () => {
        const config = { urlTemplate: "https://dev.azure.com/acme/web/_workitems/edit/{id}" };

        expect(workItemUrl(config, 42)).toBe("https://dev.azure.com/acme/web/_workitems/edit/42");
        expect(workItemLink(config, 42)).toBe("[42](https://dev.azure.com/acme/web/_workitems/edit/42)");
        expect(workItemLink({ urlTemplate: null }, 42)).toBe("42");
    });

    test("custom fields are read only when configured", () => {
        const raw = {
            id: 42,
            title: "Totals are wrong",
            state: "Closed",
            changed: "2026-09-01T00:00:00Z",
            url: "https://dev.azure.com/acme/web/_workitems/edit/42",
            comments: [
                { id: 1, author: "Bob Example", date: "2026-08-30T10:00:00Z", text: "<p>Fixed&nbsp;on test</p>" },
            ],
            rawFields: {
                "System.WorkItemType": "Bug",
                "System.Parent": 7,
                "Microsoft.VSTS.Common.ClosedBy": { displayName: "Alice Example" },
                "Custom.Environment": "TEST",
            },
        };
        const configured = toWorkItem(raw, { ...DEFAULT_CONFIG.workItems, environmentField: "Custom.Environment" });

        expect(configured.environment).toBe("TEST");
        expect(configured.closedBy).toBe("Alice Example");
        expect(configured.parentId).toBe(7);
        expect(configured.comments[0]?.text).toBe("Fixed on test");
        expect(configured.url).toBe(raw.url);
        expect(toWorkItem(raw, DEFAULT_CONFIG.workItems).environment).toBeNull();
    });
});

describe("small helpers", () => {
    test("pool keeps input order and refuses a non-positive concurrency", async () => {
        const result = await pool([30, 10, 20], 2, async (ms, i) => {
            await Bun.sleep(ms / 10);

            return `${i}:${ms}`;
        });

        expect(result).toEqual(["0:30", "1:10", "2:20"]);
        await expect(pool([1], 0, async () => 1)).rejects.toThrow("Concurrency must be at least 1");
    });

    test("dates render as ISO by default and d.m.YYYY on request", () => {
        expect(formatDate("2026-09-08T12:19:00Z")).toBe("2026-09-08");
        expect(formatDate("2026-09-08T12:19:00Z", "dmy")).toBe("8.9.2026");
        expect(formatDate("2025-11-30", "dmy")).toBe("30.11.2025");
        expect(formatDate(null)).toBe("");
        expect(formatDate("not a date")).toBe("not a date");
    });

    test("templates fill known placeholders and keep unknown ones; plurals follow the language", () => {
        expect(fillTemplate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
        expect(createMessages("en").count(1, "file")).toBe("1 file");
        expect(createMessages("en").count(3, "line")).toBe("3 lines");
        expect(createMessages("cs").count(3, "file")).toBe("3 soubory");
        expect(createMessages("cs").count(8, "line")).toBe("8 řádků");
        expect(createMessages("en", { "closedBug.sample": ", partial check" }).text("closedBug.sample")).toBe(
            ", partial check"
        );
    });
});

function pages(sizes: number[], nextPages: Array<number | null | undefined>) {
    const asked: number[] = [];
    const getPage = async (page: number): Promise<Page<number>> => {
        asked.push(page);
        const size = sizes[page - 1] ?? 0;

        return { items: Array.from({ length: size }, (_, i) => page * 1000 + i), nextPage: nextPages[page - 1] };
    };

    return { asked, getPage };
}

describe("fetchAllPages", () => {
    // Regression: /users/:id/events drops events the token cannot see AFTER paging, so page 2 came
    // back with 99 of 100 while the server still announced pages 3 to 5. Stopping at the short page
    // lost 206 of 405 events in a live check.
    test("follows X-Next-Page past a short page", async () => {
        const { asked, getPage } = pages([100, 99, 100, 100, 6], [2, 3, 4, 5, null]);
        const result = await fetchAllPages(getPage, { maxPages: 50 });

        expect(result.items).toHaveLength(405);
        expect(result.pages).toBe(5);
        expect(result.truncated).toBe(false);
        expect(asked).toEqual([1, 2, 3, 4, 5]);
    });

    // Regression: `merge_requests/:iid/draft_notes` sends no X-Next-Page and IGNORES `page`, so every
    // page repeated the same two drafts. Without the header, a short page is the last page, and a
    // page equal to the previous one ends the walk and is dropped (seen live: 1000 "drafts" for 2 real
    // ones after 500 requests).
    test("without the header, a short page ends the walk", async () => {
        const { asked, getPage } = pages([100, 99, 40], [undefined, undefined, undefined]);
        const result = await fetchAllPages(getPage, { maxPages: 50, perPage: 100 });

        expect(result.items).toHaveLength(199);
        expect(result.truncated).toBe(false);
        expect(asked).toEqual([1, 2]);
    });

    test("without the header, a page that repeats the previous one ends the walk and is dropped", async () => {
        const asked: number[] = [];
        const result = await fetchAllPages(
            async (page) => {
                asked.push(page);

                return { items: [{ id: 501 }, { id: 502 }], nextPage: undefined };
            },
            { maxPages: 500, perPage: 2 }
        );

        expect(result.items).toEqual([{ id: 501 }, { id: 502 }]);
        expect(result.truncated).toBe(false);
        expect(asked).toEqual([1, 2]);
    });

    test("without the header and without a page size, an empty page still ends the walk", async () => {
        const { asked, getPage } = pages([3, 0], [undefined, undefined]);
        const result = await fetchAllPages(getPage, { maxPages: 50 });

        expect(result.items).toHaveLength(3);
        expect(asked).toEqual([1, 2]);
    });

    test("reports truncation when the page cap is hit while the server still has pages", async () => {
        const { asked, getPage } = pages([100, 100, 100, 100], [2, 3, 4, null]);
        const result = await fetchAllPages(getPage, { maxPages: 2 });

        expect(result.truncated).toBe(true);
        expect(result.items).toHaveLength(200);
        expect(asked).toEqual([1, 2]);
    });

    test("is not truncated when the cap lands exactly on the last page", async () => {
        const { getPage } = pages([100, 5], [2, null]);
        const result = await fetchAllPages(getPage, { maxPages: 2 });

        expect(result.truncated).toBe(false);
        expect(result.items).toHaveLength(105);
    });
});

describe("parseNextPage", () => {
    test("a number is the next page, an empty header is the last page, no header is unknown", () => {
        expect(parseNextPage("3")).toBe(3);
        expect(parseNextPage("")).toBeNull();
        expect(parseNextPage(null)).toBeUndefined();
    });
});
