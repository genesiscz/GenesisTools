import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { extractGrokUserQueries, listGrokSessionsFromRoot, searchGrokSessions } from "./grok-sessions";

const ID_A = "01a05cc5-0ecf-7d40-945e-977e45b3f935";
const ID_B = "01a05d17-c512-7dd2-abb6-e62d8c7d612a";

function writeSession(
    root: string,
    cwd: string,
    id: string,
    opts: { title: string; updated: string; query?: string }
): void {
    const dir = join(root, encodeURIComponent(cwd), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "summary.json"),
        SafeJSON.stringify({
            info: { id, cwd },
            generated_title: opts.title,
            session_summary: opts.title,
            updated_at: opts.updated,
        })
    );
    if (opts.query) {
        writeFileSync(
            join(dir, "chat_history.jsonl"),
            `${SafeJSON.stringify({
                type: "user",
                content: [{ type: "text", text: `<user_query>\n${opts.query}\n</user_query>` }],
            })}\n`
        );
    }
}

describe("extractGrokUserQueries", () => {
    test("pulls the tagged user_query out of a chat_history line", () => {
        const line = SafeJSON.stringify({
            type: "user",
            content: [{ type: "text", text: "<user_query>\nrestore cmux panes\n</user_query>" }],
        });
        expect(extractGrokUserQueries(`${line}\n`)).toEqual(["restore cmux panes"]);
    });

    test("skips harness user_info blobs", () => {
        const info = SafeJSON.stringify({
            type: "user",
            content: [{ type: "text", text: "<user_info>\nOS Version: macos\n</user_info>" }],
        });
        const real = SafeJSON.stringify({
            type: "user",
            content: [{ type: "text", text: "<user_query>\nrestore cmux panes\n</user_query>" }],
        });
        expect(extractGrokUserQueries(`${info}\n${real}\n`)).toEqual(["restore cmux panes"]);
    });
});

describe("listGrokSessionsFromRoot", () => {
    test("reads summary.json from encoded-cwd uuid dirs", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-sessions-"));
        writeSession(root, "/Users/me/Projects/shop", ID_A, {
            title: "PRs merged into release/2026-09-03",
            updated: "2026-09-02T10:00:00.000Z",
        });
        writeSession(root, "/Users/me/Projects/App", ID_B, {
            title: "aws-costs",
            updated: "2026-09-03T10:00:00.000Z",
        });

        const listed = listGrokSessionsFromRoot(root);
        expect(listed.map((s) => s.sessionId).sort()).toEqual([ID_A, ID_B].sort());
        const prs = listed.find((s) => s.sessionId === ID_A);
        expect(prs?.cwd).toBe("/Users/me/Projects/shop");
        expect(prs?.title).toBe("PRs merged into release/2026-09-03");
        expect(prs?.kind).toBe("grok");
    });
});

describe("searchGrokSessions", () => {
    test("filters by cwd, query in title, and query in user_query", () => {
        const root = mkdtempSync(join(tmpdir(), "grok-search-"));
        const shop = "/Users/me/Projects/shop";
        writeSession(root, shop, ID_A, {
            title: "PRs merged into release/2026-09-03",
            updated: "2026-09-02T10:00:00.000Z",
            query: "please restore the panes",
        });
        writeSession(root, shop, ID_B, {
            title: "aws-costs",
            updated: "2026-09-03T10:00:00.000Z",
            query: "how much did we spend",
        });

        const byTitle = searchGrokSessions(root, { query: "PRs merged", cwd: shop });
        expect(byTitle.map((s) => s.sessionId)).toEqual([ID_A]);

        const byBody = searchGrokSessions(root, { query: "restore the panes", cwd: shop });
        expect(byBody.map((s) => s.sessionId)).toEqual([ID_A]);
        expect(byBody[0]?.matchedText).toContain("restore the panes");

        const limited = searchGrokSessions(root, { cwd: shop, limit: 1 });
        expect(limited).toHaveLength(1);
        expect(limited[0]?.sessionId).toBe(ID_B);
    });
});
