import { describe, expect, test } from "bun:test";
import { enrichQaEntry, renderQaAnswerHtml } from "@app/dev-dashboard/lib/qa-render";
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

describe("enrichQaEntry", () => {
    test("builds preview html for long answers", () => {
        const entry = enrichQaEntry({
            ...baseEntry,
            answerMd: "line one\nline two\nline three\nline four",
        });

        expect(entry.answerHtml).toContain("line four");
        expect(entry.answerHtmlPreview).toContain("line three");
        expect(entry.answerHtmlPreview).not.toContain("line four");
    });
});
