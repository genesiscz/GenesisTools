import { describe, expect, test } from "bun:test";
import { searchQa } from "./qa-search";
import type { QaRow } from "./qa-types";

function row(over: Partial<QaRow> & { id: string }): QaRow {
    return {
        ts: Date.now(),
        sessionId: "s",
        sessionTitle: null,
        project: "P",
        repoRoot: "/r",
        cwd: "/r",
        branch: null,
        commitSha: null,
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        question: over.question ?? "q",
        answerMd: over.answerMd ?? "a",
        refs: [],
        source: "cli",
        turnUuid: null,
        answerHtml: "<p>a</p>",
        answerHtmlPreview: "<p>a</p>",
        questionHtml: "<p>q</p>",
        supersededBy: null,
        readAt: null,
        ...over,
    };
}

describe("searchQa", () => {
    test("empty query returns all rows", () => {
        const rows = [row({ id: "1" }), row({ id: "2" })];
        expect(searchQa(rows, "").entries).toHaveLength(2);
    });

    test("filters by tokenized query", () => {
        const rows = [row({ id: "1", question: "metro bundler setup" }), row({ id: "2", question: "unrelated topic" })];
        const { entries } = searchQa(rows, "metro");

        expect(entries.map((e) => e.id)).toEqual(["1"]);
    });
});
