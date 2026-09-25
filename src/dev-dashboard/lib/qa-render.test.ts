import { describe, expect, test } from "bun:test";
import { deliveryLabel } from "@app/dev-dashboard/lib/qa-decision-delivery";
import { enrichQaEntry, renderQaAnswerHtml, renderQaQuestionHtml } from "@app/dev-dashboard/lib/qa-render";
import type { QaEntry } from "@app/question/lib/types";
import { formatClock } from "@genesiscz/utils/format";

const baseEntry: QaEntry = {
    id: "qa-test",
    ts: Date.now(),
    sessionId: "s1",
    sessionTitle: null,
    project: "GenesisTools",
    repoRoot: "/tmp",
    cwd: "/tmp",
    branch: "main",
    commitSha: null,
    commitMessage: null,
    agent: "unknown",
    isWorktree: false,
    worktreePath: null,
    aiAgent: null,
    agentLabel: null,
    tag: "question",
    question: "How does this component work?",
    answerMd: "",
    refs: [],
    source: "cli",
    turnUuid: null,
};

describe("renderQaAnswerHtml", () => {
    test("renders fenced tsx with hljs classes", () => {
        const html = renderQaAnswerHtml(`Intro paragraph.

\`\`\`tsx
export function Widget({ title }: { title: string }) {
  return <div className="widget">{title}</div>;
}
\`\`\`
`);

        expect(html).toContain("<pre>");
        expect(html).toContain("hljs");
        expect(html).toContain("language-tsx");
        expect(html).toContain("Widget");
    });
});

describe("renderQaQuestionHtml", () => {
    test("renders markdown bold and code", () => {
        const html = renderQaQuestionHtml("Why **bold** and `code`?");

        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("code");
    });
});

describe("enrichQaEntry", () => {
    test("builds preview html for answers over the line limit", () => {
        const lines = Array.from({ length: 52 }, (_, i) => `line ${i + 1}`);
        const entry = enrichQaEntry({
            ...baseEntry,
            answerMd: lines.join("\n"),
        });

        expect(entry.answerHtml).toContain("line 52");
        expect(entry.answerHtmlPreview).toContain("line 3");
        expect(entry.answerHtmlPreview).not.toContain("line 4");
        expect(entry.questionHtml).toContain("How does");
    });
});

describe("deliveryLabel", () => {
    const at = "2026-09-24T20:40:00.000Z";
    const clock = formatClock(at, { date: "short" });

    test("names the route, the target and the time of a sent or queued answer", () => {
        expect(deliveryLabel({ route: "cmux", target: "work · pane 3", at })).toBe(
            `sent ${clock} via cmux work · pane 3`
        );
        expect(deliveryLabel({ route: "codex", target: "fixer", at })).toBe(`sent ${clock} via codex fixer`);
        expect(deliveryLabel({ route: "queued", target: "no cmux pane runs this session", at })).toBe(
            `queued ${clock}: no cmux pane runs this session`
        );
        expect(deliveryLabel({ route: "prompt", at })).toBe(`sent ${clock} with the session's next prompt`);
    });

    test("a row stored before deliveries were recorded says nothing", () => {
        expect(deliveryLabel(null)).toBeNull();
        expect(deliveryLabel(undefined)).toBeNull();
    });
});
