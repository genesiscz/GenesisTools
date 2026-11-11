import { describe, expect, test } from "bun:test";
import { type IssueWriteClient, type NewIssue, postIssue } from "./issue-post";

type Posted = NewIssue;

/** Records every request; a `refuse` client throws on any call, so a dry run that reaches it fails loudly. */
function client(posted: Posted[], options: { refuse?: boolean; fail?: string } = {}): IssueWriteClient {
    return {
        createIssue: async (issue) => {
            if (options.refuse) {
                throw new Error(`a dry run reached the GitHub client: ${issue.title}`);
            }

            if (options.fail) {
                throw new Error(options.fail);
            }

            posted.push(issue);
            return { number: 42, url: "https://github.com/shop/storefront/issues/42" };
        },
    };
}

const BODY = [
    "## GenesisTools failure: The camera did not start.",
    "",
    "- **Recording folder:** `/Users/alice/.genesis-tools/recordings/library/video-1`",
    "- contact alice@example.com, token ghp_abcdefghijklmnopqrstuvwxyz0123456789, at 12:50:46",
    "- reported by Wile E. Coyote at acme-corp.example",
].join("\n");

const MARKERS = [
    { label: "real-name", pattern: "\\bWile E\\. Coyote\\b" },
    { label: "host", pattern: "acme-corp\\.example" },
];

/** A marker JavaScript cannot compile (the list is PCRE, so `(?i)` and the like fail). */
const BROKEN = { label: "broken", pattern: "(unclosed" };

describe("tools github issues post", () => {
    test("posts the title, body and labels to the repository and returns the issue's number and URL", async () => {
        const posted: Posted[] = [];
        const result = await postIssue(
            { repo: "shop/storefront", title: "The camera did not start", body: "Plain text.", labels: ["bug"] },
            { client: () => client(posted), markers: () => [], homeDir: "/Users/alice" }
        );

        expect(posted).toEqual([
            {
                owner: "shop",
                repo: "storefront",
                title: "The camera did not start",
                body: "Plain text.",
                labels: ["bug"],
            },
        ]);
        expect(result).toMatchObject({ posted: true, number: 42, url: "https://github.com/shop/storefront/issues/42" });
    });

    test("--redact replaces home paths, emails, tokens and the local markers before posting, and counts them", async () => {
        const posted: Posted[] = [];
        const result = await postIssue(
            { repo: "shop/storefront", title: "Failure for Wile E. Coyote", body: BODY, redact: true },
            { client: () => client(posted), markers: () => MARKERS, homeDir: "/Users/alice" }
        );

        const sent = posted[0];
        expect(String(sent?.title)).not.toContain("Coyote");
        expect(String(sent?.body)).not.toContain("/Users/alice");
        expect(String(sent?.body)).not.toContain("alice@example.com");
        expect(String(sent?.body)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
        expect(String(sent?.body)).not.toContain("Coyote");
        expect(String(sent?.body)).not.toContain("acme-corp.example");
        expect(String(sent?.body)).toContain("[HOME]/.genesis-tools/recordings/library/video-1");
        expect(String(sent?.body)).toContain("at 12:50:46");
        expect(result.replaced).toMatchObject({ paths: 1, emails: 1, markers: 3 });
        expect(result.replaced.tokens + result.replaced.keys).toBeGreaterThanOrEqual(1);
        expect(result.skippedMarkers).toEqual([]);
    });

    test("--redact with a marker JavaScript cannot compile posts nothing, and a dry run names the marker", async () => {
        const posted: Posted[] = [];
        const deps = { client: () => client(posted), markers: () => [...MARKERS, BROKEN], homeDir: "/Users/alice" };

        await expect(
            postIssue({ repo: "shop/storefront", title: "T", body: BODY, redact: true }, deps)
        ).rejects.toThrow("nothing was posted: broken");
        expect(posted).toEqual([]);

        const dry = await postIssue(
            { repo: "shop/storefront", title: "T", body: BODY, redact: true, dryRun: true },
            deps
        );
        expect(dry.posted).toBe(false);
        expect(dry.skippedMarkers).toEqual(["broken"]);
        expect(posted).toEqual([]);
    });

    test("--dry-run returns what would be posted and never calls GitHub", async () => {
        const result = await postIssue(
            { repo: "shop/storefront", title: "T", body: BODY, redact: true, dryRun: true },
            { client: () => client([], { refuse: true }), markers: () => MARKERS, homeDir: "/Users/alice" }
        );

        expect(result.posted).toBe(false);
        expect(result.url).toBeNull();
        expect(result.body).not.toContain("Coyote");
    });

    test("a refused repository or an empty title fails before anything is sent", async () => {
        const deps = { client: () => client([], { refuse: true }), markers: () => [], homeDir: "/Users/alice" };
        await expect(postIssue({ repo: "storefront", title: "T", body: "b" }, deps)).rejects.toThrow("owner/repo");
        await expect(postIssue({ repo: "shop/storefront", title: "  ", body: "b" }, deps)).rejects.toThrow("title");
    });

    test("GitHub's refusal reaches the caller", async () => {
        const deps = { client: () => client([], { fail: "Not Found" }), markers: () => [], homeDir: "/Users/alice" };
        await expect(postIssue({ repo: "shop/storefront", title: "T", body: "b" }, deps)).rejects.toThrow("Not Found");
    });
});
