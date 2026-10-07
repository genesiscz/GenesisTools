import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingWorkItemSelected, registerStaleBranches } from "@app/gitlab/commands/stale-branches";
import {
    assertSecureHost,
    buildNewTokenUrl,
    getCommitDiff,
    getToken,
    HOST_HELP,
    looksLikeToken,
    newTokenUrl,
    normalizeHost,
    parseGitLabProjectFromRemote,
    parseGitLabRemote,
    pickHost,
    pickProject,
    restWrite,
    tokenCommands,
    tokenSetupHelp,
} from "@app/gitlab/lib/client";
import {
    appendLedger,
    ledgerPath as commentLedgerPath,
    readLedger,
    withLegacyProject,
} from "@app/gitlab/lib/comment-batch";
import { DEFAULT_CONFIG, mergeConfig, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import { formatDate, setDateStyle } from "@app/gitlab/lib/dates";
import { defaults } from "@app/gitlab/lib/defaults";
import { ledgerPath as labelLedgerPath, readLabelLedger } from "@app/gitlab/lib/label-batch";
import { createMessages, fillTemplate } from "@app/gitlab/lib/messages";
import { NEUTRAL_DEFAULTS } from "@app/gitlab/lib/neutral-defaults";
import { fetchAllPages, type Page, parseNextPage } from "@app/gitlab/lib/paginate";
import { pool } from "@app/gitlab/lib/pool";
import { extractWorkItemIds, toWorkItem, workItemLink, workItemUrl } from "@app/gitlab/lib/work-items";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";

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
        expect(newTokenUrl(HOST, NEUTRAL_DEFAULTS.token)).toBe(
            "https://gitlab.example.com/-/user_settings/personal_access_tokens?name=genesis-tools&scopes=api"
        );
        expect(buildNewTokenUrl(HOST, "my tool")).toContain("?name=my%20tool&scopes=api");
        expect(tokenSetupHelp(HOST, [], NEUTRAL_DEFAULTS.token)).toContain(newTokenUrl(HOST, NEUTRAL_DEFAULTS.token));
    });

    test("offers a way to store it for that host and repeats what was tried", () => {
        const help = tokenSetupHelp(
            HOST,
            ["glab auth token --hostname gitlab.example.com — no token in the output"],
            NEUTRAL_DEFAULTS.token
        );

        expect(help).toContain("No GitLab token found for gitlab.example.com.");
        expect(help).toContain("glab auth login --hostname gitlab.example.com");
        expect(help).toContain("export GITLAB_TOKEN=");
        expect(help).toContain("glab auth token --hostname gitlab.example.com — no token in the output");
    });

    test("a fork's token defaults add a creation URL, sources after glab's, and store hints", () => {
        const token = {
            name: "fork-tool",
            newTokenUrl: (host: string) => `${host}/-/user_settings/personal_access_tokens/legacy/new?name=fork-tool`,
            extraCommands: (hostname: string) => [["secret-tool", "lookup", "gitlab", hostname]],
            extraStoreHints: [["secret-tool store gitlab <token>", "kept in the keyring"]] as const,
        };

        expect(tokenCommands("gitlab.example.com", NEUTRAL_DEFAULTS.token)).toHaveLength(2);
        expect(tokenCommands("gitlab.example.com", token).at(-1)).toEqual([
            "secret-tool",
            "lookup",
            "gitlab",
            "gitlab.example.com",
        ]);
        expect(tokenCommands("gitlab.example.com", token)[0]?.[0]).toBe("glab");

        const help = tokenSetupHelp(HOST, [], token);
        expect(help).toContain("/personal_access_tokens/legacy/new?name=fork-tool");
        expect(help).toContain("secret-tool store gitlab <token>");
    });

    test("GITLAB_TOKEN wins without asking glab", async () => {
        await env.testing.withOverrides({ GITLAB_TOKEN: "glpat-fromtheenvironment00" }, async () => {
            expect(await getToken(HOST)).toBe("glpat-fromtheenvironment00");
        });
    });
});

describe("assertSecureHost", () => {
    test("refuses to pair the token with a plain http host on the network", () => {
        expect(() => assertSecureHost("http://gitlab.example.com")).toThrow("Refusing to send a GitLab token");
    });

    test("allows https anywhere and http on loopback only", () => {
        expect(() => assertSecureHost("https://gitlab.example.com")).not.toThrow();
        expect(() => assertSecureHost("http://localhost:8080")).not.toThrow();
        expect(() => assertSecureHost("http://127.0.0.1:9")).not.toThrow();
        expect(() => assertSecureHost("http://[::1]:8080")).not.toThrow();
    });
});

describe("getCommitDiff", () => {
    // 130 changed files, served 100 per page with GitLab's X-Next-Page header.
    const files = Array.from({ length: 130 }, (_, index) => ({ new_path: `f${index}.ts` }));
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
            const body = files.slice((page - 1) * 100, page * 100);

            return new Response(SafeJSON.stringify(body), { headers: { "x-next-page": page === 1 ? "2" : "" } });
        },
    });

    afterAll(() => {
        server.stop(true);
    });

    test("reads every page of a commit that touches more than 100 files", async () => {
        const diff = await getCommitDiff({ host: `http://localhost:${server.port}`, token: "t" }, 7, "abc");

        expect(diff).toHaveLength(130);
    });
});

describe("restWrite retries", () => {
    // Every request answers 502, the shape of a write GitLab committed and still failed to confirm.
    const hits: string[] = [];
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            hits.push(request.method);

            return new Response("bad gateway", { status: 502 });
        },
    });
    const api = { host: `http://localhost:${server.port}`, token: "t" };

    afterAll(() => {
        server.stop(true);
    });

    test("sends a POST once by default, so a committed note is never created twice", async () => {
        hits.length = 0;

        await expect(restWrite(api, { method: "POST", path: "/notes", body: {} })).rejects.toThrow();
        expect(hits).toEqual(["POST"]);
    });

    test("still retries a POST when the caller opts in", async () => {
        hits.length = 0;

        await expect(restWrite(api, { method: "POST", path: "/notes", body: {}, retries: 2 })).rejects.toThrow();
        expect(hits).toEqual(["POST", "POST"]);
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

    test("a default host comes after GITLAB_HOST and before glab's default host", () => {
        let asked = false;
        const glab = () => {
            asked = true;

            return "https://glab-default.example.com";
        };
        const fallback = "https://gitlab.fork.example";

        expect(pickHost({ env: "env.example.com", fallback, glabDefault: glab }).host).toBe("https://env.example.com");
        expect(pickHost({ fallback, glabDefault: glab })).toEqual({ host: fallback, source: "default host" });
        expect(asked).toBe(false);
        expect(pickHost({ fallback: null, glabDefault: glab }).host).toBe("https://glab-default.example.com");
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

    test("a default project beats origin when no checkout is named, and follows it when one is", () => {
        const remote = "git@gitlab.example.com:acme/web-app.git";
        const fallback = "acme/default-app";

        expect(pickProject({ env: "acme/cli", fallback, fallbackFirst: true, remote, host: HOST }).project).toBe(
            "acme/cli"
        );
        expect(pickProject({ fallback, fallbackFirst: true, remote, host: HOST })).toEqual({
            project: fallback,
            source: "default project",
        });
        expect(pickProject({ fallback, fallbackFirst: false, remote, host: HOST }).project).toBe("acme/web-app");
        expect(pickProject({ fallback, fallbackFirst: false, remote: null, host: HOST }).project).toBe(fallback);
        expect(
            pickProject({ fallback, remote: "https://git.other.example/acme/web-app.git", host: HOST }).project
        ).toBe(fallback);
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
        expect(mergeConfig(null, NEUTRAL_CONFIG)).toEqual(NEUTRAL_CONFIG);
        expect(mergeConfig(null)).toEqual(DEFAULT_CONFIG);
        expect(DEFAULT_CONFIG).toEqual(mergeConfig(defaults.config, NEUTRAL_CONFIG));
        expect(NEUTRAL_CONFIG.workItems.idPattern).toBeNull();
        expect(NEUTRAL_CONFIG.stale.environments).toEqual({
            uat: null,
            production: null,
            releasePrefix: null,
            test: null,
        });
    });

    test("the file overrides field by field and keeps the rest", () => {
        const config = mergeConfig(
            {
                language: "cs",
                dateStyle: "dmy",
                messages: { "closedBug.askUnknown": "- Where is the fix?" },
                workItems: { idPattern: "(?<!\\d)(\\d{6})(?!\\d)" },
                stale: { label: "Dormant", environments: { uat: "staging", releasePrefix: "release/" } },
            },
            NEUTRAL_CONFIG
        );

        expect(config.language).toBe("cs");
        expect(config.workItems.urlTemplate).toBeNull();
        expect(config.stale.label).toBe("Dormant");
        expect(config.stale.environments).toEqual({
            uat: "staging",
            production: null,
            releasePrefix: "release/",
            test: null,
        });
        expect(config.stale.mergeLabelPattern).toBe(NEUTRAL_CONFIG.stale.mergeLabelPattern);
    });

    test("a base's gates and messages survive a file that does not set them", () => {
        const base = mergeConfig(
            {
                messages: { "closedBug.askUnknown": "- Where is the fix?" },
                review: { gates: [{ label: "types", command: "tsc --noEmit" }] },
            },
            NEUTRAL_CONFIG
        );
        const merged = mergeConfig({ language: "cs" }, base);

        expect(merged.review.gates).toEqual([{ label: "types", command: "tsc --noEmit", when: null, exclude: null }]);
        expect(merged.messages["closedBug.askUnknown"]).toBe("- Where is the fix?");
        expect(mergeConfig({ review: { gates: [] } }, base).review.gates).toEqual([]);
    });

    test("a section of the wrong type fails loudly instead of falling back to the defaults", () => {
        expect(() => mergeConfig({ stale: false })).toThrow("stale must be an object");
        expect(() => mergeConfig({ workItems: "x" })).toThrow("workItems must be an object");
        expect(() => mergeConfig({ stale: { environments: [] } })).toThrow("stale.environments must be an object");
    });

    test("typos fail loudly instead of being ignored", () => {
        expect(() => mergeConfig({ language: "de" })).toThrow("language must be one of en, cs");
        expect(() => mergeConfig({ messages: { "closedBug.nope": "x" } })).toThrow(
            'unknown message key "closedBug.nope"'
        );
        expect(() => mergeConfig({ workItems: { idPattern: "(" } })).toThrow("not a valid regular expression");
        expect(() => mergeConfig({ stale: { label: 7 } })).toThrow("stale.label must be a string or null");
    });

    test("fetch-review defaults and extra next steps come from review.fetch and review.nextSteps", () => {
        expect(NEUTRAL_CONFIG.review.fetch).toEqual({ format: "json", contextLines: 3 });
        expect(NEUTRAL_CONFIG.review.nextSteps).toEqual([]);

        const config = mergeConfig(
            { review: { fetch: { format: "md", contextLines: 10 }, nextSteps: ["Reply with the review skill."] } },
            NEUTRAL_CONFIG
        );

        expect(config.review.fetch).toEqual({ format: "md", contextLines: 10 });
        expect(config.review.nextSteps).toEqual(["Reply with the review skill."]);
        expect(mergeConfig({ review: { fetch: { contextLines: 0 } } }, NEUTRAL_CONFIG).review.fetch).toEqual({
            format: "json",
            contextLines: 0,
        });
        expect(() => mergeConfig({ review: { fetch: { format: "html" } } })).toThrow(
            "review.fetch.format must be one of json, md, both"
        );
        expect(() => mergeConfig({ review: { fetch: { contextLines: -1 } } })).toThrow(
            "review.fetch.contextLines must be a whole number"
        );
        expect(() => mergeConfig({ review: { nextSteps: "x" } })).toThrow(
            "review.nextSteps must be an array of strings"
        );
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
        const configured = toWorkItem(raw, { ...NEUTRAL_CONFIG.workItems, environmentField: "Custom.Environment" });

        expect(configured.environment).toBe("TEST");
        expect(configured.closedBy).toBe("Alice Example");
        expect(configured.parentId).toBe(7);
        expect(configured.comments[0]?.text).toBe("Fixed on test");
        expect(configured.url).toBe(raw.url);
        expect(toWorkItem(raw, NEUTRAL_CONFIG.workItems).environment).toBeNull();
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
        setDateStyle("iso");
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

describe("ledger lines from before entries carried a project", () => {
    test("belong to the legacy project when one is set, and stay as they are otherwise", () => {
        const old = { pr: "7", message: "m" } as { pr: string; message: string; project?: string };

        expect(withLegacyProject(old, "acme/web-app").project).toBe("acme/web-app");
        expect(withLegacyProject({ ...old, project: "acme/api" }, "acme/web-app").project).toBe("acme/api");
        expect(withLegacyProject(old, null)).toBe(old);
    });
});

describe("ledger reads", () => {
    test("reading or naming a ledger creates no folder; the first write does", () => {
        const root = join(mkdtempSync(join(tmpdir(), "gt-ledger-")), "not-yet");
        const comments = commentLedgerPath(root);

        expect(comments).toBe(join(root, "comment-batch.jsonl"));
        expect(labelLedgerPath(root)).toBe(join(root, "label-batch.jsonl"));
        expect(readLedger(comments)).toEqual([]);
        expect(readLabelLedger(labelLedgerPath(root))).toEqual([]);
        expect(existsSync(root)).toBe(false);

        appendLedger({ project: "acme/web-app", pr: "7", message: "m", comment_id: 1, ts: "t" }, comments);
        expect(readLedger(comments).map((entry) => entry.pr)).toEqual(["7"]);
    });
});

describe("stale-branches side-comment", () => {
    test("--no-ado is a hidden alias of --missing-work-item", () => {
        const program = new Command();
        registerStaleBranches(program);
        const side = program.commands
            .find((command) => command.name() === "stale-branches")
            ?.commands.find((command) => command.name() === "side-comment");

        expect(side?.helpInformation()).toContain("--missing-work-item");
        expect(side?.helpInformation()).not.toContain("--no-ado");
        side?.parseOptions(["--no-ado"]);
        expect(missingWorkItemSelected(side?.opts() ?? {})).toBe(true);
        expect(missingWorkItemSelected({})).toBe(false);
        expect(missingWorkItemSelected({ missingWorkItem: true })).toBe(true);
    });
});
