import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { formatHistoryJson, formatHistoryMarkdown, renderHistoryTable } from "./format-history";
import type { AgentSearchHit } from "./types";

const realPrintln = out.println;

afterEach(() => {
    out.println = realPrintln;
});

function renderedTable(hits: AgentSearchHit[], query?: string): string {
    const lines: string[] = [];
    out.println = (raw?: unknown, ...rest: unknown[]) => {
        lines.push([raw, ...rest].map(String).join(" "));
    };
    renderHistoryTable(hits, query);

    return lines.join("\n");
}

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

/**
 * What `tools claude history` printed and the shared renderer did not. Every one of these was
 * visible on the Claude door only, so `tools codex history --sort-relevance --context 3` showed
 * neither the ranking nor the surrounding turns it had just paid to fetch.
 */
describe("the shared renderer carries what the Claude door always showed", () => {
    const rich: AgentSearchHit = {
        ...hit,
        project: "shop",
        gitBranch: "feat/refunds",
        summary: "Refund rounding across the invoice importer",
        isSubagent: true,
        relevanceScore: 42,
        filePath: `${homedir()}/.grok/sessions/01a05cc5.jsonl`,
        matchedEntries: [
            { line: 1, role: "assistant", text: "fixed", paths: [], commits: ["abc1234def", "abc1234def", "99887766"] },
        ],
        contextEntries: [
            { line: 3, role: "user", text: "the refund is off by a cent", paths: [], commits: [] },
            { line: 4, role: "tool", tool: "Edit", text: "rounding fixed", paths: ["src/invoice.ts"], commits: [] },
        ],
    };

    test("the heading names the search mode", () => {
        expect(formatHistoryMarkdown([hit], "refund", { summaryOnly: true })).toContain("(summary-only)");
        expect(formatHistoryMarkdown([hit], "refund", { sortByRelevance: true })).toContain("(by relevance)");
        expect(formatHistoryMarkdown([hit], "refund")).not.toContain("(summary-only)");
    });

    test("a hit names its project, subagent status, score, branch, summary and commits", () => {
        const md = formatHistoryMarkdown([rich], "refund", { sortByRelevance: true, context: 3 });

        expect(md).toContain("(shop)");
        expect(md).toContain("[Subagent]");
        expect(md).toContain("[score: 42]");
        expect(md).toContain("**Branch:** feat/refunds");
        expect(md).toContain("**Summary:** Refund rounding across the invoice importer");
        // De-duplicated, and shortened to the seven characters a human reads a hash by.
        expect(md).toContain("**Commits:** `abc1234`, `9988776`");
        // The home is collapsed, so a path stays readable and carries no user name.
        expect(md).toContain("**File:** `~/.grok/sessions/01a05cc5.jsonl`");
    });

    test("context turns are labelled, headed with their size, and tool calls name their path", () => {
        const md = formatHistoryMarkdown([rich], "refund", { context: 3 });

        expect(md).toContain("#### Context (3 messages before/after match)");
        expect(formatHistoryMarkdown([rich], "refund", { context: 1 })).toContain("(1 message before/after match)");
        expect(md).toContain("**[User]** the refund is off by a cent");
        expect(md).toContain("  - **Tool:** Edit `src/invoice.ts` — rounding fixed");
    });

    test("a long context turn is cut rather than printed whole", () => {
        const long: AgentSearchHit = {
            ...hit,
            contextEntries: [{ line: 1, role: "user", text: "x".repeat(2000), paths: [], commits: [] }],
        };
        const md = formatHistoryMarkdown([long]);

        expect(md).toContain(`**[User]** ${"x".repeat(500)}...`);
        expect(md).not.toContain("x".repeat(501));
    });

    test("JSON carries the project, branch and de-duplicated commits", () => {
        const parsed = SafeJSON.parse(formatHistoryJson([rich])) as Array<{
            project?: string;
            gitBranch?: string;
            commitHashes?: string[];
        }>;

        expect(parsed[0].project).toBe("shop");
        expect(parsed[0].gitBranch).toBe("feat/refunds");
        expect(parsed[0].commitHashes).toEqual(["abc1234def", "99887766"]);
    });

    test("NEGATIVE CONTROL: a hit with none of them prints none of them", () => {
        const md = formatHistoryMarkdown([hit], "refund");

        expect(md).not.toContain("[Subagent]");
        expect(md).not.toContain("**Branch:**");
        expect(md).not.toContain("**Commits:**");
        expect(md).not.toContain("#### Context");
        expect(SafeJSON.parse(formatHistoryJson([hit]))[0].commitHashes).toBeUndefined();
    });
});

/**
 * Ported from `claude/lib/history/format-table.test.ts` when the Claude door stopped rendering
 * its own table. The regression it guards is the reason the PROJECT column exists at all.
 */
test("the table prints each session's project and its whole id, so two repos stay distinct", () => {
    // `tools claude history` once hid the project, so a GenesisPlayground session id read as
    // though it belonged to the current GenesisTools checkout.
    const row = (sessionId: string, project: string, title: string): AgentSearchHit => ({
        ...hit,
        sessionId,
        project,
        title,
        cwd: `/Users/me/Projects/${project}`,
    });
    const table = renderedTable([
        row("cb09c025-0657-4f49-bae6-b5aa23b8e37b", "GenesisPlayground", "tooltip"),
        row("e68d8436-3fa0-44b3-8526-1d8435af7e3b", "GenesisTools", "resume miss"),
    ]);

    for (const column of ["ID", "PROJECT", "TITLE", "BRANCH", "AGE", "STATUS"]) {
        expect(table).toContain(column);
    }

    // The WHOLE id: a 12-character slice is not something you can paste into `resume`.
    expect(table).toContain("cb09c025-0657-4f49-bae6-b5aa23b8e37b");
    expect(table).toContain("e68d8436-3fa0-44b3-8526-1d8435af7e3b");
    expect(table).toContain("GenesisPlayground");
    expect(table).toContain("GenesisTools");
});

test("a subagent row is marked, and the source column appears only when the homes differ", () => {
    const plain = renderedTable([{ ...hit, isSubagent: true }]);

    expect(plain).toContain("agent");
    expect(plain).not.toContain("SOURCE");

    const split = renderedTable([
        { ...hit, sessionId: "one", sourceHome: "/homes/a" },
        { ...hit, sessionId: "two", sourceHome: "/homes/b" },
    ]);

    expect(split).toContain("SOURCE");
    expect(split).toContain("/homes/b");
});
