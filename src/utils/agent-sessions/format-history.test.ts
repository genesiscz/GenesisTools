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
