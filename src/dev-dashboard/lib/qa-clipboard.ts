import { renderQaAnswerHtml, renderQaQuestionHtml } from "@app/dev-dashboard/lib/qa-render";
import type { QaRow } from "./qa-types";

function frontmatter(entry: QaRow): string {
    return [
        "---",
        `id: ${entry.id}`,
        `ts: ${new Date(entry.ts).toISOString()}`,
        `tag: ${entry.tag}`,
        entry.project ? `project: ${entry.project}` : "",
        entry.branch ? `branch: ${entry.branch}` : "",
        "---",
    ]
        .filter(Boolean)
        .join("\n");
}

export function suggestObsidianFilename(question: string): string {
    return (
        question
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .trim()
            .split(/\s+/)
            .slice(0, 8)
            .join("-")
            .slice(0, 60) || "question"
    );
}

export function formatQaAsMarkdown(entry: QaRow, opts?: { includeFrontmatter?: boolean; includeQuestion?: boolean }): string {
    const includeFrontmatter = opts?.includeFrontmatter !== false;
    const includeQuestion = opts?.includeQuestion !== false;
    const refs =
        entry.refs.length > 0
            ? `\n\n**Refs:** ${entry.refs.map((r) => `${r.type}:${r.value}`).join(", ")}`
            : "";
    const fm = includeFrontmatter ? `${frontmatter(entry)}\n\n` : "";
    const question = includeQuestion ? `## Question\n\n${entry.question}\n\n` : "";

    return `${fm}${question}## Answer\n\n${entry.answerMd}${refs}\n`;
}

export function formatQaAsHtml(entry: QaRow, opts?: { includeQuestion?: boolean }): string {
    const includeQuestion = opts?.includeQuestion !== false;
    const refs =
        entry.refs.length > 0
            ? `<p><strong>Refs:</strong> ${entry.refs.map((r) => `${r.type}:${r.value}`).join(", ")}</p>`
            : "";
    const question = includeQuestion
        ? `<h2>Question</h2>\n${renderQaQuestionHtml(entry.question)}\n`
        : "";

    return `<article>\n${question}<h2>Answer</h2>\n${renderQaAnswerHtml(entry.answerMd)}\n${refs}\n</article>`;
}
