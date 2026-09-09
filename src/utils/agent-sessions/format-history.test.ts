import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { formatHistoryJson, formatHistoryMarkdown } from "./format-history";
import type { AgentSearchHit } from "./types";

const hit: AgentSearchHit = {
    kind: "grok",
    sessionId: "01a05cc5-0ecf-7d40-945e-977e45b3f935",
    cwd: "/Users/me/Projects/shop",
    title: "PRs merged into release/2026-09-03",
    mtime: new Date("2026-09-02T10:00:00.000Z"),
    filePath: "/tmp/summary.json",
    matchedText: "please restore the panes",
};

describe("formatHistoryMarkdown", () => {
    test("includes the query, title, id and match snippet", () => {
        const md = formatHistoryMarkdown([hit], "restore");
        expect(md).toContain('matching "restore"');
        expect(md).toContain("PRs merged into release/2026-09-03");
        expect(md).toContain("01a05cc5-0ecf-7d40-945e-977e45b3f935");
        expect(md).toContain("please restore the panes");
        expect(md).toContain("**Kind:** grok");
    });
});

describe("formatHistoryJson", () => {
    test("emits sessionId and kind", () => {
        const parsed = SafeJSON.parse(formatHistoryJson([hit])) as Array<{ sessionId: string; kind: string }>;
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.sessionId).toBe(hit.sessionId);
        expect(parsed[0]?.kind).toBe("grok");
    });
});

test("formats context and preserves source provenance in JSON", () => {
    const rich: AgentSearchHit = {
        ...hit,
        sourceHome: "/profiles/work",
        sourceKey: "source-work",
        account: null,
        contextEntries: [
            {
                line: 4,
                role: "tool",
                tool: "Edit",
                text: "refund rounding fixed",
                paths: ["src/invoice.ts"],
                commits: [],
            },
        ],
    };
    expect(formatHistoryMarkdown([rich])).toContain("refund rounding fixed");
    expect(formatHistoryMarkdown([rich])).toContain("Edit");
    const parsed = SafeJSON.parse(formatHistoryJson([rich]));
    expect(parsed[0].sourceHome).toBe("/profiles/work");
    expect(parsed[0].sourceKey).toBe("source-work");
});

test("JSON output bounds the machine payload and says where it cut", () => {
    // One codex tool result held 861,027 characters, so five hits weighed 13,434,868 bytes while
    // base grok answered the same shape in 3,273. `matchedText` was capped; the entries were not.
    const entry = (text: string) => ({ line: 1, role: "assistant" as const, text, paths: [], commits: [] });
    const json = SafeJSON.parse(
        formatHistoryJson([
            {
                kind: "codex",
                sessionId: "fixture",
                cwd: "/projects/shop",
                title: "Fixture",
                mtime: new Date("2026-09-01T10:00:00.000Z"),
                filePath: "/invented/fixture.jsonl",
                matchedEntries: Array.from({ length: 40 }, () => entry("x".repeat(5000))),
            },
        ]),
        { strict: true }
    ) as Array<{
        matchedEntries: Array<{ text: string; textTruncated?: boolean }>;
        matchedEntriesTruncatedFrom?: number;
    }>;

    expect(json[0].matchedEntries).toHaveLength(20);
    expect(json[0].matchedEntries[0].text).toHaveLength(1200);
    expect(json[0].matchedEntries[0].textTruncated).toBe(true);
    expect(json[0].matchedEntriesTruncatedFrom).toBe(40);
});
