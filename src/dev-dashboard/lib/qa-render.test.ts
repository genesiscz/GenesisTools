import { describe, expect, test } from "bun:test";
import { enrichQaEntry, renderQaAnswerHtml, renderQaQuestionHtml } from "@app/dev-dashboard/lib/qa-render";
import type { QaEntry } from "@app/question/lib/types";

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
        expect(entry.answerHtmlPreview).toContain("line 50");
        expect(entry.answerHtmlPreview).not.toContain("line 51");
        expect(entry.questionHtml).toContain("How does");
    });
});
