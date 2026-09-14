import type { AskAnswer, AskForm, AskItem } from "./types";

/** One-line summary for a notification banner and for CLI status lines. */
export function summarizeForm(form: AskForm): string {
    const first = form.items[0]?.promptMarkdown.replace(/\s+/g, " ").trim() ?? "(no prompt)";
    const rest = form.items.length - 1;
    const head = first.length > 100 ? `${first.slice(0, 99)}…` : first;

    return rest > 0 ? `${head} (+${rest} more)` : head;
}

function renderItemPrompt(item: AskItem, index: number, total: number): string {
    const heading = total > 1 ? `**${index + 1}. ${item.promptMarkdown}**` : item.promptMarkdown;

    if (!item.choices?.length) {
        return heading;
    }

    return `${heading}\n${item.choices.map((choice) => `- ${choice.label}`).join("\n")}`;
}

/** The form as the `question` half of a QaEntry. */
export function renderFormQuestion(form: AskForm): string {
    return form.items.map((item, index) => renderItemPrompt(item, index, form.items.length)).join("\n\n");
}

function renderOneAnswer(item: AskItem, answer: AskAnswer | undefined): string {
    if (!answer) {
        return "_(skipped)_";
    }

    const parts: string[] = [];
    const labelById = new Map((item.choices ?? []).map((choice) => [choice.id, choice.label]));

    if (answer.selectedChoices?.length) {
        parts.push(answer.selectedChoices.map((id) => `**${labelById.get(id) ?? id}**`).join(", "));
    }

    if (answer.freeText?.trim()) {
        parts.push(answer.freeText.trim());
    }

    if (answer.fileTags?.length) {
        parts.push(answer.fileTags.map((tag) => `\`@${tag}\``).join(" "));
    }

    if (answer.images?.length) {
        parts.push(`_(${answer.images.length} pasted image${answer.images.length === 1 ? "" : "s"})_`);
    }

    return parts.length > 0 ? parts.join("\n\n") : "_(no answer)_";
}

/** The submitted answers as the `answerMd` half of a QaEntry. */
export function renderFormAnswer(form: AskForm, answers: Record<string, AskAnswer>): string {
    if (form.items.length === 1) {
        return renderOneAnswer(form.items[0], answers[form.items[0].id]);
    }

    return form.items
        .map((item, index) => `**${index + 1}. ${item.promptMarkdown}**\n\n${renderOneAnswer(item, answers[item.id])}`)
        .join("\n\n");
}
