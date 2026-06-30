import { describe, expect, test } from "bun:test";
import type { QaRow } from "@app/dev-dashboard/lib/qa-types";
import { evictQaEntriesPastHorizon, QA_LIVE_HORIZON_MS } from "./qa-live-cap";

function row(id: string, ts: number): QaRow {
    return {
        id,
        ts,
        sessionId: "s",
        sessionTitle: null,
        project: "p",
        repoRoot: "/",
        cwd: "/",
        branch: null,
        commitSha: null,
        commitMessage: null,
        agent: "unknown",
        isWorktree: false,
        worktreePath: null,
        aiAgent: null,
        agentLabel: null,
        tag: "question",
        question: "q",
        answerMd: "a",
        refs: [],
        source: "cli",
        turnUuid: null,
        answerHtml: "",
        answerHtmlPreview: "",
        questionHtml: "",
        supersededBy: null,
        readAt: null,
    };
}

describe("qa.tsx live entries cap", () => {
    test("evicts old entries from live/seen/readAtById past a time horizon", () => {
        const now = Date.now();
        const oldTs = now - QA_LIVE_HORIZON_MS - 60_000;
        const recentTs = now - 60_000;

        const live = [row("old", oldTs), row("recent", recentTs)];
        const seen = new Set(["old", "recent"]);
        const readAtById = new Map([
            ["old", oldTs],
            ["recent", recentTs],
        ]);

        const result = evictQaEntriesPastHorizon(live, seen, readAtById, now);

        expect(result.live.map((e) => e.id)).toEqual(["recent"]);
        expect(result.seen.has("old")).toBe(false);
        expect(result.seen.has("recent")).toBe(true);
        expect(result.readAtById.has("old")).toBe(false);
        expect(result.readAtById.get("recent")).toBe(recentTs);
    });
});
